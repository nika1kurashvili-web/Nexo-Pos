# POS employee management

Repository implementation only: do not automatically deploy SQL or create live users.

## Manual deployment order

The existing 001 profile migration, explicit membership prerequisite and Phase 1
002 must already be installed. Register visibility migration 202609300001 stays
unchanged. Review and test the NEW
`supabase/migrations/202610010001_pos_employee_management.sql` in staging first.
This unique version replaces the never-applied local employee migration numbered
202609300002. The already-applied `202609300002_pos_register_last_close.sql` is
unchanged and must not be rerun. Only the new employee file should be applied,
manually as a BYPASSRLS/superuser owner, once prerequisites are present and the
employee objects are absent. Do not replay the entire migrations directory.
It creates one POS audit table, five functions, one index and one admin-only audit
SELECT policy. It changes no existing policy or row on installation. Apply SQL
manually before releasing the updated application. Without it, /employees fails
closed and hides edit forms.

Set `SUPABASE_SERVICE_ROLE_KEY` only in the server environment for the intended
Vercel deployment. It must belong to the project already configured by
`NEXT_PUBLIC_SUPABASE_URL`. Never put the service credential in a NEXT_PUBLIC
variable, source code, Git, client props, chat or logs. No env values were changed
during implementation. Ordinary membership updates do not need this credential;
Auth account creation/password updates and their outcome audit do.

## Membership design

The existing model remains authoritative: `pos_profiles` grants POS access,
`profiles` grants Orders access, trusted `raw_app_meta_data.nexo_memberships`
records explicit application provisioning. No role comes from user metadata.

An authenticated admin Server Action first calls the admin-only exact-email
lookup. An existing account requires an explicit attachment checkbox; its password,
Auth email confirmation, user metadata and Orders membership are untouched.
New accounts require a 12–256 character password, admin confirmation of the email,
and the existing service-only provisioning version=1 handshake BEFORE Auth creation.
The Admin API creates an **unmarked** confirmed account. Therefore the existing
fail-closed provisioning trigger grants no Orders or POS membership at this stage.

The caller's authenticated `pos_employee_save` then locks the Auth row, merges only
the `pos` role into the trusted marker, upserts the POS profile and records an audit
entry in ONE database transaction. Other metadata keys and the entire `orders`
marker are preserved. Missing markers can become `{version:1,pos:...}`; unknown
versions/keys/roles fail closed for manual review. Existing legacy Orders rows are
not inferred into metadata and remain untouched. There is no INSERT/UPDATE/DELETE
on Orders tables. Read-only `profiles` existence checks are solely for the shared
password warning, never for POS authorization.

This lifecycle intentionally does not call nexo_finalize_user_memberships: that
insert-only function cannot update an inactive/changed profile and may insert an
Orders row from an old marker. It and the provisioning CLI are unchanged. The new
RPC uses the SAME marker format; it does not introduce a second membership model.
Disabled employees retain their pos role marker, but their authoritative profile
is inactive. Calling the old finalize function on such a profile fails conflict;
it cannot silently reactivate it.

## Concurrency and authorization

Every list/lookup/save/password request requires a currently active POS admin in
the DB as well as requireAdmin in the action/page. No direct write grants to
pos_profiles, auth.users or audit rows are given to authenticated users.
All functions have SECURITY DEFINER, empty search_path and schema-qualified
table accesses. The migration requires a BYPASSRLS/superuser owner because
existing POS tables FORCE RLS. RLS is never disabled.

A transaction advisory lock serializes employee saves, then target profile row
locking serializes deactivation with pos_require_actor's financial share lock.
Self-deactivation, self-demotion even when another active admin exists, removing
the last active admin, and deactivation while a target
has an open session are rejected in SQL. No session is automatically closed.
These guards apply to the provided management RPC; trusted database owners can
always bypass application workflows with direct SQL and must not do so casually.
The advisory lock is acquired before rechecking the caller's active admin role.
Thus cross-admin saves are serialized: after one admin demotes/deactivates the
other, the waiting caller loses authorization. Self-protection leaves a sole
remaining admin unable to remove themselves; the explicit last-admin check is
retained as defense in depth. No cross-request membership cache is used in SQL.

## Auth API boundaries and passwords

Auth API creation and the membership transaction cannot be one atomic transaction.
If creation succeeds but saving membership fails, the unmarked Auth account can
remain without POS access. No account is deleted and no unknown operation is
automatically retried. Inspect Auth Users/audit first, then explicitly attach the
existing account if needed. Concurrent creation of the same email stops on Auth
rejection; it does not automatically take over the newly existing account.

Password reset uses `auth.admin.updateUserById(id,{password})` only after an
authenticated admin authorization/audit RPC confirms the target has POS membership.
If an Orders profile exists, an additional checkbox is enforced in SQL. A shared
Auth account has ONE password: changing it also affects Orders login. It cannot
be changed for POS alone without changing architecture. No Orders role/status is
changed, and the application never globally bans/deletes/signs out the account.
Temporary passwords are not stored in application tables/logs or redisplayed;
there is no forced-first-login-change feature in this scope.

Password attempts are audited before the external call. Only service_role can
record its outcome; authenticated admins cannot forge a success via this RPC.
Unknown responses leave `password_unknown` or a pending request for review. The
external Auth call cannot hold the DB authorization lock across the network: it
is authorized at request time. No claim is made of an atomic transaction spanning
Auth and Postgres. Preserve audit rows and investigate unknown outcomes manually.

## Local validation

`node --test tests/employee-management.test.mjs` uses an isolated in-memory
PostgreSQL database plus source-isolation checks. It exercises the real migrations,
not production or staging. Fixtures never contact a Supabase project. Tests cover
POS-only creation, explicit dual membership, Orders preservation, role changes,
disable/reactivate, open-session rejection, last-admin/self-disable guards,
invalid metadata rollback, cashier/anon denial and password audit grants.
The suite now applies register last-close before employees and verifies that its
function definition and existing memberships remain unchanged. It also checks
migration version uniqueness and both serialized cross-admin save orders.
PGlite queues transactions; this is not a real multi-connection contention test.

Verify the external Admin API flow manually in staging with disposable accounts
before production release. Never run a production build beside the dev server.
