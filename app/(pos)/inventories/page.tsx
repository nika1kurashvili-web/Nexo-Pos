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

      <section className="panel">
        {rows.length === 0 ? (
          <p className="muted">ინვენტარიზაცია ჯერ არ ჩატარებულა. დააჭირეთ „დამატება“-ს.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>№</th>
                  <th>თარიღი</th>
                  <th>ვინ გააკეთა</th>
                  <th>შესწორებები</th>
                  <th>შენიშვნა</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.inventory_number}</td>
                    <td>{new Date(row.created_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}</td>
                    <td>{row.actor_name}</td>
                    <td>{row.items_count}</td>
                    <td>{row.note ?? ""}</td>
                    <td><Link href={`/inventories/${row.id}`}>გახსნა</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="filter-actions">
            {page > 1 && <Link className="button secondary" href={`/inventories?page=${page - 1}`}>← წინა</Link>}
            <span className="muted">გვერდი {page} / {pages}</span>
            {page < pages && <Link className="button secondary" href={`/inventories?page=${page + 1}`}>შემდეგი →</Link>}
          </div>
        )}
      </section>
    </>
  );
}
