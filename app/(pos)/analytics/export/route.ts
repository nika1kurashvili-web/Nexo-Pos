import * as XLSX from "xlsx";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import {
  parseFilters,
  productSheet,
  summaryRows,
  tbilisiToday,
  toRpcArgs,
  type AnalyticsParams,
} from "@/lib/pos/analytics";

export const dynamic = "force-dynamic";

const formats = { money: "#,##0.00", count: "#,##0.###", percent: '0.0"%"' } as const;

export async function GET(request: Request) {
  await requireAdmin();
  const client = await posClient();

  // Same parsing rules as the page, so the file always matches the screen.
  const url = new URL(request.url);
  const params: AnalyticsParams = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    params[key] = values.length > 1 ? values : values[0];
  }
  const filters = parseFilters(params);
  if (filters.invalid) return new Response("ფილტრის მნიშვნელობა არასწორია", { status: 400 });

  const args = toRpcArgs(filters);
  const [summary, products] = await Promise.all([
    client.rpc("pos_sales_analytics", args),
    client.rpc("pos_sales_analytics_products", args),
  ]);
  const data = summary.data;
  const error = summary.error ?? products.error;
  if (error || !data || !products.data) {
    console.error("[analytics-export] rpc failed:", error?.code, error?.message);
    return new Response("მონაცემები ვერ ჩაიტვირთა", { status: 500 });
  }

  let customerName = "ყველა";
  if (filters.customer) {
    const { data: customer } = await client
      .from("pos_business_customers")
      .select("name")
      .eq("id", filters.customer)
      .maybeSingle();
    customerName = customer?.name ?? "—";
  }

  const typeLabel = filters.customer
    ? "საბითუმო"
    : filters.retail && !filters.wholesale
      ? "საცალო"
      : filters.wholesale && !filters.retail
        ? "საბითუმო"
        : "საცალო და საბითუმო";

  const text = (value: string): XLSX.CellObject => ({ t: "s", v: value });

  const filterRows: [string, string][] = [
    ["პერიოდი", `${filters.from || "დასაწყისიდან"} — ${filters.to || "დღემდე"}`],
    ["გაყიდვის ტიპი", typeLabel],
    ["საბითუმო კლიენტი", customerName],
    ["პროდუქტი", filters.product || "ყველა"],
    ["ბარკოდი / SKU", filters.sku || "ყველა"],
    ["ქვითრის ჯამი, მინიმუმი", filters.min || "—"],
    ["ქვითრის ჯამი, მაქსიმუმი", filters.max || "—"],
  ];

  const rows: XLSX.CellObject[][] = [[text("ფილტრები"), text("")]];
  for (const [label, value] of filterRows) rows.push([text(label), text(value)]);
  rows.push([text(""), text("")], [text("სტატისტიკა"), text("")]);
  for (const row of summaryRows(data)) {
    rows.push([text(row.label), { t: "n", v: row.value, z: formats[row.kind] }]);
  }

  const sheet = XLSX.utils.aoa_to_sheet([[]]);
  rows.forEach((row, r) => row.forEach((cell, c) => {
    sheet[XLSX.utils.encode_cell({ r, c })] = cell;
  }));
  sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: 1 } });
  sheet["!cols"] = [{ wch: 52 }, { wch: 28 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "ანალიტიკა");

  const table = productSheet(products.data);
  const cellFor = (value: string | number | null, kind: "text" | "count" | "money"): XLSX.CellObject => {
    if (value === null) return text("");
    if (typeof value === "string") return text(value); // ბარკოდი ტექსტად, წინა ნულები რომ არ დაიკარგოს
    return { t: "n", v: value, z: kind === "count" ? formats.count : formats.money };
  };
  const productRows: XLSX.CellObject[][] = [
    table.header.map((title) => text(title)),
    ...table.body.map((row) => row.map((value, c) => cellFor(value, table.kinds[c]))),
    table.totals.map((value, c) => cellFor(value, table.kinds[c])),
  ];
  if (table.note) productRows.push([text(""), text(table.note)]);

  const productSheetData = XLSX.utils.aoa_to_sheet([[]]);
  productRows.forEach((row, r) => row.forEach((cell, c) => {
    productSheetData[XLSX.utils.encode_cell({ r, c })] = cell;
  }));
  productSheetData["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: productRows.length - 1, c: table.header.length - 1 },
  });
  productSheetData["!cols"] = [{ wch: 20 }, { wch: 46 }, { wch: 12 }, { wch: 16 }, { wch: 22 }, { wch: 22 }, { wch: 16 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(workbook, productSheetData, "პროდუქტები");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="analytics-${tbilisiToday()}.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
