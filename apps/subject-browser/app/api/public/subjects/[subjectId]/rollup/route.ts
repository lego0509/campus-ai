export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return {
    message: err.message,
    code: err.code,
    details: err.details,
    hint: err.hint,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: { subjectId: string } }
) {
  try {
    const subjectId = params.subjectId;

    const supabaseAdmin = getSupabaseAdmin();
    const { data: subject, error: subjectErr } = await supabaseAdmin
      .from('subjects')
      .select('id, name, university_id')
      .eq('id', subjectId)
      .maybeSingle();

    if (subjectErr) {
      return NextResponse.json(
        { error: 'failed to fetch subject', details: supabaseErrorToJson(subjectErr) },
        { status: 500 }
      );
    }

    if (!subject) {
      return NextResponse.json({ error: 'subject not found' }, { status: 404 });
    }

    const { data: university, error: uniErr } = await supabaseAdmin
      .from('universities')
      .select('id, name')
      .eq('id', subject.university_id)
      .maybeSingle();

    if (uniErr) {
      return NextResponse.json(
        { error: 'failed to fetch university', details: supabaseErrorToJson(uniErr) },
        { status: 500 }
      );
    }

    const { data: rollup, error: rollErr } = await supabaseAdmin
      .from('subject_rollups')
      .select('*')
      .eq('subject_id', subjectId)
      .maybeSingle();

    if (rollErr) {
      return NextResponse.json(
        { error: 'failed to fetch subject_rollups', details: supabaseErrorToJson(rollErr) },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      subject: {
        id: subject.id,
        name: subject.name,
      },
      university: {
        id: university?.id ?? '',
        name: university?.name ?? '',
      },
      rollup: rollup ?? null,
    });
  } catch (e: any) {
    console.error('[public/subjects/:id/rollup] GET error:', e);
    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}
