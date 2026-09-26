"use server";

import { redirect } from "next/navigation";
import { createClient, clearPosCookies } from "@/lib/supabase/server";
import { endPosSession, getPosAccess } from "@/lib/auth/access";

export async function login(formData: FormData) {
  const email = formData.get("email");
  const password = formData.get("password");
  if (typeof email !== "string" || typeof password !== "string" ||
    !email.trim() || !password || email.length > 254 || password.length > 4096) {
    redirect("/login?error=required");
  }

  const client = await createClient();
  if (!client) redirect("/login?error=configuration");
  let destination = "/";
  try {
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      destination = error.status === 400 || error.status === 422
        ? "/login?error=credentials" : "/login?error=unavailable";
    } else {
      const access = await getPosAccess(client);
      if (access.status !== "allowed") {
        destination = `/login?error=${access.status === "unauthenticated" ? "denied" : access.status}`;
      }
    }
  } catch {
    destination = "/login?error=unavailable";
  }
  if (destination !== "/") {
    await endPosSession(client);
    await clearPosCookies();
  }
  redirect(destination);
}

export async function logout() {
  const client = await createClient();
  if (client) await endPosSession(client);
  await clearPosCookies();
  redirect("/login");
}
