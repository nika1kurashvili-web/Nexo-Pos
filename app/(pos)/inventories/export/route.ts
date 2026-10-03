import * as XLSX from "xlsx";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { COUNT_SHEET_HEADER } from "@/lib/pos/inventory";
import type { InventoryCatalogItem } from "@/lib/pos/types";

export const dynamic = "force-dynamic";

const clean = (value: string | null) => value?.trim() ?? "";

// შაბლონი = მთელი კატალოგი მიმდინარე მარაგით. „რეალური რაოდენობა“ წინასწარ შევსებულია
// სისტემის რაოდენობით — შეცვალეთ მხოლოდ ის სტრიქონები, რაც არ ემთხვევა.
export async function GET() {
  await requireAdmin();
  const client = await posClient();

  const { data, error } = await client.rpc("pos_inventory_catalog");
  if (error || !data) {
    console.error("[inventory-export] catalog failed:", error?.code, error?.message);
    return new Response("მონაცემები ვერ ჩაიტვირთა", { status: 500 });
  }
  const catalog = data as InventoryCatalogItem[];

  const skuCount = new Map<string, number>();
  for (const item of catalog) {
    const sku = clean(item.sku);
    if (sku) skuCount.set(sku, (skuCount.get(sku) ?? 0) + 1);
  }

  const text = (value: string): XLSX.CellObject => ({ t: "s", v: value });
  const num = (value: number | string | null, z: string): XLSX.CellObject =>
    value === null ? text("") : { t: "n", v: Number(value), z };

  const rows: XLSX.CellObject[][] = [COUNT_SHEET_HEADER.map(text)];
  const skipped: string[][] = [["პროდუქტი", "მიზეზი"]];

  for (const item of catalog) {
    const sku = clean(item.sku);
    if (!sku) {
      skipped.push([item.name, "SKU არ აქვს — ინვენტარიზაციაში ხელით შეიყვანეთ"]);
      continue;
    }
    if ((skuCount.get(sku) ?? 0) > 1) {
      skipped.push([item.name, `SKU „${sku}“ ერთზე მეტ პროდუქტს ეკუთვნის`]);
      continue;
    }
    rows.push([
      text(sku), // ტექსტად, რომ წინა ნულები არ დაიკარგოს
      text(item.name),
      num(item.price, "0.00"),
      num(item.cost, "0.00"),
      num(item.stock, "0.###"),
      num(item.stock, "0.###"),
    ]);
  }

  const sheet = XLSX.utils.aoa_to_sheet([[]]);
  rows.forEach((row, r) => row.forEach((cell, c) => {
    sheet[XLSX.utils.encode_cell({ r, c })] = cell;
  }));
  sheet["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: rows.length - 1, c: COUNT_SHEET_HEADER.length - 1 },
  });
  sheet["!cols"] = [{ wch: 22 }, { wch: 48 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 18 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "ინვენტარიზაცია");
  if (skipped.length > 1) {
    const skippedSheet = XLSX.utils.aoa_to_sheet(skipped);
    skippedSheet["!cols"] = [{ wch: 48 }, { wch: 56 }];
    XLSX.utils.book_append_sheet(workbook, skippedSheet, "გამოტოვებული");
  }

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tbilisi" }).format(new Date());
  const fileName = `ინვენტარიზაცია ${date}.xlsx`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="inventory.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
