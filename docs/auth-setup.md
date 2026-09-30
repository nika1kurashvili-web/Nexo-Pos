# POS authentication setup

## Phase 2A application behavior

The home page is an account dashboard showing Nexo POS, the authenticated user's
full name, Georgian role label plus `admin`/`cashier`, and a logout action in the
header. Register/cart/sales controls are not part of this home page. Previously
existing Phase 1 routes remain server-protected but are not linked in this shell.

Login uses the existing Server Action, not a browser password request. The
pending submit button is disabled. Middleware refreshes SSR cookies, verifies
identity with `getUser()`, then queries only `public.pos_profiles` by verified
user ID. The page guard repeats authorization server-side. Orders `profiles`,
Orders roles, and Auth metadata never grant POS membership. Missing, inactive or
invalid-role membership signs out and displays:
`ამ მომხმარებელს POS სისტემაზე წვდომა არ აქვს.`

The two existing public environment variables are unchanged. Configuration
validation rejects malformed base URLs, secret keys and legacy JWT keys whose
role is not `anon`. Do not place any secret in a `NEXT_PUBLIC_*` variable: Next.js
may embed public variables during build, before runtime validation can help.

No SQL, migration, provisioning, or shared Orders security changes are required
by Phase 2A. Existing database setup/provisioning information below is background,
not an instruction to rerun migrations. For manual verification, use existing
staging POS admin/cashier accounts and an Orders-only account; check login,
denial, refresh and logout before deploying the application through your normal
release process. Do not change the shared Auth Site URL for this password flow.

## Apply the migration

Review and run `supabase/migrations/202609260001_create_pos_profiles.sql` once
in the **shared project's Supabase SQL Editor as the database owner**. The app
does not apply migrations automatically.

The transaction creates:

- `public.pos_profiles`, referencing `auth.users.id`, with a nonblank full name,
  role, active flag, and creation/update timestamps.
- A role CHECK allowing only `admin` and `cashier`.
- `pos_profiles_select_own`, a SELECT policy for authenticated users using
  `(select auth.uid()) = id`.
- `pos_profiles_set_updated_at()` and the `pos_profiles_updated_at` trigger.

RLS is enabled and forced. Default privileges for public, anon, and authenticated
are revoked, then only SELECT is granted to authenticated. Users may read their
own inactive row so the app can explain the denial. There are no browser write
permissions, no role self-promotion, and no admin-readable employee list.
Administration is manual through the trusted Supabase dashboard/SQL Editor.

The migration does not modify `profiles`, `orders`, `order_items`, `products`,
`product_variants`, their policies, or existing Auth triggers. No catalog schema
is assumed or queried in this version.

## First POS admin and future employees

Do not use the former dashboard-create-plus-POS-insert recipe: the legacy shared
Auth trigger grants an active Orders profile to every new Auth user.
Review [explicit application membership and provisioning](user-provisioning.md).
After profile migration 001, deploy the separate shared-Auth prerequisite before
creating further POS accounts; financial migration 002 remains on hold.

Use the trusted provisioning command with explicit POS admin/cashier membership.
Orders employees use the same command with explicit Orders access. Dual access
must be requested deliberately. Existing accounts/profiles are not migrated or
cleaned up automatically. No new web/Vercel runtime secret is required.

## Security behavior

- Email/password login runs in a Next.js Server Action with the framework's
  same-origin submission checks. Passwords and tokens are not logged.
- `@supabase/ssr` manages sessions. `middleware.ts` is the supported Next.js 15
  filename; `proxy.ts` is for Next.js 16.
- Middleware calls `auth.getUser()` to verify identity with Supabase and refresh
  cookies. Access then requires that UUID's active `pos_profiles` row and a
  recognized role. Cookie payloads and user metadata alone never authorize users.
- The shell and every protected page independently call a server authorization
  guard. React cache deduplicates within a render, never across requests. Future
  data loaders and Server Actions must call the appropriate guard too.
- Missing, inactive, invalid-role, and unreadable profiles fail closed. Rejected
  logins sign out and clear POS cookies. Subsequent server requests recheck the
  profile, so deactivation blocks an existing session on its next request.
- `/` and `/sales` allow active admins/cashiers. `/reports` and `/employees`
  require admin server-side; direct cashier visits redirect to `/`.
- The `nexo-pos-auth` cookie has no Domain attribute, so it remains host-only.
  It uses SameSite=Lax and Secure in production. Personalized responses are
  marked `private, no-store`.
- Logout uses `scope: "local"` and clears POS cookies even when remote logout
  fails. It does not globally revoke the user's other Supabase sessions.
  Already-issued access tokens retain their normal lifetime; disabling the POS
  profile blocks subsequent POS application requests.

This migration secures only `pos_profiles`. Existing catalog and order RLS keeps
its existing behavior. Future POS data features require their own RLS review;
application route protection does not change another table's API permissions.

## Deployment and local configuration

