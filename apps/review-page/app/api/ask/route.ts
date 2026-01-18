export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createHmac } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * ---------------------------------------
 * /api/ask の責務（最低限）
 * ---------------------------------------
 * - ユーザーの自然文質問を受け取る
 * - OpenAI(Responses API) に tools(function calling) を渡す
 * - モデルが要求した tool を Supabase で実行
 * - 結果を function_call_output としてモデルへ返す
 * - モデルの最終回答（または聞き返し）を返す
 *
 * ※「自由なSQL」は絶対やらない。必ず “用意した関数（ツール）” だけ実行する。
 */

/** ---------- 環境変数 ---------- */
function requireEnv(name: string, value?: string | null) {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY', process.env.OPENAI_API_KEY);
const QA_MODEL = process.env.OPENAI_QA_MODEL || 'gpt-5';
const LINE_HASH_PEPPER = requireEnv('LINE_HASH_PEPPER', process.env.LINE_HASH_PEPPER);

/**
 * ASK_DEBUG=1 なら、レスポンスに tool 呼び出し履歴を載せる（LINE運用では 0 推奨）
 * もしくは header x-ask-debug: 1 で強制ON
 */
const ASK_DEBUG = process.env.ASK_DEBUG === '1';

/** ---------- OpenAI client ---------- */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/** ---------- 型（最低限） ---------- */
type AskPayload = {
  line_user_id: string;
  message: string;
  // 開発中にだけ使いたい場合（任意）
  debug?: boolean;
};

type UniversityHit = { id: string; name: string };
type SubjectHit = { id: string; name: string; university_id: string };

type RollupRow = {
  subject_id: string;
  summary_1000: string;
  review_count: number;
  avg_credit_ease: number | null;
  avg_class_difficulty: number | null;
  avg_assignment_load: number | null;
  avg_attendance_strictness: number | null;
  avg_satisfaction: number | null;
  avg_recommendation: number | null;
  is_dirty: boolean;
  updated_at: string;
};

/**
 * Responses API の output は union 型で TS がうるさいので、
 * function_call だけを「安全に読む」ための型を用意しておく。
 */
type FunctionCallItem = {
  type: 'function_call';
  name: string;
  arguments?: string;
  call_id: string;
};

/** ---------- ここが “プロンプト” の定義（見失わないように上部へ） ---------- */
/**
 * =========================================================
 * ★ PROMPT(1) : developerPrompt（モデルの性格と制約）
 * =========================================================
 * - 「DB根拠で答えろ」「大学不明なら聞き返せ」などのルールを固定する場所
 * - ここが “DB検索する／しない” の判断精度に直結する
 */
const PROMPT_DEVELOPER = `
あなたは「大学授業レビューDB」を根拠に回答するアシスタント。
必ずツールで取得した事実に基づいて答える（推測で断定しない）。

【絶対ルール】
- DBに存在しない情報（一般的なネット知識）で、特定の授業/大学を断定しておすすめしない。
- 数字（満足度/おすすめ度/難易度/単位落とす割合など）を出すときは、必ずツール結果に基づく。
- ツール結果が無いのに「DBでは〜」と言ってはいけない。

【会話制御】
- 大学が不明で特定できないなら、まず大学を聞き返す。
  ただし get_my_affiliation が取れて大学が一意なら、その大学として検索してよい（その旨を回答に明記）。
- 科目が曖昧なら、search_subjects_by_name で候補を出してユーザーに選ばせる。
- rollup が存在しない / is_dirty=true / summaryが空などの場合は「集計中/データ不足」を正直に伝える。
- 回答には可能なら review_count と主要な平均値（満足度/おすすめ度/難易度）を添える。
- 「単位落としてる割合」などは credit_outcomes を使って説明する（母数も書く）。
- toolの連続呼び出しは最大2回までで完結させる。条件が揃わない場合は聞き返す。

【質問パターンと推奨ツール】
1) ランキング/おすすめ系（例: おすすめ授業, 人気授業, ランキング）
   -> resolve_university + top_subjects_by_metric を使う（top3〜5件）。
2) 難易度/楽単/きつい系（例: 難しい, きつい, 楽, 単位取りやすい）
   -> top_subjects_by_metric（指標: 難易度/単位の容易さ）。
3) 個別科目の評価（例: 「統計学基礎ってどう？」）
   -> search_subjects_by_name -> get_subject_rollup。
4) 科目比較（例: AとBどっちが難しい？）
   -> 両科目を特定して get_subject_rollup で比較。
5) 単位落とす/出席/課題量（例: 落単率, 出席厳しい？）
   -> credit_outcomes または rollup の該当指標を提示。
6) レビュー引用（例: レビューの例を出して）
   -> top_subjects_with_examples または rollup の要約を使い、短い引用を2〜3件。
7) 大学が曖昧（例: 「うちの大学で」）
   -> get_my_affiliation で大学が一意なら使用。不明なら大学名を質問。
8) 科目一覧（例: 「○○大学ってどんな科目がある？」）
   -> resolve_university + list_subjects_by_university で科目名を列挙（上限あり）。

【出力の雰囲気】
- LINE想定。長文になりすぎない。必要なら箇条書き。
- DBの内部IDやツール名（resolve_university 等）は書かない。
- 内部カラム名（avg_recommendation など）を本文に出さない。
- 「検索しました」「照合しました」などの裏側説明は省く。
- 最後に、根拠は短く付ける（例：レビュー数、対象大学名、対象科目名）。
- 返答は簡潔に。長くなる場合は「上位3件＋補足」程度に抑える。
- スマホLINEで読みやすいように、1行は短め（約14文字前後）で改行する。
  [Context handling]
  - Use recent conversation context and user memory provided above.
  - If the user omits a university but one is mentioned in recent messages, assume the same university.
  - If top_subjects_by_metric returns empty, retry with min_reviews=0 and/or use list_subjects_by_university.
  - When rollups are missing, explain "集計中/データ不足" and provide a fallback list instead of saying "no data".
  `;

/**
 * =========================================================
 * ★ PROMPT(2) : instructions（Responses API の追加指示）
 * =========================================================
 * - developerPrompt と役割が近いが、こちらは「この呼び出しでの追加制約」
 * - “ツールを使わずにDBっぽい断定をしない” をさらに強くする
 *
 * ※SDKの型・モデル差分で挙動が変わることがあるので、ここは短め&明確にするのが安定
 */
const PROMPT_INSTRUCTIONS = `
あなたは授業レビューDBに基づく回答のみ行う。
DB参照が必要な質問では、必ず tools を呼び出してから回答する。
ツール結果が無い場合は「大学名を教えて」など必要情報を聞き返す。
`;

/**
 * DBが必要そうな質問なのに tool を呼ばない事故があるので、
 * “っぽい質問” は tool_choice='required' を使って強制する（保険）
 */
function shouldForceTool(userMessage: string) {
  const t = userMessage.toLowerCase();

  // 雑でも効果が高いキーワード群（あなたのドメインに合わせて足してOK）
  const keywords = [
    '授業',
    '科目',
    'おすすめ',
    'レビュー',
    '満足',
    'おすすめ度',
    '難易度',
    '出席',
    '課題',
    '単位',
    '落と',
    'トップ',
    'ランキング',
    '平均',
    '楽',
    'きつ',
    '比較',
    'どっち',
    'どちら',
    '率',
    '多い',
    '少ない',
    '人気',
    '評判',
    'レビュー例',
    '一覧',
    '科目一覧',
    'どんな科目',
    'rollup',
    'summary',
  ];

  return keywords.some((k) => t.includes(k));
}

/** ---------- util ---------- */
function lineUserIdToHash(lineUserId: string) {
  // LINEのuserIdはDBに生で保存しない（ハッシュ化）
  return createHmac('sha256', LINE_HASH_PEPPER).update(lineUserId, 'utf8').digest('hex');
}

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return { message: err.message, code: err.code, details: err.details, hint: err.hint };
}

