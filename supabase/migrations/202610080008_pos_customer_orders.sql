-- ბიზნეს კლიენტის შეკვეთები და ეტაპობრივი დაფარვა (მხოლოდ ადმინისთვის).
-- შეკვეთა სრულიად განცალკევებულია: არ ეხება სალაროს (pos_sales, pos_payments,
-- pos_register_sessions), მარაგს (pos_stock_movements), კლიენტის ვალის ledger-ს
-- (pos_customer_transactions) და ანალიტიკას/შემოსავლებს.
begin;
set local lock_timeout = '10s';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Run this migration as the Supabase owner role (postgres); it must bypass RLS.';
  end if;
  if to_regprocedure('public.pos_require_actor(boolean)') is null then
    raise exception 'Missing prerequisite: public.pos_require_actor(boolean)';
  end if;
  if to_regprocedure('public.pos_decimal(text,integer,boolean)') is null then
    raise exception 'Missing prerequisite: public.pos_decimal(text,integer,boolean)';
  end if;
  if to_regclass('public.pos_business_customers') is null then
    raise exception 'Missing prerequisite: public.pos_business_customers';
  end if;
end $$;

create table public.pos_customer_orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity unique,
  request_id uuid not null unique,
  customer_id uuid not null references public.pos_business_customers(id) on delete restrict,
  order_date date not null,
  note text check (note is null or length(note) between 1 and 500),
  total numeric(14,2) not null check (total >= 0),
  actor_id uuid not null references public.pos_profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index pos_customer_orders_customer on public.pos_customer_orders(customer_id, order_date desc, id);
create index pos_customer_orders_actor on public.pos_customer_orders(actor_id);

create table public.pos_customer_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.pos_customer_orders(id) on delete cascade,
  line_no integer not null check (line_no > 0),
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  name text not null check (length(name) between 1 and 400),
  sku text,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  line_total numeric(14,2) not null check (line_total >= 0),
  unique (order_id, line_no)
);
create index pos_customer_order_items_product on public.pos_customer_order_items(product_id);
create index pos_customer_order_items_variant on public.pos_customer_order_items(variant_id);

