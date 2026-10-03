import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import InventoryForm from "@/app/components/inventory-form";

export const dynamic = "force-dynamic";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const messages: Record<string, string> = {
  invalid: "შეამოწმეთ შეყვანილი რაოდენობები.",
  duplicate: "ერთი პროდუქტი ორჯერ არის მითითებული.",
  note: "შენიშვნა ძალიან გრძელია (მაქს. 500 სიმბოლო).",
  reason: "ყოველ შესწორებულ პროდუქტზე მიზეზი აუცილებელია.",
  nothing: "ცვლილება არ არის — არცერთი რაოდენობა არ შეგიცვლიათ.",
  unavailable: "ერთ-ერთი პროდუქტი აღარ არის ხელმისაწვდომი. განაახლეთ გვერდი.",
  conflict: "ეს მოთხოვნა უკვე გაგზავნილია სხვა მონაცემებით. განაახლეთ გვერდი.",
  failed: "ინვენტარიზაცია ვერ შენახულა. შეამოწმეთ მონაცემები და წვდომა.",
};

export default async function NewInventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; request?: string }>;
}) {
  await requireAdmin();
  const client = await posClient();
  const params = await searchParams;

  const { data: catalog, error } = await client.rpc("pos_inventory_catalog");
  if (error) console.error("[inventories/new] catalog failed:", error.code, error.message);

  let recovered: string | null = null;
  if (params.error === "failed" && params.request && uuidRe.test(params.request)) {
    const { data } = await client
      .from("pos_inventories")
      .select("id")
      .eq("request_id", params.request)
      .maybeSingle();
    recovered = data?.id ?? null;
  }

  const requestId = crypto.randomUUID();

  return (
    <>
      <div className="analytics-head">
        <h1>ახალი ინვენტარიზაცია</h1>
        <Link href="/inventories" className="button secondary">← სიაში</Link>
      </div>

      {error && (
        <p className="notice error" role="alert">
          პროდუქტების სია ვერ ჩაიტვირთა. გადაამოწმეთ ინვენტარიზაციის მიგრაცია.
        </p>
      )}
      {recovered ? (
        <p className="notice success" role="status">
          წინა ინვენტარიზაცია მაინც შეინახა. <Link href={`/inventories/${recovered}`}>გახსნა</Link> — ხელახლა არ გააფორმოთ.
        </p>
      ) : params.error ? (
        <p className="notice error" role="alert">{messages[params.error] ?? messages.failed}</p>
      ) : null}

      <InventoryForm key={requestId} catalog={catalog ?? []} requestId={requestId} />
    </>
  );
}
