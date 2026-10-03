import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFilters, toRpcArgs, addDays, tbilisiToday, summaryRows, filtersToQuery, productSheet } from '../lib/pos/analytics.ts';

const noon = new Date('2026-10-03T12:00:00Z');

test('no query -> last 30 days, everything, valid', () => {
  const f = parseFilters({}, noon);
  assert.equal(f.to, '2026-10-03'); assert.equal(f.from, '2026-09-04');
  assert.ok(f.retail && f.wholesale && !f.invalid);
  const a = toRpcArgs(f);
  assert.equal(a.p_from, '2026-09-04T00:00:00+04:00');
  assert.equal(a.p_to, '2026-10-04T00:00:00+04:00', 'inclusive end day becomes next midnight');
  assert.equal(a.p_type, null);
});

test('Tbilisi day is used, not UTC', () => {
  assert.equal(tbilisiToday(new Date('2026-10-03T21:30:00Z')), '2026-10-04');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('empty form (all period) and type picking', () => {
  const all = parseFilters({ from: '', to: '' }, noon);
  assert.equal(toRpcArgs(all).p_from, null); assert.equal(toRpcArgs(all).p_to, null);
  assert.equal(toRpcArgs(parseFilters({ type: 'retail' }, noon)).p_type, 'retail');
  assert.equal(toRpcArgs(parseFilters({ type: ['retail', 'wholesale'] }, noon)).p_type, null);
  assert.equal(toRpcArgs(parseFilters({ type: 'wholesale' }, noon)).p_type, 'wholesale');
});

test('choosing a customer forces wholesale', () => {
  const customer = '11111111-1111-4111-8111-111111111111';
  const a = toRpcArgs(parseFilters({ type: 'retail', customer }, noon));
  assert.equal(a.p_type, 'wholesale'); assert.equal(a.p_customer, customer);
});

test('amounts, text and invalid input', () => {
  const f = parseFilters({ min: '10,5', max: '99.99', product: '  ჩანთა ', sku: ' ab-1 ' }, noon);
  assert.ok(!f.invalid);
  const a = toRpcArgs(f);
  assert.equal(a.p_min, 10.5); assert.equal(a.p_max, 99.99); assert.equal(a.p_product, 'ჩანთა'); assert.equal(a.p_sku, 'ab-1');
  for (const bad of [{ min: 'abc' }, { max: '1.234' }, { min: '10', max: '5' }, { from: '2026-02-30' }, { from: '2026-10-05', to: '2026-10-01' }, { customer: 'nope' }]) {
    assert.ok(parseFilters(bad, noon).invalid, JSON.stringify(bad));
  }
  assert.equal(parseFilters({ customer: 'nope' }, noon).customer, '', 'bad customer id is dropped, never sent');
});

test('page is admin-only, wired to the RPC and the navigation', async () => {
  const page = await readFile(new URL('../app/(pos)/analytics/page.tsx', import.meta.url), 'utf8');
  const nav = await readFile(new URL('../app/components/pos-navigation.tsx', import.meta.url), 'utf8');
  const sql = await readFile(new URL('../supabase/migrations/202610030001_pos_analytics.sql', import.meta.url), 'utf8');
  assert.match(page, /await requireAdmin\(\)/);
  assert.match(page, /rpc\("pos_sales_analytics"/);
  assert.match(nav, /href: "\/analytics"/);
  assert.match(sql, /pos_require_actor\(true\)/);
  assert.doesNotMatch(sql, /\bstable\b/i.test(sql) ? /^$/ : /^$/);
  assert.match(sql, /revoke all on function public\.pos_sales_analytics/);
  assert.match(sql, /grant execute on function public\.pos_sales_analytics[\s\S]*to authenticated/);
  assert.ok(!/language plpgsql stable/i.test(sql), 'must stay VOLATILE (FOR SHARE inside pos_require_actor)');
});

const sample = {
  item_mode: false,
  totals: { sales_count: 4, quantity: 20, gross: 215, returns: 25, net: 190, cost: 82, profit: 88, unknown_cost_revenue: 20 },
  weekdays: [], top_products: [], received: 140, debt: 50,
  types: { retail: { sales_count: 2, net: 75 }, wholesale: { sales_count: 2, net: 115 } },
};

test('excel summary has every tile figure but no weekday or top-product data', () => {
  const rows = summaryRows(sample);
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(byLabel['შემოსული თანხა'].value, 190);
  assert.equal(byLabel['დაბრუნებები'].value, 25);
  assert.equal(byLabel['თვითღირებულება'].value, 82);
  assert.equal(byLabel['მოგება'].value, 88);
  assert.equal(byLabel['მარჟა'].kind, 'percent');
  assert.equal(Math.round(byLabel['მარჟა'].value * 10) / 10, 51.8);
  assert.equal(byLabel['საშუალო ჩეკი'].value, 47.5);
  assert.equal(byLabel['ფაქტობრივად მიღებული'].value, 140);
  assert.equal(byLabel['დარჩენილი ვალი'].value, 50);
  assert.equal(byLabel['საბითუმო: შემოსული თანხა'].value, 115);
  assert.ok(!rows.some((r) => /კვირ|ტოპ|ორშ/.test(r.label)));
  // product filter mode: no received/debt rows
  const item = summaryRows({ ...sample, item_mode: true, received: null, debt: null });
  assert.ok(!item.some((r) => r.label === 'ფაქტობრივად მიღებული' || r.label === 'დარჩენილი ვალი'));
  // empty result is still well-formed
  const empty = summaryRows({ ...sample, totals: { sales_count: 0, quantity: 0, gross: 0, returns: 0, net: 0, cost: 0, profit: 0, unknown_cost_revenue: 0 }, types: {} });
  assert.equal(empty.find((r) => r.label === 'საშუალო ჩეკი').value, 0);
});

test('export link carries exactly the filters on screen', () => {
  const f = parseFilters({ from: '2026-10-01', to: '2026-10-03', type: 'wholesale', product: 'ჩანთა', min: '5' }, noon);
  const params = Object.fromEntries(new URLSearchParams(filtersToQuery(f)));
  const back = parseFilters(params, noon);
  assert.deepEqual(toRpcArgs(back), toRpcArgs(f));
});

test('export route is admin-only, reuses the page rules and offers an icon-only link', async () => {
  const route = await readFile(new URL('../app/(pos)/analytics/export/route.ts', import.meta.url), 'utf8');
  const page = await readFile(new URL('../app/(pos)/analytics/page.tsx', import.meta.url), 'utf8');
  assert.match(route, /await requireAdmin\(\)/);
  assert.match(route, /parseFilters\(params\)/);
  assert.match(route, /summaryRows\(data\)/);
  assert.doesNotMatch(route, /weekdays|top_products/);
  assert.match(route, /pos_sales_analytics_products/);
  assert.match(route, /"პროდუქტები"/);
  assert.match(page, /aria-label="Excel-ში ჩამოტვირთვა"/);
  assert.match(page, /className="icon-button"/);
});

test('product sheet: quantities, prices, totals and unknown costs', () => {
  const sheet = productSheet([
    { name: 'A', sku: '001', quantity: 18, revenue: 145, avg_price: 8.06, unit_cost: 4, cost: 72, profit: 73 },
    { name: 'B', sku: null, quantity: 1, revenue: 20, avg_price: 20, unit_cost: null, cost: null, profit: null },
  ]);
  assert.equal(sheet.header.length, 8);
  assert.deepEqual(sheet.body[0], ['001', 'A', 18, 4, 8.06, 72, 145, 73]);
  assert.deepEqual(sheet.body[1], ['', 'B', 1, null, 20, null, 20, null], 'unknown cost is blank, not zero');
  assert.deepEqual(sheet.totals, ['', 'ჯამი', 19, null, null, 72, 165, 73], 'totals skip unknown cost');
  assert.match(sheet.note, /შესყიდვის ფასის გარეშე/);
  assert.equal(typeof sheet.body[0][0], 'string', 'barcode stays text');
  const clean = productSheet([{ name: 'A', sku: 'x', quantity: 2, revenue: 10, avg_price: 5, unit_cost: 2, cost: 4, profit: 6 }]);
  assert.equal(clean.note, null);
  assert.deepEqual(productSheet([]).totals, ['', 'ჯამი', 0, null, null, 0, 0, 0]);
});
