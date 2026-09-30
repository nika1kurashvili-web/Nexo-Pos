import Link from "next/link";
import { requirePosProfile } from "@/lib/auth/server";
import { roleLabels } from "@/lib/auth/access";
import { posClient, money } from "@/lib/pos/server";
import { Notice, SaveButton } from "@/app/components/pos-forms";
import { openRegister, closeRegister } from "./actions";
import { cashCents, sessionCashTotals } from "@/lib/pos/register-cash";

export const dynamic = "force-dynamic";

export default async function PosHomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requirePosProfile();
  const client = await posClient();

  const [{ data: registers, error: registersError }, { data: activeSession, error: sessionError }] = await Promise.all([
    client
      .from("pos_registers")
      .select("id,name")
      .eq("active", true)
      .order("name"),

    client
      .from("pos_register_sessions")
      .select("id,register_id,opening_cash,opened_at,status")
      .eq("cashier_id", profile.id)
      .eq("status", "open")
      .order("opened_at", { ascending: false })
      .maybeSingle(),
  ]);

  const activeRegister = activeSession
    ? registers?.find(
        (register) => register.id === activeSession.register_id
      )
    : null;

  const cashTotals = await sessionCashTotals(client, activeSession ? [activeSession.id] : []);
  const cashSales = activeSession && cashTotals ? (cashTotals.get(activeSession.id) ?? 0) / 100 : null;

  const openingCash = activeSession
    ? Number(activeSession.opening_cash)
    : 0;

  const expectedCash = cashSales === null ? null : (cashCents(openingCash) + cashCents(cashSales)) / 100;

  return (
    <>
      <section
        className="panel account-panel"
        aria-labelledby="home-title"
      >
        <h1 id="home-title" lang="en">
          Nexo POS
        </h1>

        <p>მოგესალმებით მოლარის სისტემაში.</p>

        <dl className="profile-summary">
          <dt>მომხმარებელი</dt>
          <dd>{profile.full_name}</dd>

          <dt>როლი</dt>
          <dd>
            {roleLabels[profile.role]}{" "}
            <span lang="en">({profile.role})</span>
          </dd>
        </dl>
      </section>

      <Notice {...(await searchParams)} loadError={Boolean(sessionError || registersError || cashTotals === null)} />

      {sessionError ? <section className="panel"><p>მიმდინარე სესიის შემოწმება ვერ მოხერხდა. განაახლეთ გვერდი; ახალი სალარო არ გახსნათ.</p></section> : activeSession ? (
        <section className="panel">
          <h2>სალარო გახსნილია</h2>

          <dl className="profile-summary">
            <dt>სალარო</dt>
            <dd>{activeRegister?.name ?? activeSession.register_id}</dd>

            <dt>ვინ გახსნა</dt>
            <dd>{profile.full_name}</dd>

            <dt>გახსნის თარიღი და დრო</dt>
            <dd>{new Date(activeSession.opened_at).toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}</dd>

            <dt>საწყისი ნაღდი</dt>
            <dd>{money(openingCash)}</dd>

            <dt>ნაღდი გადახდები ამ სესიაში</dt>
            <dd>{money(cashSales)}</dd>

            <dt>მოსალოდნელი ნაღდი სალაროში</dt>
            <dd>
              <strong>{money(expectedCash)}</strong>
            </dd>
          </dl>

          <p>
            <Link href="/sales/new" className="button primary">
              ახალი გაყიდვა
            </Link>
          </p>

          <form action={closeRegister} className="data-form">
            <input
              type="hidden"
              name="session_id"
              value={activeSession.id}
            />

            <label>
              ფაქტობრივი ნაღდი თანხა დახურვისას
              <input
                name="actual_cash"
                type="number"
                min="0"
                step="0.01"
                defaultValue={expectedCash?.toFixed(2) ?? ""}
                required
              />
            </label>

            <label>
              შენიშვნა
              <textarea
                name="note"
                maxLength={2000}
                placeholder="არასავალდებულო"
              />
            </label>

            <SaveButton>სალაროს დახურვა</SaveButton>
          </form>
        </section>
      ) : (
        <section className="panel">
          <h2>სალაროს გახსნა</h2>

          {registersError ? <p>სალაროების ჩატვირთვა ვერ მოხერხდა. განაახლეთ გვერდი.</p> : registers?.length ? (
            <form action={openRegister} className="data-form">
              <label>
                სალარო
                <select
                  name="register_id"
                  required
                  defaultValue=""
                >
                  <option value="" disabled>
                    აირჩიეთ სალარო
                  </option>

                  {registers.map((register) => (
                    <option
                      key={register.id}
                      value={register.id}
                    >
                      {register.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                საწყისი ნაღდი თანხა
                <input
                  name="opening_cash"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue="0.00"
                  required
                />
              </label>

              <SaveButton>სალაროს გახსნა</SaveButton>
            </form>
          ) : (
            <p>აქტიური სალარო ვერ მოიძებნა.</p>
          )}
        </section>
      )}
    </>
  );
}
