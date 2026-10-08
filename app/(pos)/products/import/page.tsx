import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import ProductImportForm from "@/app/components/product-import-form";

export const dynamic = "force-dynamic";

const errors: Record<string, string> = {
  invalid: "ცვლილებების მონაცემი არასწორია. ატვირთეთ ფაილი ხელახლა.",
  done: "ეს ატვირთვა უკვე შესრულდა. გახსენით პროდუქტების გვერდი და შეამოწმეთ.",
  import_sku: "ბარკოდი უკვე გამოიყენება სხვა პროდუქტზე ან ძალიან გრძელია.",
  import_name: "სახელი არასწორია.",
  import_price: "გასაყიდი ფასი არასწორია.",
  import_category: "კატეგორია უნდა იყოს „მანქანა“ ან „ტექნიკა“.",
  import_cost: "შესყიდვის ფასი არასწორია.",
  import_unavailable: "პროდუქტი აღარ არსებობს ან გაუქმებულია. ატვირთეთ ახალი ფაილი.",
  import_failed: "ატვირთვა ვერ შესრულდა. არაფერი შეცვლილა. შეამოწმეთ მონაცემები და მიგრაცია.",
};

export default async function ProductImportPage({ searchParams }: { searchParams: Promise<{ error?: string; row?: string }> }) {
  await requireAdmin();
  const params = await searchParams;
  const row = /^\d{1,6}$/.test(params.row ?? "") ? params.row : null;
  return <>
    <div className="analytics-head">
      <h1>პროდუქტების განახლება Excel-ით</h1>
      <Link href="/products" className="button secondary">← პროდუქტებზე</Link>
    </div>
    {params.error && (
      <p className="notice error" role="alert">
        {errors[params.error] ?? errors.import_failed}{row && ` (Excel-ის სტრიქონი ${row})`} არაფერი შენახულა.
      </p>
    )}
    <ProductImportForm requestId={crypto.randomUUID()} />
  </>;
}
