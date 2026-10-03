"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/server";
import { rpcClient } from "@/lib/pos/server";
import { safeAuthError } from "@/lib/auth/diagnostics";
import { isPrice, isQuantity, normalizeDecimal } from "@/lib/pos/inventory";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const errorCodes: Record<string, string> = {
  REQUEST_CONFLICT: "conflict",
  DUPLICATE_TARGET: "duplicate",
  INVALID_DECIMAL: "invalid",
  INVALID_PURCHASE_ROWS: "invalid",
  INVALID_TARGET: "invalid",
  INVALID_NOTE: "note",
  CATALOG_ITEM_UNAVAILABLE: "unavailable",
};

type RawItem = { kind?: unknown; target?: unknown; quantity?: unknown; unit_price?: unknown };

export async function createPurchase(form: FormData) {
  await requireAdmin();
  const requestId = String(form.get("request_id") ?? "").trim();
  const note = String(form.get("note") ?? "").trim();
  const back = "/purchases/new";

  if (!uuidRe.test(requestId) || note.length > 500) redirect(`${back}?error=invalid`);

  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("items") ?? ""));
  } catch {
    redirect(`${back}?error=invalid`);
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) {
    redirect(`${back}?error=invalid`);
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
      redirect(`${back}?error=invalid`);
    }
    items.push({
      kind: row.kind as string,
      target: row.target as string,
      quantity: normalizeDecimal(quantity),
      unit_price: normalizeDecimal(price),
    });
  }

  const client = await rpcClient();
  const { data, error } = await client.rpc("pos_create_purchase", {
    p_request: requestId,
    p_note: note || null,
    p_items: items,
  });

  if (error) {
    console.error("[nexo-pos-purchase]", safeAuthError(error));
    const known = errorCodes[error.message?.trim() ?? ""];
    if (known) redirect(`${back}?error=${known}`);
    redirect(`${back}?error=failed&request=${requestId}`);
  }

  revalidatePath("/purchases");
  revalidatePath("/inventories");
  redirect(`/purchases/${data}?saved=1`);
}
