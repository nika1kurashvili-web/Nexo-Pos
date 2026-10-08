// გაყიდვის დაბრუნების სტატუსი: არ დაბრუნებულა / ნაწილი დაბრუნდა / სრულად დაბრუნდა.
export type ReturnStatus = "none" | "partial" | "full";

export const RETURN_STATUS_LABEL: Record<Exclude<ReturnStatus, "none">, string> = {
  partial: "ნაწილი დაბრუნდა",
  full: "სრულად დაბრუნდა",
};

type SaleItemQty = { id: string; quantity: string | number };
type ReturnItemQty = { sale_item_id: string; quantity: string | number };

// რაოდენობები 3 ნიშნამდე მთელებად გადაგვყავს, რომ ათწილადის ცურვა სტატუსს არ ცვლიდეს.
const milli = (value: string | number) => Math.round(Number(value) * 1000);

export function computeReturnStatus(saleItems: SaleItemQty[], returnItems: ReturnItemQty[]): ReturnStatus {
  if (saleItems.length === 0) return "none";
  const returned = new Map<string, number>();
  for (const item of returnItems) {
    returned.set(item.sale_item_id, (returned.get(item.sale_item_id) ?? 0) + milli(item.quantity));
  }
  let any = false;
  let all = true;
  for (const item of saleItems) {
    const back = returned.get(item.id) ?? 0;
    if (back > 0) any = true;
    if (back < milli(item.quantity)) all = false;
  }
  if (!any) return "none";
  return all ? "full" : "partial";
}
