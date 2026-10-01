import assert from "node:assert/strict";
import { test } from "node:test";
import { measureSaleQuery } from "../lib/performance.ts";

test("query metrics are opt-in development only and never print payloads or errors", async () => {
  const previousEnv = process.env.NODE_ENV, previousFlag = process.env.POS_PERF_DIAGNOSTICS;
  const previousInfo = console.info;
  const lines = [];
  const result = { data: [{ secret: "DO_NOT_LOG_DATA" }], error: { message: "DO_NOT_LOG_ERROR" } };
  console.info = (...args) => lines.push(args.join(" "));
  try {
    for (const [environment, flag] of [["production", "1"], ["development", "0"]]) {
      process.env.NODE_ENV = environment; process.env.POS_PERF_DIAGNOSTICS = flag;
      assert.equal(await measureSaleQuery("products", Promise.resolve(result)), result);
      assert.equal(lines.length, 0);
    }
    process.env.NODE_ENV = "development"; process.env.POS_PERF_DIAGNOSTICS = "1";
    assert.equal(await measureSaleQuery("products", Promise.resolve(result)), result);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes("DO_NOT_LOG"));
    const metrics = JSON.parse(lines[0].slice("[nexo-pos-perf] ".length));
    assert.equal(metrics.rows, 1); assert.equal(metrics.failed, true);
    assert.equal(metrics.jsonBytes, Buffer.byteLength(JSON.stringify(result.data)));
    assert.ok(metrics.durationMs >= 0);
  } finally {
    console.info = previousInfo;
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
    if (previousFlag === undefined) delete process.env.POS_PERF_DIAGNOSTICS; else process.env.POS_PERF_DIAGNOSTICS = previousFlag;
  }
});
