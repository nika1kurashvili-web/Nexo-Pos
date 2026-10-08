import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/server";
import { money, posClient } from "@/lib/pos/server";
import { fetchAll } from "@/lib/pos/paginate";
import { filterOrders, orderFigures, sumFigures } from "@/lib/pos/customer-orders";
import CustomerOrderForm, { ConfirmForm, type OrderLine } from "@/app/components/customer-order-form";
import { SubmitButton } from "@/app/components/submit-button";
import { addOrderPayment, deleteCustomerOrder, deleteOrderPayment } from "./actions";

export const dynamic = "force-dynamic";

const messages: Record<string, string> = {
  invalid: "შეამოწმეთ შეყვანილი მონაცემები.",
  date: "თარიღი არასწორია.",
  items: "შეამოწმეთ პროდუქტები: სახელი, რაოდენობა და ფასი აუცილებელია.",
  note: "შენიშვნა ძალიან გრძელია.",
  amount: "თანხა არასწორია (მაქსიმუმ 2 ციფრი წერტილის შემდეგ).",
  exceeds: "ეს თანხა აღემატება შეკვეთის დარჩენილ ვალს.",
  below_paid: "შეკვეთის ახალი ჯამი ვერ იქნება უკვე გადახდილ თანხაზე ნაკლები. ჯერ წაშალეთ ზედმეტი გადახდა.",
  missing: "ჩანაწერი ვერ მოიძებნა (შესაძლოა უკვე წაშლილია).",
  denied: "ამ მოქმედებისთვის ადმინისტრატორის უფლებაა საჭირო.",
  failed: "ოპერაცია ვერ შესრულდა. თუ ეს მიგრაცია ჯერ არ გაგიშვიათ, გაუშვით 202610090001.",
};
const saved: Record<string, string> = {
  "1": "შეკვეთა შენახულია.",
  paid: "გადახდა ჩაწერილია.",
  deleted: "შეკვეთა წაიშალა.",
  payment_deleted: "გადახდა წაიშალა.",
};

const tbilisiDate = (value: string | Date) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tbilisi" }).format(new Date(value));
const qty = (value: string | number) => String(Number(value));

