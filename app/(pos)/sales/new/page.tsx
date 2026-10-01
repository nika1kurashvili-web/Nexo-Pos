import Link from "next/link";
import { measureSaleQuery } from "@/lib/performance";
import { requirePosProfile } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
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
    { data: customerPriceData, error: customerPriceError },
  ] = await Promise.all([
    measureSaleQuery("session", client
      .from("pos_register_sessions")
      .select("id")
      .eq("cashier_id", profile.id)
      .eq("status", "open")
      .order("opened_at", { ascending: false })
      .limit(1)),

    measureSaleQuery("products", client
      .from("products" as never)
      .select("id,name,sku,price,active")
      .eq("active", true)
      .order("name")),

    measureSaleQuery("variants", client
      .from("product_variants" as never)
      .select("id,product_id,name,sku,price,active")
      .eq("active", true)
      .order("name")),

    measureSaleQuery("payment_methods", client
      .from("pos_payment_methods")
      .select("code,name")
      .eq("active", true)
      .order("name")),

    measureSaleQuery("customers", client
      .from("pos_business_customers")
      .select("id,name,tax_code")
      .eq("active", true)
      .order("name")
      .limit(500)),

    measureSaleQuery("customer_prices", client
      .from("pos_customer_prices")
      .select("customer_id,product_id,variant_id,price")
      .limit(10000)),
  ]);

  const session = sessionData?.[0] ?? null;

  if (
    sessionError ||
    productError ||
    variantError ||
    paymentError ||
    customerError ||
    customerPriceError
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
    })
  );

  const customers = (customerData ?? []).map(
    (customer) => ({
      id: customer.id,
      name: customer.name,
      taxCode: customer.tax_code,
    })
  );

  const customerPrices = (customerPriceData ?? []).map(
    (price) => ({
      customerId: price.customer_id,
      productId:
        price.product_id === null
          ? null
          : String(price.product_id),
      variantId:
        price.variant_id === null
          ? null
          : String(price.variant_id),
      price: Number(price.price),
    })
  );

  const requestId = crypto.randomUUID();

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

      <Notice {...(await searchParams)} />

      <SaleTerminal
        items={catalog}
        paymentMethods={paymentMethods}
        sessionId={session.id}
        requestId={requestId}
        customers={customers}
        customerPrices={customerPrices}
      />
    </>
  );
}