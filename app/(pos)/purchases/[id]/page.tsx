import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/server";
import { money, posClient } from "@/lib/pos/server";

export const dynamic = "force-dynamic";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const qty = (v: string | number) => Number(v).toLocaleString("ka-GE", { maximumFractionDigits: 3 });

type Change = { line?: number; sku?: string | null; name?: string; field: string; old: string | number | null; new: string | number | null };
const fieldLabel: Record<string, string> = { quantity: "რაოდენობა", unit_price: "შესყიდვის ფასი", note: "შენიშვნა" };
const showValue = (field: string, value: string | number | null) => {
  if (value === null || value === "") return "—";
  if (field === "quantity") return qty(value);
  if (field === "unit_price") return money(value);
  return String(value);
};

export default async function PurchasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; edited?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { saved, edited } = await searchParams;
  if (!uuidRe.test(id)) notFound();
  const client = await posClient();

  const [{ data: purchase }, { data: items }, { data: history }] = await Promise.all([
    client
      .from("pos_purchases")
      .select("id,purchase_number,actor_name,note,items_count,total,created_at")
      .eq("id", id)
      .maybeSingle(),
    client
      .from("pos_purchase_items")
      .select("id,line_number,sku,product_name,variant_name,quantity,unit_price,previous_price,line_total")
      .eq("purchase_id", id)
      .order("line_number")
      .limit(1000),
    client
      .from("pos_purchase_history")
      .select("id,actor_name,changes,total_before,total_after,created_at")
      .eq("purchase_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  if (!purchase) notFound();

  return (
    <>
      <div className="analytics-head">
        <h1>შესყიდვა №{purchase.purchase_number}</h1>
        <div className="filter-actions">
          <Link href={`/purchases/${id}/edit`} className="button primary">რედაქტირება</Link>
          <Link href="/purchases" className="button secondary">← სიაში</Link>
        </div>
      </div>

      {edited && <p className="notice success" role="status">ცვლილება შენახულია და ისტორიაში ჩაიწერა.</p>}
      {saved && <p className="notice success" role="status">შესყიდვა შენახულია, მარაგი და შესყიდვის ფასები განახლდა.</p>}

      <section className="panel">
        <div className="stat-grid stat-grid-2">
          <div className="stat"><span>ვინ გააკეთა</span><strong>{purchase.actor_name}</strong></div>
          <div className="stat">
            <span>როდის</span>
            <strong>{new Date(purchase.created_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}</strong>
          </div>
          <div className="stat"><span>პოზიციები</span><strong>{purchase.items_count}</strong></div>
          <div className="stat"><span>ჯამი</span><strong>{money(purchase.total)}</strong></div>
        </div>
        {purchase.note && <p><strong>შენიშვნა:</strong> {purchase.note}</p>}
      </section>

      <section className="panel">
        <h2>რა შეიძინა</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ბარკოდი</th>
                <th>პროდუქტი</th>
                <th>რაოდენობა</th>
                <th>წინა ფასი</th>
                <th>შესყიდვის ფასი</th>
                <th>ჯამი</th>
              </tr>
            </thead>
            <tbody>
              {(items ?? []).map((item) => (
                <tr key={item.id}>
                  <td>{item.sku ?? ""}</td>
                  <td>{item.product_name}{item.variant_name ? ` / ${item.variant_name}` : ""}</td>
                  <td>{qty(item.quantity)}</td>
                  <td>{item.previous_price === null ? "—" : money(item.previous_price)}</td>
                  <td>{money(item.unit_price)}</td>
                  <td>{money(item.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>ცვლილებების ისტორია</h2>
        {(history ?? []).length === 0 ? (
          <p className="muted">ეს შესყიდვა არ შეცვლილა.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>როდის</th>
                  <th>ვინ შეცვალა</th>
                  <th>რა შეიცვალა</th>
                  <th>ჯამი</th>
                </tr>
              </thead>
              <tbody>
                {(history ?? []).map((entry) => {
                  const changes = (Array.isArray(entry.changes) ? entry.changes : []) as unknown as Change[];
                  return (
                    <tr key={entry.id}>
                      <td>{new Date(entry.created_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}</td>
                      <td>{entry.actor_name}</td>
                      <td>
                        {changes.map((change, index) => (
                          <div key={index}>
                            {change.name ? `${change.sku ? `${change.sku} · ` : ""}${change.name}: ` : ""}
                            {fieldLabel[change.field] ?? change.field}{" "}
                            {showValue(change.field, change.old)} → <strong>{showValue(change.field, change.new)}</strong>
                          </div>
                        ))}
                      </td>
                      <td>{money(entry.total_before)} → <strong>{money(entry.total_after)}</strong></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
