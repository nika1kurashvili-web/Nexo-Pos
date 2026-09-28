# Phase 1: POS domain and operations

## Deployment — manual only

**New prerequisite:** after profile migration 001 and before this financial
migration, review the [explicit membership provisioning fix](user-provisioning.md).
The legacy Auth trigger otherwise creates active Orders operators for POS accounts.
Neither the prerequisite nor migration 002 has been applied by this task.

Migration: `supabase/migrations/202609260002_pos_phase1.sql`.

The migration has NOT been applied to Supabase. It was executed only in disposable
in-memory PostgreSQL tests with a synthetic catalog and test users. Review and run
it manually only after the remaining production inspection and staging checks below,
in the shared project's SQL Editor as a BYPASSRLS/superuser owner, after the
already-applied `202609260001_create_pos_profiles.sql`. Do not re-run or edit that
earlier migration. Back up the shared database through your normal process first.

The new migration is transactional and checks required catalog columns, existing
authenticated SELECT grants, the existing variants SELECT-true policy, and the
absence of restrictive SELECT policies. Unexpected access rules cause the entire
migration to abort for review; it never replaces them. It derives the actual
product/variant ID types using `CREATE TABLE AS ... WITH NO DATA`, then adds real
foreign keys. It does not assume UUID IDs. Tests exercise bigint products and
text variants. The supplied live JSON was not available locally; these runtime
checks complement the catalog access rules explicitly approved by the user.

Only this approved policy is added to an existing table:

```sql
create policy pos_active_users_select_products
on public.products
as permissive
for select
to authenticated
using (
  exists (
    select 1
    from public.pos_profiles pp
    where pp.id = (select auth.uid())
      and pp.active = true
  )
);
```

Conclusion: this gives POS-only active users a separate SELECT path to products.
Their access does not depend on old `profiles` or `is_active_user()`. Variants use
the existing authenticated SELECT-true policy. No variants policy is added, no
catalog write grant is added, and no existing policy/helper is edited. Existing
order-system users retain their existing access. The broad existing variants
policy also still applies to non-POS authenticated users; POS endpoints separately
require active POS authorization.

After migration:

1. Sign in as POS admin; add a register at `/registers`.
2. Review/activate payment methods at `/payment-methods`.
3. Add business customers at `/customers`, then enter customer prices by SKU.
4. As cashier, open and close a session at `/` and verify the resulting counts.
5. Deploy the application using the existing public Supabase variables. No new
   runtime secrets or service-role key is needed.
6. Verify production/staging RLS with both a POS-only cashier and an orders-only
   user. Run real concurrent sale/close and repayment smoke tests in staging.

## Tables (9)

| Table | Purpose |
| --- | --- |
| `pos_business_customers` | Company/name, unique optional tax code, phone/address/email/notes, active flag, timestamps. Deactivate instead of deleting. |
| `pos_customer_prices` | One current price per customer/base product OR variant. XOR target constraint, partial unique indexes, nonnegative numeric price. Catalog deletion removes current prices only. |
| `pos_registers` | Named active/inactive registers. |
| `pos_register_sessions` | Cashier, register, opening cash/time, close time, expected/actual cash, variance and closing note. |
| `pos_payment_methods` | Stable codes `cash`, `tbc`, `bog`, `liberty`, `onway`, `other`; Georgian names and activation. Admin can update names/activation, not codes. |
| `pos_sales` | Unique identity sale number, idempotency UUID, cashier/customer snapshots, session, type, tracking, original totals and completed status. |
| `pos_sale_items` | Stable item ID/line number, nullable real catalog FKs, target kind, SKU/name snapshots, base/adjusted/final prices, quantity, discount and line total. |
| `pos_payments` | Individual positive payment transactions with method/name snapshot, collecting cashier/session, sale, kind, idempotency UUID and timestamp. |
| `pos_customer_transactions` | Append-only customer ledger: sale charge and linked payment/repayment credits. Unique payment linkage prevents double ledger posting. |

Historical customer/register/profile references use RESTRICT. Catalog references
in sale items use SET NULL; names, SKU, kind and prices remain intact. Financial
history survives catalog deletion. A profile tied to financial history cannot be
deleted through Auth cascade; deactivate it instead. No client role has DELETE
privileges on these POS tables.