export default async function CustomerOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; from?: string; to?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const query = await searchParams;
  const client = await posClient();

  const [customerRes, ordersRes, catalogRes, pricesRes] = await Promise.all([
    client.from("pos_business_customers").select("id,name").eq("id", id).maybeSingle(),
    client.rpc("pos_corder_list", { p_customer: id }),
    client.rpc("pos_inventory_catalog"),
    fetchAll<{ product_id: string | number | null; variant_id: string | number | null; price: string | number }>((from, to) =>
      client
        .from("pos_customer_prices")
        .select("product_id,variant_id,price")
        .eq("customer_id", id)
        .order("created_at")
        .order("id")
        .range(from, to),
    ),
  ]);

  if (customerRes.error) return <p className="notice error" role="alert">კლიენტი ვერ ჩაიტვირთა.</p>;
  if (!customerRes.data) notFound();
  const customer = customerRes.data;

  const ordersFailed = Boolean(ordersRes.error);
  const allOrders = ordersRes.data ?? [];
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from ?? "") ? (query.from as string) : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to ?? "") ? (query.to as string) : "";
  const filtered = Boolean(from || to);
  const orders = filterOrders(allOrders, from, to);
  const exportHref = `/customers/${id}/orders/export${filtered ? `?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()}` : ""}`;
  const catalog = catalogRes.data ?? [];

  const customerPrices: Record<string, string> = {};
  for (const row of pricesRes.data ?? []) {
    if (row.variant_id !== null) customerPrices[`variant:${row.variant_id}`] = String(Number(row.price));
    else if (row.product_id !== null) customerPrices[`product:${row.product_id}`] = String(Number(row.price));
  }

  const sums = sumFigures(orders);
  const today = tbilisiDate(new Date());
  const newRequestId = crypto.randomUUID();

  return (
    <>
      <p><Link href={`/customers/${id}`}>← კლიენტის გვერდი</Link></p>
      <h1>{customer.name} — შეკვეთები</h1>
      <p className="muted">
        პირადი აღრიცხვა მხოლოდ ადმინისთვის. ეს შეკვეთები არ ჩანს სალაროში, არ აკლებს მარაგს, არ ემატება შემოსავალს,
        ანალიტიკასა და რეპორტებს და არ ცვლის კლიენტის არსებულ ვალს.
      </p>

      {query.error && <p className="notice error" role="alert">{messages[query.error] ?? messages.failed}</p>}
      {query.saved && saved[query.saved] && <p className="notice success" role="status">{saved[query.saved]}</p>}
      {ordersFailed && <p className="notice error" role="alert">შეკვეთები ვერ ჩაიტვირთა. გაუშვით მიგრაცია 202610090001 Supabase-ში.</p>}

      <div className="stat-grid stat-grid-auto">
        <div className="stat"><span>შეკვეთების ჯამი</span><strong>{money(sums.total / 100)}</strong></div>
        <div className="stat"><span>გადახდილი</span><strong>{money(sums.paid / 100)}</strong></div>
        <div className="stat stat-highlight"><span>დარჩენილი ვალი</span><strong>{money(sums.remaining / 100)}</strong></div>
        <div className="stat"><span>შესყიდვის ღირებულება</span><strong>{money(sums.cost / 100)}</strong></div>
        <div className="stat"><span>სავარაუდო მოგება</span><strong>{money(sums.profit / 100)}</strong></div>
      </div>
      {sums.missing > 0 && <p className="muted">მოგება და შესყიდვა არ მოიცავს {sums.missing} პოზიციას, რომელსაც შესყიდვის ფასი არ აქვს.</p>}

      <section className="panel">
        <h2>ახალი შეკვეთა</h2>
        <CustomerOrderForm
          customerId={id}
          catalog={catalog}
          customerPrices={customerPrices}
          requestId={newRequestId}
          initialDate={today}
          submitLabel="შეკვეთის შენახვა"
        />
      </section>

      <section className="panel">
        <form method="get" className="data-form report-filters">
          <label>თარიღიდან<input name="from" type="date" defaultValue={from} /></label>
          <label>თარიღამდე<input name="to" type="date" defaultValue={to} /></label>
          <div className="filter-actions">
            <button type="submit" className="button primary">გაფილტვრა</button>
            <Link href={`/customers/${id}/orders`} className="button secondary">გასუფთავება</Link>
            <a href={exportHref} className="button secondary">Excel-ის ჩამოტვირთვა</a>
          </div>
        </form>
        <p className="muted">
          {filtered ? `ნაჩვენებია ${orders.length} შეკვეთა ${allOrders.length}-დან (თარიღი შეკვეთის თარიღია).` : `სულ ${allOrders.length} შეკვეთა.`}
          {" "}ზემოთ მოცემული ციფრები და Excel ფაილი ფილტრს მიჰყვება.
        </p>
      </section>

      {orders.map((order) => {
        const figures = orderFigures(order);
        const remaining = figures.remaining;
        const lines: OrderLine[] = order.items.map((item) => ({
          key: item.kind && item.target ? `${item.kind}:${item.target}` : `line:${item.id}`,
          kind: item.kind,
          target: item.target,
          name: item.name,
          quantity: qty(item.quantity),
          price: String(Number(item.unit_price)),
          cost: item.unit_cost === null ? "" : String(Number(item.unit_cost)),
          custom: item.kind === null,
        }));
        return (
          <details className="panel order-card" key={order.id}>
            <summary className="order-summary">
              <span className="order-date">
                {order.order_date}
                {order.note && <span className="muted"> · {order.note}</span>}
              </span>
              <span className="order-figures">
                <span>ჯამი <strong>{money(order.total)}</strong></span>
                <span>გადახდილი <strong>{money(order.paid)}</strong></span>
                <span className={remaining > 0 ? "text-bad" : undefined}>
                  დარჩა <strong>{money(remaining / 100)}</strong>
                </span>
                <span className={`badge ${remaining > 0 ? "badge-warn" : "badge-success"}`}>{remaining > 0 ? "ვალია" : "დაფარულია"}</span>
              </span>
            </summary>

            <div className="order-body">
            <div className="table-scroll">
              <table>
                <thead><tr><th>პროდუქტი</th><th>რაოდენობა</th><th>გასაყიდი ფასი</th><th>შესყიდვის ფასი</th><th>ჯამი</th></tr></thead>
                <tbody>
                  {order.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.name}</td>
                      <td>{qty(item.quantity)}</td>
                      <td>{money(item.unit_price)}</td>
                      <td>{item.unit_cost === null ? "—" : money(item.unit_cost)}</td>
                      <td>{money(Math.round(Number(item.quantity) * Number(item.unit_price) * 100) / 100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="muted">
              შესყიდვა: <strong>{money(figures.cost / 100)}</strong> · სავარაუდო მოგება: <strong>{money(figures.profit / 100)}</strong>
              {figures.missing > 0 && ` (${figures.missing} პოზიციას შესყიდვის ფასი არ აქვს)`}
            </p>

            <h3>გადახდები</h3>
            {order.payments.length === 0 ? (
              <p className="muted">გადახდა ჯერ არ არის ჩაწერილი.</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead><tr><th>თარიღი</th><th>თანხა</th><th>შენიშვნა</th><th /></tr></thead>
                  <tbody>
                    {order.payments.map((payment) => (
                      <tr key={payment.id}>
                        <td>{payment.paid_on}</td>
                        <td>{money(payment.amount)}</td>
                        <td>{payment.note ?? "—"}</td>
                        <td>
                          <ConfirmForm action={deleteOrderPayment} message="წავშალოთ ეს გადახდა? შეკვეთის ვალი ისევ გაიზრდება.">
                            <input type="hidden" name="customer_id" value={id} />
                            <input type="hidden" name="payment_id" value={payment.id} />
                            <SubmitButton pendingText="…" className="button secondary">წაშლა</SubmitButton>
                          </ConfirmForm>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {remaining > 0 && (
              <form action={addOrderPayment} className="data-form order-pay">
                <input type="hidden" name="customer_id" value={id} />
                <input type="hidden" name="order_id" value={order.id} />
                <input type="hidden" name="request_id" value={crypto.randomUUID()} />
                <label>გადახდილი თანხა (₾)<input name="amount" inputMode="decimal" required placeholder={`მაქს. ${remaining / 100}`} /></label>
                <label>თარიღი<input name="paid_on" type="date" defaultValue={today} required /></label>
                <label>შენიშვნა<input name="note" maxLength={500} /></label>
                <SubmitButton pendingText="ინახება…" className="button primary">გადახდის ჩაწერა</SubmitButton>
              </form>
            )}

            <details>
              <summary>შეკვეთის შესწორება (პროდუქტი, ფასი, რაოდენობა, თარიღი)</summary>
              <CustomerOrderForm
                customerId={id}
                catalog={catalog}
                customerPrices={customerPrices}
                requestId={order.id}
                orderId={order.id}
                initialDate={order.order_date}
                initialNote={order.note ?? ""}
                initialLines={lines}
                submitLabel="ცვლილების შენახვა"
              />
            </details>

            <details>
              <summary className="text-bad">შეკვეთის წაშლა</summary>
              <ConfirmForm action={deleteCustomerOrder} message="წავშალოთ ეს შეკვეთა და მისი ყველა გადახდა? ამის გაუქმება შეუძლებელია.">
                <input type="hidden" name="customer_id" value={id} />
                <input type="hidden" name="order_id" value={order.id} />
                <p>წაიშლება შეკვეთა გადახდებითურთ. მარაგსა და სალაროზე ეს გავლენას არ ახდენს.</p>
                <SubmitButton pendingText="იშლება…" className="button secondary">შეკვეთის წაშლა</SubmitButton>
              </ConfirmForm>
            </details>
            </div>
          </details>
        );
      })}

      {!ordersFailed && orders.length === 0 && <p className="muted">შეკვეთები ჯერ არ არის.</p>}
    </>
  );
}
