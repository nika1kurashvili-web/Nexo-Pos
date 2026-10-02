import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { money, posClient } from "@/lib/pos/server";
import { fetchAll } from "@/lib/pos/paginate";
import { registerSessionReport } from "@/lib/pos/register-cash";
import { Notice } from "@/app/components/pos-forms";
import type { CashWithdrawal } from "@/lib/pos/types";

export const dynamic = "force-dynamic";

type Filters = {
  from?: string;
  to?: string;
  register?: string;
  cashier?: string;
  session?: string;
  q?: string;
};

const MAX_ROWS = 5000;

const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const date = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

const time = (value: string) =>
  new Date(value).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" });

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export default async function CashWithdrawalsReport({
  searchParams,
}: {
  searchParams: Promise<Filters>;
}) {
  await requireAdmin();

  const client = await posClient();
  const params = await searchParams;

  const from = text(params.from);
  const to = text(params.to);
  const register = text(params.register);
  const cashier = text(params.cashier);
  const session = text(params.session);
  const q = text(params.q).slice(0, 100);

  const invalid = Boolean(
    (from && !date(from)) ||
      (to && !date(to)) ||
      (from && to && from > to) ||
      (register && !uuid(register)) ||
      (cashier && !uuid(cashier)) ||
      (session && !uuid(session)),
  );

  let until: string | null = null;
  if (to && date(to)) {
    const nextDay = new Date(`${to}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    until = `${nextDay.toISOString().slice(0, 10)}T00:00:00+04:00`;
  }

  // ფილტრის სიები (სალაროები და მოლარეები) იგივე ადმინისტრატორის ფუნქციიდან მოდის.
  const { data: options } = await registerSessionReport(client, {
    p_from: null,
    p_to: null,
    p_register: null,
    p_cashier: null,
    p_status: null,
  });

  const safeQ = q
    .replaceAll(/[,()"\\]/g, " ")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");

  const { data: rows, error } = invalid
    ? { data: [] as CashWithdrawal[], error: null }
    : await fetchAll<CashWithdrawal>((rangeFrom, rangeTo) => {
        let query = client
          .from("pos_cash_withdrawals")
          .select("*")
          .order("created_at", { ascending: false })
          .order("id");

        if (from) query = query.gte("created_at", `${from}T00:00:00+04:00`);
        if (until) query = query.lt("created_at", until);
        if (register) query = query.eq("register_id", register);
        if (cashier) query = query.eq("actor_id", cashier);
        if (session) query = query.eq("session_id", session);
        if (safeQ) query = query.ilike("reason", `%${safeQ}%`);

        return query.range(rangeFrom, rangeTo);
      }, 1000, MAX_ROWS);

  const failed = Boolean(error);
  const totalCents = rows.reduce(
    (sum, row) => sum + Math.round(Number(row.amount) * 100),
    0,
  );
  const truncated = rows.length >= MAX_ROWS;

  return (
    <>
      <p>
        <Link href="/reports">← რეპორტებზე დაბრუნება</Link>
      </p>
      <h1>თანხის გაცემის ისტორია</h1>

      <Notice loadError={failed} />
      {invalid && (
        <p className="notice error" role="alert">
          ფილტრის მნიშვნელობა არასწორია. გადაამოწმეთ თარიღები და არჩეული ჩანაწერები.
        </p>
      )}

      <section className="panel">
        <h2>ფილტრები</h2>
        <form
          method="get"
          className="data-form report-filters"
          key={JSON.stringify([from, to, register, cashier, session, q])}
        >
          {session && <input type="hidden" name="session" value={session} />}
          <label>
            თარიღიდან
            <input type="date" name="from" defaultValue={from} />
          </label>
          <label>
            თარიღამდე
            <input type="date" name="to" defaultValue={to} />
          </label>
          <label>
            სალარო
            <select name="register" defaultValue={register}>
              <option value="">ყველა</option>
              {options?.registers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            ვინ გასცა
            <select name="cashier" defaultValue={cashier}>
              <option value="">ყველა</option>
              {options?.cashiers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.full_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            მიზეზი (ძებნა)
            <input
              type="search"
              name="q"
              defaultValue={q}
              maxLength={100}
              placeholder="მაგ. ინკასაცია"
            />
          </label>
          <div className="filter-actions">
            <button type="submit" className="button primary">
              ძებნა
            </button>
            <Link href="/reports/cash-withdrawals" className="button secondary">
              გასუფთავება
            </Link>
          </div>
        </form>
        {session && (
          <p className="muted">
            ნაჩვენებია ერთი სალაროს სესიის გაცემები.{" "}
            <Link href="/reports/cash-withdrawals">ყველა სესიის ნახვა</Link>
          </p>
        )}
        <p className="muted">
          თარიღები იფილტრება გაცემის დროით, თბილისის დროის სარტყელში.
        </p>
      </section>

      <section className="panel">
        <div className="stat-grid stat-grid-2">
          <div className="stat">
            <span>გაცემების რაოდენობა</span>
            <strong>{rows.length}</strong>
          </div>
          <div className="stat stat-highlight">
            <span>გაცემული თანხა სულ</span>
            <strong>{money(totalCents / 100)}</strong>
          </div>
        </div>
        {truncated && (
          <p className="notice info">
            ნაჩვენებია უახლესი {MAX_ROWS} ჩანაწერი. დააზუსტეთ ფილტრი.
          </p>
        )}

        <h2>ჩანაწერები</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {["დრო", "სალარო", "ვინ გასცა", "თანხა", "მიზეზი"].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id}>
                  <td>{time(w.created_at)}</td>
                  <td>{w.register_name}</td>
                  <td>{w.actor_name}</td>
                  <td>
                    <strong>{money(w.amount)}</strong>
                  </td>
                  <td className="wrap">{w.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!failed && !invalid && rows.length === 0 && (
          <p>მითითებული პირობებით გაცემები ვერ მოიძებნა.</p>
        )}
      </section>
    </>
  );
}
