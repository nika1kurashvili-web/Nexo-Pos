import type { Decimal } from "./types";

export type CheckedSession = {
  id: string;
  register_id: string;
  opened_at: string;
  status: "open" | "closed";
  opening_cash: Decimal;
  actual_closing_cash: Decimal | null;
  expected_cash: Decimal | null;
};

export type HistorySession = {
  id: string;
  register_id: string;
  opened_at: string;
  status: "open" | "closed";
  actual_closing_cash: Decimal | null;
};

export type Check = { state: "ok" | "bad" | "na"; text: string };
export type SessionCheck = { opening: Check; closing: Check; verdict: "ok" | "bad" | "na" };

const cents = (value: Decimal | null | undefined) => Math.round(Number(value ?? 0) * 100);
const gel = (valueCents: number) =>
  `${(valueCents / 100).toLocaleString("ka-GE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₾`;
const signed = (valueCents: number) => `${valueCents > 0 ? "+" : ""}${gel(valueCents)}`;

// history: ყველა სესია ყველა სალაროსთვის (არა მხოლოდ გაფილტრულები), დალაგება მნიშვნელობა არ აქვს.
export function checkSession(session: CheckedSession, history: HistorySession[]): SessionCheck {
  let previous: HistorySession | null = null;
  for (const other of history) {
    if (other.register_id !== session.register_id || other.id === session.id) continue;
    if (other.opened_at >= session.opened_at) continue;
    if (!previous || other.opened_at > previous.opened_at) previous = other;
  }

  let opening: Check;
  if (!previous) {
    opening = { state: "na", text: "პირველი გახსნა ამ სალაროზე" };
  } else if (previous.status !== "closed" || previous.actual_closing_cash === null) {
    opening = { state: "na", text: "წინა სესია დახურული არ არის" };
  } else {
    const diff = cents(session.opening_cash) - cents(previous.actual_closing_cash);
    opening = diff === 0
      ? { state: "ok", text: "გახსნა სწორია: ემთხვევა წინა დახურვას" }
      : {
          state: "bad",
          text: `გახსნა შეცდომით: გაიხსნა ${gel(cents(session.opening_cash))}-ით, წინა დახურვა იყო ${gel(cents(previous.actual_closing_cash))} (სხვაობა ${signed(diff)})`,
        };
  }

  let closing: Check;
  if (session.status === "open") {
    closing = { state: "na", text: "სესია ღიაა" };
  } else {
    const diff = cents(session.actual_closing_cash) - cents(session.expected_cash);
    closing = diff === 0
      ? { state: "ok", text: "დახურვა სწორია: ფაქტობრივი = მოსალოდნელი" }
      : {
          state: "bad",
          text: `დახურვა შეცდომით: ფაქტობრივი ${gel(cents(session.actual_closing_cash))}, მოსალოდნელი ${gel(cents(session.expected_cash))} (სხვაობა ${signed(diff)})`,
        };
  }

  const verdict: SessionCheck["verdict"] =
    opening.state === "bad" || closing.state === "bad"
      ? "bad"
      : opening.state === "ok" || closing.state === "ok"
        ? "ok"
        : "na";
  return { opening, closing, verdict };
}
