-- პროდუქტის ფოტოები.
-- ფაილები ინახება Supabase Storage-ში (საჯარო bucket "product-images"), ბაზაში კი მხოლოდ
-- ბმული (image_url) products და product_variants ცხრილებში. ბრაუზერები ფოტოს პირდაპირ
-- Supabase CDN-დან იღებენ, ამიტომ POS საიტი (Vercel) ამით არ იტვირთება.
-- ატვირთვა მხოლოდ POS ადმინისტრატორს შეუძლია.
begin;

alter table public.products add column if not exists image_url text;
alter table public.product_variants add column if not exists image_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists pos_product_images_select on storage.objects;
drop policy if exists pos_product_images_insert on storage.objects;
drop policy if exists pos_product_images_update on storage.objects;
drop policy if exists pos_product_images_delete on storage.objects;
create policy pos_product_images_select on storage.objects for select to authenticated
  using (bucket_id = 'product-images' and public.pos_role() = 'admin');
create policy pos_product_images_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and public.pos_role() = 'admin');
create policy pos_product_images_update on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and public.pos_role() = 'admin')
  with check (bucket_id = 'product-images' and public.pos_role() = 'admin');
create policy pos_product_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and public.pos_role() = 'admin');

-- ბმულების ჩაწერა (ერთი ან ბევრი). null = ფოტოს მოხსნა.
create function public.pos_set_product_images(p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare r jsonb; n integer := 0; k text; u text; i uuid;
begin
  perform public.pos_require_actor(true);
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    raise exception 'INVALID_ITEMS';
  end if;
  for r in select value from jsonb_array_elements(p_items) loop
    k := r->>'kind';
    u := nullif(r->>'url', '');
    if jsonb_typeof(r) <> 'object' or k not in ('product', 'variant')
       or coalesce(r->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'INVALID_ITEMS';
    end if;
    -- მხოლოდ ჩვენი bucket-ის ბმული, თვითნებური მისამართი დაუშვებელია
    if u is not null and u !~ '^https://[A-Za-z0-9.-]+/storage/v1/object/public/product-images/[A-Za-z0-9._/-]+([?]v=[0-9]+)?$' then
      raise exception 'INVALID_URL';
    end if;
    i := (r->>'id')::uuid;
    if k = 'product' then
      update public.products set image_url = u where id = i;
    else
      update public.product_variants set image_url = u where id = i;
    end if;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

revoke all on function public.pos_set_product_images(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.pos_set_product_images(jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
