# First retail smoke test — nexo-staging only

Prepared, not executed. Do not run migration 002 again. Never target production.

The next manual step is `010_first_retail_register_setup.sql`, in the
**nexo-staging** SQL Editor as `postgres`. It creates or reuses only the active
register named `STAGING - FIRST RETAIL SMOKE`. It refuses an already-open register
and does not update, delete or reset existing records. Keep the returned register
ID and stop after this setup step until ready for the cashier test.

The prepared runtime entry point is `scripts/staging-retail-smoke.mjs`, run with
Node from the repository root when instructed. It reads no environment files and
prompts locally for:

- The project reference copied from **nexo-staging** Dashboard Settings.
- The matching `https://REFERENCE.supabase.co` URL and typed `nexo-staging` confirmation.
- A staging **publishable/anon** key, hidden. Secret/service-role keys are rejected.
- The existing POS-only cashier test email and password, both hidden.

Do not paste credentials into chat or put them in command arguments. Project name
cannot be authenticated from a URL alone: confirm the Dashboard is nexo-staging
when copying the reference/key. The script validates matching reference/URL and
legacy anon JWT reference; all table/RPC requests use the real signed-in cashier
session, never an administrator token or SQL role impersonation.

The script stops unless this account is an active cashier with explicit POS-only
app metadata, no visible own Orders profile, and no existing open cashier session.
It requires the exact bootstrap product `STG-SINGLE`, ID
`11111111-1111-4111-8111-111111111111`, name `STAGING standalone item`, price **10.00**.
The no-Orders-profile check relies on the previously verified staging policy
allowing a user to read their own Orders profile if one exists.

It then asks for two separate confirmations:

1. `OPEN STAGING REGISTER`: calls `pos_open_register(p_register, p_cash)` with 100.00.
2. `CREATE ONE STAGING RETAIL SALE`: calls `pos_complete_sale` once, quantity 1,
   no price override, no discount, no customer, and one cash payment of 10.00.

The unique request ID and `STG-RETAIL-…` tracking code are printed before the sale
call. Whitespace is deliberately supplied around tracking to verify trimming.
Sale/session IDs are printed as soon as returned. Nothing retries automatically.
If a request fails or times out, preserve these IDs and inspect staging before
retrying; a timeout does not prove the write failed. Cancelling after opening
leaves that session open.

Readback verifies one completed retail sale, a positive generated sale number
(not necessarily 1), ownership and cashier name, product/SKU/price snapshots,
one item, one cash payment and its method snapshot, trimmed tracking, subtotal /
total / paid = 10.00, discount / debt = 0.00, and the still-open session. Derived
cash drawer total is 110.00; closing fields remain NULL because closing is not
part of this test.

Finally, under the same cashier JWT, it probes INSERT/UPDATE/DELETE on sessions,
sales, sale items, payments and customer transactions. Only HTTP 403 with SQLSTATE
42501 passes. UPDATE/DELETE target `id IS NULL`, which cannot match primary-key
rows. INSERT supplies a NULL primary key, so even an unexpected permission change
cannot persist that row. Constraint failures and zero-row successes are not
accepted as permission denials. If permissions are unexpectedly permissive, an
attempted sales insert could consume an identity number before failing; gaps are
not evidence of an extra sale. No cleanup is attempted.

A final PASS is runtime evidence for this first retail scenario only. Preserve
the output (it contains IDs and results, not credentials). Stop afterward: the
register stays open and the test records remain. This script does not close the
register or test wholesale debt, repayment, retries/idempotency, or concurrency.
