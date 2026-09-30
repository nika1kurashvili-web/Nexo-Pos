-- Phase 1. Review and apply manually as database owner. Never run from the app.
begin;
set local lock_timeout = '10s';

-- Compile-time catalog checks and type derivation avoid assuming UUID catalog IDs.
do $$ begin
  -- Ordinary ownership does not bypass FORCE RLS.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = current_user
    and (rolsuper or rolbypassrls)) then
    raise exception 'POS migration owner must have BYPASSRLS or superuser privileges';
  end if;
  perform id, name, sku, price, active from public.products limit 0;
  perform id, product_id, name, sku, price, active from public.product_variants limit 0;
  if not has_table_privilege('authenticated','public.products','SELECT')
    or not has_table_privilege('authenticated','public.product_variants','SELECT') then
    raise exception 'Verify authenticated catalog SELECT grants before installing POS';
  end if;
  if not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.product_variants'::regclass
    and polpermissive and polcmd in ('r','*') and pg_catalog.pg_get_expr(polqual,polrelid) = 'true'
    and (0 = any(polroles) or (select oid from pg_catalog.pg_roles where rolname = 'authenticated') = any(polroles))) then
    raise exception 'Verify the existing authenticated variants SELECT true policy before installing POS';
  end if;
  if exists (select 1 from pg_catalog.pg_policy where polrelid in
    ('public.products'::regclass, 'public.product_variants'::regclass)
    and not polpermissive and polcmd in ('r', '*')) then
    raise exception 'Review restrictive catalog SELECT policies before installing POS RPCs';
  end if;
end $$;

-- The only explicit existing-catalog policy change is this approved SELECT policy.
-- New foreign keys below also install catalog referential-integrity triggers.
create policy pos_active_users_select_products
on public.products as permissive for select to authenticated
using (exists (select 1 from public.pos_profiles pp
  where pp.id = (select auth.uid()) and pp.active = true));

create function public.pos_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.pos_profiles where id = auth.uid() and active = true;
$$;

