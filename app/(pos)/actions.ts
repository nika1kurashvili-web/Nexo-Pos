"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/server";
import { posClient, rpcClient } from "@/lib/pos/server";
import { parsePrice } from "@/lib/pos/import-prices";
import { safeAuthError } from "@/lib/auth/diagnostics";
import type { Json } from "@/lib/pos/types";
import { fetchAll } from "@/lib/pos/paginate";
import * as XLSX from "xlsx";

const text = (form: FormData, name: string) =>
  String(form.get(name) ?? "").trim();

const optional = (form: FormData, name: string) =>
  text(form, name) || null;

const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  );

function finish(
  error: { code?: string; message?: string } | null,
  path: string
): never {
  if (error) {
    console.error("[nexo-pos-operation]", safeAuthError(error));

    const reason =
      error.code === "23505" ? "conflict" : "failed";

    redirect(`${path}?error=${reason}`);
  }

  revalidatePath("/", "layout");
  redirect(`${path}?saved=1`);
}

export async function saveCustomer(form: FormData) {
  await requireAdmin();

  const client = await posClient();
  const id = text(form, "id");
  const path = id && uuid(id) ? `/customers/${id}` : "/customers";
  const name = text(form, "name");

  if (!name || name.length > 200 || (id && !uuid(id))) {
    redirect(`${path}?error=invalid`);
  }

  const values = {
    name,
    tax_code: optional(form, "tax_code"),
    phone: optional(form, "phone"),
    address: optional(form, "address"),
    email: optional(form, "email"),
    notes: optional(form, "notes"),
    active: form.has("active"),
  };

  const { error } = id
    ? await client
        .from("pos_business_customers")
        .update(values)
        .eq("id", id)
    : await client
        .from("pos_business_customers")
        .insert(values);

  finish(error, path);
}

export async function saveRegister(form: FormData) {
  await requireAdmin();

  const client = await posClient();
  const id = text(form, "id");
  const name = text(form, "name");

  if (!name || name.length > 100 || (id && !uuid(id))) {
    redirect("/registers?error=invalid");
  }

  const values = {
    name,
    active: form.has("active"),
  };

  const { error } = id
    ? await client
        .from("pos_registers")
        .update(values)
        .eq("id", id)
    : await client.from("pos_registers").insert(values);

  finish(error, "/registers");
}

export async function savePaymentMethod(form: FormData) {
  await requireAdmin();

  const client = await posClient();

  const { error } = await client
    .from("pos_payment_methods")
    .update({ active: form.has("active") })
    .eq("code", text(form, "code"));

  finish(error, "/payment-methods");
}

export async function saveCustomerPrice(form: FormData) {
  await requireAdmin();

  const client = await posClient();
  const customer = text(form, "customer_id");
  const price = parsePrice(text(form, "price"));

  if (!uuid(customer)) {
    redirect("/customers?error=invalid");
  }

  const path = `/customers/${customer}`;
  const sku = text(form, "sku");

  if (!price || !sku) {
    redirect(`${path}?error=invalid`);
  }

  const { error } = await client.rpc(
    "pos_import_customer_prices",
    {
      p_customer: customer,
      p_rows: [{ sku, price }],
    }
  );

  finish(error, path);
}

export async function openRegister(form: FormData) {
  const client = await posClient();

  const register = text(form, "register_id");
  const cash = parsePrice(text(form, "opening_cash"));

  if (!uuid(register) || cash === null) {
    redirect("/?error=invalid");
  }

  const { error } = await client.rpc("pos_open_register", {
    p_register: register,
    p_cash: cash,
  });

  finish(error, "/");
}

