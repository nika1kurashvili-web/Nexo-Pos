# POS navigation performance

## Authorization boundary

Before this change, middleware and the request-cached server guard each ran
`getUser()` followed by a live `pos_profiles` SELECT. React `cache()` cannot share
results between middleware and the Server Component render.

Protected navigation now uses middleware `getClaims()` for token verification and
SSR session refresh. It does not query memberships. The unchanged server guard
still calls `getUser()` and checks the current database row (matching user ID,
active=true, role admin/cashier). `requireAdmin()` still checks that row's role.
All existing financial actions use the guard through `posClient()`; administrative
actions also use `requireAdmin()`. RLS and RPC actor checks are unchanged.

`/login` deliberately retains the full membership check for existing-session
routing. A revoked member is rejected by the protected server guard, redirected
to login, and has their POS session cleared by login middleware. One subsequent
login response displays the error without redirecting again. The first protected
response cannot clear cookies from a read-only Server Component. No protected
data or action is authorized during this redirect sequence.

Future protected routes/actions must keep the server guard: middleware claims
alone never authorize POS access. No membership result is cached across requests.

Installed versions inspected: @supabase/ssr 0.12.7, supabase-js/auth-js 2.117.2.
With asymmetric signing, getClaims verifies against cached JWKS (initial JWKS
retrieval and refresh can still require network). Legacy symmetric signing falls
back to an Auth request. This change does not require rotating project keys and
does not assume which signing configuration production uses.

Reference: https://supabase.com/docs/guides/auth/server-side/creating-a-client

## Evidence and limits

Local HTTP integration tests run real Next middleware, SSR and Server Actions
against an in-process fake Supabase service. They copy only application source
and explicit config files to a temporary directory; no .env, repository .next,
inherited Supabase credentials, or service-role key is used. The application uses
its installed dependencies via a junction. This avoids touching a running local
development server's build output. These tests use Next dev, not a production
build; temporary test copies are retained in the OS temp directory.

The protected home and new-sale render tests observe exactly **one** POS profile
query, including calls from the layout, page and posClient. The previous code had
two independent lookups. An ES256 fixture observes one Auth user request (the
authoritative guard), while HS256 fixtures exercise the fallback path. Cookie
refresh, forged sessions, missing/inactive/Orders-only memberships, login/logout,
admin restrictions and deactivated/unauthenticated financial actions are tested.

No production latency or production row volume was measured. Test compilation
times and loopback HTTP durations are not production performance measurements.
Production build is deferred while the user's dev server is running.

## New-sale loader

All six queries already run in parallel; query shape, limits, error behavior,
catalog mapping and terminal props remain unchanged:

| Query | Selected data | Requested limit |
| --- | --- | --- |
| Current session | id, filtered to current cashier/open | 1 |
| Products | id, name, SKU, price, active | API maximum |
| Variants | id, product id, name, SKU, price, active | API maximum |
| Payment methods | code, name | API maximum |
| Customers | id, name, tax code | 500 |
| Customer prices | customer id, product/variant id, price | 10,000 |

The API's configured row cap can be smaller than a requested limit. The broad
price query is not pagination and cannot guarantee a complete large price list.
Sending every customer's prices increases database work, response/React payload,
and browser lookup cost even for retail sales. Catalog queries also lack pagination.
These pre-existing scaling limitations are not changed here.

For an optional read-only manual measurement, stop the existing dev server first,
then in PowerShell start one dev server with:

```powershell
$env:POS_PERF_DIAGNOSTICS = '1'
corepack pnpm dev
```

Visit `/sales/new` with an existing authorized account without submitting a sale.
`[nexo-pos-perf]` prints only fixed query labels, durationMs, returned row counts,
decoded JSON byte counts and a failure boolean. JSON bytes exclude HTTP compression
and React serialization. Concurrent query durations overlap: do not add them to
estimate page time. No result values, identifiers or raw errors are logged.
Metrics are disabled by default and always disabled outside NODE_ENV=development.
After stopping that dev server, remove the flag with:

```powershell
Remove-Item Env:POS_PERF_DIAGNOSTICS
```

No Supabase or Vercel configuration change is required. Do not run build alongside
dev; after stopping dev, run typecheck/lint/build normally before deployment.

## Separate follow-up and rollback

Recommend a separate customer-price phase: an authenticated server endpoint that
loads exact prices for the selected customer and selected/searchable SKUs, with
pagination, race/stale-selection handling and explicit missing-price states.
Retain no-retail-fallback behavior and authoritative RPC price validation. Avoid a
global membership or price cache that outlives authorization/price updates.

Remaining latency includes the intentional getUser + membership query, six
new-sale data queries, production network distance, cold JWKS/refresh requests,
development compilation, and large catalog/customer-price payloads. No fixed
millisecond improvement is claimed.

Rollback is application-only: restore the previous middleware full getPosAccess
branch and remove the optional query metrics wrappers/helper. No database rollback
or migration is needed. Revert only this performance diff, preserving unrelated
work. The old path restores redundant checks rather than changing permissions.
