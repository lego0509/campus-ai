const TEST_DB_KEYS = new Set(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);

export function getEnv(name) {
  if (TEST_DB_KEYS.has(name)) {
    return process.env[`TEST_${name}`] ?? process.env[name];
  }
  return process.env[name];
}
