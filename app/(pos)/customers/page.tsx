import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { CustomerFields, Notice, SaveButton } from "@/app/components/pos-forms";
import LiveFilterForm from "@/app/components/live-filter-form";
import { saveCustomer } from "../actions";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; q?: string }> }) {
  await requireAdmin();
  const client = await posClient();
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";
  let query = client.from("pos_business_customers").select("*").order("name").limit(200);
  if (q) {
    const safe = q.replaceAll(/[,()"\\]/g, " ").replaceAll("%", "\\%").replaceAll("_", "\\_");
    query = query.or(`name.ilike.%${safe}%,tax_code.ilike.%${safe}%`);
  }
  const { data, error } = await query;
  return <><h1>ბიზნეს კლიენტები</h1><Notice error={params.error} saved={params.saved} loadError={Boolean(error)} />
    <section className="panel list-panel"><h2>კლიენტების სია</h2><p>ნაჩვენებია მაქსიმუმ 200 კლიენტი.</p>
      <LiveFilterForm className="data-form"><label>ძებნა (კომპანია ან კოდი)<input name="q" type="search" defaultValue={q} maxLength={100} autoComplete="off" /></label><div><Link href="/customers" className="button secondary" data-clear>გასუფთავება</Link></div></LiveFilterForm>
      <div className="table-scroll"><table><thead><tr><th>კომპანია</th><th>კოდი</th><th>სტატუსი</th></tr></thead><tbody>
        {data?.map((c) => <tr key={c.id}><td><Link href={`/customers/${c.id}`}>{c.name}</Link></td><td>{c.tax_code ?? "—"}</td><td>{c.active ? "აქტიური" : "გამორთული"}</td></tr>)}
      </tbody></table></div>{!error && !data?.length && <p>{q ? "ასეთი კლიენტი ვერ მოიძებნა." : "კლიენტები ჯერ არ არის დამატებული."}</p>}
    </section>
    <section className="panel"><h2>ახალი კლიენტი</h2><form action={saveCustomer} className="data-form"><CustomerFields /><SaveButton>დამატება</SaveButton></form></section>
  </>;
}
