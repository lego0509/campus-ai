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
    const q = (searchParams.get('q') ?? '').trim();

    if (!q) {
      return NextResponse.json({ ok: true, companies: [] });
    }

    const { data, error } = await supabaseAdmin
      .from('companies')
      .select('id, name, hq_prefecture')
      .ilike('name', `%${q}%`)
      .order('name', { ascending: true })
      .limit(8);

    if (error) {
      return NextResponse.json(
        { error: 'failed to fetch companies', details: supabaseErrorToJson(error) },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, companies: data ?? [] });
  } catch (e: any) {
    console.error('[companies/suggest] GET error:', e);
    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}
