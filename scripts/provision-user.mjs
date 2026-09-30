// Trusted administrator CLI only. Never import this module into the web application.
import { createClient } from "@supabase/supabase-js";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

let stage = "configuration";
const failureDiagnostics = new WeakMap();
// Allowlist messages rather than attempting to scrub arbitrary server text,
// which can contain credentials, request bodies or embedded stack traces.
const safeMessages = new Set([
  "Choose orders, pos, or explicit dual access.", "Role supplied for an unrequested application.",
  "Invalid Orders role.", "Invalid POS role.",
  "Email, full name and a password of at least 12 characters are required.",
  "Run interactively in a trusted terminal; secrets are read without echo.",
  "Set NEXO_ADMIN_SUPABASE_URL to the intended https://PROJECT.supabase.co project URL.",
  "Invalid URL", "supabaseKey is required.", "Invalid API key", "Invalid JWT", "User not allowed",
  "Database error creating new user", "Database error saving new user", "User already registered",
  "fetch failed", "Failed to fetch",
]);
const safeCodes = new Set([
  "unexpected_failure", "validation_failed", "bad_json", "bad_jwt", "not_admin", "no_authorization",
  "email_exists", "user_already_exists", "email_address_invalid", "email_address_not_authorized",
  "weak_password", "over_request_rate_limit", "request_timeout", "hook_timeout", "hook_timeout_after_retry",
  "ERR_INVALID_URL", "ERR_PARSE_ARGS_UNKNOWN_OPTION", "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
  "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT",
]);
export function safeDiagnostic(error) {
  if (error instanceof Error && failureDiagnostics.has(error)) return { ...failureDiagnostics.get(error) };
  const result = { stage };
  const status = error?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) result.status = status;
  const code = error?.code;
  if (typeof code === "string" && (safeCodes.has(code) || /^(?:[0-9]{5}|[0-9]{2}[A-Z][0-9]{2}|P[0-9]{4}|PGRST[0-9]{3})$/.test(code))) result.code = code;
  result.message = safeMessages.has(error?.message) ? error.message : "Unrecognized error message withheld.";
  return result;
}
function failure(message, error, status) {
  const result = new Error(message);
  // Preserve only allowlisted diagnostics; never attach the SDK error as a cause.
  const diagnostic = safeDiagnostic(error ? { status: error.status ?? status, code: error.code, message: error.message } : { message });
  if (!error) diagnostic.message = message; // Fixed source-code message only.
  failureDiagnostics.set(result, diagnostic);
  return result;
}

export function membershipFor({ access, ordersRole, posRole }) {
  if (!["orders", "pos", "dual"].includes(access)) throw new Error("Choose orders, pos, or explicit dual access.");
  if (access === "pos" && ordersRole || access === "orders" && posRole) throw new Error("Role supplied for an unrequested application.");
  const marker = { version: 1 };
  if (access !== "pos") {
    marker.orders = ordersRole ?? "operator";
    if (!["admin", "operator", "manager"].includes(marker.orders)) throw new Error("Invalid Orders role.");
  }
  if (access !== "orders") {
    marker.pos = posRole ?? "cashier";
    if (!["admin", "cashier"].includes(marker.pos)) throw new Error("Invalid POS role.");
  }
  return marker;
}

export async function provisionUser(client, input) {
  stage = "input_validation";
  const marker = membershipFor(input);
  if (!input.email?.trim() || !input.fullName?.trim() || typeof input.password !== "string" || input.password.length < 12) {
    throw new Error("Email, full name and a password of at least 12 characters are required.");
  }
  stage = "version_check";
  const { data: version, error: preflightError, status: preflightStatus } = await client.rpc("nexo_provisioning_version");
  if (preflightError || version !== 1) throw failure("Provisioning prerequisite is unavailable. No user was created.", preflightError, preflightStatus);
  // No retry, upsert, metadata update or fallback to a matching existing email.
  stage = "auth_create";
  const { data, error } = await client.auth.admin.createUser({
    email: input.email.trim(), password: input.password, email_confirm: input.confirmEmail === true,
    app_metadata: { nexo_memberships: marker }, user_metadata: { full_name: input.fullName.trim() },
  });
  if (error || !data?.user?.id) throw failure("Auth creation failed or its outcome is uncertain. Inspect Auth Users before retrying; no automatic cleanup or existing-user changes were attempted.", error);
  // Supabase can set app_metadata after the auth.users INSERT trigger has run.
  stage = "membership_completion";
  const { data: finalized, error: finalizeError, status: finalizeStatus } = await client.rpc("nexo_finalize_user_memberships", { p_user: data.user.id });
  if (finalizeError || finalized !== true) throw failure("Auth account exists but membership completion failed. Inspect Auth Users and complete explicitly; do not recreate or delete the account.", finalizeError, finalizeStatus);
  return data.user.id;
}

async function secretPrompt(label) {
  if (!process.stdin.isTTY) throw new Error("Run interactively in a trusted terminal; secrets are read without echo.");
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(label);
  muted = true;
  try { return await terminal.question(""); }
  finally { terminal.close(); output.end(); process.stdout.write("\n"); }
}

async function main() {
  stage = "configuration";
  const { values } = parseArgs({ options: {
    access: { type: "string" }, email: { type: "string" }, name: { type: "string" },
    "orders-role": { type: "string" }, "pos-role": { type: "string" }, "confirm-email": { type: "boolean", default: false },
  } });
  const input = { access: values.access, ordersRole: values["orders-role"], posRole: values["pos-role"],
    email: values.email, fullName: values.name, confirmEmail: values["confirm-email"] };
  stage = "input_validation";
  membershipFor(input);
  stage = "configuration";
  const url = new URL(process.env.NEXO_ADMIN_SUPABASE_URL ?? "");
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Set NEXO_ADMIN_SUPABASE_URL to the intended https://PROJECT.supabase.co project URL.");
  }
  process.stdout.write(`Project: ${url.hostname}; requested access: ${input.access}.\n`);
  const key = await secretPrompt("Supabase secret/service-role key (hidden): ");
  const password = await secretPrompt("New account password (hidden): ");
  const client = createClient(url.origin, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const id = await provisionUser(client, { ...input, password });
  process.stdout.write(`Created Auth user ${id} with explicit ${input.access} membership.\n`);
  if (!input.confirmEmail) process.stdout.write("Email is not confirmed. Complete trusted verification/confirmation before password login.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // SDK/network errors can contain sensitive request context: never dump them.
    process.stderr.write(`${JSON.stringify(safeDiagnostic(error))}\n`);
    process.exitCode = 1;
  });
}
