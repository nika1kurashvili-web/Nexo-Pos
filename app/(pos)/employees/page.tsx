import { requireAdmin } from "@/lib/auth/server";

export default async function EmployeesPage() {
  await requireAdmin();
  return <><h1>თანამშრომლები</h1><section className="panel"><p>თანამშრომლების მოდული მზადდება</p></section></>;
}
