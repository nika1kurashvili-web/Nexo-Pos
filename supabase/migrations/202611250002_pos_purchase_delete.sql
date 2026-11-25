-- Admin-only: delete a whole purchase, or remove single lines while editing it. Everything is kept in the history.
--   * stock is corrected by appending reversing movements to the ledger (nothing in the ledger is deleted),
--   * the item's purchase price goes back to its previous purchase price when the removed purchase was its latest,
--   * the history keeps a record of the deleted purchase (number, who, when, every line, total).
-- Requires 202611250001_pos_purchase_edit.sql. Safe to run more than once.
begin;

do $$ begin
  if to_regclass('public.pos_purchase_history') is null then
    raise exception 'Missing prerequisite: apply 202611250001_pos_purchase_edit.sql first';
  end if;
end $$;

-- history must outlive a deleted purchase: no foreign key, keep the purchase number
alter table public.pos_purchase_history drop constraint if exists pos_purchase_history_purchase_id_fkey;
alter table public.pos_purchase_history add column if not exists purchase_number bigint;
alter table public.pos_purchase_history add column if not exists action text not null default 'edit';
do $$ begin
  alter table public.pos_purchase_history add constraint pos_purchase_history_action_check check (action in ('edit', 'delete'));
exception when duplicate_object then null; end $$;

alter table public.pos_purchase_history disable trigger pos_purchase_history_no_change;
update public.pos_purchase_history h
   set purchase_number = p.purchase_number
  from public.pos_purchases p
 where p.id = h.purchase_id and h.purchase_number is null;
alter table public.pos_purchase_history enable trigger pos_purchase_history_no_change;