async function getUserMemorySummary(userId: string) {
  const { data, error } = await supabaseAdmin
    .from('user_memory')
    .select('summary_1000')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.summary_1000 ?? '').trim();
}

async function getRecentChatMessages(userId: string, limit = 12) {
  const { data, error } = await supabaseAdmin
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('user_id', userId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).reverse();
}

/** ---------- DBユーティリティ（ユーザーID確定） ---------- */
async function getOrCreateUserId(lineUserId: string) {
  const hash = lineUserIdToHash(lineUserId);

  // 既存ユーザー検索
  const { data: found, error: findErr } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('line_user_hash', hash)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id as string;

  // 新規作成（同時投稿のunique競合に備えてリトライ）
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('users')
    .insert({ line_user_hash: hash })
    .select('id')
    .single();

  if (insErr && (insErr as any).code === '23505') {
    const { data: again, error: againErr } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('line_user_hash', hash)
      .single();

    if (againErr) throw againErr;
    if (!again) throw new Error('user conflict retry failed');
    return again.id as string;
  }

  if (insErr) throw insErr;
  return inserted.id as string;
}

/** ---------- tools（Function Calling）定義 ---------- */
/**
 * openai sdk の型に合わせて「function」ネストなしの形式で書く：
 * { type:'function', name, description, strict, parameters }
 */
