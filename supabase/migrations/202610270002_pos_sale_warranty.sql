-- Warranty code on a sale (typed at the till like the tracking code, searchable later).
alter table public.pos_sales add column if not exists warranty_code text
  check (warranty_code is null or length(warranty_code) <= 200);
create index if not exists pos_sales_warranty on public.pos_sales(warranty_code) where warranty_code is not null;

-- Same as pos_complete_sale, plus the warranty code, in ONE transaction.
create or replace function public.pos_complete_sale_warranty(p_request uuid, p_session uuid, p_type text,
  p_customer uuid, p_tracking text, p_items jsonb, p_payments jsonb, p_date date, p_warranty text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  sale uuid;
  code text := nullif(pg_catalog.btrim(coalesce(p_warranty, '')), '');
begin
  if code is not null and length(code) > 200 then raise exception 'INVALID_WARRANTY'; end if;
  sale := public.pos_complete_sale(p_request, p_session, p_type, p_customer, p_tracking, p_items, p_payments, p_date);
  if code is not null then
    update public.pos_sales set warranty_code = code where id = sale;
  end if;
  return sale;
end $$;

revoke all on function public.pos_complete_sale_warranty(uuid, uuid, text, uuid, text, jsonb, jsonb, date, text) from public, anon, authenticated;
grant execute on function public.pos_complete_sale_warranty(uuid, uuid, text, uuid, text, jsonb, jsonb, date, text) to authenticated;
notify pgrst, 'reload schema';
