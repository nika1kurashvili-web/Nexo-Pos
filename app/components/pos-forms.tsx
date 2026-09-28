import type { Customer } from "@/lib/pos/types";
import { SubmitButton } from "./submit-button";

export function Notice({ error, saved, loadError }: { error?: string; saved?: string; loadError?: boolean }) {
  if (loadError) return <p className="notice error" role="alert">მონაცემები ვერ ჩაიტვირთა. გადაამოწმეთ Phase 1 მიგრაცია და წვდომა.</p>;
  if (error) return <p className="notice error" role="alert">{error === "conflict" ? "ჩანაწერი უკვე არსებობს ან სალარო უკვე გახსნილია." : error === "invalid" ? "შეამოწმეთ შეყვანილი მონაცემები." : "ოპერაცია ვერ შესრულდა. შეამოწმეთ მონაცემები, სესია და წვდომა."}</p>;
  return saved ? <p className="notice success" role="status">ცვლილება შენახულია.</p> : null;
}
export function SaveButton({ children = "შენახვა" }: { children?: React.ReactNode }) {
  return <SubmitButton className="button primary" pendingText="ინახება…">{children}</SubmitButton>;
}
export function CustomerFields({ customer }: { customer?: Customer }) {
  return <>
    {customer && <input type="hidden" name="id" value={customer.id} />}
    <label>კომპანიის სახელი<input name="name" defaultValue={customer?.name} required maxLength={200} /></label>
    <label>საიდენტიფიკაციო კოდი<input name="tax_code" defaultValue={customer?.tax_code ?? ""} maxLength={100} /></label>
    <label>ტელეფონი<input name="phone" type="tel" defaultValue={customer?.phone ?? ""} maxLength={100} /></label>
    <label>ელფოსტა<input name="email" type="email" defaultValue={customer?.email ?? ""} maxLength={254} /></label>
    <label>მისამართი<input name="address" defaultValue={customer?.address ?? ""} maxLength={1000} /></label>
    <label>შენიშვნა<textarea name="notes" defaultValue={customer?.notes ?? ""} maxLength={2000} /></label>
    <label className="check"><input name="active" type="checkbox" defaultChecked={customer?.active ?? true} />აქტიური</label>
  </>;
}
