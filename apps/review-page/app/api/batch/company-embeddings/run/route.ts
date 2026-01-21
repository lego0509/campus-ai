export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * ---------------------------
 * このエンドポイントの責務
 * ---------------------------
 * - company_embedding_jobs の queued / failed を拾って embedding を作る
 * - company_reviews の本文から SHA256(content_hash) を作る
 * - company_review_embeddings を upsert する（冪等）
 * - company_embedding_jobs を done / failed に更新し、失敗理由を残す
 */

const MAX_JOBS_PER_RUN = 50;
const EMBEDDING_BATCH_SIZE = 16;
const LOCK_STALE_MINUTES = 15;

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return { message: err.message, code: err.code, details: err.details, hint: err.hint };
}

function sha256Hex(text: string) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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
  const expected = requireEnv('BATCH_TOKEN', process.env.BATCH_TOKEN);
  const got = req.headers.get('x-batch-token') || '';
  return got === expected;
}

function getOpenAIForEmbeddings() {
  const apiKey =
    process.env.OPENAI_API_KEY_EMBEDDINGS || process.env.OPENAI_API_KEY || '';
  requireEnv('OPENAI_API_KEY(or _EMBEDDINGS)', apiKey);
  return new OpenAI({ apiKey });
}

function getEmbeddingModel() {
  return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
}

type JobRow = {
  review_id: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  attempt_count: number;
  locked_at: string | null;
  locked_by: string | null;
};

type BodyRow = {
  id: string;
  body_main: string;
};

type EmbMetaRow = {
  review_id: string;
  content_hash: string | null;
};

type FlagRow = {
  review_id: string;
  ai_flagged: boolean;
};

