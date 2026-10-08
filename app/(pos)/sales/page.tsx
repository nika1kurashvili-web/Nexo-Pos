import Link from "next/link";
import type { PostgrestError } from "@supabase/supabase-js";
import type { Sale } from "@/lib/pos/types";
import { requirePosProfile } from "@/lib/auth/server";
import { posClient, money } from "@/lib/pos/server";
import { Notice } from "@/app/components/pos-forms";
import { ReturnStatusBadge } from "@/app/components/return-status-badge";
import { loadReturnStatuses } from "@/lib/pos/return-status-load";

export const dynamic = "force-dynamic";

type SearchParams = {
  error?: string;
  saved?: string;
  number?: string;
  from?: string;
  to?: string;
  type?: string;
  cashier?: string;
  product?: string;
  payment?: string;
};

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePosProfile();

  const params = await searchParams;
  const client = await posClient();

  const saleNumber = params.number?.trim() ?? "";
  const from = params.from?.trim() ?? "";
  const to = params.to?.trim() ?? "";
  const cashier = params.cashier?.trim() ?? "";
  const product = params.product?.trim() ?? "";
  const payment = params.payment?.trim() ?? "";

  const type =
    params.type === "retail" || params.type === "wholesale"
      ? params.type
      : "";

  /*
   * ფილტრების ჩამოსაშლელი სიებისთვის ვიყენებთ გაყიდვების
   * ისტორიულ snapshot-ებს და payment methods-ს.
   */
  const [
    { data: cashierRows },
    { data: paymentMethods },
  ] = await Promise.all([
    client
      .from("pos_sales")
      .select("cashier_id,cashier_name")
      .order("cashier_name"),

    client
      .from("pos_payment_methods")
      .select("code,name")
      .order("name"),
  ]);

  const cashierMap = new Map<string, string>();

  cashierRows?.forEach((row) => {
    if (row.cashier_id && row.cashier_name) {
      cashierMap.set(row.cashier_id, row.cashier_name);
    }
  });

  const cashiers = Array.from(cashierMap.entries()).map(
    ([id, name]) => ({
      id,
      name,
    })
  );

  /*
   * პროდუქტის/SKU ფილტრი:
   * ჯერ ვპოულობთ შესაბამის sale_id-ებს pos_sale_items-ში.
   */
  let productSaleIds: string[] | null = null;

  if (product) {
    const safeProduct = product
      .replaceAll(/[,()"\\]/g, " ")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");

    const { data: matchingItems } = await client
      .from("pos_sale_items")
      .select("sale_id")
      .or(
        `product_name.ilike.%${safeProduct}%,variant_name.ilike.%${safeProduct}%,sku.ilike.%${safeProduct}%`
      );

    productSaleIds = Array.from(
      new Set(matchingItems?.map((item) => item.sale_id) ?? [])
    );
  }

  /*
   * გადახდის მეთოდის ფილტრი:
   * ვპოულობთ გაყიდვებს, რომლებზეც შესაბამისი sale payment არსებობს.
   */
  let paymentSaleIds: string[] | null = null;

  if (payment) {
    const { data: matchingPayments } = await client
      .from("pos_payments")
      .select("sale_id")
      .eq("kind", "sale_payment")
      .eq("method_code", payment);

    paymentSaleIds = Array.from(
      new Set(
        matchingPayments
          ?.map((row) => row.sale_id)
          .filter((id): id is string => Boolean(id)) ?? []
      )
    );
  }

  /*
   * თუ პროდუქტის და payment-ის ფილტრიც გვაქვს,
   * საჭიროა ორივე პირობის გადაკვეთა.
   */
  let relatedSaleIds: string[] | null = null;

  if (productSaleIds !== null && paymentSaleIds !== null) {
    const paymentSet = new Set(paymentSaleIds);

    relatedSaleIds = productSaleIds.filter((id) =>
      paymentSet.has(id)
    );
  } else if (productSaleIds !== null) {
    relatedSaleIds = productSaleIds;
  } else if (paymentSaleIds !== null) {
    relatedSaleIds = paymentSaleIds;
  }

  let query = client
    .from("pos_sales")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (saleNumber) {
    const parsedNumber = Number(saleNumber);

    if (Number.isInteger(parsedNumber) && parsedNumber > 0) {
      query = query.eq("sale_number", parsedNumber);
    }
  }

  if (type) {
    query = query.eq("sale_type", type);
  }

  if (cashier) {
    query = query.eq("cashier_id", cashier);
  }

  if (from) {
    query = query.gte("created_at", `${from}T00:00:00+04:00`);
  }

  if (to) {
    const nextDay = new Date(`${to}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    if (!Number.isNaN(nextDay.getTime())) {
      query = query.lt(
        "created_at",
        `${nextDay.toISOString().slice(0, 10)}T00:00:00+04:00`
      );
    }
  }

  /*
   * Supabase .in() ცარიელ მასივზე არ უნდა გავუშვათ.
   * თუ დაკავშირებული შედეგი საერთოდ არ არსებობს,
   * პირდაპირ ცარიელ შედეგს ვაბრუნებთ.
   */
  let data: Sale[] | null = null;
  let error: PostgrestError | null = null;

  if (relatedSaleIds !== null && relatedSaleIds.length === 0) {
    data = [];
  } else {
    if (relatedSaleIds !== null) {
      query = query.in("id", relatedSaleIds);
    }

    const result = await query;
    data = result.data;
    error = result.error;
  }

  const returnStatuses = data?.length ? await loadReturnStatuses(client, data.map((sale) => sale.id)) : new Map();

  return (
    <>
      <h1>გაყიდვები</h1>

      <Notice
        error={params.error}
        saved={params.saved}
        loadError={Boolean(error)}
      />

      <section className="panel">
        <h2>გაყიდვების ძებნა</h2>

        <form
          key={JSON.stringify([saleNumber, from, to, cashier, product, payment, type])}
          method="get"
          className="data-form sales-filters"
        >
          <label>
            გაყიდვის ნომერი
            <input
              name="number"
              type="number"
              min="1"
              placeholder="მაგ. 1001"
              defaultValue={saleNumber}
            />
          </label>

          <label>
            პროდუქტი ან SKU
            <input
              name="product"
              type="search"
              placeholder="პროდუქტის სახელი ან SKU"
              defaultValue={product}
            />
          </label>

          <label>
            მოლარე
            <select name="cashier" defaultValue={cashier}>
              <option value="">ყველა</option>

              {cashiers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            გადახდის მეთოდი
            <select name="payment" defaultValue={payment}>
              <option value="">ყველა</option>

              {paymentMethods?.map((method) => (
                <option key={method.code} value={method.code}>
                  {method.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            გაყიდვის ტიპი
            <select name="type" defaultValue={type}>
              <option value="">ყველა</option>
              <option value="retail">საცალო</option>
              <option value="wholesale">საბითუმო</option>
            </select>
          </label>

          <label>
            თარიღიდან
            <input
              name="from"
              type="date"
              defaultValue={from}
            />
          </label>

          <label>
            თარიღამდე
            <input
              name="to"
              type="date"
              defaultValue={to}
            />
          </label>

          <div className="sales-filter-actions">
            <button type="submit" className="button primary">
              ძებნა
            </button>

            <Link href="/sales" className="button secondary">
              გასუფთავება
            </Link>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>გაყიდვები</h2>

        <p>ნაჩვენებია მაქსიმუმ 100 შედეგი.</p>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>№</th>
                <th>თარიღი</th>
                <th>მოლარე</th>
                <th>ტიპი</th>
                <th>კლიენტი</th>
                <th>სულ</th>
                <th>გადახდილი</th>
                <th>დავალიანება</th>
                <th>დაბრუნება</th>
                <th></th>
              </tr>
            </thead>

            <tbody>
              {data?.map((sale) => (
                <tr key={sale.id}>
                  <td>#{sale.sale_number}</td>

                  <td>
                    {new Date(
                      sale.created_at
                    ).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}
                  </td>

                  <td>{sale.cashier_name}</td>

                  <td>
                    {sale.sale_type === "retail"
                      ? "საცალო"
                      : "საბითუმო"}
                  </td>

                  <td>
                    {sale.customer_name ?? "საცალო კლიენტი"}
                  </td>

                  <td>
                    <strong>{money(sale.total)}</strong>
                  </td>

                  <td>{money(sale.paid_total)}</td>

                  <td>{money(sale.debt_amount)}</td>

                  <td><ReturnStatusBadge status={returnStatuses.get(sale.id) ?? "none"} /></td>

                  <td>
                    <Link
                      href={`/sales/${sale.id}`}
                      className="button secondary"
                    >
                      დეტალები
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!error && !data?.length && (
          <p>მითითებული პირობებით გაყიდვები ვერ მოიძებნა.</p>
        )}
      </section>
    </>
  );
}
