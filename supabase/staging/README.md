# Empty nexo-staging bootstrap

First file to run manually, **only in nexo-staging**:
`supabase/staging/000_shared_pre_pos_bootstrap.sql`.
Select that project in the Supabase Dashboard and verify its project reference
before opening SQL Editor. Project display names cannot reliably be verified by
portable database SQL. The script refuses existing Auth users or known application
tables, uses CREATE rather than replacement, and runs in one transaction with a
10-second lock timeout. It is not rerunnable and contains no cleanup/drop/reset.

## Scope and evidence limits

This is a minimal, explicitly documented reconstruction of the **pre-fix** shared
database, not a certified production schema clone. The complete live DDL/preflight
CSV is not attached or stored in either repository. A passing staging test does
not prove compatibility with unknown production constraints, types, triggers or
write paths. Compare the real schema export before final production approval.

Verified from the supplied production facts:

- Orders profiles have NOT NULL role default `operator` and NOT NULL active
  default `true`. The legacy SECURITY DEFINER handle_new_user inserts only
  id/full_name for every Auth creation, including prospective POS users.
- Products and variants have RLS enabled. Products SELECT uses is_active_user();
  variants have authenticated permissive SELECT true. Products have manager SELECT.

Taken from the Orders repository:

- Role constraint permits admin/operator/manager; nexo_active_role reads the active
  old Orders profile. Restrictive insert/update/delete policies require that role
  to be admin/operator. Only the profiles/catalog subset is installed here.
- Manager profiles/products read policies; admin-only catalog/profile mutations
  described in the Orders deployment notes.
- The entire purchase-price table, its constraints/policies and
  nexo_create_catalog_item RPC from 202609250002_product_purchase_prices.sql are
  embedded, with its outer transaction removed. No courier/order objects included.

Explicit fixture assumptions, NOT verified exact production DDL:

- UUID catalog IDs (consistent with string IDs in Orders TypeScript, but those
  types alone do not prove UUID). POS migrations derive the actual catalog ID types.
- Numeric precision, timestamp/default/nullability choices beyond the two verified
  profile defaults; profile Auth cascade and variant parent cascade.
- Nonunique SKU indexes, parent FK index and updated-at trigger definitions/names.
- is_admin/is_active_user bodies implement active Orders membership; their exact
  original function bodies/ACL/search_path and FORCE RLS flags were not supplied.
- Original permissive mutation policy names/expressions and table grants are not
  fully available. Reconstructed policies are named staging_* and use the documented
  admin-only permissions. Base tables enable (not force) RLS; the repository's
  purchase-price table enables and forces it.

Thus the bootstrap preserves the verified provisioning flaw intentionally and
tests the intended catalog authorization model. It must not be described as an
exact reconstruction of every current production security rule.

## Objects created

- Four tables: profiles, products, product_variants, product_purchase_prices.
- Six functions: is_admin, is_active_user, nexo_active_role, set_updated_at,
  handle_new_user, nexo_create_catalog_item.
- Four triggers: three updated-at triggers and Auth AFTER INSERT on_auth_user_created.
- Primary/check/foreign-key/unique purchase-target constraints and supporting
  indexes, including three explicit SKU/variant-parent lookup indexes.
- 25 policies: profile/catalog reads (5), admin writes (9), restrictive writes (9),
  and purchase-price policies (2). Table/function privileges for the relevant roles.
- Fake catalog only: STG-SINGLE (10 GEL), STG-PARENT (20 GEL), its STG-SMALL variant
  (20 GEL) and STG-LARGE variant (25 GEL). No purchase-cost values are seeded.

Managed Supabase schemas, auth.users, auth.uid() and API roles are required and
are NOT recreated. No Auth users, profile rows, orders, customers, sales, API keys,
OnWay integrations or production personal data are seeded. The legacy trigger will
create Orders membership if you create users BEFORE installing the prerequisite.
For the intended smoke tests, finish all four steps before creating Auth users.

## Manual sequence

1. `supabase/staging/000_shared_pre_pos_bootstrap.sql`
2. `supabase/migrations/202609260001_create_pos_profiles.sql`
3. `supabase/prerequisites/202609280001_explicit_app_memberships.sql`
4. `supabase/migrations/202609260002_pos_phase1.sql`
5. Follow `docs/user-provisioning.md` using only the nexo-staging project URL and
   staging administrator key. Create disposable Orders/POS/dual test accounts.
6. Use two independent staging database connections to test competing register
   opens, sale versus close, repayment versus close and identical/conflicting
   request UUIDs. The local in-memory engine serializes transactions and does not
   establish real multi-connection lock behavior.

Validation: `node --test tests/staging-bootstrap.test.mjs` supplies only a local
minimal Auth harness, then executes the actual bootstrap and all three unchanged
migration files in the required order. It also verifies pre-fix provisioning,
preserved legacy membership, post-fix isolation/catalog permissions, explicit
Orders/dual membership, a POS sale/close and refusal to bootstrap populated data.
It creates no users or SQL objects in any Supabase project.
