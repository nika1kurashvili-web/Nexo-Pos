-- ფოტოების სვეტების წაკითხვის უფლება (თუ products/product_variants-ზე წვდომა სვეტების მიხედვითაა გაცემული,
-- ახალი სვეტები ავტომატურად არ იკითხება). თუ უფლება უკვე ზოგადად გაქვთ, ეს უვნებელია.
begin;
grant select (image_url, image_extra) on public.products to authenticated;
grant select (image_url, image_extra) on public.product_variants to authenticated;
notify pgrst, 'reload schema';
commit;
