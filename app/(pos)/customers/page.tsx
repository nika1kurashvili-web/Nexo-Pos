import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { CustomerFields, Notice, SaveButton } from "@/app/components/pos-forms";
import { saveCustomer } from "../actions";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireAdmin();
  const client = await posClient();
  const { data, error } = await client.from("pos_business_customers").select("*").order("name").limit(200);
  return <><h1>ბიზნეს კლიენტები</h1><Notice {...await searchParams} loadError={Boolean(error)} />
    <section className="panel"><h2>კლიენტების სია</h2><p>ნაჩვენებია მაქსიმუმ 200 კლიენტი.</p>
      <div className="table-scroll"><table><thead><tr><th>კომპანია</th><th>კოდი</th><th>სტატუსი</th></tr></thead><tbody>
        {data?.map((c) => <tr key={c.id}><td><Link href={`/customers/${c.id}`}>{c.name}</Link></td><td>{c.tax_code ?? "—"}</td><td>{c.active ? "აქტიური" : "გამორთული"}</td></tr>)}
      </tbody></table></div>{!error && !data?.length && <p>კლიენტები ჯერ არ არის დამატებული.</p>}
    </section>
    <section className="panel"><h2>ახალი კლიენტი</h2><form action={saveCustomer} className="data-form"><CustomerFields /><SaveButton>დამატება</SaveButton></form></section>
  </>;
}
