# Remaining staging concurrency verification

Implemented by `scripts/staging-concurrency-followup.mjs`; manual instructions
and coverage limits are in `CONCURRENCY_FOLLOWUP_RUNNER.md`. No database operations
were executed during implementation.
Project must be nexo-staging, reference tclplmbnfnktpthcwqbq.

## Preserved historical evidence

Never reopen or target historical session
ed6d7067-8482-4654-8c3b-df124450644c with another mutation.
The user reports closed / expected 121 / actual 121 / difference 0,
valid database timestamps and note, 2 sales, 2 items, 4 payments, 4 ledger
entries, total sales/payments 25 and customer balance zero. Read-only inspection
found no race sale, timeout payment, zero-debt payment or integrity violations.
This is a valid close-wins financial outcome, not evidence of RPC rollback.

The old assertion bundled status, note, timestamp ordering and workstation time.
The last condition was unsafe: independent client and server clocks need not
agree within ten seconds. The replacement checks each condition separately and
compares stored opening/closing instants at microsecond precision. It never
uses workstation time to judge database timestamps. The original client-clock
value and HTTP replies were not retained, so clock skew is not independently
measured or proven by the inspection alone. There is no evidence requiring a
business RPC or migration change.

## Coverage accounting

- Reaching the race means earlier competing-open assertions, concurrent original
  sale/repayment retries and REQUEST_CONFLICT assertions passed with unchanged
  snapshots. Those do not need to be repeated on historical records.
- Server statement timeout 57014 and unchanged data were observed. Runtime
  lock_timeout 55P03 was NOT observed. Do not claim it was, or change role settings
  to force it. The timeout occurred before financial writes, not midway through
  an insert sequence.
- The race observed overlapping database waiters and committed a valid close.
  Inspection proves close-wins stored results and no partial records.
- The STOP occurred before validation of the race's HTTP responses, exactly-one
  close success / other SESSION_CLOSED, and post-close new-request rejection and
  existing-request replay. These remain unverified.
- A sale-wins close ordering and a repayment against positive debt racing close
  remain untested. Existing settled customer data must not be repurposed.
- Concurrent retries of already completed requests were tested; first-use
  concurrent duplicate creation needs its own proof.

## New isolated fixture and runner design

Implement a separate runner; do not generalize the original pinned-session runner
by changing its session ID. Use a unique run UUID and persist/print fixture IDs
and request UUIDs before every mutation. Never log credentials or raw errors.
Require a fresh explicit confirmation before fixture creation, each race, and
each close. Unknown outcomes mean STOP plus read-only inspection, never retry.

Use real POS-only cashier Auth for every financial RPC. Use real POS admin Auth
only for new customer/register creation and the existing customer-price RPC.
Use two verified TLS session-pooler database connections solely for read-only
observation and temporary locking, never financial writes or JWT impersonation.
Use the downloaded CA; never disable certificate verification.

Before setup, snapshot all existing financial rows, customers/prices/registers,
and the historical closed session. After each phase compare all baseline rows
byte-for-byte and allow additions only with recorded new fixture IDs. Do not
use fixed global counts after setup. Require no open session for this cashier.
Require STG-SINGLE still active with retail price 10 and cash/TBC methods active.

Create a new customer named `STAGING - CONCURRENCY FOLLOWUP <run UUID>` and set
STG-SINGLE wholesale price to 10 through pos_set_customer_prices(p_customer,p_rows). Never edit the
old wholesale customer or its prices. Create separate registers named
`STAGING - CONCURRENCY FOLLOWUP A/B <run UUID>`. Open sessions sequentially through
pos_open_register(p_register,p_cash='0.00'); the same cashier cannot have two open
sessions. Do not reuse even the previously empty companion register.

### Session A: new-request duplication and operations winning before close

1. Open A. Complete one new wholesale sale for the new customer: quantity 1,
   price 10, no payments. Verify one item, charge +10, balance 10, drawer 0.
2. Hold a fresh sale request advisory lock, launch two identical new fully paid
   TBC retail requests (10), observe two distinct blocked database backends,
   release and await both. Require the same sale ID, exactly one sale/item/payment
   and no cash change. Then race exact retries against a changed-tracking payload
   under that same request lock: originals return the ID, changed is
   REQUEST_CONFLICT and no rows change. Separating first creation from conflict
   avoids letting the intentionally changed request become the first winner.
