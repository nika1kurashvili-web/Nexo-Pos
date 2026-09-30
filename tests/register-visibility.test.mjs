import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('register visibility: hidden occupied registers, aggregate cash, admin history and unchanged permissions', async () => {
  const db = new PGlite();
  const a='00000000-0000-4000-8000-000000000001', b='00000000-0000-4000-8000-000000000002', admin='00000000-0000-4000-8000-000000000003', denied='00000000-0000-4000-8000-000000000004';
  const q = async (sql,args=[]) => (await db.query(sql,args)).rows;
  const actor = async (id,sql,args=[]) => db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[id]);
    return (await tx.query(sql,args)).rows;
  });
  const call = async (id,fn,args=[]) => (await actor(id,`select public.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args))[0].result;
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
      create table public.products(id bigint primary key,name text,sku text,price numeric,active boolean);
      create table public.product_variants(id text primary key,product_id bigint,name text,sku text,price numeric,active boolean);
      alter table public.products enable row level security; alter table public.product_variants enable row level security;
      create policy variants_select on public.product_variants for select to authenticated using(true);
      grant select on public.products,public.product_variants to authenticated;
      insert into public.products values(1,'Fake','TEST',10,true);`);
    for (const id of [a,b,admin,denied]) await q('insert into auth.users values($1)',[id]);
    for (const file of ['202609260001_create_pos_profiles.sql','202609260002_pos_phase1.sql']) await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
    for (const [id,role,name] of [[a,'cashier','Cashier A'],[b,'cashier','Cashier B'],[admin,'admin','Admin']]) await q('insert into pos_profiles(id,role,full_name) values($1,$2,$3)',[id,role,name]);
    const register=(await q("insert into pos_registers(name) values('Test') returning id"))[0].id;
    const session=await call(a,'pos_open_register',[register,'100']);
    assert.equal((await actor(b,'select * from pos_register_sessions')).length,0);
    await assert.rejects(call(b,'pos_open_register',[register,'0']),/duplicate key/);
    const policiesBefore=await q("select policyname,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname");
    await db.exec(await readFile(new URL('../supabase/migrations/202609300001_pos_register_visibility.sql',import.meta.url),'utf8'));
    assert.deepEqual(await q("select policyname,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname"),policiesBefore);
    const state=await call(b,'pos_register_state');
    assert.equal(state[0].session_id,session); assert.equal(state[0].cashier_name,'Cashier A'); assert.equal(state[0].can_close,false); assert.equal(state[0].is_own,false);
    assert.equal((await call(a,'pos_register_state'))[0].is_own,true);
    await assert.rejects(call(b,'pos_close_register',[session,'100',null]),/SESSION_ACCESS_DENIED/);
    await assert.rejects(call(b,'pos_register_session_report'),/POS_ACCESS_DENIED/);
    await assert.rejects(call(denied,'pos_register_state'),/POS_ACCESS_DENIED/);
    await db.transaction(async tx => { await tx.exec('set local role anon'); await assert.rejects(tx.query('select public.pos_register_state()'),/permission denied/); });
    const customer=(await q("insert into pos_business_customers(name) values('Test customer') returning id"))[0].id;
    await call(admin,'pos_set_customer_prices',[customer,JSON.stringify([{kind:'product',target:'1',price:'10'}])]);
    const sale=await call(a,'pos_complete_sale',['10000000-0000-4000-8000-000000000001',session,'wholesale',customer,null,JSON.stringify([{kind:'product',target:'1',quantity:'1'}]),JSON.stringify([{method:'cash',amount:'2'}])]);
    // A different actor's repayment is deliberately invisible via cashier RLS.
    await q("insert into pos_payments(request_id,request_fingerprint,sale_id,session_id,received_by,method_code,method_name,kind,amount) values('20000000-0000-4000-8000-000000000001',repeat('a',64),$1,$2,$3,'cash','cash','repayment',3)",[sale,session,admin]);
    assert.equal((await actor(a,'select * from pos_payments')).length,1);
    assert.equal((await call(a,'pos_register_state'))[0].expected_cash,105);
    assert.equal((await call(b,'pos_register_state'))[0].cash_payments,5);
    const report=await call(admin,'pos_register_session_report');
    assert.equal(report.sessions[0].cashier_name,'Cashier A'); assert.equal(report.sessions[0].expected_cash,105);
    assert.equal((await call(admin,'pos_register_session_report',[null,null,null,b,null])).sessions.length,0);
    await call(a,'pos_close_register',[session,'104','Test close']);
    const closed=(await call(admin,'pos_register_session_report',[null,null,null,null,'closed'])).sessions[0];
    assert.equal(closed.expected_cash,105); assert.equal(closed.actual_closing_cash,104); assert.equal(closed.cash_difference,-1);
    assert.equal((await call(b,'pos_register_state'))[0].session_id,null);
    await q('update pos_profiles set active=false where id=$1',[a]);
    await assert.rejects(call(a,'pos_register_state'),/POS_ACCESS_DENIED/);
    const funcs=await q("select prosecdef,proconfig from pg_proc where proname in ('pos_register_state','pos_register_session_report')");
    assert.equal(funcs.length,2); for(const f of funcs) { assert.equal(f.prosecdef,true); assert.ok(f.proconfig.includes('search_path=""')); }
  } finally { await db.close(); }
});
