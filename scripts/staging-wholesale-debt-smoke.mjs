// Manual nexo-staging-only wholesale/debt test. Do not run automatically.
// Two real Auth sessions: admin setup/ledger reads, cashier sales/repayments. No service role.
import { randomUUID } from "node:crypto";
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

const CUSTOMER_NAME = "STAGING - WHOLESALE DEBT SMOKE";
const VARIANT = "33333333-3333-4333-8333-333333333333";
function same(a, b, message) {
  check(JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)), message);
}
async function rows(query) {
  const response = await query;
  if (response.error) throw new SmokeFailure("Verification query failed.", { code: response.error.code, status: response.status });
  check(Number.isSafeInteger(response.count) && response.count === response.data?.length, "Incomplete/truncated readback; stop and inspect staging.");
  return response.data;
}
async function login(key, role) {
  stage = `${role}_sign_in`;
  const email = (await prompt(`Existing staging POS ${role} email (hidden): `, true)).trim();
  const password = await prompt(`Existing staging POS ${role} password (hidden): `, true);
  const client = createClient(`https://${REFERENCE}.supabase.co`, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, options) => fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(30000) }) },
  });
  const signed = await result(client.auth.signInWithPassword({ email, password }), "Staging sign-in failed.");
  const verified = await result(client.auth.getUser(), "Auth user verification failed.");
  check(signed.session?.access_token && verified.user?.id === signed.user?.id && verified.user.role === "authenticated", "Expected a real authenticated user session.");
  const profile = await result(client.from("pos_profiles").select("id,role,active,full_name").eq("id", verified.user.id).single(), "POS membership lookup failed.");
  check(profile.active && profile.role === role, "The account does not have the required active POS role. Stop before setup.");
  if (role === "cashier") {
    const marker = verified.user.app_metadata?.nexo_memberships;
    check(marker?.version === 1 && marker.pos === "cashier" && !Object.hasOwn(marker, "orders"), "Use the original POS-only cashier.");
    const orders = await result(client.from("profiles").select("id").eq("id", profile.id), "Orders isolation lookup failed.");
    check(orders.length === 0, "The cashier must have no own Orders profile.");
  }
  return { client, profile };
}
async function snapshot(cashier, admin) {
  const state = {};
  for (const table of ["pos_sales", "pos_sale_items", "pos_payments", "pos_register_sessions"]) {
    state[table] = await rows(cashier.from(table).select("*", { count: "exact" }).order("id"));
  }
  state.ledger = await rows(admin.from("pos_customer_transactions").select("*", { count: "exact" }).eq("customer_id", identifiers.customer_id).order("id"));
  return state;
}
function balanceCents(ledger) {
  return ledger.reduce((sum, row) => sum + (String(row.amount).startsWith("-") ? -cents(String(row.amount).slice(1)) : cents(row.amount)), 0n);
}
function drawerCents(state) {
  return state.pos_payments.filter(p => p.session_id === identifiers.session_id && p.method_code === "cash")
    .reduce((sum, p) => sum + cents(p.amount), cents(state.pos_register_sessions[0].opening_cash));
}
function retailPreserved(before, after) {
  for (const table of ["pos_sales", "pos_sale_items", "pos_payments", "pos_register_sessions", "ledger"]) {
    for (const original of before[table]) same(original, after[table].find(row => row.id === original.id), "Previously stored financial/session records changed; stop, no cleanup attempted.");
  }
  check(after.pos_register_sessions.length === 1 && after.pos_register_sessions[0].status === "open", "Original session must remain open.");
}
function verifyWholesale(state, baseline, customer, cashierProfile, methods, step) {
  // step 0: initial partial sale; step 1: TBC repayment; step 2: final cash repayment.
  retailPreserved(baseline, state);
  check(state.pos_sales.length === 2 && state.pos_sale_items.length === 2 && state.pos_payments.length === 2 + step && state.ledger.length === 2 + step, "Unexpected financial row counts.");
  const sale = state.pos_sales.find(r => r.id === identifiers.wholesale_sale_id);
  check(sale && sale.request_id === identifiers.sale_request_id && sale.session_id === identifiers.session_id && sale.cashier_id === cashierProfile.id && sale.cashier_name === cashierProfile.full_name,
    "Wholesale sale ownership/request snapshot mismatch.");
  check(sale.sale_type === "wholesale" && sale.status === "completed" && sale.customer_id === customer.id && sale.customer_name === customer.name && sale.customer_tax_code === customer.tax_code && sale.tracking_code === identifiers.tracking_code,
    "Wholesale customer/tracking snapshot mismatch.");
  check(/^[0-9a-f]{64}$/.test(sale.request_fingerprint) && Number.isSafeInteger(Number(sale.sale_number)) && Number(sale.sale_number) > 1, "Invalid wholesale sale number/fingerprint.");
  money(sale, ["subtotal", "total"], 1500n);
  money(sale, ["discount_total"], 0n);
  money(sale, ["paid_total"], 500n);
  money(sale, ["debt_amount"], 1000n); // Immutable completion snapshots, NOT current debt.
  const items = state.pos_sale_items.filter(r => r.sale_id === sale.id);
  check(items.length === 1, "Expected one wholesale line.");
  const item = items[0];
  check(item.line_number === 1 && item.product_id === PRODUCT && item.variant_id === null && item.target_kind === "product" && item.sku === "STG-SINGLE" && item.product_name === "STAGING standalone item" && item.variant_name === null && Number(item.quantity) === 2,
    "Wholesale catalog/quantity snapshot mismatch.");
  money(item, ["base_unit_price", "adjusted_unit_price", "final_unit_price"], 750n);
  money(item, ["discount_percent"], 0n);
  money(item, ["line_total"], 1500n);
  const payments = state.pos_payments.filter(p => p.sale_id === sale.id);
  check(payments.length === 1 + step, "Unexpected wholesale payments.");
  const initial = payments.filter(p => p.kind === "sale_payment");
  check(initial.length === 1 && initial[0].method_code === "cash" && initial[0].request_fingerprint === null, "Invalid initial partial payment.");
  money(initial[0], ["amount"], 500n);
  const charges = state.ledger.filter(r => r.kind === "sale_charge");
  check(charges.length === 1 && charges[0].payment_id === null && cents(charges[0].amount) === 1500n, "Expected one 15.00 ledger charge.");
  for (const row of state.ledger) check(row.customer_id === customer.id && row.sale_id === sale.id, "Unexpected ledger ownership.");
  for (const payment of payments) {
    check(payment.session_id === identifiers.session_id && payment.received_by === cashierProfile.id && payment.method_name === methods[payment.method_code], "Payment method/cashier snapshot mismatch.");
    const entries = state.ledger.filter(r => r.payment_id === payment.id);
    check(entries.length === 1 && entries[0].kind === payment.kind && balanceCents(entries) === -cents(payment.amount), "Each payment must have exactly one matching ledger credit.");
  }
  if (step >= 1) {
    const p = payments.find(r => r.id === identifiers.tbc_payment_id);
    check(p && p.kind === "repayment" && p.method_code === "tbc" && p.request_id === identifiers.tbc_request_id && /^[0-9a-f]{64}$/.test(p.request_fingerprint), "TBC repayment identity mismatch.");
    money(p, ["amount"], 400n);
  }
  if (step === 2) {
    const p = payments.find(r => r.id === identifiers.cash_payment_id);
    check(p && p.kind === "repayment" && p.method_code === "cash" && p.request_id === identifiers.cash_request_id && /^[0-9a-f]{64}$/.test(p.request_fingerprint), "Cash repayment identity mismatch.");
    money(p, ["amount"], 600n);
  }
  check(balanceCents(state.ledger) === [1000n, 600n, 0n][step], "Incorrect current customer debt.");
  check(drawerCents(state) === [11500n, 11500n, 12100n][step], "Incorrect cash drawer effect.");
  check(state.pos_sales.reduce((sum, r) => sum + cents(r.total), 0n) === 2500n, "Combined sale total changed.");
  check(state.pos_payments.reduce((sum, r) => sum + cents(r.amount), 0n) === [1500n, 1900n, 2500n][step], "Combined payment total incorrect.");
}
async function verifyBalance(admin, expected) {
  const value = await result(admin.rpc("pos_customer_balance", { p_customer: identifiers.customer_id }), "Admin balance inspection failed.");
  check(cents(value) === expected, "Balance RPC and expected ledger balance disagree.");
}
async function deniedWrites(cashier) {
  for (const table of ["pos_register_sessions", "pos_sales", "pos_sale_items", "pos_payments", "pos_customer_transactions"]) {
    for (const operation of ["insert", "update", "delete"]) {
      stage = `deny_${table}_${operation}`;
      const query = operation === "insert" ? cashier.from(table).insert({ id: null })
        : operation === "update" ? cashier.from(table).update({ id: null }).is("id", null)
          : cashier.from(table).delete().is("id", null);
      const response = await query;
      if (response.error?.code !== "42501" || response.status !== 403) throw new SmokeFailure("Expected direct financial write permission denial.", { code: response.error?.code, status: response.status });
    }
  }
  console.log("PASS: all 15 direct cashier financial write attempts denied.");
}

