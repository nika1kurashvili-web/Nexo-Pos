-- Sales analytics for administrators.
--
-- Read-only aggregation over sales, sale items, returns, payments and the
-- customer ledger. Returns are subtracted from the sale line they belong to.
-- Cost comes from the Orders app's confidential product_purchase_prices table
-- (current purchase price, not a snapshot taken at the time of sale).
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
  if to_regclass('public.pos_return_items') is null then
    raise exception 'Missing prerequisite: apply 202610020001_pos_returns.sql first';
  end if;
  if to_regclass('public.product_purchase_prices') is null then
    raise exception 'Missing prerequisite: public.product_purchase_prices (Orders app)';
  end if;
end $$;

create index if not exists pos_sales_created on public.pos_sales(created_at);

-- VOLATILE on purpose: pos_require_actor() takes a FOR SHARE lock, which PostgREST
-- rejects inside the read-only transaction it opens for STABLE functions.
create or replace function public.pos_sales_analytics(
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
  item_mode boolean;
  result jsonb;
begin
  perform public.pos_require_actor(true);

  if p_type is not null and p_type not in ('retail', 'wholesale') then raise exception 'INVALID_FILTER'; end if;
  if p_from is not null and p_to is not null and p_from >= p_to then raise exception 'INVALID_FILTER'; end if;
  if p_min is not null and (p_min < 0 or p_min >= 'Infinity'::numeric) then raise exception 'INVALID_FILTER'; end if;
  if p_max is not null and (p_max < 0 or p_max >= 'Infinity'::numeric) then raise exception 'INVALID_FILTER'; end if;
  if p_min is not null and p_max is not null and p_min > p_max then raise exception 'INVALID_FILTER'; end if;
  if length(coalesce(product_filter, '')) > 100 or length(coalesce(sku_filter, '')) > 100 then raise exception 'INVALID_FILTER'; end if;

  item_mode := product_filter is not null or sku_filter is not null;

  with sel as (
    select i.id as item_id, i.sale_id, s.created_at, s.sale_type, i.product_id, i.variant_id, i.sku,
           i.product_name, i.variant_name, i.quantity, i.line_total
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
    select sel.sale_id, sel.created_at, sel.sale_type, sel.sku, sel.product_name, sel.variant_name,
           sel.product_id, sel.variant_id,
           sel.line_total as gross,
           coalesce(ret.amt, 0) as returned_amount,
           sel.quantity - coalesce(ret.qty, 0) as net_qty,
           sel.line_total - coalesce(ret.amt, 0) as net_revenue,
           case when sel.variant_id is not null then pv.purchase_price else pp.purchase_price end as unit_cost
    from sel
    left join ret on ret.sale_item_id = sel.item_id
    left join public.product_purchase_prices pp on pp.product_id = sel.product_id and sel.variant_id is null
    left join public.product_purchase_prices pv on pv.variant_id = sel.variant_id
  )
  select jsonb_build_object(
    'item_mode', item_mode,
    'totals', (select jsonb_build_object(
        'sales_count', count(distinct sale_id),
        'quantity', coalesce(sum(net_qty), 0),
        'gross', coalesce(sum(gross), 0),
        'returns', coalesce(sum(returned_amount), 0),
        'net', coalesce(sum(net_revenue), 0),
        'cost', coalesce(sum(net_qty * unit_cost) filter (where unit_cost is not null), 0),
        'profit', coalesce(sum(net_revenue) filter (where unit_cost is not null), 0)
                  - coalesce(sum(net_qty * unit_cost) filter (where unit_cost is not null), 0),
        'unknown_cost_revenue', coalesce(sum(net_revenue) filter (where unit_cost is null), 0))
      from lines),
    'weekdays', (select jsonb_agg(jsonb_build_object('day', d.day, 'sales_count', coalesce(w.sales_count, 0),
                                                      'net', coalesce(w.net, 0)) order by d.day)
      from generate_series(1, 7) as d(day)
      left join (
        select extract(isodow from created_at at time zone 'Asia/Tbilisi')::int as day,
               count(distinct sale_id) as sales_count, sum(net_revenue) as net
        from lines group by 1
      ) w on w.day = d.day),
    'types', (select coalesce(jsonb_object_agg(t.sale_type, jsonb_build_object('sales_count', t.sales_count, 'net', t.net)), '{}'::jsonb)
      from (select sale_type, count(distinct sale_id) as sales_count, sum(net_revenue) as net
            from lines group by sale_type) t),
    'top_products', (select coalesce(jsonb_agg(x.item order by x.net desc, x.name), '[]'::jsonb)
      from (select product_name || coalesce(' / ' || variant_name, '') as name, sum(net_revenue) as net,
                   jsonb_build_object('name', product_name || coalesce(' / ' || variant_name, ''), 'sku', max(sku),
                                      'quantity', sum(net_qty), 'net', sum(net_revenue)) as item
            from lines
            group by coalesce(variant_id::text, product_id::text, product_name || '|' || coalesce(variant_name, '')),
                     product_name, variant_name
            order by sum(net_revenue) desc, product_name
            limit 10) x),
    -- Money received / still owed belongs to whole sales, so it is reported only
    -- when no product filter narrows the view to individual lines.
    'received', case when item_mode then null else
      (select coalesce(sum(p.amount), 0) from public.pos_payments p
        where p.sale_id in (select sale_id from lines) and p.kind in ('sale_payment', 'repayment'))
      - (select coalesce(sum(r.total_amount - r.debt_reduction), 0) from public.pos_returns r
          where r.sale_id in (select sale_id from lines)) end,
    'debt', case when item_mode then null else
      (select coalesce(sum(t.amount), 0) from public.pos_customer_transactions t
        where t.sale_id in (select sale_id from lines)) end
  ) into result;

  return result;
end $$;

revoke all on function public.pos_sales_analytics(timestamptz, timestamptz, text, uuid, text, text, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.pos_sales_analytics(timestamptz, timestamptz, text, uuid, text, text, numeric, numeric)
  to authenticated;

commit;
