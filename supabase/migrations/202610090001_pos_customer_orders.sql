-- ბიზნეს კლიენტების პირადი შეკვეთები (მხოლოდ POS ადმინისტრატორისთვის).
-- სრულად გამოყოფილია: არ ეხება გაყიდვებს, სალაროს, მარაგს, ანალიტიკას, რეპორტებს და
-- კლიენტის არსებულ ვალს. არც ერთი არსებული ცხრილი არ იცვლება.
-- ცხრილებზე პირდაპირი წვდომა არავის აქვს; მხოლოდ ქვემოთ მოცემული ფუნქციებით, ადმინისთვის.
begin;

create table public.pos_customer_orders (
  id uuid primary key default gen_random_uuid(),
  request_id uuid unique,
  customer_id uuid not null references public.pos_business_customers(id) on delete restrict,
  order_date date not null,
  note text check (note is null or length(note) <= 1000),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pos_customer_orders_customer on public.pos_customer_orders(customer_id, order_date desc);

-- item_kind/item_id მხოლოდ მინიშნებაა; პროდუქტთან კავშირი (FK) განზრახ არ არის,
-- ამიტომ პროდუქტების წაშლას/იმპორტს ეს ცხრილი არ ეხება. სახელი ინახება ასლად.
create table public.pos_customer_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.pos_customer_orders(id) on delete cascade,
  line_number integer not null,
  item_kind text check (item_kind in ('product','variant')),
  item_id uuid,
  name text not null check (length(btrim(name)) between 1 and 300),
  quantity numeric(14,3) not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0)
);
create index pos_customer_order_items_order on public.pos_customer_order_items(order_id);

create table public.pos_customer_order_payments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid unique,
  order_id uuid not null references public.pos_customer_orders(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  paid_on date not null,
  note text check (note is null or length(note) <= 500),
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index pos_customer_order_payments_order on public.pos_customer_order_payments(order_id);

alter table public.pos_customer_orders enable row level security;
alter table public.pos_customer_order_items enable row level security;
alter table public.pos_customer_order_payments enable row level security;
alter table public.pos_customer_orders force row level security;
alter table public.pos_customer_order_items force row level security;
alter table public.pos_customer_order_payments force row level security;
revoke all on public.pos_customer_orders, public.pos_customer_order_items, public.pos_customer_order_payments
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- წაკითხვა
create function public.pos_corder_list(p_customer uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public.pos_require_actor(true);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'order_date', o.order_date, 'note', o.note,
      'total', coalesce(i.total, 0), 'paid', coalesce(p.paid, 0),
      'items', coalesce(i.items, '[]'::jsonb),
      'payments', coalesce(p.payments, '[]'::jsonb)
    ) order by o.order_date desc, o.created_at desc)
    from public.pos_customer_orders o
    left join lateral (
      select sum(round(x.quantity * x.unit_price, 2)) as total,
             jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.item_kind, 'target', x.item_id, 'name', x.name,
               'quantity', x.quantity, 'unit_price', x.unit_price) order by x.line_number) as items
      from public.pos_customer_order_items x where x.order_id = o.id
    ) i on true
    left join lateral (
      select sum(y.amount) as paid,
             jsonb_agg(jsonb_build_object('id', y.id, 'amount', y.amount, 'paid_on', y.paid_on, 'note', y.note)
               order by y.paid_on desc, y.created_at desc) as payments
      from public.pos_customer_order_payments y where y.order_id = o.id
    ) p on true
    where o.customer_id = p_customer
  ), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- შეკვეთის შექმნა/შესწორება
