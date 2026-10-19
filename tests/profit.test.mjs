import test from "node:test";
import assert from "node:assert/strict";
import { toProfitRows, filterRows, sortRows, totalsOf, toCsv } from "../lib/pos/profit.ts";

const rows = toProfitRows([
  { name: "ფარი", sku: "A1", quantity: 2, revenue: 40, avg_price: 20, unit_cost: 10, cost: 20, profit: 20 },
  { name: "ლამპა", sku: "B2", quantity: "3", revenue: "30", avg_price: 10, unit_cost: null, cost: null, profit: null },
  { name: "კაბელი", sku: null, quantity: 1, revenue: 9, avg_price: 9, unit_cost: 3, cost: 3, profit: 6 },
]);

test("markup percent is profit over cost; unknown cost stays null", () => {
  assert.equal(rows[0].markupPct, 100);
  assert.equal(rows[1].markupPct, null);
  assert.equal(rows[2].markupPct, 200);
});

test("filters by text and numeric ranges; unknown values never match a range", () => {
  const f = { name: "", sku: "", ranges: {} };
  assert.equal(filterRows(rows, { ...f, name: "ფარ" }).length, 1);
  assert.equal(filterRows(rows, { ...f, sku: "b2" }).length, 1);
  assert.equal(filterRows(rows, { ...f, ranges: { profit: { min: "0", max: "" } } }).length, 2);
  assert.equal(filterRows(rows, { ...f, ranges: { revenue: { min: "10", max: "35" } } }).length, 1);
});

test("sort puts unknown last in both directions", () => {
  assert.equal(sortRows(rows, "profit", "asc").at(-1).name, "ლამპა");
  assert.equal(sortRows(rows, "profit", "desc").at(-1).name, "ლამპა");
  assert.equal(sortRows(rows, "revenue", "desc")[0].name, "ფარი");
});

test("totals exclude unknown-cost rows from cost and profit", () => {
  const t = totalsOf(rows);
  assert.equal(t.revenue, 79);
  assert.equal(t.cost, 23);
  assert.equal(t.profit, 26);
  assert.equal(t.unknownCount, 1);
  assert.equal(Math.round(t.markupPct * 10) / 10, 113);
});

test("csv has BOM, header and escaped cells", () => {
  const csv = toCsv([{ ...rows[0], name: 'ა"ბ,გ' }]);
  assert.ok(csv.startsWith("﻿დასახელება"));
  assert.ok(csv.includes('"ა""ბ,გ"'));
});
