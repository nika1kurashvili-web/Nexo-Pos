import type { InventoryCatalogItem } from "./types";

export const QUANTITY_RE = /^\d{1,11}([.,]\d{1,3})?$/;
export const PRICE_RE = /^\d{1,12}([.,]\d{1,2})?$/;

// ქართული/ევროპული მძიმით შეყვანილ რიცხვს წერტილიანად ვაქცევთ.
export function normalizeDecimal(value: string): string {
  return value.trim().replace(",", ".");
}

export function isQuantity(value: string): boolean {
  const v = value.trim();
  return QUANTITY_RE.test(v) && Number(normalizeDecimal(v)) > 0;
}

export function isCount(value: string): boolean {
  return QUANTITY_RE.test(value.trim());
}

export function isPrice(value: string): boolean {
  return PRICE_RE.test(value.trim());
}

export const itemKey = (item: Pick<InventoryCatalogItem, "kind" | "id">) =>
  `${item.kind}:${item.id}`;

// ზუსტი ბარკოდის დამთხვევა (სკანერი) — შემთხვევის გარეშე.
export function findBySku(items: InventoryCatalogItem[], code: string) {
  const needle = code.trim().toLowerCase();
  if (!needle) return null;
  return items.find((item) => item.sku?.trim().toLowerCase() === needle) ?? null;
}

export function searchCatalog(items: InventoryCatalogItem[], query: string, limit = 50) {
  const needle = query.trim().toLowerCase();
  if (!needle) return items.slice(0, limit);
  const out: InventoryCatalogItem[] = [];
  for (const item of items) {
    if (
      item.name.toLowerCase().includes(needle) ||
      (item.sku ?? "").toLowerCase().includes(needle)
    ) {
      out.push(item);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// 3 ნიშნამდე ზუსტი სხვაობა ათწილადების ცურვის შეცდომის გარეშე.
export function quantityDifference(counted: string, system: string | number) {
  return Math.round((Number(normalizeDecimal(counted)) - Number(system)) * 1000) / 1000;
}

// ---------------------------------------------------------------- Excel import
export type CountRow = { sku: string; counted: string };

export const COUNT_SHEET_HEADER = ["SKU", "პროდუქტი", "საცალო ფასი", "შესყიდვის ფასი", "სისტემაში", "რეალური რაოდენობა"];

const cellText = (value: unknown) =>
  typeof value === "number" ? String(value) : String(value ?? "").trim();

// ფაილის პირველი სტრიქონი სათაურია: ვეძებთ SKU/ბარკოდის და „რეალური რაოდენობის“ სვეტს.
export function parseCountRows(
  table: unknown[][],
): { rows: CountRow[]; blank: number } | { error: string } {
  const header = (table[0] ?? []).map((cell) => cellText(cell).toLowerCase());
  const skuCol = header.findIndex((h) => h === "sku" || h === "ბარკოდი");
  const countCol = header.findIndex((h) => h.includes("რეალურ") || h === "counted");
  if (skuCol < 0 || countCol < 0) {
    return { error: "ფაილში ვერ მოიძებნა „SKU“ და „რეალური რაოდენობა“ სვეტები. გამოიყენეთ ჩამოტვირთული შაბლონი." };
  }
  const rows: CountRow[] = [];
  let blank = 0;
  for (const line of table.slice(1)) {
    const sku = cellText(line?.[skuCol]);
    if (!sku) continue;
    const counted = cellText(line?.[countCol]);
    if (!counted) {
      blank += 1;
      continue;
    }
    rows.push({ sku, counted });
  }
  return { rows, blank };
}
