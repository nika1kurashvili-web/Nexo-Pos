"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { rpcClient } from "@/lib/pos/server";
import { safeAuthError } from "@/lib/auth/diagnostics";
import type { Json } from "@/lib/pos/types";

const text = (form: FormData, name: string) =>
  String(form.get(name) ?? "").trim();

const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// RPC-ის შეცდომის კოდი -> გვერდზე ნაჩვენები მოკლე კოდი.
const errorCodes: Record<string, string> = {
  INSUFFICIENT_CASH: "cash",
  RETURN_QUANTITY_EXCEEDED: "quantity",
  REFUND_TOTAL_MISMATCH: "changed",
  OPEN_SESSION_REQUIRED: "session",
  INVALID_RETURN_REASON: "reason",
  REQUEST_CONFLICT: "conflict",
  PAYMENT_METHOD_UNAVAILABLE: "method",
};

export async function completeReturn(form: FormData) {
  const client = await rpcClient();

  const requestId = text(form, "request_id");
  const session = text(form, "session_id");
  const sale = text(form, "sale_id");
  const number = text(form, "sale_number");
  const reason = text(form, "reason");

  const back = /^\d{1,12}$/.test(number)
    ? `/returns?number=${number}`
    : "/returns";
  const sep = back.includes("?") ? "&" : "?";

  if (!uuid(requestId) || !uuid(session) || !uuid(sale)) {
    redirect(`${back}${sep}error=invalid`);
  }

  if (!reason || reason.length > 500) {
    redirect(`${back}${sep}error=reason`);
  }

  let items: Json;
  let refunds: Json;

  try {
    items = JSON.parse(text(form, "items")) as Json;
    refunds = JSON.parse(text(form, "refunds")) as Json;
  } catch {
    redirect(`${back}${sep}error=invalid`);
  }

  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > 500 ||
    !Array.isArray(refunds) ||
    refunds.length > 5
  ) {
    redirect(`${back}${sep}error=invalid`);
  }

  const { error } = await client.rpc("pos_complete_return", {
    p_request: requestId,
    p_session: session,
    p_sale: sale,
    p_items: items,
    p_refunds: refunds,
    p_reason: reason,
  });

  if (error) {
    console.error("[nexo-pos-return]", safeAuthError(error));

    const known = errorCodes[error.message?.trim() ?? ""];

    if (known) {
      redirect(`${back}${sep}error=${known}`);
    }

    // უცნობი შედეგი: დაბრუნება შესაძლოა ჩაწერილიყო. გვერდი request ID-ით შეამოწმებს.
    redirect(`${back}${sep}error=failed&request=${requestId}`);
  }

  revalidatePath("/", "layout");
  revalidatePath("/sales");
  revalidatePath(`/sales/${sale}`);

  redirect(`${back}${sep}saved=1`);
}
