import type { ProductOverviewItem } from "./types";

export const PRODUCT_SHEET_HEADER = [
  "ID (არ შეცვალოთ)", "პროდუქტი", "ვარიანტი", "ბარკოდი", "შესყიდვის ფასი", "გასაყიდი ფასი", "მარაგი", "აქტიური",
];

export type ProductFields = {
  name?: string;
  variant_name?: string;
  sku?: string;
  price?: string;
  cost?: string;
  stock?: string;
  active?: boolean;
};

export type ProductChange = {
  row: number;
  op: "update" | "create";
  id: string | null;
  label: string;
  set: ProductFields;
  was: Partial<Record<keyof ProductFields, string>>;
};

export type ImportPlan = {
  changes: ProductChange[];
  errors: { row: number; message: string }[];
  warnings: { row: number; message: string }[];
  unchanged: number;
};

// inventory.ts-ის იგივე წესები (აქ ცალკეა, რომ ფაილი დამოუკიდებლად ტესტირდებოდეს).
const normalizeDecimal = (value: string) => value.trim().replace(",", ".");
const isCount = (value: string) => /^\d{1,11}([.,]\d{1,3})?$/.test(value.trim());
const isPrice = (value: string) => /^\d{1,12}([.,]\d{1,2})?$/.test(value.trim());
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown) => (typeof value === "number" ? String(value) : String(value ?? "").trim());
const cents = (value: string | number | null | undefined) => Math.round(Number(value ?? 0) * 100);
const thousandths = (value: string | number | null | undefined) => Math.round(Number(value ?? 0) * 1000);
// უცვლელი რიცხვი (უარყოფითი მარაგი, 2 ნიშნზე მეტი ათწილადი) შეცდომად არ უნდა ჩაითვალოს.
const sameNumber = (raw: string, current: string | number | null | undefined) =>
  current !== null && current !== undefined && Number.isFinite(Number(raw)) && Math.abs(Number(raw) - Number(current)) < 1e-6;
const norm = (value: string) => value.trim().toLowerCase();

function parseActive(value: string): boolean | null {
  const v = norm(value);
  if (["დიახ", "კი", "yes", "true", "1", "აქტიური"].includes(v)) return true;
  if (["არა", "no", "false", "0", "გაუქმებული"].includes(v)) return false;
  return null;
}

function findCol(header: string[], test: (h: string) => boolean) {
  return header.findIndex(test);
}

