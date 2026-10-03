import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/server";
import { money, posClient } from "@/lib/pos/server";
import { fetchAll } from "@/lib/pos/paginate";
import {
  CustomerFields,
  Notice,
  SaveButton,
} from "@/app/components/pos-forms";
import {
  importCustomerPricesExcel,
  recordCustomerRepayment,
  saveCustomer,
  saveCustomerPrice,
} from "../../actions";

export const dynamic = "force-dynamic";

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    saved?: string;
    imported?: string;
    skipped?: string;
  }>;
}) {
  const profile = await requireAdmin();
  const { id } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    notFound();
  }

  const client = await posClient();

  const [
    { data: customer, error },
    { data: prices, error: priceError },
    { data: catalogProducts, error: catalogProductError },
    { data: catalogVariants, error: catalogVariantError },
    { data: balance, error: balanceError },
    { data: transactions, error: ledgerError },
    { data: paymentMethods, error: paymentError },
    { data: sessionData, error: sessionError },
  ] = await Promise.all([
    client
      .from("pos_business_customers")
      .select("*")
      .eq("id", id)
      .maybeSingle(),

    fetchAll<{
      id: string;
      product_id: string | null;
      variant_id: string | null;
      price: string | number;
    }>((from, to) =>
      client
        .from("pos_customer_prices")
        .select("id,product_id,variant_id,price")
        .eq("customer_id", id)
        .order("created_at")
        .order("id")
        .range(from, to)
    ),

    fetchAll<{ id: string; name: string; sku: string | null }>((from, to) =>
      client
        .from("products" as never)
        .select("id,name,sku")
        .order("id")
        .range(from, to)
    ),

    fetchAll<{ id: string; product_id: string; name: string; sku: string | null }>((from, to) =>
      client
        .from("product_variants" as never)
        .select("id,product_id,name,sku")
        .order("id")
        .range(from, to)
    ),

    client.rpc("pos_customer_balance", {
      p_customer: id,
    }),

    client
      .from("pos_customer_transactions")
      .select("*")
      .eq("customer_id", id)
      .order("created_at", {
        ascending: false,
      })
      .limit(500),

    client
      .from("pos_payment_methods")
      .select("code,name")
      .eq("active", true)
      .eq("is_debt", false)
      .order("name"),

    client
      .from("pos_register_sessions")
      .select("id")
      .eq("cashier_id", profile.id)
      .eq("status", "open")
      .order("opened_at", {
        ascending: false,
      })
      .limit(1),
  ]);

  if (error) {
    return <Notice loadError />;
  }

  if (!customer) {
    notFound();
  }

  const session = sessionData?.[0] ?? null;

  const productById = new Map(catalogProducts.map((product) => [product.id, product]));
  const variantById = new Map(catalogVariants.map((variant) => [variant.id, variant]));
  const priceRows = prices
    .map((price) => {
      if (price.variant_id !== null) {
        const variant = variantById.get(price.variant_id);
        const product = variant ? productById.get(variant.product_id) : undefined;
        return {
          id: price.id,
          sku: variant?.sku ?? "",
          name: product && variant ? `${product.name} / ${variant.name}` : "—",
          price: price.price,
        };
      }
      const product = price.product_id !== null ? productById.get(price.product_id) : undefined;
      return {
        id: price.id,
        sku: product?.sku ?? "",
        name: product?.name ?? "—",
        price: price.price,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "ka"));

  /*
   * დარჩენილი ვალი ითვლება თითო გაყიდვის სრული ledger-იდან (არა ბოლო 500 ჩანაწერიდან),
   * და მხოლოდ იმ გაყიდვებზე, რომლებსაც თავიდან ვალი ჰქონდათ.
   */
  const { data: debtCandidates, error: debtSalesError } = await fetchAll<{
    id: string;
    sale_number: number | string;
    total: string | number;
    paid_total: string | number;
    debt_amount: string | number;
    created_at: string;
  }>((from, to) =>
    client
      .from("pos_sales")
      .select("id,sale_number,total,paid_total,debt_amount,created_at")
      .eq("customer_id", id)
      .eq("sale_type", "wholesale")
      .gt("debt_amount", 0)
      .order("created_at", { ascending: false })
      .order("id")
      .range(from, to)
  );

  const debtBySale = new Map<string, number>();
  let debtLedgerError: unknown = null;

  for (let i = 0; i < debtCandidates.length; i += 50) {
    const ids = debtCandidates.slice(i, i + 50).map((sale) => sale.id);

    const { data: rows, error: ledgerChunkError } = await fetchAll<{
      sale_id: string | null;
      amount: string | number;
    }>((from, to) =>
      client
        .from("pos_customer_transactions")
        .select("sale_id,amount")
        .in("sale_id", ids)
        .order("created_at")
        .order("id")
        .range(from, to)
    );

    if (ledgerChunkError) {
      debtLedgerError = ledgerChunkError;
      break;
    }

    for (const transaction of rows) {
      if (!transaction.sale_id) continue;
      const cents = Math.round(Number(transaction.amount) * 100);
      debtBySale.set(
        transaction.sale_id,
        (debtBySale.get(transaction.sale_id) ?? 0) + cents
      );
    }
  }

  const debtSales = debtCandidates
    .map((sale) => ({
      ...sale,
      remainingDebt: Math.max(0, (debtBySale.get(sale.id) ?? 0) / 100),
    }))
    .filter((sale) => sale.remainingDebt > 0);

  const loadError = Boolean(
    priceError ||
      balanceError ||
      ledgerError ||
      debtSalesError ||
      debtLedgerError ||
      paymentError ||
      sessionError
  );

  return (
    <>
      <h1>{customer.name}</h1>

      <Notice
        {...(await searchParams)}
        loadError={loadError}
      />

      <section className="panel">
        <h2>კლიენტის მონაცემები</h2>

        <form
          action={saveCustomer}
          className="data-form"
        >
          <CustomerFields customer={customer} />
          <SaveButton />
        </form>
      </section>

      <section className="panel">
        <h2>
          ინდივიდუალური საბითუმო ფასები
        </h2>

        <p>
          ფასის არქონისას საცალო ფასი
          ავტომატურად არ გამოიყენება.
        </p>

        {Boolean(priceError || catalogProductError || catalogVariantError) && (
          <p className="notice error" role="alert">
            ფასების სია ვერ ჩაიტვირთა.
          </p>
        )}

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ბარკოდი</th>
                <th>პროდუქტი</th>
                <th>ფასი</th>
              </tr>
            </thead>

            <tbody>
              {priceRows.map((row) => (
                <tr key={row.id}>
                  <td>{row.sku || "—"}</td>
                  <td>{row.name}</td>
                  <td>{money(row.price)}</td>
                </tr>
              ))}

              {!priceRows.length && (
                <tr>
                  <td colSpan={3}>ინდივიდუალური ფასები ჯერ არ არის დამატებული.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <details>
          <summary>
            ფასის ხელით მითითება
          </summary>

          <form
            action={saveCustomerPrice}
            className="data-form"
          >
            <input
              type="hidden"
              name="customer_id"
              value={id}
            />

            <label>
              SKU / ბარკოდი
              <input name="sku" required />
            </label>

            <label>
              საბითუმო ფასი
              <input
                name="price"
                type="number"
                min="0"
                step="0.01"
                required
              />
            </label>

            <SaveButton />
          </form>
        </details>

       <details>
  <summary>
    Excel-იდან ფასების ატვირთვა
  </summary>

  <form
    action={importCustomerPricesExcel}
    className="data-form"
  >
    <input
      type="hidden"
      name="customer_id"
      value={id}
    />

    <label>
      Excel ფაილი
      <input
        type="file"
        name="file"
        accept=".xlsx,.xls"
        required
      />
    </label>

    <p>
      <a
        href={`/customers/${id}/prices-template`}
        className="button secondary"
        download
      >
        შაბლონის გადმოწერა (მთელი პროდუქცია)
      </a>
    </p>

    <p>
      გადმოწერილ ფაილში ყველა პროდუქტია. ამ კლიენტის ახლანდელი ფასები
      უკვე ჩაწერილია სვეტში <strong>ფასი</strong>. შეცვალეთ ან
      შეავსეთ ის ფასები, რაც გსურთ, და ატვირთეთ ფაილი ისევ აქ.
    </p>

    <p>
      ცარიელი ფასის მქონე სტრიქონები გამოიტოვება და არსებულ ფასებს არ
      შეცვლის. ფასის წაშლა ამ გზით შეუძლებელია.
    </p>

    <SaveButton>
      Excel-ის ატვირთვა
    </SaveButton>
  </form>
</details>
      </section>

      <section className="panel">
        <h2>დავალიანება</h2>

        <p>
          მიმდინარე ნაშთი:{" "}
          <strong>
            {balanceError
              ? "—"
              : money(balance)}
          </strong>
        </p>

        <h3>ღია დავალიანებები</h3>

        {!debtSales.length ? (
          <p>
            ამ კლიენტს ღია დავალიანება არ აქვს.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>გაყიდვა</th>
                  <th>თარიღი</th>
                  <th>გაყიდვის ჯამი</th>
                  <th>დარჩენილი ვალი</th>
                  <th>დაფარვა</th>
                </tr>
              </thead>

              <tbody>
                {debtSales.map((sale) => (
                  <tr key={sale.id}>
                    <td>#{sale.sale_number}</td>

                    <td>
                      {new Date(
                        sale.created_at
                      ).toLocaleString("ka-GE", {
                        timeZone:
                          "Asia/Tbilisi",
                      })}
                    </td>

                    <td>
                      {money(sale.total)}
                    </td>

                    <td>
                      <strong>
                        {money(
                          sale.remainingDebt
                        )}
                      </strong>
                    </td>

                    <td>
                      {!session ? (
                        <span>
                          ჯერ გახსენი სალარო
                        </span>
                      ) : (
                        <form
                          action={
                            recordCustomerRepayment
                          }
                          className="inline-form"
                        >
                          <input
                            type="hidden"
                            name="request_id"
                            value={crypto.randomUUID()}
                          />

                          <input
                            type="hidden"
                            name="customer_id"
                            value={id}
                          />

                          <input
                            type="hidden"
                            name="sale_id"
                            value={sale.id}
                          />

                          <input
                            type="hidden"
                            name="session_id"
                            value={session.id}
                          />

                          <label>
                            თანხა
                            <input
                              type="number"
                              name="amount"
                              min="0.01"
                              max={
                                sale.remainingDebt
                              }
                              step="0.01"
                              defaultValue={
                                sale.remainingDebt
                              }
                              required
                            />
                          </label>

                          <label>
                            მეთოდი
                            <select
                              name="method"
                              required
                            >
                              {paymentMethods?.map(
                                (method) => (
                                  <option
                                    key={
                                      method.code
                                    }
                                    value={
                                      method.code
                                    }
                                  >
                                    {method.name}
                                  </option>
                                )
                              )}
                            </select>
                          </label>

                          <SaveButton>
                            დაფარვა
                          </SaveButton>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!session && debtSales.length > 0 && (
          <p>
            დავალიანების მისაღებად ამ
            მომხმარებლის სახელზე ჯერ სალარო
            უნდა იყოს გახსნილი.
          </p>
        )}

        <h3>ბოლო 50 ოპერაცია</h3>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>თარიღი</th>
                <th>ოპერაცია</th>
                <th>თანხა</th>
              </tr>
            </thead>

            <tbody>
              {transactions
                ?.slice(0, 50)
                .map((transaction) => (
                  <tr key={transaction.id}>
                    <td>
                      {new Date(
                        transaction.created_at
                      ).toLocaleString("ka-GE", {
                        timeZone:
                          "Asia/Tbilisi",
                      })}
                    </td>

                    <td>
                      {transaction.kind ===
                      "sale_charge"
                        ? "გაყიდვა"
                        : transaction.kind ===
                            "repayment"
                          ? "ვალის დაფარვა"
                          : "გადახდა"}
                    </td>

                    <td>
                      {money(
                        transaction.amount
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}