-- A product that has variants (active or not) is only a name: it must never be listed as a stand-alone sellable item.
create or replace function public.pos_inventory_catalog() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform public.pos_require_actor(true);
  with items as (
    select 'product'::text as kind, p.id, p.name, null::text as variant_name, p.sku, p.price
    from public.products p
    where p.active
      and not exists (select 1 from public.product_variants v where v.product_id = p.id)
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
notify pgrst, 'reload schema';
