import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requirePosProfile } from "@/lib/auth/server";

export async function posClient() {
  await requirePosProfile();
  const client = await createClient();
  if (!client) throw new Error("POS_CONFIGURATION_MISSING");
  return client;
}

export function money(value: string | number | null) {
  // Presentation only. All accounting and validation uses PostgreSQL numeric.
  return value === null ? "—" : `${Number(value).toLocaleString("ka-GE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₾`;
}
