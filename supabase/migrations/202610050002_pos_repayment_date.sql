-- Repayment date: lets the cashier record a payment that actually arrived earlier
-- (not in the future, not before the sale). Replaces the 5-argument function.
drop function if exists public.pos_record_repayment(uuid, uuid, uuid, text, text);

create function public.pos_record_repayment(p_request uuid, p_sale uuid, p_session uuid, p_method text, p_amount text, p_date date default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid := public.pos_require_actor(); s public.pos_register_sessions; sale public.pos_sales;
  method public.pos_payment_methods; previous public.pos_payments; balance numeric; amount numeric; result uuid; fingerprint text;
  paid_at timestamptz := now(); today_tbilisi date := (now() at time zone 'Asia/Tbilisi')::date; sale_day date;
begin
  if p_request is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text,0));
  amount := public.pos_decimal(p_amount,2,true);
  fingerprint := encode(sha256(convert_to(jsonb_build_object('version',1,'operation','repayment',
    'actor',actor,'sale',p_sale,'session',p_session,'method',p_method,'amount',trim_scale(amount),'date',p_date)::text,'UTF8')),'hex');
  select * into previous from public.pos_payments where request_id = p_request;
  if found then
    if previous.received_by <> actor or previous.kind <> 'repayment' or previous.request_fingerprint is distinct from fingerprint then raise exception 'REQUEST_CONFLICT'; end if;
    return previous.id;
  end if;
  select * into s from public.pos_register_sessions where id = p_session for update;
  if s.id is null or s.status <> 'open' or s.cashier_id <> actor then raise exception 'OPEN_SESSION_REQUIRED'; end if;
  select * into sale from public.pos_sales where id = p_sale for update;
  if sale.id is null or sale.sale_type <> 'wholesale' then raise exception 'WHOLESALE_SALE_REQUIRED'; end if;
  -- Cashiers operate on their own sales; broader debt collection UI is deferred.
  if sale.cashier_id <> actor and public.pos_role() <> 'admin' then raise exception 'SALE_ACCESS_DENIED'; end if;
  amount := public.pos_decimal(p_amount,2,true);
  select coalesce(sum(t.amount),0) into balance from public.pos_customer_transactions t where t.sale_id = sale.id;
  if amount > balance then raise exception 'OVERPAYMENT_NOT_SUPPORTED'; end if;
  select * into method from public.pos_payment_methods where code = p_method and active for share;
  if not found or method.is_debt then raise exception 'PAYMENT_METHOD_UNAVAILABLE'; end if;
  -- Backdating: the money may have arrived earlier (e.g. a bank transfer entered the next day).
  -- The date cannot be in the future or before the sale itself.
  if p_date is not null and p_date <> today_tbilisi then
    sale_day := (sale.created_at at time zone 'Asia/Tbilisi')::date;
    if p_date > today_tbilisi or p_date < sale_day then raise exception 'INVALID_PAYMENT_DATE'; end if;
    paid_at := least(now(), greatest(make_timestamptz(extract(year from p_date)::int, extract(month from p_date)::int,
      extract(day from p_date)::int, 12, 0, 0, 'Asia/Tbilisi'), sale.created_at + interval '1 second'));
  end if;
  insert into public.pos_payments(request_id,request_fingerprint,sale_id,session_id,received_by,method_code,method_name,kind,amount,created_at)
    values(p_request,fingerprint,sale.id,s.id,actor,method.code,method.name,'repayment',amount,paid_at) returning id into result;
  insert into public.pos_customer_transactions(customer_id,sale_id,payment_id,kind,amount,created_at)
    values(sale.customer_id,sale.id,result,'repayment',-amount,paid_at);
  return result;
end $$;

revoke all on function public.pos_record_repayment(uuid, uuid, uuid, text, text, date) from public, anon, authenticated;
grant execute on function public.pos_record_repayment(uuid, uuid, uuid, text, text, date) to authenticated;

notify pgrst, 'reload schema';
