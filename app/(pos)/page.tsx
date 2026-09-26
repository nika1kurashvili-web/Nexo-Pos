import { requirePosProfile } from "@/lib/auth/server";

export default async function CashRegisterPage() {
  await requirePosProfile();
  return <><h1>სალარო</h1><section className="panel"><p>სალაროს მოდული მზადდება</p></section></>;
}
