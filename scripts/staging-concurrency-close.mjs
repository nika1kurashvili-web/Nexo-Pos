// Manual staging concurrency and close. NEVER run automatically.
// Real cashier RPCs; admin Auth reads/setup; separate PostgreSQL connections hold/observe locks only.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
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

const SESSION = "ed6d7067-8482-4654-8c3b-df124450644c";
const CUSTOMER = "STAGING - WHOLESALE DEBT SMOKE";
const EMPTY_REGISTER = "STAGING - CONCURRENCY EMPTY REGISTER";
const NOTE = "STAGING final concurrency close; actual cash 121.00";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = {};

async function snapshot(admin) {
  const state = {};
  // Admin READS detect even unexpected rows outside the cashier's RLS-visible scope.
  for (const table of ["pos_sales", "pos_sale_items", "pos_payments", "pos_register_sessions", "pos_customer_transactions"]) {
    state[table] = await rows(admin.from(table).select("*", { count: "exact" }).order("id"));
  }
  return state;
}
function total(rows, field) { return rows.reduce((sum, row) => sum + cents(row[field]), 0n); }
function balance(state) {
  return state.pos_customer_transactions.filter(r => r.customer_id === identifiers.customer_id)
    .reduce((sum, r) => sum + (String(r.amount).startsWith("-") ? -cents(String(r.amount).slice(1)) : cents(r.amount)), 0n);
}
function drawer(state) {
  const session = state.pos_register_sessions.find(r => r.id === SESSION);
  return cents(session.opening_cash) + total(state.pos_payments.filter(p => p.session_id === SESSION && p.method_code === "cash"), "amount");
}
function unique(rows, key) { check(new Set(rows.map(key)).size === rows.length, "Duplicate financial identities detected."); }
function integrity(state) {
  for (const rows of Object.values(state)) unique(rows, r => r.id);
  unique(state.pos_sales, r => String(r.sale_number)); unique(state.pos_sales, r => r.request_id);
  unique(state.pos_payments, r => r.request_id);
  unique(state.pos_sale_items, r => `${r.sale_id}/${r.line_number}`);
  unique(state.pos_customer_transactions.filter(r => r.payment_id !== null), r => r.payment_id);
  const open = state.pos_register_sessions.filter(r => r.status === "open");
  unique(open, r => r.register_id); unique(open, r => r.cashier_id);
  check(drawer(state) === 12100n && balance(state) === 0n, "Cash drawer or settled customer balance changed.");
}
function unchanged(before, after) { integrity(after); same(before, after, "Unexpected financial/session changes; inspect staging before retrying."); }
function rpcError(response, code, message) {
  check(response.error?.code === code && (!message || response.error?.message === message) && response.data === null,
    "RPC returned an unexpected success or error; inspect staging.");
}
function salePayload(sale) {
  return { p_request: sale.request_id, p_session: SESSION, p_type: "retail", p_customer: null,
    p_tracking: `  ${sale.tracking_code}  `,
    p_items: [{ kind: "product", target: PRODUCT, quantity: "1", discount_percent: "0" }],
    p_payments: [{ method: "cash", amount: "10.00" }] };
}
function newSalePayload(request) {
  return { p_request: request, p_session: SESSION, p_type: "retail", p_customer: null,
    p_tracking: `STG-CONCURRENCY-${request}`,
    p_items: [{ kind: "product", target: PRODUCT, quantity: "1", discount_percent: "0" }],
    p_payments: [{ method: "tbc", amount: "10.00" }] };
}
function overpayment(request) {
  // Existing customer debt is zero: this request can NEVER legitimately add a payment.
  return { p_request: request, p_sale: identifiers.wholesale_sale_id, p_session: SESSION, p_method: "cash", p_amount: "0.01" };
}
const controlDiagnostics = new WeakMap();
function connectionFailure(error, connectionStage, mode) {
  // Allowlist categories/codes only. Never return server messages, addresses,
  // usernames, connection strings, certificates, raw errors or stacks.
  const knownCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
    "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER", "ENOENT", "EACCES",
    "28P01", "28000", "3D000", "42501", "42P01", "42703", "53300", "57P03", "08001", "08006"]);
  const pending = [error], errors = [], seen = new Set();
  while (pending.length && errors.length < 8) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item); errors.push(item);
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 4));
  }
  const codes = [...new Set(errors.map(e => e.code).filter(c => knownCodes.has(c)))];
  let category = "unknown_connection_failure";
  if (["configuration", "ca_load", "client_initialization"].includes(connectionStage)) category = "configuration";
  else if (codes.some(c => ["28P01", "28000"].includes(c))) category = "database_authentication";
  else if (codes.some(c => /CERT|SELF_SIGNED|ISSUER|TLS|SSL|SIGNATURE/.test(c))) category = "tls_certificate";
  else if (codes.some(c => ["ENOTFOUND", "EAI_AGAIN"].includes(c))) category = "dns_resolution";
  else if (errors.some(e => ["ENETUNREACH", "EHOSTUNREACH"].includes(e.code) && typeof e.address === "string" && isIP(e.address) === 6)) category = "ipv6_network_unreachable";
  else if (codes.includes("ETIMEDOUT") || errors.some(e => ["timeout expired", "Connection terminated due to connection timeout"].includes(e.message))) category = "network_timeout";
  else if (codes.some(c => ["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "ECONNRESET", "08001", "08006"].includes(c))) category = "network_connection";
  else if (codes.includes("42501")) category = "database_permissions";
  else if (codes.some(c => ["53300", "57P03"].includes(c))) category = "database_unavailable";
  else if (codes.some(c => ["3D000", "42P01", "42703"].includes(c))) category = "database_schema_or_identity";
  else if (error instanceof SmokeFailure && ["holder_identity", "observer_identity"].includes(connectionStage)) category = "wrong_database_identity";
  else if (error instanceof SmokeFailure && connectionStage === "independent_connections") category = "session_pooling_required";
  const failure = new SmokeFailure("Staging connection preflight failed. Inspect the sanitized category/stage; raw connection details were withheld.");
  controlDiagnostics.set(failure, { connection_stage: connectionStage, connection_mode: mode, category, ...(codes.length ? { diagnostic_codes: codes } : {}) });
  return failure;
}
async function controls() {
  let Client;
  try { ({ Client } = createRequire(new URL("./staging-concurrency-tools/package.json", import.meta.url))("pg")); }
  catch { throw new SmokeFailure("Install the dedicated staging-concurrency-tools dependencies first; no database connection attempted."); }
  let connectionStage = "configuration", mode = "unselected", holder, observer;
  try {
  const host = (await prompt("Staging database host from Dashboard Connect (direct or SESSION pooler; hidden): ", true)).trim();
  const user = (await prompt("Staging database username from Dashboard Connect (hidden): ", true)).trim();
  const direct = host === `db.${REFERENCE}.supabase.co` && user === "postgres";
  const pooler = /^[a-z0-9-]+[.]pooler[.]supabase[.]com$/.test(host) && user === `postgres.${REFERENCE}`;
  check(direct || pooler, "Database host/username do not identify the pinned staging project.");
  mode = direct ? "direct" : "session_pooler";
  check((await prompt("Database port (must be 5432, not transaction pooler 6543): ")).trim() === "5432", "Use port 5432 direct/session pooling.");
  const password = await prompt("Staging DATABASE password (hidden; not an Auth/service-role key): ", true);
  const trust = (await prompt("TLS trust: type system, or a local PEM CA certificate path from staging Dashboard: ")).trim();
  connectionStage = "ca_load";
  const ssl = { rejectUnauthorized: true, ...(trust === "system" ? {} : { ca: await readFile(trust, "utf8") }) };
  const config = { host, port: 5432, user, password, database: "postgres", ssl, connectionTimeoutMillis: 10000,
    application_name: "nexo-staging-concurrency-control" };
  connectionStage = "client_initialization";
  holder = new Client(config); observer = new Client({ ...config, application_name: "nexo-staging-concurrency-observer" });
  // Do not log pg error objects: they can contain connection details.
  holder.on("error", () => {}); observer.on("error", () => {});
    connectionStage = "holder_connect";
    await holder.connect();
    connectionStage = "observer_connect";
    await observer.connect();
    connectionStage = "holder_identity";
    const who = await holder.query("select current_user as name, pg_backend_pid() as pid");
    check(who.rows[0].name === "postgres", "Lock instrumentation must use the staging database owner.");
    const pid = who.rows[0].pid;
    connectionStage = "observer_identity";
    const observerWho = await observer.query("select current_user as name, pg_backend_pid() as pid");
    check(observerWho.rows[0].name === "postgres", "Observer must use the staging database owner.");
    // Cross-check the control endpoint against Auth/API records, not just the hostname.
    const identity = await observer.query("select id, cashier_id from public.pos_register_sessions where id=$1", [SESSION]);
    check(identity.rows.length === 1 && identity.rows[0].cashier_id === identifiers.cashier_id, "Control database does not match the verified staging Auth/session.");
    connectionStage = "independent_connections";
    check(observerWho.rows[0].pid !== pid, "Two independent session-mode PostgreSQL backends are required.");
    return { holder, observer, pid };
  } catch (error) {
    const failure = connectionFailure(error, connectionStage, mode);
    await Promise.allSettled([holder, observer].filter(Boolean).map(client => Promise.resolve().then(() => client.end())));
    throw failure;
  }
}
async function beginLock(control, kind, request) {
  await control.holder.query("begin");
  control.pid = (await control.holder.query("select pg_backend_pid() as pid")).rows[0].pid;
  // These settings protect ONLY instrumentation. They do not change cashier RPC settings.
  await control.holder.query("set local lock_timeout='2s'");
  await control.holder.query("set local statement_timeout='15s'");
  await control.holder.query("set local idle_in_transaction_session_timeout='20s'");
  if (kind === "session") await control.holder.query("select id from public.pos_register_sessions where id=$1 for update", [SESSION]);
  else if (kind === "advisory") await control.holder.query("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))", [request]);
  else if (kind === "opening") await control.holder.query("lock table public.pos_register_sessions in share mode");
  else throw new SmokeFailure("Unknown instrumentation lock.");
}
async function blocked(control, minimum) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const query = await control.observer.query(`with recursive waiting(pid) as (
      select pid from pg_catalog.pg_stat_activity where $1::integer=any(pg_catalog.pg_blocking_pids(pid))
      union select a.pid from pg_catalog.pg_stat_activity a join waiting w on w.pid=any(pg_catalog.pg_blocking_pids(a.pid))
    ) select coalesce(array_agg(distinct pid),array[]::integer[]) as pids from waiting`, [control.pid]);
    if (query.rows[0].pids.length >= minimum) return query.rows[0].pids;
    await pause(50);
  }
  throw new SmokeFailure("Required overlapping blocked PostgreSQL backends were not observed. This is not a concurrency PASS.");
}
function launch(jobs) {
  // Start real HTTP requests together; observer must prove distinct DB backends overlap.
  return jobs.map(job => Promise.resolve().then(job).catch(() => ({ data: null, error: { code: "NETWORK_UNKNOWN" } })));
}
async function cohort(control, label, kind, request, jobs) {
  let pending = [], observationFailure;
  try {
    await beginLock(control, kind, request);
    pending = launch(jobs);
    try { evidence[label] = { blocked_backend_pids: await blocked(control, 2) }; }
    catch (error) { observationFailure = error; }
  } finally {
    await control.holder.query("rollback");
  }
  const responses = await Promise.all(pending);
  if (observationFailure) throw observationFailure;
  return responses;
}
async function timeoutProbe(control, cashier) {
  identifiers.timeout_request_id = randomUUID();
  let pending, observed, response, failure;
  try {
    await beginLock(control, "session");
    pending = launch([() => cashier.rpc("pos_record_repayment", overpayment(identifiers.timeout_request_id))])[0];
    try {
      observed = await blocked(control, 1);
      // Hold for the configured SERVER timeout, never count a client abort as a rollback.
      response = await Promise.race([pending, pause(12000).then(() => null)]);
      if (!response || !["55P03", "57014"].includes(response.error?.code)) failure = true;
    } catch { failure = true; }
  } finally { await control.holder.query("rollback"); }
  if (pending) await pending;
  check(!failure, "No controlled database lock/statement timeout was observed within 12 seconds. Stop before close; do not change API settings or assume a client timeout proves rollback.");
  const active = await control.observer.query("select count(*)::integer as n from pg_catalog.pg_stat_activity where pid=any($1::integer[]) and state='active'", [observed]);
  check(active.rows[0].n === 0, "Timed-out database request is still active; inspect before continuing.");
  evidence.timeout = { sqlstate: response.error.code, kind: response.error.code === "55P03" ? "lock_timeout" : "statement_timeout",
    lock_timeout_observed: response.error.code === "55P03", blocked_backend_pids: observed };
}
export function verifyClosedSession(closed, expectedNote) {
  check(closed?.status === "closed", "Session did not close.");
  check(closed.closing_note === expectedNote, "Session closing note mismatch.");
  // Compare database timestamps to each other, never to the workstation clock.
  // Preserve PostgreSQL microseconds rather than truncating to JS milliseconds.
  const micros = value => {
    const match = typeof value === "string" && value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/);
    check(match, "Session timestamp format is invalid.");
    const seconds = Date.parse(match[1] + match[3]);
    check(Number.isFinite(seconds), "Session timestamp is invalid.");
    return BigInt(seconds) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  };
  check(micros(closed.closed_at) >= micros(closed.opened_at), "Session close timestamp precedes opening timestamp.");
}
function verifyFinal(before, after, raceRequest, cashierProfile, methodName) {
  integrity(after);
  for (const table of ["pos_sales", "pos_sale_items", "pos_payments", "pos_customer_transactions"]) {
    for (const row of before[table]) same(row, after[table].find(r => r.id === row.id), "Original financial history changed.");
  }
  check(after.pos_register_sessions.length === before.pos_register_sessions.length, "Unexpected extra session.");
  const closed = after.pos_register_sessions.find(r => r.id === SESSION), original = before.pos_register_sessions.find(r => r.id === SESSION);
  verifyClosedSession(closed, NOTE);
  money(closed, ["expected_closing_cash", "actual_closing_cash"], 12100n); money(closed, ["cash_difference"], 0n);
  const unchangedFields = r => { const { status, closed_at, expected_closing_cash, actual_closing_cash, cash_difference, closing_note, ...rest } = r; return rest; };
  same(unchangedFields(original), unchangedFields(closed), "Closing changed session identity/opening history.");
  for (const row of before.pos_register_sessions.filter(r => r.id !== SESSION)) same(row, after.pos_register_sessions.find(r => r.id === row.id), "Another session changed.");
  const newSales = after.pos_sales.filter(r => !before.pos_sales.some(old => old.id === r.id));
  check(newSales.length <= 1, "Concurrent duplicate requests created multiple sales.");
  const count = newSales.length;
  check(after.pos_sale_items.length === before.pos_sale_items.length+count && after.pos_payments.length === before.pos_payments.length+count && after.pos_customer_transactions.length === before.pos_customer_transactions.length, "Partial/duplicate financial writes detected.");
  if (count) {
    const sale = newSales[0];
    check(sale.request_id === raceRequest && sale.session_id === SESSION && sale.cashier_id === cashierProfile.id && sale.cashier_name === cashierProfile.full_name && sale.sale_type === "retail" && sale.status === "completed" && sale.customer_id === null && sale.tracking_code === `STG-CONCURRENCY-${raceRequest}`, "Unexpected racing sale.");
    money(sale, ["subtotal", "total", "paid_total"], 1000n); money(sale, ["discount_total", "debt_amount"], 0n);
    const items = after.pos_sale_items.filter(r => r.sale_id === sale.id), payments = after.pos_payments.filter(r => r.sale_id === sale.id);
    check(items.length === 1 && payments.length === 1, "Racing sale was not atomic.");
    check(items[0].product_id === PRODUCT && items[0].variant_id === null && items[0].sku === "STG-SINGLE" && items[0].product_name === "STAGING standalone item" && Number(items[0].quantity) === 1, "Racing item snapshot mismatch.");
    money(items[0], ["base_unit_price", "adjusted_unit_price", "final_unit_price", "line_total"], 1000n);
    check(payments[0].method_code === "tbc" && payments[0].method_name === methodName && payments[0].kind === "sale_payment" && payments[0].session_id === SESSION && payments[0].received_by === cashierProfile.id, "Racing payment mismatch.");
    money(payments[0], ["amount"], 1000n);
  }
  return newSales[0]?.id ?? null;
}

