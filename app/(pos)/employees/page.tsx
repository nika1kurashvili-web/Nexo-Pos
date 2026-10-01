import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { EmployeeForm } from "@/app/components/employee-form";
import { SubmitButton } from "@/app/components/submit-button";
import { addEmployee, updateEmployee, resetEmployeePassword } from "./actions";

export const dynamic = "force-dynamic";
const errors: Record<string, string> = {
  SELF_DISABLE_FORBIDDEN: "საკუთარი ანგარიშის გათიშვა დაუშვებელია.",
  SELF_DEMOTION_FORBIDDEN: "საკუთარი ადმინისტრატორის როლის მოლარედ შეცვლა დაუშვებელია.",
  LAST_ADMIN: "ბოლო აქტიური POS ადმინისტრატორის გათიშვა ან მოლარედ შეცვლა დაუშვებელია.",
  EMPLOYEE_OPEN_SESSION: "თანამშრომელს ღია სალარო აქვს. გათიშვამდე ჯერ სალარო უნდა დაიხუროს.",
  MEMBERSHIP_METADATA_INVALID: "ანგარიშის წევრობის მონაცემები გადამოწმებას საჭიროებს. ცვლილება არ შენახულა.",
  SHARED_PASSWORD_CONFIRM_REQUIRED: "დაადასტურეთ, რომ პაროლის შეცვლა Orders-ში შესვლაზეც იმოქმედებს.",
  INVALID_EMPLOYEE: "შეამოწმეთ სახელი, ელფოსტა, როლი და დადასტურება.",
  POS_ACCESS_DENIED: "ამ მოქმედებისთვის აქტიური POS ადმინისტრატორის უფლებაა საჭირო.",
  existing_confirm: "ეს ელფოსტა უკვე არსებობს. მისთვის POS წვდომის დამატება/განახლება ცალკე მონიშნეთ და ხელახლა გაგზავნეთ. არსებული პაროლი არ შეიცვლება.",
  password: "დროებითი პაროლი უნდა შეიცავდეს 12–256 სიმბოლოს.",
  configuration: "მომხმარებლის შექმნისა და პაროლის შეცვლის სერვერული კონფიგურაცია მიუწვდომელია. მიმართეთ ადმინისტრატორს.",
  prerequisite: "მომხმარებელთა უსაფრთხო provisioning ჯერ არ არის გამართული. ანგარიში არ შექმნილა.",
  creation_unknown: "ანგარიშის შექმნა ვერ დადასტურდა. ხელახლა შექმნამდე გადაამოწმეთ Auth Users; ავტომატური გამეორება ან წაშლა არ შესრულებულა.",
  password_unknown: "პაროლის ცვლილების ან აუდიტის შედეგი ვერ დადასტურდა. ავტომატური გამეორება არ შესრულებულა; გადაამოწმეთ ანგარიში.",
  failed: "ცვლილება ვერ დასრულდა. თუ Auth ანგარიში უკვე შეიქმნა, ადმინისტრატორმა უნდა გადაამოწმოს POS წევრობა. ავტომატური წაშლა არ შესრულებულა.",
};
const events: Record<string,string> = { created:"POS წევრობა დაემატა",updated:"პროფილი/როლი/სტატუსი შეიცვალა",password_requested:"პაროლის შეცვლა მოთხოვნილია",password_succeeded:"პაროლი შეიცვალა",password_unknown:"პაროლის ცვლილების შედეგი გადასამოწმებელია" };