## Functions (12)

All privileged RPCs use a fixed empty search path and qualified names. They take
the actor from `auth.uid()`, never a browser-supplied cashier ID. Default PUBLIC
execute is revoked. Active POS membership is checked inside every entry point.

| Function | Access / purpose |
| --- | --- |
| `pos_role()` | Authenticated; current active POS role for policies. |
| `pos_require_actor(p_admin)` | Internal only; locks the active profile and checks role. |
| `pos_normalize_sale_request(actor, session, type, customer, tracking, items, payments)` | Internal SECURITY INVOKER helper; canonicalizes request intent without reading mutable catalog data. |
| `pos_decimal(value, scale, positive)` | Internal only; validates finite unsigned decimal input, precision and bounds. |
| `pos_open_register(register, cash)` | Active POS; opens the actor's session. |
| `pos_close_register(session, actual, note)` | Session owner or admin; locks session, calculates cash, closes once. |
| `pos_quote(kind, target, type, customer)` | Active POS; validates active catalog/customer and returns authoritative pricing/snapshot fields or `wholesale_price_missing`. |
| `pos_set_customer_prices(customer, rows)` | Admin only; atomic upsert by real catalog targets, rejects duplicate targets. |
| `pos_import_customer_prices(customer, rows)` | Admin only; re-matches SKU against active products/variants, rejects ambiguity/duplicates/missing rows, atomically delegates updates. |
| `pos_complete_sale(request, session, type, customer, tracking, items, payments)` | Active POS; atomic sale, snapshots, payments and ledger. |
| `pos_record_repayment(request, sale, session, method, amount)` | Active POS; locks sale, validates remaining debt, adds a new payment and ledger credit. Cashiers collect on their own sales; admins can collect on any sale using their own open session. |
| `pos_customer_balance(customer)` | Admin only; sums all ledger entries, not a truncated page of results. |

`pos_require_actor`, `pos_decimal` and `pos_normalize_sale_request` are not callable by anon/authenticated roles.
Four new update triggers on customers, prices, registers and payment methods reuse
the existing `pos_profiles_set_updated_at()` function without changing it.

## RLS policies (15)

All nine new tables have RLS enabled and forced. Table SELECT is granted to
authenticated, filtered by these policies:

| Policy | Table and effect |
| --- | --- |
| `pos_active_users_select_products` | Shared products: approved active-POS SELECT path only. |
| `pos_customers_read` | Admin sees all; cashier sees active customers. |
| `pos_prices_read` | Admin sees all; cashier sees prices for active customers. |
| `pos_registers_read` | Admin sees all; cashier sees active registers. |
| `pos_methods_read` | Admin sees all; cashier sees active methods. |
| `pos_sessions_read` | Admin sees all; cashier sees own session history. |
| `pos_sales_read` | Admin sees all; cashier sees own sales. |
| `pos_items_read` | Items only for a sale the caller can read. |
| `pos_payments_read` | Admin sees all; cashier sees payments they collected. |
| `pos_transactions_admin_read` | Full customer ledger is admin-only. |
| `pos_customers_admin_insert` | Admin-only customer insertion. |
| `pos_customers_admin_update` | Admin-only customer changes/deactivation. |
| `pos_registers_admin_insert` | Admin-only register insertion. |
| `pos_registers_admin_update` | Admin-only register changes/deactivation. |
| `pos_methods_admin_update` | Admin-only name/activation update; column grants prevent code edits. |

Direct financial/price/session INSERT/UPDATE/DELETE grants are absent, including
for admin. The SECURITY DEFINER RPCs are the sole application write path. They
explicitly enforce ownership/roles and transaction rules; they do not grant
general table-write access. Ledger/sales/payments are immutable through the app
and authenticated API, not immutable against the trusted database owner.
No service-role key is used. Inactive and orders-only users fail POS RLS/RPCs.

## Registers, price selection and accounting

- Partial unique indexes enforce one open session per register AND per cashier.
  Sales/repayments lock the same session row as closing, preventing a payment
  from being added after the close calculation. Closed sessions stay historical.
