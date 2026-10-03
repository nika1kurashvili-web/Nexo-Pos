import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";

export const dynamic = "force-dynamic";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const qty = (v: string | number) => Number(v).toLocaleString("ka-GE", { maximumFractionDigits: 3 });

export default async function InventoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { saved } = await searchParams;
  if (!uuidRe.test(id)) notFound();
  const client = await posClient();

  const [{ data: inventory }, { data: items }] = await Promise.all([
    client
      .from("pos_inventories")
      .select("id,inventory_number,actor_name,note,items_count,created_at")
      .eq("id", id)
      .maybeSingle(),
    client
      .from("pos_inventory_items")
      .select("id,line_number,sku,product_name,variant_name,system_quantity,counted_quantity,difference,reason")
      .eq("inventory_id", id)
      .order("line_number")
      .limit(2000),
  ]);
  if (!inventory) notFound();

  return (
    <>
      <div className="analytics-head">
        <h1>ინვენტარიზაცია №{inventory.inventory_number}</h1>
        <Link href="/inventories" className="button secondary">← სიაში</Link>
      </div>

      {saved && <p className="notice success" role="status">ინვენტარიზაცია შენახულია, მარაგი განახლდა.</p>}

      <section className="panel">
        <div className="stat-grid stat-grid-2">
          <div className="stat"><span>ვინ გააკეთა</span><strong>{inventory.actor_name}</strong></div>
          <div className="stat">
            <span>როდის</span>
            <strong>{new Date(inventory.created_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}</strong>
          </div>
        </div>
        {inventory.note && <p><strong>შენიშვნა:</strong> {inventory.note}</p>}
      </section>

      <section className="panel">
        <h2>რა შეასწორა ({inventory.items_count})</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ბარკოდი</th>
                <th>პროდუქტი</th>
                <th>იყო</th>
                <th>გახდა</th>
                <th>სხვაობა</th>
                <th>მიზეზი</th>
              </tr>
            </thead>
            <tbody>
              {(items ?? []).map((item) => {
                const diff = Number(item.difference);
                return (
                  <tr key={item.id}>
                    <td>{item.sku ?? ""}</td>
                    <td>{item.product_name}{item.variant_name ? ` / ${item.variant_name}` : ""}</td>
                    <td>{qty(item.system_quantity)}</td>
                    <td>{qty(item.counted_quantity)}</td>
                    <td>{diff > 0 ? `+${qty(diff)}` : qty(diff)}</td>
                    <td>{item.reason}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
