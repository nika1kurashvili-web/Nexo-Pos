import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { money, posClient } from "@/lib/pos/server";
import { loadImageMap } from "@/lib/pos/product-images-load";
import ProductImageCell from "@/app/components/product-image-cell";
import ProductSearchForm from "@/app/components/product-search-form";
import ProductFilterHeader from "@/app/components/product-filter-header";
import { filtersToQuery, hasActiveFilters, matchesFilters, parseFilters } from "@/lib/pos/product-filters";
import { createProduct, saveProduct, toggleProduct } from "./actions";

export const dynamic = "force-dynamic";

type Params = { cat?: string; deleted?: string; updated?: string; imported?: string; q?: string; all?: string; name?: string; sku?: string; status?: string; stock_min?: string; stock_max?: string; cost_min?: string; cost_max?: string; price_min?: string; price_max?: string; margin_min?: string; margin_max?: string; saved?: string; created?: string; deactivated?: string; restored?: string; error?: string };

const errors: Record<string, string> = {
  invalid: "შეამოწმეთ შეყვანილი მონაცემები.",
  name: "პროდუქტის სახელი აუცილებელია (მაქს. 200 სიმბოლო).",
  sku: "კოდი უკვე გამოიყენება სხვა პროდუქტზე ან ვარიანტზე, ან ძალიან გრძელია.",
  sku_taken: "ეს კოდი უკვე გამოიყენება სხვა პროდუქტზე ან ვარიანტზე.",
  category: "კატეგორია უნდა იყოს „მანქანა“ ან „ტექნიკა“.",
  price: "გასაყიდი ფასი არასწორია (მაგ. 12.50).",
  cost: "შესყიდვის ფასი არასწორია (მაგ. 7.50).",
  weight: "წონა უნდა იყოს 0-ზე მეტი (კგ).",
  stock: "მარაგი არასწორია: მიუთითეთ რიცხვი 0 ან მეტი.",
  unavailable: "პროდუქტი აღარ არსებობს. განაახლეთ გვერდი.",
  failed: "ოპერაცია ვერ შესრულდა. გადაამოწმეთ მონაცემები, მიგრაცია და წვდომა.",
};

