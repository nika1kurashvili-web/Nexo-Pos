-- READ ONLY: run only in nexo-staging; one exportable result set.
-- Does not execute the inspected functions or modify/clean up anything.
-- MD5 fingerprints compare normalized bodies with the current repository files;
-- a match is diagnostic evidence, NOT sufficient approval without reviewing ACL/owner.
-- PostgreSQL does not retain a reliable function creation timestamp/SQL Editor history.
with expected(signature,prerequisite_body_md5,bootstrap_body_md5) as (values
 ('public.nexo_finalize_user_memberships(uuid)','c6bb516cd5b89df4d6f01b3c66fd03be',null),
 ('public.nexo_provisioning_version()','1be4d41a0cfc72a1650ff9594daff5a4',null),
 ('public.handle_new_user()','a925506b655ef200db974711319e72d1','5628a9b02b65297f5d3938e38386a7f0')
), routine_rows as (
 select e.signature,p.oid,p.prosrc,p.prosecdef,p.proconfig,p.proacl,p.proowner,
 e.prerequisite_body_md5,e.bootstrap_body_md5,
 md5(replace(p.prosrc,E'\r\n',E'\n')) as actual_body_md5
 from expected e left join pg_catalog.pg_proc p on p.oid=to_regprocedure(e.signature)
), evidence(section,object_name,details) as (
 select 'context','connection',jsonb_build_object('database',current_database(),'current_user',current_user,
 'session_user',session_user,'server_version',current_setting('server_version'))
 union all
 select 'routines',r.signature,jsonb_build_object('exists',r.oid is not null,
 'body_state',case when r.oid is null then 'ABSENT' when r.actual_body_md5=r.prerequisite_body_md5 then 'MATCHES_REPOSITORY_PREREQUISITE'
 when r.actual_body_md5=r.bootstrap_body_md5 then 'MATCHES_REPOSITORY_PRE_FIX_BOOTSTRAP' else 'DIFFERENT_DEFINITION_REQUIRES_REVIEW' end,
 'actual_body_md5',r.actual_body_md5,'expected_prerequisite_md5',r.prerequisite_body_md5,
 'owner',pg_get_userbyid(r.proowner),'owner_superuser',o.rolsuper,'owner_bypassrls',o.rolbypassrls,
 'security_definer',r.prosecdef,'proconfig',r.proconfig,'acl',r.proacl,
 'execute', (select jsonb_object_agg(a.rolname,has_function_privilege(a.oid,r.oid,'EXECUTE'))
 from pg_catalog.pg_roles a where a.rolname in ('anon','authenticated','service_role')))
 from routine_rows r left join pg_catalog.pg_roles o on o.oid=r.proowner
 union all
 select 'overloads',p.oid::regprocedure::text,jsonb_build_object('schema',n.nspname,'owner',pg_get_userbyid(p.proowner),
 'return_type',pg_get_function_result(p.oid),'identity_arguments',pg_get_function_identity_arguments(p.oid))
 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 where p.proname in ('nexo_finalize_user_memberships','nexo_provisioning_version','handle_new_user')
 union all
 select 'auth_triggers',t.tgname,jsonb_build_object('enabled',t.tgenabled,'internal',t.tgisinternal,
 'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid,true))
 from pg_catalog.pg_trigger t where t.tgrelid=to_regclass('auth.users')
 union all
 select 'event_triggers',e.evtname,jsonb_build_object('event',e.evtevent,'enabled',e.evtenabled,
 'tags',e.evttags,'function',e.evtfoid::regprocedure::text)
 from pg_catalog.pg_event_trigger e
 union all
 select 'event_triggers','[COUNT]',jsonb_build_object('count',count(*)) from pg_catalog.pg_event_trigger
 union all
 select 'dependencies',r.signature,jsonb_build_object('direction','depends_on',
 'object',pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid),'type',d.deptype)
 from routine_rows r join pg_catalog.pg_depend d on d.classid='pg_catalog.pg_proc'::regclass and d.objid=r.oid
 union all
 select 'dependencies',r.signature,jsonb_build_object('direction','referenced_by',
 'object',pg_describe_object(d.classid,d.objid,d.objsubid),'type',d.deptype)
 from routine_rows r join pg_catalog.pg_depend d on d.refclassid='pg_catalog.pg_proc'::regclass and d.refobjid=r.oid
 union all
 select 'progress',x.name,jsonb_build_object('exists',to_regclass(x.name) is not null)
 from (values ('public.profiles'),('public.pos_profiles'),('public.pos_sales'),('supabase_migrations.schema_migrations')) x(name)
 union all
 select 'limitations','history',jsonb_build_object('note','This snapshot cannot identify who created a function or prove which SQL text was submitted. Review SQL Editor query history and project reference. Definitions are fingerprinted rather than exported to avoid exposing literals in an unknown function.')
)
select section,object_name,details::text as details from evidence order by section,object_name,details::text;
