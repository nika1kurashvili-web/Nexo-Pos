import { money, posClient } from "@/lib/pos/server";
import { fetchAll } from "@/lib/pos/paginate";
import { SaveButton } from "@/app/components/pos-forms";
import { SubmitButton } from "@/app/components/submit-button";
import CustomerOrderForm from "@/app/components/customer-order-form";
import type { CustomerOrderItem, CustomerOrderPayment, InventoryCatalogItem } from "@/lib/pos/types";
import { deleteCustomerOrder, deleteOrderPayment, recordOrderPayment } from "./order-actions";

const errors: Record<string, string> = {
  overpay: "გადახდილი თანხა აღემატება დარჩენილ ვალს.",
  date: "თარიღი არასწორია: გადახდა შეკვეთის თარიღზე ადრე ვერ იქნება.",
  invalid: "შეამოწმეთ შეყვანილი მონაცემები (რაოდენობა, ფასი, თანხა).",
  duplicate: "ერთი პროდუქტი ორჯერ არის დამატებული.",
  unavailable: "ერთ-ერთი პროდუქტი აღარ არის ხელმისაწვდომი. განაახლეთ გვერდი.",
  conflict: "ეს მოთხოვნა უკვე გაგზავნილია. განაახლეთ გვერდი.",
  failed: "ოპერაცია ვერ შესრულდა. შეამოწმეთ მიგრაცია და წვდომა.",
};

const cents = (value: string | number) => Math.round(Number(value) * 100);
const qty = (value: string | number) =>
  Number(value).toLocaleString("ka-GE", { maximumFractionDigits: 3 });