create function public.pos_corder_save(
  p_request uuid, p_order uuid, p_customer uuid, p_date date, p_note text, p_items jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid; oid uuid; r jsonb; n integer := 0; qty numeric; price numeric;
  new_total numeric := 0; paid numeric; kind text; target uuid; nm text;
begin
  actor := public.pos_require_actor(true);
  if p_date is null or p_date < date '2000-01-01' or p_date > date '2100-01-01' then raise exception 'INVALID_DATE'; end if;
  if p_note is not null and length(p_note) > 1000 then raise exception 'INVALID_NOTE'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 300 then
    raise exception 'INVALID_ITEMS';
  end if;
  if not exists(select 1 from public.pos_business_customers where id = p_customer) then raise exception 'INVALID_CUSTOMER'; end if;

  -- იგივე მოთხოვნის განმეორება (ორმაგი დაჭერა) ახალს აღარ ქმნის
  if p_order is null and p_request is not null then
    select id into oid from public.pos_customer_orders where request_id = p_request;
    if found then return oid; end if;
  end if;

  if p_order is null then
    insert into public.pos_customer_orders(request_id, customer_id, order_date, note, created_by)
      values (p_request, p_customer, p_date, nullif(btrim(p_note), ''), actor) returning id into oid;
  else
    select id into oid from public.pos_customer_orders where id = p_order and customer_id = p_customer for update;
    if not found then raise exception 'INVALID_ORDER'; end if;
    delete from public.pos_customer_order_items where order_id = oid;
  end if;

  for r in select value from jsonb_array_elements(p_items) loop
    n := n + 1;
    if jsonb_typeof(r) <> 'object'
       or coalesce(r->>'quantity','') !~ '^[0-9]{1,11}([.][0-9]{1,3})?$'
       or coalesce(r->>'unit_price','') !~ '^[0-9]{1,12}([.][0-9]{1,2})?$' then
      raise exception 'INVALID_ITEMS';
    end if;
    qty := (r->>'quantity')::numeric; price := (r->>'unit_price')::numeric;
    if qty <= 0 then raise exception 'INVALID_ITEMS'; end if;
    nm := btrim(coalesce(r->>'name',''));
    if length(nm) not between 1 and 300 then raise exception 'INVALID_ITEMS'; end if;
    kind := nullif(r->>'kind','');
    if kind is not null and kind not in ('product','variant') then raise exception 'INVALID_ITEMS'; end if;
    target := null;
    if coalesce(r->>'target','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      target := (r->>'target')::uuid;
    end if;
    insert into public.pos_customer_order_items(order_id, line_number, item_kind, item_id, name, quantity, unit_price)
      values (oid, n, kind, target, nm, qty, price);
    new_total := new_total + round(qty * price, 2);
  end loop;

  select coalesce(sum(amount), 0) into paid from public.pos_customer_order_payments where order_id = oid;
  if new_total < paid then raise exception 'TOTAL_BELOW_PAID'; end if;

  update public.pos_customer_orders
     set order_date = p_date, note = nullif(btrim(p_note), ''), updated_at = now()
   where id = oid;
  return oid;
end $$;

create function public.pos_corder_delete(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.pos_require_actor(true);
  delete from public.pos_customer_orders where id = p_order;
  if not found then raise exception 'INVALID_ORDER'; end if;
end $$;

-- ---------------------------------------------------------------- დაფარვა
create function public.pos_corder_payment_add(
  p_request uuid, p_order uuid, p_amount numeric, p_date date, p_note text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid; pid uuid; total numeric; paid numeric;
begin
  actor := public.pos_require_actor(true);
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) or p_amount > 9999999999.99 then
    raise exception 'INVALID_AMOUNT';
  end if;
  if p_date is null or p_date < date '2000-01-01' or p_date > date '2100-01-01' then raise exception 'INVALID_DATE'; end if;
  if p_note is not null and length(p_note) > 500 then raise exception 'INVALID_NOTE'; end if;
  perform 1 from public.pos_customer_orders where id = p_order for update;
  if not found then raise exception 'INVALID_ORDER'; end if;
  if p_request is not null then
    select id into pid from public.pos_customer_order_payments where request_id = p_request;
    if found then return pid; end if;
  end if;
  select coalesce(sum(round(quantity * unit_price, 2)), 0) into total from public.pos_customer_order_items where order_id = p_order;
  select coalesce(sum(amount), 0) into paid from public.pos_customer_order_payments where order_id = p_order;
  if paid + p_amount > total then raise exception 'PAYMENT_EXCEEDS_DEBT'; end if;
  insert into public.pos_customer_order_payments(request_id, order_id, amount, paid_on, note, created_by)
    values (p_request, p_order, p_amount, p_date, nullif(btrim(p_note), ''), actor) returning id into pid;
  return pid;
end $$;

create function public.pos_corder_payment_delete(p_payment uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.pos_require_actor(true);
  delete from public.pos_customer_order_payments where id = p_payment;
  if not found then raise exception 'INVALID_PAYMENT'; end if;
end $$;

revoke all on function public.pos_corder_list(uuid), public.pos_corder_save(uuid,uuid,uuid,date,text,jsonb),
  public.pos_corder_delete(uuid), public.pos_corder_payment_add(uuid,uuid,numeric,date,text),
  public.pos_corder_payment_delete(uuid) from public, anon, authenticated, service_role;
grant execute on function public.pos_corder_list(uuid), public.pos_corder_save(uuid,uuid,uuid,date,text,jsonb),
  public.pos_corder_delete(uuid), public.pos_corder_payment_add(uuid,uuid,numeric,date,text),
  public.pos_corder_payment_delete(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
