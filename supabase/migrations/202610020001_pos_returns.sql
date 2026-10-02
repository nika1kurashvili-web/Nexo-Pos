-- Apply manually after 202610010002. No existing financial rows are rewritten.
-- Adds sale returns: pos_returns / pos_return_items / pos_return_refunds, the
-- pos_complete_return and pos_return_sale_details RPCs, a ledger "return_credit"
-- kind, and cash-drawer accounting for cash refunds.
begin;
set local lock_timeout = '10s';
do $$
declare signature text; target oid;
begin
  if not exists(select 1 from pg_catalog.pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Function owner must bypass FORCE RLS';
  end if;
  foreach signature in array array['public.pos_require_actor(boolean)', 'public.pos_decimal(text,integer,boolean)',
    'public.pos_session_cash_totals(uuid)', 'public.pos_register_state()',
    'public.pos_register_session_report(timestamp with time zone,timestamp with time zone,uuid,uuid,text)'] loop
    target := pg_catalog.to_regprocedure(signature);
    if target is null then raise exception 'Missing prerequisite: %', signature; end if;
  end loop;
  perform id, sale_id, kind, amount, payment_id from public.pos_customer_transactions limit 0;
  perform id, quantity, final_unit_price, line_total from public.pos_sale_items limit 0;
  perform amount from public.pos_cash_withdrawals limit 0;
end $$;

create table public.pos_returns (
  id uuid primary key default gen_random_uuid(),
  return_number bigint generated always as identity unique,
  request_id uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  sale_id uuid not null references public.pos_sales(id) on delete restrict,
  session_id uuid not null references public.pos_register_sessions(id) on delete restrict,
  actor_id uuid not null references public.pos_profiles(id) on delete restrict,
  actor_name text not null,
  reason text not null check (length(reason) between 1 and 500 and
    reason = pg_catalog.regexp_replace(reason, '^[[:space:]]+|[[:space:]]+$', '', 'g')),
  total_amount numeric(14,2) not null check (total_amount >= 0 and total_amount < 'Infinity'::numeric),
  debt_reduction numeric(14,2) not null check (debt_reduction >= 0 and debt_reduction < 'Infinity'::numeric),
  refund_total numeric(14,2) not null check (refund_total >= 0 and refund_total < 'Infinity'::numeric),
  created_at timestamptz not null default now(),
  check (total_amount = debt_reduction + refund_total)
);

create table public.pos_return_items (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.pos_returns(id) on delete restrict,
  sale_item_id uuid not null references public.pos_sale_items(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0 and quantity < 'Infinity'::numeric),
  amount numeric(14,2) not null check (amount >= 0 and amount < 'Infinity'::numeric),
  created_at timestamptz not null default now(),
  unique (return_id, sale_item_id)
);

create table public.pos_return_refunds (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.pos_returns(id) on delete restrict,
  session_id uuid not null references public.pos_register_sessions(id) on delete restrict,
  method_code text not null references public.pos_payment_methods(code) on delete restrict,
  method_name text not null,
  amount numeric(14,2) not null check (amount > 0 and amount < 'Infinity'::numeric),
  created_at timestamptz not null default now()
);

create index pos_returns_sale on public.pos_returns(sale_id, created_at);
create index pos_returns_actor on public.pos_returns(actor_id, created_at);
create index pos_returns_session on public.pos_returns(session_id);
create index pos_return_items_return on public.pos_return_items(return_id);
create index pos_return_items_sale_item on public.pos_return_items(sale_item_id);
create index pos_return_refunds_return on public.pos_return_refunds(return_id);
create index pos_return_refunds_drawer on public.pos_return_refunds(session_id, method_code);
create index pos_return_refunds_method_fk on public.pos_return_refunds(method_code);

-- Identity sequences inherit separate grants; table RLS/revokes do not cover them.
do $$ declare return_number_sequence text; begin
  return_number_sequence := pg_catalog.pg_get_serial_sequence('public.pos_returns', 'return_number');
  if return_number_sequence is null then
    raise exception 'POS return_number identity sequence is missing';
  end if;
  execute pg_catalog.format('revoke all privileges on sequence %s from public, anon, authenticated', return_number_sequence);
end $$;

do $$ declare t text; begin
  foreach t in array array['pos_returns','pos_return_items','pos_return_refunds'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- A cashier sees returns they made and returns made against their own sales
-- (the sale lookup below is itself filtered by the pos_sales read policy).
create policy pos_returns_read on public.pos_returns for select to authenticated
  using (public.pos_role() = 'admin' or (public.pos_role() = 'cashier' and (actor_id = (select auth.uid())
    or exists (select 1 from public.pos_sales s where s.id = sale_id))));
create policy pos_return_items_read on public.pos_return_items for select to authenticated
  using (exists (select 1 from public.pos_returns r where r.id = return_id));
create policy pos_return_refunds_read on public.pos_return_refunds for select to authenticated
  using (exists (select 1 from public.pos_returns r where r.id = return_id));

create function public.pos_returns_immutable() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin raise exception 'RETURN_IMMUTABLE'; end $$;
do $$ declare t text; begin
  foreach t in array array['pos_returns','pos_return_items','pos_return_refunds'] loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.pos_returns_immutable()', t || '_no_change', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.pos_returns_immutable()', t || '_no_truncate', t);
  end loop;
end $$;

-- Ledger: a wholesale return first reduces the sale's open debt ("return_credit").
alter table public.pos_customer_transactions add column return_id uuid references public.pos_returns(id) on delete restrict;
do $$ declare c record; begin
  for c in select conname from pg_catalog.pg_constraint
    where conrelid = 'public.pos_customer_transactions'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) like '%sale_charge%' loop
    execute format('alter table public.pos_customer_transactions drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.pos_customer_transactions
  add constraint pos_ledger_kind check (kind in ('sale_charge','sale_payment','repayment','return_credit')),
  add constraint pos_ledger_shape check (
    (kind = 'sale_charge' and amount >= 0 and amount < 'Infinity'::numeric and payment_id is null and return_id is null)
    or (kind in ('sale_payment','repayment') and amount < 0 and amount > '-Infinity'::numeric and payment_id is not null and return_id is null)
    or (kind = 'return_credit' and amount < 0 and amount > '-Infinity'::numeric and payment_id is null and return_id is not null));
create unique index pos_one_return_credit on public.pos_customer_transactions(return_id) where kind = 'return_credit';
create index pos_ledger_return_fk on public.pos_customer_transactions(return_id) where return_id is not null;

-- Cash drawer: cash refunds leave the drawer. Callers authorize before invoking.
drop function public.pos_session_cash_totals(uuid);
create function public.pos_session_cash_totals(p_session uuid)
returns table(cash_payments numeric, cash_withdrawals numeric, cash_refunds numeric, expected_cash numeric)
language sql stable security definer set search_path = '' as $$
  select c.amount, w.amount, rf.amount, s.opening_cash + c.amount - w.amount - rf.amount
  from public.pos_register_sessions s
  cross join lateral (select coalesce(sum(p.amount),0) amount from public.pos_payments p
    where p.session_id = s.id and p.method_code = 'cash') c
  cross join lateral (select coalesce(sum(p.amount),0) amount from public.pos_cash_withdrawals p
    where p.session_id = s.id) w
  cross join lateral (select coalesce(sum(p.amount),0) amount from public.pos_return_refunds p
    where p.session_id = s.id and p.method_code = 'cash') rf
  where s.id = p_session;
$$;

-- Any active POS user may look a sale up by its number for a return; the RPC
-- returns only what the return screen needs (no payments, no cashier data).
create function public.pos_return_sale_details(p_number bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := public.pos_require_actor(); sale public.pos_sales; debt numeric := 0;
begin
  select * into sale from public.pos_sales where sale_number = p_number;
  if not found then return null; end if;
  if sale.sale_type = 'wholesale' then
    select greatest(coalesce(sum(t.amount),0),0) into debt from public.pos_customer_transactions t where t.sale_id = sale.id;
  end if;
  return jsonb_build_object(
    'sale', jsonb_build_object('id', sale.id, 'sale_number', sale.sale_number, 'sale_type', sale.sale_type,
      'customer_name', sale.customer_name, 'total', sale.total, 'created_at', sale.created_at),
    'current_debt', debt,
    'items', (select coalesce(jsonb_agg(x order by x.line_number), '[]'::jsonb) from (
      select i.id, i.line_number, i.sku, i.product_name, i.variant_name, i.quantity, i.final_unit_price, i.line_total,
        coalesce(r.qty,0) as returned_quantity, coalesce(r.amt,0) as returned_amount
      from public.pos_sale_items i
      left join lateral (select sum(ri.quantity) qty, sum(ri.amount) amt from public.pos_return_items ri
        where ri.sale_item_id = i.id) r on true
      where i.sale_id = sale.id) x));
end $$;

create function public.pos_complete_return(p_request uuid, p_session uuid, p_sale uuid,
  p_items jsonb, p_refunds jsonb, p_reason text) returns uuid
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare actor uuid := public.pos_require_actor(); s public.pos_register_sessions; sale public.pos_sales;
  previous public.pos_returns; reason text; item jsonb; ref jsonb; normalized_items jsonb := '[]'; normalized_refunds jsonb := '[]';
  fingerprint text; sale_item public.pos_sale_items; qty numeric; remaining numeric; ret_qty numeric; ret_amt numeric;
  line_amount numeric; total numeric := 0; debt numeric := 0; dr numeric; refund_total numeric; refund_sum numeric := 0;
  cash_refund numeric := 0; amount numeric; method public.pos_payment_methods; available numeric;
  result uuid := gen_random_uuid(); lines jsonb := '[]'; uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'UNSUPPORTED_TRANSACTION_ISOLATION';
  end if;
  if p_request is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  if p_session is null then raise exception 'OPEN_SESSION_REQUIRED'; end if;
  if p_sale is null then raise exception 'SALE_NOT_FOUND'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text, 0));
  reason := pg_catalog.regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if reason is null or length(reason) not between 1 and 500 then raise exception 'INVALID_RETURN_REASON'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 500
    or jsonb_typeof(p_refunds) is distinct from 'array' or jsonb_array_length(p_refunds) > 5 then
    raise exception 'INVALID_RETURN_ROWS';
  end if;
  for item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) is distinct from 'object' or item->>'sale_item_id' is null or item->>'sale_item_id' !~ uuid_re then
      raise exception 'INVALID_RETURN_ROWS';
    end if;
    normalized_items := normalized_items || jsonb_build_array(jsonb_build_object(
      'sale_item_id', lower(item->>'sale_item_id'), 'quantity', trim_scale(public.pos_decimal(item->>'quantity', 3, true))));
  end loop;
  if exists(select 1 from jsonb_array_elements(normalized_items) x group by x->>'sale_item_id' having count(*) > 1) then
    raise exception 'DUPLICATE_RETURN_ITEM';
  end if;
  for ref in select * from jsonb_array_elements(p_refunds) loop
    if jsonb_typeof(ref) is distinct from 'object' or ref->>'method' is null then raise exception 'INVALID_RETURN_ROWS'; end if;
    normalized_refunds := normalized_refunds || jsonb_build_array(jsonb_build_object(
      'method', ref->>'method', 'amount', trim_scale(public.pos_decimal(ref->>'amount', 2, true))));
  end loop;
  select coalesce(jsonb_agg(x order by x->>'sale_item_id'), '[]'::jsonb) into normalized_items from jsonb_array_elements(normalized_items) x;
  select coalesce(jsonb_agg(x order by x->>'method', (x->>'amount')::numeric), '[]'::jsonb) into normalized_refunds from jsonb_array_elements(normalized_refunds) x;
  fingerprint := encode(sha256(convert_to(jsonb_build_object('version', 1, 'operation', 'return', 'actor', actor,
    'session', p_session, 'sale', p_sale, 'items', normalized_items, 'refunds', normalized_refunds, 'reason', reason)::text, 'UTF8')), 'hex');
  select * into previous from public.pos_returns where request_id = p_request;
  if found then
    if previous.actor_id <> actor or previous.request_fingerprint is distinct from fingerprint then raise exception 'REQUEST_CONFLICT'; end if;
    return previous.id; -- Successful historical retries also work after close.
  end if;
  select * into s from public.pos_register_sessions where id = p_session for update;
  if s.id is null or s.status <> 'open' or s.cashier_id <> actor then raise exception 'OPEN_SESSION_REQUIRED'; end if;
  select * into sale from public.pos_sales where id = p_sale for update;
  if sale.id is null then raise exception 'SALE_NOT_FOUND'; end if;
  for item in select * from jsonb_array_elements(normalized_items) loop
    select * into sale_item from public.pos_sale_items where id = (item->>'sale_item_id')::uuid and sale_id = sale.id;
    if not found then raise exception 'INVALID_RETURN_ITEM'; end if;
    select coalesce(sum(ri.quantity), 0), coalesce(sum(ri.amount), 0) into ret_qty, ret_amt
      from public.pos_return_items ri where ri.sale_item_id = sale_item.id;
    remaining := sale_item.quantity - ret_qty;
    qty := (item->>'quantity')::numeric;
    if qty > remaining then raise exception 'RETURN_QUANTITY_EXCEEDED'; end if;
    -- The last unit returns exactly what is left of the line, so cents never drift.
    line_amount := case when qty = remaining then sale_item.line_total - ret_amt
      else least(round(sale_item.final_unit_price * qty, 2), sale_item.line_total - ret_amt) end;
    total := total + line_amount;
    lines := lines || jsonb_build_array(jsonb_build_object('item', sale_item.id, 'quantity', qty, 'amount', line_amount));
  end loop;
  if sale.sale_type = 'wholesale' then
    select greatest(coalesce(sum(t.amount), 0), 0) into debt from public.pos_customer_transactions t where t.sale_id = sale.id;
  end if;
  dr := least(total, debt);
  refund_total := total - dr;
  for ref in select * from jsonb_array_elements(normalized_refunds) loop
    amount := public.pos_decimal(ref->>'amount', 2);
    perform 1 from public.pos_payment_methods where code = ref->>'method' and active for share;
    if not found then raise exception 'PAYMENT_METHOD_UNAVAILABLE'; end if;
    refund_sum := refund_sum + amount;
    if ref->>'method' = 'cash' then cash_refund := cash_refund + amount; end if;
  end loop;
  if refund_sum <> refund_total then raise exception 'REFUND_TOTAL_MISMATCH'; end if;
  if cash_refund > 0 then
    select t.expected_cash into available from public.pos_session_cash_totals(s.id) t;
    if cash_refund > available then raise exception 'INSUFFICIENT_CASH'; end if;
  end if;
  insert into public.pos_returns(id, request_id, request_fingerprint, sale_id, session_id, actor_id, actor_name,
    reason, total_amount, debt_reduction, refund_total)
  values(result, p_request, fingerprint, sale.id, s.id, actor, (select full_name from public.pos_profiles where id = actor),
    reason, total, dr, refund_total);
  for item in select * from jsonb_array_elements(lines) loop
    insert into public.pos_return_items(return_id, sale_item_id, quantity, amount)
      values(result, (item->>'item')::uuid, (item->>'quantity')::numeric, (item->>'amount')::numeric);
  end loop;
  for ref in select * from jsonb_array_elements(normalized_refunds) loop
    select * into method from public.pos_payment_methods where code = ref->>'method';
    insert into public.pos_return_refunds(return_id, session_id, method_code, method_name, amount)
      values(result, s.id, method.code, method.name, (ref->>'amount')::numeric);
  end loop;
  if dr > 0 then
    insert into public.pos_customer_transactions(customer_id, sale_id, return_id, kind, amount)
      values(sale.customer_id, sale.id, result, 'return_credit', -dr);
  end if;
  return result;
end $$;

-- Register state/report replacements: add cash_refunds to the cash summary.
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

        c.cash_payments, c.cash_withdrawals, c.cash_refunds, c.expected_cash,

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
        c.cash_payments,c.cash_withdrawals,c.cash_refunds,
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



revoke all on function public.pos_returns_immutable(), public.pos_session_cash_totals(uuid),
  public.pos_return_sale_details(bigint), public.pos_complete_return(uuid,uuid,uuid,jsonb,jsonb,text),
  public.pos_register_state(), public.pos_register_session_report(timestamptz,timestamptz,uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.pos_return_sale_details(bigint), public.pos_complete_return(uuid,uuid,uuid,jsonb,jsonb,text),
  public.pos_register_state(), public.pos_register_session_report(timestamptz,timestamptz,uuid,uuid,text) to authenticated;
commit;
