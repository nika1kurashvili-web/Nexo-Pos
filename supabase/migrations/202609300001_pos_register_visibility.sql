-- Apply manually AFTER 001, the membership prerequisite and Phase 1 (002).
-- Read-only RPCs only. No data, table grants, policies or finance RPC changes.
begin;
set local lock_timeout = '10s';
do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Function owner must bypass FORCE RLS';
  end if;
end $$;

create function public.pos_register_state() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid(); actor_role text;
begin
  select p.role into actor_role from public.pos_profiles p where p.id = actor and p.active = true;
  if actor is null or actor_role is null or actor_role not in ('admin','cashier') then
    raise exception 'POS_ACCESS_DENIED' using errcode = '42501';
  end if;
  -- Active POS members see only register availability and current open-session
  -- summaries, never other employees' payment rows or closed-session history.
  return (select coalesce(jsonb_agg(x order by x.register_name, x.register_id), '[]'::jsonb) from (
    select r.id as register_id, r.name as register_name, r.active as register_active,
      s.id as session_id, s.cashier_id, p.full_name as cashier_name, s.opened_at, s.opening_cash,
      case when s.id is not null then coalesce(c.amount,0) end as cash_payments,
      s.opening_cash + coalesce(c.amount,0) as expected_cash,
      (s.id is not null and s.cashier_id = actor) as is_own,
      (s.id is not null and (s.cashier_id = actor or actor_role = 'admin')) as can_close
    from public.pos_registers r
    left join public.pos_register_sessions s on s.register_id = r.id and s.status = 'open'
    left join public.pos_profiles p on p.id = s.cashier_id
    left join lateral (select sum(pay.amount) as amount from public.pos_payments pay
      where pay.session_id = s.id and pay.method_code = 'cash') c on true
    where r.active or s.id is not null
  ) x);
end $$;

create function public.pos_register_session_report(
  p_from timestamptz default null, p_to timestamptz default null,
  p_register uuid default null, p_cashier uuid default null, p_status text default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.pos_profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin') then
    raise exception 'POS_ACCESS_DENIED' using errcode = '42501';
  end if;
  if (p_status is not null and p_status not in ('open','closed')) or (p_from is not null and p_to is not null and p_from >= p_to) then
    raise exception 'INVALID_FILTER';
  end if;
  return jsonb_build_object(
    'registers', (select coalesce(jsonb_agg(x order by x.name,x.id),'[]'::jsonb)
      from (select r.id,r.name from public.pos_registers r) x),
    'cashiers', (select coalesce(jsonb_agg(x order by x.full_name,x.id),'[]'::jsonb)
      from (select p.id,p.full_name from public.pos_profiles p where exists
        (select 1 from public.pos_register_sessions s where s.cashier_id=p.id)) x),
    'sessions', (select coalesce(jsonb_agg(x order by x.opened_at desc,x.id desc),'[]'::jsonb) from (
      select s.*,r.name as register_name,p.full_name as cashier_name,
        case when s.status='closed' then s.expected_closing_cash
          else s.opening_cash + coalesce((select sum(pay.amount) from public.pos_payments pay
            where pay.session_id=s.id and pay.method_code='cash'),0) end as expected_cash
      from public.pos_register_sessions s
      join public.pos_registers r on r.id=s.register_id
      join public.pos_profiles p on p.id=s.cashier_id
      where (p_from is null or s.opened_at >= p_from) and (p_to is null or s.opened_at < p_to)
        and (p_register is null or s.register_id=p_register) and (p_cashier is null or s.cashier_id=p_cashier)
        and (p_status is null or s.status=p_status)
      order by s.opened_at desc,s.id desc limit 100
    ) x)
  );
end $$;

revoke all on function public.pos_register_state(), public.pos_register_session_report(timestamptz,timestamptz,uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.pos_register_state(), public.pos_register_session_report(timestamptz,timestamptz,uuid,uuid,text)
  to authenticated;
commit;
