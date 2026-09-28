-- Run once manually as the database owner. No production SQL is executed by the app.
begin;

-- Keep confidential costs OUT of the broadly readable products/variants tables.
-- Derive FK column types from the existing schema rather than assuming UUID IDs.
create table public.product_purchase_prices as
  select p.id as product_id, v.id as variant_id, null::numeric as purchase_price
  from public.products p cross join public.product_variants v
  with no data;
alter table public.product_purchase_prices
  add constraint purchase_price_one_item check (num_nonnulls(product_id, variant_id) = 1),
  add constraint purchase_price_nonnegative check (
    purchase_price is null or
    (purchase_price >= 0 and purchase_price::text not in ('NaN', 'Infinity', '-Infinity'))
  ),
  add constraint purchase_price_product_unique unique (product_id),
  add constraint purchase_price_variant_unique unique (variant_id),
  add constraint purchase_price_product_fk foreign key (product_id) references public.products(id) on delete cascade,
  add constraint purchase_price_variant_fk foreign key (variant_id) references public.product_variants(id) on delete cascade;

alter table public.product_purchase_prices enable row level security;
alter table public.product_purchase_prices force row level security;
revoke all on public.product_purchase_prices from public, anon, authenticated;
grant select, insert, update, delete on public.product_purchase_prices to authenticated;
create policy purchase_prices_admin on public.product_purchase_prices
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy purchase_prices_admin_required on public.product_purchase_prices
  as restrictive for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- SECURITY INVOKER retains the caller's existing catalog RLS. Item and cost
-- creation form one transaction; cost failure cannot leave a half-created item.
create function public.nexo_create_catalog_item(p_kind text, p_item jsonb, p_purchase_price numeric default null)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  product public.products%rowtype;
  variant public.product_variants%rowtype;
begin
  if not public.is_admin() then raise exception 'Only active admins may create catalog items'; end if;
  if p_kind = 'product' then
    insert into public.products(name, sku, price, weight_kg, active)
    values (p_item->>'name', nullif(p_item->>'sku', ''), (p_item->>'price')::numeric,
            (p_item->>'weight_kg')::numeric, true)
    returning * into product;
    insert into public.product_purchase_prices(product_id, purchase_price)
    values (product.id, p_purchase_price);
    return to_jsonb(product);
  elsif p_kind = 'variant' then
    -- jsonb_populate_record uses the actual product_id type from the schema.
    variant := jsonb_populate_record(null::public.product_variants, p_item);
    insert into public.product_variants(product_id, name, sku, price, weight_kg, active)
    values (variant.product_id, variant.name, nullif(variant.sku, ''), variant.price, variant.weight_kg, true)
    returning * into variant;
    insert into public.product_purchase_prices(variant_id, purchase_price)
    values (variant.id, p_purchase_price);
    return to_jsonb(variant);
  else
    raise exception 'Invalid catalog item kind';
  end if;
end;
$$;
revoke all on function public.nexo_create_catalog_item(text, jsonb, numeric) from public, anon;
grant execute on function public.nexo_create_catalog_item(text, jsonb, numeric) to authenticated;

commit;
