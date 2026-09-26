import { requireAdmin } from "@/lib/auth/server";

export default async function ReportsPage() {
  await requireAdmin();
  return <><h1>რეპორტები</h1><section className="panel"><p>რეპორტების მოდული მზადდება</p></section></>;
}
