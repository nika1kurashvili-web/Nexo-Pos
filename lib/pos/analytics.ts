import type { AnalyticsProductRow, SalesAnalytics } from "./types";

// Parsing and normalisation of the analytics page filters. Pure functions, no I/O,
// so the exact same rules can be unit-tested.

export const TBILISI_OFFSET = "+04:00";

export type AnalyticsParams = Record<string, string | string[] | undefined>;

export type AnalyticsFilters = {
  from: string;
  to: string;
  product: string;
  sku: string;
  min: string;
  max: string;
  retail: boolean;
  wholesale: boolean;
  customer: string;
  invalid: boolean;
};

export type AnalyticsArgs = {
  p_from: string | null;
  p_to: string | null;
  p_type: "retail" | "wholesale" | null;
  p_customer: string | null;
  p_product: string | null;
  p_sku: string | null;
  p_min: number | null;
  p_max: number | null;
};

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value)?.trim() ?? "";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const moneyRe = /^\d{1,10}(\.\d{1,2})?$/;

export function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

export function tbilisiToday(now = new Date()) {
  return now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tbilisi" });
}

export function addDays(day: string, days: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function parseFilters(params: AnalyticsParams, now = new Date()): AnalyticsFilters {
  const today = tbilisiToday(now);

  // Opening the page without any filter shows the last 30 days.
  if (Object.keys(params).length === 0) {
    return {
      from: addDays(today, -29), to: today, product: "", sku: "", min: "", max: "",
      retail: true, wholesale: true, customer: "", invalid: false,
    };
  }

  const from = first(params.from);
  const to = first(params.to);
  const product = first(params.product).slice(0, 100);
  const sku = first(params.sku).slice(0, 100);
  const min = first(params.min).replace(",", ".");
  const max = first(params.max).replace(",", ".");
  const customer = first(params.customer);

  const types = (Array.isArray(params.type) ? params.type : [params.type ?? ""]).map((t) => t.trim());
  const retail = types.includes("retail");
  const wholesale = types.includes("wholesale");
  // Nothing ticked (or an unticked form) behaves like "everything".
  const both = !retail && !wholesale;

  const invalid = Boolean(
    (from && !validDate(from)) ||
      (to && !validDate(to)) ||
      (from && to && from > to) ||
      (min && !moneyRe.test(min)) ||
      (max && !moneyRe.test(max)) ||
      (min && max && moneyRe.test(min) && moneyRe.test(max) && Number(min) > Number(max)) ||
      (customer && !uuidRe.test(customer)),
  );

  return {
    from, to, product, sku, min, max,
    retail: retail || both,
    wholesale: wholesale || both,
    customer: uuidRe.test(customer) ? customer : "",
    invalid,
  };
}

export function toRpcArgs(filters: AnalyticsFilters): AnalyticsArgs {
  // Dates are whole days in Tbilisi time; "to" is inclusive, so the range ends
  // at the start of the following day.
  const p_from = filters.from ? `${filters.from}T00:00:00${TBILISI_OFFSET}` : null;
  const p_to = filters.to ? `${addDays(filters.to, 1)}T00:00:00${TBILISI_OFFSET}` : null;

  // Choosing a wholesale customer means wholesale sales only.
  let p_type: AnalyticsArgs["p_type"] = null;
  if (filters.customer) p_type = "wholesale";
  else if (filters.retail && !filters.wholesale) p_type = "retail";
  else if (filters.wholesale && !filters.retail) p_type = "wholesale";

  return {
    p_from,
    p_to,
    p_type,
    p_customer: filters.customer || null,
    p_product: filters.product || null,
    p_sku: filters.sku || null,
    p_min: filters.min ? Number(filters.min) : null,
    p_max: filters.max ? Number(filters.max) : null,
  };
}

export const weekdayLabels = ["ორშ", "სამ", "ოთხ", "ხუთ", "პარ", "შაბ", "კვი"] as const;

export type SummaryRow = { label: string; value: number; kind: "money" | "count" | "percent" };

const n = (value: number | string | null | undefined) => Number(value ?? 0);

// Every figure shown in the analytics tiles (but not the weekday chart or the top
// products), in display order. Used by the Excel export.
export function summaryRows(data: SalesAnalytics): SummaryRow[] {
  const t = data.totals;
  const net = n(t.net);
  const profit = n(t.profit);
  const unknown = n(t.unknown_cost_revenue);
  const known = net - unknown;
  const sales = n(t.sales_count);
  const rows: SummaryRow[] = [
    { label: "შემოსული თანხა", value: net, kind: "money" },
    { label: "გაყიდვების ჯამი (დაბრუნებამდე)", value: n(t.gross), kind: "money" },
    { label: "დაბრუნებები", value: n(t.returns), kind: "money" },
    { label: "თვითღირებულება", value: n(t.cost), kind: "money" },
    { label: "მოგება", value: profit, kind: "money" },
  ];
  if (known > 0) rows.push({ label: "მარჟა", value: (profit / known) * 100, kind: "percent" });
  if (unknown > 0) {
    rows.push({ label: "ნავაჭრი შესყიდვის ფასის გარეშე (მოგებაში არ შედის)", value: unknown, kind: "money" });
  }
  rows.push(
    { label: "გაყიდვების რაოდენობა", value: sales, kind: "count" },
    { label: "საშუალო ჩეკი", value: sales > 0 ? net / sales : 0, kind: "money" },
    { label: "გაყიდული ერთეული", value: n(t.quantity), kind: "count" },
  );
  if (data.received !== null) rows.push({ label: "ფაქტობრივად მიღებული", value: n(data.received), kind: "money" });
  if (data.debt !== null) rows.push({ label: "დარჩენილი ვალი", value: n(data.debt), kind: "money" });
  if (data.types.retail) {
    rows.push(
      { label: "საცალო: შემოსული თანხა", value: n(data.types.retail.net), kind: "money" },
      { label: "საცალო: გაყიდვების რაოდენობა", value: n(data.types.retail.sales_count), kind: "count" },
    );
  }
  if (data.types.wholesale) {
    rows.push(
      { label: "საბითუმო: შემოსული თანხა", value: n(data.types.wholesale.net), kind: "money" },
      { label: "საბითუმო: გაყიდვების რაოდენობა", value: n(data.types.wholesale.sales_count), kind: "count" },
    );
  }
  return rows;
}

// Same query string the page uses, so the export always matches what is on screen.
export function filtersToQuery(filters: AnalyticsFilters, overrides?: { from: string; to: string }) {
  const query = new URLSearchParams({
    from: overrides?.from ?? filters.from,
    to: overrides?.to ?? filters.to,
  });
  if (filters.retail && !filters.wholesale) query.append("type", "retail");
  else if (filters.wholesale && !filters.retail) query.append("type", "wholesale");
  else {
    query.append("type", "retail");
    query.append("type", "wholesale");
  }
  if (filters.customer) query.set("customer", filters.customer);
  if (filters.product) query.set("product", filters.product);
  if (filters.sku) query.set("sku", filters.sku);
  if (filters.min) query.set("min", filters.min);
  if (filters.max) query.set("max", filters.max);
  return query.toString();
}

export type ProductSheet = {
  header: string[];
  kinds: ("text" | "count" | "money")[];
  body: (string | number | null)[][];
  totals: (string | number | null)[];
  note: string | null;
};

// One row per product with quantity, purchase price, selling price and totals,
// followed by a totals row. Cost and profit are blank (never zero) when the
// purchase price is unknown, and such rows stay out of the cost/profit totals.
export function productSheet(rows: AnalyticsProductRow[]): ProductSheet {
  const header = [
    "ბარკოდი", "პროდუქტი", "რაოდენობა", "შესყიდვის ფასი", "გაყიდვის ფასი (საშუალო)",
    "თვითღირებულება (ჯამი)", "გაყიდვის ჯამი", "მოგება",
  ];
  const kinds: ProductSheet["kinds"] = ["text", "text", "count", "money", "money", "money", "money", "money"];
  const opt = (value: number | string | null) => (value === null ? null : n(value));

  let quantity = 0;
  let revenue = 0;
  let cost = 0;
  let profit = 0;
  let unknown = false;

  const body = rows.map((row) => {
    quantity += n(row.quantity);
    revenue += n(row.revenue);
    if (row.cost === null) unknown = true;
    else {
      cost += n(row.cost);
      profit += n(row.profit);
    }
    return [
      row.sku ?? "", row.name, n(row.quantity), opt(row.unit_cost), opt(row.avg_price),
      opt(row.cost), n(row.revenue), opt(row.profit),
    ];
  });

  return {
    header,
    kinds,
    body,
    totals: ["", "ჯამი", quantity, null, null, cost, revenue, profit],
    note: unknown
      ? "შესყიდვის ფასის გარეშე პროდუქტებზე თვითღირებულება და მოგება ცარიელია და ჯამებში არ შედის."
      : null,
  };
}
