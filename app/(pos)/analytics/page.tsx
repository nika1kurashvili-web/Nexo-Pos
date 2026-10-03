import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { money, posClient } from "@/lib/pos/server";
import { fetchAll } from "@/lib/pos/paginate";
import {
  addDays,
  filtersToQuery,
  parseFilters,
  tbilisiToday,
  toRpcArgs,
  weekdayLabels,
  type AnalyticsParams,
} from "@/lib/pos/analytics";
import type { SalesAnalytics } from "@/lib/pos/types";

export const dynamic = "force-dynamic";

const num = (value: number | string | null | undefined) => Number(value ?? 0);
const count = (value: number) => value.toLocaleString("ka-GE", { maximumFractionDigits: 3 });

function Tile({
  label,
  value,
  hint,
  tone = "plain",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "plain" | "brand" | "green" | "amber" | "rose" | "violet";
}) {
  return (
    <div className={`atile atile-${tone}`}>
      <span className="atile-label">{label}</span>
      <strong className="atile-value">{value}</strong>
      {hint && <span className="atile-hint">{hint}</span>}
    </div>
  );
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<AnalyticsParams>;
}) {
  await requireAdmin();
  const client = await posClient();
  const params = await searchParams;
  const filters = parseFilters(params);

  const { data: customers } = await fetchAll<{ id: string; name: string; tax_code: string | null }>(
    (from, to) =>
      client
        .from("pos_business_customers")
        .select("id,name,tax_code")
        .order("name")
        .order("id")
        .range(from, to),
  );

  let data: SalesAnalytics | null = null;
  let failed = false;
  let migrationMissing = false;

  if (!filters.invalid) {
    const result = await client.rpc("pos_sales_analytics", toRpcArgs(filters));
    if (result.error) {
      failed = true;
      migrationMissing = result.error.code === "PGRST202" || result.error.code === "42883";
      console.error("[analytics] rpc failed:", result.error.code, result.error.message);
    } else {
      data = result.data;
    }
  }

  const today = tbilisiToday();
  const monthStart = `${today.slice(0, 7)}-01`;
  const presets = [
    { label: "დღეს", from: today, to: today },
    { label: "7 დღე", from: addDays(today, -6), to: today },
    { label: "30 დღე", from: addDays(today, -29), to: today },
    { label: "ეს თვე", from: monthStart, to: today },
  ];
  const presetHref = (from: string, to: string) =>
    `/analytics?${filtersToQuery(filters, { from, to })}`;
  const exportHref = `/analytics/export?${filtersToQuery(filters)}`;

  const totals = data?.totals;
  const net = num(totals?.net);
  const cost = num(totals?.cost);
  const profit = num(totals?.profit);
  const unknownRevenue = num(totals?.unknown_cost_revenue);
  const knownRevenue = net - unknownRevenue;
  const margin = knownRevenue > 0 ? (profit / knownRevenue) * 100 : null;
  const salesCount = num(totals?.sales_count);
  const average = salesCount > 0 ? net / salesCount : 0;

  const weekdays = data?.weekdays ?? [];
  const maxDayCount = Math.max(1, ...weekdays.map((d) => num(d.sales_count)));
  const busiest = weekdays.reduce(
    (best, d) => (num(d.sales_count) > best.count ? { day: d.day, count: num(d.sales_count) } : best),
    { day: 0, count: 0 },
  );

  const retailPart = data?.types.retail;
  const wholesalePart = data?.types.wholesale;
  const showSplit = filters.retail && filters.wholesale && !filters.customer;
  const empty = data !== null && salesCount === 0;

  return (
    <>
      <div className="analytics-head">
        <h1>ანალიტიკა</h1>
        <div className="analytics-tools">
          <div className="preset-links" aria-label="სწრაფი პერიოდი">
            {presets.map((preset) => (
              <Link key={preset.label} href={presetHref(preset.from, preset.to)} className="preset">
                {preset.label}
              </Link>
            ))}
          </div>
          {!filters.invalid && (
            <a
              href={exportHref}
              className="icon-button"
              aria-label="Excel-ში ჩამოტვირთვა"
              title="Excel-ში ჩამოტვირთვა"
              download
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12" />
                <path d="m7 11 5 5 5-5" />
                <path d="M5 20h14" />
              </svg>
            </a>
          )}
        </div>
      </div>

      {failed && (
        <p className="notice error" role="alert">
          {migrationMissing
            ? "ანალიტიკის ბაზის ფუნქცია ვერ მოიძებნა. გაუშვით მიგრაცია 202610030001_pos_analytics.sql."
            : "მონაცემები ვერ ჩაიტვირთა."}
        </p>
      )}
      {filters.invalid && (
        <p className="notice error" role="alert">
          ფილტრის მნიშვნელობა არასწორია. გადაამოწმეთ თარიღები და თანხები.
        </p>
      )}

      <section className="panel">
        <h2>ფილტრები</h2>
        <form method="get" className="data-form report-filters" key={JSON.stringify(filters)}>
          <label>
            თარიღიდან
            <input type="date" name="from" defaultValue={filters.from} />
          </label>
          <label>
            თარიღამდე
            <input type="date" name="to" defaultValue={filters.to} />
          </label>
          <label>
            პროდუქტი (სახელი)
            <input
              type="search"
              name="product"
              defaultValue={filters.product}
              maxLength={100}
              placeholder="მაგ. ჩანთა"
            />
          </label>
          <label>
            ბარკოდი / SKU
            <input type="search" name="sku" defaultValue={filters.sku} maxLength={100} />
          </label>
          <label>
            გაყიდვის ჯამი, მინიმუმი (₾)
            <input type="text" inputMode="decimal" name="min" defaultValue={filters.min} placeholder="0" />
          </label>
          <label>
            გაყიდვის ჯამი, მაქსიმუმი (₾)
            <input type="text" inputMode="decimal" name="max" defaultValue={filters.max} placeholder="∞" />
          </label>

          <fieldset className="type-picker">
            <legend>გაყიდვის ტიპი</legend>
            <label className="check">
              <input type="checkbox" name="type" value="retail" defaultChecked={filters.retail} />
              საცალო
            </label>
            <label className="check">
              <input type="checkbox" name="type" value="wholesale" defaultChecked={filters.wholesale} />
              საბითუმო
            </label>
          </fieldset>

          <label>
            საბითუმო კლიენტი
            <select name="customer" defaultValue={filters.customer}>
              <option value="">ყველა კლიენტი</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                  {customer.tax_code ? ` — ${customer.tax_code}` : ""}
                </option>
              ))}
            </select>
          </label>

          <div className="filter-actions">
            <button type="submit" className="button primary">
              გაფილტვრა
            </button>
            <Link href="/analytics?from=&to=" className="button secondary">
              მთელი პერიოდი
            </Link>
            <Link href="/analytics" className="button secondary">
              გასუფთავება
            </Link>
          </div>
        </form>
        <p className="muted">
          თარიღი ეხება გაყიდვის დროს (თბილისის დროით). კლიენტის არჩევისას ნაჩვენებია მხოლოდ საბითუმო გაყიდვები.
        </p>
      </section>

      {empty && (
        <p className="notice info" role="status">
          ამ ფილტრით გაყიდვა ვერ მოიძებნა.
        </p>
      )}

      {data && (
        <>
          <section className="atiles" aria-label="სტატისტიკა">
            <Tile
              tone="brand"
              label="შემოსული თანხა"
              value={money(net)}
              hint={
                num(totals?.returns) > 0
                  ? `გაყიდვები ${money(num(totals?.gross))} − დაბრუნებები ${money(num(totals?.returns))}`
                  : "გაყიდვების ჯამი"
              }
            />
            <Tile
              tone="amber"
              label="თვითღირებულება"
              value={cost === 0 && unknownRevenue > 0 ? "—" : money(cost)}
              hint="ამჟამინდელი შესყიდვის ფასით"
            />
            <Tile
              tone="green"
              label="მოგება"
              value={knownRevenue > 0 || cost > 0 ? money(profit) : "—"}
              hint={margin === null ? undefined : `მარჟა ${margin.toFixed(1)}%`}
            />
            <Tile tone="violet" label="გაყიდვების რაოდენობა" value={count(salesCount)} hint={`საშუალო ჩეკი ${money(average)}`} />
            <Tile label="გაყიდული ერთეული" value={count(num(totals?.quantity))} hint="დაბრუნებების გარეშე" />
            <Tile
              tone="rose"
              label="დაბრუნებები"
              value={money(num(totals?.returns))}
              hint={num(totals?.gross) > 0 ? `${((num(totals?.returns) / num(totals?.gross)) * 100).toFixed(1)}% გაყიდვებიდან` : undefined}
            />
            {data.received !== null && (
              <Tile label="ფაქტობრივად მიღებული" value={money(num(data.received))} hint="გადახდები − ფულის დაბრუნება" />
            )}
            {data.debt !== null && num(data.debt) > 0 && (
              <Tile tone="rose" label="დარჩენილი ვალი" value={money(num(data.debt))} hint="საბითუმო გაყიდვებზე" />
            )}
          </section>

          {unknownRevenue > 0 && (
            <p className="notice info" role="status">
              {money(unknownRevenue)} ნავაჭრზე შესყიდვის ფასი მითითებული არ არის, ამიტომ ეს თანხა მოგებაში არ შედის.
            </p>
          )}
          {data.item_mode && (
            <p className="muted">
              პროდუქტის ან ბარკოდის ფილტრისას ნაჩვენებია მხოლოდ შესაბამისი პროდუქტები. „ფაქტობრივად მიღებული“ და
              ვალი ამ რეჟიმში არ ითვლება.
            </p>
          )}

          {showSplit && (retailPart || wholesalePart) && (
            <section className="panel">
              <h2>საცალო და საბითუმო</h2>
              <div className="split-bar" role="img" aria-label="საცალო და საბითუმო წილი">
                {(() => {
                  const r = num(retailPart?.net);
                  const w = num(wholesalePart?.net);
                  const total = r + w;
                  const rp = total > 0 ? (r / total) * 100 : 50;
                  return (
                    <>
                      <span className="split-retail" style={{ width: `${rp}%` }} />
                      <span className="split-wholesale" style={{ width: `${100 - rp}%` }} />
                    </>
                  );
                })()}
              </div>
              <div className="split-legend">
                <span><i className="dot dot-retail" /> საცალო: <strong>{money(num(retailPart?.net))}</strong> · {num(retailPart?.sales_count)} გაყიდვა</span>
                <span><i className="dot dot-wholesale" /> საბითუმო: <strong>{money(num(wholesalePart?.net))}</strong> · {num(wholesalePart?.sales_count)} გაყიდვა</span>
              </div>
            </section>
          )}

          <section className="panel">
            <h2>გაყიდვები კვირის დღეების მიხედვით</h2>
            <div className="weekday-chart" role="list">
              {weekdays.map((d) => {
                const value = num(d.sales_count);
                const height = Math.round((value / maxDayCount) * 100);
                return (
                  <div
                    key={d.day}
                    role="listitem"
                    className={`weekday${d.day === busiest.day && value > 0 ? " weekday-top" : ""}`}
                    title={`${weekdayLabels[d.day - 1]}: ${value} გაყიდვა, ${money(num(d.net))}`}
                  >
                    <span className="weekday-count">{value}</span>
                    <div className="weekday-track">
                      <div className="weekday-bar" style={{ height: `${Math.max(height, value > 0 ? 4 : 0)}%` }} />
                    </div>
                    <span className="weekday-name">{weekdayLabels[d.day - 1]}</span>
                    <span className="weekday-money">{money(num(d.net))}</span>
                  </div>
                );
              })}
            </div>
            {busiest.count > 0 && (
              <p className="muted">
                ყველაზე დატვირთული დღე: <strong>{weekdayLabels[busiest.day - 1]}</strong> ({busiest.count} გაყიდვა).
              </p>
            )}
          </section>

          <section className="panel">
            <h2>ტოპ პროდუქტები</h2>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>ბარკოდი</th>
                    <th>პროდუქტი</th>
                    <th>რაოდენობა</th>
                    <th>თანხა</th>
                  </tr>
                </thead>
                <tbody>
                  {data.top_products.map((item) => (
                    <tr key={`${item.sku ?? ""}-${item.name}`}>
                      <td>{item.sku || "—"}</td>
                      <td>{item.name}</td>
                      <td>{count(num(item.quantity))}</td>
                      <td>{money(num(item.net))}</td>
                    </tr>
                  ))}
                  {!data.top_products.length && (
                    <tr>
                      <td colSpan={4}>მონაცემი არ არის.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <details className="panel how-it-works">
            <summary>როგორ ითვლება</summary>
            <ul>
              <li><strong>შემოსული თანხა</strong> = გაყიდვების ჯამი მინუს დაბრუნებული თანხა.</li>
              <li><strong>თვითღირებულება</strong> ითვლება პროდუქტის ამჟამინდელი შესყიდვის ფასით და არა გაყიდვის დღეს არსებულით.</li>
              <li><strong>მოგება</strong> = შემოსული თანხა − თვითღირებულება, მხოლოდ იმ პროდუქტებზე, რომლებსაც შესყიდვის ფასი აქვს.</li>
              <li>დაბრუნება აკლდება იმ გაყიდვას, საიდანაც დაბრუნდა, მისი თარიღის მიუხედავად.</li>
              <li>მინიმალური და მაქსიმალური თანხა ეხება მთელი ქვითრის ჯამს.</li>
            </ul>
          </details>
        </>
      )}
    </>
  );
}
