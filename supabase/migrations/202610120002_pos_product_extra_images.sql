-- დამატებითი ფოტოები: მთავარი ფოტო რჩება image_url-ში, დანარჩენი (მაქს. 6) image_extra სიაში.
begin;

alter table public.products add column if not exists image_extra text[] not null default '{}';
alter table public.product_variants add column if not exists image_extra text[] not null default '{}';

create function public.pos_set_product_extras(p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare r jsonb; n integer := 0; k text; i uuid; urls text[]; u text;
begin
  perform public.pos_require_actor(true);
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'INVALID_ITEMS';
  end if;
  for r in select value from jsonb_array_elements(p_items) loop
    k := r->>'kind';
    if jsonb_typeof(r) <> 'object' or k not in ('product', 'variant')
       or coalesce(r->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(r->'urls') <> 'array' or jsonb_array_length(r->'urls') > 6 then
      raise exception 'INVALID_ITEMS';
    end if;
    urls := '{}';
    for u in select jsonb_array_elements_text(r->'urls') loop
      if u !~ '^https://[A-Za-z0-9.-]+/storage/v1/object/public/product-images/[A-Za-z0-9._/-]+$' then
        raise exception 'INVALID_URL';
      end if;
      urls := urls || u;
    end loop;
    i := (r->>'id')::uuid;
    if k = 'product' then
      update public.products set image_extra = urls where id = i;
    else
      update public.product_variants set image_extra = urls where id = i;
    end if;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

revoke all on function public.pos_set_product_extras(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.pos_set_product_extras(jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
