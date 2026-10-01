-- Read-only, one result set. Run manually AFTER the cash-withdrawal migration.
with checks as (
  select 'withdrawal RLS enabled/forced' check_name,
    coalesce((select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class
      where oid=to_regclass('public.pos_cash_withdrawals')),false) passed
  union all
  select 'required function: '||s, to_regprocedure(s) is not null
  from unnest(array['public.pos_record_cash_withdrawal(uuid,uuid,text,text)',
    'public.pos_session_cash_totals(uuid)','public.pos_cash_withdrawals_immutable()']) s
  union all
  select r||' has no direct financial writes',not exists(
    select 1 from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p
    where has_table_privilege(r,'public.pos_cash_withdrawals',p))
  from unnest(array['anon','authenticated','service_role']) r
  union all
  select r||' cannot call private totals',not has_function_privilege(r,'public.pos_session_cash_totals(uuid)','EXECUTE')
  from unnest(array['anon','authenticated','service_role']) r
  union all
  select 'authenticated RPC execute',has_function_privilege('authenticated','public.pos_record_cash_withdrawal(uuid,uuid,text,text)','EXECUTE')
  union all
  select 'anon RPC denied',not has_function_privilege('anon','public.pos_record_cash_withdrawal(uuid,uuid,text,text)','EXECUTE')
  union all
  select 'immutable triggers',count(*)=2 from pg_catalog.pg_trigger
    where tgrelid='public.pos_cash_withdrawals'::regclass and not tgisinternal and tgenabled='O'
  union all
  select 'empty search_path/definer: '||proname,prosecdef and 'search_path=""'=any(proconfig)
    from pg_catalog.pg_proc where oid in ('public.pos_record_cash_withdrawal(uuid,uuid,text,text)'::regprocedure,
      'public.pos_session_cash_totals(uuid)'::regprocedure,'public.pos_close_register(uuid,text,text)'::regprocedure,
      'public.pos_register_state()'::regprocedure,'public.pos_register_session_report(timestamptz,timestamptz,uuid,uuid,text)'::regprocedure)
  union all
  select 'last-close fields retained',position('last_actual_closing_cash' in pg_get_functiondef('public.pos_register_state()'::regprocedure))>0
)
select check_name,case when passed then 'PASS' else 'FAIL' end result from checks order by check_name;
