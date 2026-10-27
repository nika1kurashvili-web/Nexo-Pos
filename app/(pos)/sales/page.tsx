import Link from "next/link";
import { redirect } from "next/navigation";
import type { PostgrestError } from "@supabase/supabase-js";
import type { Sale } from "@/lib/pos/types";
import { requirePosProfile } from "@/lib/auth/server";
import { posClient, money } from "@/lib/pos/server";
import LiveFilterForm from "@/app/components/live-filter-form";
import { Notice } from "@/app/components/pos-forms";
import SalesTable, { type SalesTableRow } from "@/app/components/sales-table";
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
  tracking?: string;
  warranty?: string;
  page?: string;
};

const PAGE_SIZE = 50;

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
  const tracking = (params.tracking?.trim() ?? "").slice(0, 200);
  const warranty = (params.warranty?.trim() ?? "").slice(0, 200);
  const pageNumber = Math.max(1, Math.floor(Number(params.page)) || 1);

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
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE - 1);

  if (saleNumber) {
    const parsedNumber = Number(saleNumber);

    if (Number.isInteger(parsedNumber) && parsedNumber > 0) {
      query = query.eq("sale_number", parsedNumber);
    }
  }

  if (tracking) {
    const safeTracking = tracking
      .replaceAll(/[,()"\\]/g, " ")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    query = query.ilike("tracking_code", `%${safeTracking}%`);
  }

  if (warranty) {
    const safeWarranty = warranty
      .replaceAll(/[,()"\\]/g, " ")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    query = query.ilike("warranty_code", `%${safeWarranty}%`);
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
  let total = 0;

  if (relatedSaleIds !== null && relatedSaleIds.length === 0) {
    data = [];
  } else {
    if (relatedSaleIds !== null) {
      query = query.in("id", relatedSaleIds);
    }

    const result = await query;
    data = result.data;
    error = result.error;
    total = result.count ?? 0;
  }

  /*
   * ტრექინგის სკანირება: თუ კოდი ზუსტად ერთ გაყიდვას ემთხვევა,
   * პირდაპირ მის გვერდზე გადავდივართ.
   */
  if (tracking && data?.length === 1 && data[0].tracking_code?.trim().toLowerCase() === tracking.toLowerCase()) {
    redirect(`/sales/${data[0].id}`);
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (target: number) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value && key !== "page" && key !== "error" && key !== "saved") qs.set(key, value);
    }
    if (target > 1) qs.set("page", String(target));
    const text = qs.toString();
    return text ? `/sales?${text}` : "/sales";
  };
  const firstShown = total === 0 ? 0 : (pageNumber - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(total, pageNumber * PAGE_SIZE);

  if (warranty && data?.length === 1 && data[0].warranty_code?.trim().toLowerCase() === warranty.toLowerCase()) {
    redirect(`/sales/${data[0].id}`);
  }

  const returnStatuses = data?.length ? await loadReturnStatuses(client, data.map((sale) => sale.id)) : new Map();

  const saleIds = data?.map((sale) => sale.id) ?? [];
  const { data: itemRows } = saleIds.length
    ? await client
        .from("pos_sale_items")
        .select("sale_id,line_number,sku,product_name,variant_name,quantity,final_unit_price,line_total")
        .in("sale_id", saleIds)
        .order("line_number")
    : { data: [] };
  const itemsBySale = new Map<string, SalesTableRow["items"]>();
  for (const item of itemRows ?? []) {
    const list = itemsBySale.get(item.sale_id) ?? [];
    list.push({
      name: item.variant_name ? `${item.product_name} — ${item.variant_name}` : item.product_name,
      sku: item.sku ?? "",
      qty: String(Number(item.quantity)),
      price: money(item.final_unit_price),
      total: money(item.line_total),
    });
    itemsBySale.set(item.sale_id, list);
  }
  const tableRows: SalesTableRow[] = (data ?? []).map((sale) => {
    const created = new Date(sale.created_at);
    return {
      id: sale.id,
      number: sale.sale_number,
      day: created.toLocaleDateString("ka-GE", { timeZone: "Asia/Tbilisi" }),
      time: created.toLocaleTimeString("ka-GE", { timeZone: "Asia/Tbilisi", hour: "2-digit", minute: "2-digit" }),
      cashier: sale.cashier_name,
      wholesale: sale.sale_type === "wholesale",
      customer: sale.customer_name ?? "—",
      tracking: sale.tracking_code ?? "",
      warranty: sale.warranty_code ?? "",
      total: money(sale.total),
      paid: money(sale.paid_total),
      debt: money(sale.debt_amount),
      hasDebt: Number(sale.debt_amount) > 0,
      returnStatus: returnStatuses.get(sale.id) ?? "none",
      items: itemsBySale.get(sale.id) ?? [],
    };
  });

  return (
    <>
      <h1>ტრანზაქციები</h1>

      <Notice
        error={params.error}
        saved={params.saved}
        loadError={Boolean(error)}
      />

      <section className="panel filter-panel">
        <h2 className="sr-only">ტრანზაქციების ძებნა</h2>

        <LiveFilterForm className="data-form sales-filters">
          <label>
            თრექინგი (დაასკანერეთ ან ჩაწერეთ)
            <input
              name="tracking"
              type="search"
              placeholder="თრექინგ კოდი"
              defaultValue={tracking}
              autoComplete="off"
              autoFocus
            />
          </label>

          <label>
            საგარანტიო კოდი
            <input
              name="warranty"
              type="search"
              placeholder="საგარანტიო კოდი"
              defaultValue={warranty}
              autoComplete="off"
            />
          </label>

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

            <Link href="/sales" className="button secondary" data-clear>
              გასუფთავება
            </Link>
          </div>
        </LiveFilterForm>
      </section>

      <section className="panel list-panel">
        <div className="list-head">
          <h2>{total.toLocaleString("ka-GE")} ტრანზაქცია</h2>
          {total > 0 && (
            <span className="muted">
              ნაჩვენებია {firstShown}–{lastShown}
            </span>
          )}
        </div>

        <SalesTable rows={tableRows} />

        {pageCount > 1 && (
          <nav className="pager" aria-label="გვერდები">
            {pageNumber > 1 ? (
              <Link href={pageHref(pageNumber - 1)} className="button secondary">← წინა</Link>
            ) : (
              <span className="button secondary disabled" aria-disabled="true">← წინა</span>
            )}
            <span className="pager-info">გვერდი {pageNumber} / {pageCount}</span>
            {pageNumber < pageCount ? (
              <Link href={pageHref(pageNumber + 1)} className="button secondary">შემდეგი →</Link>
            ) : (
              <span className="button secondary disabled" aria-disabled="true">შემდეგი →</span>
            )}
          </nav>
        )}

        {!error && !data?.length && (
          <p className="empty-box">მითითებული პირობებით გაყიდვები ვერ მოიძებნა.</p>
        )}
      </section>
    </>
  );
}
