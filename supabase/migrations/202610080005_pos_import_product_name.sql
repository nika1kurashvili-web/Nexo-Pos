-- Excel import: a product name changed on a variant row renames the whole product.
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
        if item ? 'product_name' then
          if length(btrim(item->>'product_name')) not between 1 and 200 then raise exception 'INVALID_NAME'; end if;
          if kind = 'product' then
            update public.products set name = btrim(item->>'product_name') where id = target;
          else
            update public.products set name = btrim(item->>'product_name')
            where id = (select product_id from public.product_variants where id = target);
          end if;
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

revoke all on function public.pos_products_import(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.pos_products_import(uuid, jsonb) to authenticated;
notify pgrst, 'reload schema';