-- Finance entry points lock the profile so concurrent deactivation cannot race
-- a transaction that has already passed authorization.
create function public.pos_require_actor(p_admin boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid; actor_role text;
begin
  select id, role into actor, actor_role from public.pos_profiles
    where id = auth.uid() and active = true for share;
  if actor is null or actor_role not in ('admin', 'cashier') or (p_admin and actor_role <> 'admin') then
    raise exception 'POS_ACCESS_DENIED' using errcode = '42501';
  end if;
  return actor;
end $$;

create function public.pos_decimal(p_value text, p_scale integer, p_positive boolean default false)
returns numeric language plpgsql immutable set search_path = '' as $$
declare result numeric;
begin
  if p_value is null or p_value !~ '^[0-9]+([.][0-9]+)?$' then
    raise exception 'INVALID_DECIMAL';
  end if;
  result := p_value::numeric;
  if result > 9999999999.99 or result <> round(result, p_scale) or (p_positive and result <= 0) then
    raise exception 'INVALID_DECIMAL';
  end if;
  return result;
end $$;

create table public.pos_business_customers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  tax_code text unique, phone text, address text, email text, notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.pos_registers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) between 1 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.pos_payment_methods (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{0,31}$'),
  name text not null check (length(btrim(name)) between 1 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
insert into public.pos_payment_methods(code, name) values
 ('cash','ნაღდი'), ('tbc','TBC'), ('bog','საქართველოს ბანკი'),
 ('liberty','Liberty'), ('onway','OnWay'), ('other','სხვა');

create table public.pos_customer_prices as
  select p.id as product_id, v.id as variant_id from public.products p
  cross join public.product_variants v with no data;
alter table public.pos_customer_prices
  add column id uuid primary key default gen_random_uuid(),
  add column customer_id uuid not null references public.pos_business_customers(id) on delete restrict,
  add column price numeric(14,2) not null check (price >= 0 and price < 'Infinity'::numeric),
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add constraint pos_price_target check (num_nonnulls(product_id, variant_id) = 1),
  add foreign key (product_id) references public.products(id) on delete cascade,
  add foreign key (variant_id) references public.product_variants(id) on delete cascade;
create unique index pos_price_product_unique on public.pos_customer_prices(customer_id, product_id) where product_id is not null;
create unique index pos_price_variant_unique on public.pos_customer_prices(customer_id, variant_id) where variant_id is not null;

create table public.pos_register_sessions (
  id uuid primary key default gen_random_uuid(),
  register_id uuid not null references public.pos_registers(id) on delete restrict,
  cashier_id uuid not null references public.pos_profiles(id) on delete restrict,
  opened_at timestamptz not null default now(),
  opening_cash numeric(14,2) not null check (opening_cash >= 0 and opening_cash < 'Infinity'::numeric),
  closed_at timestamptz, expected_closing_cash numeric(14,2), actual_closing_cash numeric(14,2),
  cash_difference numeric(14,2), closing_note text,
  status text not null default 'open' check (status in ('open','closed')),
  check ((status = 'open' and closed_at is null and expected_closing_cash is null and actual_closing_cash is null and cash_difference is null)
    or (status = 'closed' and closed_at is not null and closed_at >= opened_at
      and expected_closing_cash is not null and expected_closing_cash >= 0 and expected_closing_cash < 'Infinity'::numeric
      and actual_closing_cash is not null and actual_closing_cash >= 0 and actual_closing_cash < 'Infinity'::numeric
      and cash_difference is not null and cash_difference = actual_closing_cash - expected_closing_cash))
);
create unique index pos_one_open_register on public.pos_register_sessions(register_id) where status = 'open';
create unique index pos_one_open_cashier on public.pos_register_sessions(cashier_id) where status = 'open';

create table public.pos_sales (
  id uuid primary key default gen_random_uuid(),
  sale_number bigint generated always as identity unique,
  request_id uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  cashier_id uuid not null references public.pos_profiles(id) on delete restrict,
  cashier_name text not null,
  session_id uuid not null references public.pos_register_sessions(id) on delete restrict,
  sale_type text not null check (sale_type in ('retail','wholesale')),
  customer_id uuid references public.pos_business_customers(id) on delete restrict,
  customer_name text, customer_tax_code text,
  tracking_code text check (length(tracking_code) <= 200),
  subtotal numeric(14,2) not null, discount_total numeric(14,2) not null,
  total numeric(14,2) not null, paid_total numeric(14,2) not null, debt_amount numeric(14,2) not null,
  status text not null default 'completed' check (status = 'completed'),
  created_at timestamptz not null default now(),
  check (sale_type <> 'wholesale' or customer_id is not null),
  check (subtotal >= 0 and subtotal < 'Infinity'::numeric and discount_total between 0 and subtotal
    and total = subtotal - discount_total and paid_total between 0 and total and debt_amount = total - paid_total),
  check (sale_type <> 'retail' or debt_amount = 0)
);
create index pos_sales_customer on public.pos_sales(customer_id, created_at);
create index pos_sales_session on public.pos_sales(session_id);

-- Identity sequences inherit separate grants; table RLS/revokes do not cover them.
-- Resolve the actual schema-qualified sequence name rather than assuming its name.
do $$ declare sale_number_sequence text; begin
  sale_number_sequence := pg_catalog.pg_get_serial_sequence('public.pos_sales', 'sale_number');
  if sale_number_sequence is null then
    raise exception 'POS sale_number identity sequence is missing';
  end if;
  execute pg_catalog.format('revoke all privileges on sequence %s from public, anon, authenticated', sale_number_sequence);
end $$;

create table public.pos_sale_items as select p.id as product_id, v.id as variant_id
  from public.products p cross join public.product_variants v with no data;
alter table public.pos_sale_items
  add column id uuid primary key default gen_random_uuid(),
  add column sale_id uuid not null references public.pos_sales(id) on delete restrict,
  add column line_number integer not null check (line_number > 0),
  add column target_kind text not null check (target_kind in ('product','variant')),
  add column sku text, add column product_name text not null, add column variant_name text,
  add column base_unit_price numeric(14,2) not null check (base_unit_price >= 0 and base_unit_price < 'Infinity'::numeric),
  add column adjusted_unit_price numeric(14,2) not null check (adjusted_unit_price >= 0 and adjusted_unit_price < 'Infinity'::numeric),
  add column quantity numeric(14,3) not null check (quantity > 0 and quantity < 'Infinity'::numeric),
  add column discount_percent numeric(5,2) not null check (discount_percent between 0 and 100),
  add column final_unit_price numeric(14,2) not null,
  add column line_total numeric(14,2) not null,
  add column created_at timestamptz not null default now(),
  add unique (sale_id, line_number),
  add foreign key (product_id) references public.products(id) on delete set null,
  add foreign key (variant_id) references public.product_variants(id) on delete set null,
  add check (final_unit_price = round(adjusted_unit_price * (1 - discount_percent / 100), 2)
    and line_total = round(final_unit_price * quantity, 2));

create table public.pos_payments (
  id uuid primary key default gen_random_uuid(), request_id uuid not null unique,
  request_fingerprint text,
  sale_id uuid not null references public.pos_sales(id) on delete restrict,
  session_id uuid not null references public.pos_register_sessions(id) on delete restrict,
  received_by uuid not null references public.pos_profiles(id) on delete restrict,
  method_code text not null references public.pos_payment_methods(code) on delete restrict,
  method_name text not null,
  kind text not null check (kind in ('sale_payment','repayment')),
  check ((kind = 'repayment' and request_fingerprint is not null and request_fingerprint ~ '^[0-9a-f]{64}$')
    or (kind = 'sale_payment' and request_fingerprint is null)),
  amount numeric(14,2) not null check (amount > 0 and amount < 'Infinity'::numeric),
  created_at timestamptz not null default now()
);
create index pos_payments_drawer on public.pos_payments(session_id, method_code);
create index pos_payments_sale on public.pos_payments(sale_id);

create table public.pos_customer_transactions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.pos_business_customers(id) on delete restrict,
  sale_id uuid not null references public.pos_sales(id) on delete restrict,
  payment_id uuid unique references public.pos_payments(id) on delete restrict,
  kind text not null check (kind in ('sale_charge','sale_payment','repayment')),
  amount numeric(14,2) not null,
  created_at timestamptz not null default now(),
  check ((kind = 'sale_charge' and amount >= 0 and amount < 'Infinity'::numeric and payment_id is null)
    or (kind in ('sale_payment','repayment') and amount < 0 and amount > '-Infinity'::numeric and payment_id is not null))
);
create unique index pos_one_sale_charge on public.pos_customer_transactions(sale_id) where kind = 'sale_charge';
create index pos_customer_ledger on public.pos_customer_transactions(customer_id, created_at);

-- No DELETE privileges anywhere. Financial tables have no direct write grants.
-- Existing partial/composite indexes do not cover these full-history/FK directions.
create index pos_prices_product_fk on public.pos_customer_prices(product_id) where product_id is not null;
create index pos_prices_variant_fk on public.pos_customer_prices(variant_id) where variant_id is not null;
create index pos_prices_customer_fk on public.pos_customer_prices(customer_id);
create index pos_sessions_register_fk on public.pos_register_sessions(register_id);
create index pos_sessions_cashier_history on public.pos_register_sessions(cashier_id, opened_at);
create index pos_sales_cashier_history on public.pos_sales(cashier_id, created_at);
create index pos_items_product_fk on public.pos_sale_items(product_id) where product_id is not null;
create index pos_items_variant_fk on public.pos_sale_items(variant_id) where variant_id is not null;
create index pos_payments_actor_history on public.pos_payments(received_by, created_at);
create index pos_payments_method_fk on public.pos_payments(method_code);
create index pos_ledger_sale on public.pos_customer_transactions(sale_id, created_at);

do $$ declare t text; begin
  foreach t in array array['pos_business_customers','pos_customer_prices','pos_registers',
    'pos_payment_methods','pos_register_sessions','pos_sales','pos_sale_items','pos_payments','pos_customer_transactions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

create policy pos_customers_read on public.pos_business_customers for select to authenticated
 using (public.pos_role() = 'admin' or (public.pos_role() = 'cashier' and active));
create policy pos_prices_read on public.pos_customer_prices for select to authenticated
 using (public.pos_role() = 'admin' or (public.pos_role() = 'cashier' and exists
   (select 1 from public.pos_business_customers c where c.id = customer_id and c.active)));
create policy pos_registers_read on public.pos_registers for select to authenticated
 using (public.pos_role() = 'admin' or (public.pos_role() = 'cashier' and active));
create policy pos_methods_read on public.pos_payment_methods for select to authenticated
 using (public.pos_role() = 'admin' or (public.pos_role() = 'cashier' and active));
create policy pos_sessions_read on public.pos_register_sessions for select to authenticated
 using (public.pos_role() = 'admin' or (public.pos_role() = 'cashier' and cashier_id = auth.uid()));
create policy pos_sales_read on public.pos_sales for select to authenticated
 using (public.pos_role() = 'admin' or (public.pos_role() = 'cashier' and cashier_id = auth.uid()));
create policy pos_items_read on public.pos_sale_items for select to authenticated
 using (exists (select 1 from public.pos_sales s where s.id = sale_id));
create policy pos_payments_read on public.pos_payments for select to authenticated
 using (public.pos_role() = 'admin' or (public.pos_role() = 'cashier' and received_by = auth.uid()));
create policy pos_transactions_admin_read on public.pos_customer_transactions for select to authenticated
 using (public.pos_role() = 'admin');

grant insert, update on public.pos_business_customers, public.pos_registers to authenticated;
grant update (name, active) on public.pos_payment_methods to authenticated;
create policy pos_customers_admin_insert on public.pos_business_customers for insert to authenticated with check (public.pos_role() = 'admin');
create policy pos_customers_admin_update on public.pos_business_customers for update to authenticated using (public.pos_role() = 'admin') with check (public.pos_role() = 'admin');
create policy pos_registers_admin_insert on public.pos_registers for insert to authenticated with check (public.pos_role() = 'admin');
create policy pos_registers_admin_update on public.pos_registers for update to authenticated using (public.pos_role() = 'admin') with check (public.pos_role() = 'admin');
create policy pos_methods_admin_update on public.pos_payment_methods for update to authenticated using (public.pos_role() = 'admin') with check (public.pos_role() = 'admin');

do $$ declare t text; begin
  foreach t in array array['pos_business_customers','pos_customer_prices','pos_registers','pos_payment_methods'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.pos_profiles_set_updated_at()', t || '_updated_at', t);
  end loop;
end $$;

create function public.pos_open_register(p_register uuid, p_cash text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := public.pos_require_actor(); result uuid;
begin
  perform 1 from public.pos_registers where id = p_register and active for share;
  if not found then raise exception 'REGISTER_UNAVAILABLE'; end if;
  insert into public.pos_register_sessions(register_id, cashier_id, opening_cash)
    values (p_register, actor, public.pos_decimal(p_cash,2)) returning id into result;
  return result;
end $$;

create function public.pos_close_register(p_session uuid, p_actual text, p_note text default null) returns numeric
language plpgsql security definer set search_path = '' as $$
declare actor uuid := public.pos_require_actor(); s public.pos_register_sessions; expected numeric;
begin
  select * into s from public.pos_register_sessions where id = p_session for update;
  if s.id is null or (s.cashier_id <> actor and public.pos_role() <> 'admin') then raise exception 'SESSION_ACCESS_DENIED'; end if;
  if s.status <> 'open' then raise exception 'SESSION_CLOSED'; end if;
  select s.opening_cash + coalesce(sum(amount),0) into expected from public.pos_payments
    where session_id = s.id and method_code = 'cash';
  update public.pos_register_sessions set status = 'closed', closed_at = now(),
    expected_closing_cash = expected, actual_closing_cash = public.pos_decimal(p_actual,2),
    cash_difference = public.pos_decimal(p_actual,2) - expected, closing_note = left(p_note,2000)
    where id = s.id;
  return expected;
end $$;

-- Internal catalog reader returns only sale-safe fields. Caller entry points
-- require active POS membership, matching the approved products SELECT policy.
create function public.pos_quote(p_kind text, p_target text, p_type text, p_customer uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p record; v record; price numeric; result jsonb;
begin
  perform public.pos_require_actor();
  if p_type is null or p_type not in ('retail','wholesale') then raise exception 'INVALID_SALE_TYPE'; end if;
  if p_kind = 'product' then
    select * into p from public.products where id::text = p_target and active;
    if not found then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
    price := p.price;
    result := jsonb_build_object('product_id', p.id, 'variant_id', null, 'sku',p.sku,'product_name',p.name,'variant_name',null);
  elsif p_kind = 'variant' then
    select * into v from public.product_variants where id::text = p_target and active;
    if not found then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
    select * into p from public.products where id = v.product_id and active;
    if not found then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
    price := v.price;
    result := jsonb_build_object('product_id',p.id,'variant_id',v.id,'sku',v.sku,'product_name',p.name,'variant_name',v.name);
  else raise exception 'INVALID_TARGET'; end if;
  if p_type = 'wholesale' then
    perform 1 from public.pos_business_customers where id = p_customer and active for share;
    if not found then raise exception 'CUSTOMER_UNAVAILABLE'; end if;
    select cp.price into price from public.pos_customer_prices cp where customer_id = p_customer and
      ((p_kind = 'product' and cp.product_id::text = p_target) or (p_kind = 'variant' and cp.variant_id::text = p_target));
    if not found then return result || jsonb_build_object('state','wholesale_price_missing'); end if;
  end if;
  price := public.pos_decimal(price::text,2);
  return result || jsonb_build_object('state','found','price',price::text);
end $$;

create function public.pos_set_customer_prices(p_customer uuid, p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare row_data jsonb; quote jsonb; typed public.pos_customer_prices; n integer := 0;
begin
  perform public.pos_require_actor(true);
  perform 1 from public.pos_business_customers where id = p_customer and active for update;
  if not found then raise exception 'CUSTOMER_UNAVAILABLE'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 2000 then raise exception 'INVALID_PRICE_ROWS'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) x group by x->>'kind', x->>'target' having count(*) > 1) then raise exception 'DUPLICATE_TARGET'; end if;
  for row_data in select * from jsonb_array_elements(p_rows) loop
    quote := public.pos_quote(row_data->>'kind',row_data->>'target','retail');
    typed := jsonb_populate_record(null::public.pos_customer_prices, quote);
    if row_data->>'kind' = 'product' then
      insert into public.pos_customer_prices(customer_id,product_id,price)
        values(p_customer,typed.product_id,public.pos_decimal(row_data->>'price',2))
        on conflict(customer_id,product_id) where product_id is not null do update set price = excluded.price;
    else
      insert into public.pos_customer_prices(customer_id,variant_id,price)
        values(p_customer,typed.variant_id,public.pos_decimal(row_data->>'price',2))
        on conflict(customer_id,variant_id) where variant_id is not null do update set price = excluded.price;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Normalize intent without consulting mutable catalog prices or active flags.
-- Receipt line order matters; payment order and decimal spelling do not.
create function public.pos_normalize_sale_request(p_actor uuid, p_session uuid, p_type text,
  p_customer uuid, p_tracking text, p_items jsonb, p_payments jsonb) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare item jsonb; pay jsonb; normalized_items jsonb := '[]'; normalized_payments jsonb := '[]';
  typed public.pos_sale_items; target text; override_price numeric; discount numeric;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 500
    or jsonb_typeof(p_payments) is distinct from 'array' or jsonb_array_length(p_payments) > 20 then
    raise exception 'INVALID_SALE_ROWS';
  end if;
  for item in select * from jsonb_array_elements(p_items) loop
    if item->>'kind' = 'product' then
      typed := jsonb_populate_record(null::public.pos_sale_items,jsonb_build_object('product_id',item->>'target'));
      target := typed.product_id::text;
    elsif item->>'kind' = 'variant' then
      typed := jsonb_populate_record(null::public.pos_sale_items,jsonb_build_object('variant_id',item->>'target'));
      target := typed.variant_id::text;
    else raise exception 'INVALID_TARGET'; end if;
    if target is null then raise exception 'INVALID_TARGET'; end if;
    override_price := case when item->>'unit_price' is null then null
      else trim_scale(public.pos_decimal(item->>'unit_price',2)) end;
    discount := trim_scale(public.pos_decimal(coalesce(item->>'discount_percent','0'),2));
    if discount > 100 then raise exception 'INVALID_DISCOUNT'; end if;
    normalized_items := normalized_items || jsonb_build_array(jsonb_build_object(
      'kind',item->>'kind','target',target,'quantity',trim_scale(public.pos_decimal(item->>'quantity',3,true)),
      'unit_price',override_price,'discount_percent',discount));
  end loop;
  for pay in select * from jsonb_array_elements(p_payments) loop
    normalized_payments := normalized_payments || jsonb_build_array(jsonb_build_object(
      'method',pay->>'method','amount',trim_scale(public.pos_decimal(pay->>'amount',2))));
  end loop;
  select coalesce(jsonb_agg(x order by x->>'method',(x->>'amount')::numeric),'[]'::jsonb)
    into normalized_payments from jsonb_array_elements(normalized_payments) x;
  return jsonb_build_object('version',1,'operation','sale','actor',p_actor,'session',p_session,
    'type',p_type,'customer',p_customer,'tracking',nullif(btrim(p_tracking),''),
    'items',normalized_items,'payments',normalized_payments);
end $$;

create function public.pos_complete_sale(p_request uuid, p_session uuid, p_type text,
  p_customer uuid, p_tracking text, p_items jsonb, p_payments jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := public.pos_require_actor(); s public.pos_register_sessions; c public.pos_business_customers;
  normalized jsonb; fingerprint text; existing public.pos_sales; sale_id uuid := gen_random_uuid(); item jsonb; pay jsonb; q jsonb;
  item_record public.pos_sale_items; items jsonb := '[]'; qty numeric; base numeric; adjusted numeric;
  discount numeric; final_price numeric; line_total numeric; subtotal numeric := 0; total numeric := 0;
  paid numeric := 0; amount numeric; method public.pos_payment_methods; payment_id uuid; line_no integer := 0;
begin
  if p_request is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text,0));
  normalized := public.pos_normalize_sale_request(actor,p_session,p_type,p_customer,p_tracking,p_items,p_payments);
  fingerprint := encode(sha256(convert_to(normalized::text,'UTF8')),'hex');
  p_items := normalized->'items'; p_payments := normalized->'payments';
  select * into existing from public.pos_sales where request_id = p_request;
  if found then
    if existing.cashier_id <> actor or existing.request_fingerprint is distinct from fingerprint then raise exception 'REQUEST_CONFLICT'; end if;
    return existing.id;
  end if;
  select * into s from public.pos_register_sessions where id = p_session for update;
  if s.id is null or s.status <> 'open' or s.cashier_id <> actor then raise exception 'OPEN_SESSION_REQUIRED'; end if;
  if p_type is null or p_type not in ('retail','wholesale') then raise exception 'INVALID_SALE_TYPE'; end if;
  if p_customer is not null then
    select * into c from public.pos_business_customers where id = p_customer and active for share;
    if not found then raise exception 'CUSTOMER_UNAVAILABLE'; end if;
  elsif p_type = 'wholesale' then raise exception 'WHOLESALE_CUSTOMER_REQUIRED'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 500
    or jsonb_typeof(p_payments) is distinct from 'array' or jsonb_array_length(p_payments) > 20 then raise exception 'INVALID_SALE_ROWS'; end if;
  for item in select * from jsonb_array_elements(p_items) loop
    q := public.pos_quote(item->>'kind', item->>'target', p_type, p_customer);
    if q->>'state' <> 'found' then raise exception 'WHOLESALE_PRICE_MISSING'; end if;
    base := public.pos_decimal(q->>'price',2);
    adjusted := public.pos_decimal(coalesce(item->>'unit_price',base::text),2);
    qty := public.pos_decimal(item->>'quantity',3,true);
    discount := public.pos_decimal(coalesce(item->>'discount_percent','0'),2);
    if discount > 100 then raise exception 'INVALID_DISCOUNT'; end if;
    final_price := round(adjusted * (1 - discount / 100),2);
    line_total := round(final_price * qty,2);
    subtotal := subtotal + round(adjusted * qty,2);
    total := total + line_total;
    line_no := line_no + 1;
    items := items || jsonb_build_array(q || jsonb_build_object('line_number',line_no,'target_kind',item->>'kind',
      'base_unit_price',base,'adjusted_unit_price',adjusted,'quantity',qty,'discount_percent',discount,
      'final_unit_price',final_price,'line_total',line_total));
  end loop;
  for pay in select * from jsonb_array_elements(p_payments) loop
    amount := public.pos_decimal(pay->>'amount',2);
    perform 1 from public.pos_payment_methods where code = pay->>'method' and active for share;
    if not found then raise exception 'PAYMENT_METHOD_UNAVAILABLE'; end if;
    paid := paid + amount;
  end loop;
  if paid > total then raise exception 'OVERPAYMENT_NOT_SUPPORTED'; end if;
  if p_type = 'retail' and paid <> total then raise exception 'RETAIL_FULL_PAYMENT_REQUIRED'; end if;
  insert into public.pos_sales(id,request_id,request_fingerprint,cashier_id,cashier_name,session_id,sale_type,customer_id,
    customer_name,customer_tax_code,tracking_code,subtotal,discount_total,total,paid_total,debt_amount)
  values(sale_id,p_request,fingerprint,actor,(select full_name from public.pos_profiles where id = actor),s.id,p_type,c.id,
    c.name,c.tax_code,nullif(btrim(p_tracking),''),subtotal,subtotal-total,total,paid,total-paid);
  for item in select * from jsonb_array_elements(items) loop
    item_record := jsonb_populate_record(null::public.pos_sale_items,item);
    insert into public.pos_sale_items(sale_id,line_number,target_kind,product_id,variant_id,sku,product_name,variant_name,
      base_unit_price,adjusted_unit_price,quantity,discount_percent,final_unit_price,line_total)
    values(sale_id,item_record.line_number,item_record.target_kind,item_record.product_id,item_record.variant_id,
      item_record.sku,item_record.product_name,item_record.variant_name,item_record.base_unit_price,
      item_record.adjusted_unit_price,item_record.quantity,item_record.discount_percent,item_record.final_unit_price,item_record.line_total);
  end loop;
  if p_type = 'wholesale' then
    insert into public.pos_customer_transactions(customer_id,sale_id,kind,amount) values(c.id,sale_id,'sale_charge',total);
  end if;
  for pay in select * from jsonb_array_elements(p_payments) loop
    amount := public.pos_decimal(pay->>'amount',2);
    if amount = 0 then continue; end if;
    select * into method from public.pos_payment_methods where code = pay->>'method';
    insert into public.pos_payments(request_id,sale_id,session_id,received_by,method_code,method_name,kind,amount)
      values(gen_random_uuid(),sale_id,s.id,actor,method.code,method.name,'sale_payment',amount) returning id into payment_id;
    if p_type = 'wholesale' then
      insert into public.pos_customer_transactions(customer_id,sale_id,payment_id,kind,amount)
        values(c.id,sale_id,payment_id,'sale_payment',-amount);
    end if;
  end loop;
  return sale_id;
end $$;

create function public.pos_record_repayment(p_request uuid, p_sale uuid, p_session uuid, p_method text, p_amount text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid := public.pos_require_actor(); s public.pos_register_sessions; sale public.pos_sales;
  method public.pos_payment_methods; previous public.pos_payments; balance numeric; amount numeric; result uuid; fingerprint text;
begin
  if p_request is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text,0));
  amount := public.pos_decimal(p_amount,2,true);
  fingerprint := encode(sha256(convert_to(jsonb_build_object('version',1,'operation','repayment',
    'actor',actor,'sale',p_sale,'session',p_session,'method',p_method,'amount',trim_scale(amount))::text,'UTF8')),'hex');
  select * into previous from public.pos_payments where request_id = p_request;
  if found then
    if previous.received_by <> actor or previous.kind <> 'repayment' or previous.request_fingerprint is distinct from fingerprint then raise exception 'REQUEST_CONFLICT'; end if;
    return previous.id;
  end if;
  select * into s from public.pos_register_sessions where id = p_session for update;
  if s.id is null or s.status <> 'open' or s.cashier_id <> actor then raise exception 'OPEN_SESSION_REQUIRED'; end if;
  select * into sale from public.pos_sales where id = p_sale for update;
  if sale.id is null or sale.sale_type <> 'wholesale' then raise exception 'WHOLESALE_SALE_REQUIRED'; end if;
  -- Cashiers operate on their own sales; broader debt collection UI is deferred.
  if sale.cashier_id <> actor and public.pos_role() <> 'admin' then raise exception 'SALE_ACCESS_DENIED'; end if;
  amount := public.pos_decimal(p_amount,2,true);
  select coalesce(sum(t.amount),0) into balance from public.pos_customer_transactions t where t.sale_id = sale.id;
  if amount > balance then raise exception 'OVERPAYMENT_NOT_SUPPORTED'; end if;
  select * into method from public.pos_payment_methods where code = p_method and active for share;
  if not found then raise exception 'PAYMENT_METHOD_UNAVAILABLE'; end if;
  insert into public.pos_payments(request_id,request_fingerprint,sale_id,session_id,received_by,method_code,method_name,kind,amount)
    values(p_request,fingerprint,sale.id,s.id,actor,method.code,method.name,'repayment',amount) returning id into result;
  insert into public.pos_customer_transactions(customer_id,sale_id,payment_id,kind,amount)
    values(sale.customer_id,sale.id,result,'repayment',-amount);
  return result;
end $$;

-- Confirmation re-matches SKUs in the database; never trust a stale preview's IDs.
create function public.pos_import_customer_prices(p_customer uuid, p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare row_data jsonb; matches jsonb; resolved jsonb := '[]';
begin
  perform public.pos_require_actor(true);
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 2000 then raise exception 'INVALID_PRICE_ROWS'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) x group by btrim(x->>'sku') having count(*) > 1) then raise exception 'DUPLICATE_SKU'; end if;
  for row_data in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(row_data->'sku') is distinct from 'string' or nullif(btrim(row_data->>'sku'),'') is null then raise exception 'INVALID_SKU'; end if;
    select jsonb_agg(jsonb_build_object('kind',kind,'target',target,'price',row_data->>'price')) into matches
      from (
        select 'product' as kind, id::text as target from public.products where btrim(sku) = btrim(row_data->>'sku') and active
        union all
        select 'variant', v.id::text from public.product_variants v join public.products p on p.id = v.product_id
          where btrim(v.sku) = btrim(row_data->>'sku') and v.active and p.active
      ) targets;
    if matches is null then raise exception 'SKU_NOT_FOUND'; end if;
    if jsonb_array_length(matches) <> 1 then raise exception 'SKU_CONFLICT'; end if;
    resolved := resolved || matches;
  end loop;
  return public.pos_set_customer_prices(p_customer,resolved);
end $$;

create function public.pos_customer_balance(p_customer uuid) returns numeric
language plpgsql security definer set search_path = '' as $$
begin
  perform public.pos_require_actor(true);
  return (select coalesce(sum(amount),0) from public.pos_customer_transactions where customer_id = p_customer);
end $$;

-- Revoke PostgreSQL's default PUBLIC execute; expose only deliberate RPCs.
revoke all on function public.pos_normalize_sale_request(uuid,uuid,text,uuid,text,jsonb,jsonb),
 public.pos_role(), public.pos_require_actor(boolean), public.pos_decimal(text,integer,boolean),
 public.pos_open_register(uuid,text), public.pos_close_register(uuid,text,text), public.pos_quote(text,text,text,uuid),
 public.pos_set_customer_prices(uuid,jsonb), public.pos_complete_sale(uuid,uuid,text,uuid,text,jsonb,jsonb),
 public.pos_record_repayment(uuid,uuid,uuid,text,text), public.pos_import_customer_prices(uuid,jsonb),
 public.pos_customer_balance(uuid) from public, anon, authenticated;
grant execute on function public.pos_role(), public.pos_open_register(uuid,text), public.pos_close_register(uuid,text,text),
 public.pos_quote(text,text,text,uuid), public.pos_set_customer_prices(uuid,jsonb),
 public.pos_complete_sale(uuid,uuid,text,uuid,text,jsonb,jsonb), public.pos_record_repayment(uuid,uuid,uuid,text,text),
 public.pos_import_customer_prices(uuid,jsonb), public.pos_customer_balance(uuid) to authenticated;

commit;
