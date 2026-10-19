import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { addDays, parseFilters, tbilisiToday, toRpcArgs } from "@/lib/pos/analytics";
import { toProfitRows } from "@/lib/pos/profit";
import ProfitTable from "@/app/components/profit-table";

export const dynamic = "force-dynamic";

type Params = { from?: string; to?: string; type?: string };

const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

/** გაყიდვები (ნავაჭრი): გაყიდული პროდუქტები პერიოდში — შესყიდვის და გასაყიდი ფასი, ჯამები, ფასნამატი. */
export default async function ProfitPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireAdmin();
  const client = await posClient();
  const params = await searchParams;

  const today = tbilisiToday();
  const type = params.type === "retail" || params.type === "wholesale" ? params.type : "all";
  const requested = parseFilters({
    from: params.from || addDays(today, -29),
    to: params.to || today,
    ...(type === "all" ? {} : { type }),
  });
  const filters = requested.invalid
    ? parseFilters({ from: addDays(today, -29), to: today, ...(type === "all" ? {} : { type }) })
    : requested;

  const { data, error } = await client.rpc("pos_sales_analytics_products", toRpcArgs(filters));
  if (error) console.error("[profit] rpc failed:", error.code, error.message);
  const rows = toProfitRows(data ?? []);

  const span = dayDiff(filters.from, filters.to);
  const link = (patch: Partial<{ from: string; to: string; type: string }>) => {
    const q = new URLSearchParams({ from: filters.from, to: filters.to, ...(type === "all" ? {} : { type }), ...patch });
    if (q.get("type") === "all") q.delete("type");
    return `/profit?${q.toString()}`;
  };
  const prev = link({ from: addDays(filters.from, -span), to: addDays(filters.from, -1) });
  const next = link({ from: addDays(filters.to, 1), to: addDays(filters.to, span) });

  const presets: [string, string, string][] = [
    ["დღეს", today, today],
    ["7 დღე", addDays(today, -6), today],
    ["30 დღე", addDays(today, -29), today],
    ["ეს თვე", `${today.slice(0, 8)}01`, today],
  ];

  return (
    <>
      <div className="analytics-head">
        <h1>გაყიდვები</h1>
      </div>

      {requested.invalid && <p className="notice error" role="alert">თარიღი არასწორია, ნაჩვენებია ბოლო 30 დღე.</p>}
      {(error || data === null) && <p className="notice error" role="alert">მონაცემები ვერ ჩაიტვირთა.</p>}

      <section className="panel profit-bar">
        <div className="profit-tabs" role="tablist">
          <Link href={link({ type: "all" })} className={type === "all" ? "on" : undefined}>ყველა გაყიდვა</Link>
          <Link href={link({ type: "retail" })} className={type === "retail" ? "on" : undefined}>საცალო</Link>
          <Link href={link({ type: "wholesale" })} className={type === "wholesale" ? "on" : undefined}>საბითუმო</Link>
        </div>

        <form method="get" className="profit-range">
          {type !== "all" && <input type="hidden" name="type" value={type} />}
          <Link href={prev} className="range-arrow" aria-label="წინა პერიოდი">‹</Link>
          <span className="range-box">
            <input type="date" name="from" defaultValue={filters.from} aria-label="თარიღიდან" />
            <span className="range-dash">—</span>
            <input type="date" name="to" defaultValue={filters.to} aria-label="თარიღამდე" />
          </span>
          <Link href={next} className="range-arrow" aria-label="შემდეგი პერიოდი">›</Link>
          <button type="submit" className="range-apply">გამოყენება</button>
        </form>

        <div className="profit-presets">
          {presets.map(([label, from, to]) => (
            <Link key={label} href={link({ from, to })} className="reason-chip">{label}</Link>
          ))}
        </div>
      </section>

      <section className="panel list-panel">
        <p>პერიოდი: {filters.from} — {filters.to}. რაოდენობა დაბრუნებების გამოკლებით. შესყიდვის ფასად მიმდინარე შესყიდვის ფასი მოქმედებს; ვისაც არ აქვს, მათი ფასნამატი ჩანს „—“.</p>
        <ProfitTable rows={rows} period={`${filters.from}_${filters.to}`} />
      </section>
    </>
  );
}
