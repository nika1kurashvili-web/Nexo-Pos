-- STAGING ONLY: run first in the EMPTY nexo-staging project's SQL Editor.
-- Minimal pre-fix reconstruction, not a complete/exact production schema dump.
-- See supabase/staging/README.md for verified facts versus fixture assumptions.
-- Does NOT create Auth infrastructure, Auth users, Orders transactions or POS tables.
-- Existing application objects/users cause failure; never run against production.
begin;
set local lock_timeout = '10s';

do $$ begin
  if to_regclass('auth.users') is null or to_regprocedure('auth.uid()') is null then
    raise exception 'Use an initialized empty Supabase project with managed Auth';
  end if;
  if exists (select 1 from auth.users) then
    raise exception 'STAGING_BOOTSTRAP_REQUIRES_NO_AUTH_USERS';
  end if;
  if exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('profiles','products','product_variants',
      'product_purchase_prices','pos_profiles','pos_sales')) then
    raise exception 'STAGING_BOOTSTRAP_REQUIRES_EMPTY_APPLICATION_SCHEMA';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Run as staging database owner with BYPASSRLS or superuser privileges';
  end if;
  if (select count(*) from pg_catalog.pg_roles where rolname in ('anon','authenticated','service_role')) <> 3 then
    raise exception 'Standard Supabase API roles required';
  end if;
end $$;

-- Verified production defaults: every legacy Auth user becomes active operator.
-- UUID catalog IDs/column sizes below are fixture choices, not verified live DDL.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'operator' constraint profiles_role_check check (role in ('admin','operator','manager')),
  active boolean not null default true,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sku text,
  price numeric(12,2) not null default 0 check (price >= 0 and price < 'Infinity'::numeric),
  weight_kg numeric(12,3) check (weight_kg >= 0 and weight_kg < 'Infinity'::numeric),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,
  sku text,
  price numeric(12,2) not null default 0 check (price >= 0 and price < 'Infinity'::numeric),
  weight_kg numeric(12,3) check (weight_kg >= 0 and weight_kg < 'Infinity'::numeric),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index staging_products_sku on public.products(sku);
create index staging_variants_sku on public.product_variants(sku);
create index staging_variants_product on public.product_variants(product_id);

-- is_admin/is_active_user reproduce membership semantics; exact original bodies
-- were not supplied. nexo_active_role matches the Orders repository migration.
create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id=auth.uid() and active=true and role='admin');
$$;
create function public.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id=auth.uid() and active=true);
$$;
create function public.nexo_active_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id=auth.uid() and active=true;
$$;
revoke all on function public.is_admin(),public.is_active_user(),public.nexo_active_role() from public,anon;
grant execute on function public.is_admin(),public.is_active_user(),public.nexo_active_role() to authenticated,service_role;

create function public.set_updated_at() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin new.updated_at := now(); return new; end;
$$;
revoke all on function public.set_updated_at() from public,anon,authenticated;
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger products_updated_at before update on public.products for each row execute function public.set_updated_at();
create trigger product_variants_updated_at before update on public.product_variants for each row execute function public.set_updated_at();

-- Deliberately PRE-FIX behavior supplied from production. No app marker check!
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id,full_name)
  values(new.id,coalesce(new.raw_user_meta_data->>'full_name',new.email));
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public,anon,authenticated;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
revoke all on public.profiles,public.products,public.product_variants from public,anon,authenticated;
grant select,insert,update,delete on public.profiles,public.products,public.product_variants to authenticated,service_role;

-- Known products SELECT uses old Orders membership, NOT pos_profiles.
create policy products_select on public.products for select to authenticated using(public.is_active_user());
-- Verified broad existing variants SELECT; no extra variants policy needed by POS.
create policy product_variants_select on public.product_variants for select to authenticated using(true);
create policy staging_profiles_select on public.profiles for select to authenticated using(id=auth.uid() or public.is_admin());
-- Admin-only permissive writes are described in the Orders deployment notes.
-- Original policy names/expressions unavailable: staging_* identifies reconstruction.
do $$ declare t text; begin
  foreach t in array array['profiles','products','product_variants'] loop
    execute format('create policy staging_admin_insert on public.%I for insert to authenticated with check (public.is_admin())',t);
    execute format('create policy staging_admin_update on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())',t);
    execute format('create policy staging_admin_delete on public.%I for delete to authenticated using (public.is_admin())',t);
    -- Exact relevant subset of Orders 202609250001; no order tables or courier RPCs.
    execute format('create policy nexo_no_manager_insert on public.%I as restrictive for insert to authenticated with check (public.nexo_active_role() in (''admin'',''operator''))',t);
    execute format('create policy nexo_no_manager_update on public.%I as restrictive for update to authenticated using (public.nexo_active_role() in (''admin'',''operator'')) with check (public.nexo_active_role() in (''admin'',''operator''))',t);
    execute format('create policy nexo_no_manager_delete on public.%I as restrictive for delete to authenticated using (public.nexo_active_role() in (''admin'',''operator''))',t);
  end loop;
end $$;
create policy nexo_manager_read_profiles on public.profiles for select to authenticated using(public.nexo_active_role()='manager');
create policy nexo_manager_read_products on public.products for select to authenticated using(public.nexo_active_role()='manager');

-- Minimal fictional catalog. Fixed UUIDs allow repeatable smoke/concurrency setup.
insert into public.products(id,name,sku,price,weight_kg) values
 ('11111111-1111-4111-8111-111111111111','STAGING standalone item','STG-SINGLE',10.00,0.100),
 ('22222222-2222-4222-8222-222222222222','STAGING variant parent','STG-PARENT',20.00,0.200);
insert into public.product_variants(id,product_id,name,sku,price,weight_kg) values
 ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','STAGING small','STG-SMALL',20.00,0.200),
 ('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','STAGING large','STG-LARGE',25.00,0.250);

-- Existing purchase-cost table and catalog RPC follow, copied from Orders
-- 202609250002_product_purchase_prices.sql, with only its outer transaction removed.

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
