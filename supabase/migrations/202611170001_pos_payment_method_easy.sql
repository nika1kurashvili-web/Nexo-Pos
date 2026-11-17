-- New payment method: EASY (selected by default in the sale terminal)
insert into public.pos_payment_methods(code, name, active)
values ('easy', 'EASY', true)
on conflict (code) do update set name = excluded.name, active = true;