export default async function EmployeesPage({ searchParams }: { searchParams: Promise<{error?:string;saved?:string}> }) {
  const actor = await requireAdmin();
  const params=await searchParams;
  const client=await posClient();
  const [{data:employees,error},{data:audit,error:auditError}]=await Promise.all([
    client.rpc("pos_employee_list",{}),
    client.from("pos_employee_audit").select("id,actor_id,target_id,event,created_at").order("created_at",{ascending:false}).limit(50),
  ]);
  const failed=Boolean(error || !employees);
  const adminCount=employees?.filter(e=>e.active && e.role==="admin").length ?? 0;
  const name=(id:string)=>employees?.find(e=>e.id===id)?.full_name ?? id;
  return <>
    <h1>თანამშრომლები</h1>
    {params.error && <p className="notice error" role="alert">{errors[params.error] ?? errors.failed}</p>}
    {params.saved && <p className="notice success" role="status">ცვლილება შენახულია.</p>}
    {failed ? <p className="notice error" role="alert">თანამშრომლების მართვა მიუწვდომელია. გადაამოწმეთ კავშირი და თანამშრომლების მართვის migration. ცვლილებები არ გაგზავნოთ.</p> : <>
      <section className="panel">
        <h2>თანამშრომლის დამატება</h2>
        <p>ახალი ანგარიში მხოლოდ POS წვდომით შეიქმნება. არსებული ანგარიშის Orders წვდომა და პაროლი უცვლელი დარჩება.</p>
        <EmployeeForm action={addEmployee} confirmation="ადასტურებთ ამ ელფოსტისთვის არჩეული POS წვდომის მინიჭებას? ახალი ანგარიშის ელფოსტა დადასტურებულად ჩაითვლება.">
          <label>სახელი<input name="name" required maxLength={200}/></label>
          <label>ელფოსტა<input name="email" type="email" required maxLength={254} autoComplete="off"/></label>
          <label>დროებითი პაროლი (ახალი ანგარიშისთვის)<input name="password" type="password" minLength={12} maxLength={256} autoComplete="new-password"/></label>
          <label>POS როლი<select name="role" defaultValue="cashier"><option value="cashier">მოლარე</option><option value="admin">Admin</option></select></label>
          <label className="check"><input name="existing_confirm" type="checkbox" value="yes"/>თუ ელფოსტა არსებობს, ვადასტურებ POS წევრობის დამატებას/განახლებასა და გააქტიურებას.</label>
          <SubmitButton pendingText="ინახება…" className="button primary">თანამშრომლის დამატება</SubmitButton>
        </EmployeeForm>
      </section>
      <section className="panel"><h2>POS თანამშრომლები</h2><div className="table-scroll"><table>
        <thead><tr>{["სახელი","ელფოსტა","POS როლი","სტატუსი","შექმნის თარიღი","მოქმედებები"].map(t=><th key={t} scope="col">{t}</th>)}</tr></thead>
        <tbody>{employees?.map(e=>{
          const cannotDisable=e.id===actor.id || e.has_open_session || (e.active && e.role==="admin" && adminCount===1);
          return <tr key={e.id}>
            <td>{e.full_name}</td><td>{e.email ?? "ელფოსტა არ არის"}{e.has_orders && <p>Orders-ის საერთო ანგარიში</p>}</td>
            <td>{e.role==="admin"?"Admin":"მოლარე"}</td><td>{e.active?"აქტიური":"გათიშული"}{e.has_open_session && <p>სალარო გახსნილია</p>}</td>
            <td>{new Date(e.created_at).toLocaleString("ka-GE",{timeZone:"Asia/Tbilisi"})}</td>
            <td>
              <details><summary>პროფილი / როლი / სტატუსი</summary>
                <EmployeeForm action={updateEmployee} confirmation="შევინახოთ POS პროფილის, როლისა და სტატუსის ცვლილებები? Orders წევრობა უცვლელი დარჩება.">
                  <input type="hidden" name="id" value={e.id}/>
                  <label>სახელი<input name="name" defaultValue={e.full_name} required maxLength={200}/></label>
                  <label>როლი<select name="role" defaultValue={e.role}><option value="cashier" disabled={e.id===actor.id || (e.active && e.role==="admin" && adminCount===1)}>მოლარე</option><option value="admin">Admin</option></select></label>
                  {cannotDisable && e.active ? <><input type="hidden" name="active" value="yes"/><p>აქტიურია — გათიშვა დაუშვებელია საკუთარი ანგარიშის, ბოლო admin-ის ან ღია სალაროს შემთხვევაში.</p></> : <label className="check"><input type="checkbox" name="active" defaultChecked={e.active}/>აქტიური</label>}
                  <SubmitButton pendingText="ინახება…" className="button secondary">შენახვა</SubmitButton>
                </EmployeeForm>
              </details>
              <details><summary>დროებითი პაროლის დაყენება</summary>
                <EmployeeForm action={resetEmployeePassword} confirmation="შევცვალოთ საერთო Auth ანგარიშის პაროლი? ეს შეიძლება სხვა სისტემაში შესვლაზეც აისახოს.">
                  <input type="hidden" name="id" value={e.id}/>
                  <label>ახალი დროებითი პაროლი<input type="password" name="password" required minLength={12} maxLength={256} autoComplete="new-password"/></label>
                  {e.has_orders && <label className="check"><input name="shared_confirm" type="checkbox" required/>ვადასტურებ: ახალი პაროლი Orders-ში შესვლისთვისაც იქნება საჭირო.</label>}
                  <SubmitButton pendingText="იცვლება…" className="button secondary">პაროლის შეცვლა</SubmitButton>
                </EmployeeForm>
              </details>
            </td>
          </tr>;
        })}</tbody>
      </table></div></section>
    </>}
    <section className="panel"><h2>ბოლო 50 ცვლილება</h2>
      {auditError ? <p>ცვლილებების ისტორია ვერ ჩაიტვირთა.</p> : <div className="table-scroll"><table><thead><tr><th>დრო</th><th>ვინ</th><th>თანამშრომელი</th><th>მოქმედება</th></tr></thead><tbody>{audit?.map(a=><tr key={a.id}><td>{new Date(a.created_at).toLocaleString("ka-GE",{timeZone:"Asia/Tbilisi"})}</td><td>{name(a.actor_id)}</td><td>{name(a.target_id)}</td><td>{events[a.event] ?? a.event}</td></tr>)}</tbody></table></div>}
    </section>
  </>;
}
