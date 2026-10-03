import { notFound } from "next/navigation";
import * as XLSX from "xlsx";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { fetchAll } from "@/lib/pos/paginate";

export const dynamic = "force-dynamic";

type ProductRow = { id: string; name: string; sku: string | null; price: string | number };
type VariantRow = ProductRow & { product_id: string };

const clean = (value: string | null) => value?.trim() ?? "";

// ბაზაში ფასების იმპორტი ემთხვევა მხოლოდ SKU-ს მიხედვით, ამიტომ შაბლონში მხოლოდ
// ის პროდუქცია მოდის, რომლის SKU არის და ერთმნიშვნელოვნად ცნობადია.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const client = await posClient();

  const [customerResult, productResult, variantResult, priceResult] = await Promise.all([
    client.from("pos_business_customers").select("name").eq("id", id).maybeSingle(),
    fetchAll<ProductRow>((from, to) => client
      .from("products" as never)
      .select("id,name,sku,price")
      .eq("active", true)
      .order("name")
      .order("id")
      .range(from, to)),
    fetchAll<VariantRow>((from, to) => client
      .from("product_variants" as never)
      .select("id,product_id,name,sku,price")
      .eq("active", true)
      .order("name")
      .order("id")
      .range(from, to)),
    fetchAll<{ product_id: string | null; variant_id: string | null; price: string | number }>((from, to) => client
      .from("pos_customer_prices")
      .select("product_id,variant_id,price")
      .eq("customer_id", id)
      .order("id")
      .range(from, to)),
  ]);

  if (customerResult.error || productResult.error || variantResult.error || priceResult.error) {
    return new Response("მონაცემები ვერ ჩაიტვირთა", { status: 500 });
  }
  if (!customerResult.data) notFound();

  const products = productResult.data;
  const productById = new Map(products.map((product) => [product.id, product]));
  const variants = variantResult.data.filter((variant) => productById.has(variant.product_id));
  const productsWithVariants = new Set(variants.map((variant) => variant.product_id));

  // იგივე წესი, რაც ფასების იმპორტის ბაზის ფუნქციაშია: ერთი SKU ერთზე მეტ ჩანაწერს არ უნდა ეკუთვნოდეს.
  const skuCount = new Map<string, number>();
  for (const sku of [...products.map((p) => clean(p.sku)), ...variants.map((v) => clean(v.sku))]) {
    if (sku) skuCount.set(sku, (skuCount.get(sku) ?? 0) + 1);
  }

  const customerPrice = new Map<string, number>();
  for (const row of priceResult.data) {
    if (row.variant_id !== null) customerPrice.set(`v:${row.variant_id}`, Number(row.price));
    else if (row.product_id !== null) customerPrice.set(`p:${row.product_id}`, Number(row.price));
  }

  const sellable = [
    ...products
      .filter((product) => !productsWithVariants.has(product.id))
      .map((product) => ({
        key: `p:${product.id}`,
        name: product.name,
        sku: clean(product.sku),
        retail: Number(product.price),
      })),
    ...variants.map((variant) => {
      const product = productById.get(variant.product_id)!;
      return {
        key: `v:${variant.id}`,
        name: `${product.name} / ${variant.name}`,
        sku: clean(variant.sku),
        retail: Number(variant.price),
      };
    }),
  ].sort((a, b) => a.name.localeCompare(b.name, "ka"));

  const header = ["SKU", "პროდუქტი", "საცალო ფასი", "ფასი"];
  const rows: XLSX.CellObject[][] = [header.map((value) => ({ t: "s", v: value }))];
  const skipped: string[][] = [["პროდუქტი", "მიზეზი"]];

  for (const item of sellable) {
    if (!item.sku) {
      skipped.push([item.name, "SKU არ აქვს"]);
      continue;
    }
    if ((skuCount.get(item.sku) ?? 0) > 1) {
      skipped.push([item.name, `SKU „${item.sku}“ ერთზე მეტ პროდუქტს ეკუთვნის`]);
      continue;
    }
    const current = customerPrice.get(item.key);
    rows.push([
      { t: "s", v: item.sku }, // ტექსტად, რომ წინა ნულები არ დაიკარგოს
      { t: "s", v: item.name },
      { t: "n", v: item.retail, z: "0.00" },
      current === undefined ? { t: "s", v: "" } : { t: "n", v: current, z: "0.00" },
    ]);
  }

  const sheet = XLSX.utils.aoa_to_sheet([[]]);
  rows.forEach((row, r) => row.forEach((cell, c) => {
    sheet[XLSX.utils.encode_cell({ r, c })] = cell;
  }));
  sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: header.length - 1 } });
  sheet["!cols"] = [{ wch: 22 }, { wch: 48 }, { wch: 14 }, { wch: 14 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "ფასები");
  if (skipped.length > 1) {
    const skippedSheet = XLSX.utils.aoa_to_sheet(skipped);
    skippedSheet["!cols"] = [{ wch: 48 }, { wch: 48 }];
    XLSX.utils.book_append_sheet(workbook, skippedSheet, "გამოტოვებული");
  }

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const fileName = `${customerResult.data.name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "customer"} - ფასები.xlsx`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="prices.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
