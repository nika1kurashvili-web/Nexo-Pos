-- Opening stock: copies public.products.stock into the POS stock ledger once.
-- Only products without active variants and with a non-zero stock, and only
-- when POS has no movement for the product yet, so re-running is harmless.
-- Products stock in the Orders app is NOT modified.
insert into public.pos_stock_movements(kind, target_kind, product_id, variant_id, sku, product_name, variant_name, quantity_change, document_id)
select 'inventory', 'product', p.id, null, p.sku, p.name, null, round(p.stock, 3), gen_random_uuid()
from public.products p
where p.stock is not null
  and round(p.stock, 3) <> 0
  and p.stock > '-Infinity'::numeric and p.stock < 'Infinity'::numeric
  and not exists (select 1 from public.product_variants v where v.product_id = p.id and v.active)
  and not exists (select 1 from public.pos_stock_movements m where m.target_kind = 'product' and m.product_id = p.id);

notify pgrst, 'reload schema';
