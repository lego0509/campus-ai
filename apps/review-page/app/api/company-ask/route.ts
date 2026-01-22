export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createHmac } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * ---------------------------------------
 * /api/company-ask の責務（最低限）
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

type CompanyHit = { id: string; name: string; hq_prefecture: string };

type CompanyRollupRow = {
  university_id: string;
  faculty: string;
  company_id: string;
  summary_1000: string;
  review_count: number;
  count_offer: number;
  count_rejected: number;
  count_other: number;
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
 */
const PROMPT_DEVELOPER = `
あなたは「就活・企業レビューDB」を根拠に回答するアシスタント。
必ずツールで取得した事実に基づいて答える（推測で断定しない）。

【絶対ルール】
- DBに存在しない情報（一般的なネット知識）で、特定企業の評価を断定しない。
- 数字（内定割合/レビュー数/選考内容など）を出すときは、必ずツール結果に基づく。
- ツール結果が無いのに「DBでは〜」と言ってはいけない。

【会話制御】
- 大学/学部が不明なら、まず聞き返す。
  ただし get_my_affiliation が取れて大学/学部が一意なら、その所属として検索してよい（その旨を回答に明記）。
- 会社名が曖昧なら、resolve_company で候補を出してユーザーに選ばせる。
- rollup が存在しない / is_dirty=true / summaryが空などの場合は「集計中/データ不足」を正直に伝える。
- 回答には可能なら review_count と内定割合（offer_rate）や結果内訳を添える。
- toolの連続呼び出しは最大2回までで完結させる。条件が揃わない場合は聞き返す。

【質問パターンと推奨ツール】
1) 会社の評判/結果（例: 「A社ってどう？」）
   -> resolve_company -> get_company_rollup
2) 会社の比較（例: A社とB社どっちが通りやすい？）
   -> 両社を特定して get_company_rollup で比較
3) 大学内の人気企業（例: うちの大学で人気の会社）
   -> top_companies_by_metric（review_count）
4) 内定率が高い企業（例: 内定多い会社）
   -> top_companies_by_metric（offer_rate）
5) 会社一覧（例: うちの大学のレビュー企業）
   -> list_companies_by_university

【出力の雰囲気】
- LINE想定。長文になりすぎない。必要なら箇条書き。
- DBの内部IDやツール名（resolve_company 等）は書かない。
- 内部カラム名（count_offer など）を本文に出さない。
- 「検索しました」「照合しました」などの裏側説明は省く。
- 根拠の追記は不要（末尾に根拠を付けない）。
- Markdown記号（* や ` など）を使わない。特にアスタリスク(*)は出力しない。
- 返答は簡潔に。長くなる場合は「上位3件＋補足」程度に抑える。
- スマホLINEで読みやすいように、1行は短め（約14文字前後）で改行する。
  [Context handling]
  - Use recent conversation context and user memory provided above.
  - If the user omits a university/faculty but one is mentioned in recent messages, assume the same.
  - When rollups are missing, explain "集計中/データ不足" and provide a fallback list instead of saying "no data".
  `;

/**
 * =========================================================
 * ★ PROMPT(2) : instructions（Responses API の追加指示）
 * =========================================================
 */
const PROMPT_INSTRUCTIONS = `
あなたは企業レビューDBに基づく回答のみ行う。
DB参照が必要な質問では、必ず tools を呼び出してから回答する。
ツール結果が無い場合は「大学名/学部名/会社名」など必要情報を聞き返す。
`;

/**
 * DBが必要そうな質問なのに tool を呼ばない事故があるので、
 * “っぽい質問” は tool_choice='required' を使って強制する（保険）
 */
function shouldForceTool(userMessage: string) {
  const t = userMessage.toLowerCase();

  const keywords = [
    '会社',
    '企業',
    '就活',
    '内定',
    '選考',
    '面接',
    'es',
    'インターン',
    'レビュー',
    '評判',
    '結果',
    '落ち',
    '通り',
    '年収',
    '給与',
    '社員数',
    '人気',
    'ランキング',
    '平均',
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

  const { data: found, error: findErr } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('line_user_hash', hash)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id as string;

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
    name: 'resolve_company',
    description: '会社名から companies を検索して候補を返す。完全一致があればそれを優先する。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        company_name: { type: 'string', description: '会社名（ユーザー入力）' },
        limit: { type: 'integer', description: '候補数（1〜10）' },
      },
      required: ['company_name', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_companies_by_university',
    description: '指定大学（+学部）の company_rollups から会社一覧を返す。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        university_id: { type: 'string', description: 'universities.id (uuid)' },
        faculty: { type: 'string', description: '学部名（任意）' },
        limit: { type: 'integer', description: '最大件数（1〜30）' },
      },
      required: ['university_id', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_company_rollup',
    description: 'company_rollups + 会社名 + 大学名を返す。なければ簡易集計で補う。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        university_id: { type: 'string', description: 'universities.id (uuid)' },
        faculty: { type: 'string', description: '学部名' },
        company_id: { type: 'string', description: 'companies.id (uuid)' },
      },
      required: ['university_id', 'faculty', 'company_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'top_companies_by_metric',
    description: '指定大学（+学部）の会社をレビュー数/内定率でランキングして返す。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        university_id: { type: 'string', description: 'universities.id (uuid)' },
        faculty: { type: 'string', description: '学部名（任意）' },
        metric: { type: 'string', enum: ['review_count', 'offer_rate'] },
        order: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', description: '最大件数（1〜10）' },
        min_reviews: { type: 'integer', description: '最低レビュー数（0以上）' },
      },
      required: ['university_id', 'metric', 'order', 'limit', 'min_reviews'],
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

  const { data: exact, error: exactErr } = await supabaseAdmin
    .from('universities')
    .select('id,name')
    .ilike('name', name)
    .maybeSingle();

  if (exactErr) throw exactErr;
  if (exact?.id) return { picked: exact as UniversityHit, candidates: [exact as UniversityHit] };

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

async function tool_resolve_company(args: { company_name: string; limit: number }) {
  const rawName = (args.company_name ?? '').trim();
  const limit = Math.max(1, Math.min(10, args.limit || 5));

  if (!rawName) return { picked: null, candidates: [] as CompanyHit[] };

  let name = rawName.replace(/\s+/g, '');

  const { data: exact, error: exactErr } = await supabaseAdmin
    .from('companies')
    .select('id,name,hq_prefecture')
    .ilike('name', name)
    .maybeSingle();

  if (exactErr) throw exactErr;
  if (exact?.id) return { picked: exact as CompanyHit, candidates: [exact as CompanyHit] };

  const { data: hits, error } = await supabaseAdmin
    .from('companies')
    .select('id,name,hq_prefecture')
    .ilike('name', `%${name}%`)
    .order('name', { ascending: true })
    .limit(limit);

  if (error) throw error;

  const candidates = (hits || []) as CompanyHit[];
  return { picked: candidates.length === 1 ? candidates[0] : null, candidates };
}

async function tool_list_companies_by_university(args: {
  university_id: string;
  faculty?: string;
  limit: number;
}) {
  const universityId = args.university_id;
  const faculty = (args.faculty ?? '').trim();
  const limit = Math.max(1, Math.min(30, args.limit || 10));

  if (!universityId) return [] as CompanyHit[];

  let query = supabaseAdmin
    .from('company_rollups')
    .select('company_id, companies(name,hq_prefecture), review_count, updated_at')
    .eq('university_id', universityId)
    .order('review_count', { ascending: false })
    .limit(200);

  if (faculty) query = query.eq('faculty', faculty);

  const { data, error } = await query;
  if (error) throw error;

  const seen = new Set<string>();
  const results: CompanyHit[] = [];

  for (const row of data || []) {
    const company = (row as any).companies;
    const companyId = (row as any).company_id as string | undefined;
    if (!companyId || !company?.name) continue;
    if (seen.has(companyId)) continue;
    seen.add(companyId);
    results.push({
      id: companyId,
      name: company.name,
      hq_prefecture: company.hq_prefecture,
    });
    if (results.length >= limit) break;
  }

  return results;
}

function offerRate(row: { count_offer?: number; count_rejected?: number; count_other?: number }) {
  const offer = Number(row.count_offer ?? 0);
  const rejected = Number(row.count_rejected ?? 0);
  const other = Number(row.count_other ?? 0);
  const denom = offer + rejected + other;
  if (denom <= 0) return null;
  return Math.round((offer / denom) * 1000) / 10;
}

async function tool_get_company_rollup(args: {
  university_id: string;
  faculty: string;
  company_id: string;
}) {
  const universityId = args.university_id;
  const faculty = (args.faculty ?? '').trim();
  const companyId = args.company_id;

  if (!universityId || !faculty || !companyId) {
    return { company: null, rollup: null, review_breakdown: null };
  }

  const { data: company, error: companyErr } = await supabaseAdmin
    .from('companies')
    .select('id,name,hq_prefecture')
    .eq('id', companyId)
    .maybeSingle();
  if (companyErr) throw companyErr;

  const { data: rollup, error: rollErr } = await supabaseAdmin
    .from('company_rollups')
    .select('*')
    .eq('university_id', universityId)
    .eq('faculty', faculty)
    .eq('company_id', companyId)
    .maybeSingle();
  if (rollErr) throw rollErr;

  let reviewCount = 0;
  let countOffer = 0;
  let countRejected = 0;
  let countOther = 0;

  if (rollup) {
    reviewCount = Number((rollup as any).review_count ?? 0);
    countOffer = Number((rollup as any).count_offer ?? 0);
    countRejected = Number((rollup as any).count_rejected ?? 0);
    countOther = Number((rollup as any).count_other ?? 0);
  } else {
    const { data: rows, error } = await supabaseAdmin
      .from('company_reviews')
      .select('outcome,company_review_ai_flags(ai_flagged)')
      .eq('university_id', universityId)
      .eq('faculty', faculty)
      .eq('company_id', companyId)
      .limit(5000);

    if (error) throw error;

    for (const r of rows || []) {
      const flags = (r as any).company_review_ai_flags as { ai_flagged: boolean }[] | undefined;
      if (flags?.some((f) => f.ai_flagged)) continue;
      reviewCount += 1;
      const outcome = (r as any).outcome;
      if (outcome === 'offer') countOffer += 1;
      else if (outcome === 'rejected') countRejected += 1;
      else countOther += 1;
    }
  }

  return {
    company: {
      id: company?.id ?? companyId,
      name: company?.name ?? null,
      hq_prefecture: company?.hq_prefecture ?? null,
    },
    rollup: rollup as CompanyRollupRow | null,
    review_breakdown: {
      review_count: reviewCount,
      count_offer: countOffer,
      count_rejected: countRejected,
      count_other: countOther,
      offer_rate: offerRate({ count_offer: countOffer, count_rejected: countRejected, count_other: countOther }),
    },
  };
}

async function tool_top_companies_by_metric(args: {
  university_id: string;
  faculty?: string;
  metric: 'review_count' | 'offer_rate';
  order: 'asc' | 'desc';
  limit: number;
  min_reviews: number;
}) {
  const universityId = args.university_id;
  const faculty = (args.faculty ?? '').trim();
  const limit = Math.max(1, Math.min(10, args.limit || 5));
  const minReviews = Math.max(0, args.min_reviews || 0);

  if (!universityId) return [];

  let query = supabaseAdmin
    .from('company_rollups')
    .select('company_id,review_count,count_offer,count_rejected,count_other,companies!inner(name,hq_prefecture)')
    .eq('university_id', universityId)
    .gte('review_count', minReviews)
    .limit(200);

  if (faculty) query = query.eq('faculty', faculty);

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data || []).map((r: any) => ({
    company_id: r.company_id,
    company_name: r.companies?.name ?? null,
    hq_prefecture: r.companies?.hq_prefecture ?? null,
    review_count: Number(r.review_count ?? 0),
    offer_rate: offerRate(r),
  }));

  const compare = (a: any, b: any) => {
    const key = args.metric === 'offer_rate' ? 'offer_rate' : 'review_count';
    const av = a[key] ?? -1;
    const bv = b[key] ?? -1;
    if (av === bv) return 0;
    return args.order === 'asc' ? av - bv : bv - av;
  };

  rows.sort(compare);

  return rows.slice(0, limit);
}

async function callTool(name: string, args: any, ctx: { userId: string }) {
  switch (name) {
    case 'get_my_affiliation':
      return await tool_get_my_affiliation(ctx);
    case 'resolve_university':
      return await tool_resolve_university(args);
    case 'resolve_company':
      return await tool_resolve_company(args);
    case 'list_companies_by_university':
      return await tool_list_companies_by_university(args);
    case 'get_company_rollup':
      return await tool_get_company_rollup(args);
    case 'top_companies_by_metric':
      return await tool_top_companies_by_metric(args);
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

  let resp = await openai.responses.create({
    model: QA_MODEL,
    input,
    tools,
    tool_choice: forced,
    parallel_tool_calls: false,
  });

  let previousResponseId = resp.id;

  for (let step = 0; step < 5; step++) {
    const calls = ((resp as any).output || []).filter((o: any) => o?.type === 'function_call') as FunctionCallItem[];

    if (calls.length === 0) {
      const text = (resp.output_text || '').trim();
      return {
        answer: text.length
          ? text
          : 'すみません、うまく回答を作れませんでした。大学名・学部名・会社名をもう少し具体的に教えてください。',
        forced,
        toolTrace,
      };
    }

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
            output_preview: previewJson({ ok: false, error: e?.message || 'tool error' }),
          });
        }

        toolOutputs.push({
          type: 'function_call_output',
          call_id: c.call_id,
          output: JSON.stringify({ ok: false, error: e?.message || 'tool error' }),
        });
      }
    }

    resp = await openai.responses.create({
      model: QA_MODEL,
      input: toolOutputs,
      previous_response_id: previousResponseId,
      tools,
      tool_choice: forced,
      parallel_tool_calls: false,
    });

    previousResponseId = resp.id;
  }

  return {
    answer: 'すみません、処理が長引いています。少し時間を置いてもう一度お試しください。',
    forced,
    toolTrace,
  };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AskPayload;

    if (!body?.line_user_id || !body?.message) {
      return NextResponse.json({ ok: false, error: 'line_user_id and message are required' }, { status: 400 });
    }

    const debug =
      ASK_DEBUG || body.debug === true || req.headers.get('x-ask-debug') === '1';

    const userId = await getOrCreateUserId(body.line_user_id);

    const [memorySummary, recentMessages] = await Promise.all([
      getUserMemorySummary(userId).catch(() => ''),
      getRecentChatMessages(userId, 12).catch(() => []),
    ]);

    const result = await runAgent({
      userMessage: body.message,
      userId,
      debug,
      memorySummary,
      recentMessages,
    });

    const response = {
      ok: true,
      answer: result.answer,
      forced: result.forced,
      ...(debug ? { toolTrace: result.toolTrace } : {}),
    };

    return NextResponse.json(response);
  } catch (e: any) {
    console.error('[api/company-ask] error:', e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? 'server error' },
      { status: 500 }
    );
  }
}
