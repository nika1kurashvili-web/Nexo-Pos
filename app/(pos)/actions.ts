"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { parsePrice } from "@/lib/pos/import-prices";
import { safeAuthError } from "@/lib/auth/diagnostics";

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const optional = (form: FormData, name: string) => text(form, name) || null;
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function finish(error: { code?: string; message?: string } | null, path: string): never {
  if (error) {
    console.error("[nexo-pos-operation]", safeAuthError(error));
    const reason = error.code === "23505" ? "conflict" : "failed";
    redirect(`${path}?error=${reason}`);
  }
  revalidatePath("/", "layout");
  redirect(`${path}?saved=1`);
}

export async function saveCustomer(form: FormData) {
  await requireAdmin();
  const client = await posClient();
  const id = text(form,"id");
  const path = id && uuid(id) ? `/customers/${id}` : "/customers";
  const name = text(form,"name");
  if (!name || name.length > 200 || (id && !uuid(id))) redirect(`${path}?error=invalid`);
  const values = { name, tax_code: optional(form,"tax_code"), phone: optional(form,"phone"),
    address: optional(form,"address"), email: optional(form,"email"), notes: optional(form,"notes"), active: form.has("active") };
  const { error } = id ? await client.from("pos_business_customers").update(values).eq("id",id)
    : await client.from("pos_business_customers").insert(values);
  finish(error,path);
}

export async function saveRegister(form: FormData) {
  await requireAdmin();
  const client = await posClient();
  const id = text(form,"id"), name = text(form,"name");
  if (!name || name.length > 100 || (id && !uuid(id))) redirect("/registers?error=invalid");
  const values = { name, active: form.has("active") };
  const { error } = id ? await client.from("pos_registers").update(values).eq("id",id) : await client.from("pos_registers").insert(values);
  finish(error,"/registers");
}

export async function savePaymentMethod(form: FormData) {
  await requireAdmin();
  const client = await posClient();
  const { error } = await client.from("pos_payment_methods").update({ active: form.has("active") }).eq("code",text(form,"code"));
  finish(error,"/payment-methods");
}

export async function saveCustomerPrice(form: FormData) {
  await requireAdmin();
  const client = await posClient();
  const customer = text(form,"customer_id"), price = parsePrice(text(form,"price"));
  if (!uuid(customer)) redirect("/customers?error=invalid");
  const path = `/customers/${customer}`;
  const sku = text(form,"sku");
  if (!price || !sku) redirect(`${path}?error=invalid`);
  const { error } = await client.rpc("pos_import_customer_prices", { p_customer: customer, p_rows: [{ sku,price }] });
  finish(error,path);
}

export async function openRegister(form: FormData) {
  const client = await posClient();
  const register = text(form,"register_id"), cash = parsePrice(text(form,"opening_cash"));
  if (!uuid(register) || !cash) redirect("/?error=invalid");
  const { error } = await client.rpc("pos_open_register",{ p_register: register, p_cash: cash });
  finish(error,"/");
}

export async function closeRegister(form: FormData) {
  const client = await posClient();
  const session = text(form,"session_id"), actual = parsePrice(text(form,"actual_cash"));
  if (!uuid(session) || !actual) redirect("/?error=invalid");
  const { error } = await client.rpc("pos_close_register",{ p_session: session, p_actual: actual, p_note: text(form,"note") });
  finish(error,"/");
}
