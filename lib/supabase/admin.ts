import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "./config";
import type { Database } from "./database.types";
import { adminConfigDiagnostics } from "./admin-diagnostics";

// Import only from authorized Server Actions. Never pass this client/key to JSX.
export function createAuthAdminClient() {
  const config = getSupabaseConfig();
  const rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Environment copy/paste may add an outer newline. Internal whitespace is
  // still rejected; no key contents, claims, or fingerprints are logged.
  const key = rawKey?.trim();
  const metadata = adminConfigDiagnostics(process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, rawKey, Boolean(config));
  const fail = (step: "public_config" | "service_key_missing" | "service_key_whitespace" | "client_create"): never => {
    console.error("[nexo-pos-employee-admin]", JSON.stringify({ category: "configuration", step, ...metadata }));
    throw new Error("EMPLOYEE_SERVER_CONFIGURATION");
  };
  if (!config) return fail("public_config");
  if (!key) return fail("service_key_missing");
  if (/\s/.test(key)) return fail("service_key_whitespace");
  try {
    return createClient<Database>(config.url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, options) => fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) }) },
    });
  } catch {
    // Constructor/runtime failures previously looked identical to missing env.
    return fail("client_create");
  }
}
