import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

// Disposable, in-memory PostgreSQL only. No network or Supabase credentials.
const db = new PGlite();
const admin = randomUUID(), cashier = randomUUID(), other = randomUUID(), inactive = randomUUID(), ordersOnly = randomUUID();
let customer, register, session;
const query = async (sql, values = []) => (await db.query(sql, values)).rows;
async function asUser(id, sql, values = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [id]);
    return (await tx.query(sql, values)).rows;
  });
}
const call = async (actor, fn, args) => (await asUser(actor, `select public.${fn}(${args.map((_,i) => `$${i+1}`).join(',')}) as result`, args))[0].result;
const item = (target = "1", extra = {}) => ({ kind: "product", target, quantity: "1", ...extra });
const sale = (actor, type, items, payments, cust = null, sid = session, request = randomUUID()) => call(actor, "pos_complete_sale", [request,sid,type,cust,"TRACK-001",JSON.stringify(items),JSON.stringify(payments)]);

before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create table public.profiles(id uuid primary key, active boolean);
    create function public.is_active_user() returns boolean language sql stable security definer as $$ select exists(select 1 from public.profiles where id=auth.uid() and active) $$;
    create table public.products(id bigint primary key, name text, sku text, price numeric(12,2), active boolean);
    create table public.product_variants(id text primary key, product_id bigint references public.products(id) on delete cascade, name text, sku text, price numeric(12,2), active boolean);
    alter table public.products enable row level security; alter table public.product_variants enable row level security;
    create policy products_select on public.products for select to authenticated using(public.is_active_user());
    create policy variants_select on public.product_variants for select to authenticated using(true);
    grant select on public.products,public.product_variants to authenticated;
    insert into public.products values(1,'Original product','001',100,true),(2,'No wholesale price','002',50,true);
    insert into public.product_variants values('v1',1,'Original variant','V1',120,true);`);
  for (const id of [admin,cashier,other,inactive,ordersOnly]) await query("insert into auth.users values($1)", [id]);
  await query("insert into profiles values($1,true)", [ordersOnly]);
  await db.exec(await readFile(new URL("../supabase/migrations/202609260001_create_pos_profiles.sql", import.meta.url), "utf8"));
  for (const [id, role, active] of [[admin,"admin",true],[cashier,"cashier",true],[other,"cashier",true],[inactive,"admin",false]]) {
    await query("insert into pos_profiles(id,full_name,role,active) values($1,'Test user',$2,$3)", [id,role,active]);
  }
  await db.exec(await readFile(new URL("../supabase/migrations/202609260002_pos_phase1.sql", import.meta.url), "utf8"));
  customer = (await asUser(admin,"insert into pos_business_customers(name,tax_code) values('Business','123') returning id"))[0].id;
  register = (await asUser(admin,"insert into pos_registers(name) values('Main register') returning id"))[0].id;
  session = await call(cashier,"pos_open_register",[register,"100.00"]);
});
after(async () => { await db.close(); });

test("catalog policy adds POS read only, preserves existing access and actual FK types", async () => {
  assert.equal((await asUser(cashier,"select * from products")).length,2);
  assert.equal((await asUser(cashier,"select * from product_variants")).length,1);
  assert.equal((await asUser(ordersOnly,"select * from products")).length,2);
  assert.equal((await asUser(inactive,"select * from products")).length,0);
  await assert.rejects(asUser(cashier,"update products set price=1"));
  const cols = await query("select column_name, data_type from information_schema.columns where table_name='pos_sale_items' and column_name in ('product_id','variant_id') order by column_name");
  assert.deepEqual(cols.map((c) => c.data_type),["bigint","text"]);
  assert.equal((await query("select qual from pg_policies where policyname='products_select'"))[0].qual,"is_active_user()");
  assert.equal((await query("select count(*)::int as n from pg_policies where tablename='product_variants'"))[0].n,1);
});

test("RLS denies cashier management, inactive and orders-only users", async () => {
  await assert.rejects(asUser(cashier,"insert into pos_business_customers(name) values('Forbidden')"));
  assert.equal((await asUser(cashier,"update pos_business_customers set name='Forbidden' returning id")).length,0);
  await assert.rejects(asUser(admin,"delete from pos_business_customers"));
  await assert.rejects(asUser(cashier,"insert into pos_sales default values"));
  await assert.rejects(asUser(admin,"update pos_payment_methods set code='money' where code='cash'"));
  for (const id of [inactive, ordersOnly]) {
    assert.equal((await asUser(id,"select * from pos_register_sessions")).length,0);
    await assert.rejects(call(id,"pos_open_register",[register,"0"]));
  }
  assert.equal((await asUser(other,"select * from pos_register_sessions")).length,0);
  await assert.rejects(call(cashier,"pos_set_customer_prices",[customer,JSON.stringify([{kind:"product",target:"1",price:"80"}])]));
});

test("register uniqueness and ownership are enforced", async () => {
  await assert.rejects(call(other,"pos_open_register",[register,"0"]));
  const reg = (await asUser(admin,"insert into pos_registers(name) values('Second') returning id"))[0].id;
  await assert.rejects(call(cashier,"pos_open_register",[reg,"0"]));
  await assert.rejects(call(other,"pos_close_register",[session,"0",null]));
});

test("customer prices are unique, support variants, never fall back to retail", async () => {
  const missing = await call(cashier,"pos_quote",["product","1","wholesale",customer]);
  assert.equal(missing.state,"wholesale_price_missing");
  await assert.rejects(sale(cashier,"wholesale",[item()],[],customer),/WHOLESALE_PRICE_MISSING/);
  await call(admin,"pos_set_customer_prices",[customer,JSON.stringify([{kind:"product",target:"1",price:"80"},{kind:"variant",target:"v1",price:"90"}])]);
  await call(admin,"pos_set_customer_prices",[customer,JSON.stringify([{kind:"product",target:"1",price:"75"}])]);
  assert.equal((await query("select count(*)::int as n from pos_customer_prices"))[0].n,2);
  assert.equal((await call(cashier,"pos_quote",["product","1","wholesale",customer])).price,"75.00");
  assert.equal((await call(cashier,"pos_quote",["variant","v1","wholesale",customer])).price,"90.00");
  await assert.rejects(call(admin,"pos_set_customer_prices",[customer,JSON.stringify([{kind:"product",target:"1",price:"1"},{kind:"product",target:"1",price:"2"}])]),/DUPLICATE_TARGET/);
  assert.equal((await query("select price from products where id=1"))[0].price,"100.00");
});

test("retail snapshots, manual price, discount, split payment and tracking are recomputed", async () => {
  const request = randomUUID();
  const id = await sale(cashier,"retail",[item("1",{quantity:"2",unit_price:"90",discount_percent:"10",line_total:1})],
    [{method:"cash",amount:"62"},{method:"tbc",amount:"100"}],null,session,request);
  const s = (await query("select * from pos_sales where id=$1",[id]))[0];
  assert.equal(s.total,"162.00"); assert.equal(s.subtotal,"180.00"); assert.equal(s.discount_total,"18.00");
  assert.equal(s.debt_amount,"0.00"); assert.equal(s.tracking_code,"TRACK-001");
  const i = (await query("select * from pos_sale_items where sale_id=$1",[id]))[0];
  assert.equal(i.base_unit_price,"100.00"); assert.equal(i.adjusted_unit_price,"90.00");
  assert.equal(i.final_unit_price,"81.00"); assert.equal(i.product_name,"Original product");
  const original = item("1",{quantity:"2",unit_price:"90",discount_percent:"10"});
  const payments = [{method:"cash",amount:"62"},{method:"tbc",amount:"100"}];
  assert.equal(await sale(cashier,"retail",[item("001",{quantity:"2.000",unit_price:"90.00",discount_percent:"10.0"})],
    [{method:"tbc",amount:"100.00"},{method:"cash",amount:"62.0"}],null,session,request),id);
  for (const change of [{target:"2"},{quantity:"3"},{unit_price:"91"},{discount_percent:"11"},{kind:"variant",target:"v1"}]) {
    await assert.rejects(sale(cashier,"retail",[{...original,...change}],payments,null,session,request),/REQUEST_CONFLICT/);
  }
  for (const changed of [[{method:"cash",amount:"162"}],[{method:"cash",amount:"63"},{method:"tbc",amount:"100"}]]) {
    await assert.rejects(sale(cashier,"retail",[original],changed,null,session,request),/REQUEST_CONFLICT/);
  }
  await assert.rejects(sale(cashier,"retail",[original],payments,customer,session,request),/REQUEST_CONFLICT/);
  await assert.rejects(sale(cashier,"retail",[original],payments,null,randomUUID(),request),/REQUEST_CONFLICT/);
  await assert.rejects(sale(cashier,"wholesale",[original],payments,null,session,request),/REQUEST_CONFLICT/);
  await assert.rejects(call(cashier,"pos_complete_sale",[request,session,"retail",null,"changed",JSON.stringify([original]),JSON.stringify(payments)]),/REQUEST_CONFLICT/);
  assert.match(s.request_fingerprint,/^[0-9a-f]{64}$/);
  assert.equal((await query("select count(*)::int as n from pos_payments where sale_id=$1",[id]))[0].n,2);
  await assert.rejects(asUser(cashier,"update pos_sale_items set quantity=999"));
});

test("SKU confirmation revalidates matches and imports atomically", async () => {
  const second = (await asUser(admin,"insert into pos_business_customers(name) values('Second business') returning id"))[0].id;
  await call(admin,"pos_import_customer_prices",[second,JSON.stringify([{sku:"001",price:"70"},{sku:"V1",price:"85"}])]);
  assert.equal((await call(cashier,"pos_quote",["product","1","wholesale",second])).price,"70.00");
  assert.equal((await call(cashier,"pos_quote",["product","1","wholesale",customer])).price,"75.00");
  await assert.rejects(call(admin,"pos_import_customer_prices",[second,JSON.stringify([{sku:"001",price:"1"},{sku:"missing",price:"3"}])]),/SKU_NOT_FOUND/);
  assert.equal((await call(cashier,"pos_quote",["product","1","wholesale",second])).price,"70.00");
  await query("insert into product_variants values('duplicate',1,'Duplicate','001',100,true)");
  await assert.rejects(call(admin,"pos_import_customer_prices",[second,JSON.stringify([{sku:"001",price:"1"}])]),/SKU_CONFLICT/);
  await query("delete from product_variants where id='duplicate'");
});

test("variant snapshots and fractional quantities follow declared cent rounding", async () => {
  const id = await sale(cashier,"retail",[item("v1",{kind:"variant",quantity:"1.125",unit_price:"9.99",discount_percent:"12.5"})],[{method:"bog",amount:"9.83"}]);
  const row = (await query("select * from pos_sale_items where sale_id=$1",[id]))[0];
  assert.equal(row.quantity,"1.125"); assert.equal(row.final_unit_price,"8.74"); assert.equal(row.line_total,"9.83");
  assert.equal(row.variant_name,"Original variant"); assert.equal(row.sku,"V1"); assert.equal(row.base_unit_price,"120.00");
  const free = await sale(cashier,"retail",[item("2",{discount_percent:"100"})],[]);
  assert.equal((await query("select total from pos_sales where id=$1",[free]))[0].total,"0.00");
});

test("wholesale zero, partial, full payments and later repayments form an immutable ledger", async () => {
  const zero = await sale(cashier,"wholesale",[item()],[],customer);
  const partial = await sale(cashier,"wholesale",[item()],[{method:"tbc",amount:"25"}],customer);
  const full = await sale(cashier,"wholesale",[item()],[{method:"bog",amount:"75"}],customer);
  for (const [id,debt] of [[zero,"75.00"],[partial,"50.00"],[full,"0.00"]]) {
    assert.equal((await query("select debt_amount from pos_sales where id=$1",[id]))[0].debt_amount,debt);
  }
  const req = randomUUID();
  const repayment = await call(cashier,"pos_record_repayment",[req,partial,session,"cash","20"]);
  assert.equal(await call(cashier,"pos_record_repayment",[req,partial,session,"cash","020.00"]),repayment);
  for (const args of [[req,partial,session,"cash","21"],[req,partial,session,"tbc","20"],[req,zero,session,"cash","20"],[req,partial,randomUUID(),"cash","20"]]) {
    await assert.rejects(call(cashier,"pos_record_repayment",args),/REQUEST_CONFLICT/);
  }
  assert.equal((await query("select sum(amount) as balance from pos_customer_transactions where sale_id=$1",[partial]))[0].balance,"30.00");
  assert.equal((await query("select debt_amount from pos_sales where id=$1",[partial]))[0].debt_amount,"50.00");
  await assert.rejects(call(cashier,"pos_record_repayment",[randomUUID(),partial,session,"cash","31"]),/OVERPAYMENT/);
  await assert.rejects(asUser(admin,"delete from pos_customer_transactions"));
  assert.equal((await asUser(cashier,"select * from pos_customer_transactions")).length,0);
  assert.equal(await call(admin,"pos_customer_balance",[customer]),"105.00");
  await assert.rejects(call(cashier,"pos_customer_balance",[customer]));
});

test("invalid finance inputs roll back the whole sale", async () => {
  const before = (await query("select count(*)::int as n from pos_sales"))[0].n;
  for (const bad of ["0","-1","NaN","Infinity","0.0001"]) await assert.rejects(sale(cashier,"retail",[item("1",{quantity:bad})],[]));
  for (const bad of ["-1","NaN","0.001"]) await assert.rejects(sale(cashier,"retail",[item("1",{unit_price:bad})],[]));
  await assert.rejects(sale(cashier,"retail",[item("1",{discount_percent:"101"})],[]));
  await assert.rejects(sale(cashier,"retail",[item()],[]),/FULL_PAYMENT/);
  await assert.rejects(sale(cashier,"wholesale",[item()],[]),/CUSTOMER_REQUIRED/);
  await assert.rejects(sale(cashier,"retail",[item()],[{method:"cash",amount:"101"}]),/OVERPAYMENT/);
  await assert.rejects(sale(cashier,"retail",[item()],[{method:"cash",amount:"-1"}]));
  await assert.rejects(sale(cashier,"retail",[item()],[{method:"unknown",amount:"100"}]));
  assert.equal((await query("select count(*)::int as n from pos_sales"))[0].n,before);
});

test("cash drawer includes cash sales and later cash repayments only", async () => {
  const expected = await call(cashier,"pos_close_register",[session,"180","Counted"]);
  assert.equal(expected,"182.00");
  const s = (await query("select * from pos_register_sessions where id=$1",[session]))[0];
  assert.equal(s.cash_difference,"-2.00"); assert.equal(s.status,"closed");
  await assert.rejects(sale(cashier,"retail",[item()],[{method:"cash",amount:"100"}]),/OPEN_SESSION/);
  await assert.rejects(call(cashier,"pos_close_register",[session,"180",null]),/SESSION_CLOSED/);
});

test("queued duplicates and both finance versus close orders are safe", async () => {
  // PGlite serializes transactions: these are outcome tests, not real lock contention.
  const reg = (await asUser(admin,"insert into pos_registers(name) values('Race scenarios') returning id"))[0].id;
  const sid = await call(other,"pos_open_register",[reg,"0"]);
  const req = randomUUID();
  const invoke = () => sale(other,"wholesale",[item()],[],customer,sid,req);
  const [first,second] = await Promise.all([invoke(),invoke()]);
  assert.equal(first,second);
  assert.equal((await query("select count(*)::int n from pos_sales where request_id=$1",[req]))[0].n,1);
  const repaymentReq = randomUUID();
  const repay = () => call(other,"pos_record_repayment",[repaymentReq,first,sid,"cash","10"]);
  const [a,b] = await Promise.all([repay(),repay()]);
  assert.equal(a,b);
  assert.equal((await query("select count(*)::int n from pos_payments where request_id=$1",[repaymentReq]))[0].n,1);
  assert.equal(await call(other,"pos_close_register",[sid,"10",null]),"10.00");
  assert.equal(await invoke(),first);
  assert.equal(await repay(),a);
  await assert.rejects(sale(other,"wholesale",[item()],[],customer,sid),/OPEN_SESSION/);
  await assert.rejects(call(other,"pos_record_repayment",[randomUUID(),first,sid,"cash","10"]),/OPEN_SESSION/);
  const closed = await call(other,"pos_open_register",[reg,"0"]);
  await call(other,"pos_close_register",[closed,"0",null]);
  await assert.rejects(sale(other,"wholesale",[item()],[],customer,closed),/OPEN_SESSION/);
  await assert.rejects(call(other,"pos_record_repayment",[randomUUID(),first,closed,"cash","10"]),/OPEN_SESSION/);
});

test("queued opens enforce one open register and one session per cashier", async () => {
  const regs = await asUser(admin,"insert into pos_registers(name) values('Concurrent A'),('Concurrent B') returning id");
  const same = await Promise.allSettled([cashier,other].map(actor => call(actor,"pos_open_register",[regs[0].id,"0"])));
  assert.equal(same.filter(r => r.status === "fulfilled").length,1);
  const winner = same.findIndex(r => r.status === "fulfilled");
  await call([cashier,other][winner],"pos_close_register",[same[winner].value,"0",null]);
  const two = await Promise.allSettled(regs.map(r => call(cashier,"pos_open_register",[r.id,"0"])));
  assert.equal(two.filter(r => r.status === "fulfilled").length,1);
  await call(cashier,"pos_close_register",[two.find(r => r.status === "fulfilled").value,"0",null]);
});

test("definer ownership, private helpers, forced RLS, FK indexes and account retention", async () => {
  const routines = await query("select p.proname,p.proconfig,r.rolsuper,r.rolbypassrls,has_function_privilege('anon',p.oid,'EXECUTE') anon from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='public' and p.proname like 'pos_%' and p.prosecdef");
  assert.ok(routines.length >= 10);
  assert.ok(routines.every(r => (r.rolsuper || r.rolbypassrls) && !r.anon && r.proconfig.includes('search_path=""')));
  for (const signature of ['pos_require_actor(boolean)','pos_decimal(text,integer,boolean)','pos_normalize_sale_request(uuid,uuid,text,uuid,text,jsonb,jsonb)']) {
    assert.equal((await query("select has_function_privilege('authenticated',$1,'EXECUTE') allowed",['public.'+signature]))[0].allowed,false);
  }
  const tables = await query("select relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname like 'pos_%'");
  assert.ok(tables.every(t => t.relrowsecurity && t.relforcerowsecurity));
  const uncovered = await query("select c.conname from pg_constraint c where c.contype='f' and c.conrelid in (select oid from pg_class where relnamespace='public'::regnamespace and relname like 'pos_%') and not exists(select 1 from pg_index i where i.indrelid=c.conrelid and i.indisvalid and i.indkey[0]=c.conkey[1] and (i.indpred is null or pg_get_expr(i.indpred,i.indrelid) like '%IS NOT NULL%'))");
  assert.deepEqual(uncovered,[]);
  await assert.rejects(query("delete from auth.users where id=$1",[cashier]),/foreign key/);
  await query("update pos_profiles set active=false where id=$1",[cashier]);
  await assert.rejects(call(cashier,"pos_open_register",[register,"0"]),/POS_ACCESS_DENIED/);
  assert.ok((await query("select count(*)::int n from pos_sales where cashier_id=$1",[cashier]))[0].n > 0);
  await query("update pos_profiles set active=true where id=$1",[cashier]);
});

test("deployment preflight rejects ordinary owners and inspection SQL is read-only and executable", async () => {
  const migration = await readFile(new URL("../supabase/migrations/202609260002_pos_phase1.sql",import.meta.url),"utf8");
  assert.match(migration,/begin;\s+set local lock_timeout = '10s';/);
  const preflight = migration.slice(migration.indexOf('do $$ begin'),migration.indexOf('end $$;')+7);
  await assert.rejects(asUser(cashier,preflight),/must have BYPASSRLS/);
  const inspection = await readFile(new URL("../supabase/inspection/phase1_write_isolation_preflight.sql",import.meta.url),"utf8");
  await db.transaction(async tx => {
    await tx.exec('set transaction read only');
    await tx.exec(inspection);
  });
});

test("snapshot survives catalog rename, price changes and deletion", async () => {
  await query("update products set name='Renamed',price=999 where id=1");
  assert.equal((await query("select product_name from pos_sale_items order by created_at limit 1"))[0].product_name,"Original product");
  await query("delete from products where id=1");
  const items = await query("select product_id,product_name,base_unit_price from pos_sale_items where product_name='Original product'");
  assert.ok(items.every((i) => i.product_id === null && i.product_name === "Original product"));
});
