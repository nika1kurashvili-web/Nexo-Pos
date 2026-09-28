export type CatalogTarget = { kind: "product" | "variant"; target: string; sku: string | null };
export type PricePreview = {
  row: number; sku: string; state: "found" | "not_found" | "invalid" | "conflict";
  price?: string; target?: CatalogTarget;
};

// Prices stay decimal strings; no binary floating-point arithmetic. The future
// XLSX adapter must preserve barcode/SKU cells as text (including leading zeros).
export function parsePrice(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return `${BigInt(whole)}.${fraction.padEnd(2, "0")}`;
}

// Input is decoded worksheet data, without a header row. Workbook decoding is
// deliberately separate; no XLSX dependency is installed in the runtime app.
export function previewWholesalePrices(rows: unknown[][], catalog: CatalogTarget[]): PricePreview[] {
  if (rows.length > 2000) throw new Error("IMPORT_TOO_LARGE");
  const targets = new Map<string, CatalogTarget[]>();
  for (const item of catalog) {
    const sku = item.sku?.trim();
    if (sku) targets.set(sku, [...(targets.get(sku) ?? []), item]);
  }
  const counts = new Map<string, number>();
  for (const [value] of rows) {
    if (typeof value === "string") counts.set(value.trim(), (counts.get(value.trim()) ?? 0) + 1);
  }
  return rows.map(([value, rawPrice], index) => {
    const sku = typeof value === "string" ? value.trim() : "";
    const price = parsePrice(rawPrice);
    const base = { row: index + 2, sku };
    if (!sku || price === null) return { ...base, state: "invalid" };
    const found = targets.get(sku) ?? [];
    if ((counts.get(sku) ?? 0) > 1 || found.length > 1) return { ...base, state: "conflict", price };
    if (!found.length) return { ...base, state: "not_found", price };
    return { ...base, state: "found", price, target: found[0] };
  });
}

export function confirmedPriceRows(preview: PricePreview[]) {
  if (!preview.length || preview.some((row) => row.state !== "found" || !row.target || !row.price)) {
    throw new Error("RESOLVE_IMPORT_ERRORS_FIRST");
  }
  return preview.map((row) => ({ kind: row.target!.kind, target: row.target!.target, price: row.price! }));
}
