import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { isQuantity, isCount, isPrice, normalizeDecimal, findBySku, searchCatalog, quantityDifference } from '../lib/pos/inventory.ts';

const load = (file) => readFile(new URL('../' + file, import.meta.url), 'utf8');
const catalog = [
  { kind: 'product', id: 'a', name: 'რძე', sku: '4860001', price: '2', stock: '5', cost: '1.2' },
  { kind: 'variant', id: 'b', name: 'ჩაი / დიდი', sku: 'TEA-L', price: '3', stock: '0', cost: null },
];

test('quantity and price validation', () => {
  assert.ok(isQuantity('1') && isQuantity('2,5') && isQuantity('0.001'));
  assert.ok(!isQuantity('0') && !isQuantity('') && !isQuantity('-1') && !isQuantity('1.2345') && !isQuantity('abc'));
  assert.ok(isCount('0') && !isCount('-1'));
  assert.ok(isPrice('0') && isPrice('12,50') && !isPrice('1.234') && !isPrice('-2'));
  assert.equal(normalizeDecimal(' 2,5 '), '2.5');
});

test('scan matches exact barcode only, search is partial', () => {
  assert.equal(findBySku(catalog, ' tea-l ')?.id, 'b');
  assert.equal(findBySku(catalog, '4860'), null);
  assert.equal(findBySku(catalog, ''), null);
  assert.deepEqual(searchCatalog(catalog, 'ჩაი').map((i) => i.id), ['b']);
  assert.deepEqual(searchCatalog(catalog, '4860').map((i) => i.id), ['a']);
});

test('difference has no float noise', () => {
  assert.equal(quantityDifference('0,3', 0.1), 0.2);
  assert.equal(quantityDifference('5', '5'), 0);
});

test('inventory migration and pages are admin-only and wired', async () => {
  const files = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter((f) => /^\d+_.+\.sql$/.test(f));
  assert.equal(new Set(files.map((f) => f.split('_')[0])).size, files.length);
  const sql = await load('supabase/migrations/202610040001_pos_inventory.sql');
  for (const t of ['pos_purchases', 'pos_purchase_items', 'pos_inventories', 'pos_inventory_items', 'pos_stock_movements']) {
    assert.match(sql, new RegExp(`${t}`));
  }
  assert.match(sql, /pos_require_actor\(true\)/);
  assert.doesNotMatch(sql, /\bstable\b/i, 'RPCs using FOR SHARE must stay volatile');
  for (const f of ['app/(pos)/purchases/page.tsx', 'app/(pos)/purchases/new/page.tsx', 'app/(pos)/purchases/[id]/page.tsx',
    'app/(pos)/inventories/page.tsx', 'app/(pos)/inventories/new/page.tsx', 'app/(pos)/inventories/[id]/page.tsx']) {
    assert.match(await load(f), /requireAdmin\(\)/, f);
  }
  for (const f of ['app/(pos)/purchases/actions.ts', 'app/(pos)/inventories/actions.ts']) {
    assert.match(await load(f), /requireAdmin\(\)/, f);
  }
  const nav = await load('app/components/pos-navigation.tsx');
  assert.match(nav, /\/purchases/); assert.match(nav, /\/inventories/);
});

import { parseCountRows, COUNT_SHEET_HEADER } from '../lib/pos/inventory.ts';

test('count sheet parser: header detection, blanks, numbers and text counts', () => {
  const ok = parseCountRows([
    COUNT_SHEET_HEADER,
    ['00123', 'რძე', 2, 1, 5, 7],
    ['TEA-L', 'ჩაი', 3, '', 0, '2,5'],
    ['X1', 'ცარიელი', 1, 1, 1, ''],
    ['', 'უსკუ', 1, 1, 1, 9],
  ]);
  assert.deepEqual(ok, { rows: [{ sku: '00123', counted: '7' }, { sku: 'TEA-L', counted: '2,5' }], blank: 1 });
  assert.ok('error' in parseCountRows([['a', 'b'], [1, 2]]));
  assert.ok('error' in parseCountRows([]));
  assert.deepEqual(parseCountRows([['ბარკოდი', 'რეალური რაოდენობა'], [4860001, 3]]), { rows: [{ sku: '4860001', counted: '3' }], blank: 0 });
});
