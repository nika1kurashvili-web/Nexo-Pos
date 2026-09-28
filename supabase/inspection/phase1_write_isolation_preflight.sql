-- READ ONLY: one statement, one result set. Export ALL rows; disable editor row limits.
-- No application functions executed or business/secret tables read.
-- Redaction is best effort; review definitions for encoded/unusual secrets before sharing.
with recursive
wanted(name) as (values ('public.products'),('public.product_variants'),('auth.users'),('public.profiles'),('public.pos_profiles')),
targets as (select w.name,c.* from wanted w join pg_catalog.pg_class c on c.oid=to_regclass(w.name)),
api_names(name) as (values ('anon'),('authenticated'),('service_role')),
api as (select r.* from pg_catalog.pg_roles r join api_names a on a.name=r.rolname),
-- Broad inventory covers wrappers and dynamic SQL not tracked by pg_depend.
routine_ids(oid) as (
 select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and p.prokind in ('f','p')
 union
 select d.refobjid from routine_ids r join pg_catalog.pg_depend d on d.objid=r.oid
 and d.classid='pg_catalog.pg_proc'::regclass and d.refclassid='pg_catalog.pg_proc'::regclass
),
routines as (select p.*,n.nspname from routine_ids i join pg_catalog.pg_proc p on p.oid=i.oid
 join pg_catalog.pg_namespace n on n.oid=p.pronamespace where p.prokind in ('f','p')),
