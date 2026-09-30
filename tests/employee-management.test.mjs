import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('employee lifecycle preserves Orders, enforces DB guards, and limits audit/password privileges', async () => {
  const db = new PGlite();
  const sql = async file => readFile(new URL('../'+file,import.meta.url),'utf8');
  const q = async (text,args=[]) => (await db.query(text,args)).rows;
  const asRole = async (role,id,text,args=[]) => db.transaction(async tx=>{
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",[id ?? '',role]);
    return (await tx.query(text,args)).rows;
  });
  const call = async (actor,name,args=[]) => (await asRole('authenticated',actor,`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args))[0].result;
  const user = async marker => {
    const id=randomUUID();
    await q('insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values($1,$2,$3,$4)',
      [id,id+'@example.invalid',JSON.stringify(marker ? {provider:'email',extra:{keep:true},nexo_memberships:marker} : {}),JSON.stringify({full_name:'Fixture'})]);
    return id;
  };
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;
      grant usage on schema auth to authenticated,service_role;`);
    for(const file of ['supabase/staging/000_shared_pre_pos_bootstrap.sql','supabase/migrations/202609260001_create_pos_profiles.sql',
      'supabase/prerequisites/202609280001_explicit_app_memberships.sql','supabase/migrations/202609260002_pos_phase1.sql',
      'supabase/migrations/202609300001_pos_register_visibility.sql']) await db.exec(await sql(file));
    const admin=await user({version:1,pos:'admin'});
    const orders=await user({version:1,orders:'operator'});
    const before=await q('select * from profiles order by id');
    const policies=await q("select tablename,policyname,qual,with_check from pg_policies where tablename not like 'pos_%' order by tablename,policyname");
    await db.exec(await sql('supabase/migrations/202609300002_pos_employee_management.sql'));
    assert.deepEqual(await q('select * from profiles order by id'),before);
    assert.deepEqual(await q("select tablename,policyname,qual,with_check from pg_policies where tablename not like 'pos_%' order by tablename,policyname"),policies);

    const employee=await user();
    assert.equal((await q('select * from profiles where id=$1',[employee])).length,0);
    assert.equal((await call(admin,'pos_employee_lookup',[employee+'@example.invalid'])).id,employee);
    await call(admin,'pos_employee_save',[employee,'Cashier','cashier',true]);
    assert.deepEqual((await q('select raw_app_meta_data from auth.users where id=$1',[employee]))[0].raw_app_meta_data,{nexo_memberships:{version:1,pos:'cashier'}});
    assert.equal((await q('select * from profiles where id=$1',[employee])).length,0);
    await assert.rejects(call(employee,'pos_employee_list'),/POS_ACCESS_DENIED/);
    await assert.rejects(call(orders,'pos_employee_lookup',['any@example.invalid']),/POS_ACCESS_DENIED/);
    await assert.rejects(call(employee,'pos_employee_save',[admin,'Forged','cashier',false]),/POS_ACCESS_DENIED/);
    await assert.rejects(asRole('authenticated',employee,"update pos_profiles set role='admin' where id=$1",[employee]),/permission denied/);
    await assert.rejects(call(admin,'pos_employee_save',[admin,'Admin','admin',false]),/SELF_DISABLE_FORBIDDEN/);
    await assert.rejects(call(admin,'pos_employee_save',[admin,'Admin','cashier',true]),/LAST_ADMIN/);

    await call(admin,'pos_employee_save',[orders,'Dual','cashier',true]);
    await call(admin,'pos_employee_save',[orders,'Dual Admin','admin',true]);
    await call(admin,'pos_employee_save',[orders,'Dual Inactive','cashier',false]);
    assert.deepEqual(await q('select * from profiles order by id'),before);
    assert.deepEqual((await q('select raw_app_meta_data from auth.users where id=$1',[orders]))[0].raw_app_meta_data,
      {provider:'email',extra:{keep:true},nexo_memberships:{version:1,orders:'operator',pos:'cashier'}});
    await call(admin,'pos_employee_save',[orders,'Dual Active','cashier',true]);
    assert.equal((await call(admin,'pos_employee_list')).find(p=>p.id===orders).has_orders,true);

    const register=(await q("insert into pos_registers(name) values('Local fixture') returning id"))[0].id;
    const session=await call(employee,'pos_open_register',[register,'0']);
    await assert.rejects(call(admin,'pos_employee_save',[employee,'Cashier','cashier',false]),/EMPLOYEE_OPEN_SESSION/);
    assert.equal((await q('select active from pos_profiles where id=$1',[employee]))[0].active,true);
    await call(employee,'pos_close_register',[session,'0','Local fixture']);
    await call(admin,'pos_employee_save',[employee,'Cashier','cashier',false]);
    await assert.rejects(call(employee,'pos_open_register',[register,'0']),/POS_ACCESS_DENIED/);
    await call(admin,'pos_employee_save',[employee,'Cashier','cashier',true]);

    await assert.rejects(call(admin,'pos_employee_password_request',[orders,false]),/SHARED_PASSWORD_CONFIRM_REQUIRED/);
    const ticket=await call(admin,'pos_employee_password_request',[orders,true]);
    await assert.rejects(call(admin,'pos_employee_password_result',[ticket,true]),/permission denied/);
    assert.equal((await asRole('service_role',null,'select public.pos_employee_password_result($1,true) result',[ticket]))[0].result,true);
    assert.equal((await q('select event from pos_employee_audit where id=$1',[ticket]))[0].event,'password_succeeded');
    assert.equal((await asRole('authenticated',employee,'select * from pos_employee_audit')).length,0);
    await assert.rejects(asRole('authenticated',admin,'delete from pos_employee_audit'),/permission denied/);
    await assert.rejects(asRole('anon',null,'select public.pos_employee_list()'),/permission denied/);
    const invalid=await user({version:2,orders:'operator'});
    await assert.rejects(call(admin,'pos_employee_save',[invalid,'Bad','cashier',true]),/MEMBERSHIP_METADATA_INVALID/);
    assert.equal((await q('select * from pos_profiles where id=$1',[invalid])).length,0);
    assert.deepEqual(await q('select * from profiles order by id'),before);
    const funcs=await q("select prosecdef,proconfig from pg_proc where proname like 'pos_employee_%'");
    assert.equal(funcs.length,5);
    for(const f of funcs) { assert.equal(f.prosecdef,true);assert.ok(f.proconfig.includes('search_path=""')); }
    assert.match(await sql('supabase/migrations/202609300002_pos_employee_management.sql'),/pg_advisory_xact_lock/);
  } finally { await db.close(); }
});

test('service credential stays server-only and existing accounts never receive create-form passwords', async () => {
  const load=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
  const service=await load('lib/supabase/admin.ts'), actions=await load('app/(pos)/employees/actions.ts');
  assert.match(service,/import "server-only"/);
  assert.match(service,/process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(service,/NEXT_PUBLIC_.*KEY/);
  assert.match(actions,/if \(!id\) \{/);
  assert.match(actions,/app_metadata: \{\}/);
  assert.doesNotMatch(actions,/console\.|deleteUser|listUsers|raw_app_meta_data/);
  for(const file of ['app/components/employee-form.tsx','app/(pos)/employees/page.tsx']) assert.doesNotMatch(await load(file),/supabase\/admin|SERVICE_ROLE_KEY/);
});
