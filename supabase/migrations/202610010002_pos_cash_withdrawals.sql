-- Apply manually after 202610010001. No existing financial rows are rewritten.
begin;
set local lock_timeout = '10s';
do $$
declare signature text; target oid;
begin
  if not exists(select 1 from pg_catalog.pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Function owner must bypass FORCE RLS';
  end if;
  foreach signature in array array['public.pos_require_actor(boolean)', 'public.pos_decimal(text,integer,boolean)',
    'public.pos_close_register(uuid,text,text)', 'public.pos_register_state()',
    'public.pos_register_session_report(timestamp with time zone,timestamp with time zone,uuid,uuid,text)',
    'public.pos_employee_save(uuid,text,text,boolean)'] loop
    target:=pg_catalog.to_regprocedure(signature);
    if target is null then raise exception 'Missing prerequisite: %',signature; end if;
    if not pg_catalog.has_function_privilege(current_user,target,'EXECUTE') then
      raise exception 'Migration owner needs prerequisite EXECUTE: %',signature;
    end if;
    if signature in ('public.pos_close_register(uuid,text,text)','public.pos_register_state()',
      'public.pos_register_session_report(timestamp with time zone,timestamp with time zone,uuid,uuid,text)')
      and not exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid=p.proowner
        where p.oid=target and r.rolname=current_user) then
      raise exception 'Apply as existing register RPC owner: %',signature;
    end if;
    if not exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid=p.proowner
      where p.oid=target and (r.rolsuper or r.rolbypassrls)) then
      raise exception 'Prerequisite function owner must bypass FORCE RLS: %',signature;
    end if;
  end loop;
  perform id,register_id,cashier_id,opening_cash,status,expected_closing_cash from public.pos_register_sessions limit 0;
  perform session_id,method_code,amount from public.pos_payments limit 0;
  if position('last_actual_closing_cash' in pg_catalog.pg_get_functiondef('public.pos_register_state()'::regprocedure))=0 then
    raise exception 'Register last-close prerequisite required';
  end if;
end $$;

create table public.pos_cash_withdrawals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  request_fingerprint text not null,
  session_id uuid not null references public.pos_register_sessions(id) on delete restrict,
  register_id uuid not null references public.pos_registers(id) on delete restrict,
  actor_id uuid not null references public.pos_profiles(id) on delete restrict,
  actor_name text not null,
  register_name text not null,
  amount numeric(14,2) not null check(amount > 0 and amount <= 9999999999.99),
  reason text not null check(length(reason) between 1 and 500 and
    reason=pg_catalog.regexp_replace(reason,'^[[:space:]]+|[[:space:]]+$','','g')),
  created_at timestamptz not null default now()
);
create index pos_cash_withdrawals_session on public.pos_cash_withdrawals(session_id,created_at,id);
create index pos_cash_withdrawals_register on public.pos_cash_withdrawals(register_id);
create index pos_cash_withdrawals_actor on public.pos_cash_withdrawals(actor_id);
alter table public.pos_cash_withdrawals enable row level security;
alter table public.pos_cash_withdrawals force row level security;
revoke all on public.pos_cash_withdrawals from public,anon,authenticated,service_role;
grant select on public.pos_cash_withdrawals to authenticated;
create policy pos_cash_withdrawals_read on public.pos_cash_withdrawals for select to authenticated
  using(public.pos_role()='admin' or (public.pos_role()='cashier' and actor_id=(select auth.uid())));

create function public.pos_cash_withdrawals_immutable() returns trigger
language plpgsql security invoker set search_path='' as $$
begin raise exception 'CASH_WITHDRAWAL_IMMUTABLE'; end $$;
create trigger pos_cash_withdrawals_no_change before update or delete on public.pos_cash_withdrawals
  for each row execute function public.pos_cash_withdrawals_immutable();
create trigger pos_cash_withdrawals_no_truncate before truncate on public.pos_cash_withdrawals
  for each statement execute function public.pos_cash_withdrawals_immutable();

