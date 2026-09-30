# Final staging concurrency and register-close scenario

> Historical run completed its close. Do not rerun this script against its pinned
> session. See `CONCURRENCY_FOLLOWUP_PLAN.md` for the remaining coverage and new
> isolated fixture design. The instructions below document the original run.

Prepared only; no staging or production execution has been performed.
Script: `scripts/staging-concurrency-close.mjs`.
Pinned project: `tclplmbnfnktpthcwqbq` (nexo-staging).
Pinned open session: `ed6d7067-8482-4654-8c3b-df124450644c`.

## Manual steps are issued one at a time

First install the isolated database-client dependency from the repository root:

```powershell
pnpm --dir scripts/staging-concurrency-tools install --ignore-scripts
```

Stop after installation until instructed. This does not run the runtime test.
It does not modify the application's dependencies; it creates a local dependency
installation/lockfile in the dedicated tools directory. Do not commit or push.

When instructed later, the entry point is:

```powershell
node scripts/staging-concurrency-close.mjs
```

## Connections and credentials

All inputs are prompted locally. No credentials should be pasted into chat,
source files, environment variables, Vercel or command arguments.

- A staging publishable/anon key, with real POS-only cashier and separate POS
  admin email/password logins. All keys/passwords/emails are hidden.
- Two **staging PostgreSQL owner connections** solely for lock control/observation.
  Copy host and username from nexo-staging Dashboard **Connect**, using the direct
  endpoint or **session pooler**, port **5432**. Transaction pooler port 6543 is
  refused. Direct host must be `db.tclplmbnfnktpthcwqbq.supabase.co`, user `postgres`;
  the session pooler must use `postgres.tclplmbnfnktpthcwqbq` at a
  `*.pooler.supabase.com` host. Supply the staging **database password**, hidden.
- TLS certificate verification stays enabled. Enter `system` to use system CA
  trust, or a local PEM CA certificate path obtained from staging Dashboard.
  TLS failures stop the test; do not disable certificate validation.

The owner connections never call POS RPCs, set an authenticated role/JWT, write
financial data or change global/role defaults. They run transaction-local guard
settings, acquire locks, read metadata and release locks using ROLLBACK. The
cashier RPCs always go through Supabase Auth/PostgREST using the real cashier JWT.
The owner connection is cross-checked against the same session/cashier IDs.
The Auth POS admin is used for a companion register setup and read-only audits
of financial tables/ledger, including rows that cashier RLS could otherwise hide.

## Before any test-data mutation

The script checks the exact starting global staging financial counts: 2 sales,
2 items, 4 payments, 4 ledger entries, 1 open session. Cash drawer must be 121.00
and customer balance zero. Unexpected data causes STOP, never cleanup.

At `READY`, stop at `START STAGING CONCURRENCY CHECKS` until instructed. The owner
connections exist but no test locks or test-data writes have happened yet.
Do not run unrelated staging operations during these controlled tests.

## What is verified

1. **Competing opens:** admin creates/reuses the unused, active register named
   `STAGING - CONCURRENCY EMPTY REGISTER`. Two cashier open attempts target the
   occupied original register and the empty companion register. A temporary SHARE
   table lock makes both requests actually overlap. Both must fail with 23505;
   neither may create a session. The empty companion register is preserved.
2. **Concurrent existing-sale retries:** hold the original request's advisory
   lock; launch two identical retries and one changed-tracking retry. Identical
   requests return the original sale; the changed one returns REQUEST_CONFLICT.
3. **Concurrent existing-repayment retries:** same pattern for the original 6.00
   cash repayment, with 5.00 as the conflicting amount. No debt is invented.
4. **Timeout/rollback:** hold the existing session row and call a new 0.01
   repayment against the fully settled wholesale sale. Require a genuine database
   timeout while blocked, then verify no records/totals changed and the blocked
   request is no longer active. A client/network timeout never counts as PASS.
5. **Final close race:** hold the session row; start two identical new 10.00 TBC
   retail sale requests, one new zero-debt repayment attempt, and two competing
   close calls (actual cash 121.00). Observe at least two distinct blocked database
   backends, then release the lock. Exactly one close succeeds; the other reports
   SESSION_CLOSED. Either one atomic non-cash sale commits before close and both
   retries return its ID, or both are rejected with OPEN_SESSION_REQUIRED. A
   repayment must fail with OVERPAYMENT_NOT_SUPPORTED or OPEN_SESSION_REQUIRED.
6. **Closed-session enforcement:** new sale/repayment request IDs are rejected;
   another close is rejected. Old successful sale/repayment requests can still
   return their original IDs, intentionally, without adding records.

Concurrency is not inferred solely from Promise.all or request timing. A separate
observer reads `pg_blocking_pids` recursively and records distinct blocked backend
PIDs. If overlapping database waiters are not observed, the test stops without
claiming a concurrency PASS. Locks are released in finally blocks; instrumentation
also has transaction-local timeout guards. No temporary database functions,
triggers, test policies or role changes are installed.

## Important timeout scope

Migration 002's `SET LOCAL lock_timeout='10s'` applies **only to migration
installation**, not later Auth/PostgREST transactions. This script does not change
the cashier role's timeout settings. It records the actual result:

- `55P03`: database lock timeout observed.
- `57014`: database statement timeout observed while waiting on the held lock.
  This proves controlled timeout/rollback, **not** that lock_timeout is configured.
- Neither within 12 seconds: STOP before the close race. Release the lock, await
  the harmless zero-debt rejection, inspect settings, and do not silently adjust
  API timeouts or report success. The script does not automatically resume.

The final output explicitly distinguishes `OBSERVED_55P03` from
`NOT_OBSERVED_STATEMENT_TIMEOUT_57014_INSTEAD`. If a specifically configured runtime
lock_timeout must be certified, the latter is an outstanding coverage limitation,
even if all concurrency/close checks pass. Any such configuration change needs a
separate decision; no migration or role is modified here.

## Expected final state

- Original retail/wholesale sales, items, payments and ledger entries unchanged.
- Customer balance remains 0.00; ledger count remains 4; session count remains 1.
- Sales/items are **2 or 3**, payments **4 or 5**, depending on which side of the
  sale/close race wins. A winning new sale is exactly one 10.00 TBC retail sale,
  labeled `STG-CONCURRENCY-<request UUID>`; it cannot alter cash in the drawer.
- Cash drawer / close expected cash / actual cash all **121.00**, difference **0.00**.
- Original session is closed with a valid close timestamp and the staging close
  note. Its opening balance/identity/history remain unchanged.
- Sale numbers and all financial IDs/request IDs remain unique. Sequence numbers
  need not be contiguous; failed attempts can consume sequence values.

Only the observed race ordering is proven; this does not pretend both possible
commit orderings occurred in one run. A positive-debt repayment/close race is
**not applicable** because the customer is settled. This script tests rejection
of a new zero-debt repayment and concurrent replay of existing repayments instead.
It never introduces debt just to enable a test.

Do not infer commit order from `now()` timestamps alone: PostgreSQL stores the
transaction start time. Lock observations, returned outcomes and stored records
provide the ordering evidence.

If any step fails or a network outcome is unknown, preserve the output and request
IDs and inspect staging. A failed script can have completed the close or committed
the one allowed non-cash sale. Do not rerun blindly. No automatic repair, reset,
deletion, reopen or compensation occurs. Stop after final verification and keep
all staging records and the companion register for review.
