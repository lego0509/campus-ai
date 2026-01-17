export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { POST as runEmbeddings } from '@/app/api/batch/embeddings/run/route';
import { POST as runRollups } from '@/app/api/batch/rollups/run/route';

/**
 * -------------------------------------------
 * 大規模一括リビルド用（単発）エンドポイント
 * -------------------------------------------
 * 目的:
 * - 全レビューの embedding_jobs を queued に戻す
 * - 全科目の subject_rollups を is_dirty = true に戻す
 * - embeddings / rollups のバッチを「空になるまで」繰り返す
 *
 * 注意:
 * - Vercel の関数タイムアウトでは完走できない可能性が高い
 * - 長時間実行できる環境（自前サーバ等）での実行を想定
 */

const REVIEWS_PAGE_SIZE = 500;
const SUBJECTS_PAGE_SIZE = 500;
const MAX_EMBEDDING_LOOPS = 10000;
const MAX_ROLLUP_LOOPS = 10000;

function requireEnv(name: string, value?: string | null) {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function checkBatchAuth(req: Request) {
  const expected = requireEnv('BATCH_TOKEN', process.env.BATCH_TOKEN);
  const got = req.headers.get('x-batch-token') || '';
  return got === expected;
}

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return { message: err.message, code: err.code, details: err.details, hint: err.hint };
}

async function enqueueAllEmbeddingJobs() {
  let lastId = '';
  let total = 0;
  const nowIso = new Date().toISOString();

  while (true) {
    const { data, error } = await supabaseAdmin
      .from('course_reviews')
      .select('id')
      .order('id', { ascending: true })
      .gt('id', lastId)
      .limit(REVIEWS_PAGE_SIZE);

    if (error) {
      throw new Error(`failed to fetch course_reviews: ${JSON.stringify(supabaseErrorToJson(error))}`);
    }

    const rows = data || [];
    if (rows.length === 0) break;

    const payload = rows.map((r) => ({
      review_id: r.id,
      status: 'queued',
      attempt_count: 0,
      last_error: null,
      locked_at: null,
      locked_by: null,
      created_at: nowIso,
      updated_at: nowIso,
    }));

    const { error: upErr } = await supabaseAdmin
      .from('embedding_jobs')
      .upsert(payload, { onConflict: 'review_id' });

    if (upErr) {
      throw new Error(`failed to upsert embedding_jobs: ${JSON.stringify(supabaseErrorToJson(upErr))}`);
    }

    total += rows.length;
    lastId = rows[rows.length - 1].id;
  }

  return total;
}

async function markAllSubjectsDirty() {
  let lastId = '';
  let total = 0;
  const nowIso = new Date().toISOString();

  while (true) {
    const { data, error } = await supabaseAdmin
      .from('subjects')
      .select('id')
      .order('id', { ascending: true })
      .gt('id', lastId)
      .limit(SUBJECTS_PAGE_SIZE);

    if (error) {
      throw new Error(`failed to fetch subjects: ${JSON.stringify(supabaseErrorToJson(error))}`);
    }

    const rows = data || [];
    if (rows.length === 0) break;

    const payload = rows.map((r) => ({
      subject_id: r.id,
      is_dirty: true,
      updated_at: nowIso,
    }));

    const { error: upErr } = await supabaseAdmin
      .from('subject_rollups')
      .upsert(payload, { onConflict: 'subject_id' });

    if (upErr) {
      throw new Error(`failed to upsert subject_rollups: ${JSON.stringify(supabaseErrorToJson(upErr))}`);
    }

    total += rows.length;
    lastId = rows[rows.length - 1].id;
  }

  return total;
}

async function runEmbeddingsOnce(runner: string) {
  const req = new Request('http://localhost/api/batch/embeddings/run', {
    method: 'POST',
    headers: {
      'x-batch-token': process.env.BATCH_TOKEN || '',
      'x-batch-runner': runner,
    },
  });
  const res = await runEmbeddings(req);
  return res.json();
}

async function runRollupsOnce(runner: string) {
  const req = new Request('http://localhost/api/batch/rollups/run', {
    method: 'POST',
    headers: {
      'x-batch-token': process.env.BATCH_TOKEN || '',
      'x-batch-runner': runner,
    },
  });
  const res = await runRollups(req);
  return res.json();
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  const runner =
    req.headers.get('x-batch-runner') ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    'full-rebuild';

  try {
    if (!checkBatchAuth(req)) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const queuedReviews = await enqueueAllEmbeddingJobs();
    const dirtySubjects = await markAllSubjectsDirty();

    let embeddingLoops = 0;
    let rollupLoops = 0;
    let lastEmbedding: any = null;
    let lastRollup: any = null;

    for (; embeddingLoops < MAX_EMBEDDING_LOOPS; embeddingLoops += 1) {
      const result = await runEmbeddingsOnce(runner);
      lastEmbedding = result;
      if (result?.message === 'no embedding jobs' || result?.counts?.picked === 0) {
        break;
      }
    }

    for (; rollupLoops < MAX_ROLLUP_LOOPS; rollupLoops += 1) {
      const result = await runRollupsOnce(runner);
      lastRollup = result;
      if (result?.message === 'no dirty subjects' || result?.counts?.subjects === 0) {
        break;
      }
    }

    return NextResponse.json({
      ok: true,
      runner,
      elapsed_ms: Date.now() - startedAt,
      queued_reviews: queuedReviews,
      dirty_subjects: dirtySubjects,
      loops: { embeddings: embeddingLoops + 1, rollups: rollupLoops + 1 },
      last_embedding_result: lastEmbedding,
      last_rollup_result: lastRollup,
    });
  } catch (e: any) {
    console.error('[batch/full-rebuild/run] fatal:', e);
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
