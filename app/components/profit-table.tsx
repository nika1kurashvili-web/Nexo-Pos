"use client";

import { useMemo, useState } from "react";
import {
  filterRows, sortRows, toCsv, totalsOf,
  type NumField, type ProfitFilters, type ProfitRow, type SortKey,
} from "@/lib/pos/profit";

const fmt = (value: number | null, digits = 2) =>
  value === null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const qtyFmt = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 3 });

type Col = { key: SortKey; label: string; field?: NumField };
const COLS: Col[] = [
  { key: "name", label: "დასახელება / კოდი" },
  { key: "quantity", label: "რაოდენობა", field: "quantity" },
  { key: "unitCost", label: "შესყიდვის ფასი (₾)", field: "unitCost" },
  { key: "cost", label: "შესყიდვის ჯამი (₾)", field: "cost" },
  { key: "avgPrice", label: "გასაყიდი ფასი (₾)", field: "avgPrice" },
  { key: "revenue", label: "ჯამური თანხა (₾)", field: "revenue" },
  { key: "profit", label: "ფასნამატი", field: "profit" },
];

export default function ProfitTable({ rows, period }: { rows: ProfitRow[]; period: string }) {
  const [filters, setFilters] = useState<ProfitFilters>({ name: "", sku: "", ranges: {} });
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "revenue", dir: "desc" });
  const [pct, setPct] = useState(false);
  const [size, setSize] = useState(20);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => filterRows(rows, filters), [rows, filters]);
  const sorted = useMemo(() => sortRows(filtered, pct && sort.key === "profit" ? "markupPct" : sort.key, sort.dir), [filtered, sort, pct]);
  const totals = useMemo(() => totalsOf(filtered), [filtered]);

  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const current = Math.min(page, pages);
  const visible = sorted.slice((current - 1) * size, current * size);

  const setRange = (field: NumField, side: "min" | "max", value: string) => {
    setFilters((f) => ({ ...f, ranges: { ...f.ranges, [field]: { min: f.ranges[field]?.min ?? "", max: f.ranges[field]?.max ?? "", [side]: value } } }));
    setPage(1);
  };
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "");

  function download() {
    const blob = new Blob([toCsv(sorted)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `navachri_${period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const active = filters.name || filters.sku || Object.values(filters.ranges).some((r) => r && (r.min || r.max));

  return (
    <div className="profit-wrap">
      <div className="profit-tools">
        <button type="button" className="button secondary" onClick={download} disabled={!sorted.length}>⬇ Excel (CSV)</button>
        <div className="pct-toggle" role="group" aria-label="ფასნამატის ჩვენება">
          <button type="button" className={!pct ? "on" : undefined} onClick={() => setPct(false)}>₾</button>
          <button type="button" className={pct ? "on" : undefined} onClick={() => setPct(true)}>%</button>
        </div>
        {active && (
          <button type="button" className="button secondary" onClick={() => { setFilters({ name: "", sku: "", ranges: {} }); setPage(1); }}>
            ფილტრების გასუფთავება
          </button>
        )}
        <span className="muted">{filtered.length} / {rows.length} პროდუქტი</span>
      </div>

      <div className="table-scroll">
        <table className="profit-table">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} scope="col" aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" className="th-sort" onClick={() => toggleSort(c.key)}>{c.label}{arrow(c.key)}</button>
                </th>
              ))}
            </tr>
            <tr className="profit-filter-row">
              <th>
                <input placeholder="ჩაწერე სახელი" value={filters.name} aria-label="ფილტრი: დასახელება" onChange={(e) => { setFilters({ ...filters, name: e.target.value }); setPage(1); }} />
                <input placeholder="ჩაწერე კოდი" value={filters.sku} aria-label="ფილტრი: კოდი" onChange={(e) => { setFilters({ ...filters, sku: e.target.value }); setPage(1); }} />
              </th>
              {COLS.slice(1).map((c) => (
                <th key={c.key}>
                  <span className="range-pair">
                    <input inputMode="decimal" placeholder="დან" aria-label={`${c.label}: დან`} value={filters.ranges[c.field!]?.min ?? ""} onChange={(e) => setRange(c.field!, "min", e.target.value)} />
                    <input inputMode="decimal" placeholder="მდე" aria-label={`${c.label}: მდე`} value={filters.ranges[c.field!]?.max ?? ""} onChange={(e) => setRange(c.field!, "max", e.target.value)} />
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
