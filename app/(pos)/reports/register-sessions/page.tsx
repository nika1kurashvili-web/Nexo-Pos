import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { money, posClient } from "@/lib/pos/server";
import { cashCents, sessionCashTotals } from "@/lib/pos/register-cash";
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
  const { data: registers, error: registersError } = await client.from("pos_registers").select("id,name").order("name");

  // Session owners populate the filter, including employees without any sales.
  const owners = new Set<string>();
  let ownersFailed = false;
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client.from("pos_register_sessions").select("id,cashier_id").order("id").range(offset, offset + 499);
    if (error || !data) { ownersFailed = true; break; }
    for (const row of data) owners.add(row.cashier_id);
    if (data.length < 500) break;
  }
  // Existing pos_profiles RLS can expose only one's own profile. Never bypass it.
  // Use an available sale name snapshot, otherwise display the employee UUID.
  const names = new Map<string, string>();
  let namesFailed = false;
  for (const id of owners) {
    const { data: profile, error } = await client.from("pos_profiles").select("full_name").eq("id", id).maybeSingle();
    if (error) namesFailed = true;
    if (profile) { names.set(id, profile.full_name); continue; }
    const { data: sales, error: salesError } = await client.from("pos_sales").select("cashier_name").eq("cashier_id", id)
      .order("created_at", { ascending: false }).order("id").limit(1);
    if (salesError) namesFailed = true;
    names.set(id, sales?.[0]?.cashier_name ? `${sales[0].cashier_name} (გაყიდვის ჩანაწერიდან)` : id);
  }
  let query = client.from("pos_register_sessions").select("*").order("opened_at", { ascending: false }).order("id", { ascending: false }).limit(100);
  if (from && date(from)) query = query.gte("opened_at", `${from}T00:00:00+04:00`);
  if (to && date(to)) {
    const nextDay = new Date(`${to}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    query = query.lt("opened_at", `${nextDay.toISOString().slice(0, 10)}T00:00:00+04:00`);
  }
  if (register && uuid(register)) query = query.eq("register_id", register);
  if (cashier && uuid(cashier)) query = query.eq("cashier_id", cashier);
  if (status) query = query.eq("status", status);
  const { data: sessions, error: sessionsError } = invalid ? { data: [], error: null } : await query;
  const cash = await sessionCashTotals(client, sessions?.filter(s => s.status === "open" && s.expected_closing_cash === null).map(s => s.id) ?? []);
  const failed = Boolean(registersError || ownersFailed || namesFailed || sessionsError || cash === null);
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
          const expected = s.status === "open" && s.expected_closing_cash === null
            ? cash ? (cashCents(s.opening_cash) + (cash.get(s.id) ?? 0)) / 100 : null
            : s.expected_closing_cash;
          return <tr key={s.id}>
            <td>{registers?.find(r => r.id === s.register_id)?.name ?? s.register_id}</td>
            <td>{names.get(s.cashier_id) ?? s.cashier_id}</td>
            <td>{time(s.opened_at)}</td><td>{money(s.opening_cash)}</td>
            <td>{s.status === "open" ? "ღია" : "დახურული"}</td><td>{time(s.closed_at)}</td>
            <td>{money(expected)}{s.status === "open" && " (მიმდინარე)"}</td>
            <td>{money(s.actual_closing_cash)}</td><td>{money(s.cash_difference)}</td><td>{s.closing_note || "—"}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {!sessionsError && !invalid && !sessions?.length && <p>მითითებული პირობებით სესიები ვერ მოიძებნა.</p>}
      <p>თუ თანამშრომლის პროფილი ხელმისაწვდომი არ არის, ნაჩვენებია გაყიდვაში შენახული სახელი ან თანამშრომლის ID.</p>
    </section>
  </>;
}
