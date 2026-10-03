"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createInventory } from "@/app/(pos)/inventories/actions";
import {
  findBySku,
  isCount,
  itemKey,
  normalizeDecimal,
  quantityDifference,
  type CountRow,
} from "@/lib/pos/inventory";
import type { InventoryCatalogItem } from "@/lib/pos/types";

const MAX_ROWS = 200;
const fmt = (v: number) => v.toLocaleString("ka-GE", { maximumFractionDigits: 3 });

type Status = "same" | "invalid" | "changed";

function statusFor(item: InventoryCatalogItem, counts: Record<string, string>): Status {
  const raw = counts[itemKey(item)];
  if (raw === undefined) return "same";
  if (!isCount(raw)) return "invalid";
  return quantityDifference(raw, item.stock) === 0 ? "same" : "changed";
}

export default function InventoryForm({
  catalog,
  requestId,
}: {
  catalog: InventoryCatalogItem[];
  requestId: string;
}) {
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [pinned, setPinned] = useState<string | null>(null);
  const [scanTick, setScanTick] = useState(0);
  const [bulkReason, setBulkReason] = useState("");
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState(false);
  const countRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, startUpload] = useTransition();
  const [importMessage, setImportMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  const countOf = (item: InventoryCatalogItem) => counts[itemKey(item)] ?? String(Number(item.stock));

  const statusOf = (item: InventoryCatalogItem) => statusFor(item, counts);

  const changed = useMemo(
    () => catalog.filter((item) => statusFor(item, counts) === "changed"),
    [catalog, counts],
  );
  const invalidCount = useMemo(
    () => catalog.filter((item) => statusFor(item, counts) === "invalid").length,
    [catalog, counts],
  );
  const valid = changed.length > 0 && invalidCount === 0;

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const changedKeys = new Set(changed.map(itemKey));
    const matches = needle
      ? catalog.filter(
          (item) =>
            item.name.toLowerCase().includes(needle) ||
            (item.sku ?? "").toLowerCase().includes(needle),
        )
      : catalog;
    const first: InventoryCatalogItem[] = [];
    const seen = new Set<string>();
    const push = (item: InventoryCatalogItem | undefined) => {
      if (!item) return;
      const key = itemKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      first.push(item);
    };
    if (pinned) push(catalog.find((item) => itemKey(item) === pinned));
    for (const item of changed) push(item);
    for (const item of matches) {
      if (first.length >= MAX_ROWS + changedKeys.size + 1) break;
      push(item);
    }
    return { list: first, total: matches.length };
  }, [catalog, changed, pinned, query]);

  useEffect(() => {
    if (!pinned) return;
    const el = countRefs.current[pinned];
    el?.focus();
    el?.select();
  }, [pinned, scanTick]);

  function onScanKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const exact = findBySku(catalog, query);
    if (exact) {
      setMissing(false);
      setPinned(itemKey(exact));
      setScanTick((t) => t + 1);
      setQuery("");
    } else if (query.trim()) {
      setMissing(true);
    }
  }

  const setCount = (item: InventoryCatalogItem, value: string) =>
    setCounts((current) => ({ ...current, [itemKey(item)]: value }));

  const reset = (item: InventoryCatalogItem) => {
    const key = itemKey(item);
    const without = (current: Record<string, string>) => {
      const next = { ...current };
      delete next[key];
      return next;
    };
    setCounts(without);
    setReasons(without);
  };

  function applyBulk() {
    const reason = bulkReason.trim();
    if (!reason) return;
    setReasons((current) => {
      const next = { ...current };
      for (const item of changed) {
        const key = itemKey(item);
        if (!(next[key] ?? "").trim()) next[key] = reason;
      }
      return next;
    });
  }

  function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImportMessage(null);
    startUpload(async () => {
      try {
        const body = new FormData();
        body.set("file", file);
        const response = await fetch("/inventories/parse", { method: "POST", body });
        const result = (await response.json()) as { rows?: CountRow[]; blank?: number; error?: string };
        if (!response.ok || !result.rows) {
          setImportMessage({ tone: "error", text: result.error ?? "ფაილის წაკითხვა ვერ მოხერხდა." });
          return;
        }
        const bySku = new Map<string, InventoryCatalogItem[]>();
        for (const item of catalog) {
          const sku = item.sku?.trim().toLowerCase();
          if (sku) bySku.set(sku, [...(bySku.get(sku) ?? []), item]);
        }
        const next: Record<string, string> = {};
        const notFound: string[] = [];
        let invalid = 0;
        let same = 0;
        let changedNow = 0;
        for (const row of result.rows) {
          const matches = bySku.get(row.sku.trim().toLowerCase());
          if (!matches || matches.length !== 1) {
            notFound.push(row.sku);
            continue;
          }
          const item = matches[0];
          if (!isCount(row.counted)) {
            invalid += 1;
            continue;
          }
          if (quantityDifference(row.counted, item.stock) === 0) {
            same += 1;
            continue;
          }
          next[itemKey(item)] = normalizeDecimal(row.counted);
          changedNow += 1;
        }
        setCounts((current) => ({ ...current, ...next }));
        const parts = [
          `ფაილიდან წაკითხულია ${result.rows.length} სტრიქონი: ${changedNow} შეცვლილია, ${same} უცვლელია.`,
        ];
        if (notFound.length) parts.push(`ვერ მოიძებნა SKU (${notFound.length}): ${notFound.slice(0, 8).join(", ")}${notFound.length > 8 ? "…" : ""}.`);
        if (invalid) parts.push(`არასწორი რაოდენობა: ${invalid} სტრიქონი გამოტოვებულია.`);
        if (result.blank) parts.push(`ცარიელი რაოდენობა: ${result.blank} სტრიქონი გამოტოვებულია.`);
        parts.push("გადაამოწმეთ ცვლილებები ქვემოთ და შეინახეთ.");
        setImportMessage({ tone: notFound.length || invalid ? "error" : "info", text: parts.join(" ") });
      } catch {
        setImportMessage({ tone: "error", text: "ფაილის ატვირთვა ვერ მოხერხდა." });
      }
    });
  }

  const payload = JSON.stringify(
    changed.map((item) => ({
      kind: item.kind,
      target: item.id,
      counted: normalizeDecimal(countOf(item)),
      reason: (reasons[itemKey(item)] ?? "").trim(),
    })),
  );

  return (
    <form action={createInventory} className="data-form">
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="items" value={payload} />

      <section className="panel">
        <label>
          დაასკანერეთ ბარკოდი ან მოძებნეთ სახელით
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMissing(false);
            }}
            onKeyDown={onScanKey}
            placeholder="ბარკოდი ან სახელი, შემდეგ Enter"
            autoComplete="off"
            autoFocus
          />
        </label>
        {missing && (
          <p className="notice error" role="alert">ამ ბარკოდით პროდუქტი ვერ მოიძებნა.</p>
        )}
        <p className="muted">
          დასკანერებული პროდუქტი ამოვა სიის თავში და რაოდენობის ველი მზად იქნება შესაცვლელად.
          შეცვლილი პროდუქტები სიის თავში რჩება; მიზეზის მითითება სურვილისამებრ შეგიძლიათ.
        </p>
        <div className="analytics-tools">
          <a
            href="/inventories/export"
            className="icon-button"
            aria-label="Excel შაბლონის ჩამოტვირთვა"
            title="Excel შაბლონის ჩამოტვირთვა (ყველა პროდუქტი რაოდენობით)"
            download
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v12" />
              <path d="m7 11 5 5 5-5" />
              <path d="M5 20h14" />
            </svg>
          </a>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={onFile}
            hidden
          />
          <button
            type="button"
            className="button secondary"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? "იტვირთება…" : "Excel-ის ატვირთვა"}
          </button>
        </div>
        {importMessage && (
          <p className={`notice ${importMessage.tone}`} role={importMessage.tone === "error" ? "alert" : "status"}>
            {importMessage.text}
          </p>
        )}
      </section>

      <section className="panel">
        <h2>პროდუქტები ({catalog.length})</h2>
        {catalog.length === 0 ? (
          <p className="muted">აქტიური პროდუქტები არ მოიძებნა.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>ბარკოდი</th>
                  <th>პროდუქტი</th>
                  <th>სისტემაში</th>
                  <th>რეალურად</th>
                  <th>სხვაობა</th>
                  <th>მიზეზი</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.list.map((item) => {
                  const key = itemKey(item);
                  const status = statusOf(item);
                  const diff =
                    status === "changed" ? quantityDifference(countOf(item), item.stock) : 0;
                  return (
                    <tr key={key} className={key === pinned ? "row-pinned" : undefined}>
                      <td>{item.sku ?? ""}</td>
                      <td>{item.name}</td>
                      <td>{fmt(Number(item.stock))}</td>
                      <td>
                        <input
                          ref={(el) => { countRefs.current[key] = el; }}
                          type="text"
                          inputMode="decimal"
                          value={countOf(item)}
                          onChange={(e) => setCount(item, e.target.value)}
                          aria-invalid={status === "invalid"}
                          aria-label="რეალური რაოდენობა"
                        />
                      </td>
                      <td>{status === "changed" ? (diff > 0 ? `+${fmt(diff)}` : fmt(diff)) : ""}</td>
                      <td>
                        {status === "changed" && (
                          <input
                            type="text"
                            value={reasons[key] ?? ""}
                            onChange={(e) =>
                              setReasons((current) => ({ ...current, [key]: e.target.value }))
                            }
                            maxLength={500}
                            placeholder="მიზეზი (არასავალდებულო)"
                            aria-label="მიზეზი"
                          />
                        )}
                      </td>
                      <td>
                        {status !== "same" && (
                          <button type="button" className="button secondary" onClick={() => reset(item)}>
                            გაუქმება
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.total > rows.list.length && (
          <p className="muted">
            ნაჩვენებია {rows.list.length} / {rows.total}. დანარჩენის საპოვნელად გამოიყენეთ ძებნა ან სკანერი.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>შესწორებები: {changed.length}</h2>
        {changed.length > 0 && (
          <div className="inline-form">
            <label>
              ერთი მიზეზი ყველა შესწორებულზე (ცარიელ ველებს შეავსებს)
              <input value={bulkReason} onChange={(e) => setBulkReason(e.target.value)} maxLength={500} />
            </label>
            <button type="button" className="button secondary" onClick={applyBulk}>
              შევსება
            </button>
          </div>
        )}
        <label>
          შენიშვნა (არასავალდებულო)
          <input name="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
        {invalidCount > 0 && (
          <p className="notice error" role="alert">{invalidCount} ველში რაოდენობა არასწორია.</p>
        )}
        <div className="filter-actions">
          <button type="submit" className="button primary" disabled={!valid}>
            ინვენტარიზაციის შენახვა
          </button>
        </div>
        <p className="muted">შეინახება მხოლოდ შეცვლილი პროდუქტები; დანარჩენის მარაგი უცვლელი დარჩება.</p>
      </section>
    </form>
  );
}
