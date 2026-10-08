"use client";

import { useMemo, useRef, useState } from "react";
import { saveCustomerOrder } from "@/app/(pos)/customers/[id]/orders/actions";
import { findBySku, isPrice, isQuantity, itemKey, normalizeDecimal, searchCatalog } from "@/lib/pos/inventory";
import type { InventoryCatalogItem } from "@/lib/pos/types";

export type OrderLine = {
  key: string;
  kind: "product" | "variant" | null;
  target: string | null;
  name: string;
  quantity: string;
  price: string;
  cost: string;
  custom: boolean;
};

const gel = (value: number) =>
  `${value.toLocaleString("ka-GE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₾`;

// დადასტურების ფანჯარა წაშლამდე
export function ConfirmForm({ action, message, children }: {
  action: (form: FormData) => Promise<void>;
  message: string;
  children: React.ReactNode;
}) {
  return (
    <form action={action} onSubmit={(event) => { if (!window.confirm(message)) event.preventDefault(); }}>
      {children}
    </form>
  );
}

export default function CustomerOrderForm({
  customerId,
  catalog,
  customerPrices,
  requestId,
  orderId,
  initialDate,
  initialNote,
  initialLines,
  submitLabel,
}: {
  customerId: string;
  catalog: InventoryCatalogItem[];
  customerPrices: Record<string, string>;
  requestId: string;
  orderId?: string;
  initialDate: string;
  initialNote?: string;
  initialLines?: OrderLine[];
  submitLabel: string;
}) {
  const [lines, setLines] = useState<OrderLine[]>(initialLines ?? []);
  const [query, setQuery] = useState("");
  const [date, setDate] = useState(initialDate);
  const [note, setNote] = useState(initialNote ?? "");
  const [customCount, setCustomCount] = useState(0);
  const qtyRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const results = useMemo(() => (query.trim() ? searchCatalog(catalog, query, 30) : []), [catalog, query]);

  const defaultCost = (item: InventoryCatalogItem) => (item.cost === null ? "" : String(Number(item.cost)));

  const defaultPrice = (item: InventoryCatalogItem) => {
    const special = customerPrices[itemKey(item)];
    if (special !== undefined) return special;
    return item.price === null ? "" : String(Number(item.price));
  };

  function focusQty(key: string) {
    setTimeout(() => {
      const el = qtyRefs.current[key];
      el?.focus();
      el?.select();
    }, 0);
  }

  function add(item: InventoryCatalogItem) {
    const key = itemKey(item);
    setLines((current) => {
      if (current.some((line) => line.key === key)) return current;
      return [{ key, kind: item.kind, target: item.id, name: item.name, quantity: "1", price: defaultPrice(item), cost: defaultCost(item), custom: false }, ...current];
    });
    setQuery("");
    focusQty(key);
  }

  function addCustom() {
    const key = `custom:${customCount}`;
    setCustomCount((n) => n + 1);
    setLines((current) => [{ key, kind: null, target: null, name: "", quantity: "1", price: "", cost: "", custom: true }, ...current]);
  }

  function onSearchKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const exact = findBySku(catalog, query);
    if (exact) return add(exact);
    if (results.length === 1) add(results[0]);
  }

  const update = (key: string, patch: Partial<Pick<OrderLine, "quantity" | "price" | "cost" | "name">>) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const lineTotal = (l: OrderLine) =>
    isQuantity(l.quantity) && isPrice(l.price)
      ? Math.round(Number(normalizeDecimal(l.quantity)) * Number(normalizeDecimal(l.price)) * 100) / 100
      : null;

  const valid =
    lines.length > 0 &&
    Boolean(date) &&
    lines.every((l) => l.name.trim().length > 0 && isQuantity(l.quantity) && isPrice(l.price) && (l.cost.trim() === "" || isPrice(l.cost)));

  const total = lines.reduce((sum, l) => sum + (lineTotal(l) ?? 0), 0);
  const costTotal = lines.reduce(
    (sum, l) =>
      sum +
      (isQuantity(l.quantity) && l.cost.trim() !== "" && isPrice(l.cost)
        ? Math.round(Number(normalizeDecimal(l.quantity)) * Number(normalizeDecimal(l.cost)) * 100) / 100
        : 0),
    0,
  );

  const payload = JSON.stringify(
    lines.map((l) => ({ kind: l.kind, target: l.target, name: l.name.trim(), quantity: l.quantity, unit_price: l.price, unit_cost: l.cost.trim() })),
  );

  return (
    <form action={saveCustomerOrder} className="data-form order-form">
      <input type="hidden" name="customer_id" value={customerId} />
      <input type="hidden" name="request_id" value={requestId} />
      {orderId && <input type="hidden" name="order_id" value={orderId} />}
      <input type="hidden" name="items" value={payload} />

      <label>
        პროდუქტის ძებნა ან ბარკოდი
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="სახელი ან ბარკოდი"
          autoComplete="off"
        />
      </label>

      {query.trim() && (
        <div className="table-scroll">
          <table>
            <tbody>
              {results.length === 0 && <tr><td className="muted">ვერაფერი მოიძებნა.</td></tr>}
              {results.map((item) => (
                <tr key={itemKey(item)}>
                  <td>{item.sku ?? ""}</td>
                  <td>{item.name}</td>
                  <td>{defaultPrice(item) === "" ? "ფასი არ არის" : gel(Number(defaultPrice(item)))}</td>
                  <td><button type="button" className="button secondary" onClick={() => add(item)}>დამატება</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <button type="button" className="button secondary" onClick={addCustom}>+ სხვა პროდუქტი (ხელით)</button>
      </div>

      {lines.length === 0 ? (
        <p className="muted">დაამატეთ პროდუქტი ზემოთ მოცემული ძებნით.</p>
      ) : (
        <div className="table-scroll">
          <table className="order-lines">
            <thead>
              <tr><th>პროდუქტი</th><th>რაოდენობა</th><th>გასაყიდი ფასი (₾)</th><th>შესყიდვის ფასი (₾)</th><th>ჯამი</th><th /></tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const okQ = isQuantity(l.quantity);
                const okP = isPrice(l.price);
                const sum = lineTotal(l);
                return (
                  <tr key={l.key}>
                    <td>
                      {l.custom ? (
                        <input
                          type="text"
                          value={l.name}
                          onChange={(e) => update(l.key, { name: e.target.value })}
                          placeholder="პროდუქტის სახელი"
                          maxLength={300}
                          aria-label="პროდუქტის სახელი"
                          aria-invalid={!l.name.trim()}
                        />
                      ) : (
                        <strong>{l.name}</strong>
                      )}
                    </td>
                    <td>
                      <input
                        ref={(el) => { qtyRefs.current[l.key] = el; }}
                        type="text"
                        inputMode="decimal"
                        value={l.quantity}
                        onChange={(e) => update(l.key, { quantity: e.target.value })}
                        aria-invalid={!okQ}
                        aria-label="რაოდენობა"
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={l.price}
                        onChange={(e) => update(l.key, { price: e.target.value })}
                        aria-invalid={!okP}
                        aria-label="ფასი"
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={l.cost}
                        onChange={(e) => update(l.key, { cost: e.target.value })}
                        aria-invalid={l.cost.trim() !== "" && !isPrice(l.cost)}
                        aria-label="შესყიდვის ფასი"
                        placeholder="—"
                      />
                    </td>
                    <td>{sum === null ? "—" : gel(sum)}</td>
                    <td>
                      <button type="button" className="button secondary" onClick={() => setLines((c) => c.filter((x) => x.key !== l.key))} aria-label="წაშლა">✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p><strong>სულ: {gel(total)}</strong>{" "}<span className="muted">· შესყიდვა: {gel(costTotal)}</span></p>

      <div className="order-meta">
        <label>
          შეკვეთის თარიღი
          <input name="order_date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label>
          შენიშვნა (არასავალდებულო)
          <input name="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </label>
      </div>

      <div className="filter-actions">
        <button type="submit" className="button primary" disabled={!valid}>{submitLabel}</button>
      </div>
    </form>
  );
}
