-- Admin-only: permanently delete one sale together with everything that belongs to it.
--   * its items, payments, customer-ledger rows (debt),
--   * its returns (items + refunds),
--   * the stock movements written for the sale and for its returns.
-- Because stock, debt and drawer cash are all derived from those rows, deleting them
-- gives the money and the stock back automatically. Site stock is recalculated.
-- The two "immutable" trigger groups are switched off only inside this transaction.
create or replace function public.pos_delete_sale(p_sale uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  item_ids uuid[];
  return_ids uuid[];
  return_item_ids uuid[];
  prod_ids uuid[];
  var_ids uuid[];
begin
  perform public.pos_require_actor(true);
  perform 1 from public.pos_sales where id = p_sale for update;
  if not found then raise exception 'SALE_NOT_FOUND'; end if;

  select coalesce(array_agg(id), '{}'::uuid[]) into item_ids from public.pos_sale_items where sale_id = p_sale;
  select coalesce(array_agg(id), '{}'::uuid[]) into return_ids from public.pos_returns where sale_id = p_sale;
  select coalesce(array_agg(id), '{}'::uuid[]) into return_item_ids from public.pos_return_items where return_id = any(return_ids);

  select coalesce(array_agg(distinct m.product_id) filter (where m.target_kind = 'product' and m.product_id is not null), '{}'::uuid[]),
         coalesce(array_agg(distinct m.variant_id) filter (where m.target_kind = 'variant' and m.variant_id is not null), '{}'::uuid[])
    into prod_ids, var_ids
    from public.pos_stock_movements m
   where m.document_id = any(item_ids) or m.document_id = any(return_item_ids);

  alter table public.pos_returns disable trigger pos_returns_no_change;
  alter table public.pos_return_items disable trigger pos_return_items_no_change;
  alter table public.pos_return_refunds disable trigger pos_return_refunds_no_change;
  alter table public.pos_stock_movements disable trigger pos_stock_movements_no_change;

  delete from public.pos_return_refunds where return_id = any(return_ids);
  delete from public.pos_stock_movements where document_id = any(item_ids) or document_id = any(return_item_ids);
  delete from public.pos_return_items where return_id = any(return_ids);
  delete from public.pos_customer_transactions where sale_id = p_sale;
  delete from public.pos_returns where sale_id = p_sale;
  delete from public.pos_payments where sale_id = p_sale;
  delete from public.pos_sale_items where sale_id = p_sale;
  delete from public.pos_sales where id = p_sale;

  alter table public.pos_returns enable trigger pos_returns_no_change;
  alter table public.pos_return_items enable trigger pos_return_items_no_change;
  alter table public.pos_return_refunds enable trigger pos_return_refunds_no_change;
  alter table public.pos_stock_movements enable trigger pos_stock_movements_no_change;

  -- the Orders site shows the POS stock: recalculate it for the affected items
  update public.products p
     set stock = greatest(0, (select coalesce(sum(m.quantity_change), 0) from public.pos_stock_movements m
                               where m.target_kind = 'product' and m.product_id = p.id))
   where p.id = any(prod_ids)
     and not exists (select 1 from public.product_variants v where v.product_id = p.id and v.active);
  update public.product_variants v
     set stock = greatest(0, (select coalesce(sum(m.quantity_change), 0) from public.pos_stock_movements m
                               where m.target_kind = 'variant' and m.variant_id = v.id))
   where v.id = any(var_ids);
end $$;

revoke all on function public.pos_delete_sale(uuid) from public, anon, authenticated;
grant execute on function public.pos_delete_sale(uuid) to authenticated;
notify pgrst, 'reload schema';
