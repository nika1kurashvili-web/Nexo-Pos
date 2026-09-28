import { requirePosProfile } from "@/lib/auth/server";
import { money, posClient } from "@/lib/pos/server";
import { Notice, SaveButton } from "@/app/components/pos-forms";
import { openRegister, closeRegister } from "./actions";

export default async function CashRegisterPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const profile = await requirePosProfile();
  const client = await posClient();
  const { data: sessions, error } = await client.from("pos_register_sessions").select("*").eq("cashier_id",profile.id).order("opened_at",{ascending:false}).limit(10);
  const { data: registers, error: registerError } = await client.from("pos_registers").select("*").eq("active",true).order("name");
  const current = sessions?.find((s) => s.status === "open");
  const failed = Boolean(error || registerError);
  return <><h1>სალარო</h1><Notice {...await searchParams} loadError={failed} />
    {!failed && <section className="panel"><h2>{current ? "მიმდინარე სესია" : "სალაროს გახსნა"}</h2>
      {current ? <>
        <dl><dt>საწყისი ნაღდი</dt><dd>{money(current.opening_cash)}</dd><dt>გახსნის დრო</dt><dd>{new Date(current.opened_at).toLocaleString("ka-GE",{timeZone:"Asia/Tbilisi"})}</dd></dl>
        <form action={closeRegister} className="data-form"><input type="hidden" name="session_id" value={current.id} />
          <label>დათვლილი ნაღდი ფული<input name="actual_cash" type="number" min="0" step="0.01" required /></label>
          <label>დახურვის შენიშვნა<textarea name="note" maxLength={2000} /></label>
          <p>მოსალოდნელი ნაშთი და სხვაობა გამოითვლება დახურვისას.</p><SaveButton>სალაროს დახურვა</SaveButton>
        </form>
      </> : registers?.length ? <form action={openRegister} className="data-form">
        <label>სალარო<select name="register_id">{registers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label>საწყისი ნაღდი ფული<input name="opening_cash" type="number" min="0" step="0.01" required defaultValue="0.00" /></label><SaveButton>სალაროს გახსნა</SaveButton>
      </form> : <p>აქტიური სალარო არ არის. მიმართეთ ადმინისტრატორს.</p>}
    </section>}
    <section className="panel"><h2>ბოლო სესიები</h2><div className="table-scroll"><table><thead><tr><th>გახსნა</th><th>სტატუსი</th><th>მოსალოდნელი</th><th>დათვლილი</th><th>სხვაობა</th></tr></thead><tbody>
      {sessions?.map((s) => <tr key={s.id}><td>{new Date(s.opened_at).toLocaleString("ka-GE",{timeZone:"Asia/Tbilisi"})}</td><td>{s.status === "open" ? "ღია" : "დახურული"}</td><td>{money(s.expected_closing_cash)}</td><td>{money(s.actual_closing_cash)}</td><td>{money(s.cash_difference)}</td></tr>)}
    </tbody></table></div></section>
    <section className="panel"><p>სალაროს მოდული მზადდება</p><p>პროდუქტების კალათა და გაყიდვის ეკრანი დაემატება შემდეგ ეტაპზე.</p></section>
  </>;
}
