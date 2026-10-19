import type { AnalyticsProductRow } from "./types";

/*
 * „ნავაჭრის“ ცხრილის სუფთა ლოგიკა: რიგების ნორმალიზება, ფილტრი, დახარისხება, ჯამები.
 * ფასნამატი = მოგება (გასაყიდი ჯამი − შესყიდვის ჯამი); პროცენტი = მოგება / შესყიდვის ჯამი.
 */

export type ProfitRow = {
  name: string;
  sku: string;
  quantity: number;
  unitCost: number | null;
  cost: number | null;
  avgPrice: number | null;
  revenue: number;
  profit: number | null;
  markupPct: number | null;
};

const num = (value: number | string | null | undefined) => (value === null || value === undefined ? null : Number(value));
const round2 = (value: number) => Math.round(value * 100) / 100;

export function toProfitRows(rows: AnalyticsProductRow[]): ProfitRow[] {
  return rows.map((row) => {
    const cost = num(row.cost);
    const profit = num(row.profit);
    return {
      name: row.name,
      sku: row.sku ?? "",
      quantity: Number(row.quantity),
      unitCost: num(row.unit_cost),
      cost: cost === null ? null : round2(cost),
      avgPrice: num(row.avg_price),
      revenue: round2(Number(row.revenue)),
      profit: profit === null ? null : round2(profit),
      markupPct: profit !== null && cost !== null && cost > 0 ? (profit / cost) * 100 : null,
    };
  });
}

export type NumField = "quantity" | "unitCost" | "cost" | "avgPrice" | "revenue" | "profit";
export const NUM_FIELDS: NumField[] = ["quantity", "unitCost", "cost", "avgPrice", "revenue", "profit"];

export type ProfitFilters = {
  name: string;
  sku: string;
  ranges: Partial<Record<NumField, { min: string; max: string }>>;
};

const parse = (value: string | undefined) => {
  const cleaned = (value ?? "").trim().replace(",", ".");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

export function filterRows(rows: ProfitRow[], f: ProfitFilters): ProfitRow[] {
  const name = f.name.trim().toLowerCase();
  const sku = f.sku.trim().toLowerCase();
  return rows.filter((row) => {
    if (name && !row.name.toLowerCase().includes(name)) return false;
    if (sku && !row.sku.toLowerCase().includes(sku)) return false;
    for (const field of NUM_FIELDS) {
      const range = f.ranges[field];
      if (!range) continue;
      const min = parse(range.min);
      const max = parse(range.max);
      if (min === null && max === null) continue;
      const value = row[field];
      if (value === null) return false;
      if (min !== null && value < min) return false;
      if (max !== null && value > max) return false;
    }
    return true;
  });
}

export type SortKey = "name" | "sku" | NumField | "markupPct";

export function sortRows(rows: ProfitRow[], key: SortKey, dir: "asc" | "desc"): ProfitRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    // უცნობი მნიშვნელობები ყოველთვის ბოლოშია
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === "string" && typeof y === "string") return x.localeCompare(y, "ka") * sign;
    return ((x as number) - (y as number)) * sign;
  });
}

export type Totals = { quantity: number; cost: number; revenue: number; profit: number; knownRevenue: number; unknownCount: number; markupPct: number | null };

/** ჯამებში შესყიდვის ფასის გარეშე რიგები არ შედის შესყიდვაში/მოგებაში (არასდროს ითვლება 0-ად). */
export function totalsOf(rows: ProfitRow[]): Totals {
  let quantity = 0, cost = 0, revenue = 0, profit = 0, knownRevenue = 0, unknownCount = 0;
  for (const row of rows) {
    quantity += row.quantity;
    revenue += row.revenue;
    if (row.cost === null || row.profit === null) { unknownCount += 1; continue; }
    cost += row.cost;
    profit += row.profit;
    knownRevenue += row.revenue;
  }
  return {
    quantity: round2(quantity * 1000) / 1000,
    cost: round2(cost),
    revenue: round2(revenue),
    profit: round2(profit),
    knownRevenue: round2(knownRevenue),
    unknownCount,
    markupPct: cost > 0 ? (profit / cost) * 100 : null,
  };
}

const csvCell = (value: string | number | null) => {
  if (value === null) return "";
  const text = String(value);
  return /[",\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function toCsv(rows: ProfitRow[]): string {
  const header = ["დასახელება", "კოდი", "რაოდენობა", "შესყიდვის ფასი", "შესყიდვის ჯამი", "გასაყიდი ფასი", "ჯამური თანხა", "ფასნამატი ₾", "ფასნამატი %"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push([r.name, r.sku, r.quantity, r.unitCost, r.cost, r.avgPrice, r.revenue, r.profit, r.markupPct === null ? null : round2(r.markupPct)].map(csvCell).join(","));
  }
  return "﻿" + lines.join("\r\n");
}
