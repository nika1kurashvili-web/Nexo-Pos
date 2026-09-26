import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cookieOptions, getSupabaseConfig, isPosCookie } from "./config";
import type { Database } from "./database.types";

export async function createClient() {
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
        } catch {
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
