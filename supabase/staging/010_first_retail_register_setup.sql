-- MANUAL SETUP ONLY: nexo-staging SQL Editor, postgres role.
-- Confirm the selected Dashboard project is nexo-staging BEFORE running.
-- This writes one named test register if absent. It does not impersonate a cashier.
-- Never run in production. Do not rerun migrations. No cleanup/reset is performed.
begin;
insert into public.pos_registers(name, active)
values ('STAGING - FIRST RETAIL SMOKE', true)
on conflict (name) do nothing;

do $$
begin
  if not exists (select 1 from public.pos_registers
    where name = 'STAGING - FIRST RETAIL SMOKE' and active) then
    raise exception 'Staging smoke register is inactive; inspect it, do not reset it';
  end if;
  if exists (select 1 from public.pos_register_sessions s
    join public.pos_registers r on r.id = s.register_id
    where r.name = 'STAGING - FIRST RETAIL SMOKE' and s.status = 'open') then
    raise exception 'Staging smoke register already has an open session; inspect before proceeding';
  end if;
end $$;
commit;

select id, name, active
from public.pos_registers
where name = 'STAGING - FIRST RETAIL SMOKE';
