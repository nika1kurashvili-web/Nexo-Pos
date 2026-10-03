-- Stock tracking, purchases and inventory counts (administrators only).
--
-- Stock is derived from an append-only movement ledger, so it can never drift:
--   sale (-), return (+)   written by triggers on pos_sale_items / pos_return_items
--   purchase (+)           written by pos_create_purchase
--   inventory (+/-)        written by pos_create_inventory (counted - system)
-- Selling beyond stock is allowed; stock simply goes negative until corrected.
-- Stock starts at 0 for every item: the first inventory count sets the real
-- starting quantity (sales made before this migration are not back-filled).
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
  if to_regprocedure('public.pos_role()') is null then
    raise exception 'Missing prerequisite: public.pos_role()';
  end if;
  if to_regclass('public.pos_return_items') is null then
    raise exception 'Missing prerequisite: apply 202610020001_pos_returns.sql first';
  end if;
  if to_regclass('public.product_purchase_prices') is null then
    raise exception 'Missing prerequisite: public.product_purchase_prices (Orders app)';
  end if;
end $$;

-- ---------------------------------------------------------------- documents
create table public.pos_purchases (
  id uuid primary key default gen_random_uuid(),
  purchase_number bigint generated always as identity unique,
  request_id uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  actor_id uuid not null references public.pos_profiles(id) on delete restrict,
  actor_name text not null,
  note text check (note is null or length(note) between 1 and 500),
  items_count integer not null check (items_count > 0),
  total numeric(14,2) not null check (total >= 0 and total < 'Infinity'::numeric),
  created_at timestamptz not null default now()
);

create table public.pos_purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.pos_purchases(id) on delete restrict,
  line_number integer not null check (line_number > 0),
  target_kind text not null check (target_kind in ('product', 'variant')),
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  sku text,
  product_name text not null,
  variant_name text,
  quantity numeric(14,3) not null check (quantity > 0 and quantity < 'Infinity'::numeric),
  unit_price numeric(14,2) not null check (unit_price >= 0 and unit_price < 'Infinity'::numeric),
  previous_price numeric(14,2),
  line_total numeric(14,2) not null,
  unique (purchase_id, line_number),
  check (line_total = round(unit_price * quantity, 2))
);

create table public.pos_inventories (
  id uuid primary key default gen_random_uuid(),
  inventory_number bigint generated always as identity unique,
  request_id uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  actor_id uuid not null references public.pos_profiles(id) on delete restrict,
  actor_name text not null,
  note text check (note is null or length(note) between 1 and 500),
  items_count integer not null check (items_count > 0),
  created_at timestamptz not null default now()
);

create table public.pos_inventory_items (
  id uuid primary key default gen_random_uuid(),
  inventory_id uuid not null references public.pos_inventories(id) on delete restrict,
  line_number integer not null check (line_number > 0),
  target_kind text not null check (target_kind in ('product', 'variant')),
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  sku text,
  product_name text not null,
  variant_name text,
  system_quantity numeric(14,3) not null,
  counted_quantity numeric(14,3) not null check (counted_quantity >= 0 and counted_quantity < 'Infinity'::numeric),
  difference numeric(14,3) not null check (difference <> 0),
  reason text not null check (length(reason) between 1 and 500),
  unique (inventory_id, line_number),
  check (difference = counted_quantity - system_quantity)
);

create table public.pos_stock_movements (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('sale', 'return', 'purchase', 'inventory')),
  target_kind text not null check (target_kind in ('product', 'variant')),
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  sku text,
  product_name text not null,
  variant_name text,
  quantity_change numeric(14,3) not null
    check (quantity_change <> 0 and quantity_change > '-Infinity'::numeric and quantity_change < 'Infinity'::numeric),
  -- sale item / return item / purchase / inventory the movement came from
  document_id uuid not null,
  created_at timestamptz not null default now()
);

create index pos_purchases_created on public.pos_purchases(created_at desc);
create index pos_purchase_items_purchase on public.pos_purchase_items(purchase_id);
create index pos_purchase_items_product on public.pos_purchase_items(product_id) where product_id is not null;
create index pos_purchase_items_variant on public.pos_purchase_items(variant_id) where variant_id is not null;
create index pos_purchases_actor on public.pos_purchases(actor_id);
create index pos_inventories_created on public.pos_inventories(created_at desc);
create index pos_inventory_items_inventory on public.pos_inventory_items(inventory_id);
create index pos_inventory_items_product on public.pos_inventory_items(product_id) where product_id is not null;
create index pos_inventory_items_variant on public.pos_inventory_items(variant_id) where variant_id is not null;
create index pos_inventories_actor on public.pos_inventories(actor_id);
create index pos_stock_product on public.pos_stock_movements(product_id) where target_kind = 'product';
create index pos_stock_variant on public.pos_stock_movements(variant_id) where target_kind = 'variant';
create index pos_stock_document on public.pos_stock_movements(document_id);

