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
    initial.map((l) => ({ id: l.id, quantity: l.quantity, price: l.unit_price, removed: false })),
  );
  const [note, setNote] = useState(initialNote);

  const update = (id: string, patch: Partial<{ quantity: string; price: string; removed: boolean }>) =>
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const kept = rows.filter((r) => !r.removed);
  const valid = kept.length > 0 && kept.every((r) => isQuantity(r.quantity) && isPrice(r.price));
  const changed =
    note.trim() !== initialNote.trim() ||
    rows.some((r, i) => r.removed || !same(r.quantity, initial[i].quantity) || !samePrice(r.price, initial[i].unit_price));

  const total = kept.reduce((sum, r) => {
    if (!isQuantity(r.quantity) || !isPrice(r.price)) return sum;
    return sum + Number(normalizeDecimal(r.quantity)) * Number(normalizeDecimal(r.price));
  }, 0);

  const payload = JSON.stringify(
    kept.map((r) => ({ id: r.id, quantity: r.quantity, unit_price: r.price })),
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
                <th />
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
                  <tr key={r.id} style={r.removed ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                    <td>{l.sku ?? ""}</td>
                    <td>{l.name}</td>
                    <td>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={r.quantity}
                        onChange={(e) => update(r.id, { quantity: e.target.value })}
                        disabled={r.removed}
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
                        disabled={r.removed}
                        aria-invalid={!okP}
                        aria-label="შესყიდვის ფასი"
                      />
                      {pChanged && <span className="muted"> იყო: {l.unit_price}</span>}
                    </td>
                    <td>{line === null || r.removed ? "—" : gel(line)}</td>
                    <td>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => update(r.id, { removed: !r.removed })}
                        aria-label={r.removed ? "დაბრუნება" : "პოზიციის ამოღება"}
                        style={{ textDecoration: "none" }}
                      >
                        {r.removed ? "დაბრუნება" : "✕"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p><strong>სულ: {gel(total)}</strong></p>
        {kept.length === 0 && (
          <p className="notice error" role="alert">
            ყველა პოზიცია ამოღებულია. მთელი შესყიდვის წასაშლელად გამოიყენეთ „შესყიდვის წაშლა“ შესყიდვის გვერდზე.
          </p>
        )}
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
          პოზიციის ამოღებისას მისი მარაგი გამოაკლდება. რაოდენობის შეცვლისას მარაგი შეიცვლება სხვაობით. შესყიდვის ფასი პროდუქტზე განახლდება მხოლოდ მაშინ,
          თუ ეს ამ პროდუქტის ბოლო შესყიდვაა. ყოველი ცვლილება ჩაიწერება ისტორიაში.
        </p>
      </section>
    </form>
  );
}
