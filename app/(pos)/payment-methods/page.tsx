import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { Notice, SaveButton } from "@/app/components/pos-forms";
import { savePaymentMethod } from "../actions";

export default async function PaymentMethodsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireAdmin();
  const client = await posClient();
  const { data, error } = await client.from("pos_payment_methods").select("*").order("created_at");
  return <><h1>გადახდის მეთოდები</h1><Notice {...await searchParams} loadError={Boolean(error)} />
    <section className="panel"><p>სალაროს ნაღდ ფულზე მოქმედებს მხოლოდ „ნაღდი“ გადახდა.</p>
      {data?.map((m) => <form action={savePaymentMethod} className="inline-form" key={m.code}>
        <input type="hidden" name="code" value={m.code} /><strong>{m.name}</strong>
        <label className="check"><input name="active" type="checkbox" defaultChecked={m.active} />აქტიური</label><SaveButton />
      </form>)}
    </section></>;
}
