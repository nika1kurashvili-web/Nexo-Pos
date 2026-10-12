import "server-only";
import { fetchAll } from "@/lib/pos/paginate";
import { posClient } from "@/lib/pos/server";

type Row = { id: string; image_url: string | null; image_extra?: string[] | null };

// აბრუნებს ფოტოების რუკებს: "product:<id>" / "variant:<id>" → მთავარი ბმული და დამატებითი ბმულების სია.
// ready=false: მიგრაცია 202610120001 არ არის გაშვებული; extrasReady=false: 202610120002 არ არის გაშვებული.
export async function loadImageMap(client: Awaited<ReturnType<typeof posClient>>): Promise<{ map: Map<string, string>; extras: Map<string, string[]>; ready: boolean; extrasReady: boolean }> {
  const map = new Map<string, string>();
  const extras = new Map<string, string[]>();
  const read = async (table: "products" | "product_variants", columns: string) =>
    fetchAll<Row>((from, to) => client.from(table as never).select(columns).order("id").range(from, to));

  let extrasReady = true;
  let [products, variants] = await Promise.all([read("products", "id,image_url,image_extra"), read("product_variants", "id,image_url,image_extra")]);
  if (products.error || variants.error) {
    extrasReady = false;
    [products, variants] = await Promise.all([read("products", "id,image_url"), read("product_variants", "id,image_url")]);
  }
  if (products.error || variants.error) return { map, extras, ready: false, extrasReady: false };
  for (const [kind, rows] of [["product", products.data], ["variant", variants.data]] as const) {
    for (const row of rows) {
      if (row.image_url) map.set(`${kind}:${row.id}`, row.image_url);
      if (row.image_extra && row.image_extra.length > 0) extras.set(`${kind}:${row.id}`, row.image_extra);
    }
  }
  return { map, extras, ready: true, extrasReady };
}
