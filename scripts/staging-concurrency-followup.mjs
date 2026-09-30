// Separate follow-up runner. NEVER run automatically. No historical mutations.
// Real cashier RPCs; admin Auth reads/setup; separate PostgreSQL connections hold/observe locks only.
import { createRequire } from "node:module";
import { readFile, mkdtemp, open } from "node:fs/promises";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

const REFERENCE = "tclplmbnfnktpthcwqbq";
const HISTORY = "ed6d7067-8482-4654-8c3b-df124450644c";
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


import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyClosedSession } from './staging-concurrency-close.mjs';

const TABLES = ['pos_sales', 'pos_sale_items', 'pos_payments', 'pos_customer_transactions',
  'pos_register_sessions', 'pos_business_customers', 'pos_customer_prices', 'pos_registers'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let journal, run, baseline, latest, cashier, admin, control, actor, customer;
const sessions = new Set(), registers = new Set(), saleSpecs = new Map(), repaySpecs = new Map();
const observed = {};

async function record(event, details = {}) {
  // Callers supply identifiers, fixed labels, numeric outcomes and allowlisted codes only.
  const line = JSON.stringify({ event, run_id: run, stage, ...details });
  if (journal) { await journal.write(line + '\n'); await journal.sync(); }
  console.log(line);
}
export function responseSummary(response) {
  return { code: /^[A-Z0-9_]{5,40}$/.test(response.error?.code ?? '') ? response.error.code : response.error ? 'UNKNOWN' : null,
    outcome: ['OPEN_SESSION_REQUIRED', 'SESSION_CLOSED', 'REQUEST_CONFLICT'].includes(response.error?.message) ? response.error.message : undefined,
    id: typeof response.data === 'string' && UUID.test(response.data) ? response.data : undefined,
    close_cash: !response.error && response.data !== null && /^\d+(\.\d{1,2})?$/.test(String(response.data)) ? String(response.data) : undefined };
}
function ok(response) { check(!response.error && response.data !== null, 'Unexpected RPC failure; inspect journal request IDs.'); return response.data; }
function denied(response, message) {
  check(response.data === null && response.error?.code === 'P0001' && response.error.message === message, 'Unexpected RPC rejection; inspect journal.');
}
function request(payload) { check(UUID.test(payload.p_request), 'Invalid request ID.'); return payload; }
function sale(session, wholesale = false, paid = true) {
  check(sessions.has(session) && session !== HISTORY, 'Only new run sessions can be targeted.');
  const id = randomUUID();
  return request({ p_request: id, p_session: session, p_type: wholesale ? 'wholesale' : 'retail', p_customer: wholesale ? customer : null,
    p_tracking: `STG-FOLLOWUP-${run}-${id}`, p_items: [{ kind: 'product', target: PRODUCT, quantity: '1', discount_percent: '0' }],
    p_payments: paid ? [{ method: 'tbc', amount: '10.00' }] : [] });
}
function repayment(session, saleId, amount, method = 'tbc') {
  check(sessions.has(session) && session !== HISTORY && [...saleSpecs.values()].some(s => s.id === saleId), 'Repayment must use this run fixtures.');
  return request({ p_request: randomUUID(), p_session: session, p_sale: saleId, p_method: method, p_amount: amount });
}
function closing(session, amount) {
  check(sessions.has(session) && session !== HISTORY, 'Historical close prohibited.');
  return { p_session: session, p_actual: amount, p_note: `STAGING FOLLOWUP ${run}` };
}
async function rpc(name, payload) {
  check(['pos_complete_sale', 'pos_record_repayment', 'pos_close_register', 'pos_open_register'].includes(name), 'Unexpected runtime RPC.');
  if (name === 'pos_open_register') check(registers.has(payload.p_register), 'Opening non-fixture register prohibited.');
  else check(sessions.has(payload.p_session) && payload.p_session !== HISTORY, 'Historical session mutation prohibited.');
  const operation = randomUUID();
  await record('BEFORE_RPC', { operation_id: operation, rpc: name, request_id: payload.p_request,
    session_id: payload.p_session, register_id: payload.p_register, sale_id: payload.p_sale, customer_id: payload.p_customer });
  let response;
  try { response = await cashier.rpc(name, payload); }
  catch { response = { data: null, error: { code: 'NETWORK_UNKNOWN' } }; }
  await record('RPC_RESULT', { operation_id: operation, rpc: name, ...responseSummary(response) });
  return response;
}
async function snapshot() {
  const state = {};
  for (const table of TABLES) state[table] = await rows(admin.from(table).select('*', { count: 'exact' }).order('id'));
  return state;
}
function preserved(old, next, except = new Set()) {
  for (const table of TABLES) for (const row of old[table]) {
    if (table === 'pos_register_sessions' && except.has(row.id)) continue;
    same(row, next[table].find(r => r.id === row.id), 'Existing row changed or disappeared; stop and inspect.');
  }
}
function sum(list, field) { return list.reduce((n, r) => n + Number(r[field]), 0); }
function near(a, b) { check(Math.abs(Number(a) - Number(b)) < 0.000001, 'Financial sum mismatch.'); }
export function auditIntegrity(s) {
  const unique = (list, key) => check(new Set(list.map(key)).size === list.length, 'Duplicate financial identity.');
  for (const table of TABLES) unique(s[table], r => r.id);
  unique(s.pos_sales, r => String(r.sale_number)); unique(s.pos_sales, r => r.request_id);
  unique(s.pos_payments, r => r.request_id); unique(s.pos_sale_items, r => `${r.sale_id}/${r.line_number}`);
  unique(s.pos_customer_transactions.filter(r => r.payment_id), r => r.payment_id);
  unique(s.pos_customer_transactions.filter(r => r.kind === 'sale_charge'), r => r.sale_id);
  const opened = s.pos_register_sessions.filter(r => r.status === 'open');
  unique(opened, r => r.cashier_id); unique(opened, r => r.register_id);
  for (const i of s.pos_sale_items) {
    check(s.pos_sales.some(r => r.id === i.sale_id), 'Orphan item.');
    near(i.line_total, Math.round(Number(i.final_unit_price) * Number(i.quantity) * 100) / 100);
  }
  for (const p of s.pos_payments) check(s.pos_sales.some(r => r.id === p.sale_id) && s.pos_register_sessions.some(r => r.id === p.session_id), 'Orphan payment.');
  for (const l of s.pos_customer_transactions) {
    const sale = s.pos_sales.find(r => r.id === l.sale_id), payment = s.pos_payments.find(r => r.id === l.payment_id);
    check(sale?.sale_type === 'wholesale' && sale.customer_id === l.customer_id && s.pos_business_customers.some(c => c.id === l.customer_id), 'Orphan/inconsistent ledger.');
    if (l.kind === 'sale_charge') { check(l.payment_id === null, 'Charge has payment.'); near(l.amount, sale.total); }
    else { check(payment?.sale_id === sale.id && payment.kind === l.kind, 'Missing/inconsistent ledger payment.'); near(l.amount, -Number(payment.amount)); }
  }
  for (const sale of s.pos_sales) {
    const items = s.pos_sale_items.filter(r => r.sale_id === sale.id), payments = s.pos_payments.filter(r => r.sale_id === sale.id);
    check(s.pos_register_sessions.some(r => r.id === sale.session_id) && items.length > 0, 'Orphan/partial sale.');
    near(sum(items, 'line_total'), sale.total); near(sum(payments.filter(p => p.kind === 'sale_payment'), 'amount'), sale.paid_total);
    near(Number(sale.total) - Number(sale.paid_total), sale.debt_amount);
    check(sum(payments, 'amount') <= Number(sale.total), 'Overpayment.');
    for (const p of payments.filter(p => p.kind === 'sale_payment')) check(p.session_id === sale.session_id, 'Sale payment session mismatch.');
    const ledger = s.pos_customer_transactions.filter(r => r.sale_id === sale.id);
    if (sale.sale_type === 'wholesale') {
      check(ledger.filter(l => l.kind === 'sale_charge').length === 1, 'Missing charge.');
      for (const p of payments) check(ledger.filter(l => l.payment_id === p.id).length === 1, 'Missing payment ledger.');
    } else check(ledger.length === 0 && Number(sale.debt_amount) === 0, 'Unexpected retail debt/ledger.');
  }
  for (const session of s.pos_register_sessions) {
    check(s.pos_registers.some(r => r.id === session.register_id), 'Orphan session.');
    if (session.status === 'closed') {
      verifyClosedSession(session, session.closing_note);
      near(session.expected_closing_cash, Number(session.opening_cash) + sum(s.pos_payments.filter(p => p.session_id === session.id && p.method_code === 'cash'), 'amount'));
      near(session.cash_difference, Number(session.actual_closing_cash) - Number(session.expected_closing_cash));
    }
  }
}
function auditAllowed(s) {
  const isNew = (table, row) => !baseline[table].some(r => r.id === row.id);
  for (const r of s.pos_registers.filter(r => isNew('pos_registers', r))) check(registers.has(r.id), 'Unrelated new register.');
  for (const r of s.pos_business_customers.filter(r => isNew('pos_business_customers', r))) check(r.id === customer, 'Unrelated new customer.');
  for (const r of s.pos_customer_prices.filter(r => isNew('pos_customer_prices', r))) check(r.customer_id === customer && r.product_id === PRODUCT && r.variant_id === null && cents(r.price) === 1000n, 'Unexpected new price.');
  for (const r of s.pos_register_sessions.filter(r => isNew('pos_register_sessions', r))) check(sessions.has(r.id) && registers.has(r.register_id) && r.cashier_id === actor.id && cents(r.opening_cash) === 0n, 'Unexpected new session.');
  for (const r of s.pos_sales.filter(r => isNew('pos_sales', r))) check([...saleSpecs.values()].some(spec => spec.id === r.id), 'Unexpected new sale.');
  for (const r of s.pos_sale_items.filter(r => isNew('pos_sale_items', r))) check([...saleSpecs.values()].some(spec => spec.id === r.sale_id), 'Unexpected new item.');
  for (const r of s.pos_payments.filter(r => isNew('pos_payments', r))) check(r.kind === 'sale_payment' ? [...saleSpecs.values()].some(spec => spec.id === r.sale_id) : [...repaySpecs.values()].some(spec => spec.id === r.id), 'Unexpected new payment.');
  for (const r of s.pos_customer_transactions.filter(r => isNew('pos_customer_transactions', r))) check(r.customer_id === customer && [...saleSpecs.values()].some(spec => spec.id === r.sale_id), 'Unexpected new ledger.');
}
const methods = {};
function auditSpecs(s) {
  for (const [id, spec] of saleSpecs) {
    const matches = s.pos_sales.filter(r => r.request_id === id);
    check(matches.length === (spec.id ? 1 : 0), 'Wrong request sale count.');
    if (!spec.id) continue;
    const r = matches[0], p = spec.payload;
    check(r.id === spec.id && r.session_id === p.p_session && r.customer_id === p.p_customer && r.sale_type === p.p_type && r.cashier_id === actor.id && r.cashier_name === actor.full_name && r.tracking_code === p.p_tracking && r.status === 'completed', 'Sale snapshot identity mismatch.');
    money(r, ['subtotal', 'total'], 1000n); money(r, ['discount_total'], 0n);
    money(r, ['paid_total'], p.p_payments.length ? 1000n : 0n); money(r, ['debt_amount'], p.p_payments.length ? 0n : 1000n);
    const items = s.pos_sale_items.filter(i => i.sale_id === r.id), payments = s.pos_payments.filter(i => i.sale_id === r.id && i.kind === 'sale_payment');
    check(items.length === 1 && payments.length === p.p_payments.length, 'Partial/duplicate sale rows.');
    const i = items[0];
    check(i.product_id === PRODUCT && i.variant_id === null && i.target_kind === 'product' && i.sku === 'STG-SINGLE' && i.product_name === 'STAGING standalone item' && Number(i.quantity) === 1 && i.line_number === 1 && Number(i.discount_percent) === 0, 'Item snapshot mismatch.');
    money(i, ['base_unit_price', 'adjusted_unit_price', 'final_unit_price', 'line_total'], 1000n);
    for (const pay of payments) { check(pay.method_code === 'tbc' && pay.method_name === methods.tbc && pay.received_by === actor.id, 'Sale payment snapshot mismatch.'); money(pay, ['amount'], 1000n); }
    if (r.sale_type === 'wholesale') check(r.customer_name === `STAGING - CONCURRENCY FOLLOWUP ${run}` && r.customer_tax_code === null, 'Customer snapshot mismatch.');
  }
  for (const [id, spec] of repaySpecs) {
    const matches = s.pos_payments.filter(r => r.request_id === id);
    check(matches.length === (spec.id ? 1 : 0), 'Wrong request repayment count.');
    if (!spec.id) continue;
    const r = matches[0], p = spec.payload;
    check(r.id === spec.id && r.sale_id === p.p_sale && r.session_id === p.p_session && r.kind === 'repayment' && r.received_by === actor.id && r.method_code === p.p_method && r.method_name === methods[p.p_method], 'Repayment snapshot mismatch.');
    money(r, ['amount'], cents(p.p_amount));
  }
}
async function audit(except = new Set()) {
  const s = await snapshot();
  preserved(baseline, s); preserved(latest, s, except); auditIntegrity(s); auditAllowed(s); auditSpecs(s);
  for (const id of except) {
    const old = latest.pos_register_sessions.find(r => r.id === id), next = s.pos_register_sessions.find(r => r.id === id);
    const strip = r => { const { status, closed_at, expected_closing_cash, actual_closing_cash, cash_difference, closing_note, ...rest } = r; return rest; };
    same(strip(old), strip(next), 'Close changed session opening history.');
  }
  latest = s;
  await record('AUDIT', { counts: Object.fromEntries(TABLES.map(t => [t, s[t].length])) });
  return s;
}
function expectBalance(amount) { near(sum(latest.pos_customer_transactions.filter(r => r.customer_id === customer), 'amount'), amount); }
function expectClose(session, amount) {
  const s = latest.pos_register_sessions.find(r => r.id === session);
  verifyClosedSession(s, `STAGING FOLLOWUP ${run}`); money(s, ['expected_closing_cash', 'actual_closing_cash'], cents(amount)); money(s, ['cash_difference'], 0n);
}
function remember(map, payload, response) {
  const id = ok(response); check(UUID.test(id), 'Expected a returned UUID.'); map.set(payload.p_request, { payload, id }); return id;
}

// Dependency injection allows testing failure/drain paths with no network.
export async function heldRace({ acquire, release, schedule }) {
  const pending = [];
  const start = job => {
    const p = Promise.resolve().then(job).catch(() => ({ data: null, error: { code: 'NETWORK_UNKNOWN' } }));
    pending.push(p); return p;
  };
  let failure, observation;
  try { await acquire(); observation = await schedule(start); }
  catch (error) { failure = error; }
  finally {
    try { await release(); } catch (error) { failure ??= error; }
  }
  const responses = await Promise.all(pending);
  if (failure) throw failure;
  return { responses, observation };
}
export function reaches(edges, from, target, seen = new Set()) {
  if (seen.has(from)) return false;
  seen.add(from);
  return (edges.find(e => e.pid === from)?.blockers ?? []).some(p => p === target || reaches(edges, p, target, seen));
}
async function graph() {
  // Return only PID/lock edges and fixed operation categories, never SQL text/parameters.
  return (await control.observer.query(`select pid, pg_catalog.pg_blocking_pids(pid) as blockers,
    case when query like '%"pos_complete_sale"%' or query like '%public.pos_complete_sale%' then 'sale'
      when query like '%"pos_record_repayment"%' or query like '%public.pos_record_repayment%' then 'repayment'
      when query like '%"pos_close_register"%' or query like '%public.pos_close_register%' then 'close'
      else 'other' end as operation
    from pg_catalog.pg_stat_activity where cardinality(pg_catalog.pg_blocking_pids(pid))>0`)).rows;
}
async function waitGraph(predicate) {
  const until = performance.now() + 1800;
  do {
    const edges = await graph();
    if (predicate(edges)) return edges;
    await delay(25);
  } while (performance.now() < until);
  throw new SmokeFailure('Required database dependency was not observed; outcomes may have committed. Inspect journal, never retry automatically.');
}
async function acquire(kind, id) {
  await control.holder.query('begin');
  control.pid = (await control.holder.query('select pg_backend_pid() as pid')).rows[0].pid;
  await control.holder.query("set local lock_timeout='2s'");
  await control.holder.query("set local statement_timeout='10s'");
  await control.holder.query("set local idle_in_transaction_session_timeout='10s'");
  if (kind === 'advisory') await control.holder.query('select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))', [id]);
  else {
    const table = { sale: 'pos_sales', customer: 'pos_business_customers', session: 'pos_register_sessions' }[kind];
    check(table && (kind === 'customer' ? id === customer : kind === 'session' ? sessions.has(id) && id !== HISTORY : [...saleSpecs.values()].some(s => s.id === id)), 'Only new fixture rows may be locked.');
    const r = await control.holder.query(`select id from public.${table} where id=$1 for update`, [id]);
    check(r.rows.length === 1, 'Lock target missing.');
  }
}
async function sessionIsLocked(session) {
  check(sessions.has(session) && session !== HISTORY, 'Historical lock prohibited.');
  // The sole blocked operation reached its later sale/customer lock. NOWAIT
  // proves the earlier session row is still locked; the next close edge then
  // attributes that dependency to the exact operation PID, not launch order.
  let blocked = false;
  await control.observer.query('begin');
  try { await control.observer.query('select id from public.pos_register_sessions where id=$1 for update nowait', [session]); }
  catch (error) { if (error.code === '55P03') blocked = true; else throw new SmokeFailure('Session-lock probe failed.'); }
  finally { await control.observer.query('rollback'); }
  check(blocked, 'Operation did not retain the session lock.');
}
async function race(label, kind, id, schedule) {
  stage = label;
  await confirm(`RACE ${label}`);
  await record('BEFORE_RACE', { label, lock_kind: kind, lock_id: id });
  const outcome = await heldRace({ acquire: () => acquire(kind, id), release: () => control.holder.query('rollback'), schedule });
  await record('RACE_RESULTS', { label, responses: outcome.responses.map(responseSummary), observation: outcome.observation });
  observed[label] = outcome.observation;
  return outcome.responses;
}
async function duplicates(label, payload, name, conflict, id) {
  await record('PLANNED_RACE', { label, rpc: name, request_id: payload.p_request, session_id: payload.p_session, sale_id: payload.p_sale });
  const responses = await race(label, 'advisory', payload.p_request, async start => {
    start(() => rpc(name, payload)); start(() => rpc(name, payload));
    if (conflict) start(() => rpc(name, conflict));
    const edges = await waitGraph(g => g.filter(e => reaches(g, e.pid, control.pid)).length >= (conflict ? 3 : 2));
    await record('DEPENDENCIES', { label, edges }); return edges;
  });
  const first = ok(responses[0]); check(UUID.test(first) && ok(responses[1]) === first && (!id || first === id), 'Duplicate requests did not return one identity.');
  if (conflict) denied(responses[2], 'REQUEST_CONFLICT');
  return responses[0];
}
async function operationBeforeClose(label, kind, lockId, session, name, payload, cash) {
  await record('PLANNED_RACE', { label, rpc: name, request_id: payload.p_request, session_id: session, sale_id: payload.p_sale });
  await confirm(`FINAL CLOSE ${label} CASH ${cash}`);
  return race(label, kind, lockId, async start => {
    start(() => rpc(name, payload));
    const first = await waitGraph(g => g.filter(e => e.blockers.includes(control.pid)).length === 1);
    const op = first.find(e => e.blockers.includes(control.pid));
    check(op.operation === (name === 'pos_complete_sale' ? 'sale' : 'repayment'), 'Unexpected operation owns dependency.');
    await sessionIsLocked(session);
    start(() => rpc('pos_close_register', closing(session, cash)));
    const edges = await waitGraph(g => g.some(e => e.operation === 'close' && reaches(g, e.pid, op.pid)) && reaches(g, op.pid, control.pid));
    await record('DEPENDENCIES', { label, operation_pid: op.pid, edges }); return edges;
  });
}
async function postClose(session, debtSale, replaySale, replayRepay, cash) {
  stage = 'post_close_checks';
  const s = sale(session), p = repayment(session, debtSale, '0.01');
  saleSpecs.set(s.p_request, { payload: s, id: null }); repaySpecs.set(p.p_request, { payload: p, id: null });
  denied(await rpc('pos_complete_sale', s), 'OPEN_SESSION_REQUIRED');
  denied(await rpc('pos_record_repayment', p), 'OPEN_SESSION_REQUIRED');
  await confirm(`VERIFY CLOSED SESSION ${session} REJECTS CLOSE`);
  denied(await rpc('pos_close_register', closing(session, cash)), 'SESSION_CLOSED');
  check(ok(await rpc('pos_complete_sale', replaySale.payload)) === replaySale.id, 'Closed successful sale replay changed identity.');
  check(ok(await rpc('pos_record_repayment', replayRepay.payload)) === replayRepay.id, 'Closed successful repayment replay changed identity.');
  denied(await rpc('pos_complete_sale', { ...replaySale.payload, p_tracking: replaySale.payload.p_tracking + '-CONFLICT' }), 'REQUEST_CONFLICT');
  denied(await rpc('pos_record_repayment', { ...replayRepay.payload, p_amount: '1.00' }), 'REQUEST_CONFLICT');
  await audit();
}
async function openSession(register) {
  check(!latest.pos_register_sessions.some(s => s.cashier_id === actor.id && s.status === 'open'), 'Cashier already has open session.');
  const id = ok(await rpc('pos_open_register', { p_register: register, p_cash: '0.00' }));
  check(UUID.test(id) && id !== HISTORY && !sessions.has(id), 'Unexpected opened session identity.');
  sessions.add(id); await record('SESSION_CREATED', { session_id: id, register_id: register });
  await audit();
  const opened = latest.pos_register_sessions.find(s => s.id === id);
  check(opened?.status === 'open' && opened.register_id === register && opened.closed_at === null, 'New session readback mismatch.');
  return id;
}
async function fixtures() {
  stage = 'fixture_creation'; await confirm('CREATE NEW STAGING FOLLOWUP FIXTURES');
  customer = randomUUID(); const ids = ['A', 'B', 'C'].map(() => randomUUID());
  for (const id of ids) registers.add(id);
  await record('BEFORE_FIXTURES', { customer_id: customer, register_ids: ids });
  await result(admin.from('pos_business_customers').insert({ id: customer, name: `STAGING - CONCURRENCY FOLLOWUP ${run}`, active: true }), 'Customer setup outcome uncertain; inspect journal.');
  for (const [i, id] of ids.entries()) {
    await record('BEFORE_REGISTER', { register_id: id });
    await result(admin.from('pos_registers').insert({ id, name: `STAGING - CONCURRENCY FOLLOWUP ${['A','B','C'][i]} ${run}`, active: true }), 'Register setup outcome uncertain; inspect journal.');
  }
  await record('BEFORE_PRICE', { customer_id: customer, product_id: PRODUCT });
  check(await result(admin.rpc('pos_set_customer_prices', { p_customer: customer, p_rows: [{ kind: 'product', target: PRODUCT, price: '10.00' }] }), 'Price setup outcome uncertain; inspect journal.') === 1, 'Expected one customer price.');
  await audit();
  check(latest.pos_business_customers.some(r => r.id === customer) && ids.every(id => latest.pos_registers.some(r => r.id === id)) && latest.pos_customer_prices.filter(r => r.customer_id === customer).length === 1, 'Incomplete fixture setup.');
  return ids;
}

async function main() {
  console.log(`STAGING ONLY: ${REFERENCE}. Historical session ${HISTORY} is read-only.`);
  check((await prompt('Copy nexo-staging project reference: ')).trim() === REFERENCE, 'Wrong staging reference; no network call made.');
  await confirm('nexo-staging');
  run = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'nexo-staging-followup-'));
  const path = join(directory, `${run}.jsonl`);
  journal = await open(path, 'wx', 0o600);
  console.log(`Sanitized durable journal: ${path}`);
  await record('RUN_CREATED', { historical_session_id: HISTORY });
  const key = (await prompt('Staging publishable/anon key (hidden): ', true)).trim(); publicKeyOnly(key, REFERENCE);
  ({ client: cashier, profile: actor } = await login(key, 'cashier')); ({ client: admin } = await login(key, 'admin'));
  identifiers.cashier_id = actor.id;
  baseline = latest = await snapshot(); auditIntegrity(baseline);
  const historical = baseline.pos_register_sessions.find(r => r.id === HISTORY);
  check(historical?.cashier_id === actor.id, 'Historical cashier mismatch.');
  verifyClosedSession(historical, 'STAGING final concurrency close; actual cash 121.00');
  money(historical, ['expected_closing_cash', 'actual_closing_cash'], 12100n); money(historical, ['cash_difference'], 0n);
  check(!baseline.pos_register_sessions.some(s => s.cashier_id === actor.id && s.status === 'open'), 'Cashier has an open session; stop without changes.');
  const product = await result(cashier.from('products').select('id,sku,name,price,active').eq('id', PRODUCT).single(), 'Seed lookup failed.');
  check(product.active && product.sku === 'STG-SINGLE' && product.name === 'STAGING standalone item' && cents(product.price) === 1000n, 'Staging seed mismatch.');
  for (const code of ['cash','tbc']) { const method = await result(cashier.from('pos_payment_methods').select('name,active').eq('code', code).single(), 'Method lookup failed.'); check(method.active, 'Method inactive.'); methods[code] = method.name; }
  stage = 'lock_control_connection'; control = await controls();
  await record('READY', { historical_session_id: HISTORY, cashier_id: actor.id,
    mid_write_failure_injection: 'UNTESTED_NO_RELIABLE_SAFE_INPUT_IDENTIFIED', lock_timeout_55P03: 'NOT_CERTIFIED' });
  const [ra, rb, rc] = await fixtures();
  const a = await openSession(ra);
  const debt = sale(a, true, false);
  remember(saleSpecs, debt, await rpc('pos_complete_sale', debt)); await audit(); expectBalance(10);
  const debtId = saleSpecs.get(debt.p_request).id;
  const retail = sale(a);
  remember(saleSpecs, retail, await duplicates('A_FIRST_SALE_DUPLICATES', retail, 'pos_complete_sale'));
  await audit(); expectBalance(10);
  await duplicates('A_SALE_RETRY_CONFLICT', retail, 'pos_complete_sale', { ...retail, p_tracking: retail.p_tracking + '-CONFLICT' }, saleSpecs.get(retail.p_request).id); await audit();
  const cash = repayment(a, debtId, '4.00', 'cash');
  remember(repaySpecs, cash, await duplicates('A_FIRST_REPAYMENT_DUPLICATES', cash, 'pos_record_repayment'));
  await audit(); expectBalance(6);
  await duplicates('A_REPAYMENT_RETRY_CONFLICT', cash, 'pos_record_repayment', { ...cash, p_amount: '3.00' }, repaySpecs.get(cash.p_request).id); await audit();
  await record('COVERAGE_LIMIT', { mid_write_failure_injection: 'UNTESTED_NO_RELIABLE_SAFE_INPUT_IDENTIFIED' });
  const part = repayment(a, debtId, '2.00');
  const ar = await operationBeforeClose('A_REPAYMENT_BEFORE_CLOSE', 'sale', debtId, a, 'pos_record_repayment', part, '4.00');
  remember(repaySpecs, part, ar[0]); check(cents(ok(ar[1])) === 400n, 'Wrong A close result.');
  await audit(new Set([a])); expectClose(a, '4.00'); expectBalance(4);
  await postClose(a, debtId, saleSpecs.get(retail.p_request), repaySpecs.get(cash.p_request), '4.00');

  const b = await openSession(rb), wholesale = sale(b, true, true);
  const br = await operationBeforeClose('B_SALE_BEFORE_CLOSE', 'customer', customer, b, 'pos_complete_sale', wholesale, '0.00');
  remember(saleSpecs, wholesale, br[0]); check(cents(ok(br[1])) === 0n, 'Wrong B close result.');
  await audit(new Set([b])); expectClose(b, '0.00'); expectBalance(4);
  await postClose(b, debtId, saleSpecs.get(wholesale.p_request), repaySpecs.get(part.p_request), '0.00');

  const c = await openSession(rc), cs = sale(c), cp = repayment(c, debtId, '2.00');
  await record('PLANNED_RACE', { label: 'C_CLOSE_BEFORE_OPERATIONS', session_id: c, sale_request_id: cs.p_request, repayment_request_id: cp.p_request, sale_id: debtId });
  await confirm('FINAL CLOSE C CASH 0.00');
  let closeFirst = false;
  const cr = await race('C_CLOSE_BEFORE_OPERATIONS', 'session', c, async start => {
    start(() => rpc('pos_close_register', closing(c, '0.00')));
    const first = await waitGraph(g => g.filter(e => e.blockers.includes(control.pid) && e.operation === 'close').length === 1);
    const closePid = first.find(e => e.blockers.includes(control.pid) && e.operation === 'close').pid;
    start(() => rpc('pos_complete_sale', cs)); start(() => rpc('pos_record_repayment', cp));
    start(() => rpc('pos_close_register', closing(c, '0.00')));
    let edges = [];
    try {
      edges = await waitGraph(g => g.filter(e => e.pid !== closePid && reaches(g, e.pid, closePid)).length >= 3);
      closeFirst = edges.some(e => e.operation === 'sale' && reaches(edges,e.pid,closePid)) && edges.some(e => e.operation === 'repayment' && reaches(edges,e.pid,closePid)) && edges.some(e => e.pid !== closePid && e.operation === 'close' && reaches(edges,e.pid,closePid));
    } catch { closeFirst = false; }
    await record('DEPENDENCIES', { label: 'C_CLOSE_BEFORE_OPERATIONS', close_pid: closePid, close_first_proven: closeFirst, edges });
    return { close_first_proven: closeFirst, edges };
  });
  const closes = [cr[0], cr[3]];
  check(closes.filter(r => !r.error).length === 1, 'Exactly one C close must succeed.');
  for (const r of closes) { if (r.error) denied(r,'SESSION_CLOSED'); else check(cents(ok(r)) === 0n,'Wrong C close cash.'); }
  if (cr[1].error) { denied(cr[1], 'OPEN_SESSION_REQUIRED'); saleSpecs.set(cs.p_request, { payload: cs, id: null }); }
  else { remember(saleSpecs, cs, cr[1]); closeFirst = false; }
  if (cr[2].error) { denied(cr[2], 'OPEN_SESSION_REQUIRED'); repaySpecs.set(cp.p_request, { payload: cp, id: null }); }
  else { remember(repaySpecs, cp, cr[2]); closeFirst = false; }
  await audit(new Set([c])); expectClose(c, '0.00'); expectBalance(cr[2].error ? 4 : 2);
  await postClose(c, debtId, saleSpecs.get(retail.p_request), repaySpecs.get(cash.p_request), '0.00');
  for (const id of sessions) check(latest.pos_register_sessions.find(s => s.id === id)?.status === 'closed', 'Run session remains open.');
  await record('FINAL', { result: closeFirst ? 'PASS_WITH_COVERAGE_LIMITS' : 'COVERAGE_OUTSTANDING',
    customer_id: customer, register_ids: [...registers], session_ids: [...sessions], close_first_proven: closeFirst,
    remaining_test_customer_balance: cr[2].error ? '4.00' : '2.00',
    mid_write_failure_injection: 'UNTESTED', runtime_lock_timeout_55P03: 'NOT_CERTIFIED', observed });
  console.log('STOP. All new sessions closed. Preserve all records and journal; no cleanup or historical changes.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async error => {
    const summary = { result: 'STOP', ...identifiers, customer_id: customer, session_ids: [...sessions],
      ...(controlDiagnostics.get(error) ?? {}), message: error instanceof SmokeFailure ? error.message : 'Unexpected failure; inspect durable journal and staging read-only. Never rerun automatically.' };
    try { await record('STOP', summary); } catch { console.error(JSON.stringify(summary)); }
    process.exitCode = 1;
  }).finally(async () => {
    if (control) {
      await control.holder.query('rollback').catch(() => {});
      await Promise.allSettled([control.holder.end(), control.observer.end()]);
    }
    if (journal) await journal.close();
  });
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
  const host = (await prompt("Verified staging SESSION pooler host (hidden): ", true)).trim();
  const user = (await prompt("Staging database username from Dashboard Connect (hidden): ", true)).trim();
  const direct = host === `db.${REFERENCE}.supabase.co` && user === "postgres";
  const pooler = /^[a-z0-9-]+[.]pooler[.]supabase[.]com$/.test(host) && user === `postgres.${REFERENCE}`;
  check(!direct && pooler && host === "aws-1-eu-west-1.pooler.supabase.com", "Database host/username do not identify the pinned staging project.");
  mode = direct ? "direct" : "session_pooler";
  check((await prompt("Database port (must be 5432, not transaction pooler 6543): ")).trim() === "5432", "Use port 5432 direct/session pooling.");
  const password = await prompt("Staging DATABASE password (hidden; not an Auth/service-role key): ", true);
  const trust = (await prompt("Local staging CA PEM certificate path (required): ")).trim();
  connectionStage = "ca_load";
  check(trust !== "system", "Use the downloaded staging CA file for this follow-up."); const ssl = { rejectUnauthorized: true, ca: await readFile(trust, "utf8") };
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
    const identity = await observer.query("select id, cashier_id from public.pos_register_sessions where id=$1", [HISTORY]);
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