const tools: OpenAI.Responses.Tool[] = [
  {
    type: 'function',
    name: 'get_my_affiliation',
    description: 'ユーザーの登録済み所属（大学/学部/学科）を返す。未登録なら null を返す。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'resolve_university',
    description: '大学名から universities を検索して候補を返す。完全一致があればそれを優先する。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        university_name: { type: 'string', description: '大学名（ユーザー入力）' },
        limit: { type: 'integer', description: '候補数（1〜10）' },
      },
      required: ['university_name', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'search_subjects_by_name',
    description: '指定大学の subjects から科目名の部分一致で検索して候補を返す（曖昧なときの候補出し用）。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        university_id: { type: 'string', description: 'universities.id (uuid)' },
        keyword: { type: 'string', description: '科目名キーワード（部分一致）' },
        limit: { type: 'integer', description: '最大件数（1〜20）' },
      },
      required: ['university_id', 'keyword', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_subjects_by_university',
    description: '指定大学の subjects を一覧で返す（科目一覧の問い合わせ用）。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        university_id: { type: 'string', description: 'universities.id (uuid)' },
        limit: { type: 'integer', description: '最大件数（1〜50）' },
      },
      required: ['university_id', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_subject_rollup',
    description: 'subject_id を指定して subject_rollups + 科目名 + 大学名を返す。必要なら単位取得状況も返す。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        subject_id: { type: 'string', description: 'subjects.id (uuid)' },
      },
      required: ['subject_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'top_subjects_by_metric',
    description: '指定大学の subject_rollups から、指標で上位/下位の科目を返す（おすすめ/難しい授業など）。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        university_id: { type: 'string', description: 'universities.id (uuid)' },
        metric: {
          type: 'string',
          enum: [
            'avg_satisfaction',
            'avg_recommendation',
            'avg_class_difficulty',
            'avg_assignment_load',
            'avg_attendance_strictness',
            'avg_credit_ease',
          ],
        },
        order: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', description: '最大件数（1〜10）' },
        min_reviews: { type: 'integer', description: '最低レビュー数（0以上）' },
      },
      required: ['university_id', 'metric', 'order', 'limit', 'min_reviews'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'top_subjects_with_examples',
    description:
      '指定大学の subject_rollups から上位科目を返し、各科目の好評レビュー例（本文）も取得する。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        university_id: { type: 'string', description: 'universities.id (uuid)' },
        metric: {
          type: 'string',
          enum: [
            'avg_satisfaction',
            'avg_recommendation',
            'avg_class_difficulty',
            'avg_assignment_load',
            'avg_attendance_strictness',
            'avg_credit_ease',
          ],
        },
        order: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', description: '最大件数（1〜10）' },
        min_reviews: { type: 'integer', description: '最低レビュー数（0以上）' },
        sample_reviews: {
          type: 'integer',
          description: '科目ごとのレビュー例数（1〜3）',
        },
      },
      required: ['university_id', 'metric', 'order', 'limit', 'min_reviews', 'sample_reviews'],
      additionalProperties: false,
    },
  },
];

