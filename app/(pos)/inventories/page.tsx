import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function InventoriesPage({
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
    .from("pos_inventories")
    .select("id,inventory_number,actor_name,items_count,note,created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .order("inventory_number", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (error) console.error("[inventories] list failed:", error.code, error.message);
  const rows = data ?? [];
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  return (
    <>
      <div className="analytics-head">
        <h1>ინვენტარიზაცია</h1>
        <Link href="/inventories/new" className="button primary">+ დამატება</Link>
      </div>

      {error && (
        <p className="notice error" role="alert">
          მონაცემები ვერ ჩაიტვირთა. გადაამოწმეთ ინვენტარიზაციის მიგრაცია და წვდომა.
        </p>
      )}

      <section className="panel list-panel">
        <div className="list-head">
          <h2>{(count ?? 0).toLocaleString("ka-GE")} ინვენტარიზაცია</h2>
          {rows.length > 0 && <span className="muted">ბოლო: {new Date(rows[0].created_at).toLocaleDateString("ka-GE", { timeZone: "Asia/Tbilisi" })}</span>}
        </div>
        {rows.length === 0 ? (
          <p className="empty-box">ინვენტარიზაცია ჯერ არ ჩატარებულა. დააჭირეთ „დამატება“-ს.</p>
        ) : (
          <div className="table-scroll">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>№</th>
                  <th>თარიღი</th>
                  <th>ვინ გააკეთა</th>
                  <th className="num">შესწორებები</th>
                  <th>შენიშვნა</th>
                  <th><span className="sr-only">მოქმედება</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td><Link href={`/inventories/${row.id}`} className="row-id">#{row.inventory_number}</Link></td>
                    <td>
                      <span className="cell-two">
                        {new Date(row.created_at).toLocaleDateString("ka-GE", { timeZone: "Asia/Tbilisi" })}
                        <small>{new Date(row.created_at).toLocaleTimeString("ka-GE", { timeZone: "Asia/Tbilisi", hour: "2-digit", minute: "2-digit" })}</small>
                      </span>
                    </td>
                    <td>{row.actor_name}</td>
                    <td className="num">{row.items_count}</td>
                    <td>{row.note ? row.note : <span className="muted">—</span>}</td>
                    <td className="row-action"><Link href={`/inventories/${row.id}`} className="row-link">გახსნა</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="pager">
            {page > 1 && <Link className="button secondary" href={`/inventories?page=${page - 1}`}>← წინა</Link>}
            <span className="muted">გვერდი {page} / {pages}</span>
            {page < pages && <Link className="button secondary" href={`/inventories?page=${page + 1}`}>შემდეგი →</Link>}
          </div>
        )}
      </section>
    </>
  );
}
