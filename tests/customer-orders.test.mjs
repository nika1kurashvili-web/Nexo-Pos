import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterOrders, orderFigures, sumFigures } from '../lib/pos/customer-orders.ts';

const o1 = { order_date: '2026-10-01', total: '36.50', paid: '10', items: [
  { quantity: '3', unit_price: '5.5', unit_cost: '3' },
  { quantity: '2', unit_price: '10', unit_cost: null },
] };
const o2 = { order_date: '2026-10-09', total: '20', paid: '20', items: [{ quantity: '1', unit_price: '20', unit_cost: '12.5' }] };

test('order figures: total, paid, remaining, cost, profit, missing', () => {
  assert.deepEqual(orderFigures(o1), { total: 3650, paid: 1000, remaining: 2650, cost: 900, profit: 750, missing: 1 });
  assert.deepEqual(orderFigures(o2), { total: 2000, paid: 2000, remaining: 0, cost: 1250, profit: 750, missing: 0 });
});

test('sums across orders', () => {
  assert.deepEqual(sumFigures([o1, o2]), { total: 5650, paid: 3000, remaining: 2650, cost: 2150, profit: 1500, missing: 1 });
});

test('date filter is inclusive and ignores invalid bounds', () => {
  const all = [o1, o2];
  assert.equal(filterOrders(all, '2026-10-02', '').length, 1);
  assert.equal(filterOrders(all, '', '2026-10-01').length, 1);
  assert.equal(filterOrders(all, '2026-10-01', '2026-10-09').length, 2);
  assert.equal(filterOrders(all, 'bad', 'worse').length, 2);
  assert.equal(filterOrders(all, '2026-10-10', '').length, 0);
});