/** ---------- tool実装（Supabaseで安全に実行） ---------- */
async function tool_get_my_affiliation(ctx: { userId: string }) {
  const { data, error } = await supabaseAdmin
    .from('user_affiliations')
    .select('university_id, faculty, department, universities(name)')
    .eq('user_id', ctx.userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    university_id: data.university_id as string,
    university_name: (data as any).universities?.name ?? null,
    faculty: data.faculty as string,
    department: data.department as string | null,
  };
}

async function tool_resolve_university(args: { university_name: string; limit: number }) {
  const rawName = (args.university_name ?? '').trim();
  const limit = Math.max(1, Math.min(10, args.limit || 5));

  if (!rawName) return { picked: null, candidates: [] as UniversityHit[] };

  let name = rawName;
  const uniMatch = rawName.match(/(.+?大学)/);
  if (uniMatch?.[1]) {
    name = uniMatch[1];
  }
  name = name.replace(/\s+/g, '');

  // 完全一致（大小無視）っぽく優先：ilike でワイルドカード無し
  const { data: exact, error: exactErr } = await supabaseAdmin
    .from('universities')
    .select('id,name')
    .ilike('name', name)
    .maybeSingle();

  if (exactErr) throw exactErr;
  if (exact?.id) return { picked: exact as UniversityHit, candidates: [exact as UniversityHit] };

  // 部分一致候補
  const { data: hits, error } = await supabaseAdmin
    .from('universities')
    .select('id,name')
    .ilike('name', `%${name}%`)
    .order('name', { ascending: true })
    .limit(limit);

  if (error) throw error;

  const candidates = (hits || []) as UniversityHit[];
  return { picked: candidates.length === 1 ? candidates[0] : null, candidates };
}

async function tool_search_subjects_by_name(args: { university_id: string; keyword: string; limit: number }) {
  const universityId = args.university_id;
  const keyword = (args.keyword ?? '').trim();
  const limit = Math.max(1, Math.min(20, args.limit || 10));

  if (!universityId || !keyword) return [] as SubjectHit[];

  const { data, error } = await supabaseAdmin
    .from('subjects')
    .select('id,name,university_id')
    .eq('university_id', universityId)
    .ilike('name', `%${keyword}%`)
    .order('name', { ascending: true })
    .limit(limit);

  if (error) throw error;

  return (data || []) as SubjectHit[];
}