- Expected cash = opening cash + every `cash` payment collected in that session,
  including later debt repayments. Banks/OnWay/other never affect physical cash.
  Difference = actual minus expected. A disabled register cannot be newly opened;
  its already-open session can still operate and close.
- Retail uses current catalog price. Wholesale requires an active customer and
  its exact product/variant price. There is no fallback from variant to base
  product, or from wholesale to retail. Missing wholesale prices return a typed
  state from quote and abort sale completion even if a manual price is supplied.
- The database loads the base price and labels again at completion. It records
  base price plus a separately supplied adjusted price (defaulting to base),
  quantity, discount, rounded final unit price and rounded line total. Browser
  totals, names and SKU are ignored. Phase 2 must refresh/confirm changed quotes.
- Currency is GEL, two-decimal prices/payments. Quantities allow three decimals;
  discount allows two decimals from 0 through 100. RPC decimal input must be a
  plain unsigned decimal, at most 9,999,999,999.99; excess precision is rejected.
  Storage is PostgreSQL numeric, never floating-point accounting.
- Rounding: final unit price = round(adjusted × (1 − discount/100), 2);
  line total = round(final unit × quantity, 2). Subtotal is the sum of rounded
  adjusted-price lines; discount total = subtotal − total. Manual price changes
  are separately auditable through base versus adjusted, not counted as discounts.
- Split payment rows can use any active method. Zero input payments are accepted
  but omitted from financial records. Negative amounts and overpayment are
  rejected. Change handling is intentionally not implemented. Retail requires
  full payment; wholesale permits zero, partial or full payment.
- Sale numbers are database identity values, unique under concurrent writes;
  gaps after rollback are normal. Request UUIDs serialize retries and return the
  original sale/payment. Never reuse an idempotency UUID for a different intent.

## Debt and future returns

A wholesale sale posts `+total` as `sale_charge`, then negative `sale_payment`
entries for immediate payments. Later `repayment` entries are separate negative
transactions linked to new `pos_payments`. Sale `paid_total`/`debt_amount` remain
the original values. Current sale debt is SUM(ledger.amount) for that sale;
current customer balance is the sum for that customer. Sale-row locking prevents
concurrent repayments from exceeding debt. Customer deactivation blocks new
sales/prices but does not erase or prevent collection of existing debt.

Returns are not implemented. Future return/return-item/refund records should
reference the original sale, immutable item IDs and payments and post compensating
ledger entries. Never rewrite original quantities/payments to represent returns.
Phase 2 will need explicit return caps, refund method/session rules and new RPCs.

## Excel foundation and RPC payloads

No XLSX dependency was present, so none was added. `lib/pos/import-prices.ts`
accepts decoded worksheet rows (header removed) and catalog targets. It preserves
text SKUs/leading zeros and emits `found`, `not_found`, `invalid`, or `conflict`.
Duplicate worksheet SKUs and duplicate matches across both catalogs are blocked.
Price parsing uses decimal strings. Confirmation requires every row resolved.
The future .xlsx adapter must validate the two-column header (`SKU/barcode`,
`wholesale price`), file/sheet sizes and decode SKU cells as text using a reviewed
XLSX library. There is no upload UI/file decoding yet.

Manual price entry already uses the same atomic SKU confirmation RPC:

```json
{"p_customer":"CUSTOMER_UUID","p_rows":[{"sku":"001234","price":"80.00"}]}
```

Sale completion contract (available as a typed Supabase RPC, no cart UI yet):

```json
{
  "p_request":"NEW_REQUEST_UUID",
  "p_session":"OPEN_SESSION_UUID",
  "p_type":"wholesale",
  "p_customer":"CUSTOMER_UUID",
  "p_tracking":"OPTIONAL_TRACKING_CODE",
  "p_items":[{"kind":"product","target":"CATALOG_ID_AS_TEXT","quantity":"2","unit_price":"80.00","discount_percent":"5"}],
  "p_payments":[{"method":"cash","amount":"50.00"},{"method":"tbc","amount":"25.00"}]
}
```

