"use client";

import { useMemo, useState } from "react";
import { completeSale } from "@/app/(pos)/actions";

type CatalogItem = {
  kind: "product" | "variant";
  id: string;
  productId: string;
  name: string;
  variantName: string | null;
  sku: string | null;
  price: number;
};

type PaymentMethod = {
  code: string;
  name: string;
};

type Customer = {
  id: string;
  name: string;
  taxCode: string | null;
};

type CustomerPrice = {
  customerId: string;
  productId: string | null;
  variantId: string | null;
  price: number;
};

type CartItem = CatalogItem & {
  quantity: number;
  unitPrice: number;
  discountPercent: number;
};

type PaymentRow = {
  id: number;
  method: string;
  amount: number;
};

type Props = {
  items: CatalogItem[];
  paymentMethods: PaymentMethod[];
  sessionId: string;
  requestId: string;
  customers: Customer[];
  customerPrices: CustomerPrice[];
};

const round2 = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

export default function SaleTerminal({
  items,
  paymentMethods,
  sessionId,
  requestId,
  customers,
  customerPrices,
}: Props) {
  const [saleType, setSaleType] =
    useState<"retail" | "wholesale">("retail");

  const [customerId, setCustomerId] = useState("");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [trackingCode, setTrackingCode] = useState("");

  const [payments, setPayments] = useState<PaymentRow[]>([
    {
      id: 1,
      method: paymentMethods[0]?.code ?? "",
      amount: 0,
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
        method: paymentMethods[0]?.code ?? "",
        amount: 0,
      },
    ]);
    setNextPaymentId(2);
  }

  function wholesalePrice(item: CatalogItem) {
    if (!customerId) return null;

    const found = customerPrices.find((price) => {
      if (price.customerId !== customerId) {
        return false;
      }

      if (item.kind === "variant") {
        return price.variantId === item.id;
      }

      return (
        price.productId === item.id &&
        price.variantId === null
      );
    });

    return found ? found.price : null;
  }

  const availableItems = useMemo(() => {
    if (saleType === "retail") {
      return items;
    }

    if (!customerId) {
      return [];
    }

    return items
      .map((item) => {
        const price = customerPrices.find((row) => {
          if (row.customerId !== customerId) {
            return false;
          }

          if (item.kind === "variant") {
            return row.variantId === item.id;
          }

          return (
            row.productId === item.id &&
            row.variantId === null
          );
        });

        if (!price) {
          return null;
        }

        return {
          ...item,
          price: price.price,
        };
      })
      .filter(
        (item): item is CatalogItem => item !== null
      );
  }, [
    items,
    saleType,
    customerId,
    customerPrices,
  ]);

  const results = useMemo(() => {
    const query = search.trim().toLowerCase();

    if (!query) {
      return availableItems.slice(0, 30);
    }

    return availableItems
      .filter((item) => {
        const searchable = [
          item.name,
          item.variantName ?? "",
          item.sku ?? "",
        ]
          .join(" ")
          .toLowerCase();

        return searchable.includes(query);
      })
      .slice(0, 30);
  }, [availableItems, search]);

  function changeSaleType(
    type: "retail" | "wholesale"
  ) {
    setSaleType(type);
    setCart([]);
    setSearch("");
    resetPayments();

    if (type === "retail") {
      setCustomerId("");
    }
  }

  function changeCustomer(id: string) {
    setCustomerId(id);
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
          unitPrice: price,
          discountPercent: 0,
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
    value: number
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
              value || 0.001
            ),
          };
        }

        if (field === "unitPrice") {
          return {
            ...row,
            unitPrice: Math.max(0, value || 0),
          };
        }

        return {
          ...row,
          discountPercent: Math.min(
            100,
            Math.max(0, value || 0)
          ),
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
        row.unitPrice *
          (1 - row.discountPercent / 100)
      );

      const lineTotal = round2(
        finalUnitPrice * row.quantity
      );

      return sum + lineTotal;
    }, 0);

    return round2(value);
  }, [cart]);

  const paidTotal = round2(
    payments.reduce(
      (sum, payment) =>
        sum + Math.max(0, payment.amount || 0),
      0
    )
  );

  const remaining = round2(
    Math.max(0, total - paidTotal)
  );

  const overpayment = round2(
    Math.max(0, paidTotal - total)
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
          amount: Math.max(
            0,
            Number(value) || 0
          ),
        };
      })
    );
  }

  function addPayment() {
    const usedMethods = new Set(
      payments.map((payment) => payment.method)
    );

    const nextMethod =
      paymentMethods.find(
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
        amount: remaining,
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

  const validPayments = payments.filter(
    (payment) =>
      payment.method &&
      payment.amount > 0
  );

  const payload = JSON.stringify(
    cart.map((row) => ({
      kind: row.kind,
      target: row.id,
      quantity: row.quantity.toFixed(3),
      unit_price: row.unitPrice.toFixed(2),
      discount_percent:
        row.discountPercent.toFixed(2),
    }))
  );

  const paymentPayload = JSON.stringify(
    validPayments.map((payment) => ({
      method: payment.method,
      amount: round2(payment.amount).toFixed(2),
    }))
  );

  const canAddPayment =
    payments.length < paymentMethods.length &&
    remaining > 0;

  const canSubmit =
    cart.length > 0 &&
    total > 0 &&
    !duplicatePaymentMethod &&
    overpayment === 0 &&
    (saleType === "retail"
      ? remaining === 0 &&
        validPayments.length > 0
      : Boolean(customerId));

  return (
    <div className="sale-terminal">
      <section className="panel">
        <h2>გაყიდვის ტიპი</h2>

        <div className="sale-type-selector">
          <button
            type="button"
            className={
              saleType === "retail"
                ? "button"
                : "button secondary"
            }
            onClick={() =>
              changeSaleType("retail")
            }
          >
            საცალო
          </button>

          <button
            type="button"
            className={
              saleType === "wholesale"
                ? "button"
                : "button secondary"
            }
            onClick={() =>
              changeSaleType("wholesale")
            }
          >
            საბითუმო
          </button>
        </div>

        {saleType === "wholesale" && (
          <>
            <label>
              ბიზნეს კლიენტი
              <select
                value={customerId}
                onChange={(event) =>
                  changeCustomer(
                    event.target.value
                  )
                }
              >
                <option value="">
                  აირჩიე კლიენტი
                </option>

                {customers.map((customer) => (
                  <option
                    key={customer.id}
                    value={customer.id}
                  >
                    {customer.name}
                    {customer.taxCode
                      ? ` — ${customer.taxCode}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>

            {selectedCustomer && (
              <p>
                არჩეული კლიენტი:{" "}
                <strong>
                  {selectedCustomer.name}
                </strong>
              </p>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h2>პროდუქტის დამატება</h2>

        {saleType === "wholesale" &&
        !customerId ? (
          <p>
            ჯერ აირჩიე ბიზნეს კლიენტი.
          </p>
        ) : (
          <>
            <label>
              ძებნა სახელით ან SKU-ით
              <input
                type="search"
                value={search}
                onChange={(event) =>
                  setSearch(event.target.value)
                }
                placeholder="მაგ: ტელევიზორი ან SKU"
                autoComplete="off"
              />
            </label>

            {saleType === "wholesale" && (
              <p>
                ნაჩვენებია მხოლოდ ის პროდუქტები,
                რომლებზეც ამ კლიენტს
                ინდივიდუალური საბითუმო ფასი აქვს.
              </p>
            )}

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>პროდუქტი</th>
                    <th>SKU</th>
                    <th>ფასი</th>
                    <th></th>
                  </tr>
                </thead>

                <tbody>
                  {results.map((item) => (
                    <tr
                      key={`${item.kind}-${item.id}`}
                    >
                      <td>
                        <strong>
                          {item.name}
                        </strong>

                        {item.variantName && (
                          <div>
                            {item.variantName}
                          </div>
                        )}
                      </td>

                      <td>
                        {item.sku ?? "—"}
                      </td>

                      <td>
                        {item.price.toFixed(2)} ₾
                      </td>

                      <td>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() =>
                            addItem(item)
                          }
                        >
                          დამატება
                        </button>
                      </td>
                    </tr>
                  ))}

                  {!results.length && (
                    <tr>
                      <td colSpan={4}>
                        {saleType ===
                        "wholesale"
                          ? "ამ კლიენტისთვის შესაბამისი საბითუმო ფასი ვერ მოიძებნა."
                          : "პროდუქტი ვერ მოიძებნა."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2>კალათა</h2>

        {!cart.length ? (
          <p>კალათა ცარიელია.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>პროდუქტი</th>
                  <th>რაოდენობა</th>
                  <th>ფასი</th>
                  <th>ფასდაკლება %</th>
                  <th>ჯამი</th>
                  <th></th>
                </tr>
              </thead>

              <tbody>
                {cart.map((row, index) => {
                  const finalUnitPrice = round2(
                    row.unitPrice *
                      (1 -
                        row.discountPercent /
                          100)
                  );

                  const lineTotal = round2(
                    finalUnitPrice *
                      row.quantity
                  );

                  return (
                    <tr
                      key={`${row.kind}-${row.id}`}
                    >
                      <td>
                        <strong>
                          {row.name}
                        </strong>

                        {row.variantName && (
                          <div>
                            {row.variantName}
                          </div>
                        )}
                      </td>

                      <td>
                        <div className="quantity-control">
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() =>
                              changeQuantity(
                                index,
                                -1
                              )
                            }
                          >
                            −
                          </button>

                          <input
                            type="number"
                            min="0.001"
                            step="1"
                            value={row.quantity}
                            onChange={(event) =>
                              updateItem(
                                index,
                                "quantity",
                                Number(
                                  event.target
                                    .value
                                )
                              )
                            }
                          />

                          <button
                            type="button"
                            className="button secondary"
                            onClick={() =>
                              changeQuantity(
                                index,
                                1
                              )
                            }
                          >
                            +
                          </button>
                        </div>
                      </td>

                      <td>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={row.unitPrice}
                          onChange={(event) =>
                            updateItem(
                              index,
                              "unitPrice",
                              Number(
                                event.target.value
                              )
                            )
                          }
                        />
                      </td>

                      <td>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={
                            row.discountPercent
                          }
                          onChange={(event) =>
                            updateItem(
                              index,
                              "discountPercent",
                              Number(
                                event.target.value
                              )
                            )
                          }
                        />
                      </td>

                      <td>
                        {lineTotal.toFixed(2)} ₾
                      </td>

                      <td>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() =>
                            removeItem(index)
                          }
                        >
                          წაშლა
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div>
          <strong>
            სულ: {total.toFixed(2)} ₾
          </strong>
        </div>

        <hr />

        <h2>გადახდა</h2>

        <div className="split-payments">
          {payments.map((payment) => (
            <div
              key={payment.id}
              className="split-payment-row"
            >
              <label>
                გადახდის მეთოდი
                <select
                  value={payment.method}
                  onChange={(event) =>
                    updatePayment(
                      payment.id,
                      "method",
                      event.target.value
                    )
                  }
                >
                  <option value="">
                    აირჩიე
                  </option>

                  {paymentMethods.map(
                    (method) => (
                      <option
                        key={method.code}
                        value={method.code}
                      >
                        {method.name}
                      </option>
                    )
                  )}
                </select>
              </label>

              <label>
                თანხა
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={payment.amount}
                  onChange={(event) =>
                    updatePayment(
                      payment.id,
                      "amount",
                      event.target.value
                    )
                  }
                />
              </label>

              {payments.length > 1 && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() =>
                    removePayment(payment.id)
                  }
                >
                  წაშლა
                </button>
              )}
            </div>
          ))}

          {canAddPayment && (
            <button
              type="button"
              className="button secondary"
              onClick={addPayment}
            >
              + გადახდის დამატება
            </button>
          )}
        </div>

        {duplicatePaymentMethod && (
          <div className="notice error">
            ერთი და იგივე გადახდის მეთოდი
            ორჯერ არის არჩეული.
          </div>
        )}

        {overpayment > 0 && (
          <div className="notice error">
            გადახდილი თანხა გაყიდვის ჯამს
            {` ${overpayment.toFixed(2)} ₾-ით `}
            აღემატება.
          </div>
        )}

        <div className="sale-summary">
          <p>
            სულ:{" "}
            <strong>
              {total.toFixed(2)} ₾
            </strong>
          </p>

          <p>
            გადახდილია:{" "}
            <strong>
              {paidTotal.toFixed(2)} ₾
            </strong>
          </p>

          <p>
            {saleType === "wholesale"
              ? "დავალიანება:"
              : "დარჩენილია:"}{" "}
            <strong>
              {remaining.toFixed(2)} ₾
            </strong>
          </p>
        </div>

        {saleType === "retail" &&
          remaining > 0 && (
            <p className="muted">
              საცალო გაყიდვის დასასრულებლად
              სრული თანხა უნდა იყოს
              გადახდილი.
            </p>
          )}

        <label>
          Tracking კოდი
          <input
            value={trackingCode}
            onChange={(event) =>
              setTrackingCode(
                event.target.value
              )
            }
            maxLength={200}
            placeholder="არასავალდებულო"
          />
        </label>

        <form action={completeSale}>
          <input
            type="hidden"
            name="request_id"
            value={requestId}
          />

          <input
            type="hidden"
            name="session_id"
            value={sessionId}
          />

          <input
            type="hidden"
            name="sale_type"
            value={saleType}
          />

          <input
            type="hidden"
            name="customer_id"
            value={customerId}
          />

          <input
            type="hidden"
            name="items"
            value={payload}
          />

          <input
            type="hidden"
            name="payments"
            value={paymentPayload}
          />

          <input
            type="hidden"
            name="tracking_code"
            value={trackingCode}
          />

          <button
            type="submit"
            className="button"
            disabled={!canSubmit}
          >
            {saleType === "retail"
              ? `გაყიდვის დასრულება — ${total.toFixed(
                  2
                )} ₾`
              : `საბითუმო გაყიდვის დასრულება — ${total.toFixed(
                  2
                )} ₾`}
          </button>
        </form>
      </section>
    </div>
  );
}