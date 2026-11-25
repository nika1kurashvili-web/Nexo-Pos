-- Admin-only: edit a saved purchase (quantity, price, note) and keep a history of who changed what.
--   * the purchase lines are updated and the purchase total is recalculated,
--   * a quantity change writes a correcting stock movement (+/- difference), so stock stays derived from the ledger
--     and the Orders site stock is updated by the existing trigger,
--   * a price change moves the item's purchase price only when this is the item's latest purchase,
--   * every edit writes one history row (who, when, old/new values, total before/after).
-- The "immutable document" triggers are switched off only inside this transaction.
begin;

do $$ begin
  if to_regclass('public.pos_purchases') is null then
    raise exception 'Missing prerequisite: apply 202610040001_pos_inventory.sql first';
  end if;
end $$;

create table if not exists public.pos_purchase_history (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.pos_purchases(id) on delete restrict,
  actor_id uuid not null references public.pos_profiles(id) on delete restrict,
  actor_name text not null,
  changes jsonb not null,
  total_before numeric(14,2) not null,
  total_after numeric(14,2) not null,
  created_at timestamptz not null default now()
);
create index if not exists pos_purchase_history_purchase on public.pos_purchase_history(purchase_id, created_at desc);

alter table public.pos_purchase_history enable row level security;
alter table public.pos_purchase_history force row level security;
revoke all on public.pos_purchase_history from public, anon, authenticated, service_role;
grant select on public.pos_purchase_history to authenticated;
drop policy if exists pos_purchase_history_admin_read on public.pos_purchase_history;
create policy pos_purchase_history_admin_read on public.pos_purchase_history
  for select to authenticated using (public.pos_role() = 'admin');

drop trigger if exists pos_purchase_history_no_change on public.pos_purchase_history;
create trigger pos_purchase_history_no_change before update or delete on public.pos_purchase_history
  for each row execute function public.pos_inventory_documents_immutable();
drop trigger if exists pos_purchase_history_no_truncate on public.pos_purchase_history;
create trigger pos_purchase_history_no_truncate before truncate on public.pos_purchase_history
  for each statement execute function public.pos_inventory_documents_immutable();

-- p_items: every line of the purchase, as [{"id": <purchase item id>, "quantity": "..", "unit_price": ".."}]
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
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) <> pur.items_count then
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

  update public.pos_purchases set total = new_total, note = new_note where id = p_purchase;

  alter table public.pos_purchases enable trigger pos_purchases_no_change;
  alter table public.pos_purchase_items enable trigger pos_purchase_items_no_change;

  insert into public.pos_purchase_history(purchase_id, actor_id, actor_name, changes, total_before, total_after)
  values (p_purchase, actor, (select full_name from public.pos_profiles where id = actor), changes, pur.total, new_total);
end $$;

revoke all on function public.pos_edit_purchase(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.pos_edit_purchase(uuid, text, jsonb) to authenticated;

commit;
notify pgrst, 'reload schema';
