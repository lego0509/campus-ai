export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createHmac } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getEnv } from '@/lib/env';

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

const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY', getEnv('OPENAI_API_KEY'));
const QA_MODEL = getEnv('OPENAI_QA_MODEL') || 'gpt-5';
const LINE_HASH_PEPPER = requireEnv('LINE_HASH_PEPPER', getEnv('LINE_HASH_PEPPER'));

/**
 * ASK_DEBUG=1 なら、レスポンスに tool 呼び出し履歴を載せる（LINE運用では 0 推奨）
 * もしくは header x-ask-debug: 1 で強制ON
 */
const ASK_DEBUG = getEnv('ASK_DEBUG') === '1';

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
type TagSubjectHit = {
  subject_id: string;
  subject_name: string | null;
  university_id: string | null;
  tag_review_count: number;
  review_count: number | null;
  avg_class_difficulty: number | null;
  avg_assignment_difficulty: number | null;
  avg_attendance_strictness: number | null;
  avg_recommendation: number | null;
  summary_1000?: string | null;
};

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
  avg_assignment_difficulty?: number | null;
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
外部の一般知識・ネット情報・想像で補完しない。ツール出力に無い内容は書かない。

【絶対ルール】
- DBに存在しない情報（一般的なネット知識）で、特定の授業/大学を断定しておすすめしない。
- 数字（おすすめ度/難易度/課題難易度/出席の厳しさ/単位落とす割合など）を出すときは、必ずツール結果に基づく。
- ツール結果が無いのに「DBでは〜」と言ってはいけない。
- ツール結果に無い講義内容・試験形式・範囲などを一般知識で書かない。
- 情報不足の場合は「DBに情報がない/集計中」と明確に伝える。

【会話制御】
- 大学が不明で特定できないなら、まず大学を聞き返す。
  ただし get_my_affiliation が取れて大学が一意なら、その大学として検索してよい（その旨を回答に明記）。
- 科目が曖昧なら、search_subjects_by_name で候補を出してユーザーに選ばせる。
- rollup が存在しない / is_dirty=true / summaryが空などの場合は「集計中/データ不足」を正直に伝える。
- DBから必要な情報が取得できない場合は「キャッピーのデータベースに情報が登録されていない」と正直に伝える。
- 大学名が省略され、科目名だけが来た場合は、直近の会話やメモリから大学名を推定して検索する。
  推定した場合は「直近の文脈から◯◯大学として検索した」と短く明記する。推定できなければ大学名を聞き返す。
- 回答には可能なら review_count と主要な平均値（おすすめ度/難易度/課題難易度/出席の厳しさ）を添える。
- 「単位落としてる割合」などは credit_outcomes を使って説明する（母数も書く）。
- toolの連続呼び出しは最大2回までで完結させる。条件が揃わない場合は聞き返す。
 - 直前の会話で「おすすめ授業」などを提示した後、ユーザーが「その○○について詳しく」と聞いた場合は、
   必ずその科目を特定して get_subject_rollup を使い、DBの内容だけで回答する。

【質問パターンと推奨ツール】
1) ランキング/おすすめ系（例: おすすめ授業, 人気授業, ランキング）
   -> resolve_university + top_subjects_by_metric を使う（top3〜5件）。
2) 難易度/課題難易度/出席厳しさ/楽単系（例: 難しい, きつい, 楽, 単位取りやすい）
   -> top_subjects_by_metric（指標: 難易度/課題難易度/出席の厳しさ）。
3) 個別科目の評価（例: 「統計学基礎ってどう？」）
   -> search_subjects_by_name -> get_subject_rollup。
4) 科目比較（例: AとBどっちが難しい？）
   -> 両科目を特定して get_subject_rollup で比較。
5) 単位落とす（例: 落単率）
   -> credit_outcomes を提示。
6) レビュー引用（例: レビューの例を出して）
   -> top_subjects_with_examples または rollup の要約を使い、短い引用を2〜3件。
7) 大学が曖昧（例: 「うちの大学で」）
   -> get_my_affiliation で大学が一意なら使用。不明なら大学名を質問。
8) 科目一覧（例: 「○○大学ってどんな科目がある？」）
   -> resolve_university + list_subjects_by_university で科目名を列挙（上限あり）。
