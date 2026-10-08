import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportPlan, PRODUCT_SHEET_HEADER } from '../lib/pos/product-import.ts';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const current = [
  { kind: 'product', id: A, name: 'რძე', variant_name: null, sku: '111', price: '2', stock: '5', cost: '1.2', active: true },
  { kind: 'variant', id: B, name: 'ჩანთა', variant_name: 'წითელი', sku: '222', price: '10', stock: '0', cost: null, active: true },
  { kind: 'product', id: C, name: 'ძველი', variant_name: null, sku: null, price: '1', stock: '0', cost: null, active: false },
];
const H = PRODUCT_SHEET_HEADER.filter((h) => h !== 'კატეგორია');

test('no changes -> unchanged only', () => {
  const plan = buildImportPlan([H, [A, 'რძე', '', 111, 1.2, 2, 5, 'დიახ'], [B, 'ჩანთა', 'წითელი', '222', '', 10, 0, 'დიახ']], current);
  assert.equal(plan.changes.length, 0); assert.equal(plan.unchanged, 2); assert.equal(plan.errors.length, 0);
});

test('detects price, cost, sku, stock, name, active changes', () => {
  const plan = buildImportPlan([H, [A, 'რძე 1ლ', '', '999', '1,5', '2,5', 5, 'არა'], [B, 'ჩანთა', 'ლურჯი', '222', 4, 10, 0, 'დიახ']], current);
  const a = plan.changes[0];
  assert.deepEqual(a.set, { name: 'რძე 1ლ', sku: '999', cost: '1.5', price: '2.5', active: false });
  assert.equal(plan.errors.length, 0);
  const bad = buildImportPlan([H, [A, 'რძე', '', '111', '', '', 7, 'არა']], current);
  assert.equal(bad.errors.length, 1); // stock change on item being deactivated
  const b = plan.changes.find((c) => c.id === B);
  assert.deepEqual(b.set, { variant_name: 'ლურჯი', cost: '4' });
});

test('stock change on active item', () => {
  const plan = buildImportPlan([H, [A, 'რძე', '', '111', '', '', '8', '']], current);
  assert.deepEqual(plan.changes[0].set, { stock: '8' });
});

test('new product and validation errors', () => {
  const plan = buildImportPlan([H,
    ['', 'ახალი', '', 'N1', 3, 6, 10, ''],
    ['', 'ფასის გარეშე', '', '', '', '', '', ''],
    ['', 'ვარიანტიანი', 'X', '', '', 5, '', ''],
    ['bad-id', 'x', '', '', '', 1, '', ''],
    [A, 'რძე', '', '', '', 'abc', '', ''],
  ], current);
  assert.equal(plan.changes.length, 1);
  assert.deepEqual(plan.changes[0].set, { name: 'ახალი', price: '6', sku: 'N1', cost: '3', stock: '10' });
  assert.deepEqual(plan.errors.map((e) => e.row), [3, 4, 5, 6]);
});

test('duplicate barcode is flagged only for touched rows', () => {
  const plan = buildImportPlan([H, [A, 'რძე', '', '222', '', '', '', ''], ['', 'ახალი', '', '222', '', 5, '', '']], current);
  assert.equal(plan.errors.length, 2);
  const ok = buildImportPlan([H, [A, 'რძე', '', '111', '', '', '', '']], [...current, { ...current[0], id: '44444444-4444-4444-8444-444444444444', sku: '111' }]);
  assert.equal(ok.errors.length, 0);
});

test('missing columns / duplicate ids', () => {
  assert.ok('error' in buildImportPlan([['a', 'b']], current));
  const plan = buildImportPlan([H, [A, 'რძე', '', '', '', 3, '', ''], [A, 'რძე', '', '', '', 4, '', '']], current);
  assert.equal(plan.errors.length, 1);
});