-- Identity sequences inherit separate grants; table RLS/revokes do not cover them.
do $$ declare seq text; t text; c text; begin
  foreach t in array array['pos_purchases', 'pos_inventories'] loop
    c := case t when 'pos_purchases' then 'purchase_number' else 'inventory_number' end;
    seq := pg_catalog.pg_get_serial_sequence('public.' || t, c);
    if seq is null then raise exception 'identity sequence missing for %.%', t, c; end if;
    execute pg_catalog.format('revoke all privileges on sequence %s from public, anon, authenticated', seq);
  end loop;
end $$;

do $$ declare t text; begin
  foreach t in array array['pos_purchases', 'pos_purchase_items', 'pos_inventories', 'pos_inventory_items', 'pos_stock_movements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.pos_role() = %L)',
      t || '_admin_read', t, 'admin');
  end loop;
end $$;

-- Documents and the ledger never change. The single exception: deleting a catalog
-- item in the Orders app nulls product_id/variant_id (ON DELETE SET NULL); that
-- must keep working, and the name/SKU snapshots stay.
create function public.pos_inventory_documents_immutable() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'product_id' - 'variant_id') = (to_jsonb(old) - 'product_id' - 'variant_id')
     and (to_jsonb(new)->>'product_id' is null or to_jsonb(new)->>'product_id' = to_jsonb(old)->>'product_id')
     and (to_jsonb(new)->>'variant_id' is null or to_jsonb(new)->>'variant_id' = to_jsonb(old)->>'variant_id') then
    return new;
  end if;
  raise exception 'INVENTORY_DOCUMENT_IMMUTABLE';
end $$;
do $$ declare t text; begin
  foreach t in array array['pos_purchases', 'pos_purchase_items', 'pos_inventories', 'pos_inventory_items', 'pos_stock_movements'] loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.pos_inventory_documents_immutable()', t || '_no_change', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.pos_inventory_documents_immutable()', t || '_no_truncate', t);
  end loop;
end $$;

-- ------------------------------------------------- sales / returns -> stock
create function public.pos_stock_from_sale_item() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pos_stock_movements(kind, target_kind, product_id, variant_id, sku, product_name, variant_name,
    quantity_change, document_id)
  values ('sale', new.target_kind, new.product_id, new.variant_id, new.sku, new.product_name, new.variant_name,
    -new.quantity, new.id);
  return new;
end $$;
create trigger pos_sale_items_stock after insert on public.pos_sale_items
  for each row execute function public.pos_stock_from_sale_item();

create function public.pos_stock_from_return_item() returns trigger
language plpgsql security definer set search_path = '' as $$
declare item public.pos_sale_items;
begin
  select * into item from public.pos_sale_items where id = new.sale_item_id;
  insert into public.pos_stock_movements(kind, target_kind, product_id, variant_id, sku, product_name, variant_name,
    quantity_change, document_id)
  values ('return', item.target_kind, item.product_id, item.variant_id, item.sku, item.product_name, item.variant_name,
    new.quantity, new.id);
  return new;
end $$;
create trigger pos_return_items_stock after insert on public.pos_return_items
  for each row execute function public.pos_stock_from_return_item();

revoke all on function public.pos_stock_from_sale_item(), public.pos_stock_from_return_item()
  from public, anon, authenticated;

