"use client";

import { useState } from "react";
import { editPurchase } from "@/app/(pos)/purchases/actions";
import { isPrice, isQuantity, normalizeDecimal } from "@/lib/pos/inventory";

export type EditLine = {
  id: string;
  sku: string | null;
  name: string;
  quantity: string;
  unit_price: string;
};

const gel = (value: number) =>
  `${value.toLocaleString("ka-GE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₾`;

const same = (a: string, b: string) =>
  isQuantity(a) && isQuantity(b) ? Number(normalizeDecimal(a)) === Number(normalizeDecimal(b)) : a === b;
const samePrice = (a: string, b: string) =>
  isPrice(a) && isPrice(b) ? Number(normalizeDecimal(a)) === Number(normalizeDecimal(b)) : a === b;

export default function PurchaseEditForm({
  purchaseId,
  lines: initial,
  note: initialNote,
}: {
  purchaseId: string;
  lines: EditLine[];
  note: string;
}) {
  const [rows, setRows] = useState(
    initial.map((l) => ({ id: l.id, quantity: l.quantity, price: l.unit_price })),
  );
  const [note, setNote] = useState(initialNote);

  const update = (id: string, patch: Partial<{ quantity: string; price: string }>) =>
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const valid = rows.every((r) => isQuantity(r.quantity) && isPrice(r.price));
  const changed =
    note.trim() !== initialNote.trim() ||
    rows.some((r, i) => !same(r.quantity, initial[i].quantity) || !samePrice(r.price, initial[i].unit_price));

  const total = rows.reduce((sum, r) => {
    if (!isQuantity(r.quantity) || !isPrice(r.price)) return sum;
    return sum + Number(normalizeDecimal(r.quantity)) * Number(normalizeDecimal(r.price));
  }, 0);

  const payload = JSON.stringify(
    rows.map((r) => ({ id: r.id, quantity: r.quantity, unit_price: r.price })),
  );

  return (
    <form action={editPurchase} className="data-form">
      <input type="hidden" name="purchase_id" value={purchaseId} />
      <input type="hidden" name="items" value={payload} />

      <section className="panel">
        <h2>პოზიციები</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ბარკოდი</th>
                <th>პროდუქტი</th>
                <th>რაოდენობა</th>
                <th>შესყიდვის ფასი (₾)</th>
                <th>ჯამი</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const l = initial[i];
                const okQ = isQuantity(r.quantity);
                const okP = isPrice(r.price);
                const line = okQ && okP ? Number(normalizeDecimal(r.quantity)) * Number(normalizeDecimal(r.price)) : null;
                const qChanged = !same(r.quantity, l.quantity);
                const pChanged = !samePrice(r.price, l.unit_price);
                return (
                  <tr key={r.id}>
                    <td>{l.sku ?? ""}</td>
                    <td>{l.name}</td>
                    <td>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={r.quantity}
                        onChange={(e) => update(r.id, { quantity: e.target.value })}
                        aria-invalid={!okQ}
                        aria-label="რაოდენობა"
                      />
                      {qChanged && <span className="muted"> იყო: {l.quantity}</span>}
                    </td>
                    <td>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={r.price}
                        onChange={(e) => update(r.id, { price: e.target.value })}
                        aria-invalid={!okP}
                        aria-label="შესყიდვის ფასი"
                      />
                      {pChanged && <span className="muted"> იყო: {l.unit_price}</span>}
                    </td>
                    <td>{line === null ? "—" : gel(line)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
          <button type="submit" className="button primary" disabled={!valid || !changed}>
            ცვლილებების შენახვა
          </button>
        </div>
        <p className="muted">
          რაოდენობის შეცვლისას მარაგი შეიცვლება სხვაობით. შესყიდვის ფასი პროდუქტზე განახლდება მხოლოდ მაშინ,
          თუ ეს ამ პროდუქტის ბოლო შესყიდვაა. ყოველი ცვლილება ჩაიწერება ისტორიაში.
        </p>
      </section>
    </form>
  );
}
