# POS authentication setup

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

## First POS admin

1. In **Supabase → Authentication → Users**, create the intended user with an
   email and a strong password. Ensure the email is confirmed for password login
   (use the dashboard's auto-confirm option if offered).
2. Copy that Auth user's UUID.
3. Replace both placeholders and run this SQL in the SQL Editor:

```sql
insert into public.pos_profiles (id, full_name, role, active)
values ('AUTH_USER_UUID'::uuid, 'ADMIN_FULL_NAME', 'admin', true);
```

For a cashier, use `cashier` instead of `admin`. If an email already exists in
shared Auth, use its existing UUID; do not reset its password or create a
duplicate account just to grant POS access.

An Auth account or an order-management `profiles` row alone grants no POS access.
This migration does not automatically populate either profile table. Review any
existing shared Auth provisioning hooks when creating users; those hooks are
not changed here.

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
