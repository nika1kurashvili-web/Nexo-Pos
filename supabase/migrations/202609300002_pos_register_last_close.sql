-- Add last closed session information to POS register state.
-- Read-only change. Does not modify register sessions or payments.

begin;

set local lock_timeout = '10s';

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = current_user
      and (rolsuper or rolbypassrls)
  ) then
    raise exception 'Function owner must bypass FORCE RLS';
  end if;
end
$$;

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

        case
          when s.id is not null
          then coalesce(c.amount, 0)
        end as cash_payments,

        s.opening_cash
          + coalesce(c.amount, 0)
          as expected_cash,

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

      left join lateral (
        select sum(pay.amount) as amount
        from public.pos_payments pay
        where pay.session_id = s.id
          and pay.method_code = 'cash'
      ) c on true

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

revoke all
on function public.pos_register_state()
from public, anon, authenticated, service_role;

grant execute
on function public.pos_register_state()
to authenticated;

commit;