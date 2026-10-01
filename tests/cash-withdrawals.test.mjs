import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { validWithdrawal } from '../lib/pos/cash-withdrawal.ts';

const migration = '202610010002_pos_cash_withdrawals.sql';
const load = file => readFile(new URL('../'+file, import.meta.url),'utf8');

test('cash withdrawals: real SQL, financial invariants, isolation and compatibility (in-memory only)', async t => {
  const db = new PGlite();
  const q = async (sql,args=[]) => (await db.query(sql,args)).rows;
  const asUser = async (id,sql,args=[],role='authenticated') => db.transaction(async tx => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",[id ?? '',role]);
    return (await tx.query(sql,args)).rows;
  });
  const rpc = async (actor,fn,args=[]) => (await asUser(actor,`select public.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args))[0].result;
  const createUser = async marker => {
    const id=randomUUID();
    await q('insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values($1,$2,$3,$4)',
      [id,id+'@example.invalid',JSON.stringify({nexo_memberships:marker}),JSON.stringify({full_name:'Local Fixture'})]);
    return id;
  };
  const createSession = async (actor,amount='100') => {
    const r=(await q('insert into pos_registers(name) values($1) returning id',['Local '+randomUUID()]))[0].id;
    return { register:r, session:await rpc(actor,'pos_open_register',[r,amount]) };
  };
  const withdraw = (actor,session,amount='10',reason='ხარჯი',request=randomUUID()) => rpc(actor,'pos_record_cash_withdrawal',[request,session,amount,reason]);
  const count = async () => Number((await q('select count(*) n from pos_cash_withdrawals'))[0].n);
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
      grant usage on schema auth to authenticated,service_role;`);
    for (const file of ['supabase/staging/000_shared_pre_pos_bootstrap.sql','supabase/migrations/202609260001_create_pos_profiles.sql',
      'supabase/prerequisites/202609280001_explicit_app_memberships.sql','supabase/migrations/202609260002_pos_phase1.sql',
      'supabase/migrations/202609300001_pos_register_visibility.sql','supabase/migrations/202609300002_pos_register_last_close.sql',
      'supabase/migrations/202610010001_pos_employee_management.sql']) await db.exec(await load(file));
    const admin=await createUser({version:1,pos:'admin'}), cashier=await createUser({version:1,pos:'cashier'});
    const other=await createUser({version:1,pos:'cashier'}), inactive=await createUser({version:1,pos:'cashier'});
    const orders=await createUser({version:1,orders:'operator'});
    await q('update pos_profiles set active=false where id=$1',[inactive]);
    const historical=await createSession(admin,'42');
    await rpc(admin,'pos_close_register',[historical.session,'41','Historical fixture']);
    const historicalBefore=await q('select * from pos_register_sessions where id=$1',[historical.session]);
    const memberships=await q('select * from profiles order by id');
    const policies=await q('select * from pg_policies order by schemaname,tablename,policyname');
    const financeDefinitions=await q("select pg_get_functiondef(oid) definition from pg_proc where proname in ('pos_complete_sale','pos_record_repayment','pos_open_register') order by proname");
    await db.exec(await load('supabase/migrations/'+migration));
    const own=await createSession(cashier), adminSession=await createSession(admin), otherSession=await createSession(other);
    let withdrawalId; const request=randomUUID();

    await t.test('cashier/admin own-session withdrawal, trimming, snapshots and aggregate formula',async()=>{
      withdrawalId=await withdraw(cashier,own.session,'10.00',' \tტრანსპორტირება\n ',request);
      const row=(await q('select * from pos_cash_withdrawals where id=$1',[withdrawalId]))[0];
      assert.equal(row.reason,'ტრანსპორტირება'); assert.equal(row.register_id,own.register); assert.equal(row.actor_id,cashier);
      assert.equal(row.actor_name,'Local Fixture'); assert.equal(Number(row.amount),10);
      await withdraw(admin,adminSession.session,'5');
      const state=(await rpc(cashier,'pos_register_state')).find(r=>r.session_id===own.session);
      assert.equal(state.cash_withdrawals,10); assert.equal(state.expected_cash,90);
      await q("update pos_profiles set full_name='Renamed' where id=$1",[cashier]);
      await q("update pos_registers set name='Renamed Register' where id=$1",[own.register]);
      assert.equal((await q('select actor_name from pos_cash_withdrawals where id=$1',[withdrawalId]))[0].actor_name,'Local Fixture');
    });
    await t.test('access: unknown/closed/foreign sessions, inactive, Orders-only and anon rejected',async()=>{
      for(const [actor,session] of [[cashier,randomUUID()],[cashier,null],[cashier,historical.session],[cashier,otherSession.session],[admin,own.session]]) {
        await assert.rejects(withdraw(actor,session),/OPEN_SESSION_REQUIRED/);
      }
      for(const actor of [inactive,orders]) await assert.rejects(withdraw(actor,own.session),/POS_ACCESS_DENIED/);
      await assert.rejects(asUser(null,'select public.pos_record_cash_withdrawal($1,$2,$3,$4)',[randomUUID(),own.session,'1','test'],'anon'),/permission denied/);
    });
    await t.test('strict decimal/reason/request validation creates no rows',async()=>{
      const before=await count();
      for(const amount of ['0','-1','NaN','Infinity','1e2','1,00','1.001','1.000','10000000000','',null]) {
        await assert.rejects(withdraw(cashier,own.session,amount),/INVALID_DECIMAL/);
      }
      for(const reason of ['', ' \n\t ', 'ა'.repeat(501),null]) await assert.rejects(withdraw(cashier,own.session,'1',reason),/INVALID_WITHDRAWAL_REASON/);
      await assert.rejects(withdraw(cashier,own.session,'1','test',null),/REQUEST_ID_REQUIRED/);
      await assert.rejects(withdraw(cashier,'bad-session'),/invalid input syntax/);
      assert.equal(await count(),before);
    });
    await t.test('exact normalized retry is idempotent and changed payload/actor conflicts',async()=>{
      const before=await count();
      assert.equal(await withdraw(cashier,own.session,'010','ტრანსპორტირება',request),withdrawalId);
      for(const args of [[cashier,own.session,'11','ტრანსპორტირება'],[cashier,own.session,'10','changed'],[cashier,otherSession.session,'10','ტრანსპორტირება'],[other,own.session,'10','ტრანსპორტირება']]) {
        await assert.rejects(withdraw(...args,request),/REQUEST_CONFLICT/);
      }
      assert.equal(await count(),before);
    });
    await t.test('cash sale/split payment and cash repayment count; card repayments do not',async()=>{
      const product=(await q("select id from products where sku='STG-SINGLE'"))[0].id;
      const customer=(await q("insert into pos_business_customers(name) values('Local Customer') returning id"))[0].id;
      await rpc(admin,'pos_set_customer_prices',[customer,JSON.stringify([{kind:'product',target:String(product),price:'30'}])]);
      const sale=await rpc(cashier,'pos_complete_sale',[randomUUID(),own.session,'wholesale',customer,'LOCAL',
        JSON.stringify([{kind:'product',target:String(product),quantity:'1'}]),JSON.stringify([{method:'cash',amount:'5'},{method:'tbc',amount:'5'}])]);
      await rpc(cashier,'pos_record_repayment',[randomUUID(),sale,own.session,'cash','10']);
      await rpc(cashier,'pos_record_repayment',[randomUUID(),sale,own.session,'tbc','10']);
      const state=(await rpc(cashier,'pos_register_state')).find(r=>r.session_id===own.session);
      assert.equal(state.cash_payments,15); assert.equal(state.cash_withdrawals,10); assert.equal(state.expected_cash,105);
      assert.equal(Number((await q('select sum(amount) n from pos_customer_transactions where sale_id=$1',[sale]))[0].n),0);
      assert.equal((await q('select * from pos_payments where sale_id=$1',[sale])).length,4);
    });
    await t.test('overdraw rejected; queued competing withdrawals cannot spend the same cash twice',async()=>{
      await assert.rejects(withdraw(cashier,own.session,'105.01'),/INSUFFICIENT_CASH/);
      // PGlite serializes connections; tests both operations, not real lock waits.
      const outcomes=await Promise.allSettled([withdraw(cashier,own.session,'80'),withdraw(cashier,own.session,'80')]);
      assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
      assert.match(outcomes.find(r=>r.status==='rejected').reason.message,/INSUFFICIENT_CASH/);
      assert.equal((await rpc(cashier,'pos_register_state')).find(r=>r.session_id===own.session).expected_cash,25);
      const duplicate=randomUUID(), before=await count();
      const ids=await Promise.all([withdraw(cashier,own.session,'5','duplicate',duplicate),withdraw(cashier,own.session,'5.00',' duplicate ',duplicate)]);
      assert.equal(ids[0],ids[1]); assert.equal(await count(),before+1);
    });
    await t.test('RLS, immutability, private helper and admin history',async()=>{
      const ownRows=await asUser(cashier,'select * from pos_cash_withdrawals');
      assert.ok(ownRows.length>0); assert.ok(ownRows.every(r=>r.actor_id===cashier));
      assert.equal((await asUser(other,'select * from pos_cash_withdrawals')).length,0);
      assert.equal((await asUser(orders,'select * from pos_cash_withdrawals')).length,0);
      assert.equal((await asUser(admin,'select * from pos_cash_withdrawals')).length,await count());
      for(const sql of ['delete from pos_cash_withdrawals','update pos_cash_withdrawals set amount=1','insert into pos_cash_withdrawals default values','truncate pos_cash_withdrawals']) {
        await assert.rejects(asUser(cashier,sql),/permission denied/);
      }
      await assert.rejects(q('delete from pos_cash_withdrawals'),/CASH_WITHDRAWAL_IMMUTABLE/);
      await assert.rejects(q('update pos_cash_withdrawals set reason=reason'),/CASH_WITHDRAWAL_IMMUTABLE/);
      await assert.rejects(q('truncate pos_cash_withdrawals'),/CASH_WITHDRAWAL_IMMUTABLE/);
      await assert.rejects(asUser(admin,'select * from public.pos_session_cash_totals($1)',[own.session]),/permission denied/);
      await assert.rejects(rpc(cashier,'pos_register_session_report'),/POS_ACCESS_DENIED/);
      const report=await rpc(admin,'pos_register_session_report');
      const row=report.sessions.find(s=>s.id===own.session);
      assert.equal(row.cash_payments,15); assert.equal(row.cash_withdrawals,95); assert.equal(row.expected_cash,20);
    });
    await t.test('close/last-close/history and post-close replay remain correct',async()=>{
      assert.equal(Number(await rpc(cashier,'pos_close_register',[own.session,'19','Local close'])),20);
      const closed=(await rpc(admin,'pos_register_session_report')).sessions.find(s=>s.id===own.session);
      assert.equal(closed.expected_cash,20); assert.equal(closed.actual_closing_cash,19); assert.equal(closed.cash_difference,-1);
      const state=(await rpc(cashier,'pos_register_state')).find(r=>r.register_id===own.register);
      assert.equal(state.last_expected_closing_cash,20); assert.equal(state.last_actual_closing_cash,19); assert.ok(state.last_closed_at);
      await assert.rejects(withdraw(cashier,own.session,'1'),/OPEN_SESSION_REQUIRED/);
      assert.equal(await withdraw(cashier,own.session,'10','ტრანსპორტირება',request),withdrawalId);
      assert.deepEqual(await q('select * from pos_register_sessions where id=$1',[historical.session]),historicalBefore);
      assert.equal((await rpc(admin,'pos_register_session_report')).sessions.find(s=>s.id===historical.session).expected_cash,42);
      assert.deepEqual(await q('select * from profiles order by id'),memberships);
      assert.deepEqual(await q("select * from pg_policies where tablename<>'pos_cash_withdrawals' order by schemaname,tablename,policyname"),policies);
      assert.deepEqual(await q("select pg_get_functiondef(oid) definition from pg_proc where proname in ('pos_complete_sale','pos_record_repayment','pos_open_register') order by proname"),financeDefinitions);
    });
    await t.test('metadata: forced RLS, restrict FKs, definer paths and limited grants',async()=>{
      assert.deepEqual((await q("select relrowsecurity,relforcerowsecurity from pg_class where oid='pos_cash_withdrawals'::regclass"))[0],{relrowsecurity:true,relforcerowsecurity:true});
      for(const fk of await q("select confdeltype from pg_constraint where conrelid='pos_cash_withdrawals'::regclass and contype='f'")) assert.equal(fk.confdeltype,'r');
      const funcs=await q("select prosecdef,proconfig from pg_proc where proname in ('pos_session_cash_totals','pos_record_cash_withdrawal','pos_close_register','pos_register_state','pos_register_session_report')");
      for(const f of funcs) { assert.equal(f.prosecdef,true);assert.ok(f.proconfig.includes('search_path=""')); }
      for(const role of ['anon','authenticated','service_role']) {
        for(const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE']) assert.equal((await q("select has_table_privilege($1,'pos_cash_withdrawals',$2) allowed",[role,privilege]))[0].allowed,false);
      }
    });
  } finally { await db.close(); }
});

