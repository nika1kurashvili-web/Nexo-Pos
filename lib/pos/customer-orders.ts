// კლიენტის პირადი შეკვეთების გამოთვლები და თარიღის ფილტრი (სუფთა ლოგიკა, ტესტირებადი).
export type OrderItemLike = { quantity: string | number; unit_price: string | number; unit_cost: string | number | null };
export type OrderLike = {
  order_date: string;
  total: string | number;
  paid: string | number;
  items: OrderItemLike[];
};

export const toCents = (value: string | number) => Math.round(Number(value) * 100);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// from/to ჩათვლით, YYYY-MM-DD. ცარიელი ან არასწორი საზღვარი იგნორირდება.
export function filterOrders<T extends { order_date: string }>(orders: T[], from?: string, to?: string): T[] {
  const lo = from && DATE_RE.test(from) ? from : "";
  const hi = to && DATE_RE.test(to) ? to : "";
  return orders.filter((order) => (!lo || order.order_date >= lo) && (!hi || order.order_date <= hi));
}

export function orderFigures(order: OrderLike) {
  let cost = 0;
  let profit = 0;
  let missing = 0;
  for (const item of order.items) {
    if (item.unit_cost === null || item.unit_cost === undefined) {
      missing += 1;
      continue;
    }
    const sale = Math.round(Number(item.quantity) * Number(item.unit_price) * 100);
    const buy = Math.round(Number(item.quantity) * Number(item.unit_cost) * 100);
    cost += buy;
    profit += sale - buy;
  }
  const total = toCents(order.total);
  const paid = toCents(order.paid);
  return { total, paid, remaining: total - paid, cost, profit, missing };
}

export function sumFigures(orders: OrderLike[]) {
  const sum = { total: 0, paid: 0, remaining: 0, cost: 0, profit: 0, missing: 0 };
  for (const order of orders) {
    const f = orderFigures(order);
    sum.total += f.total;
    sum.paid += f.paid;
    sum.remaining += f.remaining;
    sum.cost += f.cost;
    sum.profit += f.profit;
    sum.missing += f.missing;
  }
  return sum;
}
