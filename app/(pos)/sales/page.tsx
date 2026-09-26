import { requirePosProfile } from "@/lib/auth/server";

export default async function SalesPage() {
  await requirePosProfile();
  return <><h1>გაყიდვები</h1><section className="panel"><p>გაყიდვების მოდული მზადდება</p></section></>;
}
