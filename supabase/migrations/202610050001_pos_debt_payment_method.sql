-- "ნიკასთან რიცხავს": a payment method that is NOT money received. An amount
-- entered on it stays as the wholesale customer's debt (wholesale sales only).
alter table public.pos_payment_methods add column if not exists is_debt boolean not null default false;
alter table public.pos_sales
  add column if not exists deferred_total numeric(14,2) not null default 0 check (deferred_total >= 0),
  add column if not exists deferred_method_name text;

insert into public.pos_payment_methods(code, name, is_debt)
values ('nika_transfer', 'ნიკასთან რიცხავს', true)
on conflict (code) do update set is_debt = true;

create or replace function public.pos_complete_sale(p_request uuid, p_session uuid, p_type text,
  p_customer uuid, p_tracking text, p_items jsonb, p_payments jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := public.pos_require_actor(); s public.pos_register_sessions; c public.pos_business_customers;
  normalized jsonb; fingerprint text; existing public.pos_sales; sale_id uuid := gen_random_uuid(); item jsonb; pay jsonb; q jsonb;
  item_record public.pos_sale_items; items jsonb := '[]'; qty numeric; base numeric; adjusted numeric;
  discount numeric; final_price numeric; line_total numeric; subtotal numeric := 0; total numeric := 0;
  paid numeric := 0; deferred numeric := 0; deferred_name text; amount numeric; method public.pos_payment_methods; payment_id uuid; line_no integer := 0;
begin
  if p_request is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text,0));
  normalized := public.pos_normalize_sale_request(actor,p_session,p_type,p_customer,p_tracking,p_items,p_payments);
  fingerprint := encode(sha256(convert_to(normalized::text,'UTF8')),'hex');
  p_items := normalized->'items'; p_payments := normalized->'payments';
  select * into existing from public.pos_sales where request_id = p_request;
  if found then
    if existing.cashier_id <> actor or existing.request_fingerprint is distinct from fingerprint then raise exception 'REQUEST_CONFLICT'; end if;
    return existing.id;
  end if;
  select * into s from public.pos_register_sessions where id = p_session for update;
  if s.id is null or s.status <> 'open' or s.cashier_id <> actor then raise exception 'OPEN_SESSION_REQUIRED'; end if;
  if p_type is null or p_type not in ('retail','wholesale') then raise exception 'INVALID_SALE_TYPE'; end if;
  if p_customer is not null then
    select * into c from public.pos_business_customers where id = p_customer and active for share;
    if not found then raise exception 'CUSTOMER_UNAVAILABLE'; end if;
  elsif p_type = 'wholesale' then raise exception 'WHOLESALE_CUSTOMER_REQUIRED'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 500
    or jsonb_typeof(p_payments) is distinct from 'array' or jsonb_array_length(p_payments) > 20 then raise exception 'INVALID_SALE_ROWS'; end if;
  for item in select * from jsonb_array_elements(p_items) loop
    q := public.pos_quote(item->>'kind', item->>'target', p_type, p_customer);
    if q->>'state' <> 'found' then raise exception 'WHOLESALE_PRICE_MISSING'; end if;
    base := public.pos_decimal(q->>'price',2);
    adjusted := public.pos_decimal(coalesce(item->>'unit_price',base::text),2);
    qty := public.pos_decimal(item->>'quantity',3,true);
    discount := public.pos_decimal(coalesce(item->>'discount_percent','0'),2);
    if discount > 100 then raise exception 'INVALID_DISCOUNT'; end if;
    final_price := round(adjusted * (1 - discount / 100),2);
    line_total := round(final_price * qty,2);
    subtotal := subtotal + round(adjusted * qty,2);
    total := total + line_total;
    line_no := line_no + 1;
    items := items || jsonb_build_array(q || jsonb_build_object('line_number',line_no,'target_kind',item->>'kind',
      'base_unit_price',base,'adjusted_unit_price',adjusted,'quantity',qty,'discount_percent',discount,
      'final_unit_price',final_price,'line_total',line_total));
  end loop;
  for pay in select * from jsonb_array_elements(p_payments) loop
    amount := public.pos_decimal(pay->>'amount',2);
    select * into method from public.pos_payment_methods where code = pay->>'method' and active for share;
    if not found then raise exception 'PAYMENT_METHOD_UNAVAILABLE'; end if;
    if method.is_debt then
      -- A debt method ("pays later") is not money received: the amount stays as the customer's debt.
      if amount > 0 and p_type <> 'wholesale' then raise exception 'DEBT_METHOD_WHOLESALE_ONLY'; end if;
      if amount > 0 then deferred := deferred + amount; deferred_name := coalesce(deferred_name, method.name); end if;
    else
      paid := paid + amount;
    end if;
  end loop;
  if paid + deferred > total then raise exception 'OVERPAYMENT_NOT_SUPPORTED'; end if;
  if p_type = 'retail' and paid <> total then raise exception 'RETAIL_FULL_PAYMENT_REQUIRED'; end if;
  insert into public.pos_sales(id,request_id,request_fingerprint,cashier_id,cashier_name,session_id,sale_type,customer_id,
    customer_name,customer_tax_code,tracking_code,subtotal,discount_total,total,paid_total,debt_amount,deferred_total,deferred_method_name)
  values(sale_id,p_request,fingerprint,actor,(select full_name from public.pos_profiles where id = actor),s.id,p_type,c.id,
    c.name,c.tax_code,nullif(btrim(p_tracking),''),subtotal,subtotal-total,total,paid,total-paid,deferred,deferred_name);
  for item in select * from jsonb_array_elements(items) loop
    item_record := jsonb_populate_record(null::public.pos_sale_items,item);
    insert into public.pos_sale_items(sale_id,line_number,target_kind,product_id,variant_id,sku,product_name,variant_name,
      base_unit_price,adjusted_unit_price,quantity,discount_percent,final_unit_price,line_total)
    values(sale_id,item_record.line_number,item_record.target_kind,item_record.product_id,item_record.variant_id,
      item_record.sku,item_record.product_name,item_record.variant_name,item_record.base_unit_price,
      item_record.adjusted_unit_price,item_record.quantity,item_record.discount_percent,item_record.final_unit_price,item_record.line_total);
  end loop;
  if p_type = 'wholesale' then
    insert into public.pos_customer_transactions(customer_id,sale_id,kind,amount) values(c.id,sale_id,'sale_charge',total);
  end if;
  for pay in select * from jsonb_array_elements(p_payments) loop
    amount := public.pos_decimal(pay->>'amount',2);
    if amount = 0 then continue; end if;
    select * into method from public.pos_payment_methods where code = pay->>'method';
    if method.is_debt then continue; end if;
    insert into public.pos_payments(request_id,sale_id,session_id,received_by,method_code,method_name,kind,amount)
      values(gen_random_uuid(),sale_id,s.id,actor,method.code,method.name,'sale_payment',amount) returning id into payment_id;
    if p_type = 'wholesale' then
      insert into public.pos_customer_transactions(customer_id,sale_id,payment_id,kind,amount)
        values(c.id,sale_id,payment_id,'sale_payment',-amount);
    end if;
  end loop;
  return sale_id;
end $$;

notify pgrst, 'reload schema';
