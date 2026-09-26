"use client";

import { createBrowserClient } from "@supabase/ssr";
import { cookieOptions, getSupabaseConfig } from "./config";
import type { Database } from "./database.types";

export function createClient() {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Supabase public environment variables are missing.");
  return createBrowserClient<Database>(config.url, config.anonKey, { cookieOptions });
}
