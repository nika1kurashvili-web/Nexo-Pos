import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { money, posClient } from "@/lib/pos/server";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; deleted?: string }>;
}) {
  await requireAdmin();
  const client = await posClient();
  const params = await searchParams;
  const page = /^\d{1,6}$/.test(params.page ?? "") ? Math.max(1, Number(params.page)) : 1;
  const from = (page - 1) * PAGE_SIZE;

  const { data, error, count } = await client
    .from("pos_purchases")
    .select("id,purchase_number,actor_name,items_count,total,note,created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .order("purchase_number", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (error) console.error("[purchases] list failed:", error.code, error.message);
  const rows = data ?? [];

  const itemsByPurchase = new Map<
    string,
    { id: string; line_number: number; sku: string | null; product_name: string; variant_name: string | null; quantity: string | number; unit_price: string | number }[]
  >();
  if (rows.length > 0) {
    const { data: items, error: itemsError } = await client
      .from("pos_purchase_items")
      .select("id,purchase_id,line_number,sku,product_name,variant_name,quantity,unit_price")
      .in("purchase_id", rows.map((row) => row.id))
      .order("line_number")
      .limit(5000);
    if (itemsError) console.error("[purchases] items failed:", itemsError.code, itemsError.message);
    for (const item of items ?? []) {
      const list = itemsByPurchase.get(item.purchase_id) ?? [];
      list.push(item);
      itemsByPurchase.set(item.purchase_id, list);
    }
  }
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  const { data: deletedRows } = await client
    .from("pos_purchase_history")
    .select("id,purchase_number,actor_name,total_before,created_at,changes")
    .eq("action", "delete")
    .order("created_at", { ascending: false })
    .limit(30);
  type RemovedLine = { sku?: string | null; name?: string; old?: string | number | null; price?: string | number | null };

  return (
    <>
      <div className="analytics-head">
        <h1>შესყიდვები</h1>
        <Link href="/purchases/new" className="button primary">+ დამატება</Link>
      </div>

      {error && (
        <p className="notice error" role="alert">
          მონაცემები ვერ ჩაიტვირთა. გადაამოწმეთ ინვენტარიზაციის მიგრაცია და წვდომა.
        </p>
      )}

      {params.deleted && <p className="notice success" role="status">შესყიდვა წაიშალა, მარაგი დაბრუნდა.</p>}

      <section className="panel list-panel">
        <div className="list-head">
          <h2>{(count ?? 0).toLocaleString("ka-GE")} შესყიდვა</h2>
          {rows.length > 0 && <span className="muted">ჯამი ამ გვერდზე: {money(rows.reduce((sum, row) => sum + Number(row.total), 0))}</span>}
        </div>
        {rows.length === 0 ? (
          <p className="empty-box">შესყიდვები ჯერ არ არის. დააჭირეთ „დამატება“-ს.</p>
        ) : (
          <div className="table-scroll">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>№</th>
                  <th>თარიღი</th>
                  <th>ვინ გააკეთა</th>
                  <th>რა შეიძინა</th>
                  <th className="num">ჯამი</th>
                  <th>შენიშვნა</th>
                  <th><span className="sr-only">მოქმედება</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td><Link href={`/purchases/${row.id}`} className="row-id">#{row.purchase_number}</Link></td>
                    <td>
                      <span className="cell-two">
                        {new Date(row.created_at).toLocaleDateString("ka-GE", { timeZone: "Asia/Tbilisi" })}
                        <small>{new Date(row.created_at).toLocaleTimeString("ka-GE", { timeZone: "Asia/Tbilisi", hour: "2-digit", minute: "2-digit" })}</small>
                      </span>
                    </td>
                    <td>{row.actor_name}</td>
                    <td>
                      <details className="row-details">
                        <summary>{row.items_count} პოზიცია</summary>
                        <ul>
                          {(itemsByPurchase.get(row.id) ?? []).map((item) => (
                            <li key={item.id}>
                              {item.product_name}
                              {item.variant_name ? ` / ${item.variant_name}` : ""} — {Number(item.quantity).toLocaleString("ka-GE", { maximumFractionDigits: 3 })} × {money(item.unit_price)}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </td>
                    <td className="num"><strong>{money(row.total)}</strong></td>
                    <td>{row.note ? row.note : <span className="muted">—</span>}</td>
                    <td className="row-action"><Link href={`/purchases/${row.id}`} className="row-link">გახსნა</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="pager">
            {page > 1 && <Link className="button secondary" href={`/purchases?page=${page - 1}`}>← წინა</Link>}
            <span className="muted">გვერდი {page} / {pages}</span>
            {page < pages && <Link className="button secondary" href={`/purchases?page=${page + 1}`}>შემდეგი →</Link>}
          </div>
        )}
      </section>

      {(deletedRows ?? []).length > 0 && (
        <section className="panel">
          <details>
            <summary><strong>წაშლილი შესყიდვები ({(deletedRows ?? []).length})</strong></summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>№</th>
                    <th>როდის წაიშალა</th>
                    <th>ვინ წაშალა</th>
                    <th>რა იყო</th>
                    <th>ჯამი</th>
                  </tr>
                </thead>
                <tbody>
                  {(deletedRows ?? []).map((entry) => (
                    <tr key={entry.id}>
                      <td>#{entry.purchase_number ?? "—"}</td>
                      <td>{new Date(entry.created_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}</td>
                      <td>{entry.actor_name}</td>
                      <td>
                        {((Array.isArray(entry.changes) ? entry.changes : []) as unknown as RemovedLine[]).map((line, index) => (
                          <div key={index}>
                            {line.name}: {Number(line.old).toLocaleString("ka-GE", { maximumFractionDigits: 3 })} × {money(line.price ?? 0)}
                          </div>
                        ))}
                      </td>
                      <td>{money(entry.total_before)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}
    </>
  );
}
