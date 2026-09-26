export const POS_COOKIE_NAME = "nexo-pos-auth";

export const cookieOptions = {
  name: POS_COOKIE_NAME,
  path: "/",
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  // No domain: POS cookies must not be shared with orders.nexo.ge.
};

export function getSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

export function isPosCookie(name: string) {
  return name === POS_COOKIE_NAME || name.startsWith(`${POS_COOKIE_NAME}.`) ||
    name.startsWith(`${POS_COOKIE_NAME}-`);
}
