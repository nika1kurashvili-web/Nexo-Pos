"use client";

import { useMemo, useRef, useState } from "react";
import { createPurchase } from "@/app/(pos)/purchases/actions";
import {
  findBySku,
  isPrice,
  isQuantity,
  itemKey,
  normalizeDecimal,
  searchCatalog,
} from "@/lib/pos/inventory";
import type { InventoryCatalogItem } from "@/lib/pos/types";

type Line = {
  key: string;
  item: InventoryCatalogItem;
  quantity: string;
  price: string;
};

const gel = (value: number) =>
  `${value.toLocaleString("ka-GE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₾`;

export default function PurchaseForm({
  catalog,
  requestId,
}: {
  catalog: InventoryCatalogItem[];
  requestId: string;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const qtyRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const results = useMemo(
    () => (query.trim() ? searchCatalog(catalog, query, 30) : []),
    [catalog, query],
  );

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
      return [
        {
          key,
          item,
          quantity: "1",
          price: item.cost === null ? "" : String(Number(item.cost)),
        },
        ...current,
      ];
    });
    setQuery("");
    focusQty(key);
  }

  function onSearchKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const exact = findBySku(catalog, query);
    if (exact) return add(exact);
    if (results.length === 1) add(results[0]);
  }

  const update = (key: string, patch: Partial<Pick<Line, "quantity" | "price">>) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const valid =
    lines.length > 0 &&
    lines.every((l) => isQuantity(l.quantity) && isPrice(l.price));

  const total = lines.reduce((sum, l) => {
    if (!isQuantity(l.quantity) || !isPrice(l.price)) return sum;
    return sum + Number(normalizeDecimal(l.quantity)) * Number(normalizeDecimal(l.price));
  }, 0);

  const payload = JSON.stringify(
    lines.map((l) => ({
      kind: l.item.kind,
      target: l.item.id,
      quantity: l.quantity,
      unit_price: l.price,
    })),
  );

  return (
    <form action={createPurchase} className="data-form">
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="items" value={payload} />

      <section className="panel">
        <label>
          პროდუქტის ძებნა ან ბარკოდის დასკანერება
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="სახელი ან ბარკოდი"
            autoComplete="off"
            autoFocus
          />
        </label>
        {query.trim() && (
          <div className="table-scroll">
            <table>
              <tbody>
                {results.length === 0 && (
                  <tr><td className="muted">ვერაფერი მოიძებნა.</td></tr>
                )}
                {results.map((item) => (
                  <tr key={itemKey(item)}>
                    <td>{item.sku ?? ""}</td>
                    <td>{item.name}</td>
                    <td>{item.cost === null ? "ფასი არ არის" : gel(Number(item.cost))}</td>
                    <td>
                      <button type="button" className="button secondary" onClick={() => add(item)}>
                        დამატება
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>შესყიდვის პოზიციები</h2>
        {lines.length === 0 ? (
          <p className="muted">დაამატეთ პროდუქტი ზემოთ მოცემული ძებნით.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>ბარკოდი</th>
                  <th>პროდუქტი</th>
                  <th>რაოდენობა</th>
                  <th>შესყიდვის ფასი (₾)</th>
                  <th>წინა ფასი</th>
                  <th>ჯამი</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const okQ = isQuantity(l.quantity);
                  const okP = isPrice(l.price);
                  const line =
                    okQ && okP
                      ? Number(normalizeDecimal(l.quantity)) * Number(normalizeDecimal(l.price))
                      : null;
                  const changed =
                    l.item.cost !== null &&
                    okP &&
                    Number(normalizeDecimal(l.price)) !== Number(l.item.cost);
                  return (
                    <tr key={l.key}>
                      <td>{l.item.sku ?? ""}</td>
                      <td>{l.item.name}</td>
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
                          aria-label="შესყიდვის ფასი"
                        />
                      </td>
                      <td>
                        {l.item.cost === null ? "—" : gel(Number(l.item.cost))}
                        {changed && <span className="muted"> · შეიცვლება</span>}
                      </td>
                      <td>{line === null ? "—" : gel(line)}</td>
                      <td>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => setLines((c) => c.filter((x) => x.key !== l.key))}
                          aria-label="წაშლა"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p><strong>სულ: {gel(total)}</strong></p>
        <label>
          შენიშვნა (არასავალდებულო)
          <input
            name="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="მაგ. მომწოდებელი, ინვოისის ნომერი"
          />
        </label>
        <div className="filter-actions">
          <button type="submit" className="button primary" disabled={!valid}>
            შესყიდვის შენახვა
          </button>
        </div>
        <p className="muted">
          შენახვისას მარაგი გაიზრდება, ხოლო თითო პროდუქტის შესყიდვის ფასი განახლდება ამ ფასით.
        </p>
      </section>
    </form>
  );
}
