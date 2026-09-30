import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyClosedSession } from '../scripts/staging-concurrency-close.mjs';

const row = { status: 'closed', closing_note: 'test', opened_at: '2026-09-30T10:00:00.123456+00:00', closed_at: '2026-09-30T10:00:00.123457+00:00' };
test('close validation never reads the client clock', () => {
  const original = Date.now;
  Date.now = () => { throw new Error('Local clock must not be used'); };
  try { assert.doesNotThrow(() => verifyClosedSession(row, 'test')); }
  finally { Date.now = original; }
});
test('equivalent database instants with different offsets are accepted', () => {
  verifyClosedSession({ ...row, closed_at: '2026-09-30T14:00:00.123456+04:00' }, 'test');
});
test('one microsecond before opening is rejected', () => {
  assert.throws(() => verifyClosedSession({ ...row, closed_at: '2026-09-30T10:00:00.123455Z' }, 'test'), /precedes opening/);
});
test('missing session, wrong state, wrong note and invalid timestamps have distinct failures', () => {
  assert.throws(() => verifyClosedSession(undefined, 'test'), /did not close/);
  assert.throws(() => verifyClosedSession({ ...row, status: 'open' }, 'test'), /did not close/);
  assert.throws(() => verifyClosedSession(row, 'different'), /note mismatch/);
  for (const closed_at of [null, '', 'invalid', '2026-09-30T10:00:00']) {
    assert.throws(() => verifyClosedSession({ ...row, closed_at }, 'test'), /timestamp format/);
  }
});
