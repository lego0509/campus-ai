export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getEnv } from '@/lib/env';

/**
 * ---------------------------
 * このエンドポイントの責務
 * ---------------------------
 * - company_rollups.is_dirty = true の行を拾う
 * - company_reviews から review_count / outcome集計を更新
 * - company_reviews から新規レビュー本文を拾って summary_1000 を更新（差分）
 * - ★追加：summary_1000 を embedding 化して company_rollup_embeddings に差分upsert
 * - 成功したら is_dirty=false に戻す（失敗したら維持）
 */

const MAX_ROLLUPS_PER_RUN = 15;
const MAX_REVIEWS_PER_ROLLUP_FOR_STATS = 5000;
const MAX_NEW_REVIEWS_FOR_SUMMARY = 30;
const MAX_BODY_CHARS_FOR_SUMMARY = 1200;

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return { message: err.message, code: err.code, details: err.details, hint: err.hint };
}

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function requireEnv(name: string, value?: string | null) {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function checkBatchAuth(req: Request) {
  const expected = requireEnv('BATCH_TOKEN', getEnv('BATCH_TOKEN'));
  const got = req.headers.get('x-batch-token') || '';
  return got === expected;
}

function normalizeBodyForSummary(body: string) {
  const t = body.trim().replace(/\s+/g, ' ');
  return t.length <= MAX_BODY_CHARS_FOR_SUMMARY ? t : t.slice(0, MAX_BODY_CHARS_FOR_SUMMARY) + '…';
}

function normalizeSummaryForEmbedding(summary: string) {
  return summary.trim().replace(/\s+/g, ' ');
}

function sha256Hex(text: string) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function getOpenAIForSummary() {
  const apiKey = getEnv('OPENAI_API_KEY_SUMMARY') || getEnv('OPENAI_API_KEY') || '';
  requireEnv('OPENAI_API_KEY(or _SUMMARY)', apiKey);
  return new OpenAI({ apiKey });
}

function getOpenAIForRollupEmbedding() {
  const apiKey =
    getEnv('OPENAI_API_KEY_ROLLUP_EMBEDDINGS') ||
    getEnv('OPENAI_API_KEY_SUMMARY') ||
    getEnv('OPENAI_API_KEY') ||
    '';
  requireEnv('OPENAI_API_KEY(or _SUMMARY or _ROLLUP_EMBEDDINGS)', apiKey);
  return new OpenAI({ apiKey });
}

function getSummaryModel() {
  return getEnv('OPENAI_SUMMARY_MODEL') || 'gpt-4.1-nano';
}

function getRollupEmbeddingModel() {
  return getEnv('OPENAI_ROLLUP_EMBEDDING_MODEL') || 'text-embedding-3-small';
}

type RollupRow = {
  university_id: string;
  faculty: string;
  company_id: string;
  summary_1000: string;
  last_processed_review_id: string | null;
  updated_at: string;
};

type ReviewRow = {
  id: string;
  university_id: string;
  faculty: string;
  company_id: string;
  created_at: string;
  outcome: 'offer' | 'rejected' | 'other';
};

type ReviewRowWithFlags = ReviewRow & {
  company_review_ai_flags?: { ai_flagged: boolean }[] | null;
};

type BodyRow = {
  id: string;
  body_main: string;
};

type RollupEmbeddingRow = {
  university_id: string;
  faculty: string;
  company_id: string;
  content_hash: string;
};

export async function POST(req: Request) {
  const startedAt = Date.now();
  const runner =
    req.headers.get('x-batch-runner') || process.env.VERCEL_GIT_COMMIT_SHA || 'unknown-runner';

  try {
    if (!checkBatchAuth(req)) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const openaiForSummary = getOpenAIForSummary();
    const openaiForRollupEmbedding = getOpenAIForRollupEmbedding();
    const summaryModel = getSummaryModel();
    const rollupEmbeddingModel = getRollupEmbeddingModel();

    const { data: dirty, error: dirtyErr } = await supabaseAdmin
      .from('company_rollups')
      .select('university_id,faculty,company_id,summary_1000,last_processed_review_id,updated_at')
      .eq('is_dirty', true)
      .order('updated_at', { ascending: true })
      .limit(MAX_ROLLUPS_PER_RUN);

    if (dirtyErr) {
      return NextResponse.json(
        { ok: false, error: 'failed to fetch dirty company_rollups', details: supabaseErrorToJson(dirtyErr) },
        { status: 500 }
      );
    }

    const rollups = (dirty || []) as RollupRow[];

    if (rollups.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'no dirty company rollups',
        runner,
        elapsed_ms: Date.now() - startedAt,
        counts: {
          rollups: 0,
          stats_updated: 0,
          summaries_updated: 0,
          rollup_embeddings_updated: 0,
          kept_dirty: 0,
        },
      });
    }

    let statsUpdated = 0;
    let summariesUpdated = 0;
    let rollupEmbeddingsUpdated = 0;
    let keptDirty = 0;

    const perRollup: any[] = [];

    for (const r of rollups) {
      const { university_id: universityId, faculty, company_id: companyId } = r;

      const result: any = {
        university_id: universityId,
        faculty,
        company_id: companyId,
        ok: true,
        stats_updated: false,
        summary_updated: false,
        rollup_embedding_updated: false,
        kept_dirty: false,
        errors: [] as any[],
      };

      try {
        const { data: reviews, error: revErr } = await supabaseAdmin
          .from('company_reviews')
          .select('id,university_id,faculty,company_id,created_at,outcome,company_review_ai_flags(ai_flagged)')
          .eq('university_id', universityId)
          .eq('faculty', faculty)
          .eq('company_id', companyId)
          .order('created_at', { ascending: true })
          .limit(MAX_REVIEWS_PER_ROLLUP_FOR_STATS);

        if (revErr) throw revErr;

        const rows = (reviews || [])
          .filter((row: ReviewRowWithFlags) => {
            const flags = row.company_review_ai_flags;
            if (!flags || flags.length === 0) return true;
            return !flags.some((f) => f.ai_flagged);
          })
          .map((row: ReviewRowWithFlags) => ({
            id: row.id,
            university_id: row.university_id,
            faculty: row.faculty,
            company_id: row.company_id,
            created_at: row.created_at,
            outcome: row.outcome,
          })) as ReviewRow[];

        if (rows.length === 0) {
          const { error: updErr } = await supabaseAdmin
            .from('company_rollups')
            .update({
              review_count: 0,
              count_offer: 0,
              count_rejected: 0,
              count_other: 0,
              summary_1000: '',
              last_processed_review_id: null,
              is_dirty: false,
              updated_at: new Date().toISOString(),
            })
            .eq('university_id', universityId)
            .eq('faculty', faculty)
            .eq('company_id', companyId);

          if (updErr) throw updErr;

          statsUpdated += 1;
          summariesUpdated += 1;
          result.stats_updated = true;
          result.summary_updated = true;

          perRollup.push(result);
          continue;
        }

        const count = rows.length;
        let countOffer = 0;
        let countRejected = 0;
        let countOther = 0;

        for (const row of rows) {
          if (row.outcome === 'offer') countOffer += 1;
          else if (row.outcome === 'rejected') countRejected += 1;
          else countOther += 1;
        }

        {
          const { error: updErr } = await supabaseAdmin
            .from('company_rollups')
            .update({
              review_count: count,
              count_offer: countOffer,
              count_rejected: countRejected,
              count_other: countOther,
              updated_at: new Date().toISOString(),
            })
            .eq('university_id', universityId)
            .eq('faculty', faculty)
            .eq('company_id', companyId);

          if (updErr) throw updErr;

          statsUpdated += 1;
          result.stats_updated = true;
        }

        let newIds: string[] = [];

        if (r.last_processed_review_id) {
          const idx = rows.findIndex((x) => x.id === r.last_processed_review_id);
          if (idx >= 0) {
            newIds = rows.slice(idx + 1).map((x) => x.id);
          } else {
            newIds = rows.map((x) => x.id);
          }
        } else {
          newIds = rows.map((x) => x.id);
        }

        if (newIds.length > MAX_NEW_REVIEWS_FOR_SUMMARY) {
          newIds = newIds.slice(-MAX_NEW_REVIEWS_FOR_SUMMARY);
        }

        const bodyMap = new Map<string, string>();
        for (const ids of chunk(newIds, 200)) {
          const { data: bodies, error: bErr } = await supabaseAdmin
            .from('company_reviews')
            .select('id,body_main')
            .in('id', ids);

          if (bErr) throw bErr;

          for (const b of (bodies || []) as BodyRow[]) {
            bodyMap.set(b.id, b.body_main);
          }
        }

        const newBodies = newIds
          .map((id) => bodyMap.get(id))
          .filter((x): x is string => !!x && x.trim().length > 0)
          .map(normalizeBodyForSummary);

        const prevSummary = (r.summary_1000 || '').trim();
        let finalSummary = prevSummary;
        const latestId = rows[rows.length - 1].id;

        if (newBodies.length > 0) {
          const prompt = {
            previous_summary: prevSummary,
            new_reviews: newBodies,
            rules: [
              '日本語で書く',
              '1000文字以内（できれば800文字以内）',
              '良い点/悪い点/注意点/おすすめ対象をバランスよく',
              '個人名は伏せる',
              '箇条書きOK。読みやすさ優先',
            ],
          };

          const resp = await openaiForSummary.responses.create({
            model: summaryModel,
            input: [
              {
                role: 'developer',
                content:
                  'あなたは企業レビューの要約担当です。過去要約と新規レビュー本文から最新の統合要約を作成してください。',
              },
              { role: 'user', content: JSON.stringify(prompt) },
            ],
          });

          finalSummary = (resp.output_text || '').trim();

          const { error: sumUpdErr } = await supabaseAdmin
            .from('company_rollups')
            .update({
              summary_1000: finalSummary,
              last_processed_review_id: latestId,
              is_dirty: false,
              updated_at: new Date().toISOString(),
            })
            .eq('university_id', universityId)
            .eq('faculty', faculty)
            .eq('company_id', companyId);

          if (sumUpdErr) throw sumUpdErr;

          summariesUpdated += 1;
          result.summary_updated = true;
        } else {
          const { error: clearErr } = await supabaseAdmin
            .from('company_rollups')
            .update({
              last_processed_review_id: latestId,
              is_dirty: false,
              updated_at: new Date().toISOString(),
            })
            .eq('university_id', universityId)
            .eq('faculty', faculty)
            .eq('company_id', companyId);

          if (clearErr) throw clearErr;

          result.summary_updated = false;
        }

        const normalizedSummary = normalizeSummaryForEmbedding(finalSummary);
        const summaryHash = sha256Hex(normalizedSummary);

        const { data: embRow, error: embSelErr } = await supabaseAdmin
          .from('company_rollup_embeddings')
          .select('university_id,faculty,company_id,content_hash')
          .eq('university_id', universityId)
          .eq('faculty', faculty)
          .eq('company_id', companyId)
          .maybeSingle();

        if (embSelErr) throw embSelErr;

        const current = (embRow || null) as RollupEmbeddingRow | null;
        const needsEmbedding = !current || current.content_hash !== summaryHash;

        if (needsEmbedding) {
          if (normalizedSummary.length === 0) {
            const { error: upErr } = await supabaseAdmin
              .from('company_rollup_embeddings')
              .upsert(
                {
                  university_id: universityId,
                  faculty,
                  company_id: companyId,
                  embedding: null,
                  model: rollupEmbeddingModel,
                  content_hash: summaryHash,
                },
                { onConflict: 'university_id,faculty,company_id' }
              );

            if (upErr) throw upErr;

            rollupEmbeddingsUpdated += 1;
            result.rollup_embedding_updated = true;
          } else {
            const embResp = await openaiForRollupEmbedding.embeddings.create({
              model: rollupEmbeddingModel,
              input: normalizedSummary,
            });

            const vec = embResp.data?.[0]?.embedding;
            if (!vec || !Array.isArray(vec)) {
              throw new Error('failed to create rollup embedding (no vector returned)');
            }

            const { error: upErr } = await supabaseAdmin
              .from('company_rollup_embeddings')
              .upsert(
                {
                  university_id: universityId,
                  faculty,
                  company_id: companyId,
                  embedding: vec,
                  model: rollupEmbeddingModel,
                  content_hash: summaryHash,
                },
                { onConflict: 'university_id,faculty,company_id' }
              );

            if (upErr) throw upErr;

            rollupEmbeddingsUpdated += 1;
            result.rollup_embedding_updated = true;
          }
        } else {
          result.rollup_embedding_updated = false;
        }

        perRollup.push(result);
      } catch (e: any) {
        result.ok = false;
        result.kept_dirty = true;
        result.errors.push({ message: e?.message ?? String(e) });

        keptDirty += 1;

        const { error: keepErr } = await supabaseAdmin
          .from('company_rollups')
          .update({ is_dirty: true, updated_at: new Date().toISOString() })
          .eq('university_id', universityId)
          .eq('faculty', faculty)
          .eq('company_id', companyId);

        if (keepErr) {
          result.errors.push({
            type: 'keep_dirty_update_failed',
            details: supabaseErrorToJson(keepErr),
          });
        }

        perRollup.push(result);
      }
    }

    return NextResponse.json({
      ok: true,
      runner,
      elapsed_ms: Date.now() - startedAt,
      counts: {
        rollups: rollups.length,
        stats_updated: statsUpdated,
        summaries_updated: summariesUpdated,
        rollup_embeddings_updated: rollupEmbeddingsUpdated,
        kept_dirty: keptDirty,
      },
      rollups: perRollup,
    });
  } catch (e: any) {
    console.error('[batch/company-rollups/run] fatal:', e);
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
