"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { completeReturn } from "@/app/(pos)/returns/actions";

type Item = {
  id: string;
  name: string;
  sku: string | null;
  quantity: string;
  finalUnitPrice: string;
  lineTotal: string;
  returnedQuantity: string;
  returnedAmount: string;
};

type Props = {
  saleId: string;
  saleNumber: number;
  saleType: "retail" | "wholesale";
  currentDebt: number;
  items: Item[];
  paymentMethods: { code: string; name: string }[];
  sessionId: string | null;
  requestId: string;
};

// ყველა გამოთვლა მთელ რიცხვებზე (მილი-ერთეული და თეთრი), ბაზის წესების იდენტურად.
const milli = (value: string) => Math.round(Number(value) * 1000);
const cents = (value: string | number) => Math.round(Number(value) * 100);
const gel = (valueCents: number) => `${(valueCents / 100).toFixed(2)} ₾`;
const qtyPattern = /^\d{1,11}(\.\d{1,3})?$/;

function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="button primary return-submit"
      disabled={disabled || pending}
    >
      {pending ? "ინახება…" : "დაბრუნების გაფორმება"}
    </button>
  );
}

export default function ReturnForm({
  saleId,
  saleNumber,
  saleType,
  currentDebt,
  items,
  paymentMethods,
  sessionId,
  requestId,
}: Props) {
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState(
    paymentMethods.find((m) => m.code === "cash")?.code ??
      paymentMethods[0]?.code ??
      "",
  );

  const lines = items.map((item) => {
    const remaining = milli(item.quantity) - milli(item.returnedQuantity);
    const raw = (quantities[item.id] ?? "").trim();
    const entered = raw !== "";
    const valid = entered && qtyPattern.test(raw) && milli(raw) > 0 && milli(raw) <= remaining;
    const qMilli = valid ? milli(raw) : 0;
    const left = cents(item.lineTotal) - cents(item.returnedAmount);
    // ბოლო ერთეული აბრუნებს ხაზის დარჩენილ თანხას, თეთრები არ იკარგება.
    const amount = !valid
      ? 0
      : qMilli === remaining
        ? left
        : Math.min(Math.floor((cents(item.finalUnitPrice) * qMilli + 500) / 1000), left);
    return { item, raw, entered, valid, qMilli, remaining, amount };
  });

  const selected = lines.filter((l) => l.valid);
  const hasInvalid = lines.some((l) => l.entered && !l.valid);
  const totalCents = selected.reduce((sum, l) => sum + l.amount, 0);
  const debtCents = saleType === "wholesale" ? cents(currentDebt) : 0;
  const debtReduction = Math.min(totalCents, debtCents);
  const refundCents = totalCents - debtReduction;

  const canSubmit =
    sessionId !== null &&
    selected.length > 0 &&
    !hasInvalid &&
    reason.trim().length > 0 &&
    (refundCents === 0 || method !== "");

  const itemsPayload = selected.map((l) => ({
    sale_item_id: l.item.id,
    quantity: l.raw,
  }));
  const refundsPayload =
    refundCents > 0 ? [{ method, amount: (refundCents / 100).toFixed(2) }] : [];

  const setQty = (id: string, value: string) =>
    setQuantities((prev) => ({ ...prev, [id]: value }));

  return (
    <form action={completeReturn} className="panel return-form">
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="session_id" value={sessionId ?? ""} />
      <input type="hidden" name="sale_id" value={saleId} />
      <input type="hidden" name="sale_number" value={saleNumber} />
      <input type="hidden" name="items" value={JSON.stringify(itemsPayload)} />
      <input type="hidden" name="refunds" value={JSON.stringify(refundsPayload)} />

      <h2>რას აბრუნებს მყიდველი?</h2>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>ნივთი</th>
              <th>გაყიდული</th>
              <th>უკვე დაბრუნებული</th>
              <th>ფასი</th>
              <th>დასაბრუნებელი</th>
              <th>თანხა</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(({ item, raw, entered, valid, remaining, amount }) => {
              const done = remaining <= 0;
              return (
                <tr key={item.id} className={done ? "row-done" : undefined}>
                  <td>
                    <strong>{item.name}</strong>
                    {item.sku && <div className="muted">{item.sku}</div>}
                  </td>
                  <td>{Number(item.quantity)}</td>
                  <td>{Number(item.returnedQuantity)}</td>
                  <td>{gel(cents(item.finalUnitPrice))}</td>
                  <td>
                    {done ? (
                      <span className="muted">აღარ რჩება</span>
                    ) : (
                      <div className="return-qty">
                        <input
                          type="text"
                          inputMode="decimal"
                          aria-label={`დასაბრუნებელი რაოდენობა: ${item.name}`}
                          placeholder="0"
                          value={raw}
                          aria-invalid={entered && !valid}
                          onChange={(event) => setQty(item.id, event.target.value)}
                          onFocus={(event) => event.currentTarget.select()}
                        />
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => setQty(item.id, String(remaining / 1000))}
                        >
                          ყველა ({remaining / 1000})
                        </button>
                      </div>
                    )}
                    {entered && !valid && !done && (
                      <div className="field-error" role="alert">
                        მაქსიმუმ {remaining / 1000}
                      </div>
                    )}
                  </td>
                  <td>{valid ? <strong>{gel(amount)}</strong> : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="return-bottom">
        <label>
          დაბრუნების მიზეზი
          <textarea
            name="reason"
            required
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="მაგ. დეფექტი, არასწორი ზომა, კლიენტმა გადაიფიქრა"
          />
        </label>

        <div className="return-summary">
          <p>
            <span>დასაბრუნებელი ნივთების ღირებულება</span>
            <strong>{gel(totalCents)}</strong>
          </p>

          {saleType === "wholesale" && (
            <p>
              <span>ვალის შემცირება (მიმდინარე ვალი {gel(debtCents)})</span>
              <strong>{gel(debtReduction)}</strong>
            </p>
          )}

          <p className="return-refund">
            <span>მყიდველს უბრუნდება</span>
            <strong>{gel(refundCents)}</strong>
          </p>

          {refundCents > 0 && (
            <label>
              როგორ დაუბრუნდეს თანხა
              <select value={method} onChange={(event) => setMethod(event.target.value)}>
                {paymentMethods.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {refundCents > 0 && method === "cash" && (
            <p className="muted">ნაღდი თანხა სალაროს მოსალოდნელ ნაღდს დააკლდება.</p>
          )}
          {saleType === "wholesale" && debtReduction > 0 && refundCents === 0 && (
            <p className="muted">თანხა მთლიანად კლიენტის ვალს დაუკლდება, ფული არ ბრუნდება.</p>
          )}
        </div>
      </div>

      <Submit disabled={!canSubmit} />
    </form>
  );
}
