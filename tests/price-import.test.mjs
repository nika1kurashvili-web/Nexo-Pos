import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePrice, previewWholesalePrices, confirmedPriceRows } from "../lib/pos/import-prices.ts";

test("money is normalized without floating-point calculations", () => {
  assert.equal(parsePrice("0001.2"), "1.20");
  assert.equal(parsePrice("0"), "0.00");
  for (const value of [-1, NaN, Infinity, "1.001", "1e3", "1,20", "", {}, null]) assert.equal(parsePrice(value), null);
});
test("preview matches both catalogs, preserves leading zeros and rejects ambiguity", () => {
  const catalog = [{ kind: "product", target: "1", sku: "001" }, { kind: "variant", target: "2", sku: "V" },
    { kind: "product", target: "3", sku: "D" }, { kind: "variant", target: "4", sku: "D" }];
  const result = previewWholesalePrices([["001", "2.00"], ["V", "3"], ["missing", "1"], ["D", "1"], [42, 1], ["bad", -1]], catalog);
  assert.deepEqual(result.map((row) => row.state), ["found", "found", "not_found", "conflict", "invalid", "invalid"]);
  assert.deepEqual(confirmedPriceRows(result.slice(0, 2)), [{ kind: "product", target: "1", price: "2.00" }, { kind: "variant", target: "2", price: "3.00" }]);
  assert.throws(() => confirmedPriceRows(result));
  assert.deepEqual(previewWholesalePrices([["001", 1], ["001", 2]], catalog).map((r) => r.state), ["conflict", "conflict"]);
});
