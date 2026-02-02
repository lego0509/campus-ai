export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limitRaw = Number(url.searchParams.get('limit') || 20);
    const limit = Math.max(1, Math.min(50, Number.isFinite(limitRaw) ? limitRaw : 20));

    const { data, error } = await supabaseAdmin
      .from('review_tags')
      .select('name,usage_count')
      .order('usage_count', { ascending: false })
      .order('name', { ascending: true })
      .limit(limit);

    if (error) throw error;

    return NextResponse.json({
      ok: true,
      tags: (data || []).map((t: any) => t.name).filter(Boolean),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
