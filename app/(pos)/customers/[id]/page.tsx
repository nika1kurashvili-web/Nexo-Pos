import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/server";
import { money, posClient } from "@/lib/pos/server";
import { CustomerFields, Notice, SaveButton } from "@/app/components/pos-forms";
import { saveCustomer, saveCustomerPrice } from "../../actions";

export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const client = await posClient();
  const { data: customer, error } = await client.from("pos_business_customers").select("*").eq("id",id).maybeSingle();
  if (error) return <Notice loadError />;
  if (!customer) notFound();
  const { data: prices, error: priceError } = await client.from("pos_customer_prices").select("*").eq("customer_id",id).order("created_at").limit(200);
  const { data: balance, error: balanceError } = await client.rpc("pos_customer_balance",{p_customer:id});
  const { data: transactions, error: ledgerError } = await client.from("pos_customer_transactions").select("*").eq("customer_id",id).order("created_at",{ascending:false}).limit(50);
  return <><h1>{customer.name}</h1><Notice {...await searchParams} loadError={Boolean(priceError || balanceError || ledgerError)} />
    <section className="panel"><h2>კლიენტის მონაცემები</h2><form action={saveCustomer} className="data-form"><CustomerFields customer={customer} /><SaveButton /></form></section>
    <section className="panel"><h2>ინდივიდუალური საბითუმო ფასები</h2>
      <p>ფასის არქონისას საცალო ფასი ავტომატურად არ გამოიყენება. ნაჩვენებია მაქსიმუმ 200 ფასი.</p>
      <div className="table-scroll"><table><thead><tr><th>ტიპი</th><th>კატალოგის ID</th><th>ფასი</th></tr></thead><tbody>
        {prices?.map((p) => <tr key={p.id}><td>{p.variant_id !== null ? "ვარიანტი" : "პროდუქტი"}</td><td>{String(p.variant_id ?? p.product_id)}</td><td>{money(p.price)}</td></tr>)}
      </tbody></table></div>
      <details><summary>ფასის ხელით მითითება</summary><form action={saveCustomerPrice} className="data-form">
        <input type="hidden" name="customer_id" value={id} />
        <label>SKU / ბარკოდი<input name="sku" required /></label>
        <label>საბითუმო ფასი<input name="price" type="number" min="0" step="0.01" required /></label><SaveButton />
      </form></details>
      <p>Excel ატვირთვა და SKU-ით ფასების წინასწარი ნახვა დაემატება შემდეგ ეტაპზე.</p>
    </section>
    <section className="panel"><h2>დავალიანება</h2><p>მიმდინარე ნაშთი: {balanceError ? "—" : money(balance)}</p>
      <h3>ბოლო 50 ოპერაცია</h3><div className="table-scroll"><table><thead><tr><th>თარიღი</th><th>ოპერაცია</th><th>თანხა</th></tr></thead><tbody>
        {transactions?.map((t) => <tr key={t.id}><td>{new Date(t.created_at).toLocaleString("ka-GE",{timeZone:"Asia/Tbilisi"})}</td><td>{t.kind === "sale_charge" ? "გაყიდვა" : t.kind === "repayment" ? "ვალის დაფარვა" : "გადახდა"}</td><td>{money(t.amount)}</td></tr>)}
      </tbody></table></div>
    </section>
  </>;
}
