import { Hono } from "hono";
import { serveStatic } from "hono/cloudflare-workers";

import sandbox from "./server/sandbox";
import type { D1Database } from "@cloudflare/workers-types";
const app = new Hono<{ Bindings: { DB: D1Database; APP_MODE?: string } }>();
app.route("/api/sandbox", sandbox);
app.use("/static/*", serveStatic({ root: "./public" }));
app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    mode: c.env?.APP_MODE === "sandbox" ? "local-sandbox" : "design-preview",
    livePayments: false,
    persistence: c.env?.APP_MODE === "sandbox" && !!c.env?.DB,
  }),
);
app.get("/", (c) =>
  c.redirect(c.env?.APP_MODE === "sandbox" ? "/workspace" : "/preview/admin"),
);
app.get("/workspace", (c) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
  );
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex,nofollow"/><title>Barbershop OS — Local workspace</title><link rel="icon" href="/static/favicon.svg"/><link rel="stylesheet" href="/static/style.css"/><link rel="stylesheet" href="/static/app.css"/></head><body><div id="root"><p class="boot-message">Opening local workspace…</p></div><noscript>JavaScript is required. No live services are connected.</noscript><script type="module" src="/static/app.js"></script></body></html>`,
  );
});
app.get("/preview/:surface", (c) => {
  const surface = c.req.param("surface");
  if (!["admin", "book", "barber"].includes(surface)) return c.notFound();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
  );
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/><meta name="theme-color" content="#153d32"/><meta name="robots" content="noindex,nofollow"/><meta name="description" content="Barbershop OS design preview. Explore a considered workspace for better days in the chair."/><title>Barbershop OS — ${surface === "book" ? "Book a visit" : surface === "barber" ? "Your day" : "Shop calendar"}</title><link rel="icon" href="/static/favicon.svg" type="image/svg+xml"/><link rel="stylesheet" href="/static/style.css"/><link rel="stylesheet" href="/static/app.css"/></head><body><div id="root"><p class="boot-message">Opening your workspace…</p></div><noscript>This interactive design preview needs JavaScript. No live booking or payment is available.</noscript><script type="module" src="/static/app.js"></script></body></html>`,
  );
});
app.notFound((c) =>
  c.text(
    "This page is not part of the preview. Visit /preview/admin, /preview/book or /preview/barber.",
    404,
  ),
);
export default app;
