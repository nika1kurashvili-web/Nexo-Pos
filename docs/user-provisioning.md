# Explicit Orders and POS membership

Status: implemented locally; NOT applied. Migration 002 remains on hold.

## Deployment order

1. `supabase/migrations/202609260001_create_pos_profiles.sql` (already applied;
   do not rerun or edit it).
2. Review and manually apply
   `supabase/prerequisites/202609280001_explicit_app_memberships.sql`.
3. Use the new trusted account-creation workflow below. Review previously created
   POS accounts for unintended Orders membership separately; no automatic cleanup.
4. Only after the separate Phase 1 security/concurrency checks, consider
   `supabase/migrations/202609260002_pos_phase1.sql`. Do not apply it now.

The prerequisite is intentionally outside the automatic migrations directory:
its later calendar date must not cause financial migration 002 to run first.
This repository's deployment is manual. An automated deployment must explicitly
schedule this prerequisite between 001 and 002; do not blindly run all migrations.

Apply as the existing `handle_new_user()` owner, which must be BYPASSRLS/superuser.
The preflight checks that owner, the existing enabled AFTER INSERT row trigger,
the two profile tables, and browser restrictions on Auth app metadata. It fails
instead of guessing or transferring ownership. There is a transaction-local
10-second lock timeout; all DDL succeeds together or rolls back. No existing
Auth/profile records are backfilled, updated, deleted or reactivated.

## Database design

`profiles` remains Orders membership; `pos_profiles` remains POS membership.
The old active operator defaults stay unchanged, but the Auth trigger no longer
inserts an Orders row unconditionally. Its function OID/owner and existing trigger
binding are retained using CREATE OR REPLACE.

Trusted provisioning writes the following **app metadata**:

```json
{"nexo_memberships":{"version":1,"orders":"operator"}}
```

POS only:

```json
{"nexo_memberships":{"version":1,"pos":"cashier"}}
```

Explicit dual membership:

```json
{"nexo_memberships":{"version":1,"orders":"operator","pos":"cashier"}}
```

Orders roles: admin/operator/manager. POS roles: admin/cashier. Missing marker,
unknown version/keys, invalid types/roles or null role values grant **nothing**.
An invalid part invalidates the whole marker. No default application membership.
Other top-level Auth app metadata (provider/providers) does not affect this check.
User-editable metadata supplies only the display name, never access or roles.

`handle_new_user()` delegates to `nexo_finalize_user_memberships(uuid)` on insert.
Supabase's Admin API can INSERT Auth first and UPDATE app metadata afterward in
the same API operation. Therefore the CLI explicitly calls the completion function
after createUser succeeds. There is deliberately no Auth UPDATE trigger: changing
metadata alone never silently changes existing memberships.

The completion function reads the stored app metadata, locks the Auth row and
creates the requested profiles in one database transaction. It accepts no caller-
supplied role/metadata argument. Existing matching active profiles are left intact;
different roles or inactive profiles cause a conflict, never an overwrite or
reactivation. It does not remove an unrequested existing membership. Repeated
completion is safe. Auth creation and completion are two API requests: completion
failure can leave a new Auth account with no memberships, requiring manual recovery.
Do not automatically delete/recreate accounts after an ambiguous network failure.

`nexo_provisioning_version()` is a service-role-only deployment handshake so the
CLI cannot silently create POS users against the legacy unconditional trigger.
Both helpers revoke PUBLIC/anon/authenticated access. Completion and the trigger
are SECURITY DEFINER with empty search paths and qualified application objects;
the version function is SECURITY INVOKER. The migration checks effective browser
EXECUTE permissions after grants, including inherited grants. No browser RPC is
added for creating employees or choosing memberships.

## Trusted administrator workflow — Orders and POS

Repository inspection found no Orders createUser/invite/signUp endpoint.
`orders.nexo.ge/employees` edits existing profiles after checking an active Orders
admin; its former creation instructions referred administrators to Supabase Auth.
Replace that dashboard-only account-creation step with this local admin command.
After creation, the same Orders page still edits roles, activation, names and
phone numbers. No Orders app build/runtime changes are needed for that behavior.
The old dashboard-only recipe now intentionally creates an account with no access.

