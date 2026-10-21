"use client";

import { useDeferredValue, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useFormStatus } from "react-dom";
import { completeSale, loadCustomerPrices } from "@/app/(pos)/actions";
import "./sale-terminal.css";

type CatalogItem = {
  kind: "product" | "variant";
  id: string;
  productId: string;
  name: string;
  variantName: string | null;
  sku: string | null;
  price: number;
  imageUrl?: string | null;
  // მარაგის ნაშთი (null = უცნობია)
  stock?: number | null;
};

type PaymentMethod = {
  code: string;
  name: string;
  // true = „გადახდა მოგვიანებით“ (მაგ. ნიკასთან რიცხავს): თანხა არ ითვლება მიღებულად, რჩება ვალად.
  isDebt?: boolean;
};

type Customer = {
  id: string;
  name: string;
  taxCode: string | null;
};

type CustomerPrice = {
  productId: string | null;
  variantId: string | null;
  price: number;
};

type CartItem = CatalogItem & {
  quantity: number;
  unitPrice: string;
  discountPercent: string;
};

type PaymentRow = {
  id: number;
  method: string;
  // null means automatic; any string (including empty or zero) is a manual edit.
  amount: string | null;
};

type Props = {
  items: CatalogItem[];
  paymentMethods: PaymentMethod[];
  sessionId: string;
  requestId: string;
  customers: Customer[];
  // ადმინს შეუძლია გაყიდვის თარიღის შეცვლა (წარსულით); today = თბილისის დღევანდელი თარიღი.
  canBackdate?: boolean;
  today?: string;
};

const moneyInput = (value: string) => value.replace(/^0+(?=\d)/, "");

const round2 = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

