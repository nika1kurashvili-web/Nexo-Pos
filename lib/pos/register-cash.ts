import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export const cashCents = (value: string | number) => Math.round(Number(value) * 100);

// Read every page: PostgREST's default row limit must not truncate drawer totals.
// No kind filter: both initial cash payments and cash repayments affect drawers.
export async function sessionCashTotals(client: SupabaseClient<Database>, ids: string[]) {
  const totals = new Map(ids.map(id => [id, 0]));
  if (!ids.length) return totals;
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client.from("pos_payments")
      .select("id,session_id,amount").in("session_id", ids).eq("method_code", "cash")
      .order("id").range(offset, offset + 499);
    if (error || !data) return null;
    for (const payment of data) totals.set(payment.session_id,
      (totals.get(payment.session_id) ?? 0) + cashCents(payment.amount));
    if (data.length < 500) return totals;
  }
}
