export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

function toLimit(value: string | null, fallback = 3) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(10, Math.floor(n)));
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const universityName = (searchParams.get('university_name') || '').trim();
    const query = (searchParams.get('q') || '').trim();
    const limit = toLimit(searchParams.get('limit'), 3);

    if (!universityName || !query) {
      return NextResponse.json({ ok: true, subjects: [] });
    }

    let universityId: string | null = null;

    const { data: exact, error: exactErr } = await supabaseAdmin
      .from('universities')
      .select('id')
      .ilike('name', universityName)
      .maybeSingle();

    if (exactErr) throw exactErr;
    if (exact?.id) {
      universityId = exact.id as string;
    } else {
      const { data: hits, error: hitErr } = await supabaseAdmin
        .from('universities')
        .select('id')
        .ilike('name', `%${universityName}%`)
        .order('name', { ascending: true })
        .limit(1);

      if (hitErr) throw hitErr;
      universityId = hits?.[0]?.id ?? null;
    }

    if (!universityId) {
      return NextResponse.json({ ok: true, subjects: [] });
    }

    const { data, error } = await supabaseAdmin
      .from('subjects')
      .select('id,name')
      .eq('university_id', universityId)
      .ilike('name', `${query}%`)
      .order('name', { ascending: true })
      .limit(limit);

    if (error) throw error;

    return NextResponse.json({ ok: true, subjects: data ?? [] });
  } catch (e: any) {
    console.error('[subjects/suggest] GET error:', e);
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