async function main() {
  console.log(`STAGING ONLY: https://${REFERENCE}.supabase.co`);
  check((await prompt("Copy the nexo-staging project reference: ")).trim() === REFERENCE, "Wrong staging reference; no network request made.");
  await confirm("nexo-staging");
  const key = (await prompt("Staging publishable/anon key (hidden; NOT service_role): ", true)).trim();
  publicKeyOnly(key, REFERENCE);
  const { client: cashier, profile: cashierProfile } = await login(key, "cashier");
  const { client: admin, profile: adminProfile } = await login(key, "admin");
  check(adminProfile.id !== cashierProfile.id, "Use separate admin and cashier accounts.");
  identifiers.cashier_id = cashierProfile.id;
  stage = "read_only_preflight";
  const register = await result(cashier.from("pos_registers").select("id,active").eq("name", REGISTER).single(), "Original register not found.");
  check(register.active, "Original register is inactive.");
  const session = await result(cashier.from("pos_register_sessions").select("*").eq("cashier_id", cashierProfile.id).eq("register_id", register.id).eq("status", "open").single(), "Original open session not found.");
  identifiers.session_id = session.id;
  check(session.closed_at === null && session.expected_closing_cash === null && session.actual_closing_cash === null && session.cash_difference === null, "Session must be unclosed.");
  money(session, ["opening_cash"], 10000n);
  const product = await result(cashier.from("products").select("*").eq("id", PRODUCT).single(), "Staging seed unavailable.");
  check(product.sku === "STG-SINGLE" && product.name === "STAGING standalone item" && product.active && cents(product.price) === 1000n, "Unexpected STG-SINGLE seed.");
  const variant = await result(cashier.from("product_variants").select("*").eq("id", VARIANT).single(), "Unpriced staging variant unavailable.");
  check(variant.sku === "STG-SMALL" && variant.active && cents(variant.price) === 2000n, "Unexpected STG-SMALL seed.");
  const methods = {};
  for (const code of ["cash", "tbc"]) {
    const method = await result(cashier.from("pos_payment_methods").select("code,name,active").eq("code", code).single(), "Required payment method unavailable.");
    check(method.active, "Cash and TBC must be active."); methods[code] = method.name;
  }
  const existing = await result(admin.from("pos_business_customers").select("id").eq("name", CUSTOMER_NAME), "Customer preflight failed.");
  check(existing.length === 0, "This wholesale test customer already exists. Inspect prior progress; do not reset or rerun automatically.");
  identifiers.customer_id = randomUUID();
  identifiers.sale_request_id = randomUUID();
  identifiers.tracking_code = `STG-WHOLESALE-${identifiers.sale_request_id}`;
  const baseline = await snapshot(cashier, admin);
  check(baseline.ledger.length === 0 && ["pos_sales", "pos_sale_items", "pos_payments", "pos_register_sessions"].every(t => baseline[t].length === 1), "Expected the intact first retail smoke state only.");
  const retail = baseline.pos_sales[0];
  check(String(retail.sale_number) === "1" && retail.session_id === session.id && retail.cashier_id === cashierProfile.id && retail.sale_type === "retail" && retail.status === "completed" && retail.tracking_code === `STG-RETAIL-${retail.request_id}`, "Original retail sale mismatch.");
  money(retail, ["total", "paid_total"], 1000n); money(retail, ["debt_amount"], 0n);
  check(drawerCents(baseline) === 11000n, "Initial drawer must be 110.00.");
  identifiers.retail_sale_id = retail.id;
  console.log(JSON.stringify({ phase: "READY", ...identifiers, expected_initial_drawer: "110.00", setup: "customer + STG-SINGLE price 7.50", sale: "2 units, total 15.00, cash paid 5.00", repayments: "TBC 4.00 then cash 6.00" }, null, 2));

  stage = "admin_customer_setup";
  await confirm("CREATE STAGING WHOLESALE CUSTOMER");
  const customer = await result(admin.from("pos_business_customers").insert({ id: identifiers.customer_id, name: CUSTOMER_NAME,
    tax_code: `STG-WHOLESALE-${identifiers.customer_id}`, notes: "Staging wholesale partial-payment/repayment smoke test only", active: true }).select("*").single(), "Customer setup failed or outcome uncertain; inspect the printed customer ID.");
  stage = "admin_wholesale_price_setup";
  const priced = await result(admin.rpc("pos_set_customer_prices", { p_customer: customer.id, p_rows: [{ kind: "product", target: PRODUCT, price: "7.50" }] }), "Admin wholesale pricing RPC failed; preserve customer and inspect.");
  check(priced === 1, "Expected exactly one configured wholesale price.");
  const prices = await result(admin.from("pos_customer_prices").select("*").eq("customer_id", customer.id), "Configured price readback failed.");
  check(prices.length === 1 && prices[0].product_id === PRODUCT && prices[0].variant_id === null && cents(prices[0].price) === 750n, "Unexpected customer-specific price.");
  const quote = await result(cashier.rpc("pos_quote", { p_kind: "product", p_target: PRODUCT, p_type: "wholesale", p_customer: customer.id }), "Cashier wholesale quote failed.");
  check(quote.state === "found" && cents(quote.price) === 750n, "Wholesale quote did not use the 7.50 customer price.");

  stage = "missing_wholesale_price";
  await confirm("TEST MISSING WHOLESALE PRICE");
  const missing = await result(cashier.rpc("pos_quote", { p_kind: "variant", p_target: VARIANT, p_type: "wholesale", p_customer: customer.id }), "Missing-price quote failed.");
  check(missing.state === "wholesale_price_missing" && missing.price === undefined, "Missing wholesale price must not fall back to retail.");
  identifiers.missing_price_request_id = randomUUID();
  console.log(JSON.stringify({ missing_price_request_id: identifiers.missing_price_request_id }));
  const rejected = await cashier.rpc("pos_complete_sale", { p_request: identifiers.missing_price_request_id, p_session: session.id,
    p_type: "wholesale", p_customer: customer.id, p_tracking: `STG-NO-PRICE-${identifiers.missing_price_request_id}`,
    p_items: [{ kind: "variant", target: VARIANT, quantity: "1", discount_percent: "0" }], p_payments: [{ method: "cash", amount: "20.00" }] });
  same(baseline, await snapshot(cashier, admin), "Missing-price attempt changed financial records.");
  check(rejected.error?.code === "P0001" && rejected.error?.message === "WHOLESALE_PRICE_MISSING" && rejected.data === null, "Expected WHOLESALE_PRICE_MISSING; another failure is not a pass.");
  await verifyBalance(admin, 0n);
  console.log("PASS missing price: quote has no fallback, sale rejected, financial records unchanged.");

  stage = "cashier_partial_wholesale_sale";
  await confirm("CREATE PARTIALLY PAID WHOLESALE SALE");
  identifiers.wholesale_sale_id = await result(cashier.rpc("pos_complete_sale", { p_request: identifiers.sale_request_id,
    p_session: session.id, p_type: "wholesale", p_customer: customer.id, p_tracking: identifiers.tracking_code,
    p_items: [{ kind: "product", target: PRODUCT, quantity: "2", discount_percent: "0" }],
    p_payments: [{ method: "cash", amount: "5.00" }] }), "Wholesale sale failed or outcome uncertain; inspect request ID before retrying.");
  console.log(JSON.stringify({ wholesale_sale_id: identifiers.wholesale_sale_id }));
  const sold = await snapshot(cashier, admin);
  verifyWholesale(sold, baseline, customer, cashierProfile, methods, 0); await verifyBalance(admin, 1000n);
  console.log("PASS wholesale: total 15.00, initial paid 5.00, current debt 10.00, drawer 115.00.");
  const hiddenLedger = await result(cashier.from("pos_customer_transactions").select("id").eq("customer_id", customer.id), "Cashier ledger-isolation check failed.");
  check(hiddenLedger.length === 0, "Ledger rows should remain admin-only.");
  const deniedBalance = await cashier.rpc("pos_customer_balance", { p_customer: customer.id });
  check(deniedBalance.error?.code === "42501", "Balance inspection must remain admin-only.");

  stage = "cashier_tbc_repayment";
  identifiers.tbc_request_id = randomUUID();
  console.log(JSON.stringify({ tbc_request_id: identifiers.tbc_request_id }));
  await confirm("REPAY 4.00 BY TBC");
  identifiers.tbc_payment_id = await result(cashier.rpc("pos_record_repayment", { p_request: identifiers.tbc_request_id,
    p_sale: identifiers.wholesale_sale_id, p_session: session.id, p_method: "tbc", p_amount: "4.00" }), "TBC repayment failed or outcome uncertain; inspect request ID.");
  const bankPaid = await snapshot(cashier, admin);
  verifyWholesale(bankPaid, baseline, customer, cashierProfile, methods, 1); await verifyBalance(admin, 600n);
  retailPreserved(sold, bankPaid);
  console.log("PASS TBC repayment: current debt 6.00, drawer unchanged at 115.00.");

  stage = "cashier_cash_repayment";
  identifiers.cash_request_id = randomUUID();
  const repay = { p_request: identifiers.cash_request_id, p_sale: identifiers.wholesale_sale_id, p_session: session.id, p_method: "cash", p_amount: "6.00" };
  console.log(JSON.stringify({ cash_request_id: identifiers.cash_request_id }));
  await confirm("REPAY FINAL 6.00 BY CASH");
  identifiers.cash_payment_id = await result(cashier.rpc("pos_record_repayment", repay), "Cash repayment failed or outcome uncertain; inspect request ID.");
  const paid = await snapshot(cashier, admin);
  verifyWholesale(paid, baseline, customer, cashierProfile, methods, 2); await verifyBalance(admin, 0n);
  retailPreserved(bankPaid, paid);
  console.log("PASS cash repayment: debt 0.00, drawer 121.00; original paid/debt snapshots still 5.00/10.00.");

  stage = "cashier_repayment_idempotency";
  await confirm("VERIFY REPAYMENT RETRY AND CONFLICT");
  const repeated = await result(cashier.rpc("pos_record_repayment", repay), "Exact repayment retry failed.");
  same(paid, await snapshot(cashier, admin), "Exact repayment retry changed financial records.");
  check(repeated === identifiers.cash_payment_id, "Exact retry must return the original payment ID.");
  const conflict = await cashier.rpc("pos_record_repayment", { ...repay, p_amount: "5.00" });
  same(paid, await snapshot(cashier, admin), "Changed repayment request changed financial records.");
  check(conflict.error?.code === "P0001" && conflict.error?.message === "REQUEST_CONFLICT" && conflict.data === null, "Changed repayment payload must produce REQUEST_CONFLICT.");
  await verifyBalance(admin, 0n);
  await deniedWrites(cashier);
  same(paid, await snapshot(cashier, admin), "Write-denial probes changed financial records.");
  console.log(JSON.stringify({ result: "PASS", ...identifiers, sale_count: 2, item_count: 2, payment_count: 4,
    customer_ledger_count: 4, wholesale_total: "15.00", initial_paid_snapshot: "5.00", initial_debt_snapshot: "10.00",
    current_customer_balance: "0.00", total_received_for_wholesale: "15.00", expected_drawer: "121.00", session_status: "open" }, null, 2));
  console.log("STOP. Wholesale/debt/repayment scenario complete. Original retail records preserved; register remains open. No cleanup or concurrency test.");
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
