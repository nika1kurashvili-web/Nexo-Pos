-- READ ONLY -- run manually ONLY in nexo-staging as postgres in SQL Editor.
-- One SELECT statement / one exportable result set. No application RPCs are called.
-- Baseline: repository migration 002 + 001 + explicit-membership prerequisite,
-- and the supplied pre-002 staging preflight CSV (catalog policies/grants/helpers).
-- PASS checks metadata, not runtime concurrency or business behavior. FAIL needs review.
-- INFO rows supply evidence/limitations. Do not infer project identity from database name.
-- The payment seed query intentionally reads only six configuration rows, no business data.
-- If pos_payment_methods is absent, PostgreSQL reports the missing relation: STOP/review.
-- Function bodies are fingerprinted, not exported (avoids leaking unexpected literals).
-- Fingerprints normalize line comments, whitespace and a final semicolon only.
with
expected_tables(name) as (values
 ('public.pos_business_customers'),
 ('public.pos_registers'),
 ('public.pos_payment_methods'),
 ('public.pos_customer_prices'),
 ('public.pos_register_sessions'),
 ('public.pos_sales'),
 ('public.pos_sale_items'),
 ('public.pos_payments'),
 ('public.pos_customer_transactions')
), expected_functions(signature,scope,definer,auth_execute,service_execute,body_md5) as (values
 ('public.pos_role()','phase1',true,true,true,'16de8bef65eaf94fd11b505858ec0b79'),
 ('public.pos_require_actor(boolean)','phase1',true,false,true,'4bb10c2352d8f1f00fdb097f8f8605f9'),
 ('public.pos_decimal(text,integer,boolean)','phase1',false,false,true,'6a56f73dbc21ce34ee82a48ed2cbf3e0'),
 ('public.pos_open_register(uuid,text)','phase1',true,true,true,'17747d7d08353bfd41d8bd81334aeb11'),
 ('public.pos_close_register(uuid,text,text)','phase1',true,true,true,'03f6f544d2f18458d225c6e5ed6ba0c4'),
 ('public.pos_quote(text,text,text,uuid)','phase1',true,true,true,'0c81a2d6c66aafa369e90d68d191ffd9'),
 ('public.pos_set_customer_prices(uuid,jsonb)','phase1',true,true,true,'625b7e2fc2d9c9586a007eb17c246809'),
 ('public.pos_normalize_sale_request(uuid,uuid,text,uuid,text,jsonb,jsonb)','phase1',false,false,true,'9efdc0d30f5372c4e2129d0e705f74ac'),
 ('public.pos_complete_sale(uuid,uuid,text,uuid,text,jsonb,jsonb)','phase1',true,true,true,'ff917baf38ea127c2ca6e385293af7d9'),
 ('public.pos_record_repayment(uuid,uuid,uuid,text,text)','phase1',true,true,true,'114f8b9666e3be714e5e6e9da481f75e'),
 ('public.pos_import_customer_prices(uuid,jsonb)','phase1',true,true,true,'40209b99bf79ae796ce0f35b6849d617'),
 ('public.pos_customer_balance(uuid)','phase1',true,true,true,'d29ee8fda7d075136560c551f453e609'),
 ('public.nexo_finalize_user_memberships(uuid)','prerequisite',true,false,true,'a90747221dbf8fbd5b31e4e2da7880ff'),
 ('public.handle_new_user()','prerequisite',true,false,false,'592a97aae146e51ef81a65a588bf973b'),
 ('public.nexo_provisioning_version()','prerequisite',false,false,true,'f6bf37efedbc0a2dfffc1caf5088d86e'),
 ('public.pos_profiles_set_updated_at()','profile_helper',false,false,true,'494c5a61690c77d73ce0d415f244e276'),
 ('public.is_active_user()','catalog_baseline',true,true,true,'13c5c4412b1b2b6641a72aa4ed185699'),
 ('public.is_admin()','catalog_baseline',true,true,true,'14b8de1c07e474f660bf96fd2cd169ea'),
 ('public.nexo_active_role()','catalog_baseline',true,true,true,'dc64a1db592dce87f6cd1108da860418'),
 ('public.nexo_create_catalog_item(text,jsonb,numeric)','catalog_baseline',false,true,true,'481d1c53a55dd0e8ea0ddd1c8c9cb194')
), expected_policies(table_name,name,command,using_expr,check_expr,permissive) as (values
 ('public.products','pos_active_users_select_products','SELECT','exists (select 1 from public.pos_profiles pp
  where pp.id = (select auth.uid()) and pp.active = true)',null,true),
 ('public.pos_business_customers','pos_customers_read','SELECT','public.pos_role() = ''admin'' or (public.pos_role() = ''cashier'' and active)',null,true),
 ('public.pos_customer_prices','pos_prices_read','SELECT','public.pos_role() = ''admin'' or (public.pos_role() = ''cashier'' and exists
   (select 1 from public.pos_business_customers c where c.id = customer_id and c.active))',null,true),
 ('public.pos_registers','pos_registers_read','SELECT','public.pos_role() = ''admin'' or (public.pos_role() = ''cashier'' and active)',null,true),
 ('public.pos_payment_methods','pos_methods_read','SELECT','public.pos_role() = ''admin'' or (public.pos_role() = ''cashier'' and active)',null,true),
 ('public.pos_register_sessions','pos_sessions_read','SELECT','public.pos_role() = ''admin'' or (public.pos_role() = ''cashier'' and cashier_id = auth.uid())',null,true),
 ('public.pos_sales','pos_sales_read','SELECT','public.pos_role() = ''admin'' or (public.pos_role() = ''cashier'' and cashier_id = auth.uid())',null,true),
 ('public.pos_sale_items','pos_items_read','SELECT','exists (select 1 from public.pos_sales s where s.id = sale_id)',null,true),
 ('public.pos_payments','pos_payments_read','SELECT','public.pos_role() = ''admin'' or (public.pos_role() = ''cashier'' and received_by = auth.uid())',null,true),
 ('public.pos_customer_transactions','pos_transactions_admin_read','SELECT','public.pos_role() = ''admin''',null,true),
 ('public.pos_business_customers','pos_customers_admin_insert','INSERT',null,'public.pos_role() = ''admin''',true),
 ('public.pos_business_customers','pos_customers_admin_update','UPDATE','public.pos_role() = ''admin''','public.pos_role() = ''admin''',true),
 ('public.pos_registers','pos_registers_admin_insert','INSERT',null,'public.pos_role() = ''admin''',true),
 ('public.pos_registers','pos_registers_admin_update','UPDATE','public.pos_role() = ''admin''','public.pos_role() = ''admin''',true),
 ('public.pos_payment_methods','pos_methods_admin_update','UPDATE','public.pos_role() = ''admin''','public.pos_role() = ''admin''',true),
 ('public.pos_profiles','pos_profiles_select_own','SELECT','(( SELECT auth.uid() AS uid) = id)',null,true),
 ('public.product_variants','nexo_no_manager_delete','DELETE','(nexo_active_role() = ANY (ARRAY[''admin''::text, ''operator''::text]))',null,false),
 ('public.product_variants','nexo_no_manager_insert','INSERT',null,'(nexo_active_role() = ANY (ARRAY[''admin''::text, ''operator''::text]))',false),
 ('public.product_variants','nexo_no_manager_update','UPDATE','(nexo_active_role() = ANY (ARRAY[''admin''::text, ''operator''::text]))','(nexo_active_role() = ANY (ARRAY[''admin''::text, ''operator''::text]))',false),
 ('public.product_variants','product_variants_select','SELECT','true',null,true),
 ('public.product_variants','staging_admin_delete','DELETE','is_admin()',null,true),
 ('public.product_variants','staging_admin_insert','INSERT',null,'is_admin()',true),
 ('public.product_variants','staging_admin_update','UPDATE','is_admin()','is_admin()',true),
 ('public.products','nexo_manager_read_products','SELECT','(nexo_active_role() = ''manager''::text)',null,true),
 ('public.products','nexo_no_manager_delete','DELETE','(nexo_active_role() = ANY (ARRAY[''admin''::text, ''operator''::text]))',null,false),
 ('public.products','nexo_no_manager_insert','INSERT',null,'(nexo_active_role() = ANY (ARRAY[''admin''::text, ''operator''::text]))',false),
 ('public.products','nexo_no_manager_update','UPDATE','(nexo_active_role() = ANY (ARRAY[''admin''::text, ''operator''::text]))','(nexo_active_role() = ANY (ARRAY[''admin''::text, ''operator''::text]))',false),
 ('public.products','products_select','SELECT','is_active_user()',null,true),
 ('public.products','staging_admin_delete','DELETE','is_admin()',null,true),
 ('public.products','staging_admin_insert','INSERT',null,'is_admin()',true),
 ('public.products','staging_admin_update','UPDATE','is_admin()','is_admin()',true)
), expected_indexes(name,table_name,is_unique,columns,predicate) as (values
 ('pos_price_product_unique','public.pos_customer_prices',true,'customer_id,product_id','product_id is not null'),
 ('pos_price_variant_unique','public.pos_customer_prices',true,'customer_id,variant_id','variant_id is not null'),
 ('pos_one_open_register','public.pos_register_sessions',true,'register_id','status = ''open'''),
 ('pos_one_open_cashier','public.pos_register_sessions',true,'cashier_id','status = ''open'''),
 ('pos_sales_customer','public.pos_sales',false,'customer_id,created_at',null),
 ('pos_sales_session','public.pos_sales',false,'session_id',null),
 ('pos_payments_drawer','public.pos_payments',false,'session_id,method_code',null),
 ('pos_payments_sale','public.pos_payments',false,'sale_id',null),
 ('pos_one_sale_charge','public.pos_customer_transactions',true,'sale_id','kind = ''sale_charge'''),
 ('pos_customer_ledger','public.pos_customer_transactions',false,'customer_id,created_at',null),
 ('pos_prices_product_fk','public.pos_customer_prices',false,'product_id','product_id is not null'),
 ('pos_prices_variant_fk','public.pos_customer_prices',false,'variant_id','variant_id is not null'),
 ('pos_prices_customer_fk','public.pos_customer_prices',false,'customer_id',null),
 ('pos_sessions_register_fk','public.pos_register_sessions',false,'register_id',null),
 ('pos_sessions_cashier_history','public.pos_register_sessions',false,'cashier_id,opened_at',null),
 ('pos_sales_cashier_history','public.pos_sales',false,'cashier_id,created_at',null),
 ('pos_items_product_fk','public.pos_sale_items',false,'product_id','product_id is not null'),
 ('pos_items_variant_fk','public.pos_sale_items',false,'variant_id','variant_id is not null'),
 ('pos_payments_actor_history','public.pos_payments',false,'received_by,created_at',null),
 ('pos_payments_method_fk','public.pos_payments',false,'method_code',null),
 ('pos_ledger_sale','public.pos_customer_transactions',false,'sale_id,created_at',null)
), expected_fks(table_name,column_name,target_table,target_column,delete_action) as (values
 ('public.pos_customer_prices','customer_id','public.pos_business_customers','id','r'),
 ('public.pos_customer_prices','product_id','public.products','id','c'),
 ('public.pos_customer_prices','variant_id','public.product_variants','id','c'),
 ('public.pos_register_sessions','register_id','public.pos_registers','id','r'),
 ('public.pos_register_sessions','cashier_id','public.pos_profiles','id','r'),
 ('public.pos_sales','cashier_id','public.pos_profiles','id','r'),
 ('public.pos_sales','session_id','public.pos_register_sessions','id','r'),
 ('public.pos_sales','customer_id','public.pos_business_customers','id','r'),
 ('public.pos_sale_items','sale_id','public.pos_sales','id','r'),
 ('public.pos_sale_items','product_id','public.products','id','n'),
 ('public.pos_sale_items','variant_id','public.product_variants','id','n'),
 ('public.pos_payments','sale_id','public.pos_sales','id','r'),
 ('public.pos_payments','session_id','public.pos_register_sessions','id','r'),
 ('public.pos_payments','received_by','public.pos_profiles','id','r'),
 ('public.pos_payments','method_code','public.pos_payment_methods','code','r'),
 ('public.pos_customer_transactions','customer_id','public.pos_business_customers','id','r'),
 ('public.pos_customer_transactions','sale_id','public.pos_sales','id','r'),
 ('public.pos_customer_transactions','payment_id','public.pos_payments','id','r')
), expected_unique(table_name,columns,kind) as (values
 ('public.pos_business_customers','id','p'),
 ('public.pos_registers','id','p'),
 ('public.pos_payment_methods','code','p'),
 ('public.pos_customer_prices','id','p'),
 ('public.pos_register_sessions','id','p'),
 ('public.pos_sales','id','p'),
 ('public.pos_sale_items','id','p'),
 ('public.pos_payments','id','p'),
 ('public.pos_customer_transactions','id','p'),
 ('public.pos_business_customers','tax_code','u'),
 ('public.pos_registers','name','u'),
 ('public.pos_sales','sale_number','u'),
 ('public.pos_sales','request_id','u'),
 ('public.pos_sale_items','sale_id,line_number','u'),
 ('public.pos_payments','request_id','u'),
 ('public.pos_customer_transactions','payment_id','u')
), expected_catalog_grants(table_name,role_name,privilege,allowed) as (values
 ('public.product_variants','anon','DELETE',false),
 ('public.product_variants','anon','INSERT',false),
 ('public.product_variants','anon','SELECT',false),
 ('public.product_variants','anon','UPDATE',false),
 ('public.product_variants','anon','TRIGGER',false),
 ('public.product_variants','anon','TRUNCATE',false),
 ('public.product_variants','anon','REFERENCES',false),
 ('public.product_variants','authenticated','DELETE',true),
 ('public.product_variants','authenticated','INSERT',true),
 ('public.product_variants','authenticated','SELECT',true),
 ('public.product_variants','authenticated','UPDATE',true),
 ('public.product_variants','authenticated','TRIGGER',false),
 ('public.product_variants','authenticated','TRUNCATE',false),
 ('public.product_variants','authenticated','REFERENCES',false),
 ('public.product_variants','service_role','DELETE',true),
 ('public.product_variants','service_role','INSERT',true),
 ('public.product_variants','service_role','SELECT',true),
 ('public.product_variants','service_role','UPDATE',true),
 ('public.product_variants','service_role','TRIGGER',true),
 ('public.product_variants','service_role','TRUNCATE',true),
 ('public.product_variants','service_role','REFERENCES',true),
 ('public.products','anon','DELETE',false),
 ('public.products','anon','INSERT',false),
 ('public.products','anon','SELECT',false),
 ('public.products','anon','UPDATE',false),
 ('public.products','anon','TRIGGER',false),
 ('public.products','anon','TRUNCATE',false),
 ('public.products','anon','REFERENCES',false),
 ('public.products','authenticated','DELETE',true),
 ('public.products','authenticated','INSERT',true),
 ('public.products','authenticated','SELECT',true),
 ('public.products','authenticated','UPDATE',true),
 ('public.products','authenticated','TRIGGER',false),
 ('public.products','authenticated','TRUNCATE',false),
 ('public.products','authenticated','REFERENCES',false),
 ('public.products','service_role','DELETE',true),
 ('public.products','service_role','INSERT',true),
 ('public.products','service_role','SELECT',true),
 ('public.products','service_role','UPDATE',true),
 ('public.products','service_role','TRIGGER',true),
 ('public.products','service_role','TRUNCATE',true),
 ('public.products','service_role','REFERENCES',true)
), expected_triggers(table_name,name,function_name,type_bits) as (values
 ('public.pos_business_customers','pos_business_customers_updated_at','public.pos_profiles_set_updated_at()','19'),
 ('public.pos_customer_prices','pos_customer_prices_updated_at','public.pos_profiles_set_updated_at()','19'),
 ('public.pos_registers','pos_registers_updated_at','public.pos_profiles_set_updated_at()','19'),
 ('public.pos_payment_methods','pos_payment_methods_updated_at','public.pos_profiles_set_updated_at()','19'),
 ('public.pos_profiles','pos_profiles_updated_at','public.pos_profiles_set_updated_at()','19'),
 ('auth.users','on_auth_user_created','public.handle_new_user()','5')
), expected_seeds(code,name) as (values
 ('cash','ნაღდი'),('tbc','TBC'),('bog','საქართველოს ბანკი'),
 ('liberty','Liberty'),('onway','OnWay'),('other','სხვა')
), roles as (
 select v.name,r.* from (values ('anon'),('authenticated'),('service_role')) v(name)
 left join pg_catalog.pg_roles r on r.rolname=v.name
), tables as (
 select e.name,c.* from expected_tables e left join pg_catalog.pg_class c on c.oid=to_regclass(e.name)
), privilege_tables as (
 select * from tables
 union all
 select 'public.pos_profiles',c.* from pg_catalog.pg_class c where c.oid=to_regclass('public.pos_profiles')
), functions as (
 select e.*,p.oid,p.proowner,p.prosecdef,p.proconfig,p.proacl,p.prosrc,
 md5(regexp_replace(regexp_replace(regexp_replace(replace(p.prosrc,E'\r\n',E'\n'),'--[^\n]*','','g'),'[[:space:]]','','g'),';$','')) actual_md5
 from expected_functions e left join pg_catalog.pg_proc p on p.oid=to_regprocedure(e.signature)
), actual_policies as (
 select n.nspname||'.'||c.relname table_name,p.polname::text name,
 case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end command,
 p.polpermissive permissive,
 array(select case when role_oid=0 then 'PUBLIC' else pg_get_userbyid(role_oid)::text end from unnest(p.polroles) role_oid order by 1) roles,
 pg_get_expr(p.polqual,p.polrelid) using_expr,pg_get_expr(p.polwithcheck,p.polrelid) check_expr
 from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
 where p.polrelid in (select oid from tables) or p.polrelid in (to_regclass('public.products'),to_regclass('public.product_variants'),to_regclass('public.pos_profiles'))
), policy_pairs as (
 select coalesce(e.table_name,a.table_name) table_name,coalesce(e.name,a.name) name,e.command expected_command,a.command actual_command,
 e.permissive expected_permissive,a.permissive actual_permissive,a.roles,
 e.using_expr expected_using,a.using_expr actual_using,e.check_expr expected_check,a.check_expr actual_check
 from expected_policies e full join actual_policies a on a.table_name=e.table_name and a.name=e.name
), policy_checks as (
 select p.*,
 -- pg_get_expr adds casts, parentheses and a subquery output alias. Normalize ONLY these presentation differences.
 regexp_replace(lower(coalesce(expected_using,'<NULL>')),'::text|public[.]|pos_customer_prices[.]|pos_sale_items[.]|as uid|[[:space:]()]','','g') eu,
 regexp_replace(lower(coalesce(actual_using,'<NULL>')),'::text|public[.]|pos_customer_prices[.]|pos_sale_items[.]|as uid|[[:space:]()]','','g') au,
 regexp_replace(lower(coalesce(expected_check,'<NULL>')),'::text|public[.]|pos_customer_prices[.]|pos_sale_items[.]|as uid|[[:space:]()]','','g') ec,
 regexp_replace(lower(coalesce(actual_check,'<NULL>')),'::text|public[.]|pos_customer_prices[.]|pos_sale_items[.]|as uid|[[:space:]()]','','g') ac
 from policy_pairs p
), constraints as (
 select c.*,c.conrelid::regclass::text table_name,
 (select string_agg(a.attname,',' order by k.ord) from unnest(c.conkey) with ordinality k(num,ord) join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num) columns,
 (select string_agg(a.attname,',' order by k.ord) from unnest(c.confkey) with ordinality k(num,ord) join pg_catalog.pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num) target_columns
 from pg_catalog.pg_constraint c where c.conrelid in (select oid from tables)
), identity_sequence as (
 select t.oid table_oid,a.attidentity,a.atttypid,s.oid,s.relkind,s.relowner,s.relacl,n.nspname||'.'||s.relname sequence_name
 from (select to_regclass('public.pos_sales') oid) t
 left join pg_catalog.pg_attribute a on a.attrelid=t.oid and a.attname='sale_number' and not a.attisdropped
 left join pg_catalog.pg_depend d on d.refclassid='pg_catalog.pg_class'::regclass and d.refobjid=t.oid and d.refobjsubid=a.attnum
 and d.classid='pg_catalog.pg_class'::regclass and d.deptype='i'
 left join pg_catalog.pg_class s on s.oid=d.objid and s.relkind='S'
 left join pg_catalog.pg_namespace n on n.oid=s.relnamespace
), checks(section,object_name,ok,details) as (
 select 'tables',t.name,t.oid is not null and t.relkind='r' and t.relrowsecurity and t.relforcerowsecurity,
 jsonb_build_object('exists',t.oid is not null,'rls',t.relrowsecurity,'force_rls',t.relforcerowsecurity,'owner',pg_get_userbyid(t.relowner)) from tables t
 union all
 select 'roles',r.name,r.oid is not null and case when r.name='service_role' then r.rolbypassrls or r.rolsuper else not r.rolbypassrls and not r.rolsuper and not r.rolcreaterole end,
 jsonb_build_object('exists',r.oid is not null,'bypassrls',r.rolbypassrls,'superuser',r.rolsuper,'can_create_roles',r.rolcreaterole) from roles r
 union all
 select 'policies',p.table_name||'.'||p.name,
 p.expected_command=p.actual_command and p.expected_permissive=p.actual_permissive and p.roles=array['authenticated']::text[] and p.eu=p.au and p.ec=p.ac,
 jsonb_build_object('expected_command',p.expected_command,'actual_command',p.actual_command,'expected_permissive',p.expected_permissive,'actual_permissive',p.actual_permissive,'roles',p.roles,'expected_using',p.expected_using,'actual_using',p.actual_using,'expected_check',p.expected_check,'actual_check',p.actual_check) from policy_checks p
 union all
 select 'functions',f.signature,f.oid is not null and f.prosecdef=f.definer and f.actual_md5=f.body_md5
 and o.rolname='postgres' and coalesce(f.proconfig @> array['search_path=""'],false) and (not f.definer or coalesce(o.rolbypassrls or o.rolsuper,false)),
 jsonb_build_object('scope',f.scope,'exists',f.oid is not null,'owner',o.rolname,'expected_owner','postgres','owner_bypassrls',o.rolbypassrls,'owner_superuser',o.rolsuper,'security_definer',f.prosecdef,'expected_definer',f.definer,'proconfig',f.proconfig,'actual_body_md5',f.actual_md5,'expected_body_md5',f.body_md5,'acl',f.proacl) from functions f left join pg_catalog.pg_roles o on o.oid=f.proowner
 union all
 select 'function_execute',f.signature||' / '||r.name,f.oid is not null and r.oid is not null and has_function_privilege(r.oid,f.oid,'EXECUTE')=case r.name when 'authenticated' then f.auth_execute when 'service_role' then f.service_execute else false end,
 jsonb_build_object('execute',has_function_privilege(r.oid,f.oid,'EXECUTE'),'expected',case r.name when 'authenticated' then f.auth_execute when 'service_role' then f.service_execute else false end) from functions f cross join roles r
 union all
 select 'function_public_execute',f.signature,f.oid is not null and not exists(select 1 from aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'),jsonb_build_object('expected_public_execute',false) from functions f
 union all
 select 'unexpected_functions','POS/provisioning overloads',count(*)=0,jsonb_build_object('unexpected_signatures',coalesce(jsonb_agg(p.oid::regprocedure::text),'[]'))
 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and (p.proname like 'pos_%' or p.proname in ('handle_new_user','nexo_finalize_user_memberships','nexo_provisioning_version')) and not exists(select 1 from functions f where f.oid=p.oid)
 union all
 select 'triggers',e.table_name||'.'||e.name,t.oid is not null and t.tgfoid=to_regprocedure(e.function_name) and t.tgtype=e.type_bits::integer and t.tgenabled in ('O','A') and t.tgqual is null and t.tgnargs=0,
 jsonb_build_object('definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled,'expected_function',e.function_name) from expected_triggers e left join pg_catalog.pg_trigger t on t.tgrelid=to_regclass(e.table_name) and t.tgname=e.name and not t.tgisinternal
 union all
 select 'unexpected_triggers','POS/auth triggers',count(*)=0,jsonb_build_object('unexpected',coalesce(jsonb_agg(pg_get_triggerdef(t.oid,true)),'[]')) from pg_catalog.pg_trigger t
 where not t.tgisinternal and (t.tgrelid in (select oid from tables) or t.tgrelid in (to_regclass('public.pos_profiles'),to_regclass('auth.users')))
 and not exists(select 1 from expected_triggers e where t.tgrelid=to_regclass(e.table_name) and t.tgname=e.name)
 union all
 select 'foreign_keys',e.table_name||'.'||e.column_name,c.oid is not null and c.confrelid=to_regclass(e.target_table) and c.target_columns=e.target_column and c.confdeltype::text=e.delete_action and c.confupdtype='a' and c.convalidated and not c.condeferrable,
 jsonb_build_object('definition',pg_get_constraintdef(c.oid,true),'expected_target',e.target_table||'.'||e.target_column,'expected_delete_code',e.delete_action,'validated',c.convalidated) from expected_fks e left join constraints c on c.conrelid=to_regclass(e.table_name) and c.contype='f' and c.columns=e.column_name
 union all
 select 'uniqueness',e.table_name||' / '||e.columns,c.oid is not null and c.contype::text=e.kind and c.convalidated and not c.condeferrable and i.indisvalid and i.indisready,
 jsonb_build_object('expected_type',e.kind,'definition',pg_get_constraintdef(c.oid,true),'index_valid',i.indisvalid) from expected_unique e left join constraints c on c.conrelid=to_regclass(e.table_name) and c.columns=e.columns and c.contype in ('p','u') left join pg_catalog.pg_index i on i.indexrelid=c.conindid
 union all
 select 'indexes',e.name,i.indexrelid is not null and i.indrelid=to_regclass(e.table_name) and i.indisunique=e.is_unique and i.indisvalid and i.indisready
 and (select string_agg(a.attname,',' order by k.ord) from unnest(i.indkey) with ordinality k(num,ord) join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.num)=e.columns
 and regexp_replace(lower(coalesce(pg_get_expr(i.indpred,i.indrelid),'<NULL>')),'::text|[[:space:]()]','','g')=regexp_replace(lower(coalesce(e.predicate,'<NULL>')),'::text|[[:space:]()]','','g'),
 jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),'expected_table',e.table_name,'expected_columns',e.columns,'expected_unique',e.is_unique,'expected_predicate',e.predicate) from expected_indexes e left join pg_catalog.pg_index i on i.indexrelid=to_regclass('public.'||e.name)
 union all
 select 'payment_seeds',e.code,p.code is not null and p.name=e.name and p.active,
 jsonb_build_object('expected_name',e.name,'actual_name',p.name,'active',p.active) from expected_seeds e left join public.pos_payment_methods p on p.code=e.code
 union all
 select 'identity_sequence','public.pos_sales.sale_number',s.oid is not null and s.attidentity='a' and s.atttypid='bigint'::regtype,
 jsonb_build_object('sequence',s.sequence_name,'identity',s.attidentity,'owner',pg_get_userbyid(s.relowner),'acl',s.relacl) from identity_sequence s
 union all
 select 'sequence_public_privileges',coalesce(s.sequence_name,'MISSING'),s.oid is not null and not exists(select 1 from aclexplode(coalesce(s.relacl,acldefault('S',s.relowner))) a where a.grantee=0),jsonb_build_object('expected_public_privileges','NONE') from identity_sequence s
 union all
 select 'sequence_role_privileges',coalesce(s.sequence_name,'MISSING')||' / '||r.name,s.oid is not null and r.oid is not null and
 case when r.name='service_role' then has_sequence_privilege(r.oid,s.oid,'USAGE') else not has_sequence_privilege(r.oid,s.oid,'SELECT,UPDATE,USAGE') end,
 jsonb_build_object('select',has_sequence_privilege(r.oid,s.oid,'SELECT'),'update',has_sequence_privilege(r.oid,s.oid,'UPDATE'),'usage',has_sequence_privilege(r.oid,s.oid,'USAGE')) from identity_sequence s cross join roles r
 union all
 select 'sequence_definer_access',f.signature,s.oid is not null and f.oid is not null and has_sequence_privilege(f.proowner,s.oid,'USAGE'),
 jsonb_build_object('owner',pg_get_userbyid(f.proowner),'sequence',s.sequence_name,'usage',has_sequence_privilege(f.proowner,s.oid,'USAGE')) from identity_sequence s cross join functions f where f.signature like 'public.pos_complete_sale(%'
 union all
 select 'catalog_grants',e.table_name||' / '||e.role_name||' / '||e.privilege,to_regclass(e.table_name) is not null and r.oid is not null and has_table_privilege(r.oid,to_regclass(e.table_name),e.privilege)=e.allowed,
 jsonb_build_object('expected',e.allowed,'actual',has_table_privilege(r.oid,to_regclass(e.table_name),e.privilege)) from expected_catalog_grants e left join pg_catalog.pg_roles r on r.rolname=e.role_name
 union all
 -- Compare effective column rights with the verified table-grant baseline too;
 -- this catches extra column-only grants that table-level inspection would miss.
 select 'catalog_column_privileges',e.table_name||'.'||a.attname||' / '||e.role_name||' / '||e.privilege,
 has_column_privilege(r.oid,a.attrelid,a.attnum,e.privilege)=e.allowed,
 jsonb_build_object('expected',e.allowed,'actual',has_column_privilege(r.oid,a.attrelid,a.attnum,e.privilege))
 from expected_catalog_grants e join pg_catalog.pg_attribute a on a.attrelid=to_regclass(e.table_name) and a.attnum>0 and not a.attisdropped
 left join pg_catalog.pg_roles r on r.rolname=e.role_name where e.privilege in ('SELECT','INSERT','UPDATE','REFERENCES')
 union all
 select 'catalog_rls',v.name,c.oid is not null and c.relrowsecurity and not c.relforcerowsecurity,
 jsonb_build_object('rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'expected_rls',true,'expected_force_rls',false) from (values ('public.products'),('public.product_variants')) v(name) left join pg_catalog.pg_class c on c.oid=to_regclass(v.name)
 union all
 select 'direct_table_privileges',t.name||' / '||r.name||' / '||v.privilege,t.oid is not null and r.oid is not null and has_table_privilege(r.oid,t.oid,v.privilege)=
 (r.name='service_role' or (r.name='authenticated' and (v.privilege='SELECT' or (t.name in ('public.pos_business_customers','public.pos_registers') and v.privilege in ('INSERT','UPDATE'))))),
 jsonb_build_object('actual',has_table_privilege(r.oid,t.oid,v.privilege)) from privilege_tables t cross join roles r cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(privilege)
 union all
 select 'column_write_privileges',t.name||'.'||a.attname||' / '||r.name||' / '||v.privilege,
 has_column_privilege(r.oid,t.oid,a.attnum,v.privilege)= (r.name='authenticated' and (t.name in ('public.pos_business_customers','public.pos_registers') and v.privilege in ('INSERT','UPDATE') or t.name='public.pos_payment_methods' and a.attname in ('name','active') and v.privilege='UPDATE')),
 jsonb_build_object('actual',has_column_privilege(r.oid,t.oid,a.attnum,v.privilege)) from privilege_tables t join pg_catalog.pg_attribute a on a.attrelid=t.oid and a.attnum>0 and not a.attisdropped cross join roles r cross join (values ('INSERT'),('UPDATE'),('REFERENCES')) v(privilege) where r.name in ('anon','authenticated')
 union all
 select 'public_table_acl',t.name,t.oid is not null and not exists(select 1 from aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) a where a.grantee=0),jsonb_build_object('acl',t.relacl) from privilege_tables t
 union all
 select 'auth_metadata_isolation',r.name,r.oid is not null and not has_table_privilege(r.oid,to_regclass('auth.users'),'INSERT')
 and not has_column_privilege(r.oid,to_regclass('auth.users'),'raw_app_meta_data','INSERT') and not has_column_privilege(r.oid,to_regclass('auth.users'),'raw_app_meta_data','UPDATE'),jsonb_build_object('expected','No browser provisioning authority') from roles r where r.name in ('anon','authenticated')
 union all
 select 'schema_access',r.name,has_schema_privilege(r.oid,'public','USAGE') and (r.name='service_role' or not has_schema_privilege(r.oid,'public','CREATE')),
 jsonb_build_object('usage',has_schema_privilege(r.oid,'public','USAGE'),'create',has_schema_privilege(r.oid,'public','CREATE')) from roles r
), evidence(section,object_name,status,details) as (
 select section,object_name,case when ok is true then 'PASS' else 'FAIL' end,details from checks
 union all
 select 'constraints',table_name||'.'||conname,'INFO',jsonb_build_object('type',contype,'validated',convalidated,'definition',pg_get_constraintdef(oid,true)) from constraints
 union all
 select 'context','connection','INFO',jsonb_build_object('database',current_database(),'current_user',current_user,'session_user',session_user,'server_version',current_setting('server_version'),'instruction','Confirm nexo-staging in Dashboard; this query cannot authenticate the project name.')
 union all
 select 'limitations','scope','INFO',jsonb_build_object('note','Metadata-only verification. No RPC, nextval, setval, provisioning, sale or concurrency test is executed. service_role bypass remains intentional; financial RPCs still require an active POS auth.uid(). Policy normalization differences or modified configurable seed names require review. Fingerprints are drift evidence, not a security proof. External services, exposed API schemas and service-key handling are outside this SQL.')
)
select section,object_name,status,details::text as details from evidence
union all
select 'SUMMARY',section,case when count(*) filter(where status='FAIL')>0 then 'FAIL' when count(*) filter(where status='PASS')=0 then 'INFO' else 'PASS' end,
 jsonb_build_object('rows',count(*),'passed',count(*) filter(where status='PASS'),'failed',count(*) filter(where status='FAIL'),'info',count(*) filter(where status='INFO'))::text
from evidence group by section
order by section,object_name,status;
