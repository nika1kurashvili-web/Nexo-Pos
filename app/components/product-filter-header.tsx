"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type Kind = "text" | "select" | "range" | "none";
type Column = {
  label: string;
  kind: Kind;
  key?: string; // text/select: URL key; range: prefix (key_min/key_max)
  options?: { value: string; label: string }[];
};

const COLUMNS: Column[] = [
  { label: "ფოტო", kind: "none" },
  { label: "პროდუქტი", kind: "text", key: "name" },
  {
    label: "კატეგორია", kind: "select", key: "cat",
    options: [
      { value: "მანქანა", label: "მანქანა" },
      { value: "ტექნიკა", label: "ტექნიკა" },
      { value: "none", label: "კატეგორიის გარეშე" },
    ],
  },
  { label: "კოდი", kind: "text", key: "sku" },
  { label: "მარაგი", kind: "range", key: "stock" },
  { label: "შესყიდვის ფასი", kind: "range", key: "cost" },
  { label: "გასაყიდი ფასი", kind: "range", key: "price" },
  { label: "მოგება", kind: "range", key: "margin" },
  {
    label: "სტატუსი", kind: "select", key: "status",
    options: [
      { value: "active", label: "აქტიური" },
      { value: "inactive", label: "გაუქმებული" },
      { value: "all", label: "ყველა" },
    ],
  },
  { label: "მოქმედება", kind: "none" },
];

const keysOf = (col: Column) =>
  col.kind === "range" ? [`${col.key}_min`, `${col.key}_max`] : col.key ? [col.key] : [];

/*
 * ცხრილის სათაურის რიგი ექსელის მსგავსი ფილტრებით: ყოველ სვეტზე ▾ ღილაკი,
 * რომელიც ფილტრის ფანჯარას ხსნის (ტექსტი / არჩევანი / „დან–მდე“).
 */
export default function ProductFilterHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const popRef = useRef<HTMLDivElement>(null);

  const current = (key: string) => search.get(key) ?? (key === "status" && search.get("all") === "1" ? "all" : "");

  useEffect(() => {
    if (open === null) return;
    const close = () => setOpen(null);
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (popRef.current?.contains(target) || target.closest("[data-filter-btn]")) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function navigate(next: URLSearchParams) {
    next.delete("all");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function openFor(index: number, button: HTMLElement) {
    if (open === index) { setOpen(null); return; }
    const col = COLUMNS[index];
    setDraft(Object.fromEntries(keysOf(col).map((key) => [key, current(key)])));
    const rect = button.getBoundingClientRect();
    const width = 240;
    setPos({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
    setOpen(index);
  }

  function apply(col: Column, values: Record<string, string>) {
    const next = new URLSearchParams(search.toString());
    // ძველი „გაუქმებულებიც“ → status
    if (next.get("all") === "1" && !next.get("status")) next.set("status", "all");
    for (const key of keysOf(col)) {
      const value = (values[key] ?? "").trim();
      if (value) next.set(key, value);
      else next.delete(key);
    }
    navigate(next);
    setOpen(null);
  }

  const col = open === null ? null : COLUMNS[open];

  return (
    <>
      <tr className="filter-head">
        {COLUMNS.map((c, index) => {
          const active = keysOf(c).some((key) => Boolean(current(key)));
          return (
            <th key={c.label} scope="col" className={active ? "has-filter" : undefined}>
              <span className="th-inner">
                <span>{c.label}</span>
                {c.kind !== "none" && (
                  <button
                    type="button"
                    data-filter-btn
                    className={`filter-btn${active ? " on" : ""}`}
                    aria-label={`ფილტრი: ${c.label}`}
                    aria-expanded={open === index}
                    onClick={(event) => openFor(index, event.currentTarget)}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 3h12l-4.6 5.4V13l-2.8-1.6V8.4z" fill="currentColor" /></svg>
                  </button>
                )}
              </span>
            </th>
          );
        })}
      </tr>

      {col && (
        <tr className="filter-pop-row" aria-hidden={false}>
          <td colSpan={COLUMNS.length} style={{ padding: 0, border: 0 }}>
            <div
              ref={popRef}
              className="filter-pop"
              role="dialog"
              aria-label={`ფილტრი: ${col.label}`}
              style={{ top: pos.top, left: pos.left }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(col, draft); } }}
            >
              <strong>{col.label}</strong>
              {col.kind === "text" && (
                <input
                  autoFocus
                  type="search"
                  placeholder="ჩაწერეთ…"
                  value={draft[col.key!] ?? ""}
                  onChange={(event) => setDraft({ ...draft, [col.key!]: event.target.value })}
                />
              )}
              {col.kind === "select" && (
                <select
                  autoFocus
                  value={draft[col.key!] ?? ""}
                  onChange={(event) => setDraft({ ...draft, [col.key!]: event.target.value })}
                >
                  <option value="">{col.key === "status" ? "ნაგულისხმევი (აქტიურები)" : "ყველა"}</option>
                  {col.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              )}
              {col.kind === "range" && (
                <div className="filter-range">
                  <label>დან<input autoFocus inputMode="decimal" placeholder="მინ." value={draft[`${col.key}_min`] ?? ""} onChange={(event) => setDraft({ ...draft, [`${col.key}_min`]: event.target.value })} /></label>
                  <label>მდე<input inputMode="decimal" placeholder="მაქს." value={draft[`${col.key}_max`] ?? ""} onChange={(event) => setDraft({ ...draft, [`${col.key}_max`]: event.target.value })} /></label>
                </div>
              )}
              <div className="filter-pop-actions">
                <button type="button" className="button primary" onClick={() => apply(col, draft)}>გამოყენება</button>
                <button type="button" className="button secondary" onClick={() => apply(col, {})}>გასუფთავება</button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