test('unchanged negative stock and long-decimal cost are not errors', () => {
  const cur = [{ kind: 'variant', id: A, name: 'უნივერსალი', variant_name: 'N12', sku: '9', price: '19', stock: '-1739', cost: '4.3333', active: true }];
  const plan = buildImportPlan([H, [A, 'უნივერსალი', 'N12', '9', 4.3333, 19, -1739, 'დიახ']], cur);
  assert.equal(plan.errors.length, 0); assert.equal(plan.changes.length, 0); assert.equal(plan.unchanged, 1);
  const edited = buildImportPlan([H, [A, 'უნივერსალი', 'N12', '9', 4.3333, 20, -1739, 'დიახ']], cur);
  assert.deepEqual(edited.changes[0].set, { price: '20' });
  const bad = buildImportPlan([H, [A, 'უნივერსალი', 'N12', '9', 4.3333, 19, -5, 'დიახ']], cur);
  assert.equal(bad.errors.length, 1);
});

test('items missing from the file are proposed for removal, never auto-applied', () => {
  const plan = buildImportPlan([H, [A, 'რძე', '', '111', '', '', '', '']], current);
  assert.deepEqual(plan.removals.map((r) => r.id).sort(), [B, C].sort());
  assert.equal(plan.changes.length, 0);
  const empty = buildImportPlan([H], current);
  assert.equal(empty.removals.length, 0); // ცარიელი ფაილი ყველაფრის წაშლას არ სთავაზობს
});

test('category column: set, validate, per-product consistency', () => {
  const H2 = [...H.slice(0, 3), 'კატეგორია', ...H.slice(3)];
  const cur = [
    { kind: 'variant', id: A, product_id: C, name: 'ჩანთა', variant_name: 'a', sku: '1', price: '1', stock: '0', cost: null, active: true, category: null },
    { kind: 'variant', id: B, product_id: C, name: 'ჩანთა', variant_name: 'b', sku: '2', price: '1', stock: '0', cost: null, active: true, category: null },
  ];
  const ok = buildImportPlan([H2, [A, 'ჩანთა', 'a', 'მანქანა', '1', '', '', '', ''], [B, 'ჩანთა', 'b', 'მანქანა', '2', '', '', '', '']], cur);
  assert.equal(ok.errors.length, 0); assert.equal(ok.changes.length, 2); assert.equal(ok.changes[0].set.category, 'მანქანა');
  const conflict = buildImportPlan([H2, [A, 'ჩანთა', 'a', 'მანქანა', '1', '', '', '', ''], [B, 'ჩანთა', 'b', 'ტექნიკა', '2', '', '', '', '']], cur);
  assert.equal(conflict.errors.length, 1);
  const bad = buildImportPlan([H2, [A, 'ჩანთა', 'a', 'სხვა', '1', '', '', '', '']], cur);
  assert.equal(bad.errors.length, 1);
  const created = buildImportPlan([H2, ['', 'ახალი', '', 'ტექნიკა', 'N', '', 5, '', '']], cur);
  assert.equal(created.changes[0].set.category, 'ტექნიკა');
  const same = buildImportPlan([H2, [A, 'ჩანთა', 'a', '', '1', '', '', '', '']], cur);
  assert.equal(same.changes.length, 0);
});

test('product name changed on a variant row renames the whole product (no warning)', () => {
  const cur = [
    { kind: 'variant', id: A, product_id: C, name: 'მინის საწმენდი ', variant_name: 'a', sku: '1', price: '1', stock: '0', cost: null, active: true, category: null },
    { kind: 'variant', id: B, product_id: C, name: 'მინის საწმენდი ', variant_name: 'b', sku: '2', price: '1', stock: '0', cost: null, active: true, category: null },
  ];
  const same = buildImportPlan([H, [A, 'მინის საწმენდი', 'a', '1', '', '', '', ''], [B, 'მინის საწმენდი', 'b', '2', '', '', '', '']], cur);
  assert.equal(same.changes.length, 0); assert.equal(same.warnings.length, 0); // trailing space in DB is not a change
  const one = buildImportPlan([H, [A, 'ახალი სახელი', 'a', '1', '', '', '', ''], [B, 'მინის საწმენდი', 'b', '2', '', '', '', '']], cur);
  assert.deepEqual(one.changes.map((c) => c.set), [{ product_name: 'ახალი სახელი' }]);
  const clash = buildImportPlan([H, [A, 'X', 'a', '1', '', '', '', ''], [B, 'Y', 'b', '2', '', '', '', '']], cur);
  assert.equal(clash.errors.length, 1);
});
