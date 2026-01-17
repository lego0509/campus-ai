export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return {
    message: err.message,
    code: err.code,
    details: err.details,
    hint: err.hint,
  };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const universityId = searchParams.get('universityId');
    const query = searchParams.get('query')?.trim() ?? '';

    if (!universityId) {
      return NextResponse.json({ error: 'universityId is required' }, { status: 400 });
    }

    let builder = supabaseAdmin
      .from('subjects')
      .select('id, name, subject_rollups(review_count)')
      .eq('university_id', universityId)
      .order('name')
      .limit(200);

    if (query.length > 0) {
      builder = builder.ilike('name', `%${query}%`);
    }

    const { data, error } = await builder;

    if (error) {
      return NextResponse.json(
        { error: 'failed to fetch subjects', details: supabaseErrorToJson(error) },
        { status: 500 }
      );
    }

    const subjects = (data ?? []).map((row: any) => ({
      id: row.id as string,
      name: row.name as string,
      review_count: row.subject_rollups?.review_count ?? 0,
    }));

    return NextResponse.json({ ok: true, subjects });
  } catch (e: any) {
    console.error('[public/subjects] GET error:', e);
    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}
