-- Product category: exactly two values, "მანქანა" (cars) and "ტექნიკა" (appliances). Variants use their product's category.
alter table public.products add column if not exists category text;
alter table public.products drop constraint if exists products_category_check;
alter table public.products add constraint products_category_check check (category is null or category in ('მანქანა', 'ტექნიკა'));

create function public.pos_set_category(p_kind text, p_id uuid, p_category text) returns void
language plpgsql security definer set search_path = '' as $$
declare value text := nullif(btrim(coalesce(p_category, '')), ''); changed integer;
begin
  perform public.pos_require_actor(true);
  if p_kind not in ('product', 'variant') then raise exception 'INVALID_TARGET'; end if;
  if value is not null and value not in ('მანქანა', 'ტექნიკა') then raise exception 'INVALID_CATEGORY'; end if;
  if p_kind = 'product' then
    update public.products set category = value where id = p_id;
  else
    update public.products set category = value where id = (select product_id from public.product_variants where id = p_id);
  end if;
  get diagnostics changed = row_count;
  if changed = 0 then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
end $$;

create or replace function public.pos_products_overview() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform public.pos_require_actor(true);
  with items as (
    select 'product'::text as kind, p.id, p.id as product_id, p.name, null::text as variant_name, p.sku, p.price,
           p.active, true as product_active, p.category
    from public.products p
    where not exists (select 1 from public.product_variants v where v.product_id = p.id)
    union all
    select 'variant', v.id, p.id, p.name, v.name, v.sku, v.price, v.active, p.active, p.category
    from public.product_variants v join public.products p on p.id = v.product_id
  ), stock as (
    select 'product'::text as kind, product_id as id, sum(quantity_change) as qty
    from public.pos_stock_movements where target_kind = 'product' and product_id is not null group by product_id
    union all
    select 'variant', variant_id, sum(quantity_change)
    from public.pos_stock_movements where target_kind = 'variant' and variant_id is not null group by variant_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'kind', i.kind, 'id', i.id, 'product_id', i.product_id, 'name', i.name, 'variant_name', i.variant_name, 'sku', i.sku,
      'price', i.price, 'stock', coalesce(s.qty, 0),
      'cost', case when i.kind = 'variant' then pv.purchase_price else pp.purchase_price end,
      'active', i.active and i.product_active,
      'category', i.category
    ) order by i.name, i.variant_name nulls first, i.id), '[]'::jsonb)
  into result
  from items i
  left join stock s on s.kind = i.kind and s.id = i.id
  left join public.product_purchase_prices pp on i.kind = 'product' and pp.product_id = i.id
  left join public.product_purchase_prices pv on i.kind = 'variant' and pv.variant_id = i.id;
  return result;
end $$;

