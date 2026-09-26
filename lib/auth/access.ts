import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, PosProfile } from "../supabase/database.types";

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

export async function getPosAccess(client: SupabaseClient<Database>): Promise<AccessResult> {
  try {
    // Verify identity with Supabase Auth; never trust the user stored in a cookie.
    const { data: { user }, error: authError } = await client.auth.getUser();
    if (authError || !user) return { status: "unauthenticated" };

    const { data: profile, error } = await client.from("pos_profiles")
      .select("id,full_name,role,active,created_at,updated_at")
      .eq("id", user.id)
      .maybeSingle();

    if (error) return { status: "unavailable" };
    if (!profile || profile.id !== user.id) return { status: "denied" };
    if (profile.active === false) return { status: "inactive" };
    if (profile.active !== true || !["admin", "cashier"].includes(profile.role)) {
      return { status: "denied" };
    }
    return { status: "allowed", profile };
  } catch {
    return { status: "unavailable" };
  }
}

export async function endPosSession(client: SupabaseClient<Database>) {
  try {
    // Global sign-out could invalidate the separate order-management session.
    await client.auth.signOut({ scope: "local" });
  } catch {
    // Callers also clear local POS cookies, even when Supabase is unreachable.
  }
}