Use only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` for the
same Supabase project as orders. They are already configured in Vercel according
to the project setup; confirm that they apply to the intended deployment
environment. Local development uses `.env.local` copied from `.env.example`.
Missing configuration shows a Georgian message and blocks login.

After applying the migration and provisioning the admin, deploy/redeploy the
POS Vercel project from this repository root. No additional variables are needed.
Do not change the shared Auth Site URL, the orders deployment, or existing
policies for this password-only flow. No email callback flow is implemented.

## Automated verification

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

`pnpm test` requires a production build. Node's built-in test runner starts a
local Next.js production server and an isolated Supabase HTTP substitute. Tests
exercise real redirects, Server Action form submissions, and cookies for:
unauthenticated access, admin/cashier login and role rendering, admin-only routes,
missing/inactive/invalid profiles, invalid credentials, deactivation, failed
profile queries, logout (including remote failure), and forged cookies.

Use a build made without real `NEXT_PUBLIC_SUPABASE_*` values for these tests;
Next.js may inline public values at build time. The test process supplies local
dummy values. No real users are created and no SQL is applied. These tests
verify application behavior, not live database RLS or Supabase configuration.

## Live verification after applying SQL

1. Confirm a logged-out visitor is redirected to `/login`.
2. Sign in as active admin and cashier and check names, Georgian roles, and links.
3. Sign in as an Auth-only/order-management user without a POS row: access must
   be denied and the session cleared.
4. Check inactive-user denial, then disable an already logged-in POS account and
   verify its next server request is denied.
5. Confirm cashier direct visits to `/reports` and `/employees` are denied.
6. Using each user's JWT and the anon key, verify Data API SELECT returns only
   that user's `pos_profiles` row; selecting another UUID returns no row, and
   INSERT/UPDATE/DELETE are denied. An ordinary SQL Editor SELECT runs with
   elevated privileges and does not verify user RLS.
7. Confirm POS logout redirects to login and leaves an independently signed-in
   orders session intact.

References: [Supabase SSR](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs),
[sign-out scopes](https://supabase.com/docs/reference/javascript/auth-signout),
[Next.js authorization](https://nextjs.org/docs/app/guides/authentication).

## Diagnosing a production login failure

Login submits a Server Action from `app/login/page.tsx` to
`app/login/actions.ts`; it does not use the browser Supabase client. The
`unavailable` message is deliberately generic. It can mean a password Auth API
error other than status 400/422, an exception during sign-in, or a profile SELECT
error/exception after successful Auth. Middleware and the server guard can also
redirect to the same message when their profile checks fail. A missing row and
an inactive row have the same access-denied message; neither is a connection error.

These failures were previously handled without logging and converted to an
ordinary redirect, so there need not be a failed invocation or visible exception
in Vercel. Redirects in the action are outside the catch block and are not
misclassified as connection errors.

After deploying diagnostics, reproduce once and filter **Vercel runtime logs**
for `[nexo-pos-auth]` at that time. Include info-level logs and middleware logs,
not just build output or HTTP 500 requests. Each entry identifies `source`,
`attemptId`, `step`, and `outcome`. Entries within a login action share an
attempt ID; middleware and guard invocations have their own IDs.

| Step / signal | What to inspect next |
| --- | --- |
| `middleware` / `login.request` only, no `login` entries | The POST reached middleware; inspect any middleware failure and the Server Action request/response before assuming Supabase Auth ran. |
| `configuration` | Presence and format flags for exactly `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`; values are never printed. `jwt` identifies syntax only, not whether it is the correct project's anon key. |
| `client.create` | Client initialization failure, such as a malformed URL. The URL must be the project's base HTTP(S) URL, not a dashboard or REST API path. |
| `signInWithPassword` failed | Auth endpoint rejected or could not process login. `401` / `invalid_api_key` means check that the configured public key belongs to the configured project; `429` means rate limiting. Other codes identify the Auth rejection. |
| `getUser` failed | Server-side verification of the new or existing session failed. |
| `pos_profiles.select` failed | Auth may have succeeded; this is a Data API/schema/permission issue, not proof of a network outage. `42501` indicates insufficient privilege, `PGRST205` a missing table in the schema cache, and `42703` an undefined column. Inspect the target project and migration before changing policies. |
| `cookies.write` failed | The action could not persist the session. Cookie write errors are no longer silently ignored in Server Actions; read-only Server Components still defer cookie writes to middleware. |
| `login.result` success, followed by another failure | Inspect the subsequent middleware/guard entry and cookie persistence on the redirected request. |

Safe error diagnostics include known error types, codes, numeric statuses, and
network/cookie/URL classifications. They omit raw upstream messages, details,
hints, stacks, URLs, emails, UUIDs, passwords, cookie values, tokens, and keys.
Share the structured diagnostic entries, never request bodies or cookies.

No production root cause is established solely by the generic message. Do not
change Vercel variables, Supabase users, or RLS until the failing step is known.
