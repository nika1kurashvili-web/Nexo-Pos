import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getPosAccess } from "./access";

// React cache deduplicates only within this server render, not across requests.
export const requirePosProfile = cache(async () => {
  const client = await createClient();
  if (!client) redirect("/login?error=configuration");
  const access = await getPosAccess(client, { source: "guard", attemptId: crypto.randomUUID() });
  if (access.status !== "allowed") {
    redirect(access.status === "unauthenticated" ? "/login" : `/login?error=${access.status}`);
  }
  return access.profile;
});

export async function requireAdmin() {
  const profile = await requirePosProfile();
  if (profile.role !== "admin") redirect("/");
  return profile;
}
