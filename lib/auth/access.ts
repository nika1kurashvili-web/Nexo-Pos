import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, PosProfile } from "../supabase/database.types";
import { authDiagnostic, type AuthDiagnosticContext, type AuthStep } from "./diagnostics";

export const roleLabels = {
  admin: "ადმინისტრატორი",
  cashier: "მოლარე",
} as const;

export const authMessages = {
  credentials: "ელფოსტა ან პაროლი არასწორია.",
  required: "შეიყვანეთ ელფოსტა და პაროლი.",
  denied: "ამ მომხმარებელს POS სისტემაზე წვდომა არ აქვს.",
  inactive: "მომხმარებელი გათიშულია.",
  unavailable: "სისტემასთან დაკავშირება ვერ მოხერხდა. სცადეთ მოგვიანებით.",
  configuration: "სისტემა ჯერ არ არის გამართული. დაუკავშირდით ადმინისტრატორს.",
} as const;

export type AccessResult =
  | { status: "allowed"; profile: PosProfile }
  | { status: "unauthenticated" | "denied" | "inactive" | "unavailable" };

export async function getPosAccess(client: SupabaseClient<Database>, context: AuthDiagnosticContext): Promise<AccessResult> {
  let step: AuthStep = "getUser";
  try {
    // Verify identity with Supabase Auth; never trust the user stored in a cookie.
    const { data: { user }, error: authError } = await client.auth.getUser();
    if (authError || !user) {
      // A missing session is normal on a first visit to /login, not an outage.
      if (authError && authError.name !== "AuthSessionMissingError") {
        authDiagnostic(context, step, "failed", authError);
      } else if (context.source === "login") {
        authDiagnostic(context, step, "unauthenticated");
      }
      return { status: "unauthenticated" };
    }
    if (context.source === "login") authDiagnostic(context, step, "success");

    step = "pos_profiles.select";
    const { data: profile, error, status } = await client.from("pos_profiles")
      .select("id,full_name,role,active,created_at,updated_at")
      .eq("id", user.id)
      .maybeSingle();

    if (error) {
      authDiagnostic(context, step, "failed", error, status);
      return { status: "unavailable" };
    }
    if (context.source === "login") authDiagnostic(context, step, "success");
    if (!profile || profile.id !== user.id) return { status: "denied" };
    if (profile.active === false) return { status: "inactive" };
    if (profile.active !== true || !["admin", "cashier"].includes(profile.role)) {
      return { status: "denied" };
    }
    return { status: "allowed", profile };
  } catch (error) {
    authDiagnostic(context, step, "failed", error);
    return { status: "unavailable" };
  }
}

export async function endPosSession(client: SupabaseClient<Database>, context: AuthDiagnosticContext) {
  try {
    // Global sign-out could invalidate the separate order-management session.
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) authDiagnostic(context, "signOut", "failed", error);
  } catch (error) {
    authDiagnostic(context, "signOut", "failed", error);
    // Callers also clear local POS cookies, even when Supabase is unreachable.
  }
}
