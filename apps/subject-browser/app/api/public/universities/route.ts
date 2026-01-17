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

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('universities')
      .select('id, name')
      .order('name');

    if (error) {
      return NextResponse.json(
        { error: 'failed to fetch universities', details: supabaseErrorToJson(error) },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, universities: data ?? [] });
  } catch (e: any) {
    console.error('[public/universities] GET error:', e);
    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}