const CATEGORIES = ["მანქანა", "ტექნიკა"];
const qty = (value: string | number) => String(Number(value));
const plain = (value: string | number | null) => (value === null ? "" : String(Number(value)));

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireAdmin();
  const client = await posClient();
  const params = await searchParams;
  const filters = parseFilters(params);
  const q = filters.q;
  const qs = filtersToQuery(filters);

  const [{ data, error }, images] = await Promise.all([client.rpc("pos_products_overview"), loadImageMap(client)]);
  if (error) console.error("[products] overview failed:", error.code, error.message);
  const items = data ?? [];
  const rows = items.filter((item) => matchesFilters(item, filters));

  const active = items.filter((item) => item.active);
  const carCount = active.filter((item) => item.category === "მანქანა").length;
  const techCount = active.filter((item) => item.category === "ტექნიკა").length;
  const noneCount = active.length - carCount - techCount;
  const stockValue = active.reduce((sum, item) => sum + Math.max(0, Number(item.stock)) * Number(item.cost ?? 0), 0);
  const notice = params.imported ? `Excel-ით განახლდა: ${Number(params.updated) || 0}, დაემატა: ${Number(params.created) || 0}, წაიშალა: ${Number(params.deleted) || 0}, გაუქმდა (ისტორიის გამო): ${Number(params.deactivated) || 0}.` :
    params.saved ? "ცვლილება შენახულია." : params.created ? "პროდუქტი დაემატა." :
    params.deactivated ? "პროდუქტი გაუქმებულია (ისტორია შენარჩუნებულია)." : params.restored ? "პროდუქტი აღდგენილია." : null;

  return <>
    <div className="analytics-head">
      <h1>პროდუქტები</h1>
      <div>
        <a href="/products/export" className="button secondary">Excel-ის ჩამოტვირთვა</a>{" "}
        <Link href="/products/images" className="button secondary">ფოტოები</Link>{" "}
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
          <input type="hidden" name="qs" value={qs} />
          <label>სახელი<input name="name" required maxLength={200} /></label>
          <label>კატეგორია<select name="category" defaultValue=""><option value="">— არ არის —</option>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
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

    <section className="kpi-strip" aria-label="მარაგი">
      <div><span>აქტიური პროდუქტი</span><strong>{active.length}</strong></div>
      <div><span>მანქანა</span><strong>{carCount}</strong></div>
      <div><span>ტექნიკა</span><strong>{techCount}</strong></div>
      <div><span>კატეგორიის გარეშე</span><strong className={noneCount > 0 ? "text-warn" : "muted"}>{noneCount}</strong></div>
      <div className="kpi-lead"><span>მარაგის ღირებულება, შესყიდვის ფასით</span><strong>{money(stockValue)}</strong></div>
    </section>

    <section className="panel">
      <ProductSearchForm q={q} />
      <p className="muted small">რაოდენობის შეცვლა ინახება როგორც ინვენტარიზაცია („ხელით შესწორება“).</p>
    </section>

    <section className="panel">
      {hasActiveFilters(filters) && <p className="muted">ფილტრით ნაჩვენებია {rows.length} პროდუქტი {items.length}-დან.</p>}
      {(
        <div className="table-scroll">
          <table className="products-table">
            <thead><ProductFilterHeader /></thead>
            <tbody>{rows.length === 0 && <tr><td colSpan={10} className="muted">პროდუქტი ვერ მოიძებნა. შეცვალეთ ფილტრი სათაურში ან <Link href="/products">გაასუფთავეთ ყველა ფილტრი</Link>.</td></tr>}{rows.map((item) => {
              const formId = `p-${item.kind}-${item.id}`;
              const stock = Number(item.stock);
              const margin = item.cost !== null && item.price !== null ? Number(item.price) - Number(item.cost) : null;
              return <tr key={formId} className={item.active ? undefined : "row-inactive"}>
                <td>{(() => {
                  const own = images.map.get(`${item.kind}:${item.id}`) ?? null;
                  const parent = item.kind === "variant" ? images.map.get(`product:${item.product_id}`) ?? null : null;
                  return <ProductImageCell kind={item.kind} id={item.id} url={own ?? parent} inherited={!own && !!parent} extras={images.extras.get(`${item.kind}:${item.id}`) ?? []} />;
                })()}</td>
                <td>
                  {item.variant_name && <div className="muted">{item.name}</div>}
                  <input form={formId} name="name" defaultValue={item.variant_name ?? item.name} maxLength={200} aria-label={item.variant_name ? "ვარიანტის სახელი" : "დასახელება"} className="cell-input cell-text cell-name" />
                </td>
                <td><select form={formId} name="category" defaultValue={item.category ?? ""} aria-label="კატეგორია" className="cell-select"><option value="">—</option>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></td>
                <td><input form={formId} name="sku" defaultValue={item.sku ?? ""} maxLength={100} placeholder="—" aria-label="კოდი" className="cell-input cell-text cell-sku" /></td>
                <td><span className="cell-field"><input form={formId} name="stock" inputMode="decimal" defaultValue={qty(item.stock)} aria-label="მარაგი" className={`cell-input${stock <= 0 ? " cell-low" : ""}`} /></span></td>
                <td><span className="cell-field cell-money"><input form={formId} name="cost" inputMode="decimal" defaultValue={plain(item.cost)} placeholder="—" aria-label="შესყიდვის ფასი" className="cell-input" /></span></td>
                <td><span className="cell-field cell-money"><input form={formId} name="price" inputMode="decimal" defaultValue={plain(item.price ?? 0)} aria-label="გასაყიდი ფასი" className="cell-input" /></span></td>
                <td className={margin === null ? "num muted" : margin < 0 ? "num text-neg" : "num"}>{margin === null ? "—" : money(margin)}</td>
                <td>{item.active ? <span className="muted">აქტიური</span> : <span className="badge badge-neutral">გაუქმებული</span>}</td>
                <td className="row-actions">
                  <form id={formId} action={saveProduct}>
                    <input type="hidden" name="kind" value={item.kind} />
                    <input type="hidden" name="id" value={item.id} />
                    <input type="hidden" name="request_id" value={crypto.randomUUID()} />
                    <input type="hidden" name="orig_name" value={item.variant_name ?? item.name} />
                    <input type="hidden" name="orig_sku" value={item.sku ?? ""} />
                    <input type="hidden" name="orig_category" value={item.category ?? ""} />
                    <input type="hidden" name="orig_stock" value={qty(item.stock)} />
                    <input type="hidden" name="orig_cost" value={plain(item.cost)} />
                    <input type="hidden" name="orig_price" value={plain(item.price ?? 0)} />
                    <input type="hidden" name="active" value={item.active ? "1" : "0"} />
                    <input type="hidden" name="qs" value={qs} />
                    <button type="submit" className="button secondary btn-sm">შენახვა</button>{" "}
                    <button type="submit" formAction={toggleProduct} className="row-link">{item.active ? "გაუქმება" : "აღდგენა"}</button>
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
