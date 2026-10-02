"use client";

import { useState } from "react";
import { SaveButton } from "@/app/components/pos-forms";

type RegisterOption = {
  register_id: string;
  register_name: string;

  last_actual_closing_cash: number | string | null;
  last_expected_closing_cash: number | string | null;
  last_closed_at: string | null;
};

type Props = {
  registers: RegisterOption[];
  action: (formData: FormData) => void | Promise<void>;
};

function formatMoney(value: number | string) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "0.00 ₾";
  }

  return `${number.toFixed(2)} ₾`;
}

export function RegisterOpenForm({
  registers,
  action,
}: Props) {
  const [registerId, setRegisterId] = useState("");

  const selected =
    registers.find(
      (register) =>
        register.register_id === registerId
    ) ?? null;

  const actual =
    selected?.last_actual_closing_cash ?? null;

  const expected =
    selected?.last_expected_closing_cash ?? null;

  const lastAmount =
    actual !== null ? actual : expected;

  return (
    <form action={action} className="data-form">
      <label>
        თავისუფალი სალარო

        <select
          name="register_id"
          required
          value={registerId}
          onChange={(event) =>
            setRegisterId(event.target.value)
          }
        >
          <option value="" disabled>
            აირჩიეთ სალარო
          </option>

          {registers.map((register) => (
            <option
              key={register.register_id}
              value={register.register_id}
            >
              {register.register_name}
            </option>
          ))}
        </select>
      </label>

      <label>
        საწყისი ნაღდი თანხა

        <input
          name="opening_cash"
          type="number"
          min="0"
          step="0.01"
          defaultValue="0.00"
          required
        />
      </label>

      {selected && (
        lastAmount !== null && selected.last_closed_at ? (
          <>
            <div className="stat-grid">
              <div className="stat stat-info">
                <span>ბოლო დახურვა</span>
                <strong>{formatMoney(lastAmount)}</strong>
              </div>
              <div className="stat stat-info">
                <span>დახურვის დრო</span>
                <strong>
                  {new Date(
                    selected.last_closed_at
                  ).toLocaleString("ka-GE", {
                    timeZone: "Asia/Tbilisi",
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </strong>
              </div>
            </div>

            {actual === null && (
              <p className="muted">
                ეს არის მოსალოდნელი თანხა,
                რადგან ფაქტობრივი დახურვის თანხა
                არ არის დაფიქსირებული.
              </p>
            )}
          </>
        ) : (
          <p className="notice info">
            წინა დახურვის მონაცემი არ არის.
          </p>
        )
      )}

      <SaveButton>
        სალაროს გახსნა
      </SaveButton>
    </form>
  );
}