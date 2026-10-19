"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterRows, sortRows, toCsv, totalsOf,
  type NumField, type ProfitFilters, type ProfitRow, type SortKey,
} from "@/lib/pos/profit";

const fmt = (value: number | null, digits = 2) =>
  value === null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const qtyFmt = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 3 });

type Col = { key: SortKey; label: string; field?: NumField; text?: boolean };
const COLS: Col[] = [
  { key: "name", label: "დასახელება / კოდი", text: true },
  { key: "quantity", label: "რაოდენობა", field: "quantity" },
  { key: "unitCost", label: "შესყიდვის ფასი (₾)", field: "unitCost" },
  { key: "cost", label: "შესყიდვის ჯამი (₾)", field: "cost" },
  { key: "avgPrice", label: "გასაყიდი ფასი (₾)", field: "avgPrice" },
  { key: "revenue", label: "ჯამური თანხა (₾)", field: "revenue" },
  { key: "profit", label: "ფასნამატი", field: "profit" },
];

type Draft = { name: string; sku: string; min: string; max: string };
const EMPTY: ProfitFilters = { name: "", sku: "", ranges: {} };

export default function ProfitTable({ rows, period }: { rows: ProfitRow[]; period: string }) {
  const [filters, setFilters] = useState<ProfitFilters>(EMPTY);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "revenue", dir: "desc" });
  const [pct, setPct] = useState(false);
  const [size, setSize] = useState(20);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: "", sku: "", min: "", max: "" });
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const popRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => filterRows(rows, filters), [rows, filters]);
  const sorted = useMemo(() => sortRows(filtered, pct && sort.key === "profit" ? "markupPct" : sort.key, sort.dir), [filtered, sort, pct]);
  const totals = useMemo(() => totalsOf(filtered), [filtered]);

  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const current = Math.min(page, pages);
  const visible = sorted.slice((current - 1) * size, current * size);

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

  const isActive = (c: Col) =>
    c.text ? Boolean(filters.name || filters.sku) : Boolean(filters.ranges[c.field!]?.min || filters.ranges[c.field!]?.max);

  function openFor(index: number, button: HTMLElement) {
    if (open === index) { setOpen(null); return; }
    const c = COLS[index];
    setDraft(c.text
      ? { name: filters.name, sku: filters.sku, min: "", max: "" }
      : { name: "", sku: "", min: filters.ranges[c.field!]?.min ?? "", max: filters.ranges[c.field!]?.max ?? "" });
    const rect = button.getBoundingClientRect();
    const width = 240;
    setPos({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
    setOpen(index);
  }

  function apply(c: Col, values: Draft) {
    setFilters((f) => c.text
      ? { ...f, name: values.name.trim(), sku: values.sku.trim() }
      : { ...f, ranges: { ...f.ranges, [c.field!]: { min: values.min.trim(), max: values.max.trim() } } });
    setPage(1);
    setOpen(null);
  }

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "");

  function download() {
    const blob = new Blob([toCsv(sorted)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gayidvebi_${period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const anyFilter = COLS.some(isActive);
  const col = open === null ? null : COLS[open];

  return (
    <div className="profit-wrap">
      <div className="profit-tools">
        <button type="button" className="button secondary" onClick={download} disabled={!sorted.length}>⬇ Excel (CSV)</button>
        <div className="pct-toggle" role="group" aria-label="ფასნამატის ჩვენება">
          <button type="button" className={!pct ? "on" : undefined} onClick={() => setPct(false)}>₾</button>
          <button type="button" className={pct ? "on" : undefined} onClick={() => setPct(true)}>%</button>
        </div>
        {anyFilter && (
          <button type="button" className="button secondary" onClick={() => { setFilters(EMPTY); setPage(1); }}>
            ფილტრების გასუფთავება
          </button>
        )}
        <span className="muted">{filtered.length} / {rows.length} პროდუქტი</span>
      </div>

      <div className="table-scroll">
        <table className="profit-table">
          <thead>
            <tr className="filter-head">
              {COLS.map((c, index) => (
                <th key={c.key} scope="col" className={isActive(c) ? "has-filter" : undefined} aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <span className="th-inner">
                    <button type="button" className="th-sort" onClick={() => toggleSort(c.key)}>{c.label}{arrow(c.key)}</button>
                    <button
                      type="button"
                      data-filter-btn
                      className={`filter-btn${isActive(c) ? " on" : ""}`}
                      aria-label={`ფილტრი: ${c.label}`}
                      aria-expanded={open === index}
                      onClick={(event) => openFor(index, event.currentTarget)}
                    >
                      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 3h12l-4.6 5.4V13l-2.8-1.6V8.4z" fill="currentColor" /></svg>
                    </button>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={`${r.sku}-${r.name}-${i}`}>
                <td><strong>{r.name}</strong><div className="muted">{r.sku || "—"}</div></td>
                <td className="num">{qtyFmt(r.quantity)}</td>
                <td className="num">{fmt(r.unitCost)}</td>
                <td className="num">{fmt(r.cost)}</td>
                <td className="num">{fmt(r.avgPrice)}</td>
                <td className="num">{fmt(r.revenue)}</td>
                <td className={`num${r.profit !== null && r.profit < 0 ? " neg" : ""}`}>{pct ? (r.markupPct === null ? "—" : `${fmt(r.markupPct, 1)}%`) : fmt(r.profit)}</td>
              </tr>
            ))}
            {!visible.length && (
              <tr><td colSpan={COLS.length} className="muted">{rows.length ? "ფილტრით ვერაფერი მოიძებნა." : "ამ პერიოდში გაყიდვები არ არის."}</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr className="profit-total">
              <td>სულ{totals.unknownCount > 0 && <span className="muted"> ({totals.unknownCount} პროდუქტს შესყიდვის ფასი არ აქვს)</span>}</td>
              <td className="num">{qtyFmt(totals.quantity)}</td>
              <td />
              <td className="num">{fmt(totals.cost)} ₾</td>
              <td />
              <td className="num">{fmt(totals.revenue)} ₾</td>
              <td className="num">{pct ? (totals.markupPct === null ? "—" : `${fmt(totals.markupPct, 1)}%`) : `${fmt(totals.profit)} ₾`}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {col && (
        <div
          ref={popRef}
          className="filter-pop"
          role="dialog"
          aria-label={`ფილტრი: ${col.label}`}
          style={{ top: pos.top, left: pos.left }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(col, draft); } }}
        >
          <strong>{col.label}</strong>
          {col.text ? (
            <>
              <input autoFocus type="search" placeholder="დასახელება…" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <input type="search" placeholder="კოდი / ბარკოდი…" value={draft.sku} onChange={(e) => setDraft({ ...draft, sku: e.target.value })} />
            </>
          ) : (
            <div className="filter-range">
              <label>დან<input autoFocus inputMode="decimal" placeholder="მინ." value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })} /></label>
              <label>მდე<input inputMode="decimal" placeholder="მაქს." value={draft.max} onChange={(e) => setDraft({ ...draft, max: e.target.value })} /></label>
            </div>
          )}
          <div className="filter-pop-actions">
            <button type="button" className="button primary" onClick={() => apply(col, draft)}>გამოყენება</button>
            <button type="button" className="button secondary" onClick={() => apply(col, { name: "", sku: "", min: "", max: "" })}>გასუფთავება</button>
          </div>
        </div>
      )}

      <div className="profit-pager">
        <label>
          რიგები გვერდზე
          <select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }}>
            {[20, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <div>
          <button type="button" className="button secondary" disabled={current <= 1} onClick={() => setPage(current - 1)}>← წინა</button>
          <span className="muted"> გვერდი {current} / {pages} </span>
          <button type="button" className="button secondary" disabled={current >= pages} onClick={() => setPage(current + 1)}>შემდეგი →</button>
        </div>
      </div>
    </div>
  );
}
