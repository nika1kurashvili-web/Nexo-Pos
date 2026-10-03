"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/server";
import { rpcClient } from "@/lib/pos/server";
import { safeAuthError } from "@/lib/auth/diagnostics";
import { isCount, normalizeDecimal } from "@/lib/pos/inventory";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const errorCodes: Record<string, string> = {
  REQUEST_CONFLICT: "conflict",
  DUPLICATE_TARGET: "duplicate",
  INVALID_DECIMAL: "invalid",
  INVALID_INVENTORY_ROWS: "invalid",
  INVALID_TARGET: "invalid",
  INVALID_NOTE: "note",
  INVALID_REASON: "reason",
  NOTHING_TO_SAVE: "nothing",
  CATALOG_ITEM_UNAVAILABLE: "unavailable",
};

type RawItem = { kind?: unknown; target?: unknown; counted?: unknown; reason?: unknown };

export async function createInventory(form: FormData) {
  await requireAdmin();
  const requestId = String(form.get("request_id") ?? "").trim();
  const note = String(form.get("note") ?? "").trim();
  const back = "/inventories/new";

  if (!uuidRe.test(requestId) || note.length > 500) redirect(`${back}?error=invalid`);

  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("items") ?? ""));
  } catch {
    redirect(`${back}?error=invalid`);
  }
  if (!Array.isArray(raw) || raw.length > 2000) redirect(`${back}?error=invalid`);
  if (raw.length === 0) redirect(`${back}?error=nothing`);

  const items: { kind: string; target: string; counted: string; reason: string }[] = [];
  for (const row of raw as RawItem[]) {
    const counted = String(row.counted ?? "");
    const reason = String(row.reason ?? "").trim() || "ინვენტარიზაცია";
    if (
      (row.kind !== "product" && row.kind !== "variant") ||
      typeof row.target !== "string" ||
      !uuidRe.test(row.target) ||
      !isCount(counted)
    ) {
      redirect(`${back}?error=invalid`);
    }
    if (reason.length > 500) redirect(`${back}?error=reason`);
    items.push({
      kind: row.kind as string,
      target: row.target as string,
      counted: normalizeDecimal(counted),
      reason,
    });
  }

  const client = await rpcClient();
  const { data, error } = await client.rpc("pos_create_inventory", {
    p_request: requestId,
    p_note: note || null,
    p_items: items,
  });

  if (error) {
    console.error("[nexo-pos-inventory]", safeAuthError(error));
    const known = errorCodes[error.message?.trim() ?? ""];
    if (known) redirect(`${back}?error=${known}`);
    redirect(`${back}?error=failed&request=${requestId}`);
  }

  revalidatePath("/inventories");
  redirect(`/inventories/${data}?saved=1`);
}