-- Private shared calculation. RPC callers authorize before invoking it. All
-- cash payment kinds count, including repayments; never sum RLS-filtered rows.
create function public.pos_session_cash_totals(p_session uuid)
returns table(cash_payments numeric,cash_withdrawals numeric,expected_cash numeric)
language sql stable security definer set search_path='' as $$
  select c.amount,w.amount,s.opening_cash+c.amount-w.amount
  from public.pos_register_sessions s
  cross join lateral (select coalesce(sum(p.amount),0) amount from public.pos_payments p
    where p.session_id=s.id and p.method_code='cash') c
  cross join lateral (select coalesce(sum(p.amount),0) amount from public.pos_cash_withdrawals p
    where p.session_id=s.id) w
  where s.id=p_session;
$$;

create function public.pos_record_cash_withdrawal(p_request uuid,p_session uuid,p_amount text,p_reason text)
returns uuid language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare actor uuid:=public.pos_require_actor(); s public.pos_register_sessions;
  previous public.pos_cash_withdrawals; amount numeric; reason text; fingerprint text;
  available numeric; result uuid;
begin
  -- Aggregates after a wait must see the preceding committed withdrawal.
  -- PostgREST uses READ COMMITTED; reject stale snapshot isolation explicitly.
  if pg_catalog.current_setting('transaction_isolation')<>'read committed' then
    raise exception 'UNSUPPORTED_TRANSACTION_ISOLATION';
  end if;
  if p_request is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  if p_session is null then raise exception 'OPEN_SESSION_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text,0));
  if p_amount is null or p_amount !~ '^[0-9]+([.][0-9]{1,2})?$' then raise exception 'INVALID_DECIMAL'; end if;
  amount:=public.pos_decimal(p_amount,2,true);
  reason:=pg_catalog.regexp_replace(p_reason,'^[[:space:]]+|[[:space:]]+$','','g');
  if reason is null or length(reason) not between 1 and 500 then raise exception 'INVALID_WITHDRAWAL_REASON'; end if;
  fingerprint:=encode(sha256(convert_to(jsonb_build_object('version',1,'operation','cash_withdrawal',
    'actor',actor,'session',p_session,'amount',trim_scale(amount),'reason',reason)::text,'UTF8')),'hex');
  select * into previous from public.pos_cash_withdrawals where request_id=p_request;
  if found then
    if previous.actor_id<>actor or previous.request_fingerprint is distinct from fingerprint then raise exception 'REQUEST_CONFLICT'; end if;
    return previous.id; -- Successful historical retries also work after close.
  end if;
  select * into s from public.pos_register_sessions where id=p_session for update;
  if s.id is null or s.status<>'open' or s.cashier_id<>actor then raise exception 'OPEN_SESSION_REQUIRED'; end if;
  select t.expected_cash into available from public.pos_session_cash_totals(s.id) t;
  if amount>available then raise exception 'INSUFFICIENT_CASH'; end if;
  insert into public.pos_cash_withdrawals(request_id,request_fingerprint,session_id,register_id,actor_id,actor_name,register_name,amount,reason)
    select p_request,fingerprint,s.id,s.register_id,actor,p.full_name,r.name,amount,reason
    from public.pos_profiles p cross join public.pos_registers r where p.id=actor and r.id=s.register_id
    returning id into result;
  return result;
end $$;