async function main() {
  console.log(`STAGING ONLY: https://${REFERENCE}.supabase.co; existing session ${SESSION}`);
  check((await prompt("Copy nexo-staging project reference: ")).trim() === REFERENCE, "Wrong project reference; no network call made.");
  await confirm("nexo-staging");
  const key = (await prompt("Staging publishable/anon key (hidden): ", true)).trim(); publicKeyOnly(key, REFERENCE);
  const { client: cashier, profile: cashierProfile } = await login(key, "cashier");
  const { client: admin } = await login(key, "admin");
  identifiers.cashier_id = cashierProfile.id; identifiers.session_id = SESSION;
  const customer = await result(admin.from("pos_business_customers").select("id").eq("name", CUSTOMER).single(), "Verified wholesale customer missing.");
  identifiers.customer_id = customer.id;
  const before = await snapshot(admin);
  check(before.pos_sales.length === 2 && before.pos_sale_items.length === 2 && before.pos_payments.length === 4 && before.pos_customer_transactions.length === 4 && before.pos_register_sessions.length === 1, "Expected exactly the verified starting staging state; inspect, never reset.");
  integrity(before);
  check(total(before.pos_sales, "total") === 2500n && total(before.pos_payments, "amount") === 2500n, "Expected original total sales and payments of 25.00.");
  const session = before.pos_register_sessions[0];
  check(session.id === SESSION && session.cashier_id === cashierProfile.id && session.status === "open" && session.closed_at === null && session.expected_closing_cash === null && session.actual_closing_cash === null && session.cash_difference === null, "Wrong cashier or open session.");
  money(session, ["opening_cash"], 10000n);
  const register = await result(admin.from("pos_registers").select("id,name,active").eq("id", session.register_id).single(), "Register read failed.");
  check(register.name === REGISTER && register.active, "Original staging register mismatch.");
  const retail = before.pos_sales.find(r => r.sale_type === "retail"), wholesale = before.pos_sales.find(r => r.sale_type === "wholesale");
  check(retail && wholesale && retail.cashier_id === cashierProfile.id && wholesale.cashier_id === cashierProfile.id && wholesale.customer_id === customer.id && retail.tracking_code === `STG-RETAIL-${retail.request_id}`, "Original sales mismatch.");
  identifiers.wholesale_sale_id = wholesale.id;
  const repayment = before.pos_payments.find(p => p.sale_id === wholesale.id && p.kind === "repayment" && p.method_code === "cash");
  check(repayment && cents(repayment.amount) === 600n && repayment.received_by === cashierProfile.id, "Original cash repayment mismatch.");
  const product = await result(cashier.from("products").select("id,sku,name,price,active").eq("id", PRODUCT).single(), "Staging product missing.");
  check(product.active && product.sku === "STG-SINGLE" && product.name === "STAGING standalone item" && cents(product.price) === 1000n, "Staging seed changed.");
  const tbc = await result(cashier.from("pos_payment_methods").select("name,active").eq("code", "tbc").single(), "TBC method missing."); check(tbc.active, "TBC must be active.");
  const balanceResult = await result(admin.rpc("pos_customer_balance", { p_customer: customer.id }), "Balance verification failed."); check(cents(balanceResult) === 0n, "Do not invent debt for this test.");
  stage = "lock_control_connection";
  const control = await controls();
  try {
    const roleSettings = await control.observer.query("select rolname, rolconfig from pg_catalog.pg_roles where rolname in ('authenticated','authenticator')");
    console.log(JSON.stringify({ phase: "READY", ...identifiers, expected_drawer: "121.00", role_timeout_settings: roleSettings.rows.map(r => ({ role: r.rolname, settings: (r.rolconfig ?? []).filter(s => /^(lock_timeout|statement_timeout)=/.test(s)) })) }, null, 2));
    await confirm("START STAGING CONCURRENCY CHECKS");

    stage = "opening_invariants";
    let empty = await result(admin.from("pos_registers").select("id,active").eq("name", EMPTY_REGISTER).maybeSingle(), "Concurrency register lookup failed.");
    if (!empty) empty = await result(admin.from("pos_registers").insert({ name: EMPTY_REGISTER, active: true }).select("id,active").single(), "Admin test-register setup failed; inspect before retry.");
    check(empty.active && !before.pos_register_sessions.some(s => s.register_id === empty.id), "Companion register must be active and unused.");
    identifiers.empty_register_id = empty.id;
    const opening = await cohort(control, "opening", "opening", null, [
      () => cashier.rpc("pos_open_register", { p_register: register.id, p_cash: "0.00" }),
      () => cashier.rpc("pos_open_register", { p_register: empty.id, p_cash: "0.00" }),
    ]);
    for (const response of opening) rpcError(response, "23505");
    unchanged(before, await snapshot(admin));
    console.log("PASS competing opens: no extra session on occupied or empty register.");

    stage = "concurrent_sale_retries";
    const original = salePayload(retail);
    const sales = await cohort(control, "sale_retries", "advisory", retail.request_id, [
      () => cashier.rpc("pos_complete_sale", original), () => cashier.rpc("pos_complete_sale", original),
      () => cashier.rpc("pos_complete_sale", { ...original, p_tracking: retail.tracking_code + "-CONFLICT" }),
    ]);
    for (const response of sales.slice(0,2)) check(!response.error && response.data === retail.id, "Concurrent sale replay did not return original sale.");
    rpcError(sales[2], "P0001", "REQUEST_CONFLICT"); unchanged(before, await snapshot(admin));

    stage = "concurrent_repayment_retries";
    const repay = { p_request: repayment.request_id, p_sale: wholesale.id, p_session: SESSION, p_method: "cash", p_amount: "6.00" };
    const repayments = await cohort(control, "repayment_retries", "advisory", repayment.request_id, [
      () => cashier.rpc("pos_record_repayment", repay), () => cashier.rpc("pos_record_repayment", repay),
      () => cashier.rpc("pos_record_repayment", { ...repay, p_amount: "5.00" }),
    ]);
    for (const response of repayments.slice(0,2)) check(!response.error && response.data === repayment.id, "Concurrent repayment replay created or returned another payment.");
    rpcError(repayments[2], "P0001", "REQUEST_CONFLICT"); unchanged(before, await snapshot(admin));

    stage = "database_timeout_rollback";
    await confirm("TEST CONTROLLED DATABASE TIMEOUT");
    await timeoutProbe(control, cashier); unchanged(before, await snapshot(admin));
    console.log(JSON.stringify({ phase: "TIMEOUT_VERIFIED", ...evidence.timeout }));

    stage = "sale_repayment_close_race";
    await confirm("RACE NONCASH SALE AND CLOSE AT 121.00");
    identifiers.race_request_id = randomUUID(); identifiers.zero_debt_request_id = randomUUID();
    console.log(JSON.stringify({ ...identifiers }));
    const racingSale = newSalePayload(identifiers.race_request_id);
    const close = { p_session: SESSION, p_actual: "121.00", p_note: NOTE };
    const raced = await cohort(control, "close_race", "session", null, [
      () => cashier.rpc("pos_complete_sale", racingSale), () => cashier.rpc("pos_complete_sale", racingSale),
      () => cashier.rpc("pos_record_repayment", overpayment(identifiers.zero_debt_request_id)),
      () => cashier.rpc("pos_close_register", close), () => cashier.rpc("pos_close_register", close),
    ]);
    const after = await snapshot(admin);
    const newSale = verifyFinal(before, after, identifiers.race_request_id, cashierProfile, tbc.name);
    for (const response of raced.slice(0,2)) {
      if (newSale) check(!response.error && response.data === newSale, "Sale winner/replay did not agree on one sale.");
      else rpcError(response, "P0001", "OPEN_SESSION_REQUIRED");
    }
    check(["OPEN_SESSION_REQUIRED", "OVERPAYMENT_NOT_SUPPORTED"].includes(raced[2].error?.message), "Zero-debt repayment unexpectedly succeeded.");
    rpcError(raced[2], "P0001", raced[2].error.message);
    const closes = raced.slice(3); check(closes.filter(r => !r.error).length === 1, "Exactly one close must succeed.");
    for (const response of closes) {
      if (response.error) rpcError(response, "P0001", "SESSION_CLOSED");
      else check(cents(response.data) === 12100n, "Close computed unexpected cash.");
    }

    stage = "closed_session_rejection";
    identifiers.closed_sale_request_id = randomUUID(); identifiers.closed_repayment_request_id = randomUUID();
    console.log(JSON.stringify({ closed_sale_request_id: identifiers.closed_sale_request_id, closed_repayment_request_id: identifiers.closed_repayment_request_id }));
    const deniedSale = await cashier.rpc("pos_complete_sale", newSalePayload(identifiers.closed_sale_request_id)); rpcError(deniedSale, "P0001", "OPEN_SESSION_REQUIRED");
    const deniedRepay = await cashier.rpc("pos_record_repayment", overpayment(identifiers.closed_repayment_request_id)); rpcError(deniedRepay, "P0001", "OPEN_SESSION_REQUIRED");
    const deniedClose = await cashier.rpc("pos_close_register", close); rpcError(deniedClose, "P0001", "SESSION_CLOSED");
    // Existing requests remain legitimate read-like replays after closing; no new attachment.
    check(await result(cashier.rpc("pos_complete_sale", original), "Closed-session original sale replay failed.") === retail.id, "Original sale replay changed identity.");
    check(await result(cashier.rpc("pos_record_repayment", repay), "Closed-session original repayment replay failed.") === repayment.id, "Original repayment replay changed identity.");
    unchanged(after, await snapshot(admin));
    check(cents(await result(admin.rpc("pos_customer_balance", { p_customer: customer.id }), "Final balance lookup failed.")) === 0n, "Final debt changed.");
    console.log(JSON.stringify({ result: "PASS", ...identifiers, observed_concurrency: evidence,
      sale_count: after.pos_sales.length, item_count: after.pos_sale_items.length, payment_count: after.pos_payments.length,
      ledger_count: after.pos_customer_transactions.length, session_count: after.pos_register_sessions.length,
      optional_noncash_sale_id: newSale, expected_drawer: "121.00", actual_cash: "121.00", cash_difference: "0.00", session_status: "closed",
      lock_timeout_result: evidence.timeout.lock_timeout_observed ? "OBSERVED_55P03" : "NOT_OBSERVED_STATEMENT_TIMEOUT_57014_INSTEAD" }, null, 2));
    console.log("STOP. Preserve all records and the empty companion register. No cleanup, reopen or later test.");
  } finally {
    await control.holder.query("rollback").catch(() => {});
    await Promise.allSettled([control.holder.end(), control.observer.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ result: "STOP", stage, ...identifiers,
      ...(controlDiagnostics.get(error) ?? {}),
      message: error instanceof SmokeFailure ? error.message : "Unexpected failure; raw connection/server diagnostics withheld. Outcome may be committed; inspect IDs before retrying.",
      ...(error instanceof SmokeFailure && error.code ? { code: error.code } : {}),
      ...(error instanceof SmokeFailure && error.status ? { status: error.status } : {}),
    }, null, 2));
    process.exitCode = 1;
  });
}
