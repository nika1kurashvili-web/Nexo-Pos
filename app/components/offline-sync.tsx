"use client";

import { useCallback, useEffect, useState } from "react";
import { QUEUE_EVENT, readQueue, removeFromQueue, syncQueue, type QueuedSale } from "@/lib/pos/offline-queue";

const SHELL = "/sales/new";
const MARKER = "till-catalog-title";

// „ახალი გაყიდვის“ გვერდს და მისი სკრიპტების ფაილებს ვინახავთ, რომ ინტერნეტის გარეშეც გაიხსნას.
async function refreshShell() {
  if (!("caches" in window) || !navigator.onLine) return;
  try {
    const statics = await caches.open("nexo-static-v1");
    const urls = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(`${location.origin}/_next/static/`));
    await Promise.all(urls.map((url) => statics.match(url).then((hit) => (hit ? undefined : statics.add(url).catch(() => undefined)))));

    const response = await fetch(SHELL, { credentials: "same-origin", headers: { Accept: "text/html" } });
    if (!response.ok || response.redirected) return;
    const html = await response.text();
    if (!html.includes(MARKER)) return; // სალარო დახურულია, ამ გვერდს არ ვინახავთ
    const pages = await caches.open("nexo-pages-v1");
    await pages.put(SHELL, new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  } catch {
    // ქსელი გაითიშა, ძველი შენახული ვერსია რჩება
  }
}

const gel = (value: number) =>
  `${value.toLocaleString("ka-GE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₾`;

export default function OfflineSync() {
  const [queue, setQueue] = useState<QueuedSale[]>([]);
  const [online, setOnline] = useState(true);
  const [open, setOpen] = useState(false);

  const reload = useCallback(() => setQueue(readQueue()), []);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    const goOnline = () => {
      setOnline(true);
      void syncQueue();
      void refreshShell();
    };
    const goOffline = () => setOnline(false);
    const onQueue = () => {
      reload();
      if (navigator.onLine) void syncQueue();
    };

    reload();
    setOnline(navigator.onLine);
    void syncQueue();
    const first = window.setTimeout(() => void refreshShell(), 3000);
    const syncTimer = window.setInterval(() => void syncQueue(), 30000);
    const shellTimer = window.setInterval(() => void refreshShell(), 10 * 60 * 1000);

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    window.addEventListener(QUEUE_EVENT, onQueue);
    window.addEventListener("storage", reload);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(syncTimer);
      window.clearInterval(shellTimer);
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener(QUEUE_EVENT, onQueue);
      window.removeEventListener("storage", reload);
    };
  }, [reload]);

  if (online && queue.length === 0) return null;

  const pending = queue.filter((item) => item.status === "pending").length;
  const failed = queue.length - pending;

  return (
    <div className="offline-box" role="status">
      {!online && <p className="offline-pill">ოფლაინ რეჟიმი — გაყიდვები კომპიუტერში ინახება</p>}
      {queue.length > 0 && (
        <button type="button" className="offline-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          რიგშია: {pending}
          {failed > 0 && <strong> · შეცდომა: {failed}</strong>}
        </button>
      )}
      {open && queue.length > 0 && (
        <ul className="offline-list">
          {queue.map((sale) => (
            <li key={sale.id} className={sale.status === "error" ? "is-error" : undefined}>
              <span>
                {new Date(sale.createdAt).toLocaleTimeString("ka-GE", { hour: "2-digit", minute: "2-digit" })} · {gel(sale.total)}
              </span>
              {sale.status === "pending" ? (
                <em>ელოდება გაგზავნას</em>
              ) : (
                <>
                  <em>ვერ გაიგზავნა{sale.error ? `: ${sale.error}` : ""}</em>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm("ამ გაყიდვის წაშლა რიგიდან? ბაზაში ის არ ჩაწერილა.")) removeFromQueue(sale.id);
                    }}
                  >
                    წაშლა
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
