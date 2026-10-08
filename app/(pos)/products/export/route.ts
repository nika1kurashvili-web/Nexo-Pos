import * as XLSX from "xlsx";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { PRODUCT_SHEET_HEADER } from "@/lib/pos/product-import";
import type { ProductOverviewItem } from "@/lib/pos/types";

export const dynamic = "force-dynamic";

// მთელი კატალოგი (გაუქმებულებიც), რომ ფაილში ყველაფრის გასწორება შეიძლებოდეს.
export async function GET() {
  await requireAdmin();
  const client = await posClient();
  const { data, error } = await client.rpc("pos_products_overview");
  if (error || !data) {
    console.error("[products-export] failed:", error?.code, error?.message);
    return new Response("მონაცემები ვერ ჩაიტვირთა", { status: 500 });
  }
  const items = data as ProductOverviewItem[];

  const text = (value: string): XLSX.CellObject => ({ t: "s", v: value });
  const num = (value: number | string | null, z: string): XLSX.CellObject =>
    value === null || value === "" ? text("") : { t: "n", v: Number(value), z };

  const rows: XLSX.CellObject[][] = [PRODUCT_SHEET_HEADER.map(text)];
  for (const item of items) {
    rows.push([
      text(item.id),
      text(item.name),
      text(item.variant_name ?? ""),
      text(item.category ?? ""),
      text(item.sku ?? ""), // ტექსტად, რომ ბარკოდის წინა ნულები არ დაიკარგოს
      num(item.cost, "0.00"),
      num(item.price, "0.00"),
      num(item.stock, "0.###"),
      text(item.active ? "დიახ" : "არა"),
    ]);
  }

  const sheet = XLSX.utils.aoa_to_sheet([[]]);
  rows.forEach((row, r) => row.forEach((cell, c) => {
    sheet[XLSX.utils.encode_cell({ r, c })] = cell;
  }));
  sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: PRODUCT_SHEET_HEADER.length - 1 } });
  sheet["!cols"] = [{ wch: 38 }, { wch: 42 }, { wch: 20 }, { wch: 14 }, { wch: 22 }, { wch: 16 }, { wch: 16 }, { wch: 10 }, { wch: 10 }];
  sheet["!freeze"] = { xSplit: 0, ySplit: 1 } as never;

  const help = XLSX.utils.aoa_to_sheet([
    ["როგორ გამოვიყენოთ"],
    ["1. შეცვალეთ მხოლოდ სასურველი უჯრები: პროდუქტი, ვარიანტი, ბარკოდი, შესყიდვის ფასი, გასაყიდი ფასი, მარაგი, აქტიური (დიახ/არა)."],
    ["2. პირველი სვეტი (ID) არ შეცვალოთ — მისით ვაკავშირებთ სტრიქონს არსებულ პროდუქტთან."],
    ["   კატეგორია: მხოლოდ „მანქანა“ ან „ტექნიკა“. კატეგორია პროდუქტზეა, ამიტომ ერთი პროდუქტის ყველა ვარიანტს ერთი უნდა ჰქონდეს."],
    ["3. ახალი პროდუქტისთვის დაამატეთ ახალი სტრიქონი ID-ს გარეშე: სახელი და გასაყიდი ფასი აუცილებელია, დანარჩენი არა."],
    ["4. ახალი ვარიანტის დამატება აქედან არ შეიძლება — ის ორდერების აპში ემატება."],
    ["5. სტრიქონის წაშლა ფაილში პროდუქტს არ წაშლის. გასაუქმებლად „აქტიური“ გახადეთ „არა“."],
    ["6. მარაგის ცვლილება ინახება როგორც ინვენტარიზაცია. გაუქმებულ პროდუქტზე მარაგს ვერ შეცვლით."],
    ["7. ატვირთვისას ჯერ გაჩვენებთ რა შეიცვლება, შენახვა მხოლოდ თქვენი დადასტურების შემდეგ ხდება."],
  ]);
  help["!cols"] = [{ wch: 120 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "პროდუქტები");
  XLSX.utils.book_append_sheet(workbook, help, "ინსტრუქცია");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tbilisi" }).format(new Date());
  const fileName = `პროდუქტები ${date}.xlsx`;
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="products.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