9) ハッシュタグ検索（例: 「#楽単」「#高難易度 #出席厳しい」）
   -> search_subjects_by_tags を使って科目一覧を返す。複数タグは AND で絞る。

【出力の雰囲気】
- LINE想定。長文になりすぎない。必要なら箇条書き。
- DBの内部IDやツール名（resolve_university 等）は書かない。
- 内部カラム名（avg_recommendation など）を本文に出さない。
- 「検索しました」「照合しました」などの裏側説明は省く。
- 最後に「キャッピーのデータベースからの情報です」と短く添える。
- Markdown記号（アスタリスクやバッククォートなど）は使わない。
- 返答は簡潔に。長くなる場合は「上位3件＋補足」程度に抑える。
- スマホLINEで読みやすいように、過度な改行は避けて適度に改行する。
 - 「1科目について詳しく教えて」に該当する質問は、必ず以下の固定フォーマットのみで返す（余計な情報は禁止）。
   1) 大学名/科目名
   2) レビュー数
   3) おすすめ度・授業難易度・課題難易度・出席の厳しさ（数値はDBから。無ければ「データ不足」）
   4) 単位取得状況（DBから。無ければ「データ不足」）
   5) 要約（summary_1000 がある場合のみ。無ければ「集計中」）
   6) 最後に「キャッピーのデータベースからの情報です」
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
ツール出力に含まれない内容は書かず、一般知識で補完しない。
`;

/**
 * DBが必要そうな質問なのに tool を呼ばない事故があるので、
 * “っぽい質問” は tool_choice='required' を使って強制する（保険）
 */
function shouldForceTool(userMessage: string) {
  const t = (userMessage || '').trim().toLowerCase();
  if (!t) return false;
  if (t.includes('#') || t.includes('＃')) return true;

  // Casual topics that should not force DB tools.
  const casualExcludes = [
    '天気',
    '恋愛',
    'バイト',
    '雑談',
    '人生',
    'アプリ',
    'スマホ',
    'ゲーム',
    '映画',
    '音楽',
    'グルメ',
    '旅行',
    'スポーツ',
  ];
  if (casualExcludes.some((k) => t.includes(k))) return false;

  // Strong intent patterns: "Aについて教えて" / "Aってどう？" / "詳しく教えて"
  const forcePatterns = [/について教えて/, /詳しく教えて/, /ってどう\??$/, /ってどんな/];
  if (forcePatterns.some((re) => re.test(t))) return true;

  // High-signal keywords (DB-required topics)
  const keywords = [
    '授業',
    '科目',
    '講義',
    'シラバス',
    'カリキュラム',
    'おすすめ',
    'レビュー',
    '満足',
    'おすすめ度',
    '難易度',
    '出席',
    '課題',
    'レポート',
    'テスト',
    '試験',
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
    'タグ',
    'レビュー例',
    '一覧',
    '科目一覧',
    'どんな科目',
    'rollup',
    'summary',
  ];
  if (keywords.some((k) => t.includes(k))) return true;

  // Short subject-like questions: force DB even if keywords are minimal.
  const shortText = t.replace(/\s+/g, '');
  if (shortText.length >= 2 && shortText.length <= 25) {
    const subjectHints = [
      '学',
      '論',
      '入門',
      '基礎',
      '概論',
      '演習',
      '実験',
      '実習',
      'ゼミ',
      '研究',
      '統計',
      '情報',
      '数学',
      '英語',
      '物理',
      '化学',
      '経済',
      '法学',
      '心理',
      'プログラミング',
      'について',
      '教えて',
    ];
    if (subjectHints.some((k) => shortText.includes(k))) return true;
  }

  return false;
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

function normalizeTag(raw: string) {
  const withoutFullWidthHash = raw.replace(/＃/g, '#').trim();
  const withoutHash = withoutFullWidthHash.replace(/^#+/, '').trim();
  const collapsed = withoutHash.replace(/\s+/g, '');
  const lowered = collapsed.toLowerCase();
  if (lowered.length === 0) return null;
  if (Array.from(lowered).length > 12) return null;
  return lowered;
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

function extractSubjectCandidatesFromText(text: string) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const candidates: string[] = [];

  for (const line of lines) {
    let body = line;

    const numbered = body.match(
      /^(?:[0-9]+|[①-⑩]|[一二三四五六七八九十]+)[\)\.\:、\s]+(.+)$/
    );
    if (numbered?.[1]) body = numbered[1];
    if (body.startsWith('・') || body.startsWith('-')) body = body.slice(1).trim();

    const cut = body.split(/[（(]|[:：]| - |—|─/)[0].trim();
    if (cut.length >= 2 && cut.length <= 60) {
      candidates.push(cut);
    }
  }

  return candidates.filter((c, idx, arr) => arr.indexOf(c) === idx);
}

function inferListIndex(userMessage: string, max: number) {
  const t = userMessage.replace(/\s+/g, '');
  if (!t) return null;

  if (/最後|一番下|末尾/.test(t)) return max - 1;

  const patterns: Array<{ re: RegExp; idx: number }> = [
    { re: /1つ目|1番|一番|最初|上から1|1位|一位/, idx: 0 },
    { re: /2つ目|2番|二番|二つ目|上から2|2位|二位/, idx: 1 },
    { re: /3つ目|3番|三番|三つ目|上から3|3位|三位/, idx: 2 },
    { re: /4つ目|4番|四番|四つ目|上から4|4位|四位/, idx: 3 },
    { re: /5つ目|5番|五番|五つ目|上から5|5位|五位/, idx: 4 },
  ];

  for (const p of patterns) {
    if (p.re.test(t)) return p.idx;
  }

  return null;
}

function resolveImplicitSubjectFromContext(
  userMessage: string,
  recentMessages: { role: string; content: string }[]
) {
  const message = userMessage.trim();
  if (!message || recentMessages.length === 0) return { message, resolvedSubject: null as string | null };

  const lastAssistant = [...recentMessages]
    .reverse()
    .find((m) => m.role === 'assistant' && (m.content || '').trim().length > 0);
  if (!lastAssistant) return { message, resolvedSubject: null as string | null };

  const candidates = extractSubjectCandidatesFromText(lastAssistant.content);
  if (candidates.length === 0) return { message, resolvedSubject: null as string | null };

  for (const name of candidates) {
    if (message.includes(name)) return { message, resolvedSubject: name };
  }

  const refersList = /その中|上の|下の|一覧|さっき|先ほど|候補|おすすめ|リスト/.test(message);
  if (!refersList && !/その授業|その科目|それ|あれ/.test(message)) {
    return { message, resolvedSubject: null as string | null };
  }

  const idx = inferListIndex(message, candidates.length);
  if (idx !== null && idx >= 0 && idx < candidates.length) {
    const subject = candidates[idx];
    return { message: `${subject}について詳しく教えて`, resolvedSubject: subject };
  }

  if (candidates.length === 1) {
    const subject = candidates[0];
    return { message: `${subject}について詳しく教えて`, resolvedSubject: subject };
  }

  return { message, resolvedSubject: null as string | null };
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
        university_id: { type: 'string', description: 'universities.id (uuid) 任意' },
        keyword: { type: 'string', description: '科目名キーワード（部分一致）' },
        limit: { type: 'integer', description: '最大件数（1〜20）' },
      },
      required: ['keyword', 'limit'],
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
            'avg_recommendation',
            'avg_class_difficulty',
            'avg_assignment_difficulty',
            'avg_attendance_strictness',
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
            'avg_recommendation',
            'avg_class_difficulty',
            'avg_assignment_difficulty',
            'avg_attendance_strictness',
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
  {
    type: 'function',
    name: 'search_subjects_by_tags',
    description:
      'ハッシュタグ（#楽単 など）で科目を検索し、科目ごとの件数と平均指標を返す。複数タグはANDで絞る。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'タグ配列（#なし推奨）。最大5件。',
        },
        university_id: {
          type: ['string', 'null'],
          description: 'universities.id (uuid) 任意',
        },
        limit: { type: 'integer', description: '最大件数（1〜10）' },
      },
      required: ['tags', 'limit', 'university_id'],
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

async function tool_search_subjects_by_name(
  args: { university_id?: string; keyword: string; limit: number },
  ctx: { userId: string }
) {
  let universityId = args.university_id;
  const keyword = (args.keyword ?? '').trim();
  const limit = Math.max(1, Math.min(20, args.limit || 10));

  if (!universityId && ctx?.userId) {
    const aff = await tool_get_my_affiliation({ userId: ctx.userId });
    universityId = aff?.university_id ?? undefined;
  }

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

async function tool_search_subjects_by_tags(args: {
  tags: string[];
  university_id?: string;
  limit: number;
}) {
  const limit = Math.max(1, Math.min(10, args.limit || 5));
  const rawTags = Array.isArray(args.tags) ? args.tags : [];
  const normalizedTags = rawTags
    .map((t) => normalizeTag(String(t)))
    .filter((t): t is string => Boolean(t))
    .filter((t, idx, arr) => arr.indexOf(t) === idx)
    .slice(0, 5);

  if (normalizedTags.length === 0) return [] as TagSubjectHit[];

  const { data: tagRows, error: tagErr } = await supabaseAdmin
    .from('review_tags')
    .select('id,name')
    .in('name', normalizedTags);
  if (tagErr) throw tagErr;
  const tagIds = (tagRows || []).map((t: any) => t.id);
  if (tagIds.length === 0) return [] as TagSubjectHit[];

  const { data: rows, error } = await supabaseAdmin
    .from('course_review_tags')
    .select('review_id,tag_id,course_reviews(subject_id,subjects(name,university_id))')
    .in('tag_id', tagIds);
  if (error) throw error;

  const perSubject = new Map<
    string,
    {
      subject_id: string;
      subject_name: string | null;
      university_id: string | null;
      matchedTags: Set<string>;
      reviewIds: Set<string>;
    }
  >();

  for (const row of rows || []) {
    const subjectId = (row as any).course_reviews?.subject_id as string | undefined;
    const subjectName = (row as any).course_reviews?.subjects?.name ?? null;
    const universityId = (row as any).course_reviews?.subjects?.university_id ?? null;
    if (!subjectId) continue;
    if (args.university_id && universityId !== args.university_id) continue;

    const cur =
      perSubject.get(subjectId) ||
      ({
        subject_id: subjectId,
        subject_name: subjectName,
        university_id: universityId,
        matchedTags: new Set<string>(),
        reviewIds: new Set<string>(),
      } as const);

    cur.matchedTags.add(String((row as any).tag_id));
    cur.reviewIds.add(String((row as any).review_id));
    perSubject.set(subjectId, cur as any);
  }

  const filtered = Array.from(perSubject.values()).filter(
    (s) => s.matchedTags.size >= tagIds.length
  );

  filtered.sort((a, b) => b.reviewIds.size - a.reviewIds.size);
  const picked = filtered.slice(0, limit);
  const subjectIds = picked.map((p) => p.subject_id);
  if (subjectIds.length === 0) return [] as TagSubjectHit[];

  const { data: rollups, error: rollErr } = await supabaseAdmin
    .from('subject_rollups')
    .select(
      'subject_id,review_count,avg_class_difficulty,avg_recommendation,avg_attendance_strictness,summary_1000'
    )
    .in('subject_id', subjectIds);
  if (rollErr) throw rollErr;

  const rollupMap = new Map((rollups || []).map((r: any) => [r.subject_id, r]));

  const { data: diffRows, error: diffErr } = await supabaseAdmin
    .from('course_reviews')
    .select('subject_id,assignment_difficulty_4')
    .in('subject_id', subjectIds)
    .limit(10000);
  if (diffErr) throw diffErr;

  const diffAgg = new Map<string, { sum: number; count: number }>();
  for (const r of diffRows || []) {
    const v = (r as any).assignment_difficulty_4;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const sid = String((r as any).subject_id);
    const cur = diffAgg.get(sid) || { sum: 0, count: 0 };
    cur.sum += v;
    cur.count += 1;
    diffAgg.set(sid, cur);
  }

  return picked.map((p) => {
    const rollup = rollupMap.get(p.subject_id);
    const diff = diffAgg.get(p.subject_id);
    return {
      subject_id: p.subject_id,
      subject_name: p.subject_name,
      university_id: p.university_id,
      tag_review_count: p.reviewIds.size,
      review_count: rollup?.review_count ?? null,
      avg_class_difficulty: rollup?.avg_class_difficulty ?? null,
      avg_assignment_difficulty: diff ? diff.sum / diff.count : null,
      avg_attendance_strictness: rollup?.avg_attendance_strictness ?? null,
      avg_recommendation: rollup?.avg_recommendation ?? null,
      summary_1000: rollup?.summary_1000 ?? null,
    };
  });
}

async function queryTopSubjectsByAssignmentDifficulty(args: {
  university_id: string;
  order: 'asc' | 'desc';
  limit: number;
  min_reviews: number;
}) {
  const { university_id, order, limit, min_reviews } = args;
  const { data, error } = await supabaseAdmin
    .from('course_reviews')
    .select('subject_id,assignment_difficulty_4,subjects!inner(name,university_id)')
    .eq('subjects.university_id', university_id)
    .limit(10000);

  if (error) throw error;

  const stats = new Map<string, { subject_id: string; subject_name: string; sum: number; count: number }>();

  for (const row of data || []) {
    const v = (row as any).assignment_difficulty_4;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const subjectId = (row as any).subject_id as string;
    const subjectName = (row as any).subjects?.name ?? null;
    if (!subjectId || !subjectName) continue;
    const cur = stats.get(subjectId) || { subject_id: subjectId, subject_name: subjectName, sum: 0, count: 0 };
    cur.sum += v;
    cur.count += 1;
    stats.set(subjectId, cur);
  }

  const items = Array.from(stats.values())
    .filter((x) => x.count >= min_reviews)
    .map((x) => ({
      subject_id: x.subject_id,
      subject_name: x.subject_name,
      review_count: x.count,
      metric_value: roundOneDecimal(x.sum / x.count),
      metric: 'avg_assignment_difficulty' as const,
    }));

  items.sort((a, b) => {
    if (a.metric_value === null && b.metric_value === null) return 0;
    if (a.metric_value === null) return 1;
    if (b.metric_value === null) return -1;
    return order === 'asc' ? a.metric_value - b.metric_value : b.metric_value - a.metric_value;
  });

  return items.slice(0, limit);
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

function roundOneDecimal(value: any) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return Math.round(num * 10) / 10;
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
      .select('performance_self,course_review_ai_flags(ai_flagged)')
      .eq('subject_id', subjectId)
      .limit(5000);

    if (perfErr) throw perfErr;

    let _notRated = 0;
    let _noCredit = 0;
    let _creditNormal = 0;
    let _creditHigh = 0;

    for (const r of perfRows || []) {
      const flags = (r as any).course_review_ai_flags as { ai_flagged: boolean }[] | undefined;
      if (flags?.some((f) => f.ai_flagged)) continue;
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

  let avgAssignmentDifficulty = null as number | null;
  {
    const { data: diffRows, error: diffErr } = await supabaseAdmin
      .from('course_reviews')
      .select('assignment_difficulty_4')
      .eq('subject_id', subjectId)
      .limit(5000);

    if (diffErr) throw diffErr;
    const vals = (diffRows || [])
      .map((r: any) => r.assignment_difficulty_4)
      .filter((v: any) => typeof v === 'number' && Number.isFinite(v)) as number[];
    if (vals.length > 0) {
      avgAssignmentDifficulty = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
  }

    const roundedRollup = rollup
    ? ({
        ...rollup,
        avg_credit_ease: roundOneDecimal(rollup.avg_credit_ease),
        avg_class_difficulty: roundOneDecimal(rollup.avg_class_difficulty),
        avg_assignment_load: roundOneDecimal(rollup.avg_assignment_load),
        avg_attendance_strictness: roundOneDecimal(rollup.avg_attendance_strictness),
        avg_satisfaction: roundOneDecimal(rollup.avg_satisfaction),
        avg_recommendation: roundOneDecimal(rollup.avg_recommendation),
        avg_assignment_difficulty: roundOneDecimal(avgAssignmentDifficulty),
      } as RollupRow)
    : null;

  return {
    subject: {
      id: subj?.id ?? subjectId,
      name: subj?.name ?? null,
      university_id: subj?.university_id ?? null,
      university_name: (subj as any)?.universities?.name ?? null,
    },
    rollup: roundedRollup,
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
    | 'avg_recommendation'
    | 'avg_class_difficulty'
    | 'avg_assignment_difficulty'
    | 'avg_attendance_strictness';
  order: 'asc' | 'desc';
  limit: number;
  min_reviews: number;
}) {
  const universityId = args.university_id;
  const limit = Math.max(1, Math.min(10, args.limit || 5));
  const minReviews = Math.max(0, args.min_reviews || 0);

  if (!universityId) return [];
  if (args.metric === 'avg_assignment_difficulty') {
    return await queryTopSubjectsByAssignmentDifficulty({
      university_id: universityId,
      order: args.order,
      limit,
      min_reviews: minReviews,
    });
  }

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
      metric_value: roundOneDecimal(r[args.metric] ?? null),
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
    | 'avg_recommendation'
    | 'avg_class_difficulty'
    | 'avg_assignment_difficulty'
    | 'avg_attendance_strictness';
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
  if (args.metric === 'avg_assignment_difficulty') {
    const top = await queryTopSubjectsByAssignmentDifficulty({
      university_id: universityId,
      order: args.order,
      limit,
      min_reviews: minReviews,
    });

    const withExamples = [];
    for (const item of top) {
      const { data: reviews, error: reviewErr } = await supabaseAdmin
        .from('course_reviews')
        .select('body_main,created_at')
        .eq('subject_id', item.subject_id)
        .order('created_at', { ascending: false })
        .limit(sampleCount);
      if (reviewErr) throw reviewErr;
      withExamples.push({
        ...item,
        sample_reviews: (reviews || []).map((r: any) => ({
          body_main: r.body_main,
          created_at: r.created_at,
        })),
      });
    }

    return withExamples;
  }

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
      .select('body_main,satisfaction,recommendation,created_at,course_review_ai_flags(ai_flagged)')
      .eq('subject_id', subjectId)
      .gte('satisfaction', 4)
      .gte('recommendation', 4)
      .order('created_at', { ascending: false })
      .limit(sampleCount * 5);

    if (revErr) throw revErr;

    const subjectName = (r as any)?.subjects?.name ?? null;
    const metricValue = roundOneDecimal((r as Record<string, unknown>)[args.metric] ?? null);
    const clean = (reviews || []).filter((x: any) => {
      const flags = x.course_review_ai_flags as { ai_flagged: boolean }[] | undefined;
      return !flags?.some((f) => f.ai_flagged);
    });

    results.push({
      subject_id: subjectId,
      subject_name: subjectName,
      review_count: r.review_count,
      metric_value: metricValue,
      metric: args.metric,
      examples: clean.slice(0, sampleCount).map((x: any) => ({
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
      return await tool_search_subjects_by_name(args, ctx);
    case 'list_subjects_by_university':
      return await tool_list_subjects_by_university(args);
    case 'get_subject_rollup':
      return await tool_get_subject_rollup(args);
    case 'top_subjects_by_metric':
      return await tool_top_subjects_by_metric(args);
    case 'top_subjects_with_examples':
      return await tool_top_subjects_with_examples(args);
    case 'search_subjects_by_tags':
      return await tool_search_subjects_by_tags(args);
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

  const developerPrompt = `${PROMPT_DEVELOPER.trim()}\n\n${PROMPT_INSTRUCTIONS.trim()}`;

  // review-ask はDB専用なので常に tool を必須にする
  const forced: 'auto' | 'required' = 'required';
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

  const resolved = resolveImplicitSubjectFromContext(message, recentMessages);

  const r = await runAgent({
    userMessage: resolved.message,
    userId,
    debug,
    memorySummary,
    recentMessages,
  });
  
  return NextResponse.json({
    ok: true,
    user_id: userId,
    answer: r.answer,
    ...(debug
      ? { debug: { forced_tool: r.forced, tool_calls: r.toolTrace, version: 'force-tool-2026-01-26' } }
      : {}),
  });

  } catch (e: any) {
    console.error('[api/ask] error:', e);
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
