# Sale returns (დაბრუნება)

Migration: `supabase/migrations/202610020001_pos_returns.sql` — apply **manually**, after `202610010002_pos_cash_withdrawals.sql`.

## Apply
1. Supabase → SQL Editor, role **postgres** (the owner that applied the earlier migrations).
2. Paste the whole file and run it once. It is one transaction; on any error nothing is applied.
3. Verify: `select to_regclass('public.pos_returns'), to_regprocedure('public.pos_complete_return(uuid,uuid,uuid,jsonb,jsonb,text)');` returns two non-null values.

Deploy the app only after the migration is applied (the new `/returns` page and the cash summary read the new objects).

## Rules enforced in the database
- Any active cashier or admin with their **own open register session** can return items from **any** receipt (found by sale number).
- A line can be returned in parts; the quantity can never exceed what was sold minus what was already returned. The last unit returns exactly the remaining line amount (no cent drift).
- Retail: the full value is refunded; the cashier picks the refund method (cash, card, …).
- Wholesale: the value first reduces the sale's open debt (ledger kind `return_credit`); only the excess is refunded. The refund the cashier sends must equal the amount the database computes (`REFUND_TOTAL_MISMATCH` otherwise).
- Cash refunds leave the drawer: `expected cash = opening + cash payments − withdrawals − cash refunds`, and a cash refund larger than the drawer is rejected (`INSUFFICIENT_CASH`).
- A request ID makes retries safe: the same request returns the same result, a changed payload under the same ID is `REQUEST_CONFLICT`.
- Returns, their items and refunds are immutable (no update/delete/truncate) and have no direct write grants.

## Visibility
Admins see every return. A cashier sees returns they made and returns made against their own sales.