export async function closeRegister(form: FormData) {
  const client = await posClient();

  const session = text(form, "session_id");
  const actual = parsePrice(text(form, "actual_cash"));

  if (!uuid(session) || actual === null) {
    redirect("/?error=invalid");
  }

  const { error } = await client.rpc("pos_close_register", {
    p_session: session,
    p_actual: actual,
    p_note: text(form, "note"),
  });

  finish(error, "/");
}
export async function completeSale(form: FormData) {
  const client = await rpcClient();

  const requestId = text(form, "request_id");
  const session = text(form, "session_id");
  const saleType = text(form, "sale_type");
  const customer = optional(form, "customer_id");
  const tracking = optional(form, "tracking_code");

  if (
    !uuid(requestId) ||
    !uuid(session) ||
    !["retail", "wholesale"].includes(saleType)
  ) {
    redirect("/sales/new?error=invalid");
  }

  if (saleType === "retail" && customer !== null) {
    redirect("/sales/new?error=invalid");
  }

  if (
    saleType === "wholesale" &&
    (!customer || !uuid(customer))
  ) {
    redirect("/sales/new?error=invalid");
  }

  let items: Json;
  let payments: Json;

  try {
    items = JSON.parse(text(form, "items")) as Json;
    payments = JSON.parse(text(form, "payments")) as Json;
  } catch {
    redirect("/sales/new?error=invalid");
  }

  if (!Array.isArray(items) || items.length === 0) {
    redirect("/sales/new?error=invalid");
  }

  if (!Array.isArray(payments)) {
    redirect("/sales/new?error=invalid");
  }

  /*
   * Retail გაყიდვა სრულად უნდა იყოს გადახდილი,
   * ამიტომ მინიმუმ ერთი payment სჭირდება.
   *
   * Wholesale-ს შეიძლება ჰქონდეს:
   * - სრული გადახდა
   * - ნაწილობრივი გადახდა
   * - 0 გადახდა
   *
   * დარჩენილ თანხას DB თვითონ აფიქსირებს დავალიანებად.
   */
  if (saleType === "retail" && payments.length === 0) {
    redirect("/sales/new?error=invalid");
  }

  const { error } = await client.rpc(
    "pos_complete_sale",
    {
      p_request: requestId,
      p_session: session,
      p_type: saleType,
      p_customer:
        saleType === "wholesale" ? customer : null,
      p_tracking: tracking,
      p_items: items,
      p_payments: payments,
    }
  );

  if (error) {
    console.error(
      "[nexo-pos-sale]",
      safeAuthError(error)
    );

    redirect(`/sales/new?error=failed&request=${requestId}`);
  }

  revalidatePath("/", "layout");
  revalidatePath("/sales");

  if (customer) {
    revalidatePath(`/customers/${customer}`);
  }

  redirect("/sales/new?saved=1");
}
export async function recordCustomerRepayment(
  form: FormData
) {
  const client = await posClient();

  const requestId = text(form, "request_id");
  const customer = text(form, "customer_id");
  const sale = text(form, "sale_id");
  const session = text(form, "session_id");
  const method = text(form, "method");
  const amount = parsePrice(text(form, "amount"));
  // თარიღი არასავალდებულოა: ცარიელი = დღეს. ფორმატი YYYY-MM-DD, სხვა ვალიდაცია ბაზაშია.
  const paidOn = text(form, "paid_on");

  const path = uuid(customer)
    ? `/customers/${customer}`
    : "/customers";

  if (
    !uuid(requestId) ||
    !uuid(customer) ||
    !uuid(sale) ||
    !uuid(session) ||
    !method ||
    amount === null ||
    Number(amount) <= 0 ||
    (paidOn !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(paidOn))
  ) {
    redirect(`${path}?error=invalid`);
  }

  const { error } = await client.rpc(
    "pos_record_repayment",
    {
      p_request: requestId,
      p_sale: sale,
      p_session: session,
      p_method: method,
      p_amount: amount,
      p_date: paidOn || null,
    }
  );

  if (error) {
    console.error(
      "[nexo-pos-repayment]",
      safeAuthError(error)
    );

    redirect(
      `${path}?error=${error.message?.trim() === "INVALID_PAYMENT_DATE" ? "date" : "failed"}`
    );
  }

  revalidatePath("/", "layout");
  revalidatePath("/sales");
  revalidatePath(`/sales/${sale}`);
  revalidatePath(path);

  redirect(`${path}?saved=1`);
}
export async function importCustomerPricesExcel(
  form: FormData
) {
  await requireAdmin();

  const client = await posClient();
  const customer = text(form, "customer_id");

  if (!uuid(customer)) {
    redirect("/customers?error=invalid");
  }

  const path = `/customers/${customer}`;
  const file = form.get("file");

  if (!(file instanceof File) || file.size === 0) {
    redirect(`${path}?error=invalid`);
  }

  if (file.size > 4 * 1024 * 1024) {
    redirect(`${path}?error=too_large`);
  }

  const fileName = file.name.toLowerCase();

  if (
    !fileName.endsWith(".xlsx") &&
    !fileName.endsWith(".xls")
  ) {
    redirect(`${path}?error=invalid`);
  }

  let rows: Array<{
    sku: string;
    price: string;
  }> = [];
  let skipped = 0;

  try {
    const buffer = Buffer.from(
      await file.arrayBuffer()
    );

    const workbook = XLSX.read(buffer, {
      type: "buffer",
    });

    const sheetName = workbook.SheetNames[0];

    if (!sheetName) {
      redirect(`${path}?error=invalid`);
    }

    const sheet = workbook.Sheets[sheetName];

    const rawRows = XLSX.utils.sheet_to_json<
      Record<string, unknown>
    >(sheet, {
      defval: "",
    });

    rows = rawRows
      .map((row) => {
        const normalized = Object.fromEntries(
          Object.entries(row).map(
            ([key, value]) => [
              key.trim().toLowerCase(),
              value,
            ]
          )
        );

        const sku = String(
          normalized.sku ??
            normalized["sku / ბარკოდი"] ??
            normalized["ბარკოდი"] ??
            ""
        ).trim();

        const rawPrice =
          normalized.price ??
          normalized["ფასი"] ??
          normalized["საბითუმო ფასი"] ??
          "";

        const price = parsePrice(
          String(rawPrice).trim()
        );

        if (!sku || price === null || Number(price) < 0) {
          return null;
        }

        return {
          sku,
          price,
        };
      })
      .filter(
        (
          row
        ): row is {
          sku: string;
          price: string;
        } => row !== null
      );
    skipped = rawRows.length - rows.length;
  } catch (error) {
    console.error(
      "[nexo-pos-price-import]",
      error
    );

    redirect(`${path}?error=invalid`);
  }

  if (rows.length === 0) {
    redirect(`${path}?error=invalid`);
  }

  // DB ფუნქცია ერთ ჯერზე მაქსიმუმ 2000 სტრიქონს იღებს.
  if (rows.length > 2000) {
    redirect(`${path}?error=too_many`);
  }

  const { data, error } = await client.rpc(
    "pos_import_customer_prices",
    {
      p_customer: customer,
      p_rows: rows,
    }
  );

  if (error) {
    console.error(
      "[nexo-pos-price-import]",
      safeAuthError(error)
    );

    redirect(`${path}?error=failed`);
  }

  revalidatePath(path);

  redirect(
    `${path}?saved=1&imported=${encodeURIComponent(
      String(data ?? rows.length)
    )}&skipped=${skipped}`
  );
}


// Wholesale prices are loaded only for the customer being served, instead of
// shipping every customer's price list with the page.
export async function loadCustomerPrices(customerId: string) {
  if (!uuid(customerId)) return { ok: false as const, prices: [] };
  const client = await posClient();
  const { data, error } = await fetchAll<{
    product_id: string | null;
    variant_id: string | null;
    price: string | number;
  }>((from, to) => client
    .from("pos_customer_prices")
    .select("product_id,variant_id,price")
    .eq("customer_id", customerId)
    .order("id")
    .range(from, to));
  if (error) return { ok: false as const, prices: [] };
  return {
    ok: true as const,
    prices: data.map((row) => ({
      productId: row.product_id === null ? null : String(row.product_id),
      variantId: row.variant_id === null ? null : String(row.variant_id),
      price: Number(row.price),
    })),
  };
}