create table public.pos_customer_order_payments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  order_id uuid not null references public.pos_customer_orders(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  paid_on date not null,
  actor_id uuid not null references public.pos_profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index pos_customer_order_payments_order on public.pos_customer_order_payments(order_id, paid_on, created_at);
create index pos_customer_order_payments_actor on public.pos_customer_order_payments(actor_id);

-- მხოლოდ ადმინი კითხულობს; ცვლილება მხოლოდ ქვემოთ მოცემული RPC-ებით.
alter table public.pos_customer_orders enable row level security;
alter table public.pos_customer_orders force row level security;
alter table public.pos_customer_order_items enable row level security;
alter table public.pos_customer_order_items force row level security;
alter table public.pos_customer_order_payments enable row level security;
alter table public.pos_customer_order_payments force row level security;
revoke all on public.pos_customer_orders, public.pos_customer_order_items, public.pos_customer_order_payments
  from public, anon, authenticated, service_role;
grant select on public.pos_customer_orders, public.pos_customer_order_items, public.pos_customer_order_payments
  to authenticated;
create policy pos_customer_orders_admin_read on public.pos_customer_orders for select to authenticated
  using (public.pos_role() = 'admin');
create policy pos_customer_order_items_admin_read on public.pos_customer_order_items for select to authenticated
  using (public.pos_role() = 'admin');
create policy pos_customer_order_payments_admin_read on public.pos_customer_order_payments for select to authenticated
  using (public.pos_role() = 'admin');

-- p_items: [{kind:'product'|'variant', target:uuid, quantity:'1.5', unit_price:'12.00'}]
create function public.pos_create_customer_order(
  p_request uuid, p_customer uuid, p_date date, p_note text, p_items jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.pos_require_actor(true);
  note text;
  item jsonb;
  existing public.pos_customer_orders;
  p public.products;
  v public.product_variants;
  qty numeric; price numeric; line numeric;
  order_total numeric := 0;
  order_id uuid := gen_random_uuid();
  line_no integer := 0;
  seen text[] := '{}';
begin
  if p_request is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text, 0));
  select * into existing from public.pos_customer_orders where request_id = p_request;
  if found then
    if existing.customer_id is distinct from p_customer then raise exception 'REQUEST_CONFLICT'; end if;
    return existing.id; -- ორმაგი გაგზავნა იგივე შეკვეთას აბრუნებს.
  end if;
  if p_customer is null or not exists (select 1 from public.pos_business_customers where id = p_customer) then
    raise exception 'CUSTOMER_NOT_FOUND';
  end if;
  if p_date is null then raise exception 'INVALID_DATE'; end if;
  note := nullif(pg_catalog.regexp_replace(coalesce(p_note, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  if note is not null and length(note) > 500 then raise exception 'INVALID_NOTE'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    raise exception 'INVALID_ORDER_ROWS';
  end if;

  insert into public.pos_customer_orders(id, request_id, customer_id, order_date, note, total, actor_id)
    values (order_id, p_request, p_customer, p_date, note, 0, actor);

  for item in select * from jsonb_array_elements(p_items) loop
    line_no := line_no + 1;
    if jsonb_typeof(item) is distinct from 'object'
      or item->>'kind' is null or item->>'kind' not in ('product', 'variant')
      or coalesce(item->>'target', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'INVALID_TARGET';
    end if;
    if (item->>'kind') || ':' || lower(item->>'target') = any(seen) then raise exception 'DUPLICATE_TARGET'; end if;
    seen := seen || ((item->>'kind') || ':' || lower(item->>'target'));
    if coalesce(item->>'quantity', '') !~ '^[0-9]{1,11}([.][0-9]{1,3})?$' then raise exception 'INVALID_DECIMAL'; end if;
    qty := (item->>'quantity')::numeric;
    if qty <= 0 then raise exception 'INVALID_DECIMAL'; end if;
    price := public.pos_decimal(item->>'unit_price', 2);
    line := round(qty * price, 2);
    if item->>'kind' = 'product' then
      select * into p from public.products where id = (item->>'target')::uuid;
      if p.id is null then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
      insert into public.pos_customer_order_items(order_id, line_no, product_id, variant_id, name, sku, quantity, unit_price, line_total)
        values (order_id, line_no, p.id, null, p.name, p.sku, qty, price, line);
    else
      select * into v from public.product_variants where id = (item->>'target')::uuid;
      if v.id is null then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
      select * into p from public.products where id = v.product_id;
      insert into public.pos_customer_order_items(order_id, line_no, product_id, variant_id, name, sku, quantity, unit_price, line_total)
        values (order_id, line_no, p.id, v.id, p.name || coalesce(' / ' || v.name, ''), v.sku, qty, price, line);
    end if;
    order_total := order_total + line;
  end loop;

  if order_total > 9999999999.99 then raise exception 'INVALID_DECIMAL'; end if;
  update public.pos_customer_orders set total = order_total where id = order_id;
  return order_id;
end $$;

create function public.pos_record_customer_order_payment(
  p_request uuid, p_order uuid, p_amount text, p_paid_on date
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.pos_require_actor(true);
  o public.pos_customer_orders;
  previous public.pos_customer_order_payments;
  amount numeric;
  paid numeric;
  result uuid;
begin
  if p_request is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text, 0));
  select * into previous from public.pos_customer_order_payments where request_id = p_request;
  if found then
    if previous.order_id is distinct from p_order then raise exception 'REQUEST_CONFLICT'; end if;
    return previous.id;
  end if;
  select * into o from public.pos_customer_orders where id = p_order for update;
  if o.id is null then raise exception 'ORDER_NOT_FOUND'; end if;
  amount := public.pos_decimal(p_amount, 2, true);
  if p_paid_on is null or p_paid_on < o.order_date then raise exception 'INVALID_DATE'; end if;
  select coalesce(sum(x.amount), 0) into paid from public.pos_customer_order_payments x where x.order_id = o.id;
  if amount > o.total - paid then raise exception 'OVERPAYMENT'; end if;
  insert into public.pos_customer_order_payments(request_id, order_id, amount, paid_on, actor_id)
    values (p_request, o.id, amount, p_paid_on, actor)
    returning id into result;
  return result;
end $$;

-- შეცდომით ჩაწერილი გადახდის ან შეკვეთის წაშლა.
create function public.pos_delete_customer_order_payment(p_payment uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.pos_require_actor(true);
  delete from public.pos_customer_order_payments where id = p_payment;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
end $$;

create function public.pos_delete_customer_order(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.pos_require_actor(true);
  delete from public.pos_customer_orders where id = p_order;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
end $$;

revoke all on function public.pos_create_customer_order(uuid, uuid, date, text, jsonb),
  public.pos_record_customer_order_payment(uuid, uuid, text, date),
  public.pos_delete_customer_order_payment(uuid), public.pos_delete_customer_order(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.pos_create_customer_order(uuid, uuid, date, text, jsonb),
  public.pos_record_customer_order_payment(uuid, uuid, text, date),
  public.pos_delete_customer_order_payment(uuid), public.pos_delete_customer_order(uuid)
  to authenticated;

notify pgrst, 'reload schema';
commit;
