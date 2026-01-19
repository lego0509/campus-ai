export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const PREFECTURES = [
  '北海道',
  '青森県',
  '岩手県',
  '宮城県',
  '秋田県',
  '山形県',
  '福島県',
  '茨城県',
  '栃木県',
  '群馬県',
  '埼玉県',
  '千葉県',
  '東京都',
  '神奈川県',
  '新潟県',
  '富山県',
  '石川県',
  '福井県',
  '山梨県',
  '長野県',
  '岐阜県',
  '静岡県',
  '愛知県',
  '三重県',
  '滋賀県',
  '京都府',
  '大阪府',
  '兵庫県',
  '奈良県',
  '和歌山県',
  '鳥取県',
  '島根県',
  '岡山県',
  '広島県',
  '山口県',
  '徳島県',
  '香川県',
  '愛媛県',
  '高知県',
  '福岡県',
  '佐賀県',
  '長崎県',
  '熊本県',
  '大分県',
  '宮崎県',
  '鹿児島県',
  '沖縄県',
] as const;

const OUTCOME_CODES = ['offer', 'rejected', 'other'] as const;
const SELECTION_TYPE_CODES = ['es', 'test', 'interview', 'gd', 'assignment', 'other'] as const;
const SALARY_BAND_CODES = [
  'under_300',
  '300_399',
  '400_499',
  '500_599',
  '600_699',
  '700_799',
  '800_899',
  '900_999',
  '1000_plus',
] as const;

type OutcomeCode = (typeof OUTCOME_CODES)[number];
type SelectionTypeCode = (typeof SELECTION_TYPE_CODES)[number];
type SalaryBandCode = (typeof SALARY_BAND_CODES)[number];

type Payload = {
  line_user_id: string;
  university_name: string;
  faculty: string;
  department?: string | null;

  company_id?: string | null;
  company_name?: string | null;
  hq_prefecture?: string | null;

  grad_year: number;
  outcome: OutcomeCode;
  result_month: string;
  selection_types?: string[] | null;
  body_main: string;

  employee_count?: number | null;
  annual_salary_band?: SalaryBandCode | null;
};

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return {
    message: err.message,
    code: err.code,
    details: err.details,
    hint: err.hint,
  };
}

function lineUserIdToHash(lineUserId: string) {
  const pepper = process.env.LINE_HASH_PEPPER;
  if (!pepper) {
    throw new Error('LINE_HASH_PEPPER is not set');
  }
  return createHmac('sha256', pepper).update(lineUserId, 'utf8').digest('hex');
}

async function getOrCreateUserId(lineUserId: string) {
  const hash = lineUserIdToHash(lineUserId);

  const { data: found, error: findErr } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('line_user_hash', hash)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id;

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
    return again.id;
  }

  if (insErr) throw insErr;
  return inserted.id;
}

async function getOrCreateUniversityId(name: string) {
  const { data: found, error: findErr } = await supabaseAdmin
    .from('universities')
    .select('id')
    .eq('name', name)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id;

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('universities')
    .insert({ name })
    .select('id')
    .single();

  if (insErr && (insErr as any).code === '23505') {
    const { data: again, error: againErr } = await supabaseAdmin
      .from('universities')
      .select('id')
      .eq('name', name)
      .single();

    if (againErr) throw againErr;
    if (!again) throw new Error('university conflict retry failed');
    return again.id;
  }

  if (insErr) throw insErr;
  return inserted.id;
}

