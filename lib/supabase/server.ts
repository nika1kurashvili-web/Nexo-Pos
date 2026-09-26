import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cookieOptions, getSupabaseConfig, isPosCookie } from "./config";
import type { Database } from "./database.types";
import { authDiagnostic, type AuthDiagnosticContext } from "@/lib/auth/diagnostics";

export async function createClient(actionContext?: AuthDiagnosticContext) {
  const config = getSupabaseConfig();
  if (!config) return null;
  const cookieStore = await cookies();

  return createServerClient<Database>(config.url, config.anonKey, {
    cookieOptions,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (items) => {
        try {
          items.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          if (actionContext && items.length) authDiagnostic(actionContext, "cookies.write", "success");
        } catch (error) {
          if (actionContext) {
            authDiagnostic(actionContext, "cookies.write", "failed", error);
            // Cookie writes MUST succeed in actions. Only read-only renders may
            // defer them to middleware; otherwise an action hides a real failure.
            throw error;
          }
          // Server Components cannot write cookies. Middleware refreshes them.
        }
      },
    },
  });
}

// Call only from Server Actions, where cookie writes are supported.
export async function clearPosCookies() {
  const cookieStore = await cookies();
  cookieStore.getAll().filter(({ name }) => isPosCookie(name)).forEach(({ name }) => {
    cookieStore.set(name, "", { ...cookieOptions, maxAge: 0 });
  });
}
