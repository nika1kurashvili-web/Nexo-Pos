export type WithdrawalResult = { status: "idle" | "error" | "unknown" | "success"; message: string };

export const withdrawalErrors: Record<string, string> = {
  INVALID_DECIMAL: "შეიყვანეთ დადებითი თანხა, მაქსიმუმ 2 ათწილადით.",
  INVALID_WITHDRAWAL_REASON: "მიუთითეთ მიზეზი, 1–500 სიმბოლო.",
  INSUFFICIENT_CASH: "სალაროში მოსალოდნელი ნაღდი თანხა არასაკმარისია.",
  OPEN_SESSION_REQUIRED: "თანხის გაცემა მხოლოდ თქვენი ღია სალაროდან შეიძლება.",
  POS_ACCESS_DENIED: "ამ მოქმედებისთვის აქტიური POS წვდომაა საჭირო.",
  REQUEST_CONFLICT: "ამ მოთხოვნის ნომრით განსხვავებული მონაცემებია შენახული. გადაამოწმეთ გაცემების ისტორია.",
};

export function validWithdrawal(amount: string, reason: string) {
  return /^[0-9]+(?:\.[0-9]{1,2})?$/.test(amount) && Number(amount) > 0 &&
    Number(amount) <= 9999999999.99 && reason.trim().length > 0 && [...reason.trim()].length <= 500;
}