export function buildImportPlan(table: unknown[][], current: ProductOverviewItem[]): ImportPlan | { error: string } {
  const header = (table[0] ?? []).map((cell) => norm(text(cell)));
  const col = {
    id: findCol(header, (h) => h.startsWith("id")),
    name: findCol(header, (h) => h === "პროდუქტი" || h === "სახელი"),
    variant: findCol(header, (h) => h === "ვარიანტი"),
    sku: findCol(header, (h) => h === "ბარკოდი" || h === "sku"),
    cost: findCol(header, (h) => h.startsWith("შესყიდვ")),
    price: findCol(header, (h) => h.startsWith("გასაყიდ")),
    stock: findCol(header, (h) => h.startsWith("მარაგ")),
    active: findCol(header, (h) => h.startsWith("აქტიურ")),
  };
  if (col.id < 0 || col.name < 0) {
    return { error: "ფაილში ვერ მოიძებნა „ID“ და „პროდუქტი“ სვეტები. გამოიყენეთ ჩამოტვირთული ფაილი." };
  }

  const byId = new Map(current.map((item) => [item.id.toLowerCase(), item]));
  const plan: ImportPlan = { changes: [], errors: [], warnings: [], unchanged: 0 };
  const seen = new Set<string>();
  const finalSku = new Map<string, string>(); // item key -> lowercase sku
  for (const item of current) finalSku.set(item.id.toLowerCase(), norm(item.sku ?? ""));
  const touchedSku: { row: number; key: string; sku: string }[] = [];

  table.slice(1).forEach((line, index) => {
    const row = index + 2; // Excel-ის სტრიქონის ნომერი
    const get = (c: number) => (c < 0 ? "" : text(line?.[c]));
    const id = get(col.id).toLowerCase();
    const name = get(col.name);
    if (!id && !name && !get(col.sku)) return; // ცარიელი სტრიქონი
    const error = (message: string) => plan.errors.push({ row, message });

    if (id) {
      if (!uuidRe.test(id)) return error("ID არასწორია. არ შეცვალოთ ID სვეტი.");
      if (seen.has(id)) return error("ეს ID ფაილში ორჯერ არის.");
      seen.add(id);
      const item = byId.get(id);
      if (!item) return error("ასეთი ID სისტემაში არ არსებობს.");

      const set: ProductFields = {};
      const was: ProductChange["was"] = {};
      const label = item.variant_name ? `${item.name} / ${item.variant_name}` : item.name;

      if (item.kind === "product") {
        if (!name || name.length > 200) return error("პროდუქტის სახელი აუცილებელია (მაქს. 200 სიმბოლო).");
        if (name !== item.name) { set.name = name; was.name = item.name; }
      } else {
        if (name && name !== item.name) plan.warnings.push({ row, message: `„${item.name}“: ვარიანტის სტრიქონზე პროდუქტის სახელი არ იცვლება (შეცვალეთ ორდერების აპში).` });
        const variant = get(col.variant);
        if (col.variant >= 0 && variant !== (item.variant_name ?? "")) {
          if (!variant || variant.length > 200) return error("ვარიანტის სახელი აუცილებელია (მაქს. 200 სიმბოლო).");
          set.variant_name = variant; was.variant_name = item.variant_name ?? "";
        }
      }

      if (col.sku >= 0) {
        const sku = get(col.sku);
        if (sku.length > 100) return error("ბარკოდი ძალიან გრძელია.");
        if (sku !== (item.sku ?? "").trim()) {
          set.sku = sku; was.sku = item.sku ?? "";
          finalSku.set(id, norm(sku));
          if (sku) touchedSku.push({ row, key: id, sku: norm(sku) });
        }
      }
      const priceRaw = normalizeDecimal(get(col.price));
      if (priceRaw && !sameNumber(priceRaw, item.price)) {
        if (!isPrice(priceRaw)) return error("გასაყიდი ფასი არასწორია.");
        set.price = priceRaw; was.price = String(Number(item.price ?? 0));
      }
      const costRaw = normalizeDecimal(get(col.cost));
      if (costRaw && !sameNumber(costRaw, item.cost)) {
        if (!isPrice(costRaw)) return error("შესყიდვის ფასი არასწორია.");
        set.cost = costRaw; was.cost = item.cost === null ? "" : String(Number(item.cost));
      }
      let activeAfter = item.active;
      const activeRaw = get(col.active);
      if (activeRaw) {
        const parsed = parseActive(activeRaw);
        if (parsed === null) return error("„აქტიური“ უნდა იყოს „დიახ“ ან „არა“.");
        if (parsed !== item.active) { set.active = parsed; was.active = undefined; activeAfter = parsed; }
      }
      const stockRaw = normalizeDecimal(get(col.stock));
      if (stockRaw && !sameNumber(stockRaw, item.stock)) {
        if (!isCount(stockRaw)) return error("მარაგი არასწორია: შეიყვანეთ 0 ან მეტი რიცხვი.");
        if (!activeAfter) return error("გაუქმებულ პროდუქტზე მარაგს ვერ შეცვლით. ჯერ გახადეთ აქტიური („დიახ“).");
        set.stock = stockRaw; was.stock = String(Number(item.stock));
      }
      if (Object.keys(set).length === 0) plan.unchanged += 1;
      else plan.changes.push({ row, op: "update", id: item.id, label, set, was });
      return;
    }

    // ახალი პროდუქტი (ID არ აქვს)
    if (!name || name.length > 200) return error("ახალი პროდუქტისთვის სახელი აუცილებელია (მაქს. 200 სიმბოლო).");
    if (get(col.variant)) return error("ახალი ვარიანტის დამატება აქედან შეუძლებელია. დაამატეთ ორდერების აპში.");
    const sku = get(col.sku);
    if (sku.length > 100) return error("ბარკოდი ძალიან გრძელია.");
    const priceRaw = normalizeDecimal(get(col.price));
    if (!isPrice(priceRaw)) return error("ახალი პროდუქტისთვის გასაყიდი ფასი აუცილებელია.");
    const costRaw = normalizeDecimal(get(col.cost));
    if (costRaw && !isPrice(costRaw)) return error("შესყიდვის ფასი არასწორია.");
    const stockRaw = normalizeDecimal(get(col.stock)) || "0";
    if (!isCount(stockRaw)) return error("მარაგი არასწორია (0 ან მეტი).");
    const activeRaw = get(col.active);
    if (activeRaw && parseActive(activeRaw) !== true) return error("ახალი პროდუქტი აქტიური უნდა იყოს.");

    const set: ProductFields = { name, price: priceRaw };
    if (sku) set.sku = sku;
    if (costRaw) set.cost = costRaw;
    if (cents(stockRaw) > 0 || thousandths(stockRaw) > 0) set.stock = stockRaw;
    const key = `new:${row}`;
    finalSku.set(key, norm(sku));
    if (sku) touchedSku.push({ row, key, sku: norm(sku) });
    plan.changes.push({ row, op: "create", id: null, label: name, set, was: {} });
  });

  // ბარკოდის დუბლირება: მხოლოდ იმ სტრიქონებზე ვაფრთხილებთ, რომლებსაც ბარკოდი ვცვლით ან ვამატებთ.
  const count = new Map<string, number>();
  for (const sku of finalSku.values()) if (sku) count.set(sku, (count.get(sku) ?? 0) + 1);
  for (const touched of touchedSku) {
    if ((count.get(touched.sku) ?? 0) > 1) {
      plan.errors.push({ row: touched.row, message: "ეს ბარკოდი სხვა პროდუქტზე ან ვარიანტზე უკვე გამოიყენება." });
    }
  }
  plan.errors.sort((a, b) => a.row - b.row);
  return plan;
}
