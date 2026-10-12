// ფოტოების ფაილების ავტომატური მიბმა პროდუქტებზე ფაილის სახელით (სუფთა ლოგიკა, ტესტირებადი).
// ფაილის სახელი = ბარკოდი (SKU) ან პროდუქტის სახელი. ვარიანტი: „პროდუქტი ვარიანტი“.
export type ImageTarget = {
  kind: "product" | "variant";
  id: string;
  label: string;
  sku: string | null;
  names: string[];
  hasImage: boolean;
  extraCount: number;
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

export const MAX_PHOTOS = 7; // 1 მთავარი + 6 დამატებითი

export function buildImageTargets(
  items: CatalogItemLike[],
  hasImage: (kind: "product" | "variant", id: string) => boolean,
  extraCount: (kind: "product" | "variant", id: string) => number = () => 0,
): ImageTarget[] {
  const targets: ImageTarget[] = [];
  const parents = new Map<string, string>();
  for (const item of items) {
    if (!item.active) continue;
    if (item.kind === "product") {
      targets.push({ kind: "product", id: item.id, label: item.name, sku: item.sku, names: [item.name], hasImage: hasImage("product", item.id), extraCount: extraCount("product", item.id) });
    } else {
      targets.push({
        kind: "variant",
        id: item.id,
        label: `${item.name} / ${item.variant_name ?? ""}`,
        sku: item.sku,
        names: [`${item.name} ${item.variant_name ?? ""}`],
        hasImage: hasImage("variant", item.id),
        extraCount: extraCount("variant", item.id),
      });
      parents.set(item.product_id, item.name);
    }
  }
  for (const [id, name] of parents) {
    targets.push({ kind: "product", id, label: `${name} (საერთო ფოტო)`, sku: null, names: [name], hasImage: hasImage("product", id), extraCount: extraCount("product", id) });
  }
  return targets;
}

export type MatchResult = {
  matched: { index: number; fileName: string; target: ImageTarget; slot: number }[];
  skippedExisting: { index: number; fileName: string; target: ImageTarget; slot: number }[];
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
  const claimed = new Map<string, string>();
  const order = fileNames.map((name, index) => ({ name, index })).sort((a, b) => a.name.localeCompare(b.name, "ka", { numeric: true }));
  const find = (base: string) => bySku.get(base.trim().toLowerCase()) ?? byName.get(normKey(base)) ?? [];

  for (const { name, index } of order) {
    const base = baseName(name);
    let slot = 1;
    let candidates = find(base);
    // „სახელი-2“ … „სახელი-7“ = იმავე პროდუქტის დამატებითი ფოტო (სრული სახელის დამთხვევას ყოველთვის პირველობა აქვს)
    const extra = /^(.*\S)\s*[-_]\s*([2-7])$/.exec(base);
    if (candidates.length === 0 && extra) {
      candidates = find(extra[1]);
      slot = Number(extra[2]);
    }
    if (candidates.length === 0) { result.unmatched.push({ index, fileName: name }); continue; }
    if (candidates.length > 1) { result.ambiguous.push({ index, fileName: name, candidates: candidates.map((c) => c.label) }); continue; }
    const target = candidates[0];
    const key = `${target.kind}:${target.id}:${slot}`;
    const first = claimed.get(key);
    if (first !== undefined) { result.duplicates.push({ index, fileName: name, of: first }); continue; }
    claimed.set(key, name);
    const occupied = slot === 1 ? target.hasImage : slot - 2 < target.extraCount;
    if (occupied && !replaceExisting) result.skippedExisting.push({ index, fileName: name, target, slot });
    else result.matched.push({ index, fileName: name, target, slot });
  }
  return result;
}

// დამატებითი ფოტოების (სლოტი 2..7) სიის განახლება: არსებულ ადგილზე ჩანაცვლება, ახალი ბოლოში ემატება (მაქს. 6).
export function applyExtras(current: string[], placements: { slot: number; url: string }[]): string[] {
  const list = [...current];
  for (const { slot, url } of [...placements].sort((a, b) => a.slot - b.slot)) {
    const index = slot - 2;
    if (index < 0) continue;
    if (index < list.length) list[index] = url;
    else if (list.length < MAX_PHOTOS - 1) list.push(url);
  }
  return list;
}