relations as (select c.*,n.nspname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
 where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','f')),
evidence(section,object_name,object_type,detail_1,detail_2,definition) as (
 select 'context',current_user::text,'execution_context',jsonb_build_object('session_user',session_user,
 'version',current_setting('server_version'),'api_schemas_setting',current_setting('pgrst.db_schemas',true))::text,
 'Confirm API exposed schemas in Dashboard; NULL setting does not mean none.',null::text
 union all
 select 'required_objects',w.name,'relation',jsonb_build_object('present',t.oid is not null)::text,null,null
 from wanted w left join targets t on t.name=w.name
 union all
 select 'required_objects',a.name,'role',jsonb_build_object('present',r.oid is not null)::text,null,null
 from api_names a left join api r on r.rolname=a.name
 union all
 -- Exact stored defaults, nullability, domain defaults and constraints: do not
 -- infer the Orders role/active defaults from POS migrations or UI fallbacks.
 select 'profile_columns',format('%s.%I',t.name,a.attname),'column',
 jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
 'identity',a.attidentity,'generated',a.attgenerated,'domain_not_null',ty.typnotnull,
 'domain_default',ty.typdefault)::text,
 jsonb_build_object('column_default',pg_get_expr(d.adbin,d.adrelid),
 'enum_values',(select jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_catalog.pg_enum e
 where e.enumtypid=case when ty.typtype='d' then ty.typbasetype else ty.oid end))::text,
 pg_get_expr(d.adbin,d.adrelid)
 from targets t join pg_catalog.pg_attribute a on a.attrelid=t.oid and a.attnum>0 and not a.attisdropped
 join pg_catalog.pg_type ty on ty.oid=a.atttypid
 left join pg_catalog.pg_attrdef d on d.adrelid=t.oid and d.adnum=a.attnum
 where t.name in ('public.profiles','public.pos_profiles')
 union all
 select 'profile_constraints',format('%s.%I',t.name,c.conname),'constraint',
 jsonb_build_object('type',c.contype,'validated',c.convalidated,'deferrable',c.condeferrable,
 'initially_deferred',c.condeferred,'relation',c.conrelid::regclass::text,
 'referenced_relation',case when c.confrelid=0 then null else c.confrelid::regclass::text end)::text,
 'Includes incoming foreign keys and domain constraints.',pg_get_constraintdef(c.oid,true)
 from targets t join pg_catalog.pg_constraint c on c.conrelid=t.oid or c.confrelid=t.oid
 or c.contypid in (select a.atttypid from pg_catalog.pg_attribute a where a.attrelid=t.oid and a.attnum>0 and not a.attisdropped)
 where t.name in ('public.profiles','public.pos_profiles')
 union all
 select 'catalog_rls',t.name,'table',jsonb_build_object('relrowsecurity',t.relrowsecurity,
 'relforcerowsecurity',t.relforcerowsecurity,'owner',pg_get_userbyid(t.relowner),'acl',t.relacl)::text,null,null
 from targets t where t.name in ('public.products','public.product_variants')
 union all
 select 'catalog_table_grants',t.name,'effective_privileges',r.rolname::text,
 jsonb_build_object('SELECT',has_table_privilege(r.oid,t.oid,'SELECT'),'INSERT',has_table_privilege(r.oid,t.oid,'INSERT'),
 'UPDATE',has_table_privilege(r.oid,t.oid,'UPDATE'),'DELETE',has_table_privilege(r.oid,t.oid,'DELETE'),
 'TRUNCATE',has_table_privilege(r.oid,t.oid,'TRUNCATE'),'REFERENCES',has_table_privilege(r.oid,t.oid,'REFERENCES'),
 'TRIGGER',has_table_privilege(r.oid,t.oid,'TRIGGER'))::text,null
 from targets t cross join api r where t.name in ('public.products','public.product_variants')
 union all
 select 'column_grants',format('%I.%I.%I',c.nspname,c.relname,a.attname),'effective_column_privileges',r.rolname::text,
 jsonb_build_object('SELECT',has_column_privilege(r.oid,c.oid,a.attnum,'SELECT'),
 'INSERT',has_column_privilege(r.oid,c.oid,a.attnum,'INSERT'),'UPDATE',has_column_privilege(r.oid,c.oid,a.attnum,'UPDATE'),
 'REFERENCES',has_column_privilege(r.oid,c.oid,a.attnum,'REFERENCES'),'acl',a.attacl)::text,null
 from relations c join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped cross join api r
 union all
 select 'policies',format('%I.%I.%I',p.schemaname,p.tablename,p.policyname),'rls_policy',
 jsonb_build_object('command',p.cmd,'roles',p.roles,'mode',p.permissive)::text,
 jsonb_build_object('using',p.qual,'with_check',p.with_check)::text,
 format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s;',p.policyname,p.schemaname,p.tablename,p.permissive,p.cmd,
 (select string_agg(quote_ident(x),', ') from unnest(p.roles) x),
 case when p.qual is null then '' else ' USING ('||p.qual||')' end,
 case when p.with_check is null then '' else ' WITH CHECK ('||p.with_check||')' end)
 from pg_catalog.pg_policies p where p.schemaname !~ '^pg_' and p.schemaname <> 'information_schema'
 union all
 select 'target_policy_counts',w.name,'policy_check',count(p.oid)::text,null,null
 from wanted w left join targets t on t.name=w.name left join pg_catalog.pg_policy p on p.polrelid=t.oid group by w.name
 union all
 select 'routine_definitions',p.oid::regprocedure::text,'routine',
 jsonb_build_object('kind',p.prokind,'schema',p.nspname,'security',case when p.prosecdef then 'DEFINER' else 'INVOKER' end,
 'owner',r.rolname,'owner_superuser',r.rolsuper,'owner_bypassrls',r.rolbypassrls,'language',l.lanname,
 'proconfig',p.proconfig,'acl',p.proacl)::text,'Broad inventory includes helper dependencies, wrappers and dynamic SQL.',pg_get_functiondef(p.oid)
 from routines p join pg_catalog.pg_roles r on r.oid=p.proowner join pg_catalog.pg_language l on l.oid=p.prolang
 union all
 select 'routine_execute',p.oid::regprocedure::text,'effective_execute',a.rolname::text,
 jsonb_build_object('execute',has_function_privilege(a.oid,p.oid,'EXECUTE'),
 'schema_usage',has_schema_privilege(a.oid,p.pronamespace,'USAGE'))::text,null from routines p cross join api a
 union all
 select 'named_helpers',n.name,'helper_presence',count(p.oid)::text,'Full definitions in routine_definitions; zero means missing.',null
 from (values ('is_active_user'),('is_admin'),('nexo_active_role'),('handle_new_user'),('set_updated_at')) n(name)
 left join routines p on p.proname=n.name group by n.name
 union all
 select 'dependencies',pg_describe_object(d.classid,d.objid,d.objsubid),'recorded_dependency',d.deptype::text,
 pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid),null from pg_catalog.pg_depend d
 where (d.classid='pg_catalog.pg_proc'::regclass and d.objid in (select oid from routines))
 or (d.classid='pg_catalog.pg_policy'::regclass and d.objid in (select oid from pg_catalog.pg_policy where polrelid in (select oid from targets)))
 union all
 select 'triggers',format('%I.%I.%I',c.nspname,c.relname,t.tgname),'trigger',
 jsonb_build_object('enabled',t.tgenabled,'internal',t.tgisinternal,'function',t.tgfoid::regprocedure::text)::text,
 'Includes indirect trigger paths on other non-system relations.',pg_get_triggerdef(t.oid,true)
 from pg_catalog.pg_trigger t join relations c on c.oid=t.tgrelid
 union all
 select 'target_trigger_counts',w.name,'trigger_check',count(g.oid)::text,null,null
 from wanted w left join targets t on t.name=w.name left join pg_catalog.pg_trigger g on g.tgrelid=t.oid group by w.name
 union all
 select 'views',format('%I.%I',c.nspname,c.relname),'view',jsonb_build_object('owner',pg_get_userbyid(c.relowner),
 'options',c.reloptions,'acl',c.relacl,'updatable_mask',pg_relation_is_updatable(c.oid,true))::text,null,pg_get_viewdef(c.oid,true)
 from relations c where c.relkind in ('v','m')
 union all
 select 'rules',format('%I.%I.%I',r.schemaname,r.tablename,r.rulename),'rule',null,null,r.definition
 from pg_catalog.pg_rules r where r.schemaname !~ '^pg_' and r.schemaname <> 'information_schema'
 union all
 select 'indirect_relation_grants',format('%I.%I',c.nspname,c.relname),'relation',a.rolname::text,
 jsonb_build_object('kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
 'acl',c.relacl,'SELECT',has_table_privilege(a.oid,c.oid,'SELECT'),'INSERT',has_table_privilege(a.oid,c.oid,'INSERT'),
 'UPDATE',has_table_privilege(a.oid,c.oid,'UPDATE'),'DELETE',has_table_privilege(a.oid,c.oid,'DELETE'))::text,null
 from relations c cross join api a
 union all
 select 'roles',r.rolname::text,'role',jsonb_build_object('superuser',r.rolsuper,'bypassrls',r.rolbypassrls,
 'inherit',r.rolinherit,'canlogin',r.rolcanlogin,'createrole',r.rolcreaterole,'createdb',r.rolcreatedb)::text,null,null from pg_catalog.pg_roles r
 union all
 select 'role_memberships',pg_get_userbyid(m.member),'membership',
 jsonb_build_object('granted_role',pg_get_userbyid(m.roleid),'grantor',pg_get_userbyid(m.grantor),'admin_option',m.admin_option)::text,
 -- PostgreSQL version-specific membership options, when available.
 (to_jsonb(m)-'member'-'roleid'-'grantor'-'admin_option')::text,null from pg_catalog.pg_auth_members m
 union all
 select 'effective_role_memberships',a.rolname::text,'effective_membership',r.rolname::text,
 jsonb_build_object('member',pg_has_role(a.oid,r.oid,'MEMBER'),'inherits_now',pg_has_role(a.oid,r.oid,'USAGE'))::text,null
 from api a cross join pg_catalog.pg_roles r where a.oid=r.oid or pg_has_role(a.oid,r.oid,'MEMBER')
 union all
 select 'schema_grants',n.nspname::text,'schema',a.rolname::text,
 jsonb_build_object('owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl,'usage',has_schema_privilege(a.oid,n.oid,'USAGE'),
 'create',has_schema_privilege(a.oid,n.oid,'CREATE'))::text,null from pg_catalog.pg_namespace n cross join api a
 where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
 union all
 select 'default_acl',pg_get_userbyid(d.defaclrole),'default_privileges',
 jsonb_build_object('schema',n.nspname,'object_kind',d.defaclobjtype,'acl',d.defaclacl)::text,null,null
 from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace
 union all
 select 'limitations','scope','inspection_limits','Metadata cannot prove arbitrary dynamic SQL, external code, Edge Functions or service-key use.',
 'Confirm Dashboard API schemas. Export ALL rows. Dependency tracking is incomplete for PLpgSQL/dynamic SQL.',
 'Definitions are heuristically redacted. Encoded/unusual credentials require manual review. No business data or secret stores are read.'
),
sections(section) as (values ('context'),('required_objects'),('profile_columns'),('profile_constraints'),('catalog_rls'),('catalog_table_grants'),('column_grants'),
 ('policies'),('target_policy_counts'),('routine_definitions'),('routine_execute'),('named_helpers'),('dependencies'),
 ('triggers'),('target_trigger_counts'),('views'),('rules'),('indirect_relation_grants'),('roles'),('role_memberships'),
 ('effective_role_memberships'),('schema_grants'),('default_acl'),('limitations')),
