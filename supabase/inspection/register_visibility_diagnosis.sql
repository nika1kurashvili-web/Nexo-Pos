-- READ ONLY; one result set. Run manually as owner in the intended project's
-- SQL Editor. Compare cashier_id with the signed-in Auth user ID privately.
-- SQL Editor auth.uid() is NOT the browser user's ID.
select 'open_session' as section, s.id::text as object_name,
  jsonb_build_object('register_id',s.register_id,'register_name',r.name,
    'cashier_id',s.cashier_id,'cashier_name',p.full_name,'active',p.active,
    'opened_at',s.opened_at,'opening_cash',s.opening_cash) as details
from public.pos_register_sessions s join public.pos_registers r on r.id=s.register_id
join public.pos_profiles p on p.id=s.cashier_id where s.status='open'
union all
select 'indexes',indexname,jsonb_build_object('definition',indexdef)
from pg_catalog.pg_indexes where schemaname='public' and tablename='pos_register_sessions'
union all
select 'policies',tablename||'.'||policyname,jsonb_build_object('roles',roles,'command',cmd,'using',qual,'check',with_check)
from pg_catalog.pg_policies where schemaname='public' and tablename in ('pos_register_sessions','pos_profiles','pos_payments')
union all
select 'open_session_count','all',jsonb_build_object('count',count(*))
from public.pos_register_sessions where status='open'
order by section,object_name;