-- after a purchase line disappears: the item's cost becomes the price of its latest remaining purchase
create or replace function public.pos_restore_purchase_cost(it public.pos_purchase_items, pur_created timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare v numeric;
begin
  if it.target_kind = 'product' and it.product_id is not null then
    if exists (select 1 from public.pos_purchase_items i2 join public.pos_purchases p2 on p2.id = i2.purchase_id
                where p2.created_at > pur_created and i2.target_kind = 'product' and i2.product_id = it.product_id) then
      return;
    end if;
    select i2.unit_price into v from public.pos_purchase_items i2 join public.pos_purchases p2 on p2.id = i2.purchase_id
     where i2.target_kind = 'product' and i2.product_id = it.product_id and p2.created_at <= pur_created
     order by p2.created_at desc limit 1;
    if v is null then v := it.previous_price; end if;
    if v is not null then
      insert into public.product_purchase_prices(product_id, purchase_price) values (it.product_id, v)
      on conflict (product_id) do update set purchase_price = excluded.purchase_price;
    end if;
  elsif it.target_kind = 'variant' and it.variant_id is not null then
    if exists (select 1 from public.pos_purchase_items i2 join public.pos_purchases p2 on p2.id = i2.purchase_id
                where p2.created_at > pur_created and i2.target_kind = 'variant' and i2.variant_id = it.variant_id) then
      return;
    end if;
    select i2.unit_price into v from public.pos_purchase_items i2 join public.pos_purchases p2 on p2.id = i2.purchase_id
     where i2.target_kind = 'variant' and i2.variant_id = it.variant_id and p2.created_at <= pur_created
     order by p2.created_at desc limit 1;
    if v is null then v := it.previous_price; end if;
    if v is not null then
      insert into public.product_purchase_prices(variant_id, purchase_price) values (it.variant_id, v)
      on conflict (variant_id) do update set purchase_price = excluded.purchase_price;
    end if;
  end if;
end $$;
revoke all on function public.pos_restore_purchase_cost(public.pos_purchase_items, timestamptz) from public, anon, authenticated;

-- edit: lines that are left out of p_items are removed (at least one line must stay)
create or replace function public.pos_edit_purchase(p_purchase uuid, p_note text, p_items jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.pos_require_actor(true);
  pur public.pos_purchases;
  it public.pos_purchase_items;
  new_note text;
  plan jsonb := '[]';
  changes jsonb := '[]';
  row_data jsonb;
  item_id uuid;
  seen uuid[] := '{}';
  qty numeric;
  price numeric;
  new_total numeric := 0;
  is_latest boolean;
  label text;
begin
  select * into pur from public.pos_purchases where id = p_purchase for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND'; end if;

  new_note := nullif(pg_catalog.regexp_replace(coalesce(p_note, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  if new_note is not null and length(new_note) > 500 then raise exception 'INVALID_NOTE'; end if;
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) not between 1 and pur.items_count then
    raise exception 'INVALID_PURCHASE_ROWS';
  end if;

  for row_data in select * from jsonb_array_elements(p_items) loop
    begin
      item_id := (row_data->>'id')::uuid;
    exception when others then
      raise exception 'INVALID_PURCHASE_ROWS';
    end;
    if item_id = any(seen) then raise exception 'DUPLICATE_TARGET'; end if;
    seen := seen || item_id;

    select * into it from public.pos_purchase_items where id = item_id and purchase_id = p_purchase;
    if not found then raise exception 'INVALID_PURCHASE_ROWS'; end if;

    qty := public.pos_decimal(row_data->>'quantity', 3, true);
    price := public.pos_decimal(row_data->>'unit_price', 2);
    new_total := new_total + round(price * qty, 2);
    label := it.product_name || coalesce(' / ' || it.variant_name, '');

    if qty <> it.quantity then
      changes := changes || jsonb_build_array(jsonb_build_object(
        'line', it.line_number, 'sku', it.sku, 'name', label, 'field', 'quantity',
        'old', trim_scale(it.quantity), 'new', trim_scale(qty)));
    end if;
    if price <> it.unit_price then
      changes := changes || jsonb_build_array(jsonb_build_object(
        'line', it.line_number, 'sku', it.sku, 'name', label, 'field', 'unit_price',
        'old', trim_scale(it.unit_price), 'new', trim_scale(price)));
    end if;
    plan := plan || jsonb_build_array(jsonb_build_object('id', item_id, 'qty', qty, 'price', price));
  end loop;

  -- lines left out are removed
  for it in select * from public.pos_purchase_items where purchase_id = p_purchase and id <> all(seen) order by line_number loop
    label := it.product_name || coalesce(' / ' || it.variant_name, '');
    changes := changes || jsonb_build_array(jsonb_build_object(
      'line', it.line_number, 'sku', it.sku, 'name', label, 'field', 'removed',
      'old', trim_scale(it.quantity), 'new', null, 'price', trim_scale(it.unit_price)));
  end loop;

  if new_note is distinct from pur.note then
    changes := changes || jsonb_build_array(jsonb_build_object('field', 'note', 'old', pur.note, 'new', new_note));
  end if;
  if jsonb_array_length(changes) = 0 then raise exception 'NO_CHANGES'; end if;

  alter table public.pos_purchases disable trigger pos_purchases_no_change;
  alter table public.pos_purchase_items disable trigger pos_purchase_items_no_change;

  for row_data in select * from jsonb_array_elements(plan) loop
    select * into it from public.pos_purchase_items where id = (row_data->>'id')::uuid;
    qty := (row_data->>'qty')::numeric;
    price := (row_data->>'price')::numeric;

    if qty <> it.quantity then
      insert into public.pos_stock_movements(kind, target_kind, product_id, variant_id, sku, product_name, variant_name,
        quantity_change, document_id)
      values ('purchase', it.target_kind, it.product_id, it.variant_id, it.sku, it.product_name, it.variant_name,
        qty - it.quantity, it.id);
    end if;

    if price <> it.unit_price then
      if it.target_kind = 'product' and it.product_id is not null then
        is_latest := not exists (
          select 1 from public.pos_purchase_items i2 join public.pos_purchases p2 on p2.id = i2.purchase_id
           where p2.created_at > pur.created_at and i2.target_kind = 'product' and i2.product_id = it.product_id);
        if is_latest then
          insert into public.product_purchase_prices(product_id, purchase_price) values (it.product_id, price)
          on conflict (product_id) do update set purchase_price = excluded.purchase_price;
        end if;
      elsif it.target_kind = 'variant' and it.variant_id is not null then
        is_latest := not exists (
          select 1 from public.pos_purchase_items i2 join public.pos_purchases p2 on p2.id = i2.purchase_id
           where p2.created_at > pur.created_at and i2.target_kind = 'variant' and i2.variant_id = it.variant_id);
        if is_latest then
          insert into public.product_purchase_prices(variant_id, purchase_price) values (it.variant_id, price)
          on conflict (variant_id) do update set purchase_price = excluded.purchase_price;
        end if;
      end if;
    end if;

    update public.pos_purchase_items
       set quantity = qty, unit_price = price, line_total = round(price * qty, 2)
     where id = it.id;
  end loop;

  for it in select * from public.pos_purchase_items where purchase_id = p_purchase and id <> all(seen) order by line_number loop
    insert into public.pos_stock_movements(kind, target_kind, product_id, variant_id, sku, product_name, variant_name,
      quantity_change, document_id)
    values ('purchase', it.target_kind, it.product_id, it.variant_id, it.sku, it.product_name, it.variant_name,
      -it.quantity, it.id);
    delete from public.pos_purchase_items where id = it.id;
    perform public.pos_restore_purchase_cost(it, pur.created_at);
  end loop;

  update public.pos_purchases
     set total = new_total, note = new_note, items_count = jsonb_array_length(p_items)
   where id = p_purchase;

  alter table public.pos_purchases enable trigger pos_purchases_no_change;
  alter table public.pos_purchase_items enable trigger pos_purchase_items_no_change;

  insert into public.pos_purchase_history(purchase_id, purchase_number, action, actor_id, actor_name, changes, total_before, total_after)
  values (p_purchase, pur.purchase_number, 'edit', actor,
    (select full_name from public.pos_profiles where id = actor), changes, pur.total, new_total);
end $$;

-- delete the whole purchase
create or replace function public.pos_delete_purchase(p_purchase uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.pos_require_actor(true);
  pur public.pos_purchases;
  it public.pos_purchase_items;
  changes jsonb := '[]';
begin
  select * into pur from public.pos_purchases where id = p_purchase for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND'; end if;

  for it in select * from public.pos_purchase_items where purchase_id = p_purchase order by line_number loop
    changes := changes || jsonb_build_array(jsonb_build_object(
      'line', it.line_number, 'sku', it.sku, 'name', it.product_name || coalesce(' / ' || it.variant_name, ''),
      'field', 'removed', 'old', trim_scale(it.quantity), 'new', null, 'price', trim_scale(it.unit_price)));
  end loop;

  alter table public.pos_purchases disable trigger pos_purchases_no_change;
  alter table public.pos_purchase_items disable trigger pos_purchase_items_no_change;

  for it in select * from public.pos_purchase_items where purchase_id = p_purchase order by line_number loop
    insert into public.pos_stock_movements(kind, target_kind, product_id, variant_id, sku, product_name, variant_name,
      quantity_change, document_id)
    values ('purchase', it.target_kind, it.product_id, it.variant_id, it.sku, it.product_name, it.variant_name,
      -it.quantity, it.id);
    delete from public.pos_purchase_items where id = it.id;
    perform public.pos_restore_purchase_cost(it, pur.created_at);
  end loop;
  delete from public.pos_purchases where id = p_purchase;

  alter table public.pos_purchases enable trigger pos_purchases_no_change;
  alter table public.pos_purchase_items enable trigger pos_purchase_items_no_change;

  insert into public.pos_purchase_history(purchase_id, purchase_number, action, actor_id, actor_name, changes, total_before, total_after)
  values (p_purchase, pur.purchase_number, 'delete', actor,
    (select full_name from public.pos_profiles where id = actor), changes, pur.total, 0);
end $$;

revoke all on function public.pos_edit_purchase(uuid, text, jsonb), public.pos_delete_purchase(uuid) from public, anon, authenticated;
grant execute on function public.pos_edit_purchase(uuid, text, jsonb), public.pos_delete_purchase(uuid) to authenticated;

commit;
notify pgrst, 'reload schema';
