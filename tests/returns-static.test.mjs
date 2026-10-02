import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const load = (file) => readFile(new URL('../' + file, import.meta.url), 'utf8');
const migrationName = '202610020001_pos_returns.sql';

test('returns migration: unique version, forced RLS, immutable history, restricted RPC grants', async () => {
  const files = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter((f) => /^\d+_.+\.sql$/.test(f));
  assert.equal(new Set(files.map((f) => f.split('_')[0])).size, files.length);
  assert.ok(files.includes(migrationName));
  assert.ok(files.indexOf(migrationName) > files.indexOf('202610010002_pos_cash_withdrawals.sql'));

  const sql = await load('supabase/migrations/' + migrationName);
  for (const table of ['pos_returns', 'pos_return_items', 'pos_return_refunds']) {
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /enable row level security/);
  assert.match(sql, /force row level security/);
  assert.match(sql, /revoke all on public\.%I from public, anon, authenticated, service_role/);
  assert.match(sql, /grant select on public\.%I to authenticated/);
  assert.match(sql, /RETURN_IMMUTABLE/);
  assert.match(sql, /before update or delete/);
  assert.match(sql, /before truncate/);

  // Every function is a definer with an empty search_path and a read-committed guard where it writes.
  const definers = sql.match(/create function public\.\w+[\s\S]*?\$\$;?/g) ?? [];
  assert.ok(definers.length >= 4);
  for (const def of definers.filter((d) => /security definer/.test(d))) {
    assert.match(def, /set search_path = ''/);
  }
  const complete = sql.slice(sql.indexOf('create function public.pos_complete_return'));
  assert.match(complete, /set lock_timeout = '5s'/);
  assert.match(complete, /transaction_isolation[\s\S]*read committed/);
  assert.match(complete, /REQUEST_CONFLICT/);
  assert.match(complete, /REFUND_TOTAL_MISMATCH/);
  assert.match(complete, /RETURN_QUANTITY_EXCEEDED/);
  assert.match(complete, /INSUFFICIENT_CASH/);

  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(sql, /grant execute on function public\.pos_return_sale_details\(bigint\), public\.pos_complete_return\(uuid,uuid,uuid,jsonb,jsonb,text\)/);
  // The private cash helper and the immutability trigger are never granted to API roles.
  const grant = sql.slice(sql.lastIndexOf('grant execute on function'));
  assert.doesNotMatch(grant, /pos_session_cash_totals|pos_returns_immutable/);
  assert.doesNotMatch(sql, /grant [^;]*to (anon|public|service_role)/i);
});

test('return Server Action calls the RPC with the request id and offers the screen from the sale page and menu', async () => {
  const action = await load('app/(pos)/returns/actions.ts');
  assert.match(action, /rpc\("pos_complete_return"/);
  assert.match(action, /p_request: requestId/);
  assert.match(action, /error=failed&request=\$\{requestId\}/);
  const nav = await load('app/components/pos-navigation.tsx');
  assert.match(nav, /href: "\/returns"/);
  const sale = await load('app/(pos)/sales/[id]/page.tsx');
  assert.match(sale, /\/returns\?number=/);
});
