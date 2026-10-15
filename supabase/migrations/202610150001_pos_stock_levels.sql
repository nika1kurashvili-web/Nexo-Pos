-- მარაგის ნაშთი ახალი გაყიდვის ეკრანისთვის (მოლარეც ხედავს).
-- pos_stock_movements ცხრილი მხოლოდ ადმინისთვისაა წაკითხვადი, ამიტომ ნაშთს ვაბრუნებთ დაცული ფუნქციით:
-- მხოლოდ რაოდენობა, ფასების გარეშე.
create or replace function public.pos_stock_levels() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform public.pos_require_actor(false);
  select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'id', t.id, 'stock', t.qty)), '[]'::jsonb)
  into result
  from (
    select 'product'::text as kind, product_id as id, sum(quantity_change) as qty
    from public.pos_stock_movements where target_kind = 'product' and product_id is not null group by product_id
    union all
    select 'variant', variant_id, sum(quantity_change)
    from public.pos_stock_movements where target_kind = 'variant' and variant_id is not null group by variant_id
  ) t;
  return result;
end $$;

revoke all on function public.pos_stock_levels() from public, anon;
grant execute on function public.pos_stock_levels() to authenticated;
notify pgrst, 'reload schema';