// კლიენტის შეკვეთები და ეტაპობრივი დაფარვა. სალაროსგან, მარაგისგან და
// შემოსავლებისგან სრულიად დამოუკიდებელია; ჩანს მხოლოდ ადმინისთვის.
export default async function CustomerOrders({
  customerId,
  customerPrices,
  today,
  orderError,
  orderSaved,
}: {
  customerId: string;
  customerPrices: Record<string, string>;
  today: string;
  orderError?: string;
  orderSaved?: string;
}) {
  const client = await posClient();

  const [{ data: orders, error: ordersError }, { data: catalog, error: catalogError }] = await Promise.all([
    fetchAll<{ id: string; order_number: number; order_date: string; note: string | null; total: string | number }>(
      (from, to) =>
        client
          .from("pos_customer_orders")
          .select("id,order_number,order_date,note,total")
          .eq("customer_id", customerId)
          .order("order_date", { ascending: false })
          .order("order_number", { ascending: false })
          .range(from, to)
    ),
    client.rpc("pos_inventory_catalog"),
  ]);

  const items = new Map<string, CustomerOrderItem[]>();
  const payments = new Map<string, CustomerOrderPayment[]>();
  let detailError: unknown = null;

  for (let i = 0; i < orders.length && !detailError; i += 50) {
    const ids = orders.slice(i, i + 50).map((order) => order.id);
    const [itemRows, paymentRows] = await Promise.all([
      fetchAll<CustomerOrderItem>((from, to) =>
        client
          .from("pos_customer_order_items")
          .select("*")
          .in("order_id", ids)
          .order("line_no")
          .order("id")
          .range(from, to)
      ),
      fetchAll<CustomerOrderPayment>((from, to) =>
        client
          .from("pos_customer_order_payments")
          .select("*")
          .in("order_id", ids)
          .order("paid_on")
          .order("created_at")
          .order("id")
          .range(from, to)
      ),
    ]);
    detailError = itemRows.error || paymentRows.error;
    for (const row of itemRows.data) items.set(row.order_id, [...(items.get(row.order_id) ?? []), row]);
    for (const row of paymentRows.data) payments.set(row.order_id, [...(payments.get(row.order_id) ?? []), row]);
  }

  const rows = orders.map((order) => {
    const paid = (payments.get(order.id) ?? []).reduce((sum, p) => sum + cents(p.amount), 0);
    return { ...order, paid: paid / 100, debt: Math.max(0, cents(order.total) - paid) / 100 };
  });
  const totals = rows.reduce(
    (sum, row) => ({ total: sum.total + cents(row.total), paid: sum.paid + Math.round(row.paid * 100) }),
    { total: 0, paid: 0 }
  );

  return (
    <section className="panel" id="orders">
      <h2>შეკვეთები</h2>
      <p className="muted">
        ჩანს მხოლოდ ადმინისთვის. შეკვეთა და მისი დაფარვა არ გადის სალაროში, არ ცვლის მარაგს და არ
        აისახება შემოსავლებში.
      </p>

      {orderError && (
        <p className="notice error" role="alert">{errors[orderError] ?? errors.failed}</p>
      )}
      {orderSaved && !orderError && (
        <p className="notice success" role="status">ცვლილება შენახულია.</p>
      )}
      {Boolean(ordersError || detailError) && (
        <p className="notice error" role="alert">
          შეკვეთები ვერ ჩაიტვირთა. გადაამოწმეთ, რომ 202610080008 მიგრაცია გაშვებულია.
        </p>
      )}

      <p>
        შეკვეთები სულ: <strong>{money(totals.total / 100)}</strong> · გადახდილი:{" "}
        <strong>{money(totals.paid / 100)}</strong> · დარჩენილი ვალი:{" "}
        <strong>{money((totals.total - totals.paid) / 100)}</strong>
      </p>

      <details>
        <summary>ახალი შეკვეთა</summary>
        {catalogError && (
          <p className="notice error" role="alert">პროდუქტების სია ვერ ჩაიტვირთა.</p>
        )}
        <CustomerOrderForm
          key={orders.length}
          customerId={customerId}
          catalog={(catalog ?? []) as InventoryCatalogItem[]}
          customerPrices={customerPrices}
          requestId={crypto.randomUUID()}
          today={today}
        />
      </details>

      {rows.length === 0 && <p className="muted">შეკვეთები ჯერ არ არის.</p>}

      {rows.map((order) => (
        <details key={order.id} className="panel">
          <summary>
            #{order.order_number} · {order.order_date} · სულ {money(order.total)} · გადახდილი{" "}
            {money(order.paid)} · {order.debt > 0 ? <strong>ვალი {money(order.debt)}</strong> : "დაფარულია"}
          </summary>

          {order.note && <p>{order.note}</p>}

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>ბარკოდი</th>
                  <th>პროდუქტი</th>
                  <th>რაოდენობა</th>
                  <th>ფასი</th>
                  <th>ჯამი</th>
                </tr>
              </thead>
              <tbody>
                {(items.get(order.id) ?? []).map((item) => (
                  <tr key={item.id}>
                    <td>{item.sku || "—"}</td>
                    <td>{item.name}</td>
                    <td>{qty(item.quantity)}</td>
                    <td>{money(item.unit_price)}</td>
                    <td>{money(item.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>გადახდების ისტორია</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>თარიღი</th>
                  <th>თანხა</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(payments.get(order.id) ?? []).map((payment) => (
                  <tr key={payment.id}>
                    <td>{payment.paid_on}</td>
                    <td>{money(payment.amount)}</td>
                    <td>
                      <form action={deleteOrderPayment}>
                        <input type="hidden" name="customer_id" value={customerId} />
                        <input type="hidden" name="payment_id" value={payment.id} />
                        <SubmitButton className="button secondary" pendingText="იშლება…">წაშლა</SubmitButton>
                      </form>
                    </td>
                  </tr>
                ))}
                {!(payments.get(order.id) ?? []).length && (
                  <tr><td colSpan={3}>გადახდა ჯერ არ არის.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {order.debt > 0 && (
            <form action={recordOrderPayment} className="data-form">
              <input type="hidden" name="customer_id" value={customerId} />
              <input type="hidden" name="order_id" value={order.id} />
              <input type="hidden" name="request_id" value={crypto.randomUUID()} />
              <label>
                მიღებული თანხა
                <input
                  type="number"
                  name="amount"
                  min="0.01"
                  max={order.debt}
                  step="0.01"
                  required
                />
              </label>
              <label>
                თარიღი
                <input type="date" name="paid_on" defaultValue={today} min={order.order_date} required />
              </label>
              <SaveButton>გადახდის ჩაწერა</SaveButton>
            </form>
          )}

          <details>
            <summary>შეკვეთის წაშლა</summary>
            <form action={deleteCustomerOrder}>
              <input type="hidden" name="customer_id" value={customerId} />
              <input type="hidden" name="order_id" value={order.id} />
              <p className="muted">წაიშლება შეკვეთა და მისი ყველა გადახდა.</p>
              <SubmitButton className="button secondary" pendingText="იშლება…">დიახ, წაშალე</SubmitButton>
            </form>
          </details>
        </details>
      ))}
    </section>
  );
}
