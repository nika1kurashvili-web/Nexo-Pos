"use server";

import { redirect } from "next/navigation";
import { createClient, clearPosCookies } from "@/lib/supabase/server";
import { endPosSession, getPosAccess } from "@/lib/auth/access";
import { authDiagnostic, type AuthDiagnosticContext } from "@/lib/auth/diagnostics";
import { getSupabaseConfigHealth } from "@/lib/supabase/config";

export async function login(formData: FormData) {
  const context: AuthDiagnosticContext = { source: "login", attemptId: crypto.randomUUID() };
  console.info(`[nexo-pos-auth] ${JSON.stringify({ ...context, step: "configuration", ...getSupabaseConfigHealth() })}`);
  const email = formData.get("email");
  const password = formData.get("password");
  if (typeof email !== "string" || typeof password !== "string" ||
    !email.trim() || !password || email.length > 254 || password.length > 4096) {
    redirect("/login?error=required");
  }

  let client;
  try {
    client = await createClient(context);
  } catch (error) {
    authDiagnostic(context, "client.create", "failed", error);
    // Outside the catch: Next.js redirects throw a framework control-flow error.
  }
  if (!client) redirect("/login?error=configuration");
  let destination = "/";
  authDiagnostic(context, "signInWithPassword", "started");
  try {
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      authDiagnostic(context, "signInWithPassword", "failed", error);
      destination = error.status === 400 || error.status === 422
        ? "/login?error=credentials" : "/login?error=unavailable";
    } else {
      authDiagnostic(context, "signInWithPassword", "success");
      const access = await getPosAccess(client, context);
      if (access.status !== "allowed") {
        destination = `/login?error=${access.status === "unauthenticated" ? "denied" : access.status}`;
      }
    }
  } catch (error) {
    authDiagnostic(context, "signInWithPassword", "failed", error);
    destination = "/login?error=unavailable";
  }
  if (destination !== "/") {
    await endPosSession(client, context);
    await clearPosCookies();
  }
  authDiagnostic(context, "login.result", destination === "/" ? "success" : "denied");
  redirect(destination);
}

export async function logout() {
  const context: AuthDiagnosticContext = { source: "logout", attemptId: crypto.randomUUID() };
  const client = await createClient(context);
  if (client) await endPosSession(client, context);
  await clearPosCookies();
  redirect("/login");
}
