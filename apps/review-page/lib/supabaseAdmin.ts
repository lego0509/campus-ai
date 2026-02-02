import { createClient } from '@supabase/supabase-js';
import { getEnv } from './env';

export const supabaseAdmin = createClient(
  getEnv('SUPABASE_URL')!,
  getEnv('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
);
