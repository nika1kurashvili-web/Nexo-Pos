"use server";

import { revalidatePath } from "next/cache";
import { posClient } from "@/lib/pos/server";
import { validWithdrawal, withdrawalErrors, type WithdrawalResult } from "@/lib/pos/cash-withdrawal";

export async function recordCashWithdrawal(_previous: WithdrawalResult, form: FormData): Promise<WithdrawalResult> {
  // Keep redirects from the authoritative membership guard outside RPC catch.
  const client = await posClient();
  const request = String(form.get("request_id") ?? "");
  const session = String(form.get("session_id") ?? "");
  const amount = String(form.get("amount") ?? "").trim();
  const reason = String(form.get("reason") ?? "").trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(request) || !uuid.test(session) || !validWithdrawal(amount, reason)) {
    return { status: "error", message: "შეამოწმეთ თანხა (მაქსიმუმ 2 ათწილადი) და მიზეზი (1–500 სიმბოლო)." };
  }
  const unknown: WithdrawalResult = { status: "unknown", message: "შედეგი ვერ დადასტურდა. არ შექმნათ ახალი მოთხოვნა. გადაამოწმეთ ისტორია ან გაიმეორეთ იგივე მოთხოვნა უცვლელი მონაცემებით." };
  let result;
  try {
    result = await client.rpc("pos_record_cash_withdrawal", { p_request: request, p_session: session, p_amount: amount, p_reason: reason });
  } catch { return unknown; }
  if (result.error) {
    const message = withdrawalErrors[result.error.message];
    // Known SQL exceptions roll back; transport/unknown outcomes retain the ID.
    return message ? { status: result.error.message === "REQUEST_CONFLICT" ? "unknown" : "error", message } : unknown;
  }
  if (!result.data) return unknown;
  revalidatePath("/");
  revalidatePath("/reports/register-sessions", "layout");
  return { status: "success", message: "თანხის გაცემა შენახულია. სალაროს მოსალოდნელი თანხა განახლდა." };
}
