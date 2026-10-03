import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { money, posClient } from "@/lib/pos/server";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
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

      <section className="panel">
        {rows.length === 0 ? (
          <p className="muted">შესყიდვები ჯერ არ არის. დააჭირეთ „დამატება“-ს.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>№</th>
                  <th>თარიღი</th>
                  <th>ვინ გააკეთა</th>
                  <th>რა შეიძინა</th>
                  <th>ჯამი</th>
                  <th>შენიშვნა</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.purchase_number}</td>
                    <td>{new Date(row.created_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}</td>
                    <td>{row.actor_name}</td>
                    <td>
                      <details>
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
                    <td>{money(row.total)}</td>
                    <td>{row.note ?? ""}</td>
                    <td><Link href={`/purchases/${row.id}`}>გახსნა</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="filter-actions">
            {page > 1 && <Link className="button secondary" href={`/purchases?page=${page - 1}`}>← წინა</Link>}
            <span className="muted">გვერდი {page} / {pages}</span>
            {page < pages && <Link className="button secondary" href={`/purchases?page=${page + 1}`}>შემდეგი →</Link>}
          </div>
        )}
      </section>
    </>
  );
}
