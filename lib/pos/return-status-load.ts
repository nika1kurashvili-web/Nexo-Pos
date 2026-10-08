import "server-only";
import type { posClient } from "./server";
import { computeReturnStatus, type ReturnStatus } from "./return-status";

type Client = Awaited<ReturnType<typeof posClient>>;

const chunks = <T,>(list: T[], size: number) => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// ბევრი გაყიდვის სტატუსი ერთად. მხოლოდ იმ გაყიდვებზე ვკითხულობთ ნივთებს, რომლებსაც დაბრუნება აქვს.
export async function loadReturnStatuses(client: Client, saleIds: string[]): Promise<Map<string, ReturnStatus>> {
  const result = new Map<string, ReturnStatus>();
  const withReturns = new Map<string, string[]>(); // sale_id -> return ids
  for (const part of chunks(saleIds, 50)) {
    const { data } = await client.from("pos_returns").select("id,sale_id").in("sale_id", part);
    for (const row of data ?? []) {
      withReturns.set(row.sale_id, [...(withReturns.get(row.sale_id) ?? []), row.id]);
    }
  }
  const returningSales = [...withReturns.keys()];
  const itemsBySale = new Map<string, { id: string; quantity: string | number }[]>();
  const returnedBySale = new Map<string, { sale_item_id: string; quantity: string | number }[]>();

  for (const part of chunks(returningSales, 50)) {
    const { data } = await client.from("pos_sale_items").select("id,sale_id,quantity").in("sale_id", part);
    for (const row of data ?? []) itemsBySale.set(row.sale_id, [...(itemsBySale.get(row.sale_id) ?? []), row]);
  }
  const saleOfReturn = new Map<string, string>();
  for (const [saleId, ids] of withReturns) for (const id of ids) saleOfReturn.set(id, saleId);
  for (const part of chunks([...saleOfReturn.keys()], 50)) {
    const { data } = await client.from("pos_return_items").select("return_id,sale_item_id,quantity").in("return_id", part);
    for (const row of data ?? []) {
      const saleId = saleOfReturn.get(row.return_id);
      if (saleId) returnedBySale.set(saleId, [...(returnedBySale.get(saleId) ?? []), row]);
    }
  }
  for (const saleId of saleIds) {
    result.set(saleId, withReturns.has(saleId)
      ? computeReturnStatus(itemsBySale.get(saleId) ?? [], returnedBySale.get(saleId) ?? [])
      : "none");
  }
  return result;
}
