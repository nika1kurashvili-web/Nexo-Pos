// Explicit opt-in only. Never log query results, identifiers, URLs, or errors.
type QueryLabel = "session" | "products" | "variants" | "payment_methods" | "customers" | "customer_prices";

export async function measureSaleQuery<T extends { data: unknown; error: unknown }>(
  label: QueryLabel,
  query: PromiseLike<T>,
): Promise<T> {
  if (process.env.NODE_ENV !== "development" || process.env.POS_PERF_DIAGNOSTICS !== "1") {
    return await query;
  }
  const started = performance.now();
  const result = await query;
  console.info("[nexo-pos-perf]", JSON.stringify({
    query: label,
    durationMs: Math.round(performance.now() - started),
    rows: Array.isArray(result.data) ? result.data.length : 0,
    // Decoded JSON size, not compressed network or React payload size.
    jsonBytes: new TextEncoder().encode(JSON.stringify(result.data ?? null)).byteLength,
    failed: Boolean(result.error),
  }));
  return result;
}
