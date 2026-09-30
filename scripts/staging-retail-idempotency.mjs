// Manual nexo-staging-only idempotency test. Do not run automatically.
// Real cashier authentication; no service role, new request ID, cleanup or session close.
import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

const REFERENCE = "tclplmbnfnktpthcwqbq";
const REGISTER = "STAGING - FIRST RETAIL SMOKE";
const PRODUCT = "11111111-1111-4111-8111-111111111111";
let stage = "configuration";
const identifiers = {};

class SmokeFailure extends Error {
  constructor(message, upstream) {
    super(message); // Only fixed source-code messages are supplied.
    if (Number.isInteger(upstream?.status)) this.status = upstream.status;
    if (/^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(upstream?.code ?? "")) this.code = upstream.code;
  }
}
function check(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}
async function result(query, message) {
  const response = await query;
  if (response.error) throw new SmokeFailure(message, { ...response.error, status: response.status ?? response.error.status });
  return response.data;
}
async function prompt(label, hidden = false) {
  check(process.stdin.isTTY, "Use an interactive terminal; credentials must not be command arguments.");
  const output = new Writable({ write(chunk, encoding, done) {
    if (!hidden) process.stdout.write(chunk, encoding);
    done();
  } });
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  terminal.once("SIGINT", cancel);
  terminal.once("close", cancel);
  try {
    while (true) {
      if (terminal.closed || controller.signal.aborted) throw new Error("Prompt closed");
      if (hidden) process.stdout.write(label);
      let answer;
      try { answer = await terminal.question(hidden ? "" : label, { signal: controller.signal }); }
      finally { if (hidden) process.stdout.write("\n"); }
      if (answer.trim()) return answer; // Preserve password whitespace; trim only to detect blanks.
      process.stdout.write("A value is required. Please try again.\n");
    }
  } catch {
    throw new SmokeFailure("Input cancelled or terminal closed. No further test steps were run; existing records were preserved.");
  } finally {
    terminal.removeListener("SIGINT", cancel);
    terminal.removeListener("close", cancel);
    terminal.close();
    output.end();
  }
}
async function confirm(text) {
  check(await prompt(`Type ${text} to continue: `) === text, "Stopped at manual confirmation; existing test records were preserved.");
}
function cents(value) {
  const text = String(value);
  check(/^\d+(?:\.\d{1,2})?$/.test(text), "Unexpected money format.");
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
function money(row, fields, expected) {
  for (const field of fields) check(cents(row[field]) === expected, "Stored monetary totals or snapshots differ from expectations.");
}
function publicKeyOnly(key, reference) {
  if (key.startsWith("sb_publishable_")) return;
  let claims;
  try { claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")); }
  catch { throw new SmokeFailure("Supply a staging publishable key or legacy anon key, never a secret/service-role key."); }
  check(claims.role === "anon" && claims.ref === reference,
    "The key must be an anon key belonging to the confirmed staging reference.");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
async function snapshot(client) {
  const state = {};
  for (const table of ["pos_sales", "pos_sale_items", "pos_payments", "pos_register_sessions"]) {
    const response = await client.from(table).select("*", { count: "exact" }).order("id");
    if (response.error) throw new SmokeFailure("Financial snapshot read failed.", { code: response.error.code, status: response.status });
    check(Number.isSafeInteger(response.count) && response.count === response.data?.length, "Snapshot was incomplete or truncated; stop without issuing another RPC.");
    state[table] = { count: response.count, rows: response.data };
  }
  return state;
}
function verifyBaseline(state, profile) {
  for (const table of Object.keys(state)) check(state[table].count === 1, "Expected exactly the first smoke test's one visible sale, item, payment and session. Inspect existing records; do not reset them.");
  const sale = state.pos_sales.rows[0];
  const item = state.pos_sale_items.rows[0];
  const payment = state.pos_payments.rows[0];
  const session = state.pos_register_sessions.rows[0];
  check(sale.id === identifiers.sale_id && sale.session_id === identifiers.session_id && sale.request_id === identifiers.request_id && String(sale.sale_number) === "1", "Original sale/request/session/number mismatch.");
  check(sale.cashier_id === profile.id && sale.cashier_name === profile.full_name && sale.sale_type === "retail" && sale.status === "completed" && sale.customer_id === null, "Original retail ownership or state mismatch.");
  check(sale.tracking_code === identifiers.tracking_code && /^[0-9a-f]{64}$/.test(sale.request_fingerprint), "Original tracking code or fingerprint mismatch.");
  money(sale, ["subtotal", "total", "paid_total"], 1000n);
  money(sale, ["discount_total", "debt_amount"], 0n);
  check(item.sale_id === sale.id && item.line_number === 1 && item.target_kind === "product" && item.product_id === PRODUCT && item.variant_id === null && item.sku === "STG-SINGLE" && item.product_name === "STAGING standalone item" && Number(item.quantity) === 1, "Original sale item mismatch.");
  money(item, ["base_unit_price", "adjusted_unit_price", "final_unit_price", "line_total"], 1000n);
  money(item, ["discount_percent"], 0n);
  check(payment.sale_id === sale.id && payment.session_id === session.id && payment.received_by === profile.id && payment.kind === "sale_payment" && payment.method_code === "cash", "Original payment mismatch.");
  money(payment, ["amount"], 1000n);
  check(session.id === identifiers.session_id && session.register_id === identifiers.register_id && session.cashier_id === profile.id && session.status === "open" && session.closed_at === null && session.expected_closing_cash === null && session.actual_closing_cash === null && session.cash_difference === null, "The original register session must remain open.");
  money(session, ["opening_cash"], 10000n);
  check(cents(session.opening_cash) + cents(payment.amount) === 11000n, "Expected drawer total is 110.00.");
}
function unchanged(before, after, profile) {
  verifyBaseline(after, profile);
  check(JSON.stringify(canonical(before)) === JSON.stringify(canonical(after)), "Financial records/counts changed. Stop and inspect staging; no cleanup was attempted.");
}
function retryPayload(sale) {
  // Reconstruct the original request, not its calculated price snapshots:
  // omitted unit_price normalizes to NULL, whereas explicitly sending 10.00 does not.
  return {
    p_request: sale.request_id, p_session: sale.session_id, p_type: "retail", p_customer: null,
    p_tracking: `  ${sale.tracking_code}  `,
    p_items: [{ kind: "product", target: PRODUCT, quantity: "1", discount_percent: "0" }],
    p_payments: [{ method: "cash", amount: "10.00" }],
  };
}

async function main() {
  console.log(`STAGING ONLY: https://${REFERENCE}.supabase.co`);
  const reference = (await prompt("Copy the nexo-staging project reference from Dashboard: ")).trim();
  check(reference === REFERENCE, "Project reference differs from the confirmed nexo-staging project. No network request was made.");
  await confirm("nexo-staging");
  const key = (await prompt("Staging publishable/anon key (hidden; NOT service_role): ", true)).trim();
  publicKeyOnly(key, reference);
  const email = (await prompt("Existing POS-only cashier test email (hidden): ", true)).trim();
  const password = await prompt("Existing cashier password (hidden): ", true);
  const client = createClient(`https://${REFERENCE}.supabase.co`, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, options) => fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(30000) }) },
  });
  stage = "cashier_sign_in";
  const login = await result(client.auth.signInWithPassword({ email, password }), "Cashier sign-in failed.");
  check(login.session?.access_token && login.user?.id, "No authenticated cashier session was returned.");
  const verified = await result(client.auth.getUser(), "Authenticated user verification failed.");
  check(verified.user?.id === login.user.id && verified.user.role === "authenticated", "Unexpected authenticated user context.");
  identifiers.cashier_id = verified.user.id;
  const marker = verified.user.app_metadata?.nexo_memberships;
  check(marker?.version === 1 && marker.pos === "cashier" && !Object.hasOwn(marker, "orders"),
    "Use the existing explicitly POS-only cashier test account.");

  stage = "cashier_preflight";
  const profile = await result(client.from("pos_profiles").select("id,full_name,role,active").eq("id", identifiers.cashier_id).single(), "POS profile lookup failed.");
  check(profile.role === "cashier" && profile.active === true, "The POS cashier must be active.");
  // The verified staging Orders policy permits reading one's own profile if it exists.
  const orders = await result(client.from("profiles").select("id").eq("id", profile.id), "Orders membership isolation lookup failed.");
  check(orders.length === 0, "This account has an Orders profile; stop and use the POS-only cashier.");
  const register = await result(client.from("pos_registers").select("id,name,active").eq("name", REGISTER).single(), "Original staging register lookup failed.");
  check(register.active, "Original staging register is inactive.");
  identifiers.register_id = register.id;
  const sessions = await result(client.from("pos_register_sessions").select("id").eq("register_id", register.id).eq("cashier_id", profile.id).eq("status", "open"), "Original open session lookup failed.");
  check(sessions.length === 1, "Exactly one existing open cashier session is required. This test never opens a new session.");
  identifiers.session_id = sessions[0].id;
  const sales = await result(client.from("pos_sales").select("*").eq("session_id", identifiers.session_id), "Original retail sale lookup failed.");
  check(sales.length === 1, "Expected exactly the original successful sale in this session.");
  const sale = sales[0];
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sale.request_id) && sale.tracking_code === `STG-RETAIL-${sale.request_id}`, "The existing sale is not the identified first retail smoke request.");
  identifiers.sale_id = sale.id;
  identifiers.request_id = sale.request_id;
  identifiers.tracking_code = sale.tracking_code;
  stage = "baseline_snapshot";
  const before = await snapshot(client);
  verifyBaseline(before, profile);
  const payload = retryPayload(sale);
  console.log(JSON.stringify({ ...identifiers, sale_number: sale.sale_number, sale_count: 1, item_count: 1, payment_count: 1, total: "10.00", paid: "10.00", expected_drawer: "110.00" }, null, 2));

  stage = "exact_retry";
  await confirm("RETRY EXISTING STAGING SALE");
  const returned = await result(client.rpc("pos_complete_sale", payload), "Exact retry failed or outcome is uncertain. Stop and inspect the existing request; do not retry automatically.");
  const afterRetry = await snapshot(client);
  unchanged(before, afterRetry, profile);
  check(returned === sale.id, "Exact retry did not return the original sale UUID.");
  console.log("PASS exact retry: original sale returned; all visible financial rows, counts and totals unchanged.");

  stage = "changed_payload_conflict";
  await confirm("TEST SAME REQUEST WITH CHANGED TRACKING");
  // Change exactly one valid field while retaining the existing request_id.
  const conflict = await client.rpc("pos_complete_sale", { ...payload, p_tracking: sale.tracking_code + "-CONFLICT" });
  const afterConflict = await snapshot(client);
  unchanged(before, afterConflict, profile);
  if (conflict.error?.code !== "P0001" || conflict.error?.message !== "REQUEST_CONFLICT" || conflict.data !== null) {
    throw new SmokeFailure("Expected REQUEST_CONFLICT with SQLSTATE P0001; another failure or a success is not a pass.", { code: conflict.error?.code, status: conflict.status });
  }
  console.log("PASS changed payload: REQUEST_CONFLICT; all visible financial rows, counts and totals unchanged.");
  console.log(JSON.stringify({ result: "PASS", ...identifiers, sale_number: sale.sale_number, sale_count: 1, item_count: 1, payment_count: 1, session_count: 1, total: "10.00", paid: "10.00", expected_drawer: "110.00", session_status: "open" }, null, 2));
  console.log("STOP. Idempotency test complete. No session close, cleanup or later scenario was attempted.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ result: "STOP", stage, ...identifiers,
      message: error instanceof SmokeFailure ? error.message : "Unexpected failure; raw diagnostics withheld. Inspect staging before retrying.",
      ...(error instanceof SmokeFailure && error.code ? { code: error.code } : {}),
      ...(error instanceof SmokeFailure && error.status ? { status: error.status } : {}),
    }, null, 2));
    process.exitCode = 1;
  });
}
