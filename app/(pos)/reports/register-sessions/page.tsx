import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { money, posClient } from "@/lib/pos/server";
import { registerSessionReport } from "@/lib/pos/register-cash";

import { Notice } from "@/app/components/pos-forms";

export const dynamic = "force-dynamic";
type Filters = { from?: string; to?: string; register?: string; cashier?: string; status?: string };
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const time = (value: string | null) => value ? new Date(value).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" }) : "—";

export default async function RegisterSessionsReport({ searchParams }: { searchParams: Promise<Filters> }) {
  await requireAdmin();
  const client = await posClient();
  const params = await searchParams;
  const from = typeof params.from === "string" ? params.from.trim() : "";
  const to = typeof params.to === "string" ? params.to.trim() : "";
  const register = typeof params.register === "string" ? params.register.trim() : "";
  const cashier = typeof params.cashier === "string" ? params.cashier.trim() : "";
  const status = params.status === "open" || params.status === "closed" ? params.status : "";
  const invalid = Boolean((from && !date(from)) || (to && !date(to)) || (from && to && from > to) ||
    (register && !uuid(register)) || (cashier && !uuid(cashier)));
  let until: string | null = null;
  if (to && date(to)) {
    const nextDay = new Date(`${to}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    until = `${nextDay.toISOString().slice(0, 10)}T00:00:00+04:00`;
  }
  const { data: report, error: reportError } = await registerSessionReport(client, {
    p_from: !invalid && from ? `${from}T00:00:00+04:00` : null,
    p_to: !invalid ? until : null,
    p_register: !invalid && register ? register : null,
    p_cashier: !invalid && cashier ? cashier : null,
    p_status: status || null,
  });
  const registers = report?.registers;
  const names = new Map(report?.cashiers.map(p => [p.id, p.full_name]) ?? []);
  const sessions = invalid ? [] : report?.sessions;
  const failed = Boolean(reportError || !report);
  return <>
    <p><Link href="/reports">← რეპორტებზე დაბრუნება</Link></p>
    <h1>სალაროს სესიები</h1>
    <Notice loadError={failed} />
    {invalid && <p className="notice error" role="alert">ფილტრის მნიშვნელობა არასწორია. გადაამოწმეთ თარიღები და არჩეული ჩანაწერები.</p>}
    <section className="panel">
      <h2>ფილტრები</h2>
      <form method="get" className="data-form" key={JSON.stringify([from, to, register, cashier, status])}>
        <label>თარიღიდან<input type="date" name="from" defaultValue={from} /></label>
        <label>თარიღამდე<input type="date" name="to" defaultValue={to} /></label>
        <label>სალარო<select name="register" defaultValue={register}><option value="">ყველა</option>{registers?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label>მოლარე<select name="cashier" defaultValue={cashier}><option value="">ყველა</option>{[...names].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>სტატუსი<select name="status" defaultValue={status}><option value="">ყველა</option><option value="open">ღია</option><option value="closed">დახურული</option></select></label>
        <div><button type="submit" className="button primary">ძებნა</button>{" "}<Link href="/reports/register-sessions" className="button secondary">გასუფთავება</Link></div>
      </form>
      <p>თარიღები იფილტრება გახსნის დროით, თბილისის დროის სარტყელში. ნაჩვენებია უახლესი 100 სესია.</p>
    </section>
    <section className="panel">
      <h2>სესიების ისტორია</h2>
      <div className="table-scroll"><table>
        <thead><tr>{["სალარო", "მოლარე / ვინ გახსნა", "გახსნა", "საწყისი თანხა", "სტატუსი", "დახურვა", "მოსალოდნელი თანხა", "ფაქტობრივი თანხა", "სხვაობა", "დახურვის შენიშვნა"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{sessions?.map(s => {
          const expected = s.expected_cash;
          return <tr key={s.id}>
            <td>{s.register_name}</td>
            <td>{s.cashier_name}</td>
            <td>{time(s.opened_at)}</td><td>{money(s.opening_cash)}</td>
            <td>{s.status === "open" ? "ღია" : "დახურული"}</td><td>{time(s.closed_at)}</td>
            <td>{money(expected)}{s.status === "open" && " (მიმდინარე)"}</td>
            <td>{money(s.actual_closing_cash)}</td><td>{money(s.cash_difference)}</td><td>{s.closing_note || "—"}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {!failed && !invalid && !sessions?.length && <p>მითითებული პირობებით სესიები ვერ მოიძებნა.</p>}

    </section>
  </>;
}

