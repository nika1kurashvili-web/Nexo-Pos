import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { PosFunctions } from "./types";

// Aggregate inside authorized DB functions, not over RLS-filtered payment rows.
// Missing RPCs/errors must never be treated as an empty/free register list.
export function registerState(client: SupabaseClient<Database>) {
  return client.rpc("pos_register_state", {});
}

export function registerSessionReport(
  client: SupabaseClient<Database>,
  filters: PosFunctions["pos_register_session_report"]["Args"],
) {
  return client.rpc("pos_register_session_report", filters);
}
