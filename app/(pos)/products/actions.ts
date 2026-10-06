"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/server";
import { rpcClient } from "@/lib/pos/server";
import { safeAuthError } from "@/lib/auth/diagnostics";
import { isCount, isPrice, normalizeDecimal } from "@/lib/pos/inventory";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const errorCodes: Record<string, string> = {
  INVALID_NAME: "name",
  INVALID_SKU: "sku",
  INVALID_PRICE: "price",
  INVALID_COST: "cost",
  INVALID_WEIGHT: "weight",
  SKU_TAKEN: "sku_taken",
  CATALOG_ITEM_UNAVAILABLE: "unavailable",
};

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

function back(form: FormData, extra: string) {
  const q = text(form, "q");
  const all = text(form, "all") === "1";
  const params = new URLSearchParams();
  if (q) params.set("q", q.slice(0, 100));
  if (all) params.set("all", "1");
  const base = params.toString();
  return `/products?${base ? `${base}&` : ""}${extra}`;
}

async function setStock(form: FormData, kind: string, id: string, counted: string, requestId: string) {
  const client = await rpcClient();
  const { error } = await client.rpc("pos_create_inventory", {
    p_request: requestId,
    p_note: "ხელით შესწორება პროდუქტების გვერდიდან",
    p_items: [{ kind, target: id, counted, reason: "ხელით შესწორება" }],
  });
  if (error) {
    console.error("[nexo-pos-products] stock", safeAuthError(error));
    const message = error.message?.trim() ?? "";
    // NOTHING_TO_SAVE = რაოდენობა უკვე ზუსტად ასეთია (სხვა ადამიანმა შეცვალა).
    if (message === "NOTHING_TO_SAVE") return;
    redirect(back(form, `error=${errorCodes[message] ?? "failed"}`));
  }
}

export async function saveProduct(form: FormData) {
  await requireAdmin();
  const kind = text(form, "kind");
  const id = text(form, "id");
  const requestId = text(form, "request_id");
  const price = normalizeDecimal(text(form, "price"));
  const origPrice = normalizeDecimal(text(form, "orig_price"));
  const cost = normalizeDecimal(text(form, "cost"));
  const origCost = normalizeDecimal(text(form, "orig_cost"));
  const stock = normalizeDecimal(text(form, "stock"));
  const origStock = normalizeDecimal(text(form, "orig_stock"));
  if ((kind !== "product" && kind !== "variant") || !uuidRe.test(id) || !uuidRe.test(requestId)) {
    redirect(back(form, "error=invalid"));
  }
  if (!isPrice(price)) redirect(back(form, "error=price"));
  if (!isCount(stock)) redirect(back(form, "error=stock"));
  if (cost !== origCost && !isPrice(cost)) redirect(back(form, "error=cost"));

  const client = await rpcClient();
  if (cost !== origCost && Number(cost) !== Number(origCost || "0")) {
    const { error } = await client.rpc("pos_set_cost", { p_kind: kind, p_id: id, p_cost: cost });
    if (error) {
      console.error("[nexo-pos-products] cost", safeAuthError(error));
      redirect(back(form, `error=${errorCodes[error.message?.trim() ?? ""] ?? "failed"}`));
    }
  }
  if (Number(price) !== Number(origPrice)) {
    const { error } = await client.rpc("pos_update_product", { p_kind: kind, p_id: id, p_price: price, p_active: null });
    if (error) {
      console.error("[nexo-pos-products] price", safeAuthError(error));
      redirect(back(form, `error=${errorCodes[error.message?.trim() ?? ""] ?? "failed"}`));
    }
  }
  if (Number(stock) !== Number(origStock)) await setStock(form, kind, id, stock, requestId);
  revalidatePath("/products");
  redirect(back(form, "saved=1"));
}

export async function toggleProduct(form: FormData) {
  await requireAdmin();
  const kind = text(form, "kind");
  const id = text(form, "id");
  const active = text(form, "active") === "1";
  if ((kind !== "product" && kind !== "variant") || !uuidRe.test(id)) redirect(back(form, "error=invalid"));
  const client = await rpcClient();
  const { error } = await client.rpc("pos_update_product", { p_kind: kind, p_id: id, p_price: null, p_active: !active });
  if (error) {
    console.error("[nexo-pos-products] toggle", safeAuthError(error));
    redirect(back(form, `error=${errorCodes[error.message?.trim() ?? ""] ?? "failed"}`));
  }
  revalidatePath("/products");
  redirect(back(form, active ? "deactivated=1" : "restored=1"));
}

export async function createProduct(form: FormData) {
  await requireAdmin();
  const name = text(form, "name");
  const sku = text(form, "sku");
  const price = normalizeDecimal(text(form, "price"));
  const cost = normalizeDecimal(text(form, "cost"));
  const weight = normalizeDecimal(text(form, "weight")) || "1";
  const stock = normalizeDecimal(text(form, "stock")) || "0";
  const requestId = text(form, "request_id");
  if (!name || name.length > 200) redirect(back(form, "error=name"));
  if (!isPrice(price)) redirect(back(form, "error=price"));
  if (cost && !isPrice(cost)) redirect(back(form, "error=cost"));
  if (!isCount(stock)) redirect(back(form, "error=stock"));
  if (!uuidRe.test(requestId)) redirect(back(form, "error=invalid"));

  const client = await rpcClient();
  const { data, error } = await client.rpc("pos_create_product", {
    p_name: name, p_sku: sku || null, p_price: price, p_cost: cost || null, p_weight: weight,
  });
  if (error || !data) {
    console.error("[nexo-pos-products] create", safeAuthError(error));
    redirect(back(form, `error=${errorCodes[error?.message?.trim() ?? ""] ?? "failed"}`));
  }
  if (Number(stock) > 0) await setStock(form, "product", data as string, stock, requestId);
  revalidatePath("/products");
  redirect(back(form, "created=1"));
}
