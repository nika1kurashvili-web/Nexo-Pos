import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { heldRace, reaches, auditIntegrity, responseSummary } from '../scripts/staging-concurrency-followup.mjs';

test('outcome logging never includes raw server messages, bodies, tokens or stacks', () => {
  const raw = { data: 'private token', error: { code: 'P0001', message: 'secret password', stack:'secret stack', body:'secret body' } };
  assert.equal(JSON.stringify(responseSummary(raw)), '{"code":"P0001"}');
  assert.deepEqual(responseSummary({data:null,error:{code:'P0001',message:'REQUEST_CONFLICT'}}),
    {code:'P0001',outcome:'REQUEST_CONFLICT',id:undefined,close_cash:undefined});
});

test('race releases before draining every operation after observation failure', async () => {
  const events = []; let finish;
  await assert.rejects(heldRace({
    acquire: async () => events.push('acquire'),
    release: async () => { events.push('release'); finish(); },
    schedule: async start => {
      start(async () => { await new Promise(r => { finish = r; }); events.push('finished'); return { data: 'id' }; });
      await Promise.resolve(); throw new Error('observation failed');
    },
  }), /observation failed/);
  assert.deepEqual(events, ['acquire','release','finished']);
});
test('race drains successful, rejected, and delayed jobs, including release failure', async () => {
  let completed = false;
  await assert.rejects(heldRace({ acquire: async () => {}, release: async () => { throw new Error('release failure'); },
    schedule: async start => { start(async () => { throw new Error('network'); }); start(async () => { await new Promise(r => setTimeout(r,5)); completed = true; }); },
  }), /release failure/);
  assert.equal(completed,true);
});
test('failed acquire still attempts release and never dispatches', async () => {
  let released = false, dispatched = false;
  await assert.rejects(heldRace({ acquire: async () => { throw new Error('lock failed'); }, release: async () => { released = true; }, schedule: async () => { dispatched = true; } }), /lock failed/);
  assert.equal(released,true); assert.equal(dispatched,false);
});
test('successful overlap returns outcomes in dispatch order and observation', async () => {
  const r = await heldRace({ acquire: async () => {}, release: async () => {}, schedule: async start => {
    start(async () => ({ data:'one' })); start(async () => { throw new Error('secret raw network error'); }); return { pid: 42 };
  } });
  assert.deepEqual(r, { responses:[{data:'one'},{data:null,error:{code:'NETWORK_UNKNOWN'}}], observation:{pid:42} });
});
test('dependency proof requires actual edges, tolerates cycles without inventing order', () => {
  const g = [{pid:1,blockers:[9]},{pid:2,blockers:[1]},{pid:3,blockers:[2]}];
  assert.equal(reaches(g,3,1),true); assert.equal(reaches(g,1,3),false);
  assert.equal(reaches([{pid:1,blockers:[2]},{pid:2,blockers:[1]}],1,9),false);
  assert.equal(reaches([{pid:1,blockers:[9]},{pid:2,blockers:[9]}],2,1),false);
});
function fixture() {
  return {
    pos_registers:[{id:'r'}],pos_business_customers:[{id:'c'}],pos_customer_prices:[],
    pos_register_sessions:[{id:'session',register_id:'r',cashier_id:'cashier',status:'open',opening_cash:0}],
    pos_sales:[{id:'s',request_id:'req',sale_number:1,session_id:'session',sale_type:'wholesale',customer_id:'c',total:10,paid_total:4,debt_amount:6}],
    pos_sale_items:[{id:'i',sale_id:'s',line_number:1,quantity:1,final_unit_price:10,line_total:10}],
    pos_payments:[{id:'p',request_id:'pay',sale_id:'s',session_id:'session',kind:'sale_payment',method_code:'cash',amount:4}],
    pos_customer_transactions:[{id:'charge',customer_id:'c',sale_id:'s',payment_id:null,kind:'sale_charge',amount:10},
      {id:'paid',customer_id:'c',sale_id:'s',payment_id:'p',kind:'sale_payment',amount:-4}],
  };
}
test('financial audit accepts a consistent partial wholesale sale and valid cash close', () => {
  const f = fixture(); auditIntegrity(f);
  Object.assign(f.pos_register_sessions[0], { status:'closed',opening_cash:0,expected_closing_cash:4,actual_closing_cash:4,cash_difference:0,
    opened_at:'2026-09-30T10:00:00Z',closed_at:'2026-09-30T11:00:00Z',closing_note:'test' });
  auditIntegrity(f);
});
test('financial audit rejects partial rows, orphan links, duplicated requests and altered totals', () => {
  const mutations = [
    f => { f.pos_sale_items=[]; },
    f => { f.pos_customer_transactions.pop(); },
    f => { f.pos_payments[0].sale_id='absent'; },
    f => { f.pos_sales.push({...f.pos_sales[0],id:'duplicate'}); },
    f => { f.pos_sale_items.push({...f.pos_sale_items[0],id:'duplicate'}); },
    f => { f.pos_customer_transactions[1].amount=-3; },
    f => { f.pos_sales[0].total=11; },
    f => { f.pos_register_sessions.push({...f.pos_register_sessions[0],id:'second'}); },
  ];
  for (const mutate of mutations) { const f=fixture(); mutate(f); assert.throws(()=>auditIntegrity(f)); }
});
test('source safety gates: pinned pooler, strict CA, no historical mutation or owner DML', async () => {
  const source = await readFile(new URL('../scripts/staging-concurrency-followup.mjs',import.meta.url),'utf8');
  assert.match(source,/aws-1-eu-west-1\.pooler\.supabase\.com/);
  assert.match(source,/rejectUnauthorized: true, ca: await readFile/);
  assert.doesNotMatch(source,/rejectUnauthorized:\s*false/);
  assert.match(source,/payload\.p_session !== HISTORY/);
  assert.match(source,/journal\.sync\(\)/);
  for (const call of source.matchAll(/\.query\((['"`])([\s\S]*?)\1/g)) {
    assert.doesNotMatch(call[2],/\b(insert\s+into|delete\s+from|update\s+public|alter\s+|create\s+|drop\s+|set\s+role)\b/i);
  }
  assert.match(source,/await confirm\('CREATE NEW STAGING FOLLOWUP FIXTURES'\)/);
  assert.match(source,/await confirm\(`FINAL CLOSE/);
  assert.match(source,/await confirm\(`RACE/);
});
