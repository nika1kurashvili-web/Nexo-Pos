# Cash withdrawal deployment and review

Prepared locally only. No production/staging operations are performed by tests.

## Migration and deployment

Apply only `supabase/migrations/202610010002_pos_cash_withdrawals.sql`, manually,
after the existing profile, explicit-membership, Phase 1, register visibility,
register last-close, and employee-management migrations. Never replay them.
The new transaction aborts on missing prerequisite signatures/columns or missing
last-close support. Run as the existing register RPC owner, which must have
BYPASSRLS/superuser capability. Existing function owners are preserved.

Recommended sequence:

1. Validate on staging first, including genuine simultaneous requests from
   separate connections. Local PGlite tests cannot demonstrate lock contention.
2. Take the normal database backup/recovery checkpoint and confirm the target
   project manually. Apply only the new migration in SQL Editor.
3. Run `supabase/inspection/cash_withdrawals_post_migration.sql` (read-only).
4. Deploy the matching application changes. No environment variables or keys are
   added. SQL must precede the application: the UI expects cash_withdrawals fields.
5. Check existing balances/history without creating synthetic production data.
   Use staging for cashier/admin withdrawal, duplicate, overdraw and close tests.

## Accounting and history

`pos_cash_withdrawals` is separate from sales, payments and customer debt. It stores
request ID/fingerprint, session/register/actor IDs, positive numeric amount,
trimmed reason, timestamp, and actor/register name snapshots. All FKs use RESTRICT.
No existing financial rows or historical closing values change on installation.

The private `pos_session_cash_totals(uuid)` is the single current-cash formula:

    opening_cash + SUM(all session payments with method_code='cash')
                 - SUM(session cash withdrawals)

Both sale_payment and repayment count. No noncash payment counts. State, report,
withdrawal overdraw validation and close all call this helper. Closed reports use
stored expected_closing_cash, actual_closing_cash and cash_difference, not a
retroactive recalculation. All last-close fields are retained.

New functions: pos_record_cash_withdrawal, pos_session_cash_totals (private),
pos_cash_withdrawals_immutable (trigger). Replaced functions: pos_close_register,
pos_register_state, pos_register_session_report. Existing sale/repayment/open,
membership/provisioning, employee and Orders functions/policies remain unchanged.

## Security and concurrency

Active POS membership is authoritative. pos_require_actor locks the actor profile
against concurrent deactivation. Cashiers AND admins can withdraw only from their
own open session. Admin permission to close another session remains unchanged.

Withdrawal requests take the existing style of transaction advisory lock on the
request UUID and a FOR UPDATE lock on the session. Sales, repayments and close
already take this session lock. After waiting, READ COMMITTED sees committed prior
movements, so two requests cannot both spend the same available cash. Withdrawal
and close explicitly reject other isolation levels rather than read stale sums.
Withdrawals have a 5-second lock timeout; an earlier platform statement timeout
may occur. SQL errors roll back all writes; transport loss can leave the caller
uncertain whether the transaction committed.

The normalized request fingerprint includes actor, session, numeric amount and
trimmed reason. Identical retries return the original ID even after close;
changed payloads/actors return REQUEST_CONFLICT. Active membership is still
required for replay. Fresh requests against closed sessions fail. There is no
automatic retry after an ambiguous result.

The new table has RLS and FORCE RLS: admin reads all, cashier reads only their own
rows, inactive/Orders-only users read none. No direct INSERT/UPDATE/DELETE/TRUNCATE
grants go to authenticated, anon or service_role. Immutable triggers also reject
UPDATE/DELETE/TRUNCATE, including accidental privileged SQL. A database owner can
still disable triggers and must not do so as an application correction workflow.
The private aggregate cannot be called by browser roles. Public entry points are
SECURITY DEFINER with empty search_path, with EXECUTE granted only to authenticated
and explicit internal authorization. No browser service credential is involved.

## UI and limitations

The own-session home card opens a Georgian amount/reason form. Pending submissions
are disabled; a form request UUID is reused for retries. Unknown outcomes keep
fields read-only and display that UUID; inspect history or retry the exact same
request, never start another withdrawal to compensate. Navigating away/reloading
does not persist form state: record the shown request UUID before leaving an
ambiguous operation. No automatic retry or cleanup occurs. Successful actions
revalidate home/report data without a manual reload.

Admin register reports include cash income and withdrawals and link to a session's
latest 200 withdrawal rows, including snapshots and request IDs. Pagination beyond
200 is not implemented; all records remain in the database. Cashier access to
other people's current aggregate balances remains as in existing register state;
other people's detailed financial history is not exposed.

Money uses strict decimal text, positive and <=9999999999.99, at most two decimal
places. Reason is trimmed and 1–500 characters. Future deposits/reversals should
be separate append-only entries linked to originals, then extend the shared cash
helper. They must not rewrite/delete these withdrawals or use negative payments.

## Rollback

Before any withdrawal exists, an explicitly reviewed database rollback is possible;
none is provided/executed automatically. After the first withdrawal, NEVER restore
the old close/state/report formula: doing so overstates cash. If necessary disable
the withdrawal UI/entry-point EXECUTE while retaining the new accounting and all
historical rows. Fix forward. Reverting the entire app/SQL blindly is unsafe.

## Validation

Local SQL tests execute the complete schema sequence in disposable in-memory
PostgreSQL and verify grants, RLS, snapshots, replay/conflict, overdraw, cash versus
card payments/repayments, close/last-close, Orders preservation and immutability.
Queued competing requests exercise both spending outcomes and duplicate handling;
they are NOT independent database connections. Static checks verify session lock
before aggregate, bounded withdrawal lock waits and unique migration version.
Server Action mocks verify authorization before RPC, request preservation, unknown
outcomes and revalidation. Existing POS tests cover retail, wholesale, split,
discounts, debt and repayment. No production data is used by any test.
