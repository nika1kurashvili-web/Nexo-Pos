-- Edit the purchase (cost) price of a product or variant from the Products page.
create function public.pos_set_cost(p_kind text, p_id uuid, p_cost text) returns void
language plpgsql security definer set search_path = '' as $$
declare found_row boolean;
begin
  perform public.pos_require_actor(true);
  if p_kind not in ('product', 'variant') then raise exception 'INVALID_TARGET'; end if;
  if coalesce(p_cost, '') !~ '^\d{1,12}(\.\d{1,2})?$' then raise exception 'INVALID_COST'; end if;
  if p_kind = 'product' then
    select exists (select 1 from public.products where id = p_id) into found_row;
    if not found_row then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
    insert into public.product_purchase_prices(product_id, purchase_price) values (p_id, p_cost::numeric)
    on conflict (product_id) do update set purchase_price = excluded.purchase_price;
  else
    select exists (select 1 from public.product_variants where id = p_id) into found_row;
    if not found_row then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
    insert into public.product_purchase_prices(variant_id, purchase_price) values (p_id, p_cost::numeric)
    on conflict (variant_id) do update set purchase_price = excluded.purchase_price;
  end if;
end $$;

revoke all on function public.pos_set_cost(text, uuid, text) from public, anon, authenticated;
grant execute on function public.pos_set_cost(text, uuid, text) to authenticated;
notify pgrst, 'reload schema';
