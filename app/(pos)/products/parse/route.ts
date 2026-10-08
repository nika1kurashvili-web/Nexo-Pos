import * as XLSX from "xlsx";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { buildImportPlan } from "@/lib/pos/product-import";
import type { ProductOverviewItem } from "@/lib/pos/types";

export const dynamic = "force-dynamic";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_CHANGES = 2000;

// ფაილს მხოლოდ ვკითხულობთ და ვადარებთ მიმდინარე მონაცემებს; არაფერი ინახება.
export async function POST(request: Request) {
  await requireAdmin();
  const client = await posClient();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "ფაილი ვერ წაიკითხა." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return Response.json({ error: "აირჩიეთ Excel ფაილი." }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: "ფაილი ძალიან დიდია (მაქსიმუმ 4 MB)." }, { status: 400 });

  let table: unknown[][];
  try {
    const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return Response.json({ error: "ფაილი ცარიელია." }, { status: 400 });
    table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "" });
  } catch {
    return Response.json({ error: "ფაილის წაკითხვა ვერ მოხერხდა. გამოიყენეთ ჩამოტვირთული .xlsx ფაილი." }, { status: 400 });
  }
  if (table.length > MAX_ROWS) return Response.json({ error: "ფაილში ძალიან ბევრი სტრიქონია." }, { status: 400 });

  const { data, error } = await client.rpc("pos_products_overview");
  if (error || !data) {
    console.error("[products-parse] overview failed:", error?.code, error?.message);
    return Response.json({ error: "პროდუქტების სია ვერ ჩაიტვირთა." }, { status: 500 });
  }
  const plan = buildImportPlan(table, data as ProductOverviewItem[]);
  if ("error" in plan) return Response.json({ error: plan.error }, { status: 400 });
  if (plan.changes.length > MAX_CHANGES) return Response.json({ error: "ერთ ჯერზე მაქსიმუმ 2000 ცვლილება შეიძლება." }, { status: 400 });
  return Response.json(plan);
}
