/* Nexo POS: ოფლაინ რეჟიმის სერვის-ვორქერი.
 * - /_next/static და /fonts ფაილები ინახება (cache-first),
 * - „ახალი გაყიდვის“ გვერდი ინახება და ინტერნეტის გარეშე იხსნება,
 * - ოფლაინ ნებისმიერი სხვა გვერდი ახალ გაყიდვაზე გადადის. */
const STATIC = "nexo-static-v1";
const PAGES = "nexo-pages-v1";
const SHELL = "/sales/new";
const MARKER = "till-catalog-title";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("nexo-") && key !== STATIC && key !== PAGES) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/fonts/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === "navigate") event.respondWith(navigate(request, url));
});

async function cacheFirst(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

const offlinePage = () =>
  new Response(
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>ოფლაინ</title>" +
      "<body style='font-family:system-ui,sans-serif;padding:2rem;max-width:36rem;margin:auto'>" +
      "<h1>ინტერნეტი არ არის</h1><p>გაყიდვის გვერდი ამ კომპიუტერზე ჯერ არ არის შენახული. " +
      "დაუკავშირდით ინტერნეტს და ერთხელ გახსენით „ახალი გაყიდვა“.</p></body>",
    { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
  );

async function navigate(request, url) {
  const pages = await caches.open(PAGES);
  try {
    const response = await fetch(request);
    if (url.pathname === SHELL && response.ok && !response.redirected) {
      // ვინახავთ მხოლოდ გახსნილი სალაროს გვერდს (სადაც გაყიდვის ტერმინალია).
      response
        .clone()
        .text()
        .then((html) => {
          if (html.includes(MARKER)) {
            return pages.put(SHELL, new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
          }
        })
        .catch(() => {});
    }
    return response;
  } catch {
    const shell = await pages.match(SHELL);
    if (url.pathname === SHELL) return shell || offlinePage();
    if (shell && url.pathname !== "/login") return Response.redirect(SHELL, 302);
    return offlinePage();
  }
}
