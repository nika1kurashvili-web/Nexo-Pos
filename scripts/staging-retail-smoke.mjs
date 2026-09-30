// Manual staging-only runtime test. NEVER import into the application.
// No environment/.env credentials, service-role client, retries or cleanup.
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

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

async function main() {
  const reference = (await prompt("Project reference copied from nexo-staging Dashboard Settings: ")).trim();
  check(/^[a-z0-9-]+$/.test(reference), "Invalid staging project reference.");
  const entered = (await prompt("Full nexo-staging project URL: ")).trim();
  check(entered === `https://${reference}.supabase.co` || entered === `https://${reference}.supabase.co/`,
    "URL does not exactly match the staging reference.");
  console.log(`Target: https://${reference}.supabase.co`);
  await confirm("nexo-staging");
  const key = (await prompt("Staging publishable/anon key (hidden; NOT service_role): ", true)).trim();
  publicKeyOnly(key, reference);
  const email = (await prompt("Existing POS-only cashier test email (hidden): ", true)).trim();
  const password = await prompt("Existing cashier password (hidden): ", true);
  const client = createClient(`https://${reference}.supabase.co`, key, {
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
  const register = await result(client.from("pos_registers").select("id,name,active").eq("name", REGISTER).single(), "Create the named staging register with the manual setup file first.");
  check(register.active, "The staging register must be active.");
  identifiers.register_id = register.id;
  const open = await result(client.from("pos_register_sessions").select("id").eq("cashier_id", profile.id).eq("status", "open"), "Open-session lookup failed.");
  check(open.length === 0, "Cashier already has an open session. Inspect it; do not rerun or reset.");
  const product = await result(client.from("products").select("id,name,sku,price,active").eq("sku", "STG-SINGLE").single(), "STG-SINGLE lookup failed.");
  check(product.id === PRODUCT && product.name === "STAGING standalone item" && product.active && cents(product.price) === 1000n,
    "The standalone staging seed does not match the bootstrap; inspect before testing.");
  const method = await result(client.from("pos_payment_methods").select("code,name,active").eq("code", "cash").single(), "Cash payment method lookup failed.");
  check(method.active, "Cash must be active.");

  stage = "open_register";
  console.log(`Ready: ${REGISTER}; opening cash 100.00; one STG-SINGLE at 10.00.`);
  await confirm("OPEN STAGING REGISTER");
  identifiers.session_id = await result(client.rpc("pos_open_register", { p_register: register.id, p_cash: "100.00" }), "Open-register RPC failed or outcome is uncertain. Inspect staging before retrying.");
  console.log(JSON.stringify({ session_id: identifiers.session_id }));
  const session = await result(client.from("pos_register_sessions").select("*").eq("id", identifiers.session_id).single(), "Session verification failed.");
  check(session.register_id === register.id && session.cashier_id === profile.id && session.status === "open" && session.opened_at && session.closed_at === null,
    "The opened session has unexpected ownership or state.");
  money(session, ["opening_cash"], 10000n);

  stage = "complete_retail_sale";
  identifiers.request_id = randomUUID();
  identifiers.tracking_code = `STG-RETAIL-${identifiers.request_id}`;
  console.log(JSON.stringify({ request_id: identifiers.request_id, tracking_code: identifiers.tracking_code }));
  await confirm("CREATE ONE STAGING RETAIL SALE");
  identifiers.sale_id = await result(client.rpc("pos_complete_sale", {
    p_request: identifiers.request_id, p_session: session.id, p_type: "retail", p_customer: null,
    p_tracking: `  ${identifiers.tracking_code}  `,
    p_items: [{ kind: "product", target: product.id, quantity: "1", discount_percent: "0" }],
    p_payments: [{ method: "cash", amount: "10.00" }],
  }), "Sale RPC failed or outcome is uncertain. Inspect the printed request ID before any retry.");
  console.log(JSON.stringify({ sale_id: identifiers.sale_id }));

  stage = "verify_retail_sale";
  const sale = await result(client.from("pos_sales").select("*").eq("id", identifiers.sale_id).single(), "Sale readback failed.");
  check(sale.request_id === identifiers.request_id && sale.session_id === session.id && sale.cashier_id === profile.id && sale.cashier_name === profile.full_name,
    "Sale ownership, request or cashier snapshot mismatch.");
  check(sale.sale_type === "retail" && sale.status === "completed" && sale.customer_id === null && sale.customer_name === null && sale.customer_tax_code === null,
    "Unexpected retail sale/customer state.");
  check(sale.tracking_code === identifiers.tracking_code, "Tracking code was not stored with surrounding whitespace trimmed.");
  check(/^[1-9][0-9]*$/.test(String(sale.sale_number)) && (typeof sale.sale_number !== "number" || Number.isSafeInteger(sale.sale_number)), "Invalid generated sale number.");
  check(/^[0-9a-f]{64}$/.test(sale.request_fingerprint) && sale.created_at, "Missing request fingerprint or timestamp.");
  money(sale, ["subtotal", "total", "paid_total"], 1000n);
  money(sale, ["discount_total", "debt_amount"], 0n);
  const items = await result(client.from("pos_sale_items").select("*").eq("sale_id", sale.id), "Sale item readback failed.");
  check(items.length === 1, "Expected exactly one sale item.");
  const item = items[0];
  check(item.line_number === 1 && item.target_kind === "product" && item.product_id === product.id && item.variant_id === null && item.sku === product.sku && item.product_name === product.name && item.variant_name === null && Number(item.quantity) === 1,
    "Sale item identity, quantity or catalog snapshot mismatch.");
  money(item, ["base_unit_price", "adjusted_unit_price", "final_unit_price", "line_total"], 1000n);
  money(item, ["discount_percent"], 0n);
  const payments = await result(client.from("pos_payments").select("*").eq("sale_id", sale.id), "Payment readback failed.");
  check(payments.length === 1, "Expected exactly one payment.");
  const payment = payments[0];
  check(payment.session_id === session.id && payment.received_by === profile.id && payment.method_code === "cash" && payment.method_name === method.name && payment.kind === "sale_payment" && payment.request_fingerprint === null,
    "Payment ownership, method snapshot or type mismatch.");
  money(payment, ["amount"], 1000n);
  const after = await result(client.from("pos_register_sessions").select("*").eq("id", session.id).single(), "Session readback failed.");
  check(after.status === "open" && after.closed_at === null && after.expected_closing_cash === null && after.actual_closing_cash === null && after.cash_difference === null,
    "This test must leave the register session open and unclosed.");
  money(after, ["opening_cash"], 10000n);
  const drawer = await result(client.from("pos_payments").select("amount").eq("session_id", session.id).eq("method_code", "cash"), "Drawer readback failed.");
  check(drawer.length === 1 && drawer.reduce((sum, row) => sum + cents(row.amount), cents(after.opening_cash)) === 11000n, "Expected derived cash drawer total 110.00.");

  stage = "direct_financial_write_denials";
  // INSERT: id=NULL cannot persist because all five tables have a primary key.
  // UPDATE/DELETE: id IS NULL cannot match any primary-key row, even if grants drift.
  // Only SQLSTATE 42501 counts as denial; constraint errors and zero-row success FAIL.
  for (const table of ["pos_register_sessions", "pos_sales", "pos_sale_items", "pos_payments", "pos_customer_transactions"]) {
    for (const operation of ["insert", "update", "delete"]) {
      stage = `direct_write_${table}_${operation}`;
      const query = operation === "insert" ? client.from(table).insert({ id: null })
        : operation === "update" ? client.from(table).update({ id: null }).is("id", null)
          : client.from(table).delete().is("id", null);
      const response = await query;
      if (response.error?.code !== "42501" || response.status !== 403) {
        throw new SmokeFailure("A direct financial write probe did not receive the required permission denial; stop and inspect privileges.",
          { code: response.error?.code, status: response.status });
      }
      console.log(`PASS denied: ${table} ${operation.toUpperCase()}`);
    }
  }
  console.log(JSON.stringify({ result: "PASS", ...identifiers, sale_number: sale.sale_number, total: "10.00", paid: "10.00", expected_drawer: "110.00", session_status: "open" }, null, 2));
  console.log("STOP. First retail smoke test finished. Session and test records remain intact. Do not rerun, close, delete or proceed to other scenarios yet.");
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
