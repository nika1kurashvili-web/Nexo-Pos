-- Keeps the shared public.products.stock (shown on the site) equal to the POS
-- stock ledger for products without variants. The site never shows a negative
-- number: POS may go below zero, the site value is clamped at 0.
create or replace function public.pos_sync_site_stock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.target_kind = 'product' and new.product_id is not null then
    update public.products p
       set stock = greatest(0, (select coalesce(sum(m.quantity_change), 0)
                                  from public.pos_stock_movements m
                                 where m.target_kind = 'product' and m.product_id = new.product_id))
     where p.id = new.product_id
       and not exists (select 1 from public.product_variants v where v.product_id = p.id and v.active);
  end if;
  return null;
end $$;

revoke all on function public.pos_sync_site_stock() from public, anon, authenticated;

drop trigger if exists pos_stock_movements_site_sync on public.pos_stock_movements;
create trigger pos_stock_movements_site_sync
  after insert on public.pos_stock_movements
  for each row execute function public.pos_sync_site_stock();

-- one-time catch-up for products that already have POS movements
update public.products p
   set stock = greatest(0, s.qty)
  from (select product_id, sum(quantity_change) as qty
          from public.pos_stock_movements
         where target_kind = 'product' and product_id is not null
         group by product_id) s
 where p.id = s.product_id
   and not exists (select 1 from public.product_variants v where v.product_id = p.id and v.active);

notify pgrst, 'reload schema';
