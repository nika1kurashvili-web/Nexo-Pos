import Link from "next/link";
import { measureSaleQuery } from "@/lib/performance";
import { fetchAll } from "@/lib/pos/paginate";
import { requirePosProfile } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { tbilisiToday } from "@/lib/pos/analytics";
import { Notice } from "@/app/components/pos-forms";
import SaleTerminal from "@/app/components/sale-terminal";

export const dynamic = "force-dynamic";

type CatalogRow = {
  id: string;
  name: string;
  sku: string | null;
  price: string | number;
  active: boolean;
};

type VariantRow = CatalogRow & {
  product_id: string;
};

export default async function NewSalePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    saved?: string;
    request?: string;
  }>;
}) {
  const profile = await requirePosProfile();
  const client = await posClient();

  const [
    { data: sessionData, error: sessionError },
    { data: productData, error: productError },
    { data: variantData, error: variantError },
    { data: paymentData, error: paymentError },
    { data: customerData, error: customerError },
  ] = await Promise.all([
    measureSaleQuery("session", client
      .from("pos_register_sessions")
      .select("id")
      .eq("cashier_id", profile.id)
      .eq("status", "open")
      .order("opened_at", { ascending: false })
      .limit(1)),

    measureSaleQuery("products", fetchAll<CatalogRow>((from, to) => client
      .from("products" as never)
      .select("id,name,sku,price,active")
      .eq("active", true)
      .order("name")
      .order("id")
      .range(from, to))),

    measureSaleQuery("variants", fetchAll<VariantRow>((from, to) => client
      .from("product_variants" as never)
      .select("id,product_id,name,sku,price,active")
      .eq("active", true)
      .order("name")
      .order("id")
      .range(from, to))),

    measureSaleQuery("payment_methods", client
      .from("pos_payment_methods")
      .select("code,name,is_debt")
      .eq("active", true)
      .order("name")),

    measureSaleQuery("customers", fetchAll<{ id: string; name: string; tax_code: string | null }>((from, to) => client
      .from("pos_business_customers")
      .select("id,name,tax_code")
      .eq("active", true)
      .order("name")
      .order("id")
      .range(from, to))),

  ]);

  const session = sessionData?.[0] ?? null;

  if (
    sessionError ||
    productError ||
    variantError ||
    paymentError ||
    customerError
  ) {
    return (
      <>
        <h1>ახალი გაყიდვა</h1>

        <Notice loadError />

        <p>
          <Link href="/sales">
            გაყიდვებში დაბრუნება
          </Link>
        </p>
      </>
    );
  }

  if (!session) {
    return (
      <>
        <h1>ახალი გაყიდვა</h1>

        <section className="panel">
          <h2>სალარო დახურულია</h2>

          <p>
            გაყიდვის დასაწყებად ჯერ უნდა გახსნა სალარო.
          </p>

          <Link href="/" className="button">
            სალაროს გახსნა
          </Link>
        </section>
      </>
    );
  }

  const products =
    (productData ?? []) as unknown as CatalogRow[];

  const variants =
    (variantData ?? []) as unknown as VariantRow[];

  const productById = new Map(
    products.map((product) => [product.id, product])
  );

  const productsWithVariants = new Set(
    variants.map((variant) => variant.product_id)
  );

  const catalog = [
    ...products
      .filter(
        (product) =>
          !productsWithVariants.has(product.id)
      )
      .map((product) => ({
        kind: "product" as const,
        id: product.id,
        productId: product.id,
        name: product.name,
        variantName: null,
        sku: product.sku,
        price: Number(product.price),
      })),

    ...variants
      .filter((variant) =>
        productById.has(variant.product_id)
      )
      .map((variant) => {
        const product = productById.get(
          variant.product_id
        )!;

        return {
          kind: "variant" as const,
          id: variant.id,
          productId: product.id,
          name: product.name,
          variantName: variant.name,
          sku: variant.sku ?? product.sku,
          price: Number(variant.price),
        };
      }),
  ];

  const paymentMethods = (paymentData ?? []).map(
    (method) => ({
      code: method.code,
      name: method.name,
      isDebt: method.is_debt === true,
    })
  );

  const customers = (customerData ?? []).map(
    (customer) => ({
      id: customer.id,
      name: customer.name,
      taxCode: customer.tax_code,
    })
  );

  const requestId = crypto.randomUUID();
  const notice = await searchParams;

  /*
   * თუ წინა გაგზავნამ "failed" დააბრუნა, შესაძლებელია გაყიდვა მაინც ჩაწერილიყო
   * (მაგ. ქსელის შეცდომა პასუხის დაბრუნებამდე). ვამოწმებთ ამავე request_id-ით,
   * რომ მოლარემ იგივე გაყიდვა ხელახლა არ გაატაროს.
   */
  let recoveredSale: { id: string; sale_number: number | string } | null = null;

  if (
    notice.error === "failed" &&
    notice.request &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      notice.request
    )
  ) {
    const { data: existing } = await client
      .from("pos_sales")
      .select("id,sale_number")
      .eq("request_id", notice.request)
      .maybeSingle();

    recoveredSale = existing ?? null;
  }

  return (
    <>
      <div>
        <h1>ახალი გაყიდვა</h1>

        <p>
          <Link href="/sales">
            ← გაყიდვების ისტორია
          </Link>
        </p>
      </div>

      {recoveredSale ? (
        <p className="notice success" role="status">
          წინა გაყიდვა მაინც დაფიქსირდა (№{String(recoveredSale.sale_number)}). ხელახლა არ გაატაროთ.{" "}
          <Link href={`/sales/${recoveredSale.id}`}>გაყიდვის ნახვა</Link>
        </p>
      ) : (
        <Notice error={notice.error} />
      )}
      {!notice.error && notice.saved && <p className="notice success" role="status">გაყიდვა წარმატებით დაფიქსირდა</p>}

      <SaleTerminal
        key={requestId}
        items={catalog}
        paymentMethods={paymentMethods}
        sessionId={session.id}
        requestId={requestId}
        customers={customers}
        canBackdate={profile.role === "admin"}
        today={tbilisiToday()}
      />
    </>
  );
}