test('cash withdrawal migration and UI static safety',async()=>{
  const files=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>/^\d+_.+\.sql$/.test(f));
  assert.equal(new Set(files.map(f=>f.split('_')[0])).size,files.length);
  const sql=await load('supabase/migrations/'+migration);
  assert.match(sql,/set lock_timeout='5s'/);
  assert.match(sql,/transaction_isolation[\s\S]*read committed/);
  const rpc=sql.slice(sql.indexOf('create function public.pos_record_cash_withdrawal'),sql.indexOf('create or replace function public.pos_close_register'));
  assert.ok(rpc.indexOf('for update')<rpc.indexOf('into available'));
  assert.ok(rpc.indexOf('pg_advisory_xact_lock')<rpc.indexOf('into previous'));
  assert.doesNotMatch(sql,/(?:update|insert into|delete from|alter table) public\.(profiles|products|product_variants)\b/i);
  assert.doesNotMatch(sql,/drop\s+(table|function)|disable row level security/i);
  const action=await load('app/(pos)/cash-withdrawal-action.ts');
  assert.ok(action.indexOf('await posClient()')<action.indexOf('client.rpc('));
  assert.match(action,/revalidatePath/); assert.doesNotMatch(action,/service_role|console\./);
  const ui=await load('app/components/cash-withdrawal-form.tsx');
  assert.match(ui,/useActionState/); assert.match(ui,/disabled=\{pending\}/);
  assert.match(ui,/request_id/); assert.match(ui,/readOnly=\{pending \|\| unknown\}/);
  assert.match(await load('app/(pos)/reports/register-sessions/[id]/page.tsx'),/await requireAdmin\(\)/);
  for(const amount of ['0','-1','1.001','1.000','NaN','1e2']) assert.equal(validWithdrawal(amount,'reason'),false);
  assert.equal(validWithdrawal('1.20',' trimmed '),true); assert.equal(validWithdrawal('1',' \n '),false);
});
