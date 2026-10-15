/*
 * პროდუქტების ცხრილის სვეტების ფილტრები (ექსელის მსგავსი).
 * სუფთა ლოგიკაა, URL პარამეტრები <-> ფილტრის ობიექტი <-> შესაბამისობა.
 */

export const TEXT_KEYS = ["q", "name", "sku"] as const;
export const RANGE_FIELDS = ["stock", "cost", "price", "margin"] as const;
export const FILTER_KEYS = [
  "q", "name", "sku", "cat", "status",
  "stock_min", "stock_max", "cost_min", "cost_max",
  "price_min", "price_max", "margin_min", "margin_max",
] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Record<FilterKey, string>;
export type RawParams = Record<string, string | string[] | undefined>;

const CATS = ["მანქანა", "ტექნიკა", "none"];
const STATUSES = ["active", "inactive", "all"];

export const emptyFilters = (): Filters =>
  Object.fromEntries(FILTER_KEYS.map((key) => [key, ""])) as Filters;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

export function parseNumber(value: string): number | null {
  const cleaned = value.trim().replace(",", ".");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseFilters(raw: RawParams): Filters {
  const out = emptyFilters();
  for (const key of FILTER_KEYS) out[key] = first(raw[key]).trim().slice(0, 100);
  if (!CATS.includes(out.cat)) out.cat = "";
  if (!STATUSES.includes(out.status)) out.status = "";
  // ძველი პარამეტრი „გაუქმებულებიც“
  if (!out.status && first(raw.all) === "1") out.status = "all";
  for (const key of FILTER_KEYS) {
    if (/_(min|max)$/.test(key) && parseNumber(out[key]) === null) out[key] = "";
  }
  return out;
}

export function filtersToQuery(filters: Filters): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) if (filters[key]) params.set(key, filters[key]);
  return params.toString();
}

/** ფორმიდან მოსული query string-ის გასუფთავება (მხოლოდ ცნობილი გასაღებები). */
export function sanitizeQuery(qs: string): string {
  const params = new URLSearchParams(qs.slice(0, 1000));
  const raw: RawParams = {};
  params.forEach((value, key) => { if (raw[key] === undefined) raw[key] = value; });
  return filtersToQuery(parseFilters(raw));
}

export function hasActiveFilters(filters: Filters): boolean {
  return FILTER_KEYS.some((key) => Boolean(filters[key]));
}

export type FilterItem = {
  name: string;
  variant_name: string | null;
  sku: string | null;
  category: string | null;
  stock: string | number;
  cost: string | number | null;
  price: string | number | null;
  active: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function marginOf(item: Pick<FilterItem, "cost" | "price">): number | null {
  if (item.cost === null || item.price === null) return null;
  return round2(Number(item.price) - Number(item.cost));
}

export function matchesFilters(item: FilterItem, f: Filters): boolean {
  if (f.status === "active" || f.status === "") {
    if (!item.active) return false;
  } else if (f.status === "inactive") {
    if (item.active) return false;
  }
  if (f.cat === "none") {
    if (item.category !== null) return false;
  } else if (f.cat && item.category !== f.cat) return false;

  const lower = (s: string) => s.toLowerCase();
  if (f.name && !lower(`${item.name} ${item.variant_name ?? ""}`).includes(lower(f.name))) return false;
  if (f.sku && !lower(item.sku ?? "").includes(lower(f.sku))) return false;
  if (f.q && !lower(`${item.name} ${item.variant_name ?? ""} ${item.sku ?? ""}`).includes(lower(f.q))) return false;

  const values: Record<(typeof RANGE_FIELDS)[number], number | null> = {
    stock: Number(item.stock),
    cost: item.cost === null ? null : Number(item.cost),
    price: item.price === null ? 0 : Number(item.price),
    margin: marginOf(item),
  };
  for (const field of RANGE_FIELDS) {
    const min = parseNumber(f[`${field}_min` as FilterKey]);
    const max = parseNumber(f[`${field}_max` as FilterKey]);
    if (min === null && max === null) continue;
    const value = values[field];
    if (value === null) return false;
    if (min !== null && value < min) return false;
    if (max !== null && value > max) return false;
  }
  return true;
}