Run from this repository on a trusted administrator machine, after the prerequisite
has been deployed. Install the project's existing dependencies first. Set only
the nonsecret project URL; the command prompts for the secret/service-role key
and new password without echo. Do not paste secrets in command arguments or files.

```powershell
$env:NEXO_ADMIN_SUPABASE_URL = 'https://PROJECT.supabase.co'
# Orders employee (default Orders role: operator)
node scripts/provision-user.mjs --access orders --email person@example.com --name "Employee Name" --confirm-email
# POS cashier
node scripts/provision-user.mjs --access pos --pos-role cashier --email cashier@example.com --name "Cashier Name" --confirm-email
# POS administrator
node scripts/provision-user.mjs --access pos --pos-role admin --email pos-admin@example.com --name "POS Administrator" --confirm-email
# Deliberately grant both applications on a NEW account
node scripts/provision-user.mjs --access dual --orders-role operator --pos-role cashier --email dual@example.com --name "Dual Access" --confirm-email
```

`--confirm-email` is an explicit administrator attestation that the address has
been verified. Without it, the account remains unconfirmed and cannot use normal
password login until confirmed. createUser does not send an invitation email.
The CLI does not send messages, reset existing passwords, or reuse an existing
email automatically. It prints the new UUID on success, never passwords or keys.
Supabase enforces the configured password policy in addition to the CLI minimum.

The trust boundary is possession of the Supabase administrator credential on a
trusted machine, as with the previous manual Supabase workflow. An ordinary
Orders/POS application admin session alone cannot call these helpers. No secret
is stored in Vercel, NEXT_PUBLIC variables, browser code, or the web application.
Never import `scripts/provision-user.mjs` from app/lib/browser modules.

## Recovery and deliberate grants to existing users

If creation reports an uncertain result, inspect Authentication Users by email
before retrying. Do not recreate the account or change its password. Verify its
stored app metadata and both memberships. A trusted database administrator may
retry completion for that exact verified UUID:

```sql
select public.nexo_finalize_user_memberships('VERIFIED_AUTH_UUID'::uuid);
```

For an intentional second membership on an existing account, an administrator
must use the Auth Admin API `updateUserById` to merge the requested
`nexo_memberships` marker into existing app metadata, preserving other keys.
Include any existing membership with its current role; then explicitly call the
completion RPC for that UUID. This is a separate deliberate administrative action,
not a migration or an automatic consequence of signing in. It never edits existing
profile values. Changing/removing a marker is not revocation; deactivate the
corresponding profile through its existing trusted administration path.

Existing accidental Orders profiles are NOT removed by this change. Audit those
accounts against intended application memberships before approving financial
migration 002. Keep financial history and employee-retention requirements intact.

## Catalog and test scope

This prerequisite changes no catalog table, policy, grant, Orders authorization
helper, existing profile role/active state, or POS financial function. POS-only
users have no Orders profile and therefore do not become active Orders operators.
The approved products SELECT policy in unapplied migration 002 still supplies
POS-only product reads; until 002 is applied those reads may remain blocked.
Variants retain the existing authenticated SELECT policy.

Tests use a disposable PostgreSQL fixture with verified defaults and representative
Orders RLS, plus a snapshot of the existing Orders catalog mutation migration in
`tests/fixtures/orders-purchase-prices.sql` (test input only). They verify no catalog
INSERT/UPDATE/DELETE for POS-only admin or cashier, RPC denial, preserved Orders
admin editing/catalog behavior, both metadata timings, malformed/forged markers,
explicit dual access, atomic completion, retries and unchanged existing profiles.
They do not contact production or prove every unprovided live policy/RPC. Review
the complete production preflight and smoke-test the deployed Supabase Auth API
on staging before production application.

Local verification: 53/53 tests passed, including 14 provisioning tests and 15
Phase 1 database tests. TypeScript, ESLint and the Next.js production build pass.
Migrations 001 and 002 were left unchanged. No migration was applied to Supabase;
no commit or push was made. Existing Node test-import module-type warnings remain
non-failing.

References: [Supabase Admin createUser](https://supabase.com/docs/reference/javascript/auth-admin-createuser),
[app metadata trust](https://supabase.com/docs/guides/platform/migrating-to-supabase/auth0),
[Auth Admin implementation and metadata timing](https://github.com/supabase/auth/blob/master/internal/api/admin.go).
