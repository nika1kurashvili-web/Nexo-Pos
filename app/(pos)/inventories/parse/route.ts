import * as XLSX from "xlsx";
import { requireAdmin } from "@/lib/auth/server";
import { parseCountRows } from "@/lib/pos/inventory";

export const dynamic = "force-dynamic";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 20000;

// ფაილს მხოლოდ ვკითხულობთ და შედეგს ბრაუზერს ვუბრუნებთ; არაფერი ინახება.
// შენახვა ხდება ჩვეულებრივი ინვენტარიზაციის ფორმიდან, გადახედვის შემდეგ.
export async function POST(request: Request) {
  await requireAdmin();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "ფაილი ვერ წაიკითხა." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "აირჩიეთ Excel ფაილი." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "ფაილი ძალიან დიდია (მაქსიმუმ 4 MB)." }, { status: 400 });
  }

  let table: unknown[][];
  try {
    const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return Response.json({ error: "ფაილი ცარიელია." }, { status: 400 });
    table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "" });
  } catch {
    return Response.json({ error: "ფაილის წაკითხვა ვერ მოხერხდა. გამოიყენეთ .xlsx შაბლონი." }, { status: 400 });
  }
  if (table.length > MAX_ROWS) {
    return Response.json({ error: "ფაილში ძალიან ბევრი სტრიქონია." }, { status: 400 });
  }

  const parsed = parseCountRows(table);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  return Response.json(parsed);
}
