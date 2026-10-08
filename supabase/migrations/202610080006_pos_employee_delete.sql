-- თანამშრომლის წაშლა (მხოლოდ POS ადმინისტრატორისთვის).
-- წაიშლება მხოლოდ POS წვდომა. Auth ანგარიში და Orders წვდომა უცვლელი რჩება.
-- თუ თანამშრომელს აქვს ისტორია (გაყიდვა, სალარო, დაბრუნება...), ბაზა წაშლას არ დაუშვებს;
-- ასეთს გათიშვა (გაუქმება) სჭირდება.
begin;

alter table public.pos_employee_audit drop constraint if exists pos_employee_audit_event_check;
alter table public.pos_employee_audit add constraint pos_employee_audit_event_check
  check (event in ('created','updated','deleted','password_requested','password_succeeded','password_unknown'));

create or replace function public.pos_employee_delete(p_user uuid) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid := auth.uid(); old public.pos_profiles; marker jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(726394120038::bigint);
  if not exists(select 1 from public.pos_profiles where id=actor and active and role='admin') then
    raise exception 'POS_ACCESS_DENIED' using errcode='42501';
  end if;
  select * into old from public.pos_profiles where id=p_user for update;
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
    raise exception 'EMPLOYEE_HAS_HISTORY';
  end;

  -- POS ნიშნულს ვშლით Auth მეტამონაცემებიდან; Orders ნიშნული რჩება
  select raw_app_meta_data->'nexo_memberships' into marker from auth.users where id=p_user;
  if marker is not null and jsonb_typeof(marker)='object' and marker ? 'pos' then
    update auth.users
       set raw_app_meta_data = jsonb_set(raw_app_meta_data,'{nexo_memberships}',marker - 'pos')
     where id=p_user;
  end if;

  insert into public.pos_employee_audit(actor_id,target_id,event,before_state)
    values(actor,p_user,'deleted',jsonb_build_object('name',old.full_name,'role',old.role,'active',old.active));
end $$;

revoke all on function public.pos_employee_delete(uuid) from public,anon,authenticated,service_role;
grant execute on function public.pos_employee_delete(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
