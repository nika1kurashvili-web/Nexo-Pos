import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "./config";
import type { Database } from "./database.types";

// Import only from authorized Server Actions. Never pass this client/key to JSX.
export function createAuthAdminClient() {
  const config = getSupabaseConfig();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!config || !key || /\s/.test(key)) throw new Error("EMPLOYEE_SERVER_CONFIGURATION");
  return createClient<Database>(config.url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, options) => fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) }) },
  });
}
