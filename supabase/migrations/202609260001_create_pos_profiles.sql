-- Run once as the database owner in the shared Supabase project.
-- This migration owns only POS profiles. Existing tables/policies are untouched.
begin;

create table public.pos_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (length(btrim(full_name)) > 0),
  role text not null constraint pos_profiles_role_check check (role in ('admin', 'cashier')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pos_profiles enable row level security;
alter table public.pos_profiles force row level security;

-- Remove any inherited default grants before allowing only own-profile reads.
revoke all on public.pos_profiles from public, anon, authenticated;
grant select on public.pos_profiles to authenticated;

create policy pos_profiles_select_own
  on public.pos_profiles for select to authenticated
  using ((select auth.uid()) = id);

-- Inactive users can read their own status, but application guards deny access.
-- No browser INSERT/UPDATE/DELETE grants or policies, including for POS admins.

create function public.pos_profiles_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.pos_profiles_set_updated_at() from public, anon, authenticated;

create trigger pos_profiles_updated_at
  before update on public.pos_profiles
  for each row execute function public.pos_profiles_set_updated_at();

commit;
