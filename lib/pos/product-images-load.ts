import "server-only";
import { fetchAll } from "@/lib/pos/paginate";
import { posClient } from "@/lib/pos/server";

type Row = { id: string; image_url: string | null };

// აბრუნებს ფოტოების რუკას: "product:<id>" / "variant:<id>" → ბმული. თუ მიგრაცია ჯერ არ არის გაშვებული, ცარიელია.
export async function loadImageMap(client: Awaited<ReturnType<typeof posClient>>): Promise<{ map: Map<string, string>; ready: boolean }> {
  const map = new Map<string, string>();
  const [products, variants] = await Promise.all([
    fetchAll<Row>((from, to) => client.from("products" as never).select("id,image_url").not("image_url", "is", null).order("id").range(from, to)),
    fetchAll<Row>((from, to) => client.from("product_variants" as never).select("id,image_url").not("image_url", "is", null).order("id").range(from, to)),
  ]);
  if (products.error || variants.error) return { map, ready: false };
  for (const row of products.data) if (row.image_url) map.set(`product:${row.id}`, row.image_url);
  for (const row of variants.data) if (row.image_url) map.set(`variant:${row.id}`, row.image_url);
  return { map, ready: true };
}
