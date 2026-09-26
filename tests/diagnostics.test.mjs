import assert from "node:assert/strict";
import { test } from "node:test";
import { safeAuthError } from "../lib/auth/diagnostics.ts";
import { getSupabaseConfigHealth } from "../lib/supabase/config.ts";

test("error diagnostics retain useful codes but discard raw error fields", () => {
  const secret = "sensitive-password-token-key";
  const result = safeAuthError({
    name: "TypeError", message: `fetch failed ${secret}`, code: "42501", status: 403,
    cause: { code: "ENOTFOUND", message: secret },
    details: secret, hint: secret, stack: secret, password: secret, access_token: secret,
  });
  assert.deepEqual(result, { category: "network_failure", name: "TypeError", code: "42501", causeCode: "ENOTFOUND", status: 403 });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(safeAuthError({ code: secret, name: secret, status: secret }), {
    category: "upstream_error", name: undefined, code: undefined, causeCode: undefined, status: undefined,
  });
});

test("cookie write failures have a safe identifiable category", () => {
  assert.equal(safeAuthError(new Error("Cookies can only be modified in a Server Action or Route Handler.")).category, "cookie_write_not_allowed");
});

test("environment diagnostics identify malformed URLs and key shape without values", () => {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  try {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_secret_DO_NOT_PRINT";
    for (const [url, expected] of [
      ["not-a-url", "malformed"],
      ["ftp://example.test", "invalid_protocol"],
      ["https://example.test/rest/v1", "unexpected_url_components"],
      ["https://user:password@example.test/?key=secret", "unexpected_url_components"],
      ["https://example.test", "valid"],
    ]) {
      process.env.NEXT_PUBLIC_SUPABASE_URL = url;
      const result = getSupabaseConfigHealth();
      assert.equal(result.urlShape, expected);
      assert.equal(result.keyShape, "secret_key_not_anon");
      assert.ok(!JSON.stringify(result).includes("DO_NOT_PRINT"));
      assert.ok(!JSON.stringify(result).includes(url));
    }
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    assert.equal(getSupabaseConfigHealth().configured, false);
  } finally {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey;
  }
});
