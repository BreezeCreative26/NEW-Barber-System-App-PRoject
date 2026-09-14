import { Hono } from "hono";
import { serveStatic } from "hono/cloudflare-workers";

const app = new Hono();
app.use("/static/*", serveStatic({ root: "./public" }));
app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    mode: "design-preview",
    livePayments: false,
    persistence: false,
  }),
);
app.get("/", (c) => c.redirect("/preview/admin"));
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