3. Hold a fresh repayment request advisory lock, launch two identical cash
   repayments of 4 against A's wholesale sale, observe overlap and release.
   Require one payment/ledger entry, same returned ID, balance 6, drawer 4.
   Repeat with existing-request exact retries and a conflicting amount 3;
   require REQUEST_CONFLICT without changes.
4. For deterministic operations-before-close coverage, observer/holder lock a
   required existing row on the NEW fixture (wholesale sale row). Dispatch a new
   TBC repayment of 2. Prove its backend holds A's session row and is waiting on
   the held sale row; only then dispatch close(actual 4). Observe close blocked
   behind that repayment; release promptly. Require repayment success, close
   success, balance 4, drawer/actual 4, difference 0. No inference from launch
   order alone. If lock ownership cannot be demonstrated, STOP, not PASS.
   A TBC repayment leaves drawer unchanged regardless of scheduling.
5. After close, fresh sale/repayment requests must return OPEN_SESSION_REQUIRED,
   second close SESSION_CLOSED. Existing successful sale/repayment requests return
   their old IDs, changed requests REQUEST_CONFLICT; all snapshots unchanged.

### Session B: sale-before-close and close-before-repayment

Open B only after A is closed. Starting drawer 0. Preserve A's remaining new
fixture debt 4; this is deliberate test data, not historical customer debt.

To cover sale-before-close, hold a lock conflicting with the sale's catalog
read lock only after verifying pos_quote's actual lock statements in the runner
implementation. Prefer a NEW fixture customer row: a wholesale sale takes FOR
SHARE on it after locking its session. Hold that row FOR UPDATE, dispatch one
new fully TBC-paid wholesale sale 10, observe the sale owns B's session lock and
waits on the customer, dispatch close(actual 0), prove blocking, then release.
Require exactly one atomic sale/item/payment/charge/payment-ledger pair and a
successful zero-difference close. Balance stays 4. Do not lock or edit products.

For deterministic close-before-sale/repayment, use a THIRD new register/session C
opened only after B closes. Start with cash 0. Holder locks C's session; dispatch
close and observe it waiting before starting new sale and a valid TBC repayment
of 2 on A's new debt, plus a second close. Observe actual queue/dependency edges,
release, and validate replies and stored state. Do not assume queue order merely
from Promise order: if the financial operation wins instead, record that valid
outcome, verify it exactly, and leave close-first coverage outstanding rather
than silently retrying. TBC keeps expected cash 0 whichever wins.

The required close-first outcome: one close success, second SESSION_CLOSED,
fresh sale/repayment OPEN_SESSION_REQUIRED, no rows for their request IDs, new
fixture balance still 4. After close, repeat fresh-request rejections and old
successful request replays with no changes. All sessions remain closed and all
new fixture records/debt are retained for review; no cleanup/settlement shortcut.

## Atomicity and final checks

For every success verify snapshots, totals, payment method, session ownership,
exact per-request row deltas, ledger charge/payment links and current balances.
For every rejection verify zero per-request financial rows and unchanged totals.
Check global FK links, sale/request/line/payment/ledger uniqueness and open-session
invariants. Sale-number gaps are allowed; duplicate numbers are not.

Before closing A, inspect actual constraints for a controlled post-insert failure
reliably reachable through permitted RPC inputs without modifying schema.
If none is identified, explicitly report mid-write failure injection as untested;
do not weaken policies or add test triggers. Current successful transactions and
pre-write timeout/rejections alone do not prove every hypothetical failure path.

Keep all database locks bounded and release in finally. Await every launched HTTP
request even on failure; observation failure is never rollback evidence. Store
sanitized individual code/result IDs before aggregate assertions so a future
STOP does not discard race outcome evidence. Closed timestamp validation uses
database instants only. No workstation-clock upper bound.

## Next manual step

Follow only the first manual step in `CONCURRENCY_FOLLOWUP_RUNNER.md`, stopping
at the fixture-creation confirmation. Never rerun staging-concurrency-close.mjs
against its historical pinned session.
