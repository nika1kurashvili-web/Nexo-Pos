-- Per-product breakdown for the analytics Excel export.
-- Same filters and rules as pos_sales_analytics (returns subtracted, current
-- purchase price as cost), but one row per product/variant instead of a top-10.
begin;
set local lock_timeout = '10s';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Run this migration as the Supabase owner role (postgres); it must bypass RLS.';
  end if;
  if to_regprocedure('public.pos_sales_analytics(timestamp with time zone,timestamp with time zone,text,uuid,text,text,numeric,numeric)') is null then
    raise exception 'Missing prerequisite: apply 202610030001_pos_analytics.sql first';
  end if;
end $$;

-- VOLATILE on purpose (pos_require_actor() takes a FOR SHARE lock).
create or replace function public.pos_sales_analytics_products(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_type text default null,
  p_customer uuid default null,
  p_product text default null,
  p_sku text default null,
  p_min numeric default null,
  p_max numeric default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  product_filter text := nullif(lower(btrim(p_product)), '');
  sku_filter text := nullif(lower(btrim(p_sku)), '');
  result jsonb;
begin
  perform public.pos_require_actor(true);

  if p_type is not null and p_type not in ('retail', 'wholesale') then raise exception 'INVALID_FILTER'; end if;
  if p_from is not null and p_to is not null and p_from >= p_to then raise exception 'INVALID_FILTER'; end if;
  if p_min is not null and (p_min < 0 or p_min >= 'Infinity'::numeric) then raise exception 'INVALID_FILTER'; end if;
  if p_max is not null and (p_max < 0 or p_max >= 'Infinity'::numeric) then raise exception 'INVALID_FILTER'; end if;
  if p_min is not null and p_max is not null and p_min > p_max then raise exception 'INVALID_FILTER'; end if;
  if length(coalesce(product_filter, '')) > 100 or length(coalesce(sku_filter, '')) > 100 then raise exception 'INVALID_FILTER'; end if;

  with sel as (
    select i.id as item_id, i.product_id, i.variant_id, i.sku, i.product_name, i.variant_name,
           i.quantity, i.line_total
    from public.pos_sale_items i
    join public.pos_sales s on s.id = i.sale_id
    where (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at < p_to)
      and (p_type is null or s.sale_type = p_type)
      and (p_customer is null or s.customer_id = p_customer)
      and (p_min is null or s.total >= p_min)
      and (p_max is null or s.total <= p_max)
      and (product_filter is null
           or position(product_filter in lower(i.product_name || ' ' || coalesce(i.variant_name, ''))) > 0)
      and (sku_filter is null or position(sku_filter in lower(coalesce(i.sku, ''))) > 0)
  ), ret as (
    select ri.sale_item_id, sum(ri.quantity) as qty, sum(ri.amount) as amt
    from public.pos_return_items ri
    where ri.sale_item_id in (select item_id from sel)
    group by ri.sale_item_id
  ), lines as (
    select sel.sku, sel.product_name, sel.variant_name, sel.product_id, sel.variant_id,
           sel.quantity - coalesce(ret.qty, 0) as net_qty,
           sel.line_total - coalesce(ret.amt, 0) as net_revenue,
           case when sel.variant_id is not null then pv.purchase_price else pp.purchase_price end as unit_cost
    from sel
    left join ret on ret.sale_item_id = sel.item_id
    left join public.product_purchase_prices pp on pp.product_id = sel.product_id and sel.variant_id is null
    left join public.product_purchase_prices pv on pv.variant_id = sel.variant_id
  ), grouped as (
    select product_name || coalesce(' / ' || variant_name, '') as name,
           max(sku) as sku,
           sum(net_qty) as quantity,
           sum(net_revenue) as revenue,
           max(unit_cost) as unit_cost,
           bool_or(unit_cost is null) as cost_unknown
    from lines
    group by coalesce(variant_id::text, product_id::text, product_name || '|' || coalesce(variant_name, '')),
             product_name, variant_name
    order by sum(net_revenue) desc, product_name
    limit 5000
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'name', name,
      'sku', sku,
      'quantity', quantity,
      'revenue', revenue,
      'avg_price', case when quantity > 0 then round(revenue / quantity, 2) else null end,
      'unit_cost', case when cost_unknown then null else unit_cost end,
      'cost', case when cost_unknown then null else quantity * unit_cost end,
      'profit', case when cost_unknown then null else revenue - quantity * unit_cost end
    ) order by revenue desc, name), '[]'::jsonb)
  into result
  from grouped;

  return result;
end $$;

revoke all on function public.pos_sales_analytics_products(timestamptz, timestamptz, text, uuid, text, text, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.pos_sales_analytics_products(timestamptz, timestamptz, text, uuid, text, text, numeric, numeric)
  to authenticated;

commit;
