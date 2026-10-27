import "server-only";
import { revalidatePath } from "next/cache";
import { rpcClient } from "@/lib/pos/server";
import { safeAuthError } from "@/lib/auth/diagnostics";
import type { Json } from "@/lib/pos/types";

const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export type SaleResult =
  | { ok: true }
  | { ok: false; error: "invalid" | "date" | "failed"; detail?: string };

// იგივე შემოწმებები და იგივე ბაზის ფუნქცია, რაც completeSale-ში (app/(pos)/actions.ts).
export async function submitSale(input: Record<string, unknown>): Promise<SaleResult> {
  const requestId = str(input.request_id);
  const session = str(input.session_id);
  const saleType = str(input.sale_type);
  const customer = str(input.customer_id) || null;
  const tracking = str(input.tracking_code) || null;
  const saleDate = str(input.sale_date);
  const warranty = str(input.warranty_code);
  if (warranty.length > 200) return { ok: false, error: "invalid" };

  if (
    !uuid(requestId) ||
    !uuid(session) ||
    !["retail", "wholesale"].includes(saleType) ||
    (saleDate !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(saleDate))
  ) {
    return { ok: false, error: "invalid" };
  }
  if (saleType === "retail" && customer !== null) return { ok: false, error: "invalid" };
  if (saleType === "wholesale" && (!customer || !uuid(customer))) return { ok: false, error: "invalid" };

  let items: Json;
  let payments: Json;
  try {
    items = JSON.parse(str(input.items)) as Json;
    payments = JSON.parse(str(input.payments)) as Json;
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (!Array.isArray(items) || items.length === 0 || !Array.isArray(payments)) {
    return { ok: false, error: "invalid" };
  }
  if (saleType === "retail" && payments.length === 0) return { ok: false, error: "invalid" };

  const client = await rpcClient();
  const args = {
    p_request: requestId,
    p_session: session,
    p_type: saleType,
    p_customer: saleType === "wholesale" ? customer : null,
    p_tracking: tracking,
    p_items: items,
    p_payments: payments,
    p_date: saleDate || null,
  };
  // საგარანტიო კოდის გარეშე ძველი ფუნქცია გამოიყენება (მიგრაციამდეც მუშაობს).
  const { error } = warranty
    ? await client.rpc("pos_complete_sale_warranty", { ...args, p_warranty: warranty })
    : await client.rpc("pos_complete_sale", args);

  if (error) {
    console.error("[nexo-pos-sale]", safeAuthError(error));
    const code = error.message?.trim() ?? "";
    if (code === "BACKDATE_NOT_ALLOWED" || code === "INVALID_SALE_DATE") return { ok: false, error: "date" };
    return { ok: false, error: "failed", detail: /^[A-Z][A-Z0-9_]{2,60}$/.test(code) ? code : undefined };
  }

  revalidatePath("/", "layout");
  revalidatePath("/sales");
  if (customer) revalidatePath(`/customers/${customer}`);
  return { ok: true };
}
