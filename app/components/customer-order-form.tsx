"use client";

import { useMemo, useRef, useState } from "react";
import { createCustomerOrder } from "@/app/(pos)/customers/[id]/order-actions";
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

export default function CustomerOrderForm({
  customerId,
  catalog,
  customerPrices,
  requestId,
  today,
}: {
  customerId: string;
  catalog: InventoryCatalogItem[];
  // `${kind}:${id}` → კლიენტის ინდივიდუალური ფასი
  customerPrices: Record<string, string>;
  requestId: string;
  today: string;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
  const qtyRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const results = useMemo(
    () => (query.trim() ? searchCatalog(catalog, query, 30) : []),
    [catalog, query],
  );

  const defaultPrice = (item: InventoryCatalogItem) => {
    const own = customerPrices[itemKey(item)];
    if (own !== undefined) return own;
    return item.price === null ? "" : String(Number(item.price));
  };

  function add(item: InventoryCatalogItem) {
    const key = itemKey(item);
    setLines((current) => {
      if (current.some((line) => line.key === key)) return current;
      return [...current, { key, item, quantity: "1", price: defaultPrice(item) }];
    });
    setQuery("");
    setTimeout(() => {
      qtyRefs.current[key]?.focus();
      qtyRefs.current[key]?.select();
    }, 0);
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

  const valid = lines.length > 0 && lines.every((l) => isQuantity(l.quantity) && isPrice(l.price));

  const total = lines.reduce((sum, l) => {
    if (!isQuantity(l.quantity) || !isPrice(l.price)) return sum;
    return sum + Math.round(Number(normalizeDecimal(l.quantity)) * Number(normalizeDecimal(l.price)) * 100) / 100;
  }, 0);

  const payload = JSON.stringify(
    lines.map((l) => ({ kind: l.item.kind, target: l.item.id, quantity: l.quantity, unit_price: l.price })),
  );

  return (
    <form action={createCustomerOrder} className="data-form">
      <input type="hidden" name="customer_id" value={customerId} />
      <input type="hidden" name="request_id" value={requestId} />
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
              {results.length === 0 && (
                <tr><td className="muted">ვერაფერი მოიძებნა.</td></tr>
              )}
              {results.map((item) => {
                const price = defaultPrice(item);
                return (
                  <tr key={itemKey(item)}>
                    <td>{item.sku ?? ""}</td>
                    <td>{item.name}</td>
                    <td>{price === "" ? "ფასი არ არის" : gel(Number(price))}</td>
                    <td>
                      <button type="button" className="button secondary" onClick={() => add(item)}>
                        დამატება
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {lines.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ბარკოდი</th>
                <th>პროდუქტი</th>
                <th>რაოდენობა</th>
                <th>ფასი (₾)</th>
                <th>ჯამი</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const okQ = isQuantity(l.quantity);
                const okP = isPrice(l.price);
                const line = okQ && okP
                  ? Number(normalizeDecimal(l.quantity)) * Number(normalizeDecimal(l.price))
                  : null;
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
                        aria-label="ფასი"
                      />
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
        თარიღი
        <input type="date" name="order_date" defaultValue={today} required />
      </label>

      <label>
        შენიშვნა (არასავალდებულო)
        <input name="note" maxLength={500} />
      </label>

      <div className="filter-actions">
        <button type="submit" className="button primary" disabled={!valid}>
          შეკვეთის შენახვა
        </button>
      </div>
      <p className="muted">
        შეკვეთა არ გატარდება სალაროში, არ შეცვლის მარაგს და არ აისახება შემოსავლებში.
      </p>
    </form>
  );
}
