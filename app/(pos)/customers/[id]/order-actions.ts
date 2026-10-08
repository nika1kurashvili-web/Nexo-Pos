"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/server";
import { rpcClient } from "@/lib/pos/server";
import { safeAuthError } from "@/lib/auth/diagnostics";
import { isPrice, isQuantity, normalizeDecimal } from "@/lib/pos/inventory";

// კლიენტის შეკვეთები: არ ეხება სალაროს, მარაგს და შემოსავლებს. მხოლოდ ადმინი.

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

const errorCodes: Record<string, string> = {
  OVERPAYMENT: "overpay",
  INVALID_DATE: "date",
  INVALID_DECIMAL: "invalid",
  INVALID_ORDER_ROWS: "invalid",
  INVALID_TARGET: "invalid",
  DUPLICATE_TARGET: "duplicate",
  INVALID_NOTE: "invalid",
  CATALOG_ITEM_UNAVAILABLE: "unavailable",
  REQUEST_CONFLICT: "conflict",
};

type RawItem = { kind?: unknown; target?: unknown; quantity?: unknown; unit_price?: unknown };

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

function customerPath(form: FormData) {
  const id = field(form, "customer_id");
  if (!uuidRe.test(id)) redirect("/customers");
  return `/customers/${id}`;
}

function done(
  error: { code?: string; message?: string } | null,
  path: string
): never {
  if (error) {
    console.error("[nexo-pos-customer-order]", safeAuthError(error));
    redirect(`${path}?order_error=${errorCodes[error.message?.trim() ?? ""] ?? "failed"}#orders`);
  }
  revalidatePath(path);
  redirect(`${path}?order_saved=1#orders`);
}

export async function createCustomerOrder(form: FormData) {
  await requireAdmin();
  const path = customerPath(form);
  const requestId = field(form, "request_id");
  const date = field(form, "order_date");
  const note = field(form, "note");
  if (!uuidRe.test(requestId) || !dateRe.test(date) || note.length > 500) {
    redirect(`${path}?order_error=invalid#orders`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(field(form, "items"));
  } catch {
    redirect(`${path}?order_error=invalid#orders`);
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) {
    redirect(`${path}?order_error=invalid#orders`);
  }

  const items: { kind: string; target: string; quantity: string; unit_price: string }[] = [];
  for (const row of raw as RawItem[]) {
    const quantity = String(row.quantity ?? "");
    const price = String(row.unit_price ?? "");
    if (
      (row.kind !== "product" && row.kind !== "variant") ||
      typeof row.target !== "string" ||
      !uuidRe.test(row.target) ||
      !isQuantity(quantity) ||
      !isPrice(price)
    ) {
      redirect(`${path}?order_error=invalid#orders`);
    }
    items.push({
      kind: row.kind as string,
      target: row.target as string,
      quantity: normalizeDecimal(quantity),
      unit_price: normalizeDecimal(price),
    });
  }

  const client = await rpcClient();
  const { error } = await client.rpc("pos_create_customer_order", {
    p_request: requestId,
    p_customer: path.slice("/customers/".length),
    p_date: date,
    p_note: note || null,
    p_items: items,
  });
  done(error, path);
}

export async function recordOrderPayment(form: FormData) {
  await requireAdmin();
  const path = customerPath(form);
  const requestId = field(form, "request_id");
  const orderId = field(form, "order_id");
  const amount = normalizeDecimal(field(form, "amount"));
  const paidOn = field(form, "paid_on");
  if (!uuidRe.test(requestId) || !uuidRe.test(orderId) || !isPrice(amount) || !(Number(amount) > 0) || !dateRe.test(paidOn)) {
    redirect(`${path}?order_error=invalid#orders`);
  }

  const client = await rpcClient();
  const { error } = await client.rpc("pos_record_customer_order_payment", {
    p_request: requestId,
    p_order: orderId,
    p_amount: amount,
    p_paid_on: paidOn,
  });
  done(error, path);
}

export async function deleteOrderPayment(form: FormData) {
  await requireAdmin();
  const path = customerPath(form);
  const paymentId = field(form, "payment_id");
  if (!uuidRe.test(paymentId)) redirect(`${path}?order_error=invalid#orders`);

  const client = await rpcClient();
  const { error } = await client.rpc("pos_delete_customer_order_payment", { p_payment: paymentId });
  done(error, path);
}

export async function deleteCustomerOrder(form: FormData) {
  await requireAdmin();
  const path = customerPath(form);
  const orderId = field(form, "order_id");
  if (!uuidRe.test(orderId)) redirect(`${path}?order_error=invalid#orders`);

  const client = await rpcClient();
  const { error } = await client.rpc("pos_delete_customer_order", { p_order: orderId });
  done(error, path);
}
