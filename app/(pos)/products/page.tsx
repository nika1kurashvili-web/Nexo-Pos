import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { money, posClient } from "@/lib/pos/server";
import { createProduct, saveProduct, toggleProduct } from "./actions";

export const dynamic = "force-dynamic";

type Params = { deleted?: string; updated?: string; imported?: string; q?: string; all?: string; saved?: string; created?: string; deactivated?: string; restored?: string; error?: string };

const errors: Record<string, string> = {
  invalid: "შეამოწმეთ შეყვანილი მონაცემები.",
  name: "პროდუქტის სახელი აუცილებელია (მაქს. 200 სიმბოლო).",
  sku: "კოდი უკვე გამოიყენება სხვა პროდუქტზე ან ვარიანტზე, ან ძალიან გრძელია.",
  sku_taken: "ეს კოდი უკვე გამოიყენება სხვა პროდუქტზე ან ვარიანტზე.",
  price: "გასაყიდი ფასი არასწორია (მაგ. 12.50).",
  cost: "შესყიდვის ფასი არასწორია (მაგ. 7.50).",
  weight: "წონა უნდა იყოს 0-ზე მეტი (კგ).",
  stock: "მარაგი არასწორია: მიუთითეთ რიცხვი 0 ან მეტი.",
  unavailable: "პროდუქტი აღარ არსებობს. განაახლეთ გვერდი.",
  failed: "ოპერაცია ვერ შესრულდა. გადაამოწმეთ მონაცემები, მიგრაცია და წვდომა.",
};

