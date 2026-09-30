# New staging concurrency follow-up runner

Entry point: `scripts/staging-concurrency-followup.mjs`.
Implements `CONCURRENCY_FOLLOWUP_PLAN.md`; this is not the historical runner.
No Supabase operations were executed during implementation or local tests.

## First manual step only

From the repository terminal run:

```powershell
node scripts/staging-concurrency-followup.mjs
```

Provide locally, in prompt order:

1. Project reference `tclplmbnfnktpthcwqbq`, then confirmation `nexo-staging`.
2. Staging publishable/anon key (hidden). Secret/service-role keys are refused.
3. Existing POS-only cashier email/password (hidden).
4. Existing POS admin email/password (hidden).
5. Session pooler host `aws-1-eu-west-1.pooler.supabase.com` (hidden).
6. Session pooler username `postgres.tclplmbnfnktpthcwqbq` (hidden).
7. Port `5432`.
8. Staging database password (hidden).
9. Local CA path `C:\Users\nika1\Downloads\prod-ca-2021.crt`, without quotation marks.

**Stop at `CREATE NEW STAGING FOLLOWUP FIXTURES`; do not confirm yet.**
At READY no fixtures or financial records have been written. Auth sign-ins,
read-only checks, TLS database connections and a local sanitized journal exist.
Do not leave the prompt unattended for an extended period; Auth expiry or
connection loss must stop the run rather than prompt any automatic retry.

## Safety and evidence

- Hard-pinned staging HTTPS endpoint, exact pooler hostname/project username,
  port 5432, CA verification and two distinct server connections. No direct or
  transaction-pooler alternative, no insecure TLS fallback.
- The baseline historical closed session must still close at 121 with zero
  difference and belong to the real cashier. The script cannot send a financial
  RPC or lock request against that session.
- New customer and A/B/C register UUIDs are generated and durably logged before
  creation. Session IDs come from the database and cannot be predicted: the
  register ID plus a unique local operation ID is logged before opening; the
  returned session ID is immediately logged afterward.
- The journal is a new JSONL file in the local OS temporary directory, outside
  Git. The exact path prints on startup. Each entry is flushed before proceeding.
  Keep the journal for review; it contains only fixed diagnostic labels, UUIDs,
  counts, dependency PIDs and allowlisted result codes/cash values, no secrets,
  raw request bodies, error objects or SQL parameter text.
- Every RPC logs a result before aggregate validation. Every launched request is
  awaited even if dependency observation/release fails. Unknown outcome is STOP,
  never an automatic retry, close, compensation, or cleanup.
- Rejected fresh requests are compared against stored state. Exact prior request
  retries are intentional idempotency tests, not recovery after ambiguous errors.
- Snapshots include all existing financial rows, customer prices, customers and
  registers. Every baseline row is compared after each phase. New rows must
  belong to recorded fixtures/requests. Only explicitly closing a NEW session
  may change a row from the preceding snapshot.

## Lock evidence

The first-use duplicate cohorts block two separate backend requests on the same
request advisory lock. Subsequent cohorts include changed-payload conflicts.

For A, a new wholesale sale row is held; the repayment locks the session before
waiting on that row. For B, the new customer row is held; the wholesale sale
locks its session before requesting the customer's FOR SHARE lock. pos_quote
does not lock the catalog row; no products/variants are locked or edited.

The observer proves the operation is blocked on the holder, uses a NOWAIT probe
to confirm the new session is locked, and then proves the close backend depends
on that specific operation PID. Request launch order is not proof. The probe's
temporary transaction always rolls back.

For C, close is observed waiting before the other requests start. The runner
requires edges showing sale, repayment and competing close depend on that first
close PID. Missing edges or a valid operation-first outcome produce
`COVERAGE_OUTSTANDING`, after validating the actual results and closing all new
sessions. There is no silent rerun. Unknown RPC results still cause STOP.

Holder transactions use local 2s lock timeout, 10s statement and idle-transaction
guards. Observer waits are bounded; locks release in finally before draining HTTP
requests. These settings do not change cashier RPC/role/global configuration.

## Expected retained records

On the intended result there are three NEW closed sessions: A at 4 cash, B/C at
0, each with zero difference. The NEW customer's deliberate remaining debt is
4.00 (2.00 if C's repayment legitimately beats close, reported as outstanding
close-first coverage). Original customer balance and all historical rows stay
unchanged. No cleanup or automatic settlement is performed.

Post-close checks cover fresh sale/repayment rejection, second-close rejection,
successful earlier NEW-fixture request replays and changed-payload conflicts.
The historical pinned session is never targeted, including for these probes.

`PASS_WITH_COVERAGE_LIMITS` means the planned runtime assertions passed, not that
all conceivable failure modes were tested. No safe reliable post-insert failure
input was identified: decimal/quantity bounds and validations occur before writes;
item numeric fields accommodate the permitted input limits, and valid staged FK
and ledger inputs do not provide a deterministic late error. Mid-write failure
injection stays UNTESTED. No triggers, constraints or policies are added to force
one. Runtime lock_timeout 55P03 remains NOT_CERTIFIED; the previous historical
test observed statement_timeout 57014, not lock_timeout.

If STOP occurs, sessions may be open or already closed and writes may have
committed. Preserve everything and inspect the journal IDs read-only. The final
all-sessions-closed assertion applies to completed verification, never to an
automatic repair after a failure.
