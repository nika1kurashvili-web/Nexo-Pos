"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/server";
import { rpcClient } from "@/lib/pos/server";
import { isPrice, isQuantity, normalizeDecimal } from "@/lib/pos/inventory";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

const errorCodes: Record<string, string> = {
  INVALID_DATE: "date",
  INVALID_ITEMS: "items",
  INVALID_NOTE: "note",
  INVALID_AMOUNT: "amount",
  PAYMENT_EXCEEDS_DEBT: "exceeds",
  TOTAL_BELOW_PAID: "below_paid",
  INVALID_ORDER: "missing",
  INVALID_PAYMENT: "missing",
  INVALID_CUSTOMER: "missing",
  POS_ACCESS_DENIED: "denied",
};

const field = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const back = (customer: string) => `/customers/${customer}/orders`;
const validDate = (value: string) => dateRe.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

function fail(customer: string, error?: { message?: string } | null): never {
  redirect(`${back(customer)}?error=${(error?.message && errorCodes[error.message]) || "failed"}`);
}

type RawItem = { kind?: unknown; target?: unknown; name?: unknown; quantity?: unknown; unit_price?: unknown; unit_cost?: unknown };

export async function saveCustomerOrder(form: FormData) {
  await requireAdmin();
  const customer = field(form, "customer_id");
  if (!uuidRe.test(customer)) redirect("/customers");
  const requestId = field(form, "request_id");
  const orderId = field(form, "order_id");
  const date = field(form, "order_date");
  const note = field(form, "note");
  if (!validDate(date) || note.length > 1000 || (orderId && !uuidRe.test(orderId)) || (!orderId && !uuidRe.test(requestId))) {
    redirect(`${back(customer)}?error=invalid`);
  }

  let raw: unknown;
  try { raw = JSON.parse(String(form.get("items") ?? "")); } catch { redirect(`${back(customer)}?error=items`); }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 300) redirect(`${back(customer)}?error=items`);

  const items: { kind: string | null; target: string | null; name: string; quantity: string; unit_price: string; unit_cost: string | null }[] = [];
  for (const row of raw as RawItem[]) {
    const quantity = String(row.quantity ?? "");
    const price = String(row.unit_price ?? "");
    const cost = String(row.unit_cost ?? "").trim();
    const name = String(row.name ?? "").trim();
    const kind = row.kind === "product" || row.kind === "variant" ? row.kind : null;
    const target = typeof row.target === "string" && uuidRe.test(row.target) ? row.target : null;
    if (!name || name.length > 300 || !isQuantity(quantity) || !isPrice(price) || (cost !== "" && !isPrice(cost))) redirect(`${back(customer)}?error=items`);
    items.push({ kind, target, name, quantity: normalizeDecimal(quantity), unit_price: normalizeDecimal(price), unit_cost: cost === "" ? null : normalizeDecimal(cost) });
  }

  const client = await rpcClient();
  const { error } = await client.rpc("pos_corder_save", {
    p_request: orderId ? null : requestId,
    p_order: orderId || null,
    p_customer: customer,
    p_date: date,
    p_note: note || null,
    p_items: items,
  });
  if (error) fail(customer, error);
  revalidatePath(back(customer));
  redirect(`${back(customer)}?saved=1`);
}

export async function deleteCustomerOrder(form: FormData) {
  await requireAdmin();
  const customer = field(form, "customer_id");
  const order = field(form, "order_id");
  if (!uuidRe.test(customer)) redirect("/customers");
  if (!uuidRe.test(order)) redirect(`${back(customer)}?error=missing`);
  const client = await rpcClient();
  const { error } = await client.rpc("pos_corder_delete", { p_order: order });
  if (error) fail(customer, error);
  revalidatePath(back(customer));
  redirect(`${back(customer)}?saved=deleted`);
}

export async function addOrderPayment(form: FormData) {
  await requireAdmin();
  const customer = field(form, "customer_id");
  const order = field(form, "order_id");
  const requestId = field(form, "request_id");
  const date = field(form, "paid_on");
  const note = field(form, "note");
  const amount = field(form, "amount");
  if (!uuidRe.test(customer)) redirect("/customers");
  if (!uuidRe.test(order) || !uuidRe.test(requestId) || note.length > 500) redirect(`${back(customer)}?error=invalid`);
  if (!validDate(date)) redirect(`${back(customer)}?error=date`);
  if (!isPrice(amount) || Number(normalizeDecimal(amount)) <= 0) redirect(`${back(customer)}?error=amount`);
  const client = await rpcClient();
  const { error } = await client.rpc("pos_corder_payment_add", {
    p_request: requestId,
    p_order: order,
    p_amount: normalizeDecimal(amount),
    p_date: date,
    p_note: note || null,
  });
  if (error) fail(customer, error);
  revalidatePath(back(customer));
  redirect(`${back(customer)}?saved=paid`);
}

export async function deleteOrderPayment(form: FormData) {
  await requireAdmin();
  const customer = field(form, "customer_id");
  const payment = field(form, "payment_id");
  if (!uuidRe.test(customer)) redirect("/customers");
  if (!uuidRe.test(payment)) redirect(`${back(customer)}?error=missing`);
  const client = await rpcClient();
  const { error } = await client.rpc("pos_corder_payment_delete", { p_payment: payment });
  if (error) fail(customer, error);
  revalidatePath(back(customer));
  redirect(`${back(customer)}?saved=payment_deleted`);
}