export async function POST(req: Request) {
  const startedAt = Date.now();
  const runner =
    req.headers.get('x-batch-runner') ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    'unknown-runner';

  try {
    if (!checkBatchAuth(req)) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const openai = getOpenAIForEmbeddings();
    const model = getEmbeddingModel();

    const staleBefore = new Date(Date.now() - LOCK_STALE_MINUTES * 60 * 1000).toISOString();

    const { data: jobs, error: jobsErr } = await supabaseAdmin
      .from('company_embedding_jobs')
      .select('review_id,status,attempt_count,locked_at,locked_by')
      .in('status', ['queued', 'failed'])
      .or(`locked_at.is.null,locked_at.lt.${staleBefore}`)
      .order('updated_at', { ascending: true })
      .limit(MAX_JOBS_PER_RUN);

    if (jobsErr) {
      return NextResponse.json(
        { ok: false, error: 'failed to fetch company_embedding_jobs', details: supabaseErrorToJson(jobsErr) },
        { status: 500 }
      );
    }

    const picked = (jobs || []) as JobRow[];

    if (picked.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'no company embedding jobs',
        runner,
        elapsed_ms: Date.now() - startedAt,
        counts: { picked: 0, done: 0, skipped: 0, failed: 0 },
      });
    }

    const reviewIds = picked.map((j) => j.review_id);

    {
      const nowIso = new Date().toISOString();
      const { error: lockErr } = await supabaseAdmin
        .from('company_embedding_jobs')
        .update({
          status: 'processing',
          locked_at: nowIso,
          locked_by: runner,
          updated_at: nowIso,
        })
        .in('review_id', reviewIds)
        .in('status', ['queued', 'failed']);

      if (lockErr) {
        return NextResponse.json(
          { ok: false, error: 'failed to lock company_embedding_jobs', details: supabaseErrorToJson(lockErr) },
          { status: 500 }
        );
      }
    }

    const { data: flaggedRows, error: flaggedErr } = await supabaseAdmin
      .from('company_review_ai_flags')
      .select('review_id,ai_flagged')
      .in('review_id', reviewIds)
      .eq('ai_flagged', true);

    if (flaggedErr) {
      return NextResponse.json(
        { ok: false, error: 'failed to fetch ai flags', details: supabaseErrorToJson(flaggedErr) },
        { status: 500 }
      );
    }

    const flaggedSet = new Set((flaggedRows || []).map((r: FlagRow) => r.review_id));

    if (flaggedSet.size > 0) {
      const flaggedIds = Array.from(flaggedSet);
      const nowIso = new Date().toISOString();

      const { error: delErr } = await supabaseAdmin
        .from('company_review_embeddings')
        .delete()
        .in('review_id', flaggedIds);

      if (delErr) {
        return NextResponse.json(
          { ok: false, error: 'failed to delete flagged embeddings', details: supabaseErrorToJson(delErr) },
          { status: 500 }
        );
      }

      const { error: doneErr } = await supabaseAdmin
        .from('company_embedding_jobs')
        .update({
          status: 'done',
          last_error: 'ai_flagged',
          locked_at: null,
          locked_by: runner,
          updated_at: nowIso,
        })
        .in('review_id', flaggedIds);

      if (doneErr) {
        return NextResponse.json(
          { ok: false, error: 'failed to mark flagged jobs as done', details: supabaseErrorToJson(doneErr) },
          { status: 500 }
        );
      }
    }

    const pickedActive = picked.filter((j) => !flaggedSet.has(j.review_id));

    if (pickedActive.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'no company embedding jobs (all flagged)',
        runner,
        elapsed_ms: Date.now() - startedAt,
        counts: { picked: picked.length, done: 0, skipped: 0, failed: 0 },
      });
    }

    const activeReviewIds = pickedActive.map((j) => j.review_id);

    const bodyMap = new Map<string, string>();
    for (const ids of chunk(activeReviewIds, 200)) {
      const { data: bodies, error: bodiesErr } = await supabaseAdmin
        .from('company_reviews')
        .select('id,body_main')
        .in('id', ids);

      if (bodiesErr) {
        return NextResponse.json(
          { ok: false, error: 'failed to fetch company_reviews', details: supabaseErrorToJson(bodiesErr) },
          { status: 500 }
        );
      }

      for (const b of (bodies || []) as BodyRow[]) {
        bodyMap.set(b.id, b.body_main);
      }
    }

    const hashMap = new Map<string, string | null>();
    for (const ids of chunk(activeReviewIds, 200)) {
      const { data: metas, error: metaErr } = await supabaseAdmin
        .from('company_review_embeddings')
        .select('review_id,content_hash')
        .in('review_id', ids);

      if (metaErr) {
        return NextResponse.json(
          { ok: false, error: 'failed to fetch company_review_embeddings meta', details: supabaseErrorToJson(metaErr) },
          { status: 500 }
        );
      }

      for (const m of (metas || []) as EmbMetaRow[]) {
        hashMap.set(m.review_id, m.content_hash ?? null);
      }
    }

    const need: { review_id: string; body: string; hash: string; attempt_count: number }[] = [];
    const toDoneSkip: string[] = [];
    const toFailMissingBody: { review_id: string; error: string; attempt_count: number }[] = [];

    for (const j of pickedActive) {
      const body = bodyMap.get(j.review_id);
      if (!body || body.trim().length === 0) {
        toFailMissingBody.push({
          review_id: j.review_id,
          attempt_count: j.attempt_count,
          error: 'missing body_main in company_reviews',
        });
        continue;
      }

      const h = sha256Hex(body);
      const existing = hashMap.get(j.review_id) ?? null;

      if (existing && existing === h) {
        toDoneSkip.push(j.review_id);
        continue;
      }

      need.push({ review_id: j.review_id, body, hash: h, attempt_count: j.attempt_count });
    }

    let skipped = 0;
    if (toDoneSkip.length > 0) {
      const nowIso = new Date().toISOString();
      const { error: doneErr } = await supabaseAdmin
        .from('company_embedding_jobs')
        .update({
          status: 'done',
          last_error: null,
          locked_at: null,
          locked_by: runner,
          updated_at: nowIso,
        })
        .in('review_id', toDoneSkip);

      if (doneErr) {
        return NextResponse.json(
          { ok: false, error: 'failed to mark skipped jobs as done', details: supabaseErrorToJson(doneErr) },
          { status: 500 }
        );
      }
      skipped = toDoneSkip.length;
    }

    let failed = 0;
    if (toFailMissingBody.length > 0) {
      const nowIso = new Date().toISOString();
      const rows = toFailMissingBody.map((x) => ({
        review_id: x.review_id,
        status: 'failed',
        attempt_count: x.attempt_count + 1,
        last_error: x.error,
        locked_at: null,
        locked_by: runner,
        updated_at: nowIso,
      }));

      const { error: failErr } = await supabaseAdmin
        .from('company_embedding_jobs')
        .upsert(rows, { onConflict: 'review_id' });

      if (failErr) {
        return NextResponse.json(
          { ok: false, error: 'failed to mark missing-body jobs as failed', details: supabaseErrorToJson(failErr) },
          { status: 500 }
        );
      }
      failed += rows.length;
    }

    let done = 0;

    for (const batch of chunk(need, EMBEDDING_BATCH_SIZE)) {
      const nowIso = new Date().toISOString();

      try {
        const resp = await openai.embeddings.create({
          model,
          input: batch.map((x) => x.body),
          encoding_format: 'float',
        });

        const vecs = (resp.data || []).map((d: any) => d.embedding);
        if (vecs.length !== batch.length) {
          throw new Error(`embedding response mismatch: got ${vecs.length}, expected ${batch.length}`);
        }

        const embedRows = batch.map((x, i) => ({
          review_id: x.review_id,
          embedding: vecs[i],
          model,
          content_hash: x.hash,
          updated_at: nowIso,
        }));

        const { error: upErr } = await supabaseAdmin
          .from('company_review_embeddings')
          .upsert(embedRows, { onConflict: 'review_id' });

        if (upErr) throw upErr;

        const jobRows = batch.map((x) => ({
          review_id: x.review_id,
          status: 'done',
          attempt_count: x.attempt_count + 1,
          last_error: null,
          locked_at: null,
          locked_by: runner,
          updated_at: nowIso,
        }));

        const { error: jobDoneErr } = await supabaseAdmin
          .from('company_embedding_jobs')
          .upsert(jobRows, { onConflict: 'review_id' });

        if (jobDoneErr) throw jobDoneErr;

        done += batch.length;
      } catch (e: any) {
        const msg = e?.message ?? 'embedding batch failed';

        const jobFailRows = batch.map((x) => ({
          review_id: x.review_id,
          status: 'failed',
          attempt_count: x.attempt_count + 1,
          last_error: msg,
          locked_at: null,
          locked_by: runner,
          updated_at: nowIso,
        }));

        const { error: jobFailErr } = await supabaseAdmin
          .from('company_embedding_jobs')
          .upsert(jobFailRows, { onConflict: 'review_id' });

        if (jobFailErr) {
          return NextResponse.json(
            { ok: false, error: 'failed to update company_embedding_jobs to failed', details: supabaseErrorToJson(jobFailErr) },
            { status: 500 }
          );
        }

        failed += batch.length;
      }
    }

    return NextResponse.json({
      ok: true,
      runner,
      elapsed_ms: Date.now() - startedAt,
      counts: {
        picked: picked.length,
        done,
        skipped,
        failed,
      },
    });
  } catch (e: any) {
    console.error('[batch/company-embeddings/run] fatal:', e);
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
