import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = 'supabase/migrations/202610080008_pos_customer_orders.sql';
const load = file => readFile(new URL('../' + file, import.meta.url), 'utf8');

test('customer orders: admin-only, isolated from register/stock/ledger, partial payments (in-memory only)', async t => {
  const db = new PGlite();
  const q = async (sql, args = []) => (await db.query(sql, args)).rows;
  const asUser = async (id, sql, args = [], role = 'authenticated') => db.transaction(async tx => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)", [id ?? '', role]);
    return (await tx.query(sql, args)).rows;
  });
  const createUser = async marker => {
    const id = randomUUID();
    await q('insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values($1,$2,$3,$4)',
      [id, id + '@example.invalid', JSON.stringify({ nexo_memberships: marker }), JSON.stringify({ full_name: 'Local Fixture' })]);
    return id;
  };
  const counts = async () => (await q(`select
    (select count(*) from pos_sales)::int sales, (select count(*) from pos_payments)::int payments,
    (select count(*) from pos_customer_transactions)::int ledger`))[0];
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
      grant usage on schema auth to authenticated,service_role;`);
    for (const file of ['supabase/staging/000_shared_pre_pos_bootstrap.sql', 'supabase/migrations/202609260001_create_pos_profiles.sql',
      'supabase/prerequisites/202609280001_explicit_app_memberships.sql', 'supabase/migrations/202609260002_pos_phase1.sql',
      migration]) await db.exec(await load(file));

    const admin = await createUser({ version: 1, pos: 'admin' });
    const cashier = await createUser({ version: 1, pos: 'cashier' });
    const customer = (await q("insert into pos_business_customers(name) values('შპს ტესტი') returning id"))[0].id;
    const product = (await q("insert into products(name,sku,price) values('რძე','4860001',2) returning id"))[0].id;
    const parent = (await q("insert into products(name,price) values('ჩაი',0) returning id"))[0].id;
    const variant = (await q("insert into product_variants(product_id,name,sku,price) values($1,'დიდი','TEA-L',3) returning id", [parent]))[0].id;
    const before = await counts();
    const create = (actor, items, request = randomUUID(), date = '2026-10-01') =>
      asUser(actor, 'select public.pos_create_customer_order($1,$2,$3,$4,$5) id', [request, customer, date, ' შენიშვნა ', JSON.stringify(items)]).then(r => r[0].id);
    const pay = (actor, order, amount, date = '2026-10-02', request = randomUUID()) =>
      asUser(actor, 'select public.pos_record_customer_order_payment($1,$2,$3,$4) id', [request, order, amount, date]).then(r => r[0].id);

    let order;
    await t.test('admin creates an order with edited prices and quantities', async () => {
      const request = randomUUID();
      order = await create(admin, [
        { kind: 'product', target: product, quantity: '2.5', unit_price: '1.80' },
        { kind: 'variant', target: variant, quantity: '3', unit_price: '10' },
      ], request);
      const row = (await q('select * from pos_customer_orders where id=$1', [order]))[0];
      assert.equal(Number(row.total), 34.5);
      assert.equal(row.note, 'შენიშვნა');
      const items = await q('select name,sku,quantity,unit_price,line_total from pos_customer_order_items where order_id=$1 order by line_no', [order]);
      assert.deepEqual(items.map(i => [i.name, i.sku, Number(i.line_total)]), [['რძე', '4860001', 4.5], ['ჩაი / დიდი', 'TEA-L', 30]]);
      assert.equal(await create(admin, [{ kind: 'product', target: product, quantity: '1', unit_price: '1' }], request), order, 'retry is idempotent');
    });

    await t.test('partial payments reduce the debt and cannot exceed it', async () => {
      await pay(admin, order, '10');
      await pay(admin, order, '4.50', '2026-10-03');
      const paid = (await q('select sum(amount) s from pos_customer_order_payments where order_id=$1', [order]))[0].s;
      assert.equal(Number(paid), 14.5);
      await assert.rejects(pay(admin, order, '20.01'), /OVERPAYMENT/);
      await assert.rejects(pay(admin, order, '0'), /INVALID_DECIMAL/);
      await assert.rejects(pay(admin, order, '1', '2026-09-30'), /INVALID_DATE/);
      const last = await pay(admin, order, '20');
      await assert.rejects(pay(admin, order, '0.01'), /OVERPAYMENT/);
      await asUser(admin, 'select public.pos_delete_customer_order_payment($1)', [last]);
      await pay(admin, order, '0.01');
    });

    await t.test('nothing reaches the register, stock, ledger or revenue', async () => {
      assert.deepEqual(await counts(), before);
      assert.doesNotMatch(await load(migration), /insert into public\.pos_(sales|payments|stock_movements|customer_transactions)/);
    });

    await t.test('cashiers and anon can neither write nor read', async () => {
      await assert.rejects(create(cashier, [{ kind: 'product', target: product, quantity: '1', unit_price: '1' }]), /POS_ACCESS_DENIED/);
      await assert.rejects(pay(cashier, order, '1'), /POS_ACCESS_DENIED/);
      assert.equal((await asUser(cashier, 'select * from pos_customer_orders')).length, 0);
      assert.equal((await asUser(cashier, 'select * from pos_customer_order_payments')).length, 0);
      assert.equal((await asUser(admin, 'select * from pos_customer_orders')).length, 1);
      await assert.rejects(asUser(null, 'select * from pos_customer_orders', [], 'anon'), /permission denied/);
      await assert.rejects(asUser(admin, 'delete from pos_customer_orders'), /permission denied/);
    });

    await t.test('invalid rows are rejected without leaving an order', async () => {
      const n = async () => Number((await q('select count(*) n from pos_customer_orders'))[0].n);
      const start = await n();
      await assert.rejects(create(admin, []), /INVALID_ORDER_ROWS/);
      await assert.rejects(create(admin, [{ kind: 'product', target: product, quantity: '0', unit_price: '1' }]), /INVALID_DECIMAL/);
      await assert.rejects(create(admin, [{ kind: 'product', target: product, quantity: '1', unit_price: '1.001' }]), /INVALID_DECIMAL/);
      await assert.rejects(create(admin, [{ kind: 'product', target: randomUUID(), quantity: '1', unit_price: '1' }]), /CATALOG_ITEM_UNAVAILABLE/);
      await assert.rejects(create(admin, [
        { kind: 'product', target: product, quantity: '1', unit_price: '1' },
        { kind: 'product', target: product, quantity: '2', unit_price: '1' },
      ]), /DUPLICATE_TARGET/);
      assert.equal(await n(), start);
    });

    await t.test('deleting an order removes its items and payments', async () => {
      await asUser(admin, 'select public.pos_delete_customer_order($1)', [order]);
      assert.equal(Number((await q('select count(*) n from pos_customer_order_payments'))[0].n), 0);
      assert.equal(Number((await q('select count(*) n from pos_customer_order_items'))[0].n), 0);
    });
  } finally {
    await db.close();
  }
});

test('customer orders UI is admin-only and wired on the customer page', async () => {
  const page = await load('app/(pos)/customers/[id]/page.tsx');
  assert.match(page, /requireAdmin\(\)/);
  assert.match(page, /CustomerOrders/);
  const actions = await load('app/(pos)/customers/[id]/order-actions.ts');
  for (const fn of ['createCustomerOrder', 'recordOrderPayment', 'deleteOrderPayment', 'deleteCustomerOrder']) {
    assert.match(actions, new RegExp(`export async function ${fn}\\([^)]*\\) \\{\\n  await requireAdmin\\(\\);`), fn);
  }
});
