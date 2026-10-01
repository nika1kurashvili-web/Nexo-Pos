import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/server";
import { posClient, money } from "@/lib/pos/server";

export const dynamic = "force-dynamic";

export default async function WithdrawalHistory({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const client = await posClient();
  const { data, error } = await client.from("pos_cash_withdrawals")
    .select("id,request_id,created_at,register_name,actor_name,amount,reason")
    .eq("session_id", id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(200);
  return <>
    <p><Link href="/reports/register-sessions">← სალაროს სესიები</Link></p>
    <h1>თანხის გაცემის ისტორია</h1>
    <p>არჩეული სესიის უახლესი 200 გაცემა. სახელები შენახულია გაცემის მომენტისთვის.</p>
    {error ? <p role="alert" className="notice error">გაცემების ისტორია ვერ ჩაიტვირთა.</p> :
      <section className="panel"><div className="table-scroll"><table>
        <thead><tr>{["თარიღი", "სალარო", "ვინ გასცა", "თანხა", "მიზეზი", "მოთხოვნის ნომერი"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{data?.map(row => <tr key={row.id}><td>{new Date(row.created_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}</td><td>{row.register_name}</td><td>{row.actor_name}</td><td>{money(row.amount)}</td><td>{row.reason}</td><td>{row.request_id}</td></tr>)}</tbody>
      </table></div>{!data?.length && <p>ამ სესიაში თანხის გაცემა არ არის.</p>}</section>}
  </>;
}
