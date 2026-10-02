import { requireAdmin } from "@/lib/auth/server";
import Link from "next/link";

export default async function ReportsPage() {
  await requireAdmin();
  return <><h1>რეპორტები</h1><section className="panel"><h2>სალაროს სესიები</h2><p>ღია და დახურული სესიები, ნაღდი თანხები და სხვაობები.</p><Link href="/reports/register-sessions" className="button primary">სალაროს სესიები</Link></section><section className="panel"><h2>თანხის გაცემის ისტორია</h2><p>ნაღდი თანხის გაცემები ფილტრებით: თარიღი, სალარო, მოლარე და მიზეზი.</p><Link href="/reports/cash-withdrawals" className="button primary">გაცემების ისტორია</Link></section></>;
}
