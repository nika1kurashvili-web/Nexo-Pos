-- თანამშრომლის წაშლა ისტორიის შენახვით.
-- ისტორიის გარეშე თანამშრომელი მთლიანად იშლება; ისტორიის მქონე ინახება ბაზაში (სახელი რჩება
-- გაყიდვებსა და რეპორტებში), მაგრამ სიიდან ქრება და სისტემაში შესვლა ეკრძალება.
begin;

alter table public.pos_profiles add column if not exists deleted_at timestamptz;

create or replace function public.pos_employee_list() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.pos_profiles where id=auth.uid() and active and role='admin') then
    raise exception 'POS_ACCESS_DENIED' using errcode='42501';
  end if;
  return (select coalesce(jsonb_agg(x order by x.full_name,x.id),'[]'::jsonb) from (
    select p.id,p.full_name,u.email,p.role,p.active,p.created_at,
      exists(select 1 from public.pos_register_sessions s where s.cashier_id=p.id and s.status='open') as has_open_session,
      exists(select 1 from public.profiles o where o.id=p.id) as has_orders
    from public.pos_profiles p join auth.users u on u.id=p.id where p.deleted_at is null
  ) x);
end $$;

create or replace function public.pos_employee_save(p_user uuid,p_name text,p_role text,p_active boolean) returns uuid
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
    on conflict(id) do update set full_name=excluded.full_name,role=excluded.role,active=excluded.active,deleted_at=null;
  insert into public.pos_employee_audit(actor_id,target_id,event,before_state,after_state)
    values(actor,p_user,case when old.id is null then 'created' else 'updated' end,
      case when old.id is not null then jsonb_build_object('name',old.full_name,'role',old.role,'active',old.active) end,
      jsonb_build_object('name',btrim(p_name),'role',p_role,'active',p_active));
  return p_user;
end $$;

drop function if exists public.pos_employee_delete(uuid);
create function public.pos_employee_delete(p_user uuid) returns text
language plpgsql security definer set search_path='' as $$
declare actor uuid := auth.uid(); old public.pos_profiles; marker jsonb; result text := 'deleted';
begin
  perform pg_catalog.pg_advisory_xact_lock(726394120038::bigint);
  if not exists(select 1 from public.pos_profiles where id=actor and active and role='admin') then
    raise exception 'POS_ACCESS_DENIED' using errcode='42501';
  end if;
  select * into old from public.pos_profiles where id=p_user and deleted_at is null for update;
  if not found then raise exception 'INVALID_EMPLOYEE'; end if;
  if p_user = actor then raise exception 'SELF_DELETE_FORBIDDEN'; end if;
  if old.role='admin' and old.active and
     not exists(select 1 from public.pos_profiles where active and role='admin' and id<>p_user) then
    raise exception 'LAST_ADMIN';
  end if;
  if exists(select 1 from public.pos_register_sessions where cashier_id=p_user and status='open') then
    raise exception 'EMPLOYEE_OPEN_SESSION';
  end if;

  begin
    delete from public.pos_profiles where id=p_user;
  exception when foreign_key_violation then
    -- ისტორია აქვს: ვტოვებთ ჩანაწერს, ვთიშავთ და ვმალავთ
    update public.pos_profiles set active=false, deleted_at=now() where id=p_user;
    result := 'archived';
  end;

  select raw_app_meta_data->'nexo_memberships' into marker from auth.users where id=p_user;
  if marker is not null and jsonb_typeof(marker)='object' and marker ? 'pos' then
    update auth.users
       set raw_app_meta_data = jsonb_set(raw_app_meta_data,'{nexo_memberships}',marker - 'pos')
     where id=p_user;
  end if;

  insert into public.pos_employee_audit(actor_id,target_id,event,before_state)
    values(actor,p_user,'deleted',jsonb_build_object('name',old.full_name,'role',old.role,'active',old.active,'kept_history',result='archived'));
  return result;
end $$;


revoke all on function public.pos_employee_delete(uuid) from public,anon,authenticated,service_role;
grant execute on function public.pos_employee_delete(uuid) to authenticated;
revoke all on function public.pos_employee_list(),public.pos_employee_save(uuid,text,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.pos_employee_list(),public.pos_employee_save(uuid,text,text,boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