function SaleSubmit({ disabled, children }: { disabled: boolean; children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return <button type="submit" className="till-cta" disabled={disabled || pending} aria-busy={pending || undefined}>
    {pending ? "ინახება…" : children}
  </button>;
}

export default function SaleTerminal({
  items,
  paymentMethods,
  sessionId,
  requestId,
  customers,
  canBackdate = false,
  today = "",
}: Props) {
  const [saleDate, setSaleDate] = useState(today);
  const [saleType, setSaleType] =
    useState<"retail" | "wholesale">("retail");

  const [customerId, setCustomerId] = useState("");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [trackingCode, setTrackingCode] = useState("");
  // მხოლოდ არჩეული კლიენტის ფასები იტვირთება (არა ყველა კლიენტის ერთად).
  const [customerPrices, setCustomerPrices] = useState<CustomerPrice[]>([]);
  const [pricesStatus, setPricesStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const priceRequest = useRef(0);
  const deferredSearch = useDeferredValue(search);

  const defaultMethod =
    paymentMethods.find((method) => !method.isDebt)?.code ?? "";

  const [payments, setPayments] = useState<PaymentRow[]>([
    {
      id: 1,
      method: defaultMethod,
      amount: null,
    },
  ]);

  const [nextPaymentId, setNextPaymentId] = useState(2);

  const selectedCustomer = useMemo(
    () =>
      customers.find(
        (customer) => customer.id === customerId
      ) ?? null,
    [customers, customerId]
  );

  function resetPayments() {
    setPayments([
      {
        id: 1,
        method: defaultMethod,
        amount: null,
      },
    ]);
    setNextPaymentId(2);
  }

  const priceByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of customerPrices) {
      if (row.variantId !== null) map.set(`v:${row.variantId}`, row.price);
      else if (row.productId !== null) map.set(`p:${row.productId}`, row.price);
    }
    return map;
  }, [customerPrices]);

  const priceKey = (item: CatalogItem) =>
    item.kind === "variant" ? `v:${item.id}` : `p:${item.id}`;

  function wholesalePrice(item: CatalogItem) {
    if (!customerId) return null;
    return priceByKey.get(priceKey(item)) ?? null;
  }

  // ძებნის ტექსტი ერთხელ მზადდება და არა ყოველ კლავიშზე ყველა ნივთისთვის.
  const searchText = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      map.set(
        `${item.kind}-${item.id}`,
        [item.name, item.variantName ?? "", item.sku ?? ""].join(" ").toLowerCase()
      );
    }
    return map;
  }, [items]);

  const availableItems = useMemo(() => {
    if (saleType === "retail") {
      return items;
    }

    if (!customerId) {
      return [];
    }

    const result: CatalogItem[] = [];
    for (const item of items) {
      const price = priceByKey.get(priceKey(item));
      if (price !== undefined) result.push({ ...item, price });
    }
    return result;
  }, [items, saleType, customerId, priceByKey]);

  const results = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();

    if (!query) {
      return availableItems.slice(0, 30);
    }

    const found: CatalogItem[] = [];
    for (const item of availableItems) {
      if ((searchText.get(`${item.kind}-${item.id}`) ?? "").includes(query)) {
        found.push(item);
        if (found.length >= 30) break;
      }
    }
    return found;
  }, [availableItems, deferredSearch, searchText]);

  // ბარკოდის სკანერი: ზუსტად ერთნაირი კოდის მქონე პროდუქტი პირდაპირ კალათაში ემატება.
  const bySku = useMemo(() => {
    const map = new Map<string, CatalogItem[]>();
    for (const item of availableItems) {
      const key = (item.sku ?? "").trim().toLowerCase();
      if (!key) continue;
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return map;
  }, [availableItems]);

  function exactSkuMatch(value: string, requireUnique: boolean): CatalogItem | null {
    const key = value.trim().toLowerCase();
    if (!key) return null;
    const hits = bySku.get(key);
    if (!hits || hits.length !== 1) return null;
    if (requireUnique) {
      // თუ უფრო გრძელი კოდიც იწყება ამავე ტექსტით, ხელით ჩაწერას ვერ ვიგებთ: Enter იქნება საჭირო.
      for (const other of bySku.keys()) if (other !== key && other.startsWith(key)) return null;
    }
    return hits[0];
  }

  function onSearchChange(value: string) {
    const hit = exactSkuMatch(value, true);
    if (hit) {
      addItem(hit);
      setSearch("");
      return;
    }
    setSearch(value);
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault(); // სკანერის Enter-მა გაყიდვის ფორმა არ უნდა გააგზავნოს
    const hit = exactSkuMatch(search, false);
    if (hit) {
      addItem(hit);
      setSearch("");
    }
  }

  function selectCustomerPrices(id: string) {
    const token = ++priceRequest.current;
    setCustomerPrices([]);

    if (!id) {
      setPricesStatus("idle");
      return;
    }

    setPricesStatus("loading");
    loadCustomerPrices(id)
      .then((result) => {
        if (token !== priceRequest.current) return;
        setCustomerPrices(result.prices);
        setPricesStatus(result.ok ? "ready" : "error");
      })
      .catch(() => {
        if (token === priceRequest.current) setPricesStatus("error");
      });
  }

  function changeSaleType(
    type: "retail" | "wholesale"
  ) {
    setSaleType(type);
    setCart([]);
    setSearch("");
    resetPayments();

    if (type === "retail") {
      setCustomerId("");
      selectCustomerPrices("");
    }
  }

  function changeCustomer(id: string) {
    setCustomerId(id);
    selectCustomerPrices(id);
    setCart([]);
    setSearch("");
    resetPayments();
  }

  function addItem(item: CatalogItem) {
    const price =
      saleType === "wholesale"
        ? wholesalePrice(item)
        : item.price;

    if (price === null) {
      return;
    }

    setCart((current) => {
      const existing = current.find(
        (row) =>
          row.kind === item.kind &&
          row.id === item.id
      );

      if (existing) {
        return current.map((row) =>
          row.kind === item.kind &&
          row.id === item.id
            ? {
                ...row,
                quantity: row.quantity + 1,
              }
            : row
        );
      }

      return [
        ...current,
        {
          ...item,
          quantity: 1,
          unitPrice: price === 0 ? "" : String(price),
          discountPercent: "",
        },
      ];
    });
  }

  function updateItem(
    index: number,
    field:
      | "quantity"
      | "unitPrice"
      | "discountPercent",
    value: number | string
  ) {
    setCart((current) =>
      current.map((row, rowIndex) => {
        if (rowIndex !== index) {
          return row;
        }

        if (field === "quantity") {
          return {
            ...row,
            quantity: Math.max(
              0.001,
              Number(value) || 0.001
            ),
          };
        }

        if (field === "unitPrice") {
          return {
            ...row,
            unitPrice: moneyInput(String(value)),
          };
        }

        return {
          ...row,
          discountPercent: moneyInput(String(value)),
        };
      })
    );
  }

  function changeQuantity(
    index: number,
    difference: number
  ) {
    setCart((current) =>
      current.map((row, rowIndex) => {
        if (rowIndex !== index) {
          return row;
        }

        return {
          ...row,
          quantity: Math.max(
            0.001,
            row.quantity + difference
          ),
        };
      })
    );
  }

  function removeItem(index: number) {
    setCart((current) =>
      current.filter(
        (_, rowIndex) => rowIndex !== index
      )
    );
  }

  const total = useMemo(() => {
    const value = cart.reduce((sum, row) => {
      const finalUnitPrice = round2(
        Number(row.unitPrice) *
          (1 - Number(row.discountPercent) / 100)
      );

      const lineTotal = round2(
        finalUnitPrice * row.quantity
      );

      return sum + lineTotal;
    }, 0);

    return round2(value);
  }, [cart]);

  // Allocate only the remaining cents to automatic rows; manual values stay untouched.
  let automaticRemaining = Math.max(0, Math.round(total * 100) - payments.reduce(
    (sum, payment) => sum + (payment.amount === null ? 0 : Math.round(Number(payment.amount || 0) * 100)), 0
  ));
  const displayedPayments = payments.map((payment) => {
    if (payment.amount !== null) return { ...payment, amount: payment.amount };
    const amount = automaticRemaining > 0 ? (automaticRemaining / 100).toFixed(2) : "";
    automaticRemaining = 0;
    return { ...payment, amount };
  });

  // საცალოზე „მოგვიანებით“ მეთოდები არ არის ხელმისაწვდომი (ვალი მხოლოდ საბითუმოს აქვს).
  const usableMethods = paymentMethods.filter(
    (method) => saleType === "wholesale" || !method.isDebt
  );
  const debtCodes = new Set(
    paymentMethods.filter((method) => method.isDebt).map((method) => method.code)
  );

  const paidTotal = round2(
    displayedPayments.reduce(
      (sum, payment) =>
        debtCodes.has(payment.method)
          ? sum
          : sum + Math.max(0, Number(payment.amount) || 0),
      0
    )
  );

  const deferredTotal = round2(
    displayedPayments.reduce(
      (sum, payment) =>
        debtCodes.has(payment.method)
          ? sum + Math.max(0, Number(payment.amount) || 0)
          : sum,
      0
    )
  );

  const remaining = round2(
    Math.max(0, total - paidTotal)
  );

  const overpayment = round2(
    Math.max(0, paidTotal + deferredTotal - total)
  );

  function updatePayment(
    id: number,
    field: "method" | "amount",
    value: string
  ) {
    setPayments((current) =>
      current.map((payment) => {
        if (payment.id !== id) {
          return payment;
        }

        if (field === "method") {
          return {
            ...payment,
            method: value,
          };
        }

        return {
          ...payment,
          amount: moneyInput(value),
        };
      })
    );
  }

  function addPayment() {
    const usedMethods = new Set(
      payments.map((payment) => payment.method)
    );

    const nextMethod =
      usableMethods.find(
        (method) => !usedMethods.has(method.code)
      )?.code ?? "";

    if (!nextMethod) {
      return;
    }

    setPayments((current) => [
      ...current,
      {
        id: nextPaymentId,
        method: nextMethod,
        amount: null,
      },
    ]);

    setNextPaymentId((current) => current + 1);
  }

  function removePayment(id: number) {
    setPayments((current) =>
      current.filter(
        (payment) => payment.id !== id
      )
    );
  }

  const duplicatePaymentMethod = payments.some(
    (payment, index) =>
      payment.method &&
      payments.findIndex(
        (row) => row.method === payment.method
      ) !== index
  );

  const validPayments = displayedPayments.filter(
    (payment) =>
      payment.method &&
      Number(payment.amount) > 0
  );

  const payload = JSON.stringify(
    cart.map((row) => ({
      kind: row.kind,
      target: row.id,
      quantity: row.quantity.toFixed(3),
      unit_price: Number(row.unitPrice).toFixed(2),
      discount_percent:
        Number(row.discountPercent).toFixed(2),
    }))
  );

  const paymentPayload = JSON.stringify(
    validPayments.map((payment) => ({
      method: payment.method,
      amount: round2(Number(payment.amount)).toFixed(2),
    }))
  );

  const canAddPayment =
    payments.length < usableMethods.length;

  const canSubmit =
    cart.length > 0 &&
    total > 0 &&
    cart.every((row) => Number(row.unitPrice) >= 0 && Number(row.discountPercent) >= 0 && Number(row.discountPercent) <= 100) &&
    displayedPayments.every((row) => Number(row.amount) >= 0 && Number.isFinite(Number(row.amount))) &&
    !duplicatePaymentMethod &&
    overpayment === 0 &&
    (saleType === "retail"
      ? remaining === 0 &&
        validPayments.length > 0
      : Boolean(customerId));


  // ჩეკის ჯამები: რამდენი ცალია და რამდენი დააკლდა ფასდაკლებით.
  const unitCount = cart.reduce((sum, row) => sum + row.quantity, 0);
  const grossTotal = round2(
    cart.reduce(
      (sum, row) => sum + round2(Number(row.unitPrice) * row.quantity),
      0
    )
  );
  const discountTotal = round2(Math.max(0, grossTotal - total));
  const gel = (value: number) => value.toFixed(2);
  const qty = (value: number) => String(Number(value.toFixed(3)));

  const catalogLocked = saleType === "wholesale" && !customerId;

  return (
    <div className="till">
      <section className="till-catalog" aria-labelledby="till-catalog-title">
        <div className="till-bar">
          <div
            className="till-segment"
            role="group"
            aria-label="გაყიდვის ტიპი"
          >
            <button
              type="button"
              aria-pressed={saleType === "retail"}
              onClick={() => changeSaleType("retail")}
            >
              საცალო
            </button>
            <button
              type="button"
              aria-pressed={saleType === "wholesale"}
              onClick={() => changeSaleType("wholesale")}
            >
              საბითუმო
            </button>
          </div>

          {saleType === "wholesale" && (
            <label className="till-field till-customer">
              <span>ბიზნეს კლიენტი</span>
              <select
                value={customerId}
                onChange={(event) => changeCustomer(event.target.value)}
              >
                <option value="">აირჩიე კლიენტი</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                    {customer.taxCode ? ` — ${customer.taxCode}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {saleType === "wholesale" && pricesStatus === "loading" && (
          <p className="till-note" role="status">
            {selectedCustomer?.name ?? "კლიენტის"} ფასები იტვირთება…
          </p>
        )}

        {saleType === "wholesale" && pricesStatus === "error" && (
          <p className="till-alert" role="alert">
            კლიენტის ფასები ვერ ჩაიტვირთა.
            <button
              type="button"
              className="till-link"
              onClick={() => selectCustomerPrices(customerId)}
            >
              ხელახლა ცდა
            </button>
          </p>
        )}

        <h2 id="till-catalog-title" className="till-visually-hidden">
          პროდუქტის დამატება
        </h2>

        {catalogLocked ? (
          <div className="till-empty till-empty-catalog">
            <strong>ჯერ აირჩიე ბიზნეს კლიენტი</strong>
            <span>
              საბითუმოზე ჩანს მხოლოდ ის პროდუქტები, რომლებზეც კლიენტს
              ინდივიდუალური ფასი აქვს.
            </span>
          </div>
        ) : (
          <>
            <label className="till-search">
              <span className="till-visually-hidden">
                ძებნა სახელით ან SKU-ით
              </span>
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                type="search"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                onKeyDown={onSearchKeyDown}
                autoFocus
                placeholder="სახელი, SKU ან დაასკანერეთ ბარკოდი"
                autoComplete="off"
              />
            </label>

            <p className="till-count">
              {search.trim()
                ? results.length >= 30
                  ? "ნაჩვენებია პირველი 30 შედეგი"
                  : `ნაპოვნია ${results.length}`
                : saleType === "wholesale"
                  ? `${selectedCustomer?.name ?? "კლიენტის"} ფასით: ${availableItems.length} პროდუქტი`
                  : `${availableItems.length} პროდუქტი · ნაჩვენებია ${Math.min(30, availableItems.length)}`}
            </p>

            <div className="till-tiles">
              {results.map((item) => {
                const stockState =
                  item.stock == null
                    ? null
                    : item.stock <= 0
                      ? "out"
                      : item.stock <= 3
                        ? "low"
                        : "ok";
                const inCart = cart.find(
                  (row) => row.kind === item.kind && row.id === item.id
                );

                return (
                  <button
                    type="button"
                    key={`${item.kind}-${item.id}`}
                    className="till-tile"
                    data-in-cart={inCart ? "true" : undefined}
                    onClick={() => addItem(item)}
                  >
                    <span className="till-tile-photo">
                      {item.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.imageUrl}
                          alt=""
                          loading="lazy"
                          width={160}
                          height={160}
                        />
                      ) : (
                        <span className="till-tile-initial" aria-hidden="true">
                          {item.name.trim().charAt(0)}
                        </span>
                      )}
                      {inCart && (
                        <span className="till-tile-qty">
                          {qty(inCart.quantity)}
                          <span className="till-visually-hidden"> კალათაში</span>
                        </span>
                      )}
                    </span>
                    <span className="till-tile-name">{item.name}</span>
                    {item.variantName && (
                      <span className="till-tile-variant">{item.variantName}</span>
                    )}
                    <span className="till-tile-foot">
                      <span className="till-tile-price">
                        {gel(item.price)}
                        <small> ₾</small>
                      </span>
                      {stockState && (
                        <span className={`till-stock till-stock-${stockState}`}>
                          {stockState === "out"
                            ? "არ არის"
                            : `${qty(item.stock as number)} ც.`}
                        </span>
                      )}
                    </span>
                    {item.sku && <span className="till-tile-sku">{item.sku}</span>}
                  </button>
                );
              })}

              {!results.length && (
                <p className="till-empty till-empty-row">
                  {saleType === "wholesale"
                    ? "ამ კლიენტისთვის შესაბამისი საბითუმო ფასი ვერ მოიძებნა."
                    : search.trim()
                      ? `„${search.trim()}“ ვერ მოიძებნა.`
                      : "პროდუქტი ვერ მოიძებნა."}
                </p>
              )}
            </div>
          </>
        )}

        {cart.length > 0 && (
          <a href="#till-receipt" className="till-jump">
            <span>ჩეკი · {qty(unitCount)} ც.</span>
            <strong>{gel(total)} ₾</strong>
          </a>
        )}
      </section>

      <section
        id="till-receipt"
        className="till-receipt"
        aria-labelledby="till-receipt-title"
      >
        <header className="till-receipt-head">
          <h2 id="till-receipt-title">ჩეკი</h2>
          <span>
            {cart.length
              ? `${cart.length} პოზიცია · ${qty(unitCount)} ც.`
              : saleType === "wholesale"
                ? selectedCustomer?.name ?? "საბითუმო"
                : "საცალო"}
          </span>
        </header>

        {!cart.length ? (
          <div className="till-empty till-empty-cart">
            <strong>კალათა ცარიელია</strong>
            <span>დააჭირეთ პროდუქტს ან დაასკანერეთ ბარკოდი.</span>
          </div>
        ) : (
          <ul className="till-lines">
            {cart.map((row, index) => {
              const finalUnitPrice = round2(
                Number(row.unitPrice) *
                  (1 - Number(row.discountPercent) / 100)
              );
              const lineTotal = round2(finalUnitPrice * row.quantity);
              const discounted = Number(row.discountPercent) > 0;

              return (
                <li key={`${row.kind}-${row.id}`} className="till-line">
                  <div className="till-line-top">
                    <div className="till-line-name">
                      <strong>{row.name}</strong>
                      {(row.variantName || row.sku) && (
                        <span>
                          {[row.variantName, row.sku].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </div>
                    <div className="till-line-total">
                      <span>
                        {gel(lineTotal)}
                        <small> ₾</small>
                      </span>
                      {discounted && (
                        <s>{gel(round2(Number(row.unitPrice) * row.quantity))}</s>
                      )}
                    </div>
                    <button
                      type="button"
                      className="till-icon"
                      aria-label={`${row.name} — წაშლა`}
                      title="წაშლა"
                      onClick={() => removeItem(index)}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="16"
                        height="16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        aria-hidden="true"
                      >
                        <path d="M6 6l12 12M18 6 6 18" />
                      </svg>
                    </button>
                  </div>

                  <div className="till-line-controls">
                    <div className="till-stepper" role="group" aria-label="რაოდენობა">
                      <button
                        type="button"
                        aria-label="ერთით ნაკლები"
                        onClick={() => changeQuantity(index, -1)}
                      >
                        −
                      </button>
                      <input
                        type="number"
                        min="0.001"
                        step="1"
                        aria-label="რაოდენობა"
                        value={row.quantity}
                        onChange={(event) =>
                          updateItem(index, "quantity", Number(event.target.value))
                        }
                      />
                      <button
                        type="button"
                        aria-label="ერთით მეტი"
                        onClick={() => changeQuantity(index, 1)}
                      >
                        +
                      </button>
                    </div>

                    <label className="till-mini">
                      <span>ფასი, ₾</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        onFocus={(event) => {
                          if (Number(event.currentTarget.value) === 0)
                            event.currentTarget.select();
                        }}
                        value={row.unitPrice}
                        onChange={(event) =>
                          updateItem(index, "unitPrice", event.target.value)
                        }
                      />
                    </label>

                    <label className="till-mini">
                      <span>ფასდაკლება, %</span>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        placeholder="0"
                        onFocus={(event) => {
                          if (Number(event.currentTarget.value) === 0)
                            event.currentTarget.select();
                        }}
                        value={row.discountPercent}
                        onChange={(event) =>
                          updateItem(index, "discountPercent", event.target.value)
                        }
                      />
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <dl className="till-totals">
          {discountTotal > 0 && (
            <>
              <div>
                <dt>ფასდაკლებამდე</dt>
                <dd>{gel(grossTotal)} ₾</dd>
              </div>
              <div>
                <dt>ფასდაკლება</dt>
                <dd>−{gel(discountTotal)} ₾</dd>
              </div>
            </>
          )}
          <div className="till-due" data-zero={total === 0 ? "true" : undefined}>
            <dt>გადასახდელი</dt>
            <dd>
              {gel(total)}
              <small> ₾</small>
            </dd>
          </div>
        </dl>

        <div className="till-pay">
          <h3>გადახდა</h3>

          {displayedPayments.map((payment) => (
            <div key={payment.id} className="till-pay-row">
              <label className="till-field">
                <span className="till-visually-hidden">გადახდის მეთოდი</span>
                <select
                  value={payment.method}
                  onChange={(event) =>
                    updatePayment(payment.id, "method", event.target.value)
                  }
                >
                  <option value="">აირჩიე მეთოდი</option>
                  {usableMethods.map((method) => (
                    <option key={method.code} value={method.code}>
                      {method.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="till-field till-amount">
                <span className="till-visually-hidden">თანხა</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  onFocus={(event) => {
                    if (Number(event.currentTarget.value) === 0)
                      event.currentTarget.select();
                  }}
                  value={payment.amount ?? ""}
                  onChange={(event) =>
                    updatePayment(payment.id, "amount", event.target.value)
                  }
                />
                <i aria-hidden="true">₾</i>
              </label>

              {payments.length > 1 ? (
                <button
                  type="button"
                  className="till-icon"
                  aria-label="გადახდის წაშლა"
                  title="წაშლა"
                  onClick={() => removePayment(payment.id)}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              ) : (
                <span aria-hidden="true" />
              )}
            </div>
          ))}

          {canAddPayment && (
            <button type="button" className="till-link" onClick={addPayment}>
              + გადახდის გაყოფა
            </button>
          )}

          {duplicatePaymentMethod && (
            <p className="till-alert" role="alert">
              ერთი და იგივე გადახდის მეთოდი ორჯერ არის არჩეული.
            </p>
          )}

          {overpayment > 0 && (
            <p className="till-alert" role="alert">
              გადახდილი თანხა ჯამს {gel(overpayment)} ₾-ით აღემატება.
            </p>
          )}

          <dl className="till-totals till-balance">
            <div>
              <dt>გადახდილია</dt>
              <dd>{gel(paidTotal)} ₾</dd>
            </div>
            {deferredTotal > 0 && (
              <div>
                <dt>მოგვიანებით</dt>
                <dd>{gel(deferredTotal)} ₾</dd>
              </div>
            )}
            <div data-zero={remaining === 0 ? "true" : undefined}>
              <dt>{saleType === "wholesale" ? "დავალიანება" : "დარჩენილია"}</dt>
              <dd>{gel(remaining)} ₾</dd>
            </div>
          </dl>

          {saleType === "retail" && remaining > 0 && total > 0 && (
            <p className="till-note">
              საცალო გაყიდვა სრული გადახდით სრულდება.
            </p>
          )}
        </div>

        <div className="till-extra">
          <label className="till-field">
            <span>Tracking კოდი</span>
            <input
              value={trackingCode}
              onChange={(event) => setTrackingCode(event.target.value)}
              maxLength={200}
              placeholder="არასავალდებულო"
            />
          </label>

          {canBackdate && today && (
            <label className="till-field">
              <span>გაყიდვის თარიღი</span>
              <input
                type="date"
                value={saleDate}
                max={today}
                onChange={(event) => setSaleDate(event.target.value)}
                required
              />
            </label>
          )}
        </div>

        {canBackdate && today && saleDate !== today && (
          <p className="till-note">
            გაყიდვა ჩაიწერება არჩეული თარიღით (12:00 საათზე), ხოლო რეალური
            დაფიქსირების დრო ქვითარზე შეინახება.
          </p>
        )}

        <form action={completeSale} className="till-submit">
          <input type="hidden" name="request_id" value={requestId} />
          <input type="hidden" name="session_id" value={sessionId} />
          <input type="hidden" name="sale_type" value={saleType} />
          <input type="hidden" name="customer_id" value={customerId} />
          <input type="hidden" name="items" value={payload} />
          <input type="hidden" name="payments" value={paymentPayload} />
          <input type="hidden" name="tracking_code" value={trackingCode} />
          <input
            type="hidden"
            name="sale_date"
            value={canBackdate && saleDate !== today ? saleDate : ""}
          />

          <SaleSubmit disabled={!canSubmit}>
            <span>
              {saleType === "retail"
                ? "გაყიდვის დასრულება"
                : "საბითუმო გაყიდვის დასრულება"}
            </span>
            <span className="till-submit-sum">{gel(total)} ₾</span>
          </SaleSubmit>
        </form>
      </section>
    </div>
  );
}
