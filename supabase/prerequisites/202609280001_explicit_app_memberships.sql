-- MANUAL shared-Auth prerequisite: apply AFTER 202609260001_create_pos_profiles.sql
-- and BEFORE 202609260002_pos_phase1.sql. Separate directory intentionally avoids
-- misleading automatic timestamp ordering. No existing account/profile is updated.
begin;
set local lock_timeout = '10s';

do $$
declare target oid := pg_catalog.to_regprocedure('public.handle_new_user()');
begin
  perform id, full_name, role, active from public.profiles limit 0;
  perform id, full_name, role, active from public.pos_profiles limit 0;
  if target is null then raise exception 'Existing handle_new_user() is required'; end if;
  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid=p.proowner
    where p.oid=target and p.prorettype='pg_catalog.trigger'::regtype and r.rolname=current_user and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'Run as the existing trigger owner, which must bypass FORCE RLS';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Apply as a BYPASSRLS/superuser database administrator';
  end if;
  -- Keep the existing trigger/OID. Abort instead of guessing its event/timing.
  if (select count(*) from pg_catalog.pg_trigger where tgfoid=target and not tgisinternal) <> 1
    or not exists (select 1 from pg_catalog.pg_trigger where tgfoid=target
      and tgrelid='auth.users'::regclass and tgtype=5 and tgenabled in ('O','A')) then
    raise exception 'Expected exactly one enabled AFTER INSERT FOR EACH ROW auth.users trigger';
  end if;
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated')
    and (r.rolsuper or r.rolbypassrls
      or has_table_privilege(r.oid,'auth.users','INSERT')
      or has_column_privilege(r.oid,'auth.users','raw_app_meta_data','INSERT')
      or has_column_privilege(r.oid,'auth.users','raw_app_meta_data','UPDATE'))) then
    raise exception 'Browser roles must not control auth.users app metadata';
  end if;
end $$;

-- Auth Admin createUser may write app metadata AFTER the initial INSERT. This
-- service-only completion function handles that ordering without an UPDATE trigger.
create function public.nexo_finalize_user_memberships(p_user uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare account record; membership jsonb; orders_role text; pos_role text; display_name text;
begin
  select id,email,raw_app_meta_data,raw_user_meta_data into account from auth.users where id=p_user for update;
  if not found then return false; end if;
  membership := account.raw_app_meta_data->'nexo_memberships';
  if jsonb_typeof(membership) is distinct from 'object' then return false; end if;
  if membership->'version' is distinct from '1'::jsonb
    or exists (select 1 from jsonb_object_keys(membership) k where k not in ('version','orders','pos'))
    or not (membership ? 'orders' or membership ? 'pos') then return false; end if;
  orders_role := membership->>'orders'; pos_role := membership->>'pos';
  if (membership ? 'orders' and (jsonb_typeof(membership->'orders') is distinct from 'string'
      or orders_role not in ('admin','operator','manager')))
    or (membership ? 'pos' and (jsonb_typeof(membership->'pos') is distinct from 'string'
      or pos_role not in ('admin','cashier'))) then return false; end if;
  -- User-editable metadata is used only for display, NEVER membership or roles.
  display_name := coalesce(nullif(btrim(account.raw_user_meta_data->>'full_name'),''),nullif(account.email,''),account.id::text);
  if orders_role is not null then
    insert into public.profiles(id,full_name,role,active) values(account.id,display_name,orders_role,true)
      on conflict (id) do nothing;
    if not exists (select 1 from public.profiles where id=account.id and role=orders_role and active=true) then
      raise exception 'EXISTING_ORDERS_MEMBERSHIP_CONFLICT';
    end if;
  end if;
  if pos_role is not null then
    insert into public.pos_profiles(id,full_name,role,active) values(account.id,display_name,pos_role,true)
      on conflict (id) do nothing;
    if not exists (select 1 from public.pos_profiles where id=account.id and role=pos_role and active=true) then
      raise exception 'EXISTING_POS_MEMBERSHIP_CONFLICT';
    end if;
  end if;
  -- Never UPDATE/DELETE either profile. Both membership inserts are atomic.
  return true;
end $$;
revoke all on function public.nexo_finalize_user_memberships(uuid) from public, anon, authenticated;
grant execute on function public.nexo_finalize_user_memberships(uuid) to service_role;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'INSERT' or tg_table_schema <> 'auth' or tg_table_name <> 'users' then
    raise exception 'handle_new_user is only for auth.users INSERT';
  end if;
  -- Normally absent on initial Auth INSERT; missing/unknown markers grant nothing.
  -- Supports trusted SQL provisioning that supplies the marker in the initial row.
  perform public.nexo_finalize_user_memberships(new.id);
  return new;
end $$;

-- Triggers do not require the calling Auth role to have runtime EXECUTE privileges.
-- CREATE OR REPLACE preserves function owner and the existing trigger binding.
revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;

-- Deployment handshake: the provisioning CLI must refuse to create users against
-- the legacy trigger. Contains no secrets; only the trusted Admin API key may call.
create function public.nexo_provisioning_version() returns integer
language sql immutable security invoker set search_path = '' as $$ select 1; $$;
revoke all on function public.nexo_provisioning_version() from public, anon, authenticated;
grant execute on function public.nexo_provisioning_version() to service_role;
do $$ begin
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated') and
    (has_function_privilege(r.oid,'public.nexo_finalize_user_memberships(uuid)','EXECUTE')
      or has_function_privilege(r.oid,'public.nexo_provisioning_version()','EXECUTE')
      or has_function_privilege(r.oid,'public.handle_new_user()','EXECUTE'))) then
    raise exception 'Inherited privileges expose trusted provisioning to a browser role';
  end if;
end $$;
commit;
