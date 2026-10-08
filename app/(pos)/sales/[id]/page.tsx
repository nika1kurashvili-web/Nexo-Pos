import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePosProfile } from "@/lib/auth/server";
import { posClient, money } from "@/lib/pos/server";
import { Notice } from "@/app/components/pos-forms";
import type { PosReturnItem } from "@/lib/pos/types";
import { ReceiptPrintButton } from "@/app/components/receipt-print-button";
import { ReturnStatusBadge } from "@/app/components/return-status-badge";
import { computeReturnStatus } from "@/lib/pos/return-status";

export const dynamic = "force-dynamic";

export default async function SaleDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePosProfile();

  const { id } = await params;
  const client = await posClient();

  const [
    { data: sale, error: saleError },
    { data: items, error: itemsError },
    { data: payments, error: paymentsError },
  ] = await Promise.all([
    client
      .from("pos_sales")
      .select("*")
      .eq("id", id)
      .maybeSingle(),

    client
      .from("pos_sale_items")
      .select("*")
      .eq("sale_id", id)
      .order("line_number"),

    client
      .from("pos_payments")
      .select("*")
      .eq("sale_id", id)
      .order("created_at"),
  ]);

  if (!sale && !saleError) {
    notFound();
  }

  // Returns made against this sale (RLS: admin sees all, a cashier sees returns
  // they made or returns against their own sales).
  const { data: returns, error: returnsError } = sale
    ? await client
        .from("pos_returns")
        .select("*")
        .eq("sale_id", id)
        .order("created_at")
    : { data: null, error: null };

  const returnIds = (returns ?? []).map((r) => r.id);

  const { data: returnItemRows, error: returnItemsError } = returnIds.length
    ? await client
        .from("pos_return_items")
        .select("*")
        .in("return_id", returnIds)
    : { data: null, error: null };

  const returnItems: PosReturnItem[] = returnItemRows ?? [];

  // Sale totals are immutable snapshots. Sum later repayments in cents so
  // initial split payments are not counted twice and amounts retain 2 decimals.
  const toCents = (amount: string | number) =>
    Math.round((Number(amount) + Number.EPSILON) * 100);
  const repaymentCents = sale?.sale_type === "wholesale" && !paymentsError && payments
    ? payments.reduce((sum, payment) =>
      payment.kind === "repayment" ? sum + toCents(payment.amount) : sum, 0)
    : null;
  const currentPaidCents = sale && repaymentCents !== null
    ? toCents(sale.paid_total) + repaymentCents
    : null;
  const returnDebtCents = (returns ?? []).reduce(
    (sum, r) => sum + toCents(r.debt_reduction), 0);
  const returnedTotalCents = (returns ?? []).reduce(
    (sum, r) => sum + toCents(r.total_amount), 0);
  const currentDebtCents = sale && currentPaidCents !== null
    ? Math.max(0, toCents(sale.total) - currentPaidCents - returnDebtCents)
    : null;
  const itemName = new Map(
    (items ?? []).map((item) => [
      item.id,
      item.product_name + (item.variant_name ? ` / ${item.variant_name}` : ""),
    ]),
  );

  return (
    <>
      <p>
        <Link href="/sales">← გაყიდვებზე დაბრუნება</Link>
      </p>

      <h1>
        გაყიდვა №{sale?.sale_number}{" "}
        <ReturnStatusBadge status={computeReturnStatus(items ?? [], returnItems)} />
      </h1>

      <Notice loadError={Boolean(saleError || itemsError || paymentsError || returnsError || returnItemsError)} />

      {sale && (
        <>
<div className="receipt-actions">
  <Link
    href={`/returns?number=${sale.sale_number}`}
    className="button secondary"
  >
    დაბრუნება
  </Link>
  <ReceiptPrintButton />
</div>

<section className="receipt-print">
  <div className="receipt-header">
    <strong>NEXO.GE</strong>
    <span>ქვითარი #{sale.sale_number}</span>
    <span>
      {new Date(sale.created_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}
    </span>
  </div>

  <div className="receipt-divider" />

  <div className="receipt-info">
    <div>
      <span>მოლარე:</span>
      <span>{sale.cashier_name}</span>
    </div>

    <div>
      <span>ტიპი:</span>
      <span>
        {sale.sale_type === "retail"
          ? "საცალო"
          : "საბითუმო"}
      </span>
    </div>

    {sale.customer_name && (
      <div>
        <span>კლიენტი:</span>
        <span>{sale.customer_name}</span>
      </div>
    )}

    {sale.tracking_code && (
      <div>
        <span>Tracking:</span>
        <span>{sale.tracking_code}</span>
      </div>
    )}
  </div>

  <div className="receipt-divider" />

  <div className="receipt-items">
    {items?.map((item) => (
      <div
        className="receipt-item"
        key={`receipt-${item.id}`}
      >
        <div className="receipt-item-name">
          {item.product_name}
          {item.variant_name
            ? ` / ${item.variant_name}`
            : ""}
        </div>

        <div className="receipt-item-line">
          <span>
            {item.quantity} × {money(item.final_unit_price)}
          </span>

          <strong>{money(item.line_total)}</strong>
        </div>

        {Number(item.discount_percent) > 0 && (
          <div className="receipt-discount">
            ფასდაკლება: {item.discount_percent}%
          </div>
        )}
      </div>
    ))}
  </div>

  <div className="receipt-divider" />

  {Number(sale.discount_total) > 0 && (
    <div className="receipt-total-row">
      <span>ფასდაკლება</span>
      <span>{money(sale.discount_total)}</span>
    </div>
  )}

  <div className="receipt-total-row receipt-grand-total">
    <span>სულ</span>
    <strong>{money(sale.total)}</strong>
  </div>

  <div className="receipt-divider" />

  <div className="receipt-payments">
    {payments
      ?.filter(
        (payment) =>
          payment.kind === "sale_payment"
      )
      .map((payment) => (
        <div
          className="receipt-total-row"
          key={`receipt-payment-${payment.id}`}
        >
          <span>{payment.method_name}</span>
          <span>{money(payment.amount)}</span>
        </div>
      ))}
  </div>

  {sale.sale_type === "wholesale" &&
    currentDebtCents !== null &&
    currentDebtCents > 0 && (
      <>
        <div className="receipt-divider" />

        <div className="receipt-total-row">
          <strong>დარჩენილი დავალიანება</strong>
          <strong>
            {money(currentDebtCents / 100)}
          </strong>
        </div>
      </>
    )}

  <div className="receipt-footer">
    მადლობა შეძენისთვის!
  </div>
</section>
          <section className="panel">
            <h2>გაყიდვის ინფორმაცია</h2>

            <dl className="profile-summary">
              <dt>ნომერი</dt>
              <dd>#{sale.sale_number}</dd>

              <dt>თარიღი</dt>
              <dd>
                {new Date(sale.created_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}
              </dd>

              <dt>დაფიქსირდა სისტემაში</dt>
              <dd>
                {new Date(sale.recorded_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}
              </dd>

              <dt>მოლარე</dt>
              <dd>{sale.cashier_name}</dd>

              <dt>ტიპი</dt>
              <dd>
                {sale.sale_type === "retail"
                  ? "საცალო"
                  : "საბითუმო"}
              </dd>

              <dt>კლიენტი</dt>
              <dd>{sale.customer_name ?? "საცალო კლიენტი"}</dd>

              <dt>ტრეკინგი</dt>
              <dd>{sale.tracking_code ?? "—"}</dd>
            </dl>
          </section>

          <section className="panel">
            <h2>პროდუქტები</h2>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>პროდუქტი</th>
                    <th>SKU</th>
                    <th>რაოდენობა</th>
                    <th>ერთეულის ფასი</th>
                    <th>ფასდაკლება</th>
                    <th>ჯამი</th>
                  </tr>
                </thead>

                <tbody>
                  {items?.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.product_name}</strong>
                        {item.variant_name && (
                          <div>{item.variant_name}</div>
                        )}
                      </td>

                      <td>{item.sku ?? "—"}</td>

                      <td>{item.quantity}</td>

                      <td>{money(item.final_unit_price)}</td>

                      <td>{item.discount_percent}%</td>

                      <td>
                        <strong>{money(item.line_total)}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!items?.length && (
              <p>ამ გაყიდვაში პროდუქტი ვერ მოიძებნა.</p>
            )}
          </section>

          <section className="panel">
            <h2>გადახდები</h2>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>მეთოდი</th>
                    <th>ტიპი</th>
                    <th>თანხა</th>
                    <th>თარიღი</th>
                  </tr>
                </thead>

                <tbody>
                  {payments?.map((payment) => (
                    <tr key={payment.id}>
                      <td>{payment.method_name}</td>

                      <td>
                        {payment.kind === "sale_payment"
                          ? "გაყიდვა"
                          : "დავალიანების დაფარვა"}
                      </td>

                      <td>
                        <strong>{money(payment.amount)}</strong>
                      </td>

                      <td>
                        {new Date(
                          payment.created_at
                        ).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}
                        {Math.abs(new Date(payment.recorded_at).getTime() - new Date(payment.created_at).getTime()) > 60_000 && (
                          <span className="muted">
                            {" "}(დაფიქსირდა: {new Date(payment.recorded_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })})
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!payments?.length && (
              <p>გადახდა ვერ მოიძებნა.</p>
            )}
          </section>

          {(returns?.length ?? 0) > 0 && (
            <section className="panel">
              <h2>დაბრუნებები</h2>

              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>№</th>
                      <th>თარიღი</th>
                      <th>ვინ გააფორმა</th>
                      <th>დაბრუნებული ნივთები</th>
                      <th>თანხა</th>
                      <th>ვალის შემცირება</th>
                      <th>დაბრუნებული თანხა</th>
                      <th>მიზეზი</th>
                    </tr>
                  </thead>
                  <tbody>
                    {returns?.map((r) => (
                      <tr key={r.id}>
                        <td>#{r.return_number}</td>
                        <td>
                          {new Date(r.created_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}
                        </td>
                        <td>{r.actor_name}</td>
                        <td className="wrap">
                          {returnItems
                            .filter((ri) => ri.return_id === r.id)
                            .map((ri) => `${itemName.get(ri.sale_item_id) ?? "—"} × ${Number(ri.quantity)}`)
                            .join(", ")}
                        </td>
                        <td><strong>{money(r.total_amount)}</strong></td>
                        <td>{money(r.debt_reduction)}</td>
                        <td>{money(r.refund_total)}</td>
                        <td className="wrap">{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="panel">
            <h2>შეჯამება</h2>

            <dl className="profile-summary">
              <dt>ქვეჯამი</dt>
              <dd>{money(sale.subtotal)}</dd>

              <dt>ფასდაკლება</dt>
              <dd>{money(sale.discount_total)}</dd>

              <dt>{sale.sale_type === "wholesale" ? "გაყიდვის ჯამი" : "სულ"}</dt>
              <dd>
                <strong>{money(sale.total)}</strong>
              </dd>

              {sale.sale_type === "wholesale" ? (
                <>
                  <dt>თავდაპირველად გადახდილი</dt>
                  <dd>{money(sale.paid_total)}</dd>

                  <dt>თავდაპირველი დავალიანება</dt>
                  <dd>{money(sale.debt_amount)}</dd>

                  <dt>შემდგომი დაფარვები</dt>
                  <dd>{money(repaymentCents === null ? null : repaymentCents / 100)}</dd>

                  <dt>დაბრუნებით შემცირებული ვალი</dt>
                  <dd>{money(returnDebtCents / 100)}</dd>

                  <dt>სულ გადახდილია</dt>
                  <dd>{money(currentPaidCents === null ? null : currentPaidCents / 100)}</dd>

                  <dt>მიმდინარე დავალიანება</dt>
                  <dd><strong>{money(currentDebtCents === null ? null : currentDebtCents / 100)}</strong></dd>
                </>
              ) : (
                <>
                  <dt>გადახდილი</dt>
                  <dd>{money(sale.paid_total)}</dd>

                  <dt>დავალიანება</dt>
                  <dd>{money(sale.debt_amount)}</dd>
                </>
              )}

              {returnedTotalCents > 0 && (
                <>
                  <dt>დაბრუნებული ნივთების ღირებულება</dt>
                  <dd>{money(returnedTotalCents / 100)}</dd>
                </>
              )}
            </dl>
          </section>
        </>
      )}
    </>
  );
}