create or replace function public.pos_products_import(p_request uuid, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.pos_require_actor(true);
  item jsonb; counted jsonb := '[]'::jsonb;
  created integer := 0; updated integer := 0; deleted integer := 0; deactivated integer := 0;
  kind text; target uuid; newid uuid; sku_value text; parent uuid;
  has_price boolean; has_active boolean;
  parents uuid[] := '{}';
begin
  if p_request is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 2000 then
    raise exception 'INVALID_ITEMS';
  end if;
  begin
    insert into public.pos_product_imports(request_id, actor_id, items_count)
    values (p_request, actor, jsonb_array_length(p_items));
  exception when unique_violation then raise exception 'IMPORT_ALREADY_DONE';
  end;

  for item in select * from jsonb_array_elements(p_items) loop
    begin
      if item->>'op' = 'create' then
        newid := public.pos_create_product(item->>'name', nullif(item->>'sku', ''), item->>'price',
                                           nullif(item->>'cost', ''), '1');
        created := created + 1;
        if item ? 'category' then
          perform public.pos_set_category('product', newid, item->>'category');
        end if;
        if coalesce(nullif(item->>'stock', ''), '0')::numeric > 0 then
          counted := counted || jsonb_build_array(jsonb_build_object(
            'kind', 'product', 'target', newid, 'counted', item->>'stock', 'reason', 'Excel იმპორტი'));
        end if;
      elsif item->>'op' = 'update' then
        target := (item->>'id')::uuid;
        if exists (select 1 from public.products where id = target) then kind := 'product';
        elsif exists (select 1 from public.product_variants where id = target) then kind := 'variant';
        else raise exception 'CATALOG_ITEM_UNAVAILABLE';
        end if;

        if item ? 'name' then
          if kind <> 'product' or length(btrim(item->>'name')) not between 1 and 200 then raise exception 'INVALID_NAME'; end if;
          update public.products set name = btrim(item->>'name') where id = target;
        end if;
        if item ? 'variant_name' then
          if kind <> 'variant' or length(btrim(item->>'variant_name')) not between 1 and 200 then raise exception 'INVALID_NAME'; end if;
          update public.product_variants set name = btrim(item->>'variant_name') where id = target;
        end if;
        if item ? 'sku' then
          sku_value := nullif(btrim(item->>'sku'), '');
          if sku_value is not null then
            if length(sku_value) > 100 then raise exception 'INVALID_SKU'; end if;
            if exists (select 1 from public.products where lower(sku) = lower(sku_value) and id <> target)
               or exists (select 1 from public.product_variants where lower(sku) = lower(sku_value) and id <> target) then
              raise exception 'SKU_TAKEN';
            end if;
          end if;
          if kind = 'product' then update public.products set sku = sku_value where id = target;
          else update public.product_variants set sku = sku_value where id = target; end if;
        end if;
        has_price := item ? 'price'; has_active := item ? 'active';
        if has_price or has_active then
          perform public.pos_update_product(kind, target,
            case when has_price then item->>'price' end,
            case when has_active then (item->>'active')::boolean end);
        end if;
        if item ? 'cost' then perform public.pos_set_cost(kind, target, item->>'cost'); end if;
        if item ? 'category' then perform public.pos_set_category(kind, target, item->>'category'); end if;
        if item ? 'stock' then
          counted := counted || jsonb_build_array(jsonb_build_object(
            'kind', kind, 'target', target, 'counted', item->>'stock', 'reason', 'Excel იმპორტი'));
        end if;
        updated := updated + 1;
      elsif item->>'op' = 'remove' then
        target := (item->>'id')::uuid;
        if exists (select 1 from public.products where id = target) then kind := 'product';
        elsif exists (select 1 from public.product_variants where id = target) then kind := 'variant';
        else continue;
        end if;
        if kind = 'variant' then
          select product_id into parent from public.product_variants where id = target;
          parents := parents || parent;
        end if;
        if public.pos_catalog_item_used(kind, target) then
          perform public.pos_update_product(kind, target, null, false);
          deactivated := deactivated + 1;
        else
          if kind = 'product' then
            if exists (select 1 from public.product_variants where product_id = target) then
              raise exception 'CATALOG_ITEM_UNAVAILABLE';
            end if;
            delete from public.products where id = target;
          else
            delete from public.product_variants where id = target;
          end if;
          deleted := deleted + 1;
        end if;
      else
        raise exception 'INVALID_ITEMS';
      end if;
    exception when others then
      raise exception '%', sqlerrm using detail = 'row ' || coalesce(item->>'row', '?');
    end;
  end loop;

  -- A product whose variants were all removed is removed too (or deactivated if it has its own history).
  for parent in select distinct unnest(parents) loop
    if exists (select 1 from public.products where id = parent)
       and not exists (select 1 from public.product_variants where product_id = parent) then
      if public.pos_catalog_item_used('product', parent) then
        perform public.pos_update_product('product', parent, null, false);
      else
        delete from public.products where id = parent;
      end if;
    end if;
  end loop;

  if jsonb_array_length(counted) > 0 then
    begin
      perform public.pos_create_inventory(p_request, 'Excel იმპორტი პროდუქტების გვერდიდან', counted);
    exception when others then
      if sqlerrm <> 'NOTHING_TO_SAVE' then raise; end if;
    end;
  end if;
  return jsonb_build_object('created', created, 'updated', updated, 'deleted', deleted,
                            'deactivated', deactivated, 'stock_rows', jsonb_array_length(counted));
end $$;

revoke all on function public.pos_set_category(text, uuid, text), public.pos_products_import(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.pos_set_category(text, uuid, text), public.pos_products_import(uuid, jsonb) to authenticated;
notify pgrst, 'reload schema';