async function resolveCompanyId(params: {
  companyId?: string | null;
  companyName?: string | null;
  hqPrefecture?: string | null;
}) {
  const { companyId, companyName, hqPrefecture } = params;

  if (companyId) {
    const { data, error } = await supabaseAdmin
      .from('companies')
      .select('id, name, hq_prefecture')
      .eq('id', companyId)
      .maybeSingle();

    if (error) throw error;
    if (!data?.id) throw new Error('company not found');
    return { id: data.id, hq_prefecture: data.hq_prefecture };
  }

  const name = (companyName ?? '').trim();
  const prefecture = (hqPrefecture ?? '').trim();

  if (!name) throw new Error('company_name is required');
  if (!prefecture) throw new Error('hq_prefecture is required');
  if (!PREFECTURES.includes(prefecture as (typeof PREFECTURES)[number])) {
    throw new Error('hq_prefecture must be a valid prefecture');
  }

  const { data: found, error: findErr } = await supabaseAdmin
    .from('companies')
    .select('id, hq_prefecture')
    .eq('name', name)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return { id: found.id, hq_prefecture: found.hq_prefecture };

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('companies')
    .insert({ name, hq_prefecture: prefecture })
    .select('id, hq_prefecture')
    .single();

  if (insErr && (insErr as any).code === '23505') {
    const { data: again, error: againErr } = await supabaseAdmin
      .from('companies')
      .select('id, hq_prefecture')
      .eq('name', name)
      .single();

    if (againErr) throw againErr;
    if (!again) throw new Error('company conflict retry failed');
    return { id: again.id, hq_prefecture: again.hq_prefecture };
  }

  if (insErr) throw insErr;
  return { id: inserted.id, hq_prefecture: inserted.hq_prefecture };
}

function normalizeResultMonth(raw: string) {
  const match = raw.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!match) throw new Error('result_month must be YYYY-MM');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new Error('result_month year out of range');
  }
  if (month < 1 || month > 12) throw new Error('result_month month invalid');
  return `${match[1]}-${match[2]}-01`;
}

