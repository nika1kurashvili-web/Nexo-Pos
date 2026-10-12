import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImageTargets, matchImageFiles, normKey, thumbUrl } from '../lib/pos/product-images.ts';

const items = [
  { kind: 'product', id: 'p1', product_id: 'p1', name: 'რძე', variant_name: null, sku: '4860001', active: true },
  { kind: 'variant', id: 'v1', product_id: 'pp', name: 'ჩანთა', variant_name: 'წითელი', sku: '4860002', active: true },
  { kind: 'variant', id: 'v2', product_id: 'pp', name: 'ჩანთა', variant_name: 'შავი', sku: null, active: true },
  { kind: 'product', id: 'p3', product_id: 'p3', name: 'ძველი', variant_name: null, sku: '999', active: false },
];
const targets = buildImageTargets(items, (k, id) => k === 'product' && id === 'p1');

test('inactive items are not targets; parent of variants becomes a shared-photo target', () => {
  assert.equal(targets.some((t) => t.id === 'p3'), false);
  assert.ok(targets.some((t) => t.kind === 'product' && t.id === 'pp'));
});

test('match by barcode, by name, by "name variant"', () => {
  const r = matchImageFiles(['4860002.jpg', 'ჩანთა შავი.PNG', 'ჩანთა.webp'], targets, true);
  const m = Object.fromEntries(r.matched.map((x) => [x.fileName, x.target.id]));
  assert.equal(m['4860002.jpg'], 'v1');
  assert.equal(m['ჩანთა შავი.PNG'], 'v2');
  assert.equal(m['ჩანთა.webp'], 'pp');
});

test('unmatched and existing-photo handling', () => {
  const r = matchImageFiles(['4860001.jpg', 'unknown.jpg'], targets, false);
  assert.equal(r.skippedExisting.length, 1);
  assert.equal(r.unmatched.length, 1);
  assert.equal(matchImageFiles(['4860001.jpg'], targets, true).matched.length, 1);
});

test('two files for one product: first (by name) wins, the other is a duplicate', () => {
  const r = matchImageFiles(['4860002_b.jpg', '4860002.jpg', '4860002.png'], targets, true);
  assert.equal(r.matched.length, 1);
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.unmatched.length, 1); // 4860002_b matches nothing
});

test('same name on two products is ambiguous', () => {
  const t = buildImageTargets([
    { kind: 'product', id: 'a', product_id: 'a', name: 'ერთნაირი', variant_name: null, sku: null, active: true },
    { kind: 'product', id: 'b', product_id: 'b', name: 'ერთნაირი', variant_name: null, sku: null, active: true },
  ], () => false);
  assert.equal(matchImageFiles(['ერთნაირი.jpg'], t, true).ambiguous.length, 1);
});

test('helpers', () => {
  assert.equal(normKey(' მინის  საწმენდი / უნივერსალი '), 'მინისსაწმენდიუნივერსალი');
  assert.equal(thumbUrl('https://x.supabase.co/storage/v1/object/public/product-images/p/a.webp?v=1'), 'https://x.supabase.co/storage/v1/object/public/product-images/p/a_s.webp?v=1');
});
