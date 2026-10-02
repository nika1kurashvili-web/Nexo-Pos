-- pos_return_sale_details calls pos_require_actor(), which takes a FOR SHARE lock.
-- STABLE functions run in a read-only transaction through PostgREST, so the
-- lookup failed with SQLSTATE 25006. Make it VOLATILE.
alter function public.pos_return_sale_details(bigint) volatile;
