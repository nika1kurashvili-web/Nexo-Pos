import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReturnStatus } from '../lib/pos/return-status.ts';

const items = [{ id: 'a', quantity: '2' }, { id: 'b', quantity: '0.5' }];

test('no returns -> none', () => {
  assert.equal(computeReturnStatus(items, []), 'none');
  assert.equal(computeReturnStatus([], []), 'none');
});
test('some returned -> partial', () => {
  assert.equal(computeReturnStatus(items, [{ sale_item_id: 'a', quantity: '1' }]), 'partial');
  assert.equal(computeReturnStatus(items, [{ sale_item_id: 'a', quantity: '2' }]), 'partial');
});
test('everything returned (even in several returns) -> full', () => {
  assert.equal(computeReturnStatus(items, [
    { sale_item_id: 'a', quantity: '1' }, { sale_item_id: 'a', quantity: '1' }, { sale_item_id: 'b', quantity: '0.5' },
  ]), 'full');
});
test('decimal quantities do not drift', () => {
  const t = [{ id: 'x', quantity: '0.3' }];
  assert.equal(computeReturnStatus(t, [{ sale_item_id: 'x', quantity: '0.1' }, { sale_item_id: 'x', quantity: '0.2' }]), 'full');
});
