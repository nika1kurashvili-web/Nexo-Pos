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
  if (!url || !anonKey || url !== url.trim() || /\s/.test(anonKey)) return null;
  try {
    const parsed = new URL(url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") return null;
    // This checks public-key configuration, not user authorization. Membership
    // is always read from pos_profiles after Auth verifies the user.
    if (anonKey.startsWith("sb_secret_")) return null;
    if (anonKey.split(".").length === 3) {
      const payload = anonKey.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      if (JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))).role !== "anon") return null;
    } else if (!anonKey.startsWith("sb_publishable_") && !local) return null;
    return { url, anonKey };
  } catch {
    return null;
  }
}

// Diagnostics only: no values, hostnames, decoded JWTs, or key fragments escape.
// Do not silently rewrite production configuration while diagnosing a failure.
export function getSupabaseConfigHealth() {
  const config = getSupabaseConfig();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let urlShape = url ? "malformed" : "missing";
  if (url) {
    try {
      const parsed = new URL(url);
      urlShape = !["https:", "http:"].includes(parsed.protocol) ? "invalid_protocol" :
        parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/"
          ? "unexpected_url_components" : "valid";
    } catch { /* Report only the shape, never the input. */ }
  }
  return {
    configured: Boolean(config),
    urlShape,
    urlHasWhitespace: Boolean(url && url !== url.trim()),
    keyPresent: Boolean(key),
    keyHasWhitespace: Boolean(key && /\s/.test(key)),
    keyShape: !key ? "missing" : key.startsWith("sb_secret_") ? "secret_key_not_anon" :
      key.startsWith("sb_publishable_") ? "publishable" :
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key) ? "jwt" : "unrecognized",
  };
}

export function isPosCookie(name: string) {
  return name === POS_COOKIE_NAME || name.startsWith(`${POS_COOKIE_NAME}.`) ||
    name.startsWith(`${POS_COOKIE_NAME}-`);
}
