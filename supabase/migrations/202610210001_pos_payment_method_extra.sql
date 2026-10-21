-- New payment method: ექსტრა
insert into public.pos_payment_methods(code, name, active)
values ('extra', 'ექსტრა', true)
on conflict (code) do update set name = excluded.name, active = true;
