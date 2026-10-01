-- Manual deployment after explicit memberships prerequisite and Phase 1.
-- No existing rows changed on installation. Never run automatically.
begin;
set local lock_timeout = '10s';
do $$ begin
  if not exists(select 1 from pg_catalog.pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Apply as BYPASSRLS/superuser owner';
  end if;
  if public.nexo_provisioning_version() is distinct from 1 then raise exception 'Membership prerequisite required'; end if;
end $$;

create table public.pos_employee_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null,
  target_id uuid not null,
  event text not null check(event in ('created','updated','password_requested','password_succeeded','password_unknown')),
  before_state jsonb, after_state jsonb,
  created_at timestamptz not null default now()
);
alter table public.pos_employee_audit enable row level security;
alter table public.pos_employee_audit force row level security;
revoke all on public.pos_employee_audit from public,anon,authenticated,service_role;
grant select on public.pos_employee_audit to authenticated;
create policy pos_employee_audit_admin_read on public.pos_employee_audit for select to authenticated
  using (public.pos_role()='admin');
create index pos_employee_audit_target on public.pos_employee_audit(target_id,created_at);

create function public.pos_employee_list() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.pos_profiles where id=auth.uid() and active and role='admin') then
    raise exception 'POS_ACCESS_DENIED' using errcode='42501';
  end if;
  return (select coalesce(jsonb_agg(x order by x.full_name,x.id),'[]'::jsonb) from (
    select p.id,p.full_name,u.email,p.role,p.active,p.created_at,
      exists(select 1 from public.pos_register_sessions s where s.cashier_id=p.id and s.status='open') as has_open_session,
      exists(select 1 from public.profiles o where o.id=p.id) as has_orders
    from public.pos_profiles p join auth.users u on u.id=p.id
  ) x);
end $$;

-- Exact lookup only for trusted POS admins. Never exposes passwords/tokens or
-- an entire Auth directory. Read-only Orders membership existence is for warning.
create function public.pos_employee_lookup(p_email text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare u record;
begin
  if not exists(select 1 from public.pos_profiles where id=auth.uid() and active and role='admin') then
    raise exception 'POS_ACCESS_DENIED' using errcode='42501';
  end if;
  if length(btrim(p_email)) not between 3 and 254 then raise exception 'INVALID_EMPLOYEE'; end if;
  select id into u from auth.users where lower(email)=lower(btrim(p_email));
  if not found then return null; end if;
  return jsonb_build_object('id',u.id,'has_pos',exists(select 1 from public.pos_profiles p where p.id=u.id));
end $$;

-- For a newly created unmarked Auth account or explicit attachment of an
-- existing account. No finalize call: it can insert Orders rows from old markers.
-- Updating only the pos marker atomically preserves all other app metadata.
create function public.pos_employee_save(p_user uuid,p_name text,p_role text,p_active boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); old public.pos_profiles; marker jsonb; metadata jsonb;
begin
  -- Serialize all employee saves before checking the caller or counting admins.
  -- A waiting request rechecks authorization after the preceding save commits.
  perform pg_catalog.pg_advisory_xact_lock(726394120038::bigint);
  if not exists(select 1 from public.pos_profiles where id=actor and active and role='admin') then
    raise exception 'POS_ACCESS_DENIED' using errcode='42501';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 200 or p_role is null or p_role not in ('admin','cashier') or p_active is null then
    raise exception 'INVALID_EMPLOYEE';
  end if;
  select raw_app_meta_data into metadata from auth.users where id=p_user for update;
  if not found then raise exception 'AUTH_USER_NOT_FOUND'; end if;
  select * into old from public.pos_profiles where id=p_user for update;
  if p_user=actor and not p_active then raise exception 'SELF_DISABLE_FORBIDDEN'; end if;
  if p_user=actor and p_role<>'admin' then raise exception 'SELF_DEMOTION_FORBIDDEN'; end if;
  if old.role='admin' and old.active and (not p_active or p_role<>'admin') and
    not exists(select 1 from public.pos_profiles where active and role='admin' and id<>p_user) then
    raise exception 'LAST_ADMIN';
  end if;
  -- Profile lock serializes with pos_require_actor() in financial RPCs, so an
  -- overlapping open cannot slip between this check and deactivation.
  if not p_active and exists(select 1 from public.pos_register_sessions where cashier_id=p_user and status='open') then
    raise exception 'EMPLOYEE_OPEN_SESSION';
  end if;
  metadata:=coalesce(metadata,'{}'::jsonb);
  if jsonb_typeof(metadata)<>'object' then raise exception 'MEMBERSHIP_METADATA_INVALID'; end if;
  marker:=metadata->'nexo_memberships';
  if marker is null then marker:='{"version":1}'::jsonb; end if;
  if jsonb_typeof(marker)<>'object' or marker->'version' is distinct from '1'::jsonb
    or exists(select 1 from jsonb_object_keys(marker) k where k not in ('version','orders','pos'))
    or (marker ? 'orders' and (jsonb_typeof(marker->'orders')<>'string' or marker->>'orders' not in ('admin','operator','manager')))
    or (marker ? 'pos' and (jsonb_typeof(marker->'pos')<>'string' or marker->>'pos' not in ('admin','cashier'))) then
    raise exception 'MEMBERSHIP_METADATA_INVALID';
  end if;
  update auth.users set raw_app_meta_data=jsonb_set(metadata,'{nexo_memberships}',marker||jsonb_build_object('pos',p_role)) where id=p_user;
  insert into public.pos_profiles(id,full_name,role,active) values(p_user,btrim(p_name),p_role,p_active)
    on conflict(id) do update set full_name=excluded.full_name,role=excluded.role,active=excluded.active;
  insert into public.pos_employee_audit(actor_id,target_id,event,before_state,after_state)
    values(actor,p_user,case when old.id is null then 'created' else 'updated' end,
      case when old.id is not null then jsonb_build_object('name',old.full_name,'role',old.role,'active',old.active) end,
      jsonb_build_object('name',btrim(p_name),'role',p_role,'active',p_active));
  return p_user;
end $$;

-- Audit before the external Auth API call. Passwords never enter SQL arguments.
create function public.pos_employee_password_request(p_user uuid,p_shared_confirm boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
  perform public.pos_require_actor(true);
  if not exists(select 1 from public.pos_profiles where id=p_user) then raise exception 'POS_EMPLOYEE_NOT_FOUND'; end if;
  if exists(select 1 from public.profiles where id=p_user) and p_shared_confirm is distinct from true then
    raise exception 'SHARED_PASSWORD_CONFIRM_REQUIRED';
  end if;
  insert into public.pos_employee_audit(actor_id,target_id,event) values(auth.uid(),p_user,'password_requested') returning id into result;
  return result;
end $$;
create function public.pos_employee_password_result(p_request uuid,p_success boolean) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  -- Service-only completion; an authenticated browser cannot forge API success.
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ACCESS_REQUIRED' using errcode='42501';
  end if;
  update public.pos_employee_audit set event=case when p_success then 'password_succeeded' else 'password_unknown' end
    where id=p_request and event='password_requested';
  return found;
end $$;
revoke all on function public.pos_employee_list(),public.pos_employee_lookup(text),public.pos_employee_save(uuid,text,text,boolean),
  public.pos_employee_password_request(uuid,boolean),public.pos_employee_password_result(uuid,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.pos_employee_list(),public.pos_employee_lookup(text),public.pos_employee_save(uuid,text,text,boolean),
  public.pos_employee_password_request(uuid,boolean) to authenticated;
grant execute on function public.pos_employee_password_result(uuid,boolean) to service_role;
commit;
