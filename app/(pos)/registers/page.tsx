import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { Notice, SaveButton } from "@/app/components/pos-forms";
import { saveRegister } from "../actions";

export default async function RegistersPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireAdmin();
  const client = await posClient();
  const { data, error } = await client.from("pos_registers").select("*").order("name").limit(200);
  return <><h1>სალაროების მართვა</h1><Notice {...await searchParams} loadError={Boolean(error)} />
    <section className="panel"><h2>სალაროები</h2>
      {data?.map((r) => <form className="inline-form" action={saveRegister} key={r.id}>
        <input type="hidden" name="id" value={r.id} /><label>სახელი<input name="name" defaultValue={r.name} required maxLength={100} /></label>
        <label className="check"><input type="checkbox" name="active" defaultChecked={r.active} />აქტიური</label><SaveButton />
      </form>)}{!error && !data?.length && <p>ჯერ დაამატეთ სალარო.</p>}
      <p>გამორთვა კრძალავს ახალი სესიის გახსნას. უკვე გახსნილი სესია უნდა დაიხუროს.</p>
    </section>
    <section className="panel"><h2>ახალი სალარო</h2><form className="data-form" action={saveRegister}>
      <label>სახელი<input name="name" required maxLength={100} /></label>
      <label className="check"><input type="checkbox" name="active" defaultChecked />აქტიური</label><SaveButton>დამატება</SaveButton>
    </form></section></>;
}
