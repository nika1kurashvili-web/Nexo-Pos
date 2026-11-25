import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import PurchaseEditForm, { type EditLine } from "@/app/components/purchase-edit-form";

export const dynamic = "force-dynamic";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const messages: Record<string, string> = {
  invalid: "შეამოწმეთ შეყვანილი მონაცემები (რაოდენობა და ფასი).",
  note: "შენიშვნა ძალიან გრძელია (მაქს. 500 სიმბოლო).",
  nochange: "არაფერი შეცვლილა.",
  missing: "შესყიდვა ვერ მოიძებნა.",
  failed: "ცვლილება ვერ შენახულა. შეამოწმეთ მონაცემები, მიგრაცია და წვდომა.",
};

const plain = (v: string | number) => String(Number(v));

export default async function EditPurchasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { error } = await searchParams;
  if (!uuidRe.test(id)) notFound();
  const client = await posClient();

  const [{ data: purchase }, { data: items }] = await Promise.all([
    client.from("pos_purchases").select("id,purchase_number,note").eq("id", id).maybeSingle(),
    client
      .from("pos_purchase_items")
      .select("id,line_number,sku,product_name,variant_name,quantity,unit_price")
      .eq("purchase_id", id)
      .order("line_number")
      .limit(1000),
  ]);
  if (!purchase) notFound();

  const lines: EditLine[] = (items ?? []).map((item) => ({
    id: item.id,
    sku: item.sku,
    name: item.product_name + (item.variant_name ? ` / ${item.variant_name}` : ""),
    quantity: plain(item.quantity),
    unit_price: plain(item.unit_price),
  }));

  return (
    <>
      <div className="analytics-head">
        <h1>შესყიდვის რედაქტირება №{purchase.purchase_number}</h1>
        <Link href={`/purchases/${id}`} className="button secondary">← უკან</Link>
      </div>

      {error && <p className="notice error" role="alert">{messages[error] ?? messages.failed}</p>}

      <PurchaseEditForm purchaseId={id} lines={lines} note={purchase.note ?? ""} />
    </>
  );
}
