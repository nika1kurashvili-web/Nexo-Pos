import { requirePosProfile } from "@/lib/auth/server";
import { posClient, money } from "@/lib/pos/server";
import { Notice } from "@/app/components/pos-forms";

export default async function SalesPage() {
  await requirePosProfile();
  const client = await posClient();
  const { data, error } = await client.from("pos_sales").select("*").order("created_at",{ascending:false}).limit(100);
  return <><h1>გაყიდვები</h1><Notice loadError={Boolean(error)} /><section className="panel"><h2>ბოლო 100 გაყიდვა</h2>
    <p>გადახდა და ვალი ასახავს გაყიდვის დასრულების მომენტს. შემდგომი დაფარვები ინახება ცალკე.</p>
    <div className="table-scroll"><table><thead><tr><th>ნომერი</th><th>ტიპი</th><th>კლიენტი</th><th>ჯამი</th><th>გადახდილი</th><th>საწყისი ვალი</th><th>თრექინგი</th></tr></thead><tbody>
      {data?.map((s) => <tr key={s.id}><td>{s.sale_number}</td><td>{s.sale_type === "retail" ? "საცალო" : "საბითუმო"}</td><td>{s.customer_name ?? "—"}</td><td>{money(s.total)}</td><td>{money(s.paid_total)}</td><td>{money(s.debt_amount)}</td><td>{s.tracking_code ?? "—"}</td></tr>)}
    </tbody></table></div>{!error && !data?.length && <p>გაყიდვები ჯერ არ არის.</p>}
  </section></>;
}
