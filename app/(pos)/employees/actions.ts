"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { createAuthAdminClient } from "@/lib/supabase/admin";
import { employeeAdminFailure } from "@/lib/supabase/admin-diagnostics";

const messages = new Set(["SELF_DISABLE_FORBIDDEN", "SELF_DEMOTION_FORBIDDEN", "LAST_ADMIN", "EMPLOYEE_OPEN_SESSION", "MEMBERSHIP_METADATA_INVALID", "SHARED_PASSWORD_CONFIRM_REQUIRED", "INVALID_EMPLOYEE", "POS_ACCESS_DENIED"]);
function fail(error?: { message?: string } | null): never {
  redirect(`/employees?error=${error?.message && messages.has(error.message) ? error.message : "failed"}`);
}
const field = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function done(): never { revalidatePath("/", "layout"); redirect("/employees?saved=1"); }

export async function addEmployee(form: FormData) {
  await requireAdmin();
  if (field(form, "confirmed") !== "yes") fail({ message: "INVALID_EMPLOYEE" });
  const name = field(form,"name"), email = field(form,"email"), role = field(form,"role");
  if (!name || name.length > 200 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["admin","cashier"].includes(role)) fail({ message: "INVALID_EMPLOYEE" });
  const client = await posClient();
  const lookup = await client.rpc("pos_employee_lookup", { p_email: email });
  if (lookup.error) fail(lookup.error);
  let id = lookup.data?.id;
  if (lookup.data && field(form,"existing_confirm") !== "yes") redirect("/employees?error=existing_confirm");
  if (!id) {
    const password = form.get("password");
    if (typeof password !== "string" || password.length < 12 || password.length > 256) redirect("/employees?error=password");
    // Fail closed BEFORE Auth creation if the explicit-membership prerequisite
    // or server secret is absent. No fallback to legacy provisioning.
    let admin;
    try { admin = createAuthAdminClient(); } catch { redirect("/employees?error=configuration"); }
    let version;
    try { version = await admin.rpc("nexo_provisioning_version", {}); }
    catch { employeeAdminFailure("provisioning_version"); redirect("/employees?error=prerequisite"); }
    if (version.error || version.data !== 1) {
      employeeAdminFailure("provisioning_version");
      redirect("/employees?error=prerequisite");
    }
    let created;
    try {
      created = await admin.auth.admin.createUser({ email, password, email_confirm: true,
        user_metadata: { full_name: name }, app_metadata: {} });
    } catch { employeeAdminFailure("auth_create"); redirect("/employees?error=creation_unknown"); }
    // Do not retry/fall through after email races or uncertain external results.
    if (created.error || !created.data.user) {
      employeeAdminFailure("auth_create");
      redirect("/employees?error=creation_unknown");
    }
    id = created.data.user.id;
  }
  const saved = await client.rpc("pos_employee_save", { p_user: id, p_name: name, p_role: role, p_active: true });
  if (saved.error) fail(saved.error);
  done();
}

export async function updateEmployee(form: FormData) {
  await requireAdmin();
  const id=field(form,"id"), name=field(form,"name"), role=field(form,"role");
  if (field(form,"confirmed") !== "yes" || !uuid(id) || !name || name.length > 200 || !["admin","cashier"].includes(role)) fail({message:"INVALID_EMPLOYEE"});
  const client = await posClient();
  const saved = await client.rpc("pos_employee_save", { p_user:id,p_name:name,p_role:role,p_active:form.has("active") });
  if (saved.error) fail(saved.error);
  done();
}

export async function resetEmployeePassword(form: FormData) {
  await requireAdmin();
  const id=field(form,"id"), password=form.get("password");
  if (field(form,"confirmed") !== "yes" || !uuid(id) || typeof password !== "string" || password.length<12 || password.length>256) redirect("/employees?error=password");
  const client=await posClient();
  let admin;
  try { admin=createAuthAdminClient(); } catch { redirect("/employees?error=configuration"); }
  const authorized=await client.rpc("pos_employee_password_request", { p_user:id,p_shared_confirm:form.has("shared_confirm") });
  if (authorized.error || !authorized.data) fail(authorized.error);
  let success=false;
  try { const result=await admin.auth.admin.updateUserById(id,{password}); success=!result.error; }
  catch { /* Outcome is unknown. Never log the SDK object or retry a password. */ }
  const audit=await admin.rpc("pos_employee_password_result", {p_request:authorized.data,p_success:success});
  if (!success || audit.error || !audit.data) redirect("/employees?error=password_unknown");
  done();
}
