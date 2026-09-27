/* foliyo shop app service worker.
 * Registered by the customer account page with scope "/<slug>/" so each installed shop app is its
 * own PWA. Keeps a small offline shell, shows push notifications, and opens the right page on tap.
 * No API responses are cached: visits must always be live.
 */
const VERSION = "v1";
const SHELL = ["/static/style.css", "/static/design.css", "/static/app.css", "/static/theme-fonts.css", "/static/shop-theme.css", "/static/app.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(`shell-${VERSION}`).then((c) => c.addAll(SHELL).catch(() => null)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== `shell-${VERSION}`).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Static assets: cache-first (they are content-hashed or versioned by deploy). Everything else: network.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/static/") || url.pathname.startsWith("/media/")) {
    event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request).then((res) => { if (res.ok) caches.open(`shell-${VERSION}`).then((c) => c.put(event.request, res.clone())); return res; })));
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Update", body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Your visit";
  const options = {
    body: data.body || "",
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) { client.navigate(url); return client.focus(); }
      }
      return self.clients.openWindow(url);
    }),
  );
});
