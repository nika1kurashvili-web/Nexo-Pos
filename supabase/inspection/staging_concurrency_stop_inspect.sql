-- READ ONLY. Run manually ONLY in nexo-staging (tclplmbnfnktpthcwqbq).
-- One statement / one snapshot / one result set. No RPCs or sequence advancement.
-- Counts and integrity checks cover all staging financial records.
-- SQL cannot reconstruct the script's historical local clock or RPC responses.
with
requests(label, request_id) as (values
  ('race', '6f59b877-1755-4ba6-ad82-ad197139d8ed'::uuid),
  ('timeout', '313896bf-3f09-42c0-9cb9-907192fd1e12'::uuid),
  ('zero_debt', '3d36e9f9-7328-4f27-906f-1f3905fa886d'::uuid)
),
target as (
  select * from public.pos_register_sessions
  where id = 'ed6d7067-8482-4654-8c3b-df124450644c'::uuid
),
issues(kind, object_id) as (
  select 'sale_missing_session', s.id::text from public.pos_sales s
  where not exists (select 1 from public.pos_register_sessions r where r.id=s.session_id)
  union all
  select 'item_missing_sale', i.id::text from public.pos_sale_items i
  where not exists (select 1 from public.pos_sales s where s.id=i.sale_id)
  union all
  select 'payment_missing_sale_or_session', p.id::text from public.pos_payments p
  where not exists (select 1 from public.pos_sales s where s.id=p.sale_id)
     or not exists (select 1 from public.pos_register_sessions r where r.id=p.session_id)
  union all
  select 'ledger_missing_sale_customer_or_payment', l.id::text from public.pos_customer_transactions l
  where not exists (select 1 from public.pos_sales s where s.id=l.sale_id)
     or not exists (select 1 from public.pos_business_customers c where c.id=l.customer_id)
     or (l.payment_id is not null and not exists (select 1 from public.pos_payments p where p.id=l.payment_id))
  union all
  select 'sale_item_total_or_initial_payment_mismatch', s.id::text from public.pos_sales s
  where not exists (select 1 from public.pos_sale_items i where i.sale_id=s.id)
     or s.total <> (select coalesce(sum(i.line_total),0) from public.pos_sale_items i where i.sale_id=s.id)
     or s.paid_total <> (select coalesce(sum(p.amount),0) from public.pos_payments p where p.sale_id=s.id and p.kind='sale_payment')
     or s.debt_amount <> s.total-s.paid_total
     or s.total < (select coalesce(sum(p.amount),0) from public.pos_payments p where p.sale_id=s.id)
  union all
  select 'sale_payment_wrong_session', p.id::text from public.pos_payments p
  join public.pos_sales s on s.id=p.sale_id where p.kind='sale_payment' and p.session_id<>s.session_id
  union all
  select 'wholesale_charge_missing_or_mismatch', s.id::text from public.pos_sales s
  where s.sale_type='wholesale' and (select count(*) from public.pos_customer_transactions l
    where l.sale_id=s.id and l.kind='sale_charge' and l.customer_id=s.customer_id and l.amount=s.total)<>1
  union all
  select 'wholesale_payment_ledger_missing_or_mismatch', p.id::text from public.pos_payments p
  join public.pos_sales s on s.id=p.sale_id where s.sale_type='wholesale' and
    (select count(*) from public.pos_customer_transactions l where l.payment_id=p.id
      and l.sale_id=s.id and l.customer_id=s.customer_id and l.kind=p.kind and l.amount=-p.amount)<>1
  union all
  select 'ledger_inconsistent_link_or_amount', l.id::text from public.pos_customer_transactions l
  join public.pos_sales s on s.id=l.sale_id left join public.pos_payments p on p.id=l.payment_id
  where s.sale_type<>'wholesale' or l.customer_id is distinct from s.customer_id
     or (l.kind='sale_charge' and (l.payment_id is not null or l.amount<>s.total))
     or (l.kind<>'sale_charge' and (p.id is null or p.sale_id<>l.sale_id or l.amount<>-p.amount or l.kind<>p.kind))
  union all
  select 'duplicate_sale_request', request_id::text from public.pos_sales group by request_id having count(*)>1
  union all
  select 'duplicate_sale_number', sale_number::text from public.pos_sales group by sale_number having count(*)>1
  union all
  select 'duplicate_payment_request', request_id::text from public.pos_payments group by request_id having count(*)>1
  union all
  select 'duplicate_item_line', sale_id::text||':'||line_number from public.pos_sale_items group by sale_id,line_number having count(*)>1
  union all
  select 'duplicate_ledger_payment', payment_id::text from public.pos_customer_transactions where payment_id is not null group by payment_id having count(*)>1
  union all
  select 'duplicate_sale_charge', sale_id::text from public.pos_customer_transactions where kind='sale_charge' group by sale_id having count(*)>1
  union all
  select 'multiple_open_sessions_register', register_id::text from public.pos_register_sessions where status='open' group by register_id having count(*)>1
  union all
  select 'multiple_open_sessions_cashier', cashier_id::text from public.pos_register_sessions where status='open' group by cashier_id having count(*)>1
  union all
  select 'closed_drawer_mismatch', r.id::text from public.pos_register_sessions r where r.status='closed' and
    (r.expected_closing_cash is distinct from r.opening_cash+(select coalesce(sum(p.amount),0) from public.pos_payments p where p.session_id=r.id and p.method_code='cash')
     or r.cash_difference is distinct from r.actual_closing_cash-r.expected_closing_cash
     or r.closed_at is null or r.closed_at<r.opened_at)
),
report(section, object_name, details) as (
  select '01_session', 'target', jsonb_build_object(
    'exists', exists(select 1 from target), 'row', (select to_jsonb(t) from target t),
    'database_now', statement_timestamp(),
    'status_is_closed', (select status='closed' from target),
    'note_matches', (select closing_note='STAGING final concurrency close; actual cash 121.00' from target),
    'close_at_or_after_open', (select closed_at>=opened_at from target),
    'close_not_future_database_clock', (select closed_at<=statement_timestamp()+interval '10 seconds' from target),
    'closed_at_epoch_ms', (select extract(epoch from closed_at)*1000 from target),
    'opened_at_epoch_ms', (select extract(epoch from opened_at)*1000 from target),
    'computed_drawer', (select opening_cash+(select coalesce(sum(p.amount),0) from public.pos_payments p where p.session_id=t.id and p.method_code='cash') from target t))
  union all
  select '02_request', r.label, jsonb_build_object('request_id',r.request_id,
    'sales', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from public.pos_sales s where s.request_id=r.request_id),
    'items', (select coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb) from public.pos_sale_items i join public.pos_sales s on s.id=i.sale_id where s.request_id=r.request_id),
    'payments', (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from public.pos_payments p where p.request_id=r.request_id or p.sale_id in (select s.id from public.pos_sales s where s.request_id=r.request_id)),
    'ledger', (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) from public.pos_customer_transactions l where l.sale_id in (select s.id from public.pos_sales s where s.request_id=r.request_id) or l.payment_id in (select p.id from public.pos_payments p where p.request_id=r.request_id))) from requests r
  union all
  select '03_counts', 'all_staging', jsonb_build_object(
    'sessions', (select count(*) from public.pos_register_sessions),
    'sales', (select count(*) from public.pos_sales),
    'items', (select count(*) from public.pos_sale_items),
    'payments', (select count(*) from public.pos_payments),
    'ledger', (select count(*) from public.pos_customer_transactions),
    'sale_total', (select coalesce(sum(total),0) from public.pos_sales),
    'payment_total', (select coalesce(sum(amount),0) from public.pos_payments),
    'customer_balance', (select coalesce(sum(amount),0) from public.pos_customer_transactions where customer_id='8a5737e7-f592-4983-8c27-189cd613d39d'::uuid))
  union all
  select '04_integrity', 'all_checks', jsonb_build_object('issue_count',count(*), 'issues',coalesce(jsonb_agg(to_jsonb(i)),'[]'::jsonb)) from issues i
  union all
  select '05_history', 'sales', coalesce(jsonb_agg(to_jsonb(s) order by s.sale_number),'[]'::jsonb) from public.pos_sales s
  union all
  select '05_history', 'payments', coalesce(jsonb_agg(to_jsonb(p) order by p.created_at,p.id),'[]'::jsonb) from public.pos_payments p
  union all
  select '05_history', 'sessions', coalesce(jsonb_agg(to_jsonb(s) order by s.opened_at,s.id),'[]'::jsonb) from public.pos_register_sessions s
  union all
  select '06_limits', 'interpretation', to_jsonb('No historical client clock/RPC responses or pre-race snapshot are available to this query. now() in the RPC is transaction-start time, not commit time: timestamps cannot prove lock/commit order. Sequence gaps are not duplicate sales. Zero integrity issues checks current consistency, not full concurrency coverage. Expected counts: 1 session, 2 or 3 sales/items, 4 or 5 payments, 4 ledger entries; drawer 121 and customer balance 0. Timeout and zero_debt requests must have empty arrays.'::text)
)
select section, object_name, details from report order by section, object_name;