all_rows as (
 select * from evidence
 union all
 select s.section,'[SUMMARY]','section_count',count(e.section)::text,
 case when count(e.section)=0 then 'NONE FOUND' else 'Rows included; compare exported rows with this count.' end,null
 from sections s left join evidence e on e.section=s.section group by s.section
),
numbered as (select row_number() over () as row_id,a.* from all_rows a),
redacted as (
 select a.row_id,a.section,a.object_name,a.object_type,x.field,
 regexp_replace(regexp_replace(regexp_replace(regexp_replace(x.value,
 $rx$((?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|service[_-]?role[_-]?key|authorization)["']?\s*(?::=|=>|=|:)\s*["']+)[^"']*(["']+)$rx$,
 '\1[REDACTED]\2','gi'),
 $rx$(Bearer\s+)[A-Za-z0-9._~+/-]+=*$rx$,'\1[REDACTED]','gi'),
 $rx$eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$rx$,'[REDACTED_JWT]','g'),
 $rx$([a-z][a-z0-9+.-]*://[^\s/:"']+:)[^\s/@"']+(@)$rx$,'\1[REDACTED]\2','gi') as value
 from numbered a cross join lateral (values ('detail_1',a.detail_1),('detail_2',a.detail_2),('definition',a.definition)) x(field,value)
)
select section,object_name,object_type,
 max(value) filter (where field='detail_1') as detail_1,
 max(value) filter (where field='detail_2') as detail_2,
 max(value) filter (where field='definition') as definition
from redacted group by row_id,section,object_name,object_type
order by section,object_name,object_type,detail_1,detail_2;
