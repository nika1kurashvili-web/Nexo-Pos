import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const query = async (sql,args=[]) => (await db.query(sql,args)).rows;
const source = path => readFile(new URL(path,import.meta.url),"utf8");
const single='11111111-1111-4111-8111-111111111111';
let legacy, legacyProfile;
async function authUser(marker) {
  const id=randomUUID();
  await query("insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values($1,'local-test@example.invalid',$2,'{}')",
    [id,JSON.stringify(marker ? {nexo_memberships:marker} : {})]);
  return id;
}
async function asUser(id,sql,args=[]) {
  return db.transaction(async tx=>{
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[id]);
    return (await tx.query(sql,args)).rows;
  });
}
before(async()=>{
  // Test harness ONLY: a real empty Supabase project already provides these.
  // The bootstrap itself never creates/modifies managed Auth infrastructure.
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated;`);
  await db.exec(await source('../supabase/staging/000_shared_pre_pos_bootstrap.sql'));
});
after(async()=>db.close());

test('staging bootstrap creates only shared prerequisites and four fictional catalog rows',async()=>{
  assert.deepEqual((await query("select tablename from pg_tables where schemaname='public' order by tablename")).map(r=>r.tablename),
    ['product_purchase_prices','product_variants','products','profiles']);
  assert.equal((await query('select count(*)::int n from auth.users'))[0].n,0);
  assert.equal((await query('select count(*)::int n from profiles'))[0].n,0);
  assert.deepEqual((await query('select sku from products union all select sku from product_variants order by sku')).map(r=>r.sku),
    ['STG-LARGE','STG-PARENT','STG-SINGLE','STG-SMALL']);
});
test('bootstrap reproduces pre-fix automatic active Orders operator membership',async()=>{
  legacy=await authUser({version:1,pos:'cashier'});
  legacyProfile=(await query('select * from profiles where id=$1',[legacy]))[0];
  assert.equal(legacyProfile.role,'operator');assert.equal(legacyProfile.active,true);
  assert.equal((await query("select to_regclass('public.pos_profiles') table_name"))[0].table_name,null);
  assert.equal((await asUser(legacy,'select * from products')).length,2);
});
test('unchanged 001, prerequisite, and 002 execute against bootstrap in required order',async()=>{
  for(const file of ['../supabase/migrations/202609260001_create_pos_profiles.sql',
    '../supabase/prerequisites/202609280001_explicit_app_memberships.sql',
    '../supabase/migrations/202609260002_pos_phase1.sql']) await db.exec(await source(file));
  assert.deepEqual((await query('select * from profiles where id=$1',[legacy]))[0],legacyProfile);
  assert.equal((await query("select count(*)::int n from pg_tables where schemaname='public' and tablename like 'pos_%'"))[0].n,10);
  assert.equal((await query("select count(*)::int n from pg_policies where policyname='pos_active_users_select_products'"))[0].n,1);
});
test('new unmarked and delayed POS provisioning remain isolated after full sequence',async()=>{
  const id=await authUser();assert.equal((await query('select * from profiles where id=$1',[id])).length,0);
  await query('update auth.users set raw_app_meta_data=$2 where id=$1',[id,JSON.stringify({nexo_memberships:{version:1,pos:'cashier'}})]);
  assert.equal((await query('select * from pos_profiles where id=$1',[id])).length,0);
  await db.transaction(async tx=>{
    await tx.exec('set local role service_role');
    assert.equal((await tx.query('select public.nexo_finalize_user_memberships($1) ok',[id])).rows[0].ok,true);
  });
  assert.equal((await query('select * from profiles where id=$1',[id])).length,0);
  assert.equal((await asUser(id,'select * from products')).length,2);
  assert.equal((await asUser(id,'select * from product_variants')).length,2);
  for(const table of ['products','product_variants']) {
    await assert.rejects(asUser(id,`insert into ${table}(name) values('forbidden')`),/row-level security/);
    assert.equal((await asUser(id,`update ${table} set price=1 returning id`)).length,0);
    assert.equal((await asUser(id,`delete from ${table} returning id`)).length,0);
  }
  await assert.rejects(asUser(id,"select public.nexo_create_catalog_item('product',$1,null)",[JSON.stringify({name:'forbidden',price:1,weight_kg:1})]),/Only active admins/);
});
test('full staging sequence supports explicit Orders/dual admins and atomic POS sale/close',async()=>{
  const orders=await authUser({version:1,orders:'admin'});
  assert.equal((await query('select * from pos_profiles where id=$1',[orders])).length,0);
  const dual=await authUser({version:1,orders:'operator',pos:'admin'});
  assert.equal((await query('select * from profiles where id=$1',[dual])).length,1);
  const register=(await asUser(dual,"insert into pos_registers(name) values('STAGING smoke register') returning id"))[0].id;
  const session=(await asUser(dual,"select public.pos_open_register($1,'5') id",[register]))[0].id;
  const sale=(await asUser(dual,"select public.pos_complete_sale($1,$2,'retail',null,'STAGING-SMOKE',$3,$4) id",
    [randomUUID(),session,JSON.stringify([{kind:'product',target:single,quantity:'1'}]),JSON.stringify([{method:'cash',amount:'10'}])]))[0].id;
  assert.equal((await query('select total from pos_sales where id=$1',[sale]))[0].total,'10.00');
  assert.equal((await asUser(dual,"select public.pos_close_register($1,'15',null) expected",[session]))[0].expected,'15.00');
  const created=await asUser(orders,"select public.nexo_create_catalog_item('product',$1,1) item",[JSON.stringify({name:'STAGING admin test',price:5,weight_kg:1})]);
  assert.equal(created[0].item.name,'STAGING admin test');
});
test('bootstrap refuses a populated project instead of replacing data or helpers',async()=>{
  await assert.rejects(db.exec(await source('../supabase/staging/000_shared_pre_pos_bootstrap.sql')),/STAGING_BOOTSTRAP_REQUIRES_NO_AUTH_USERS/);
  await db.exec('rollback');
  assert.deepEqual((await query('select * from profiles where id=$1',[legacy]))[0],legacyProfile);
});