-- ------------------------------------------------------------------ catalog
-- Every sellable item (products without variants, and variants) with current
-- stock and current purchase price. Purchase prices live in an Orders table that
-- only Orders admins can read directly, so the read happens here.
-- VOLATILE on purpose (pos_require_actor() takes a FOR SHARE lock).
create function public.pos_inventory_catalog() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform public.pos_require_actor(true);
  with items as (
    select 'product'::text as kind, p.id, p.name, null::text as variant_name, p.sku, p.price
    from public.products p
    where p.active
      and not exists (select 1 from public.product_variants v where v.product_id = p.id and v.active)
    union all
    select 'variant', v.id, p.name, v.name, v.sku, v.price
    from public.product_variants v
    join public.products p on p.id = v.product_id
    where v.active and p.active
  ), stock as (
    select 'product'::text as kind, product_id as id, sum(quantity_change) as qty
    from public.pos_stock_movements where target_kind = 'product' and product_id is not null group by product_id
    union all
    select 'variant', variant_id, sum(quantity_change)
    from public.pos_stock_movements where target_kind = 'variant' and variant_id is not null group by variant_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'kind', i.kind, 'id', i.id,
      'name', i.name || coalesce(' / ' || i.variant_name, ''),
      'sku', i.sku,
      'price', i.price,
      'stock', coalesce(s.qty, 0),
      'cost', case when i.kind = 'variant' then pv.purchase_price else pp.purchase_price end
    ) order by i.name, i.variant_name nulls first, i.id), '[]'::jsonb)
  into result
  from items i
  left join stock s on s.kind = i.kind and s.id = i.id
  left join public.product_purchase_prices pp on i.kind = 'product' and pp.product_id = i.id
  left join public.product_purchase_prices pv on i.kind = 'variant' and pv.variant_id = i.id;
  return result;
end $$;