const qty = (value: string | number) => String(Number(value));
const plain = (value: string | number | null) => (value === null ? "" : String(Number(value)));

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireAdmin();
  const client = await posClient();
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";
  const all = params.all === "1";

  const { data, error } = await client.rpc("pos_products_overview");
  if (error) console.error("[products] overview failed:", error.code, error.message);
  const items = data ?? [];
  const needle = q.toLowerCase();
  const rows = items.filter((item) => {
    if (!all && !item.active) return false;
    if (!needle) return true;
    return `${item.name} ${item.variant_name ?? ""} ${item.sku ?? ""}`.toLowerCase().includes(needle);
  });

  const active = items.filter((item) => item.active);
  const stockValue = active.reduce((sum, item) => sum + Math.max(0, Number(item.stock)) * Number(item.cost ?? 0), 0);
  const notice = params.imported ? `Excel-ით განახლდა: ${Number(params.updated) || 0}, დაემატა: ${Number(params.created) || 0}, წაიშალა: ${Number(params.deleted) || 0}, გაუქმდა (ისტორიის გამო): ${Number(params.deactivated) || 0}.` :
    params.saved ? "ცვლილება შენახულია." : params.created ? "პროდუქტი დაემატა." :
    params.deactivated ? "პროდუქტი გაუქმებულია (ისტორია შენარჩუნებულია)." : params.restored ? "პროდუქტი აღდგენილია." : null;

  return <>
    <div className="analytics-head">
      <h1>პროდუქტები</h1>
      <div>
        <a href="/products/export" className="button secondary">Excel-ის ჩამოტვირთვა</a>{" "}
        <Link href="/products/import" className="button secondary">Excel-ის ატვირთვა</Link>
      </div>
    </div>
    {error && <p className="notice error" role="alert">პროდუქტების სია ვერ ჩაიტვირთა. გაუშვით მიგრაცია 202610060002 Supabase-ში.</p>}
    {params.error && <p className="notice error" role="alert">{errors[params.error] ?? errors.failed}</p>}
    {notice && <p className="notice success" role="status">{notice}</p>}

    <section className="panel">
      <details>
        <summary><strong>+ ახალი პროდუქტი</strong></summary>
        <form action={createProduct} className="data-form">
          <input type="hidden" name="request_id" value={crypto.randomUUID()} />
          <input type="hidden" name="q" value={q} />
          {all && <input type="hidden" name="all" value="1" />}
          <label>სახელი<input name="name" required maxLength={200} /></label>
          <label>კოდი (SKU / ბარკოდი)<input name="sku" maxLength={100} /></label>
          <label>გასაყიდი ფასი ₾<input name="price" inputMode="decimal" required placeholder="0.00" /></label>
          <label>შესყიდვის ფასი ₾<input name="cost" inputMode="decimal" placeholder="0.00" /></label>
          <label>საწყისი მარაგი<input name="stock" inputMode="decimal" defaultValue="0" /></label>
          <label>წონა (კგ)<input name="weight" inputMode="decimal" defaultValue="1" /></label>
          <div><button type="submit" className="button primary">დამატება</button></div>
        </form>
        <p className="muted">ვარიანტიანი პროდუქტები (ზომა, ფერი და ა.შ.) ჯერ ორდერების აპში ემატება, შემდეგ აქ გამოჩნდება.</p>
      </details>
    </section>

    <section className="panel">
      <form method="get" className="data-form">
        <label>ძებნა (სახელი ან კოდი)<input name="q" defaultValue={q} maxLength={100} /></label>
        <label className="check"><input type="checkbox" name="all" value="1" defaultChecked={all} />გაუქმებულებიც</label>
        <div><button type="submit" className="button primary">ძებნა</button>{" "}<Link href="/products" className="button secondary">გასუფთავება</Link></div>
      </form>
      <p className="muted">აქტიური პროდუქტი: {active.length}. მარაგის ღირებულება შესყიდვის ფასით: <strong>{money(stockValue)}</strong>. რაოდენობის შეცვლა ინახება როგორც ინვენტარიზაცია („ხელით შესწორება“).</p>
    </section>

    <section className="panel">
      {rows.length === 0 ? <p className="muted">პროდუქტი ვერ მოიძებნა.</p> : (
        <div className="table-scroll">
          <table className="products-table">
            <thead><tr>
              <th scope="col">პროდუქტი</th><th scope="col">კოდი</th><th scope="col">მარაგი</th>
              <th scope="col">შესყიდვის ფასი</th><th scope="col">გასაყიდი ფასი</th><th scope="col">მოგება</th>
              <th scope="col">სტატუსი</th><th scope="col">მოქმედება</th>
            </tr></thead>
            <tbody>{rows.map((item) => {
              const formId = `p-${item.kind}-${item.id}`;
              const stock = Number(item.stock);
              const margin = item.cost !== null && item.price !== null ? Number(item.price) - Number(item.cost) : null;
              return <tr key={formId} className={item.active ? undefined : "row-inactive"}>
                <td><strong>{item.name}</strong>{item.variant_name && <div className="muted">{item.variant_name}</div>}</td>
                <td>{item.sku ?? "—"}</td>
                <td><span className="cell-field"><input form={formId} name="stock" inputMode="decimal" defaultValue={qty(item.stock)} aria-label="მარაგი" className={`cell-input${stock <= 0 ? " cell-low" : ""}`} /></span></td>
                <td><span className="cell-field cell-money"><input form={formId} name="cost" inputMode="decimal" defaultValue={plain(item.cost)} placeholder="—" aria-label="შესყიდვის ფასი" className="cell-input" /></span></td>
                <td><span className="cell-field cell-money"><input form={formId} name="price" inputMode="decimal" defaultValue={plain(item.price ?? 0)} aria-label="გასაყიდი ფასი" className="cell-input" /></span></td>
                <td>{margin === null ? "—" : money(margin)}</td>
                <td>{item.active ? "აქტიური" : "გაუქმებული"}</td>
                <td className="row-actions">
                  <form id={formId} action={saveProduct}>
                    <input type="hidden" name="kind" value={item.kind} />
                    <input type="hidden" name="id" value={item.id} />
                    <input type="hidden" name="request_id" value={crypto.randomUUID()} />
                    <input type="hidden" name="orig_stock" value={qty(item.stock)} />
                    <input type="hidden" name="orig_cost" value={plain(item.cost)} />
                    <input type="hidden" name="orig_price" value={plain(item.price ?? 0)} />
                    <input type="hidden" name="active" value={item.active ? "1" : "0"} />
                    <input type="hidden" name="q" value={q} />
                    {all && <input type="hidden" name="all" value="1" />}
                    <button type="submit" className="button primary">შენახვა</button>{" "}
                    <button type="submit" formAction={toggleProduct} className="button secondary">{item.active ? "გაუქმება" : "აღდგენა"}</button>
                  </form>
                </td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
    </section>
  </>;
}
