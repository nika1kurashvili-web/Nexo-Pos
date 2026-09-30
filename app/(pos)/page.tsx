import Link from "next/link";
import { requirePosProfile } from "@/lib/auth/server";
import { roleLabels } from "@/lib/auth/access";
import { posClient, money } from "@/lib/pos/server";
import { Notice, SaveButton } from "@/app/components/pos-forms";
import { RegisterOpenForm } from "@/app/components/register-open-form";
import { openRegister, closeRegister } from "./actions";
import { registerState } from "@/lib/pos/register-cash";

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

  return (
    <>
      <section className="panel account-panel">
        <h1 lang="en">Nexo POS</h1>

        <p>მოგესალმებით მოლარის სისტემაში.</p>

        <dl className="profile-summary">
          <dt>მომხმარებელი</dt>
          <dd>{profile.full_name}</dd>

          <dt>როლი</dt>
          <dd>{roleLabels[profile.role]}</dd>
        </dl>
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
          {open.map((r) => (
            <section
              className="panel"
              key={r.session_id}
            >
              <h2>
                სალარო გახსნილია —{" "}
                {r.register_name}
              </h2>

              <dl className="profile-summary">
                <dt>სალარო</dt>
                <dd>{r.register_name}</dd>

                <dt>ვინ გახსნა</dt>
                <dd>
                  {r.cashier_name ?? "—"}
                </dd>

                <dt>
                  გახსნის თარიღი და დრო
                </dt>
                <dd>
                  {r.opened_at
                    ? new Date(
                        r.opened_at,
                      ).toLocaleString(
                        "ka-GE",
                        {
                          timeZone:
                            "Asia/Tbilisi",
                        },
                      )
                    : "—"}
                </dd>

                <dt>საწყისი ნაღდი</dt>
                <dd>
                  {money(r.opening_cash)}
                </dd>

                <dt>
                  ნაღდი გადახდები ამ სესიაში
                </dt>
                <dd>
                  {money(r.cash_payments)}
                </dd>

                <dt>
                  მოსალოდნელი ნაღდი სალაროში
                </dt>
                <dd>
                  <strong>
                    {money(r.expected_cash)}
                  </strong>
                </dd>
              </dl>

              {r.is_own ? (
                <p>
                  <Link
                    href="/sales/new"
                    className="button primary"
                  >
                    ახალი გაყიდვა
                  </Link>
                </p>
              ) : (
                <p>
                  სესია სხვა თანამშრომელს
                  ეკუთვნის. გაყიდვისთვის
                  გამოიყენეთ თქვენი ღია სესია
                  ან გახსენით თავისუფალი
                  სალარო.
                </p>
              )}

              {r.can_close && (
                <form
                  action={closeRegister}
                  className="data-form"
                >
                  <input
                    type="hidden"
                    name="session_id"
                    value={
                      r.session_id ?? ""
                    }
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
                        r.expected_cash ===
                        null
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
              )}
            </section>
          ))}

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