import test from "node:test";
import assert from "node:assert/strict";
import { parseFilters, filtersToQuery, sanitizeQuery, matchesFilters } from "../lib/pos/product-filters.ts";

const item = (over = {}) => ({ name: "ფარი", variant_name: null, sku: "A-100", category: "მანქანა", stock: 5, cost: 10, price: 15, active: true, ...over });

test("parseFilters ignores junk and keeps valid values", () => {
  const f = parseFilters({ name: " ფარი ", cat: "x", status: "zzz", stock_min: "abc", price_max: "12,5", all: "1" });
  assert.equal(f.name, "ფარი");
  assert.equal(f.cat, "");
  assert.equal(f.status, "all");
  assert.equal(f.stock_min, "");
  assert.equal(f.price_max, "12,5");
});

test("query round trip and sanitizing", () => {
  const qs = filtersToQuery(parseFilters({ sku: "A-1", stock_min: "2", evil: "1" }));
  assert.equal(qs, "sku=A-1&stock_min=2");
  assert.equal(sanitizeQuery("sku=A-1&evil=2&cat=bad"), "sku=A-1");
});

test("active only by default, status switches", () => {
  assert.equal(matchesFilters(item({ active: false }), parseFilters({})), false);
  assert.equal(matchesFilters(item({ active: false }), parseFilters({ status: "all" })), true);
  assert.equal(matchesFilters(item({ active: true }), parseFilters({ status: "inactive" })), false);
});

test("text filters are case-insensitive substrings", () => {
  assert.equal(matchesFilters(item(), parseFilters({ sku: "a-1" })), true);
  assert.equal(matchesFilters(item(), parseFilters({ name: "კარი" })), false);
});

test("range filters: stock, cost, price, margin", () => {
  assert.equal(matchesFilters(item(), parseFilters({ stock_min: "5", stock_max: "5" })), true);
  assert.equal(matchesFilters(item(), parseFilters({ stock_min: "6" })), false);
  assert.equal(matchesFilters(item(), parseFilters({ cost_min: "10", cost_max: "11" })), true);
  assert.equal(matchesFilters(item(), parseFilters({ price_max: "14.99" })), false);
  assert.equal(matchesFilters(item(), parseFilters({ margin_min: "5", margin_max: "5" })), true);
  assert.equal(matchesFilters(item({ cost: null }), parseFilters({ margin_min: "0" })), false);
});

test("category filter incl. none", () => {
  assert.equal(matchesFilters(item({ category: null }), parseFilters({ cat: "none" })), true);
  assert.equal(matchesFilters(item(), parseFilters({ cat: "ტექნიკა" })), false);
});
