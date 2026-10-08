import * as XLSX from "xlsx";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { filterOrders, orderFigures, sumFigures } from "@/lib/pos/customer-orders";

export const dynamic = "force-dynamic";

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

// კლიენტის შეკვეთები Excel-ში (თარიღის ფილტრით): შეჯამება, პროდუქტები, გადახდები.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const url = new URL(request.url);
  const from = dateRe.test(url.searchParams.get("from") ?? "") ? (url.searchParams.get("from") as string) : "";
  const to = dateRe.test(url.searchParams.get("to") ?? "") ? (url.searchParams.get("to") as string) : "";

  const client = await posClient();
  const [customerRes, ordersRes] = await Promise.all([
    client.from("pos_business_customers").select("id,name").eq("id", id).maybeSingle(),
    client.rpc("pos_corder_list", { p_customer: id }),
  ]);
  if (customerRes.error || ordersRes.error || !ordersRes.data) {
    console.error("[customer-orders-export] failed:", customerRes.error?.code, ordersRes.error?.code);
    return new Response("მონაცემები ვერ ჩაიტვირთა", { status: 500 });
  }
  if (!customerRes.data) notFound();

  const orders = filterOrders(ordersRes.data, from, to).slice().sort((a, b) => a.order_date.localeCompare(b.order_date));

  const text = (value: string): XLSX.CellObject => ({ t: "s", v: value });
  const money = (value: number): XLSX.CellObject => ({ t: "n", v: value, z: "0.00" });
  const count = (value: number | string): XLSX.CellObject => ({ t: "n", v: Number(value), z: "0.###" });
  const sheetOf = (rows: XLSX.CellObject[][], widths: number[]) => {
    const sheet = XLSX.utils.aoa_to_sheet([[]]);
    rows.forEach((row, r) => row.forEach((cell, c) => { sheet[XLSX.utils.encode_cell({ r, c })] = cell; }));
    sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length - 1, 0), c: widths.length - 1 } });
    sheet["!cols"] = widths.map((wch) => ({ wch }));
    return sheet;
  };

  // 1. შეჯამება
  const summary: XLSX.CellObject[][] = [
    ["თარიღი", "შენიშვნა", "ჯამი", "გადახდილი", "დარჩენილი", "შესყიდვა", "სავარაუდო მოგება"].map(text),
  ];
  for (const order of orders) {
    const f = orderFigures(order);
    summary.push([text(order.order_date), text(order.note ?? ""), money(f.total / 100), money(f.paid / 100), money(f.remaining / 100), money(f.cost / 100), money(f.profit / 100)]);
  }
  const sums = sumFigures(orders);
  summary.push([text("სულ"), text(""), money(sums.total / 100), money(sums.paid / 100), money(sums.remaining / 100), money(sums.cost / 100), money(sums.profit / 100)]);

  // 2. პროდუქტები
  const items: XLSX.CellObject[][] = [
    ["შეკვეთის თარიღი", "პროდუქტი", "რაოდენობა", "გასაყიდი ფასი", "შესყიდვის ფასი", "ჯამი", "მოგება"].map(text),
  ];
  for (const order of orders) {
    for (const item of order.items) {
      const sale = Math.round(Number(item.quantity) * Number(item.unit_price) * 100) / 100;
      const hasCost = item.unit_cost !== null;
      const buy = hasCost ? Math.round(Number(item.quantity) * Number(item.unit_cost) * 100) / 100 : 0;
      items.push([
        text(order.order_date),
        text(item.name),
        count(item.quantity),
        money(Number(item.unit_price)),
        hasCost ? money(Number(item.unit_cost)) : text(""),
        money(sale),
        hasCost ? money(Math.round((sale - buy) * 100) / 100) : text(""),
      ]);
    }
  }

  // 3. გადახდები
  const payments: XLSX.CellObject[][] = [["გადახდის თარიღი", "შეკვეთის თარიღი", "თანხა", "შენიშვნა"].map(text)];
  const flat = orders.flatMap((order) => order.payments.map((payment) => ({ order, payment })));
  flat.sort((a, b) => a.payment.paid_on.localeCompare(b.payment.paid_on));
  for (const { order, payment } of flat) {
    payments.push([text(payment.paid_on), text(order.order_date), money(Number(payment.amount)), text(payment.note ?? "")]);
  }
  payments.push([text("სულ"), text(""), money(flat.reduce((s, x) => s + Math.round(Number(x.payment.amount) * 100), 0) / 100), text("")]);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheetOf(summary, [14, 36, 14, 14, 14, 14, 18]), "შეკვეთები");
  XLSX.utils.book_append_sheet(workbook, sheetOf(items, [16, 44, 12, 16, 16, 14, 14]), "პროდუქტები");
  XLSX.utils.book_append_sheet(workbook, sheetOf(payments, [16, 16, 14, 40]), "გადახდები");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tbilisi" }).format(new Date());
  const range = from || to ? ` ${from || "…"}–${to || "…"}` : "";
  const fileName = `${customerRes.data.name} შეკვეთები${range} ${today}.xlsx`.replace(/[\\/:*?"<>|]/g, "-");
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="orders.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
