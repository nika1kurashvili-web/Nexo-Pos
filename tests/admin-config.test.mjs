import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { adminConfigDiagnostics, employeeAdminFailure } from "../lib/supabase/admin-diagnostics.ts";

test("admin constructor diagnostics distinguish failures and never expose inputs", async () => {
  const source = await readFile(new URL("../lib/supabase/admin.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const secret = "PRIVATE_TEST_SERVICE", anon = "PRIVATE_TEST_ANON";
  for (const [key, valid, constructorThrows, step] of [
    [undefined, true, false, "service_key_missing"],
    [" \r\n ", true, false, "service_key_missing"],
    [`${secret} inside`, true, false, "service_key_whitespace"],
    [secret, false, false, "public_config"],
    [secret, true, true, "client_create"],
    [` \r\n${secret}\t `, true, false, null],
    [secret, true, false, null],
  ]) {
    const logs = []; let calls = 0;
    const env = { NEXT_PUBLIC_SUPABASE_URL: "https://private-test.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: key };
    const exports = {};
    vm.runInNewContext(compiled, {
      exports, process: { env },
      console: { error: (...args) => logs.push(args.join(" ")) },
      require(name) {
        if (name === "server-only") return {};
        if (name === "./admin-diagnostics") return { adminConfigDiagnostics };
        if (name === "./config") return { getSupabaseConfig: () => valid ? { url: env.NEXT_PUBLIC_SUPABASE_URL, anonKey: anon } : null };
        if (name === "@supabase/supabase-js") return { createClient(url, actualKey, options) {
          calls++;
          assert.equal(actualKey, secret);
          assert.equal(options.auth.persistSession, false);
          if (constructorThrows) throw new Error(`NEVER_LOG ${secret}`);
          return { mock: true };
        } };
        throw new Error("Unexpected import");
      },
    });
    if (step) {
      assert.throws(() => exports.createAuthAdminClient(), /EMPLOYEE_SERVER_CONFIGURATION/);
      assert.equal(logs.length, 1);
      const entry = JSON.parse(logs[0].slice("[nexo-pos-employee-admin] ".length));
      assert.equal(entry.step, step);
      assert.equal(entry.category, "configuration");
      for (const sensitive of [secret, anon, env.NEXT_PUBLIC_SUPABASE_URL, "NEVER_LOG"]) assert.ok(!logs[0].includes(sensitive));
      if (step !== "client_create") assert.equal(calls, 0);
    } else {
      assert.equal(exports.createAuthAdminClient().mock, true);
      assert.equal(logs.length, 0);
      assert.equal(calls, 1);
    }
  }
});

test("safe metadata and API categories contain only approved fields", () => {
  assert.deepEqual(adminConfigDiagnostics("bad-url", "private-anon", " key\n", false), {
    urlPresent: true, anonKeyPresent: true, serviceKeyPresent: true,
    serviceKeyTrimmedLength: 3, serviceKeyHasOuterWhitespace: true,
    serviceKeyHasInternalWhitespace: false, urlParses: false, publicConfigValid: false,
  });
  const logs = [], previous = console.error;
  try {
    console.error = (...args) => logs.push(args.join(" "));
    employeeAdminFailure("provisioning_version"); employeeAdminFailure("auth_create");
    assert.deepEqual(logs.map(line => JSON.parse(line.slice("[nexo-pos-employee-admin] ".length))), [
      { category: "provisioning_version", outcome: "failed" },
      { category: "auth_create", outcome: "failed" },
    ]);
  } finally { console.error = previous; }
});
