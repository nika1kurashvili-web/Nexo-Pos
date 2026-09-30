# Staging wholesale / debt / repayment smoke test

Prepared for `tclplmbnfnktpthcwqbq` (nexo-staging) only. Nothing has been executed.
Entry point: `scripts/staging-wholesale-debt-smoke.mjs`.

Use the existing POS-only cashier and a separate existing active POS **admin**
account. The admin may be POS-only or explicitly dual-access; an Orders-only admin
is not sufficient. Both sign in through Auth with a staging publishable/anon key.
Service-role keys are rejected. Credentials are hidden and are never logged.

The cashier must still have exactly the first retail test's one sale, one item,
one payment and one open register session, with a derived drawer of 110.00. The
script locates these records and refuses unexpected starting state. Do not run
other scenarios concurrently. Existing data is never deleted/reset or closed.

The first manual step is to launch the script and complete the local configuration
and login prompts. Stop at `CREATE STAGING WHOLESALE CUSTOMER` until instructed.
No test-data mutation occurs before that confirmation (Auth login creates normal
authentication sessions).

Subsequent confirmations in the prepared script authorize:

| Confirmation | Action and expected result |
| --- | --- |
| CREATE STAGING WHOLESALE CUSTOMER | Admin creates `STAGING - WHOLESALE DEBT SMOKE`, with a `STG-WHOLESALE-…` tax code/UUID and test notes. Admin calls `pos_set_customer_prices` for STG-SINGLE at 7.50. Cashier quote must return 7.50, not retail 10.00. |
| TEST MISSING WHOLESALE PRICE | STG-SMALL has no customer price. Cashier quote must report `wholesale_price_missing`; a sale attempt must return `WHOLESALE_PRICE_MISSING` with no financial changes. |
| CREATE PARTIALLY PAID WHOLESALE SALE | Cashier buys two STG-SINGLE units at 7.50, total 15.00, pays 5.00 cash. Ledger +15.00/-5.00, current balance 10.00, drawer 115.00. |
| REPAY 4.00 BY TBC | Cashier calls `pos_record_repayment`. Balance 6.00; drawer stays 115.00. |
| REPAY FINAL 6.00 BY CASH | Cashier calls `pos_record_repayment`. Balance 0.00; drawer becomes 121.00. |
| VERIFY REPAYMENT RETRY AND CONFLICT | Exact cash-repayment retry returns the original payment ID; changing its amount with the same request ID gives `REQUEST_CONFLICT`. Counts, rows and balances must not change. Direct financial INSERT/UPDATE/DELETE remain denied. |

Ledger SELECT and `pos_customer_balance` require POS admin by design. Only the
admin client performs those read-only verifications; the script also verifies
that the cashier cannot access them. Sale/repayment calls always use the cashier
client. Customer insertion is the application's admin/RLS table-write path;
prices use the admin RPC, with no direct price-table writes.

Sale `paid_total=5.00` and `debt_amount=10.00` are **historical completion snapshots**.
They must remain unchanged after repayment. Current debt comes from the ledger /
balance RPC. The test also checks customer/cashier/catalog/payment snapshots,
request IDs/fingerprints, linkage, ledger signs, exact counts, and that previous
records remain byte-for-byte equivalent in JSON readback.

Expected final state: two sales, two items, four payments (retail cash 10.00,
wholesale cash 5.00, TBC repayment 4.00, cash repayment 6.00), four entries in the
new customer's ledger, current customer balance 0.00, drawer 121.00, original
session still open. Financial counts are in the cashier's RLS-visible scope;
ledger counts are scoped to this customer. No global production claims are made.

Direct-write probes use NULL primary-key inserts and `id IS NULL` update/delete
filters. Only SQLSTATE 42501 / HTTP 403 passes. No existing row can be overwritten
or deleted by these probes. If privileges regress, an invalid insert could
consume a sequence value before constraint rejection, but cannot persist a NULL
primary-key row. Sale numbers therefore need not be gapless.

On any STOP/network timeout, preserve the printed customer/request/sale/payment
IDs and inspect staging before retrying. There is no automatic retry, cleanup,
customer reuse or resume. A timeout does not prove an RPC failed to commit.
Stop after the final PASS; no register closing or concurrency test is included.