async function tool_list_subjects_by_university(args: { university_id: string; limit: number }) {
  const universityId = args.university_id;
  const limit = Math.max(1, Math.min(50, args.limit || 20));

  if (!universityId) return [] as SubjectHit[];

  const { data, error } = await supabaseAdmin
    .from('subjects')
    .select('id,name,university_id')
    .eq('university_id', universityId)
    .order('name', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (data || []) as SubjectHit[];
}

/**
 * rollups に「単位取得状況カウント」が載ってる設計に進化してても壊れないように：
 * - rollup は select('*') にして、キーがあればそれを使う
 * - 無ければ course_reviews を軽く集計して埋める（保険）
 */
function pickNumber(obj: any, keys: string[]) {
  for (const k of keys) {
    if (typeof obj?.[k] === 'number') return obj[k] as number;
  }
  return null;
}

async function tool_get_subject_rollup(args: { subject_id: string }) {
  const subjectId = args.subject_id;

  // 1) rollup
  const { data: rollup, error: rollErr } = await supabaseAdmin
    .from('subject_rollups')
    .select('*')
    .eq('subject_id', subjectId)
    .maybeSingle();

  if (rollErr) throw rollErr;

  // 2) subject + university
  const { data: subj, error: subjErr } = await supabaseAdmin
    .from('subjects')
    .select('id,name,university_id,universities(name)')
    .eq('id', subjectId)
    .maybeSingle();

  if (subjErr) throw subjErr;

  // 3) credit outcome fallback
  let noCredit = null as number | null;
  let creditNormal = null as number | null;
  let creditHigh = null as number | null;
  let notRated = null as number | null;

  if (rollup) {
    noCredit = pickNumber(rollup, ['no_credit', 'no_credit_count', 'count_no_credit', 'cnt_no_credit']);
    creditNormal = pickNumber(rollup, ['credit_normal', 'credit_normal_count', 'count_credit_normal', 'cnt_credit_normal']);
    creditHigh = pickNumber(rollup, ['credit_high', 'credit_high_count', 'count_credit_high', 'cnt_credit_high']);
    notRated = pickNumber(rollup, ['not_rated', 'not_rated_count', 'count_not_rated', 'cnt_not_rated']);
  }

  if (noCredit === null || creditNormal === null || creditHigh === null || notRated === null) {
    const { data: perfRows, error: perfErr } = await supabaseAdmin
      .from('course_reviews')
      .select('performance_self')
      .eq('subject_id', subjectId)
      .limit(5000);

    if (perfErr) throw perfErr;

    let _notRated = 0;
    let _noCredit = 0;
    let _creditNormal = 0;
    let _creditHigh = 0;

    for (const r of perfRows || []) {
      const v = (r as any).performance_self as number;
      if (v === 1) _notRated += 1;
      else if (v === 2) _noCredit += 1;
      else if (v === 3) _creditNormal += 1;
      else if (v === 4) _creditHigh += 1;
    }

    if (notRated === null) notRated = _notRated;
    if (noCredit === null) noCredit = _noCredit;
    if (creditNormal === null) creditNormal = _creditNormal;
    if (creditHigh === null) creditHigh = _creditHigh;
  }

  return {
    subject: {
      id: subj?.id ?? subjectId,
      name: subj?.name ?? null,
      university_id: subj?.university_id ?? null,
      university_name: (subj as any)?.universities?.name ?? null,
    },
    rollup: (rollup || null) as RollupRow | null,
    credit_outcomes: {
      not_rated: notRated ?? 0,
      no_credit: noCredit ?? 0,
      credit_normal: creditNormal ?? 0,
      credit_high: creditHigh ?? 0,
    },
  };
}

async function tool_top_subjects_by_metric(args: {
  university_id: string;
  metric:
    | 'avg_satisfaction'
    | 'avg_recommendation'
    | 'avg_class_difficulty'
    | 'avg_assignment_load'
    | 'avg_attendance_strictness'
    | 'avg_credit_ease';
  order: 'asc' | 'desc';
  limit: number;
  min_reviews: number;
}) {
  const universityId = args.university_id;
  const limit = Math.max(1, Math.min(10, args.limit || 5));
  const minReviews = Math.max(0, args.min_reviews || 0);

  if (!universityId) return [];

  const queryRollups = async (min: number) => {
    const { data, error } = await supabaseAdmin
      .from('subject_rollups')
      .select(`subject_id,review_count,${args.metric},subjects!inner(name,university_id)`)
      .eq('subjects.university_id', universityId)
      .gte('review_count', min)
      .order(args.metric, { ascending: args.order === 'asc', nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return (data || []) as any[];
  };

  let rows = await queryRollups(minReviews);
  if (rows.length === 0 && minReviews > 0) {
    rows = await queryRollups(0);
  }

  if (rows.length > 0) {
    return rows.map((r: any) => ({
      subject_id: r.subject_id,
      subject_name: r.subjects?.name ?? null,
      review_count: r.review_count,
      metric_value: r[args.metric] ?? null,
      metric: args.metric,
    }));
  }

  const { data: subjects, error: subErr } = await supabaseAdmin
    .from('subjects')
    .select('id,name')
    .eq('university_id', universityId)
    .order('name', { ascending: true })
    .limit(limit);
  if (subErr) throw subErr;
  return (subjects || []).map((s: any) => ({
    subject_id: s.id,
    subject_name: s.name,
    review_count: 0,
    metric_value: null,
    metric: args.metric,
  }));
}

async function tool_top_subjects_with_examples(args: {
  university_id: string;
  metric:
    | 'avg_satisfaction'
    | 'avg_recommendation'
    | 'avg_class_difficulty'
    | 'avg_assignment_load'
    | 'avg_attendance_strictness'
    | 'avg_credit_ease';
  order: 'asc' | 'desc';
  limit: number;
  min_reviews: number;
  sample_reviews: number;
}) {
  const universityId = args.university_id;
  const limit = Math.max(1, Math.min(10, args.limit || 5));
  const minReviews = Math.max(0, args.min_reviews || 0);
  const sampleCount = Math.max(1, Math.min(3, args.sample_reviews || 1));

  if (!universityId) return [];

  const queryRollups = async (min: number) => {
    const { data, error } = await supabaseAdmin
      .from('subject_rollups')
      .select(`subject_id,review_count,${args.metric},subjects!inner(name,university_id)`)
      .eq('subjects.university_id', universityId)
      .gte('review_count', min)
      .order(args.metric, { ascending: args.order === 'asc', nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return (data || []) as any[];
  };

  let filtered = await queryRollups(minReviews);
  if (filtered.length === 0 && minReviews > 0) {
    filtered = await queryRollups(0);
  }

  if (filtered.length === 0) {
    const { data: subjects, error: subErr } = await supabaseAdmin
      .from('subjects')
      .select('id,name')
      .eq('university_id', universityId)
      .order('name', { ascending: true })
      .limit(limit);
    if (subErr) throw subErr;
    return (subjects || []).map((s: any) => ({
      subject_id: s.id,
      subject_name: s.name,
      review_count: 0,
      metric_value: null,
      metric: args.metric,
      examples: [],
    }));
  }

  const results: any[] = [];

  for (const r of filtered) {
    const subjectId = r.subject_id as string;
    const { data: reviews, error: revErr } = await supabaseAdmin
      .from('course_reviews')
      .select('body_main,satisfaction,recommendation,created_at')
      .eq('subject_id', subjectId)
      .gte('satisfaction', 4)
      .gte('recommendation', 4)
      .order('created_at', { ascending: false })
      .limit(sampleCount);

    if (revErr) throw revErr;

    const subjectName = (r as any)?.subjects?.name ?? null;
    const metricValue = (r as Record<string, unknown>)[args.metric] ?? null;
    results.push({
      subject_id: subjectId,
      subject_name: subjectName,
      review_count: r.review_count,
      metric_value: metricValue,
      metric: args.metric,
      examples: (reviews || []).map((x: any) => ({
        body_main: x.body_main,
        satisfaction: x.satisfaction,
        recommendation: x.recommendation,
      })),
    });
  }

  return results;
}

async function callTool(name: string, args: any, ctx: { userId: string }) {
  switch (name) {
    case 'get_my_affiliation':
      return await tool_get_my_affiliation(ctx);
    case 'resolve_university':
      return await tool_resolve_university(args);
    case 'search_subjects_by_name':
      return await tool_search_subjects_by_name(args);
    case 'list_subjects_by_university':
      return await tool_list_subjects_by_university(args);
    case 'get_subject_rollup':
      return await tool_get_subject_rollup(args);
    case 'top_subjects_by_metric':
      return await tool_top_subjects_by_metric(args);
    case 'top_subjects_with_examples':
      return await tool_top_subjects_with_examples(args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

type AgentTraceItem = {
  step: number;
  name: string;
  args: any;
  ok: boolean;
  output_preview: string;
};

type AgentResult = {
  answer: string;
  forced: 'auto' | 'required';
  toolTrace: AgentTraceItem[];
};

function previewJson(v: any, max = 800) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch {
    const s = String(v);
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
}


/** ---------- メイン：Function Calling ループ ---------- */
async function runAgent(params: {
  userMessage: string;
  userId: string;
  debug?: boolean;
  memorySummary?: string;
  recentMessages?: { role: string; content: string }[];
}): Promise<AgentResult> {
  const { userMessage, userId, debug = false, memorySummary, recentMessages } = params;

  const developerPrompt = PROMPT_DEVELOPER.trim();

  const forced: 'auto' | 'required' = shouldForceTool(userMessage) ? 'required' : 'auto';
  const toolTrace: AgentTraceItem[] = [];

  const memoryMsg = memorySummary
    ? {
        role: 'system' as const,
        content: `User memory (summary):\n${memorySummary}`,
      }
    : null;

  const contextMsgs = (recentMessages ?? [])
    .filter((m) => m?.role && m?.content)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const lastMsg = contextMsgs.length ? contextMsgs[contextMsgs.length - 1] : null;
  const shouldAppendUser =
    !lastMsg || lastMsg.role !== 'user' || lastMsg.content?.trim() !== userMessage.trim();

  const input = [
    { role: 'developer' as const, content: developerPrompt },
    ...(memoryMsg ? [memoryMsg] : []),
    ...contextMsgs,
    ...(shouldAppendUser ? [{ role: 'user' as const, content: userMessage }] : []),
  ];

  // 1) 最初の問い合わせ
  let resp = await openai.responses.create({
    model: QA_MODEL,
    input,
    tools,
    tool_choice: forced,
    parallel_tool_calls: false,
  });

  // tool output を紐づける response id
  let previousResponseId = resp.id;

  for (let step = 0; step < 5; step++) {
    const calls = ((resp as any).output || []).filter((o: any) => o?.type === 'function_call') as FunctionCallItem[];

    // tool呼び出しが無い＝最終回答
    if (calls.length === 0) {
      const text = (resp.output_text || '').trim();
      return {
        answer: text.length
          ? text
          : 'すみません、うまく回答を作れませんでした。大学名と科目名をもう少し具体的に教えてください。',
        forced,
        toolTrace,
      };
    }

    // 2) tool実行 → outputs 生成
    const toolOutputs: any[] = [];

    for (const c of calls) {
      const name = c.name;

      let args: any = {};
      try {
        args = c.arguments ? JSON.parse(c.arguments) : {};
      } catch {
        args = {};
      }

      try {
        const result = await callTool(name, args, { userId });

        if (debug) {
          toolTrace.push({
            step,
            name,
            args,
            ok: true,
            output_preview: previewJson({ ok: true, result }),
          });
        }

        toolOutputs.push({
          type: 'function_call_output',
          call_id: c.call_id,
          output: JSON.stringify({ ok: true, result }),
        });
      } catch (e: any) {
        if (debug) {
          toolTrace.push({
            step,
            name,
            args,
            ok: false,
            output_preview: previewJson({ ok: false, error: e?.message ?? String(e) }),
          });
        }

        toolOutputs.push({
          type: 'function_call_output',
          call_id: c.call_id,
          output: JSON.stringify({ ok: false, error: e?.message ?? String(e) }),
        });
      }
    }

    // 3) 前の response に紐づけて toolOutputs を送る
    resp = await openai.responses.create({
      model: QA_MODEL,
      previous_response_id: previousResponseId,
      input: toolOutputs,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });

    previousResponseId = resp.id;
  }

  return {
    answer: 'すみません、検索が複雑になりすぎました。大学名と科目名をもう少し具体的に教えてください。',
    forced,
    toolTrace,
  };
}


/** ---------- HTTPハンドラ ---------- */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AskPayload;

    const message = body.message?.trim();
    if (!body.line_user_id) {
      return NextResponse.json({ ok: false, error: 'line_user_id is required' }, { status: 400 });
    }
    if (!message) {
      return NextResponse.json({ ok: false, error: 'message is required' }, { status: 400 });
    }

    const debug =
      ASK_DEBUG || body.debug === true || req.headers.get('x-ask-debug') === '1';

    // users.id（内部ID）を確定
    const userId = await getOrCreateUserId(body.line_user_id);

// ここでは「会話ログ保存」は webhook 側でやる前提
  const [memorySummary, recentMessages] = await Promise.all([
    getUserMemorySummary(userId),
    getRecentChatMessages(userId, 12),
  ]);

  const r = await runAgent({
    userMessage: message,
    userId,
    debug,
    memorySummary,
    recentMessages,
  });
  
  return NextResponse.json({
    ok: true,
    user_id: userId,
    answer: r.answer,
    ...(debug ? { debug: { forced_tool: r.forced, tool_calls: r.toolTrace } } : {}),
  });

  } catch (e: any) {
    console.error('[api/ask] error:', e);
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
