import { createClient } from '@supabase/supabase-js';

let cachedClient: ReturnType<typeof createClient> | null = null;

export function getSupabaseAdmin() {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set');
  }

  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}