export async function POST(req: Request) {
  let insertedReviewId: string | null = null;

  try {
    const body = (await req.json()) as Payload;

    const universityName = body.university_name?.trim();
    const faculty = body.faculty?.trim();
    const department = body.department?.trim() || null;
    const bodyMain = body.body_main?.trim();

    if (!body.line_user_id) {
      return NextResponse.json({ error: 'line_user_id is required' }, { status: 400 });
    }
    if (!universityName || !faculty) {
      return NextResponse.json({ error: 'missing required text' }, { status: 400 });
    }
    if (!bodyMain) {
      return NextResponse.json({ error: 'body_main is required' }, { status: 400 });
    }

    if (!Number.isInteger(body.grad_year) || body.grad_year < 1990 || body.grad_year > 2100) {
      return NextResponse.json({ error: 'grad_year must be 1990-2100' }, { status: 400 });
    }

    if (!OUTCOME_CODES.includes(body.outcome)) {
      return NextResponse.json({ error: 'outcome invalid' }, { status: 400 });
    }

    if (!body.result_month) {
      return NextResponse.json({ error: 'result_month is required' }, { status: 400 });
    }

    const normalizedResultMonth = normalizeResultMonth(body.result_month);

    const employeeCount = body.employee_count ?? null;
    if (employeeCount !== null) {
      if (!Number.isInteger(employeeCount) || employeeCount <= 0) {
        return NextResponse.json({ error: 'employee_count must be positive integer' }, { status: 400 });
      }
    }

    if (body.annual_salary_band) {
      if (!SALARY_BAND_CODES.includes(body.annual_salary_band)) {
        return NextResponse.json({ error: 'annual_salary_band invalid' }, { status: 400 });
      }
    }

    const selectionTypesRaw = Array.isArray(body.selection_types) ? body.selection_types : [];
    const selectionTypes = Array.from(
      new Set(
        selectionTypesRaw
          .map((s) => String(s).trim())
          .filter((s) => s.length > 0)
      )
    );

    const invalidSelection = selectionTypes.find(
      (s) => !SELECTION_TYPE_CODES.includes(s as SelectionTypeCode)
    );
    if (invalidSelection) {
      return NextResponse.json(
        { error: `selection_types invalid: ${invalidSelection}` },
        { status: 400 }
      );
    }

    const [userId, universityId] = await Promise.all([
      getOrCreateUserId(body.line_user_id),
      getOrCreateUniversityId(universityName),
    ]);

    {
      const { error: affErr } = await supabaseAdmin
        .from('user_affiliations')
        .upsert(
          {
            user_id: userId,
            university_id: universityId,
            faculty,
            department,
          },
          { onConflict: 'user_id' }
        );

      if (affErr) {
        return NextResponse.json(
          { error: 'failed to upsert user_affiliations', details: supabaseErrorToJson(affErr) },
          { status: 500 }
        );
      }
    }

    const { id: companyId } = await resolveCompanyId({
      companyId: body.company_id ?? null,
      companyName: body.company_name ?? null,
      hqPrefecture: body.hq_prefecture ?? null,
    });

    const { data: inserted, error: insReviewErr } = await supabaseAdmin
      .from('company_reviews')
      .insert({
        user_id: userId,
        university_id: universityId,
        faculty,
        department,
        company_id: companyId,
        grad_year: body.grad_year,
        outcome: body.outcome,
        result_month: normalizedResultMonth,
        employee_count: employeeCount,
        annual_salary_band: body.annual_salary_band ?? null,
        selection_types: selectionTypes,
        body_main: bodyMain,
      })
      .select('id')
      .single();

    if (insReviewErr || !inserted?.id) {
      return NextResponse.json(
        { error: 'failed to insert company_reviews', details: supabaseErrorToJson(insReviewErr) },
        { status: 400 }
      );
    }

    insertedReviewId = inserted.id;

    // ----------------------------
    // 7) company_embedding_jobs を queued で積む
    // ----------------------------
    {
      const { error: jobErr } = await supabaseAdmin
        .from('company_embedding_jobs')
        .upsert(
          {
            review_id: insertedReviewId,
            status: 'queued',
            attempt_count: 0,
            last_error: null,
            locked_at: null,
            locked_by: null,
          },
          { onConflict: 'review_id' }
        );

      if (jobErr) {
        await supabaseAdmin.from('company_reviews').delete().eq('id', insertedReviewId);
        insertedReviewId = null;

        return NextResponse.json(
          { error: 'failed to upsert company_embedding_jobs', details: supabaseErrorToJson(jobErr) },
          { status: 500 }
        );
      }
    }

    // ----------------------------
    // 8) company_rollups を dirty にする
    // ----------------------------
    {
      const { data: existing, error: findErr } = await supabaseAdmin
        .from('company_rollups')
        .select('id')
        .eq('company_id', companyId)
        .maybeSingle();

      if (findErr) {
        await supabaseAdmin.from('company_reviews').delete().eq('id', insertedReviewId);
        insertedReviewId = null;

        return NextResponse.json(
          { error: 'failed to fetch company_rollups', details: supabaseErrorToJson(findErr) },
          { status: 500 }
        );
      }

      if (existing?.id) {
        const { error: updErr } = await supabaseAdmin
          .from('company_rollups')
          .update({ is_dirty: true })
          .eq('id', existing.id);

        if (updErr) {
          await supabaseAdmin.from('company_reviews').delete().eq('id', insertedReviewId);
          insertedReviewId = null;

          return NextResponse.json(
            { error: 'failed to update company_rollups', details: supabaseErrorToJson(updErr) },
            { status: 500 }
          );
        }
      } else {
        const { error: insErr } = await supabaseAdmin
          .from('company_rollups')
          .insert({ company_id: companyId, is_dirty: true });

        if (insErr) {
          await supabaseAdmin.from('company_reviews').delete().eq('id', insertedReviewId);
          insertedReviewId = null;

          return NextResponse.json(
            { error: 'failed to insert company_rollups', details: supabaseErrorToJson(insErr) },
            { status: 500 }
          );
        }
      }
    }

    return NextResponse.json({ ok: true, review_id: insertedReviewId, company_id: companyId });
  } catch (e: any) {
    console.error('[company-reviews] POST error:', e);

    if (insertedReviewId) {
      try {
        await supabaseAdmin.from('company_reviews').delete().eq('id', insertedReviewId);
      } catch {
        // ignore cleanup failures
      }
    }

    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}
