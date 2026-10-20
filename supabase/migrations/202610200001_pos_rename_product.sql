-- Products page: edit the name and the code (SKU / barcode) of a product or variant.
-- For a product row p_name is the product name; for a variant row it is the variant name.
-- p_name NULL = leave unchanged. p_sku NULL = leave unchanged, '' = clear the code.
create or replace function public.pos_rename_product(p_kind text, p_id uuid, p_name text, p_sku text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  nm text := case when p_name is null then null
    else pg_catalog.regexp_replace(p_name, '^[[:space:]]+|[[:space:]]+$', '', 'g') end;
  code text := case when p_sku is null then null
    else nullif(pg_catalog.regexp_replace(p_sku, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') end;
  changed integer;
begin
  perform public.pos_require_actor(true);
  if p_kind not in ('product', 'variant') then raise exception 'INVALID_TARGET'; end if;
  if nm is not null and length(nm) not between 1 and 200 then raise exception 'INVALID_NAME'; end if;
  if code is not null and length(code) > 100 then raise exception 'INVALID_SKU'; end if;
  if code is not null and (exists (select 1 from public.products where lower(sku) = lower(code) and id <> p_id)
      or exists (select 1 from public.product_variants where lower(sku) = lower(code) and id <> p_id)) then
    raise exception 'SKU_TAKEN';
  end if;
  begin
    if p_kind = 'product' then
      update public.products
         set name = coalesce(nm, name), sku = case when p_sku is null then sku else code end
       where id = p_id;
    else
      update public.product_variants
         set name = coalesce(nm, name), sku = case when p_sku is null then sku else code end
       where id = p_id;
    end if;
  exception when unique_violation then raise exception 'SKU_TAKEN';
  end;
  get diagnostics changed = row_count;
  if changed = 0 then raise exception 'CATALOG_ITEM_UNAVAILABLE'; end if;
end $$;

revoke all on function public.pos_rename_product(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.pos_rename_product(text, uuid, text, text) to authenticated;
notify pgrst, 'reload schema';