create or replace function public.pos_close_register(p_session uuid,p_actual text,p_note text default null) returns numeric
language plpgsql security definer set search_path='' as $$
declare actor uuid:=public.pos_require_actor(); s public.pos_register_sessions; expected numeric;
begin
  if pg_catalog.current_setting('transaction_isolation')<>'read committed' then
    raise exception 'UNSUPPORTED_TRANSACTION_ISOLATION';
  end if;
  select * into s from public.pos_register_sessions where id=p_session for update;
  if s.id is null or (s.cashier_id<>actor and public.pos_role()<>'admin') then raise exception 'SESSION_ACCESS_DENIED'; end if;
  if s.status<>'open' then raise exception 'SESSION_CLOSED'; end if;
  select t.expected_cash into expected from public.pos_session_cash_totals(s.id) t;
  update public.pos_register_sessions set status='closed',closed_at=now(),
    expected_closing_cash=expected,actual_closing_cash=public.pos_decimal(p_actual,2),
    cash_difference=public.pos_decimal(p_actual,2)-expected,closing_note=left(p_note,2000) where id=s.id;
  return expected;
end $$;

-- Register state/report replacements follow below. No existing rows are updated.

create or replace function public.pos_register_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role text;
begin
  select p.role
  into actor_role
  from public.pos_profiles p
  where p.id = actor
    and p.active = true;

  if actor is null
     or actor_role is null
     or actor_role not in ('admin', 'cashier') then
    raise exception 'POS_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  return (
    select coalesce(
      jsonb_agg(
        x
        order by x.register_name, x.register_id
      ),
      '[]'::jsonb
    )
    from (
      select
        r.id as register_id,
        r.name as register_name,
        r.active as register_active,

        s.id as session_id,
        s.cashier_id,
        p.full_name as cashier_name,
        s.opened_at,
        s.opening_cash,

        c.cash_payments, c.cash_withdrawals, c.expected_cash,

        (
          s.id is not null
          and s.cashier_id = actor
        ) as is_own,

        (
          s.id is not null
          and (
            s.cashier_id = actor
            or actor_role = 'admin'
          )
        ) as can_close,

        lc.actual_closing_cash
          as last_actual_closing_cash,

        lc.expected_closing_cash
          as last_expected_closing_cash,

        lc.closed_at
          as last_closed_at

      from public.pos_registers r

      left join public.pos_register_sessions s
        on s.register_id = r.id
       and s.status = 'open'

      left join public.pos_profiles p
        on p.id = s.cashier_id

      left join lateral public.pos_session_cash_totals(s.id) c on true

      left join lateral (
        select
          previous.actual_closing_cash,
          previous.expected_closing_cash,
          previous.closed_at
        from public.pos_register_sessions previous
        where previous.register_id = r.id
          and previous.status = 'closed'
        order by
          previous.closed_at desc nulls last,
          previous.id desc
        limit 1
      ) lc on true

      where r.active
         or s.id is not null
    ) x
  );
end
$$;


create or replace function public.pos_register_session_report(
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
        c.cash_payments,c.cash_withdrawals,
        case when s.status='closed' then s.expected_closing_cash else c.expected_cash end as expected_cash
      from public.pos_register_sessions s
      cross join lateral public.pos_session_cash_totals(s.id) c
      join public.pos_registers r on r.id=s.register_id
      join public.pos_profiles p on p.id=s.cashier_id
      where (p_from is null or s.opened_at >= p_from) and (p_to is null or s.opened_at < p_to)
        and (p_register is null or s.register_id=p_register) and (p_cashier is null or s.cashier_id=p_cashier)
        and (p_status is null or s.status=p_status)
      order by s.opened_at desc,s.id desc limit 100
    ) x)
  );
end $$;


revoke all on function public.pos_cash_withdrawals_immutable(),public.pos_session_cash_totals(uuid),
 public.pos_record_cash_withdrawal(uuid,uuid,text,text),public.pos_close_register(uuid,text,text),
 public.pos_register_state(),public.pos_register_session_report(timestamptz,timestamptz,uuid,uuid,text)
 from public,anon,authenticated,service_role;
grant execute on function public.pos_record_cash_withdrawal(uuid,uuid,text,text),public.pos_close_register(uuid,text,text),
 public.pos_register_state(),public.pos_register_session_report(timestamptz,timestamptz,uuid,uuid,text) to authenticated;
commit;
