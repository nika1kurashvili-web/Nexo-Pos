import Link from "next/link";
import { requirePosProfile } from "@/lib/auth/server";
import { posClient, money } from "@/lib/pos/server";
import type { ReturnSaleDetails } from "@/lib/pos/types";
import ReturnForm from "@/app/components/return-form";

export const dynamic = "force-dynamic";

type SearchParams = {
  number?: string;
  saved?: string;
  error?: string;
  request?: string;
};

const messages: Record<string, string> = {
  invalid: "შეამოწმეთ შეყვანილი მონაცემები.",
  reason: "მიუთითეთ დაბრუნების მიზეზი.",
  cash: "სალაროში ნაღდი თანხა არასაკმარისია ამ დაბრუნებისთვის. აირჩიეთ სხვა მეთოდი.",
  quantity: "ამ ნივთის დასაბრუნებელი რაოდენობა აღარ არის საკმარისი. განაახლეთ გვერდი.",
  changed: "ქვითრის მდგომარეობა შეიცვალა (მაგ. ვალი დაიფარა). გადაამოწმეთ თანხები და სცადეთ ხელახლა.",
  session: "დაბრუნებისთვის თქვენი სალარო ღია უნდა იყოს.",
  conflict: "ეს მოთხოვნა უკვე გაგზავნილია სხვა მონაცემებით. განაახლეთ გვერდი.",
  method: "არჩეული გადახდის მეთოდი მიუწვდომელია.",
  failed: "დაბრუნება ვერ შესრულდა. შეამოწმეთ მონაცემები, სესია და წვდომა.",
};

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const profile = await requirePosProfile();
  const client = await posClient();
  const params = await searchParams;

  const numberText = (params.number ?? "").trim();
  const number = /^\d{1,12}$/.test(numberText) ? Number(numberText) : null;

  const [{ data: sessionData, error: sessionError }, { data: methodData, error: methodError }] =
    await Promise.all([
      client
        .from("pos_register_sessions")
        .select("id")
        .eq("cashier_id", profile.id)
        .eq("status", "open")
        .order("opened_at", { ascending: false })
        .limit(1),
      client
        .from("pos_payment_methods")
        .select("code,name")
        .eq("active", true)
        .order("name"),
    ]);

  const session = sessionData?.[0] ?? null;

  let details: ReturnSaleDetails = null;
  let lookupFailed = false;

  if (number !== null && number > 0) {
    const { data, error } = await client.rpc("pos_return_sale_details", {
      p_number: number,
    });
    if (error) {
      lookupFailed = true;
      console.error("[returns] rpc error:", error);
    }
    else details = data;
  }

  // უცნობი შედეგის შემდეგ ვამოწმებთ, ხომ არ ჩაიწერა დაბრუნება ამავე request ID-ით.
  let recovered: { return_number: number } | null = null;
  if (params.error === "failed" && params.request && uuidRe.test(params.request)) {
    const { data } = await client
      .from("pos_returns")
      .select("return_number")
      .eq("request_id", params.request)
      .maybeSingle();
    recovered = data ?? null;
  }

  const requestId = crypto.randomUUID();
  const loadError = Boolean(sessionError || methodError || lookupFailed);
  if (sessionError) console.error("[returns] sessions query failed:", sessionError);
  if (methodError) console.error("[returns] payment methods query failed:", methodError);
  if (lookupFailed) console.error("[returns] pos_return_sale_details failed for number", number);
  const allReturned =
    details?.items.every(
      (item) => Number(item.returned_quantity) >= Number(item.quantity),
    ) ?? false;

  return (
    <>
      <h1>დაბრუნება</h1>

      {loadError && (
        <p className="notice error" role="alert">
          მონაცემები ვერ ჩაიტვირთა. გადაამოწმეთ დაბრუნების მიგრაცია და წვდომა.
        </p>
      )}

      {recovered ? (
        <p className="notice success" role="status">
          წინა დაბრუნება მაინც დაფიქსირდა (№{recovered.return_number}). ხელახლა არ გააფორმოთ.
        </p>
      ) : params.error ? (
        <p className="notice error" role="alert">
          {messages[params.error] ?? messages.failed}
        </p>
      ) : params.saved ? (
        <p className="notice success" role="status">
          დაბრუნება წარმატებით დაფიქსირდა.
        </p>
      ) : null}

      <section className="panel">
        <h2>ქვითრის მოძებნა</h2>
        <form method="get" className="inline-form return-search">
          <label>
            გაყიდვის ნომერი
            <input
              name="number"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              defaultValue={numberText}
              placeholder="მაგ. 125"
              required
              autoFocus={!details}
            />
          </label>
          <button type="submit" className="button primary">
            ძებნა
          </button>
        </form>
        <p className="muted">
          ქვითარზე დაბეჭდილი ნომერი, ან გახსენით გაყიდვა „გაყიდვები“-დან და დააჭირეთ „დაბრუნება“-ს.
        </p>
      </section>

      {numberText && number === null && (
        <p className="notice error" role="alert">გაყიდვის ნომერი მხოლოდ ციფრებისგან უნდა შედგებოდეს.</p>
      )}

      {number !== null && !details && !lookupFailed && (
        <p className="notice error" role="alert">ქვითარი №{number} ვერ მოიძებნა.</p>
      )}

      {details && (
        <>
          <section className="panel">
            <div className="register-card-head">
              <div>
                <h2>გაყიდვა №{details.sale.sale_number}</h2>
                <p className="muted">
                  {new Date(details.sale.created_at).toLocaleString("ka-GE", {
                    timeZone: "Asia/Tbilisi",
                  })}
                  {details.sale.customer_name ? ` · ${details.sale.customer_name}` : ""}
                </p>
              </div>
              <span className="badge badge-success">
                {details.sale.sale_type === "retail" ? "საცალო" : "საბითუმო"}
              </span>
            </div>
            <div className="stat-grid stat-grid-2">
              <div className="stat">
                <span>გაყიდვის ჯამი</span>
                <strong>{money(details.sale.total)}</strong>
              </div>
              {details.sale.sale_type === "wholesale" && (
                <div className="stat">
                  <span>მიმდინარე ვალი</span>
                  <strong>{money(details.current_debt)}</strong>
                </div>
              )}
            </div>
          </section>

          {!session ? (
            <section className="panel">
              <h2>სალარო დახურულია</h2>
              <p>დაბრუნების გასაფორმებლად ჯერ უნდა გახსნა სალარო.</p>
              <Link href="/" className="button primary">სალაროს გახსნა</Link>
            </section>
          ) : allReturned ? (
            <p className="notice info">ამ ქვითრის ყველა ნივთი უკვე დაბრუნებულია.</p>
          ) : (
            <ReturnForm
              key={requestId}
              saleId={details.sale.id}
              saleNumber={details.sale.sale_number}
              saleType={details.sale.sale_type}
              currentDebt={Number(details.current_debt)}
              items={details.items.map((item) => ({
                id: item.id,
                name: item.product_name + (item.variant_name ? ` / ${item.variant_name}` : ""),
                sku: item.sku,
                quantity: String(item.quantity),
                finalUnitPrice: String(item.final_unit_price),
                lineTotal: String(item.line_total),
                returnedQuantity: String(item.returned_quantity),
                returnedAmount: String(item.returned_amount),
              }))}
              paymentMethods={(methodData ?? []).map((m) => ({ code: m.code, name: m.name }))}
              sessionId={session.id}
              requestId={requestId}
            />
          )}
        </>
      )}
    </>
  );
}