`kind` is `product` or `variant`. Omit `unit_price` to use the authoritative
selected price, and `discount_percent` to use zero. Retail uses `p_customer:null`.
`p_tracking` may be null. No OnWay network integration exists.

## UI and Phase 2

- Admin: business customer list/create/edit/deactivate; customer pricing by SKU
  and ledger/balance; register setup; payment-method activation.
- Cashier/admin: own register open/close/history and a recent sales list. All
  actions repeat server authorization, and database authorization is independent.
- Lists are bounded (customers/prices/registers 200, sales 100, ledger 50, own
  sessions 10). Add search/pagination before operating beyond these sizes.
- Phase 2: product search/barcode cart, quote refresh, final sale/repayment UI,
  Excel upload/preview/confirmation UI, printing, returns/refunds, and reports.

## Tests and limits

Run `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`.
`@electric-sql/pglite` is a development-only PostgreSQL engine used for isolated
database/RLS tests; it is not imported by the application. Auth/UI integration
tests run the production Next.js server against a local Supabase substitute.

Coverage includes roles/inactive users, catalog additive policy and actual FK
types, own-row access, customer prices/SKU conflicts, missing wholesale price,
register uniqueness, price/quantity/discount validation, fractional rounding,
split/full/partial/zero payments, debt/repayment limits, idempotency, tracking,
cash-only drawer totals and snapshots surviving catalog deletion. The tests do
not connect to production or prove its current schema/policies; staging testing
of the actual project and simultaneous connections remains a deployment step.

## Before-apply safety fixes (2026-09-28)

**NOT SAFE TO APPLY yet:** local fixes pass, but current production catalog write
isolation has not been proved. Run only
`supabase/inspection/phase1_write_isolation_preflight.sql` next and review every
result set. Confirm the Dashboard API exposed schemas separately. The inspection
selects metadata, not business rows. Legacy function definitions might contain
hardcoded secrets; redact any such values before sharing the output.

### Request identity

Sales persist a required SHA-256 `request_fingerprint`; repayment payment rows
persist their own required fingerprint (immediate sale-payment rows use NULL).
Hashing uses PostgreSQL built-ins; no extension or runtime dependency was added.
The unique UUID and transaction advisory lock serialize retries. A matching
fingerprint returns the original ID before consulting session state or mutable
prices. A changed valid request raises `REQUEST_CONFLICT` without posting records.
Malformed inputs still fail input validation. Active actor authorization always
runs first, including on retries.

The versioned sale intent includes actor, session (which fixes the register),
type, customer, trimmed/empty-to-NULL tracking, ordered receipt items and payment
rows. Each item includes typed catalog target, quantity, optional manual price
and discount. Numbers and numeric strings are canonicalized, as are actual
catalog ID types; omitted/null override and omitted/null zero discount normalize
consistently. Untrusted display fields/totals are ignored. Explicit price override
is a distinct intent from using the catalog price, even when prices coincide.
Item order remains significant because it defines receipt line numbers; payment
order is sorted. Separate/zero payment entries are retained in request identity
because method selection and individual splits are part of the submitted intent.
Repayment intent includes actor, sale (which fixes its customer), session, method
and amount. Its UUID is the external request key; no other reference input exists.

### Added indexes (11)

| Index | Reason |
| --- | --- |
| pos_prices_product_fk | Product deletion cascades current customer prices; existing customer-leading uniqueness cannot serve this direction. |
| pos_prices_variant_fk | Same for variant deletion. |
| pos_prices_customer_fk | All prices/customer and customer FK checks; existing partial indexes each omit one target category. |
| pos_sessions_register_fk | Register FK checks across open and closed history. |
| pos_sessions_cashier_history | Cashier history and profile FK checks, including closed sessions. |
| pos_sales_cashier_history | Cashier sale listing and historical actor FK checks. |
| pos_items_product_fk | Product deletion SET NULL lookup while retaining snapshots. |
| pos_items_variant_fk | Variant deletion SET NULL lookup while retaining snapshots. |
| pos_payments_actor_history | Collector history and actor FK checks. |
| pos_payments_method_fk | Payment-method FK checks; existing session-leading drawer index is insufficient. |
| pos_ledger_sale | Full sale debt summation and sale FK checks; partial charge-only uniqueness excludes credits. |

