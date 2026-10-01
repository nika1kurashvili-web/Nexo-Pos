"use client";

import { useActionState, useState } from "react";
import { recordCashWithdrawal } from "@/app/(pos)/cash-withdrawal-action";
import type { WithdrawalResult } from "@/lib/pos/cash-withdrawal";

function WithdrawalForm({ sessionId, requestId, onCancel }: { sessionId: string; requestId: string; onCancel: () => void }) {
  const [result, action, pending] = useActionState<WithdrawalResult, FormData>(recordCashWithdrawal, { status: "idle", message: "" });
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const unknown = result.status === "unknown";
  if (result.status === "success") return <div role="status"><p className="notice success">{result.message}</p><button type="button" className="button secondary" onClick={onCancel}>დასრულება</button></div>;
  return <form action={action} className="data-form" aria-busy={pending}>
    <h3>თანხის გაცემა</h3>
    <input type="hidden" name="request_id" value={requestId} />
    <input type="hidden" name="session_id" value={sessionId} />
    <label>თანხა (₾)<input name="amount" type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" required placeholder="0.00" value={amount} readOnly={pending || unknown} onChange={e => setAmount(e.target.value)} /></label>
    <label>მიზეზი<textarea name="reason" required maxLength={500} value={reason} readOnly={pending || unknown} onChange={e => setReason(e.target.value)} /></label>
    {result.message && <p className="notice error" role="alert">{result.message}</p>}
    {unknown && <p>მოთხოვნის ნომერი: <code>{requestId}</code></p>}
    <div><button type="button" className="button secondary" disabled={pending || unknown} onClick={onCancel}>გაუქმება</button>{" "}
      <button type="submit" className="button primary" disabled={pending}>{pending ? "ინახება…" : unknown ? "იგივე მოთხოვნის გამეორება" : "თანხის გაცემა"}</button></div>
  </form>;
}

export function CashWithdrawalForm({ sessionId }: { sessionId: string }) {
  const [requestId, setRequestId] = useState<string | null>(null);
  return requestId ? <WithdrawalForm sessionId={sessionId} requestId={requestId} onCancel={() => setRequestId(null)} /> :
    <button type="button" className="button secondary" onClick={() => setRequestId(crypto.randomUUID())}>თანხის გაცემა</button>;
}
