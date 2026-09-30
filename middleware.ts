import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { cookieOptions, getSupabaseConfig, getSupabaseConfigHealth, isPosCookie } from "@/lib/supabase/config";
import type { Database } from "@/lib/supabase/database.types";
import { endPosSession, getPosAccess } from "@/lib/auth/access";
import { authDiagnostic, type AuthDiagnosticContext } from "@/lib/auth/diagnostics";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const isLogin = request.nextUrl.pathname === "/login";
  const context: AuthDiagnosticContext = { source: "middleware", attemptId: crypto.randomUUID() };
  if (isLogin && request.method === "POST") authDiagnostic(context, "login.request", "started");

  function finish(path?: string) {
    const result = path ? NextResponse.redirect(new URL(path, request.url), 303) : response;
    if (path) response.cookies.getAll().forEach((cookie) => result.cookies.set(cookie));
    result.headers.set("Cache-Control", "private, no-store, max-age=0");
    result.headers.set("Pragma", "no-cache");
    result.headers.set("Expires", "0");
    return result;
  }

  const config = getSupabaseConfig();
  if (!config) {
    console.error(`[nexo-pos-auth] ${JSON.stringify({ ...context, step: "configuration", ...getSupabaseConfigHealth() })}`);
    return finish(isLogin ? undefined : "/login?error=configuration");
  }

  let client;
  try {
    client = createServerClient<Database>(config.url, config.anonKey, {
      cookieOptions,
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (items) => {
          items.forEach(({ name, value }) => request.cookies.set(name, value));
          const previousCookies = response.cookies.getAll();
          response = NextResponse.next({ request });
          previousCookies.forEach((cookie) => response.cookies.set(cookie));
          items.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });
  } catch (error) {
    authDiagnostic(context, "client.create", "failed", error);
    console.error(`[nexo-pos-auth] ${JSON.stringify({ ...context, step: "configuration", ...getSupabaseConfigHealth() })}`);
    return finish(isLogin ? undefined : "/login?error=configuration");
  }

  const access = await getPosAccess(client, context);
  if (access.status === "allowed") {
    return finish(isLogin && request.method === "GET" ? "/" : undefined);
  }

  // Also handles sessions whose POS profile was removed or disabled after login.
  if (request.cookies.getAll().some(({ name }) => isPosCookie(name))) {
    await endPosSession(client, context);
    const names = new Set([
      ...request.cookies.getAll().map(({ name }) => name),
      ...response.cookies.getAll().map(({ name }) => name),
    ]);
    names.forEach((name) => {
      if (isPosCookie(name)) {
        request.cookies.delete(name);
        response.cookies.set(name, "", { ...cookieOptions, maxAge: 0 });
      }
    });
  }

  if (isLogin && access.status === "unauthenticated") return finish();
  if (isLogin) authDiagnostic(context, "login.result", access.status === "unavailable" ? "failed" : access.status);
  const destination = access.status === "unauthenticated" ? "/login" : `/login?error=${access.status}`;
  return finish(destination);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
