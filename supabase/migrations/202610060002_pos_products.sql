-- Products page: full list (with stock, purchase price, sale price), add, deactivate/restore, price edit.
-- Stock changes go through pos_create_inventory (ledger), never directly.

create function public.pos_products_overview() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform public.pos_require_actor(true);
  with items as (
    select 'product'::text as kind, p.id, p.id as product_id, p.name, null::text as variant_name, p.sku, p.price,
           p.active, true as product_active
    from public.products p
    where not exists (select 1 from public.product_variants v where v.product_id = p.id)
    union all
    select 'variant', v.id, p.id, p.name, v.name, v.sku, v.price, v.active, p.active
    from public.product_variants v join public.products p on p.id = v.product_id
  ), stock as (
    select 'product'::text as kind, product_id as id, sum(quantity_change) as qty
    from public.pos_stock_movements where target_kind = 'product' and product_id is not null group by product_id
    union all
    select 'variant', variant_id, sum(quantity_change)
    from public.pos_stock_movements where target_kind = 'variant' and variant_id is not null group by variant_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'kind', i.kind, 'id', i.id, 'name', i.name, 'variant_name', i.variant_name, 'sku', i.sku,
      'price', i.price, 'stock', coalesce(s.qty, 0),
      'cost', case when i.kind = 'variant' then pv.purchase_price else pp.purchase_price end,
      'active', i.active and i.product_active
    ) order by i.name, i.variant_name nulls first, i.id), '[]'::jsonb)
  into result
  from items i
  left join stock s on s.kind = i.kind and s.id = i.id
  left join public.product_purchase_prices pp on i.kind = 'product' and pp.product_id = i.id
  left join public.product_purchase_prices pv on i.kind = 'variant' and pv.variant_id = i.id;
  return result;
end $$;

create function public.pos_create_product(p_name text, p_sku text, p_price text, p_cost text, p_weight text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  nm text := pg_catalog.regexp_replace(coalesce(p_name, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  code text := nullif(pg_catalog.regexp_replace(coalesce(p_sku, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  price numeric; cost numeric; weight numeric; pid uuid;
begin
  perform public.pos_require_actor(true);
  if length(nm) not between 1 and 200 then raise exception 'INVALID_NAME'; end if;
  if code is not null and length(code) > 100 then raise exception 'INVALID_SKU'; end if;
  if coalesce(p_price, '') !~ '^\d{1,12}(\.\d{1,2})?$' then raise exception 'INVALID_PRICE'; end if;
  if nullif(p_cost, '') is not null and p_cost !~ '^\d{1,12}(\.\d{1,2})?$' then raise exception 'INVALID_COST'; end if;
  if coalesce(p_weight, '') !~ '^\d{1,6}(\.\d{1,3})?$' then raise exception 'INVALID_WEIGHT'; end if;
  price := p_price::numeric; cost := nullif(p_cost, '')::numeric; weight := p_weight::numeric;
  if weight <= 0 then raise exception 'INVALID_WEIGHT'; end if;
  if code is not null and (exists (select 1 from public.products where lower(sku) = lower(code))
      or exists (select 1 from public.product_variants where lower(sku) = lower(code))) then
    raise exception 'SKU_TAKEN';
  end if;
  begin
    insert into public.products(name, sku, price, weight_kg, active) values (nm, code, price, weight, true)
    returning id into pid;
  exception when unique_violation then raise exception 'SKU_TAKEN';
  end;
  insert into public.product_purchase_prices(product_id, purchase_price) values (pid, cost)
  on conflict (product_id) do update set purchase_price = excluded.purchase_price;
  return pid;
end $$;

-- Change sale price and/or active flag. NULL argument = leave unchanged.
create function public.pos_update_product(p_kind text, p_id uuid, p_price text, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  perform public.pos_require_actor(true);
  if p_kind not in ('product', 'variant') then raise exception 'INVALID_TARGET'; end if;
  if p_price is not null and p_price !~ '^\d{1,12}(\.\d{1,2})?$' then raise exception 'INVALID_PRICE'; end if;
  if p_kind = 'product' then
    update public.products set price = coalesce(p_price::numeric, price), active = coalesce(p_active, active)
    where id = p_id;
  else
    update public.product_variants set price = coalesce(p_price::numeric, price), active = coalesce(p_active, active)
    where id = p_id;
  end if;
  get diagnostics changed = row_count;
  if changed = 0 then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
end $$;

revoke all on function public.pos_products_overview(), public.pos_create_product(text, text, text, text, text),
  public.pos_update_product(text, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.pos_products_overview(), public.pos_create_product(text, text, text, text, text),
  public.pos_update_product(text, uuid, text, boolean) to authenticated;

notify pgrst, 'reload schema';
