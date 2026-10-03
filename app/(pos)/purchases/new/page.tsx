import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import PurchaseForm from "@/app/components/purchase-form";

export const dynamic = "force-dynamic";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const messages: Record<string, string> = {
  invalid: "შეამოწმეთ შეყვანილი მონაცემები (რაოდენობა და ფასი).",
  duplicate: "ერთი პროდუქტი ორჯერ არის დამატებული.",
  note: "შენიშვნა ძალიან გრძელია (მაქს. 500 სიმბოლო).",
  unavailable: "ერთ-ერთი პროდუქტი აღარ არის ხელმისაწვდომი. განაახლეთ გვერდი.",
  conflict: "ეს მოთხოვნა უკვე გაგზავნილია სხვა მონაცემებით. განაახლეთ გვერდი.",
  failed: "შესყიდვა ვერ შენახულა. შეამოწმეთ მონაცემები და წვდომა.",
};

export default async function NewPurchasePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; request?: string }>;
}) {
  await requireAdmin();
  const client = await posClient();
  const params = await searchParams;

  const { data: catalog, error } = await client.rpc("pos_inventory_catalog");
  if (error) console.error("[purchases/new] catalog failed:", error.code, error.message);

  let recovered: string | null = null;
  if (params.error === "failed" && params.request && uuidRe.test(params.request)) {
    const { data } = await client
      .from("pos_purchases")
      .select("id")
      .eq("request_id", params.request)
      .maybeSingle();
    recovered = data?.id ?? null;
  }

  const requestId = crypto.randomUUID();

  return (
    <>
      <div className="analytics-head">
        <h1>ახალი შესყიდვა</h1>
        <Link href="/purchases" className="button secondary">← სიაში</Link>
      </div>

      {error && (
        <p className="notice error" role="alert">
          პროდუქტების სია ვერ ჩაიტვირთა. გადაამოწმეთ ინვენტარიზაციის მიგრაცია.
        </p>
      )}
      {recovered ? (
        <p className="notice success" role="status">
          წინა შესყიდვა მაინც შეინახა. <Link href={`/purchases/${recovered}`}>გახსნა</Link> — ხელახლა არ გააფორმოთ.
        </p>
      ) : params.error ? (
        <p className="notice error" role="alert">{messages[params.error] ?? messages.failed}</p>
      ) : null}

      <PurchaseForm
        key={requestId}
        catalog={catalog ?? []}
        requestId={requestId}
      />
    </>
  );
}
