import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const route = await readFile(new URL('../app/(pos)/customers/[id]/prices-template/route.ts', import.meta.url), 'utf8');
const actions = await readFile(new URL('../app/(pos)/actions.ts', import.meta.url), 'utf8');

test('price template is admin-only and uses the headers the Excel import understands', () => {
  assert.match(route, /await requireAdmin\(\)/);
  // The import reads the first sheet and the columns "sku" and "ფასი".
  assert.match(route, /const header = \["SKU", "პროდუქტი", "საცალო ფასი", "ფასი"\]/);
  assert.match(actions, /normalized\.sku/);
  assert.match(actions, /normalized\["ფასი"\]/);
  assert.ok(route.indexOf('"ფასები"') < route.indexOf('"გამოტოვებული"'), 'prices sheet must be first');
  // SKU cells stay text so leading zeros survive an Excel round trip.
  assert.match(route, /\{ t: "s", v: item\.sku \}/);
});
