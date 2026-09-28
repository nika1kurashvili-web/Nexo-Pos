-- READ ONLY. Run in the shared project's Supabase SQL Editor and return the
-- catalog_preflight JSON result. No customer rows, credentials, or Auth users
-- are selected. This is an inspection query, NOT an application migration.
-- Required before designing Phase 1 catalog foreign keys and POS read access.
with targets as (
  select c.oid, n.nspname as schema_name, c.relname as table_name,
    c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('products', 'product_variants')
    and c.relkind in ('r', 'p')
), policy_functions as (
  select distinct d.refobjid as oid
  from pg_catalog.pg_policy policy
  join targets t on t.oid = policy.polrelid
  join pg_catalog.pg_depend d
    on d.classid = 'pg_catalog.pg_policy'::regclass and d.objid = policy.oid
    and d.refclassid = 'pg_catalog.pg_proc'::regclass
)
select jsonb_build_object(
  'tables', (select coalesce(jsonb_agg(to_jsonb(t) - 'oid'), '[]'::jsonb) from targets t),
  'columns', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', t.table_name,
      'column', a.attname,
      'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
      'nullable', not a.attnotnull,
      'default', pg_catalog.pg_get_expr(def.adbin, def.adrelid)
    ) order by t.table_name, a.attnum), '[]'::jsonb)
    from targets t
    join pg_catalog.pg_attribute a on a.attrelid = t.oid
      and a.attnum > 0 and not a.attisdropped
    left join pg_catalog.pg_attrdef def on def.adrelid = t.oid and def.adnum = a.attnum
  ),
  'constraints', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', t.table_name, 'name', c.conname,
      'definition', pg_catalog.pg_get_constraintdef(c.oid, true)
    ) order by t.table_name, c.conname), '[]'::jsonb)
    from targets t join pg_catalog.pg_constraint c on c.conrelid = t.oid
  ),
  'indexes', (
    select coalesce(jsonb_agg(to_jsonb(i) order by i.tablename, i.indexname), '[]'::jsonb)
    from pg_catalog.pg_indexes i
    where i.schemaname = 'public' and i.tablename in ('products', 'product_variants')
  ),
  'policies', (
    select coalesce(jsonb_agg(to_jsonb(p) order by p.tablename, p.policyname), '[]'::jsonb)
    from pg_catalog.pg_policies p
    where p.schemaname = 'public' and p.tablename in ('products', 'product_variants')
  ),
  'grants', (
    select coalesce(jsonb_agg(to_jsonb(g) order by g.table_name, g.grantee, g.privilege_type), '[]'::jsonb)
    from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.table_name in ('products', 'product_variants')
      and g.grantee in ('PUBLIC', 'anon', 'authenticated')
  ),
  'column_grants', (
    select coalesce(jsonb_agg(to_jsonb(g) order by g.table_name, g.column_name, g.grantee), '[]'::jsonb)
    from information_schema.role_column_grants g
    where g.table_schema = 'public' and g.table_name in ('products', 'product_variants')
      and g.grantee in ('PUBLIC', 'anon', 'authenticated')
  ),
  'authorization_helpers', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'name', p.proname,
      'arguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
      'security_definer', p.prosecdef,
      'definition', pg_catalog.pg_get_functiondef(p.oid)
    ) order by n.nspname, p.proname), '[]'::jsonb)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.prokind = 'f' and n.nspname = 'public'
      and (p.oid in (select oid from policy_functions)
        or p.proname in ('is_admin', 'is_operator', 'nexo_active_role'))
  )
) as catalog_preflight;