Existing sale/item, payment/sale, payment/session, sale/customer, sale/session,
ledger/customer and unique ledger/payment indexes already cover those directions.
Nullable catalog FK indexes omit NULL entries. No existing indexes are removed.

### Deployment owner, locks and shared catalog

The migration remains a single transaction with `SET LOCAL lock_timeout = '10s'`.
A blocked lock acquisition fails and rolls back rather than waiting indefinitely;
this is a per-lock timeout, not a total migration duration limit. If the SQL Editor
leaves an aborted transaction open, issue ROLLBACK before retrying in a quiet window.

The first preflight rejects a creator without superuser or BYPASSRLS. An ordinary
table owner alone cannot bypass FORCE RLS and is insufficient. A SQL Editor role
with BYPASSRLS/superuser is sufficient for this model and owns the new functions.
Do not later transfer them to a non-bypass owner without redesigning authorization.
All privileged functions have empty search_path and schema-qualified application
objects. PostgreSQL built-ins resolve through pg_catalog. PUBLIC/anon execute is
revoked; authenticated gets only the deliberate entry points. Financial writes
remain definer-only and enforce actor/session/role rules inside the functions.

Repository evidence: the adjacent orders migration
`202609250001_delivery_manager_permissions.sql` installs restrictive catalog
INSERT/UPDATE/DELETE policies requiring nexo_active_role() in admin/operator.
That helper reads active OLD profiles; a POS-only user returns NULL and fails
those policies. The adjacent purchase-price migration exposes
nexo_create_catalog_item as SECURITY INVOKER with an is_admin() guard, so it must
also satisfy table grants/RLS. The actual production helper definitions, installed
policies, grants, other RPCs and writable views are not available locally. Do not
assume these repository migrations describe the entire live database.

The POS migration adds no catalog mutation grant or mutation RPC and changes no
existing function, policy, grant or RLS setting. Its only explicit existing-table
policy change is the approved permissive products SELECT policy. No variants
policy is added. New catalog FKs do add referential-integrity triggers/locking and
work during catalog deletion (CASCADE current prices; SET NULL sale references).
The SELECT policy is project-wide, and existing UPDATE policies can depend on
SELECT visibility; without the live write rules we cannot guarantee orders.nexo.ge
behavior is entirely unchanged. The read-only inspection covers table/column
privileges, roles, all policies, non-system routines, views, triggers and rules.

### Concurrency and retention

Partial unique indexes arbitrate conflicting opens for both register and cashier.
Sale, repayment and close lock the same session row FOR UPDATE. Finance first:
close includes committed cash; close first: new finance fails OPEN_SESSION_REQUIRED.
Repayments additionally lock the sale before calculating remaining ledger debt.
Advisory locks plus unique request IDs and fingerprints prevent duplicate effects.
At stricter isolation a serialization failure can require a retry with the same UUID.

Local tests submit duplicate sales, repayments and conflicting opens with
Promise.all/Promise.allSettled, and exercise finance-before-close and close-before-
finance outcomes. PGlite queues transactions on one connection: these tests do NOT
simulate actual simultaneous sessions or lock waits. Before production, verify
these six race scenarios with two independent connections on a staging clone.

Accepted retention policy: after any historical register/financial activity,
physical Auth-user deletion is not supported. Auth cascade encounters RESTRICT
historical profile references and fails atomically. Set pos_profiles.active=false
for former employees; preserve the Auth/profile/history rows. Tests verify denial
of hard deletion, successful deactivation, blocked POS operations and intact sales.

Remaining findings: no known unresolved critical/high code finding. Medium
verification gaps are the live catalog authorization baseline and real multi-
connection contention. Next step is read-only production inspection and review,
then staging concurrency verification; do not apply this migration yet.

Final local verification: 39/39 tests passed, including 15/15 isolated database
tests (also run separately). TypeScript, ESLint and the Next.js 15.5.26 production
build passed. Diff whitespace checks passed; migration 001 is unchanged. Node
emits an existing non-failing module-type warning in direct TypeScript test imports.
No production database was contacted, no migration applied, no commit or push made.
