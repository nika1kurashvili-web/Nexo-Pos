"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/server";
import { rpcClient } from "@/lib/pos/server";
import { safeAuthError } from "@/lib/auth/diagnostics";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ადმინი სრულად შლის გაყიდვას (გადახდებს, მარაგის მოძრაობას, დაბრუნებებს, დავალიანების ჩანაწერებს).
// დასადასტურებლად უნდა ჩაიწეროს გაყიდვის ნომერი.
export async function deleteSale(form: FormData) {
  await requireAdmin();
  const id = String(form.get("id") ?? "").trim();
  if (!uuidRe.test(id)) redirect("/sales?error=invalid");

  const client = await rpcClient();
  const { data: sale } = await client.from("pos_sales").select("sale_number").eq("id", id).maybeSingle();
  if (!sale) redirect("/sales?error=failed");

  const typed = String(form.get("confirm") ?? "").trim().replace(/^#/, "");
  if (typed !== String(sale.sale_number)) redirect(`/sales/${id}?error=confirm`);

  const { error } = await client.rpc("pos_delete_sale", { p_sale: id });
  if (error) {
    console.error("[nexo-pos-sale-delete]", safeAuthError(error));
    redirect(`/sales/${id}?error=delete`);
  }

  revalidatePath("/", "layout");
  revalidatePath("/sales");
  redirect("/sales?saved=1");
}
