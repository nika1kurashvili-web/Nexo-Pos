// ოფლაინ გაყიდვების რიგი (ბრაუზერის localStorage-ში) და გაგზავნა სერვერზე.
// იგივე request_id ორჯერ გაგზავნა უსაფრთხოა: ბაზა დუბლს არ ქმნის.

export type SaleFields = Record<string, string>;

export type QueuedSale = {
  id: string;
  createdAt: number;
  total: number;
  fields: SaleFields;
  status: "pending" | "error";
  error?: string;
};

export type SendOutcome =
  | { kind: "ok" }
  | { kind: "network" }
  | { kind: "auth" }
  | { kind: "rejected"; error: string; detail?: string };

const KEY = "nexo.offlineSales.v1";
export const QUEUE_EVENT = "nexo-offline-queue";

export function readQueue(): QueuedSale[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as QueuedSale[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedSale[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(queue));
  } catch {
    // ბრაუზერმა შენახვა არ დაგვრთო; რიგი მხოლოდ ამ სესიაში ვერ შეინახება.
  }
  window.dispatchEvent(new Event(QUEUE_EVENT));
}

export function enqueue(sale: QueuedSale) {
  const queue = readQueue();
  if (!queue.some((item) => item.id === sale.id)) queue.push(sale);
  writeQueue(queue);
}

export function removeFromQueue(id: string) {
  writeQueue(readQueue().filter((item) => item.id !== id));
}

function markError(id: string, error: string) {
  writeQueue(readQueue().map((item) => (item.id === id ? { ...item, status: "error", error } : item)));
}

export async function sendSale(fields: SaleFields): Promise<SendOutcome> {
  try {
    const response = await fetch("/api/sales", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
      credentials: "same-origin",
      signal: AbortSignal.timeout(20000),
    });
    // სესია ამოიწურა: middleware შესვლის გვერდზე გადაგვიყვანს.
    if (response.redirected || !(response.headers.get("content-type") ?? "").includes("application/json")) {
      return { kind: "auth" };
    }
    const data = (await response.json()) as { ok?: boolean; error?: string; detail?: string };
    if (data.ok) return { kind: "ok" };
    return { kind: "rejected", error: data.error ?? "failed", detail: data.detail };
  } catch {
    return { kind: "network" };
  }
}

let running = false;

export async function syncQueue(): Promise<void> {
  if (running || typeof window === "undefined") return;
  running = true;
  try {
    for (const sale of readQueue().filter((item) => item.status === "pending")) {
      const outcome = await sendSale(sale.fields);
      if (outcome.kind === "ok") removeFromQueue(sale.id);
      else if (outcome.kind === "rejected") markError(sale.id, outcome.detail ?? outcome.error);
      else break; // ინტერნეტი ან სესია არ არის, მოგვიანებით ვცდით
    }
  } finally {
    running = false;
  }
}
