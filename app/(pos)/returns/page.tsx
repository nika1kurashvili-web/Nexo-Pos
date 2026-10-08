import Link from "next/link";
import { requirePosProfile } from "@/lib/auth/server";
import { posClient, money } from "@/lib/pos/server";
import type { ReturnSaleDetails } from "@/lib/pos/types";
import ReturnForm from "@/app/components/return-form";
import { ReturnStatusBadge } from "@/app/components/return-status-badge";
import { computeReturnStatus } from "@/lib/pos/return-status";
import { loadReturnStatuses } from "@/lib/pos/return-status-load";

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
        .eq("is_debt", false)
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

  // ისტორია: ბოლო დაბრუნებები და (თუ ქვითარი მოიძებნა) ამ ქვითრის დაბრუნებები.
  const { data: recentReturns } = await client
    .from("pos_returns")
    .select("id,return_number,sale_id,actor_name,reason,total_amount,created_at")
    .order("created_at", { ascending: false })
    .limit(30);
  const historySaleIds = [...new Set((recentReturns ?? []).map((r) => r.sale_id))];
  const [{ data: historySales }, historyStatuses] = await Promise.all([
    historySaleIds.length
      ? client.from("pos_sales").select("id,sale_number").in("id", historySaleIds)
      : Promise.resolve({ data: [] as { id: string; sale_number: number }[] }),
    loadReturnStatuses(client, historySaleIds),
  ]);
  const saleNumberById = new Map((historySales ?? []).map((sale) => [sale.id, sale.sale_number]));

  const { data: saleReturns } = details
    ? await client.from("pos_returns").select("id,return_number,actor_name,reason,total_amount,created_at").eq("sale_id", details.sale.id).order("created_at")
    : { data: null };
  const saleReturnIds = (saleReturns ?? []).map((r) => r.id);
  const { data: saleReturnItems } = saleReturnIds.length
    ? await client.from("pos_return_items").select("return_id,sale_item_id,quantity").in("return_id", saleReturnIds)
    : { data: null };
  const itemNames = new Map((details?.items ?? []).map((item) => [item.id, item.product_name + (item.variant_name ? ` / ${item.variant_name}` : "")]));
  const saleStatus = details
    ? computeReturnStatus(
        details.items.map((item) => ({ id: item.id, quantity: item.quantity })),
        details.items.map((item) => ({ sale_item_id: item.id, quantity: item.returned_quantity })),
      )
    : "none";

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
              <span className="return-badges">
                <ReturnStatusBadge status={saleStatus} />
                <span className="badge badge-success">
                  {details.sale.sale_type === "retail" ? "საცალო" : "საბითუმო"}
                </span>
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

          {!session && (
            <section className="panel">
              <h2>სალარო დახურულია</h2>
              <p>დაბრუნების გასაფორმებლად ჯერ უნდა გახსნა სალარო. ნივთების სია ქვემოთ ჩანს, მაგრამ დადასტურება სალაროს გახსნამდე მიუწვდომელია.</p>
              <Link href="/" className="button primary">სალაროს გახსნა</Link>
            </section>
          )}
          {allReturned ? (
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
              sessionId={session?.id ?? null}
              requestId={requestId}
            />
          )}

          {(saleReturns?.length ?? 0) > 0 && (
            <section className="panel">
              <h2>ამ ქვითრის დაბრუნებები</h2>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr><th>№</th><th>თარიღი</th><th>ვინ გააფორმა</th><th>ნივთები</th><th>თანხა</th><th>მიზეზი</th></tr>
                  </thead>
                  <tbody>
                    {saleReturns?.map((r) => (
                      <tr key={r.id}>
                        <td>#{r.return_number}</td>
                        <td>{new Date(r.created_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}</td>
                        <td>{r.actor_name}</td>
                        <td className="wrap">
                          {(saleReturnItems ?? [])
                            .filter((ri) => ri.return_id === r.id)
                            .map((ri) => `${itemNames.get(ri.sale_item_id) ?? "—"} × ${Number(ri.quantity)}`)
                            .join(", ")}
                        </td>
                        <td><strong>{money(r.total_amount)}</strong></td>
                        <td className="wrap">{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      <section className="panel">
        <h2>დაბრუნებების ისტორია</h2>
        <p className="muted">ბოლო 30 დაბრუნება. სტატუსი გვიჩვენებს ქვითრის ამჟამინდელ მდგომარეობას.</p>
        {(recentReturns?.length ?? 0) === 0 ? (
          <p className="muted">დაბრუნება ჯერ არ არის გაფორმებული.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>დაბრუნება №</th><th>თარიღი</th><th>ქვითარი</th><th>სტატუსი</th><th>ვინ გააფორმა</th><th>თანხა</th><th>მიზეზი</th></tr>
              </thead>
              <tbody>
                {recentReturns?.map((r) => {
                  const saleNumber = saleNumberById.get(r.sale_id);
                  return (
                    <tr key={r.id}>
                      <td>#{r.return_number}</td>
                      <td>{new Date(r.created_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}</td>
                      <td>
                        {saleNumber !== undefined ? (
                          <Link href={`/returns?number=${saleNumber}`}>№{saleNumber}</Link>
                        ) : "—"}
                      </td>
                      <td><ReturnStatusBadge status={historyStatuses.get(r.sale_id) ?? "none"} /></td>
                      <td>{r.actor_name}</td>
                      <td><strong>{money(r.total_amount)}</strong></td>
                      <td className="wrap">{r.reason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