-- ---------------------------------------------------------------- purchases
create function public.pos_create_purchase(p_request uuid, p_note text, p_items jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.pos_require_actor(true);
  note text;
  item jsonb;
  prepared jsonb := '[]';
  normalized jsonb := '[]';
  fingerprint text;
  existing public.pos_purchases;
  p public.products;
  v public.product_variants;
  qty numeric; price numeric; previous numeric;
  total numeric := 0;
  purchase_id uuid := gen_random_uuid();
  item_id uuid;
  line_no integer := 0;
  row_data jsonb;
begin
  if p_request is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text, 0));
  note := nullif(pg_catalog.regexp_replace(coalesce(p_note, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  if note is not null and length(note) > 500 then raise exception 'INVALID_NOTE'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    raise exception 'INVALID_PURCHASE_ROWS';
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    if item->>'kind' not in ('product', 'variant') then raise exception 'INVALID_TARGET'; end if;
    qty := public.pos_decimal(item->>'quantity', 3, true);
    price := public.pos_decimal(item->>'unit_price', 2);
    normalized := normalized || jsonb_build_array(jsonb_build_object(
      'kind', item->>'kind', 'target', item->>'target', 'quantity', trim_scale(qty), 'unit_price', trim_scale(price)));
  end loop;
  if exists (select 1 from jsonb_array_elements(normalized) x group by x->>'kind', x->>'target' having count(*) > 1) then
    raise exception 'DUPLICATE_TARGET';
  end if;
  fingerprint := encode(sha256(convert_to(jsonb_build_object('version', 1, 'actor', actor, 'note', note,
    'items', (select jsonb_agg(x order by x->>'kind', x->>'target') from jsonb_array_elements(normalized) x))::text, 'UTF8')), 'hex');

  select * into existing from public.pos_purchases where request_id = p_request;
  if found then
    if existing.actor_id <> actor or existing.request_fingerprint is distinct from fingerprint then
      raise exception 'REQUEST_CONFLICT';
    end if;
    return existing.id;
  end if;

  for row_data in select * from jsonb_array_elements(normalized) loop
    line_no := line_no + 1;
    qty := (row_data->>'quantity')::numeric;
    price := (row_data->>'unit_price')::numeric;
    if row_data->>'kind' = 'product' then
      select * into p from public.products where id::text = row_data->>'target' and active;
      if not found then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
      -- A product that has variants is stocked per variant, never as a whole.
      if exists (select 1 from public.product_variants x where x.product_id = p.id and x.active) then
        raise exception 'CATALOG_ITEM_UNAVAILABLE';
      end if;
      select purchase_price into previous from public.product_purchase_prices where product_id = p.id;
      prepared := prepared || jsonb_build_array(jsonb_build_object(
        'line_number', line_no, 'target_kind', 'product', 'product_id', p.id, 'variant_id', null,
        'sku', p.sku, 'product_name', p.name, 'variant_name', null,
        'quantity', qty, 'unit_price', price, 'previous_price', previous, 'line_total', round(price * qty, 2)));
    else
      select * into v from public.product_variants where id::text = row_data->>'target' and active;
      if not found then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
      select * into p from public.products where id = v.product_id and active;
      if not found then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
      select purchase_price into previous from public.product_purchase_prices where variant_id = v.id;
      prepared := prepared || jsonb_build_array(jsonb_build_object(
        'line_number', line_no, 'target_kind', 'variant', 'product_id', p.id, 'variant_id', v.id,
        'sku', v.sku, 'product_name', p.name, 'variant_name', v.name,
        'quantity', qty, 'unit_price', price, 'previous_price', previous, 'line_total', round(price * qty, 2)));
    end if;
    total := total + round(price * qty, 2);
  end loop;

  insert into public.pos_purchases(id, request_id, request_fingerprint, actor_id, actor_name, note, items_count, total)
  values (purchase_id, p_request, fingerprint, actor,
    (select full_name from public.pos_profiles where id = actor), note, line_no, total);

  for row_data in select * from jsonb_array_elements(prepared) loop
    item_id := gen_random_uuid();
    insert into public.pos_purchase_items(id, purchase_id, line_number, target_kind, product_id, variant_id, sku,
      product_name, variant_name, quantity, unit_price, previous_price, line_total)
    values (item_id, purchase_id, (row_data->>'line_number')::integer, row_data->>'target_kind',
      (row_data->>'product_id')::uuid, (row_data->>'variant_id')::uuid, row_data->>'sku',
      row_data->>'product_name', row_data->>'variant_name', (row_data->>'quantity')::numeric,
      (row_data->>'unit_price')::numeric, (row_data->>'previous_price')::numeric, (row_data->>'line_total')::numeric);

    insert into public.pos_stock_movements(kind, target_kind, product_id, variant_id, sku, product_name, variant_name,
      quantity_change, document_id)
    values ('purchase', row_data->>'target_kind', (row_data->>'product_id')::uuid, (row_data->>'variant_id')::uuid,
      row_data->>'sku', row_data->>'product_name', row_data->>'variant_name', (row_data->>'quantity')::numeric, item_id);

    -- The latest purchase price becomes the item's cost (used by analytics and Orders).
    if row_data->>'target_kind' = 'product' then
      insert into public.product_purchase_prices(product_id, purchase_price)
      values ((row_data->>'product_id')::uuid, (row_data->>'unit_price')::numeric)
      on conflict (product_id) do update set purchase_price = excluded.purchase_price;
    else
      insert into public.product_purchase_prices(variant_id, purchase_price)
      values ((row_data->>'variant_id')::uuid, (row_data->>'unit_price')::numeric)
      on conflict (variant_id) do update set purchase_price = excluded.purchase_price;
    end if;
  end loop;

  return purchase_id;
end $$;

-- --------------------------------------------------------------- inventories
-- Items are only the corrected lines: {kind, target, counted, reason}. The change
-- is counted - stock at the moment of saving, so sales made while the count was
-- being typed are not lost.
create function public.pos_create_inventory(p_request uuid, p_note text, p_items jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.pos_require_actor(true);
  note text;
  item jsonb;
  normalized jsonb := '[]';
  prepared jsonb := '[]';
  fingerprint text;
  existing public.pos_inventories;
  p public.products;
  v public.product_variants;
  counted numeric; reason text; system_qty numeric; diff numeric;
  inventory_id uuid := gen_random_uuid();
  item_id uuid;
  line_no integer := 0;
  row_data jsonb;
begin
  if p_request is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text, 0));
  note := nullif(pg_catalog.regexp_replace(coalesce(p_note, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  if note is not null and length(note) > 500 then raise exception 'INVALID_NOTE'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 2000 then
    raise exception 'INVALID_INVENTORY_ROWS';
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    if item->>'kind' not in ('product', 'variant') then raise exception 'INVALID_TARGET'; end if;
    counted := public.pos_decimal(item->>'counted', 3);
    reason := pg_catalog.regexp_replace(coalesce(item->>'reason', ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
    if length(reason) not between 1 and 500 then raise exception 'INVALID_REASON'; end if;
    normalized := normalized || jsonb_build_array(jsonb_build_object(
      'kind', item->>'kind', 'target', item->>'target', 'counted', trim_scale(counted), 'reason', reason));
  end loop;
  if exists (select 1 from jsonb_array_elements(normalized) x group by x->>'kind', x->>'target' having count(*) > 1) then
    raise exception 'DUPLICATE_TARGET';
  end if;
  fingerprint := encode(sha256(convert_to(jsonb_build_object('version', 1, 'actor', actor, 'note', note,
    'items', (select jsonb_agg(x order by x->>'kind', x->>'target') from jsonb_array_elements(normalized) x))::text, 'UTF8')), 'hex');

  select * into existing from public.pos_inventories where request_id = p_request;
  if found then
    if existing.actor_id <> actor or existing.request_fingerprint is distinct from fingerprint then
      raise exception 'REQUEST_CONFLICT';
    end if;
    return existing.id;
  end if;

  for row_data in select * from jsonb_array_elements(normalized) loop
    counted := (row_data->>'counted')::numeric;
    if row_data->>'kind' = 'product' then
      select * into p from public.products where id::text = row_data->>'target' and active;
      if not found then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
      -- A product that has variants is stocked per variant, never as a whole.
      if exists (select 1 from public.product_variants x where x.product_id = p.id and x.active) then
        raise exception 'CATALOG_ITEM_UNAVAILABLE';
      end if;
      select coalesce(sum(quantity_change), 0) into system_qty from public.pos_stock_movements
        where target_kind = 'product' and product_id = p.id;
      diff := counted - system_qty;
      if diff <> 0 then
        line_no := line_no + 1;
        prepared := prepared || jsonb_build_array(jsonb_build_object(
          'line_number', line_no, 'target_kind', 'product', 'product_id', p.id, 'variant_id', null,
          'sku', p.sku, 'product_name', p.name, 'variant_name', null,
          'system_quantity', system_qty, 'counted_quantity', counted, 'difference', diff, 'reason', row_data->>'reason'));
      end if;
    else
      select * into v from public.product_variants where id::text = row_data->>'target' and active;
      if not found then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
      select * into p from public.products where id = v.product_id and active;
      if not found then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
      select coalesce(sum(quantity_change), 0) into system_qty from public.pos_stock_movements
        where target_kind = 'variant' and variant_id = v.id;
      diff := counted - system_qty;
      if diff <> 0 then
        line_no := line_no + 1;
        prepared := prepared || jsonb_build_array(jsonb_build_object(
          'line_number', line_no, 'target_kind', 'variant', 'product_id', p.id, 'variant_id', v.id,
          'sku', v.sku, 'product_name', p.name, 'variant_name', v.name,
          'system_quantity', system_qty, 'counted_quantity', counted, 'difference', diff, 'reason', row_data->>'reason'));
      end if;
    end if;
  end loop;

  if line_no = 0 then raise exception 'NOTHING_TO_SAVE'; end if;

  insert into public.pos_inventories(id, request_id, request_fingerprint, actor_id, actor_name, note, items_count)
  values (inventory_id, p_request, fingerprint, actor,
    (select full_name from public.pos_profiles where id = actor), note, line_no);

  for row_data in select * from jsonb_array_elements(prepared) loop
    item_id := gen_random_uuid();
    insert into public.pos_inventory_items(id, inventory_id, line_number, target_kind, product_id, variant_id, sku,
      product_name, variant_name, system_quantity, counted_quantity, difference, reason)
    values (item_id, inventory_id, (row_data->>'line_number')::integer, row_data->>'target_kind',
      (row_data->>'product_id')::uuid, (row_data->>'variant_id')::uuid, row_data->>'sku',
      row_data->>'product_name', row_data->>'variant_name', (row_data->>'system_quantity')::numeric,
      (row_data->>'counted_quantity')::numeric, (row_data->>'difference')::numeric, row_data->>'reason');

    insert into public.pos_stock_movements(kind, target_kind, product_id, variant_id, sku, product_name, variant_name,
      quantity_change, document_id)
    values ('inventory', row_data->>'target_kind', (row_data->>'product_id')::uuid, (row_data->>'variant_id')::uuid,
      row_data->>'sku', row_data->>'product_name', row_data->>'variant_name', (row_data->>'difference')::numeric, item_id);
  end loop;

  return inventory_id;
end $$;

revoke all on function public.pos_inventory_catalog(), public.pos_create_purchase(uuid, text, jsonb),
  public.pos_create_inventory(uuid, text, jsonb), public.pos_inventory_documents_immutable()
  from public, anon, authenticated;
grant execute on function public.pos_inventory_catalog(), public.pos_create_purchase(uuid, text, jsonb),
  public.pos_create_inventory(uuid, text, jsonb) to authenticated;

commit;
