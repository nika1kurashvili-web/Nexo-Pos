import Link from "next/link";
import { requirePosProfile } from "@/lib/auth/server";
import { roleLabels } from "@/lib/auth/access";
import { posClient, money } from "@/lib/pos/server";
import { Notice, SaveButton } from "@/app/components/pos-forms";
import { RegisterOpenForm } from "@/app/components/register-open-form";
import { openRegister, closeRegister } from "./actions";
import { registerState } from "@/lib/pos/register-cash";
import { CashWithdrawalForm } from "@/app/components/cash-withdrawal-form";

export const dynamic = "force-dynamic";

export default async function PosHomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requirePosProfile();
  const client = await posClient();

  const { data: states, error } = await registerState(client);

  const failed = Boolean(error || !states);

  const open =
    states?.filter((r) => r.session_id !== null) ?? [];

  const own = open.find((r) => r.is_own);

  const available =
    states?.filter(
      (r) =>
        r.register_active &&
        r.session_id === null,
    ) ?? [];

  const fmt = (value: string) =>
    new Date(value).toLocaleString("ka-GE", {
      timeZone: "Asia/Tbilisi",
      dateStyle: "medium",
      timeStyle: "short",
    });

  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hour12: false,
      timeZone: "Asia/Tbilisi",
    }).format(new Date()),
  );

  const greeting =
    hour < 5 ? "ღამე მშვიდობისა" : hour < 12 ? "დილა მშვიდობისა" : hour < 18 ? "გამარჯობა" : "საღამო მშვიდობისა";

  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">მომხმარებელი</p>
          <h1>
            {greeting}, {profile.full_name}
          </h1>
          <p className="hero-sub">
            <span className="badge badge-brand">{roleLabels[profile.role]}</span>
            <span lang="en">Nexo POS</span> — მოლარის სისტემა
          </p>
        </div>

        {own ? (
          <Link href="/sales/new" className="button primary hero-action">
            + ახალი გაყიდვა
          </Link>
        ) : null}
      </section>

      <Notice
        {...(await searchParams)}
        loadError={failed}
      />

      {failed ? (
        <section className="panel">
          <p>
            სალაროების მდგომარეობის შემოწმება ვერ
            მოხერხდა. განაახლეთ გვერდი ან მიმართეთ
            ადმინისტრატორს. ახალი სესიის გახსნა
            დროებით მიუწვდომელია.
          </p>
        </section>
      ) : (
        <>
          {open.length > 0 && (
            <h2 className="section-title">ღია სალაროები</h2>
          )}

          <div className="register-grid">
            {open.map((r) => (
              <section
                className={`panel register-card${r.is_own ? " own" : ""}`}
                key={r.session_id}
              >
                <header className="register-card-head">
                  <div>
                    <h2>{r.register_name}</h2>
                    <p className="muted">სალარო გახსნილია</p>
                  </div>
                  <span className="badge badge-success">
                    <span className="dot" aria-hidden="true" />
                    ღია
                  </span>
                </header>

                <div className="stat-grid">
                  <div className="stat stat-info">
                    <span>ვინ გახსნა</span>
                    <strong>{r.cashier_name ?? "—"}</strong>
                  </div>
                  <div className="stat stat-info">
                    <span>გახსნის დრო</span>
                    <strong>{r.opened_at ? fmt(r.opened_at) : "—"}</strong>
                  </div>
                  <div className="stat">
                    <span>საწყისი ნაღდი</span>
                    <strong>{money(r.opening_cash)}</strong>
                  </div>
                  <div className="stat">
                    <span>ნაღდი გადახდები ამ სესიაში</span>
                    <strong>{money(r.cash_payments)}</strong>
                  </div>
                  <div className="stat">
                    <span>გაცემული თანხა</span>
                    <strong>{money(r.cash_withdrawals)}</strong>
                  </div>
                  <div className="stat">
                    <span>ნაღდით დაბრუნებული</span>
                    <strong>{money(r.cash_refunds ?? 0)}</strong>
                  </div>
                  <div className="stat stat-highlight">
                    <span>მოსალოდნელი ნაღდი სალაროში</span>
                    <strong>{money(r.expected_cash)}</strong>
                  </div>
                </div>

                {r.is_own ? (
                  <div className="register-actions">
                    <Link
                      href="/sales/new"
                      className="button primary"
                    >
                      ახალი გაყიდვა
                    </Link>

                    {r.session_id && (
                      <CashWithdrawalForm
                        key={r.session_id}
                        sessionId={r.session_id}
                      />
                    )}
                  </div>
                ) : (
                  <p className="notice info">
                    სესია სხვა თანამშრომელს
                    ეკუთვნის. გაყიდვისთვის
                    გამოიყენეთ თქვენი ღია სესია
                    ან გახსენით თავისუფალი
                    სალარო.
                  </p>
                )}

                {r.can_close && (
                  <details className="close-register">
                    <summary>სალაროს დახურვა</summary>

                    <form
                      action={closeRegister}
                      className="data-form"
                    >
                      <input
                        type="hidden"
                        name="session_id"
                        value={r.session_id ?? ""}
                      />

                      <label>
                        ფაქტობრივი ნაღდი თანხა
                        დახურვისას
                        <input
                          name="actual_cash"
                          type="number"
                          min="0"
                          step="0.01"
                          defaultValue={
                            r.expected_cash === null
                              ? ""
                              : Number(
                                  r.expected_cash,
                                ).toFixed(2)
                          }
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

                      <SaveButton>
                        სალაროს დახურვა
                      </SaveButton>
                    </form>
                  </details>
                )}
              </section>
            ))}
          </div>

          {!own && (
            <section className="panel">
              <h2>სალაროს გახსნა</h2>

              {available.length ? (
                <RegisterOpenForm
                  registers={available}
                  action={openRegister}
                />
              ) : (
                <p>
                  თავისუფალი აქტიური სალარო
                  არ არის.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
