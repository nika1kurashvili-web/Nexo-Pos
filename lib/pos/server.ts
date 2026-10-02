import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requirePosProfile } from "@/lib/auth/server";

export async function posClient() {
  await requirePosProfile();
  const client = await createClient();
  if (!client) throw new Error("POS_CONFIGURATION_MISSING");
  return client;
}

// Hot-path Server Actions (sale, return) only call SECURITY DEFINER RPCs that
// re-check the live POS membership themselves (pos_require_actor), and
// middleware already verifies the session. Skipping the app-level profile
// lookup saves two sequential round trips to Supabase per submit.
export async function rpcClient() {
  const client = await createClient();
  if (!client) throw new Error("POS_CONFIGURATION_MISSING");
  return client;
}

export function money(value: string | number | null) {
  // Presentation only. All accounting and validation uses PostgreSQL numeric.
  return value === null ? "—" : `${Number(value).toLocaleString("ka-GE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₾`;
}
