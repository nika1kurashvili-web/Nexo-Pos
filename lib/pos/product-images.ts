// ფოტოების ფაილების ავტომატური მიბმა პროდუქტებზე ფაილის სახელით (სუფთა ლოგიკა, ტესტირებადი).
// ფაილის სახელი = ბარკოდი (SKU) ან პროდუქტის სახელი. ვარიანტი: „პროდუქტი ვარიანტი“.
export type ImageTarget = {
  kind: "product" | "variant";
  id: string;
  label: string;
  sku: string | null;
  names: string[];
  hasImage: boolean;
};

export type CatalogItemLike = {
  kind: "product" | "variant";
  id: string;
  product_id: string;
  name: string;
  variant_name: string | null;
  sku: string | null;
  active: boolean;
};

// მხოლოდ ასოები და ციფრები, პატარა ასოებით: ცარიელი ადგილი, ტირე, ხაზი, სლეში არ ითვლება.
export function normKey(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const baseName = (fileName: string) => fileName.replace(/\.[A-Za-z0-9]{1,5}$/, "");

export function thumbUrl(url: string): string {
  return url.replace(/\.(webp|jpg)(\?|$)/, "_s.$1$2");
}

export function buildImageTargets(
  items: CatalogItemLike[],
  hasImage: (kind: "product" | "variant", id: string) => boolean,
): ImageTarget[] {
  const targets: ImageTarget[] = [];
  const parents = new Map<string, string>();
  for (const item of items) {
    if (!item.active) continue;
    if (item.kind === "product") {
      targets.push({ kind: "product", id: item.id, label: item.name, sku: item.sku, names: [item.name], hasImage: hasImage("product", item.id) });
    } else {
      targets.push({
        kind: "variant",
        id: item.id,
        label: `${item.name} / ${item.variant_name ?? ""}`,
        sku: item.sku,
        names: [`${item.name} ${item.variant_name ?? ""}`],
        hasImage: hasImage("variant", item.id),
      });
      parents.set(item.product_id, item.name);
    }
  }
  for (const [id, name] of parents) {
    targets.push({ kind: "product", id, label: `${name} (საერთო ფოტო)`, sku: null, names: [name], hasImage: hasImage("product", id) });
  }
  return targets;
}

export type MatchResult = {
  matched: { index: number; fileName: string; target: ImageTarget }[];
  skippedExisting: { index: number; fileName: string; target: ImageTarget }[];
  duplicates: { index: number; fileName: string; of: string }[];
  ambiguous: { index: number; fileName: string; candidates: string[] }[];
  unmatched: { index: number; fileName: string }[];
};

export function matchImageFiles(fileNames: string[], targets: ImageTarget[], replaceExisting: boolean): MatchResult {
  const bySku = new Map<string, ImageTarget[]>();
  const byName = new Map<string, ImageTarget[]>();
  const push = (map: Map<string, ImageTarget[]>, key: string, target: ImageTarget) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.includes(target)) list.push(target);
    map.set(key, list);
  };
  for (const target of targets) {
    if (target.sku) push(bySku, target.sku.trim().toLowerCase(), target);
    for (const name of target.names) push(byName, normKey(name), target);
  }

  const result: MatchResult = { matched: [], skippedExisting: [], duplicates: [], ambiguous: [], unmatched: [] };
  const claimed = new Map<ImageTarget, string>();
  const order = fileNames.map((name, index) => ({ name, index })).sort((a, b) => a.name.localeCompare(b.name, "ka", { numeric: true }));

  for (const { name, index } of order) {
    const base = baseName(name);
    const candidates = bySku.get(base.trim().toLowerCase()) ?? byName.get(normKey(base)) ?? [];
    if (candidates.length === 0) { result.unmatched.push({ index, fileName: name }); continue; }
    if (candidates.length > 1) { result.ambiguous.push({ index, fileName: name, candidates: candidates.map((c) => c.label) }); continue; }
    const target = candidates[0];
    const first = claimed.get(target);
    if (first !== undefined) { result.duplicates.push({ index, fileName: name, of: first }); continue; }
    claimed.set(target, name);
    if (target.hasImage && !replaceExisting) result.skippedExisting.push({ index, fileName: name, target });
    else result.matched.push({ index, fileName: name, target });
  }
  return result;
}
