import { Hono } from "hono";
import { serveStatic } from "hono/cloudflare-workers";

import sandbox from "./server/sandbox";
import pub from "./server/public";
import customerPlan from "../docs/CUSTOMER-PLAN.md?raw";
import type { D1Database } from "@cloudflare/workers-types";
const app = new Hono<{ Bindings: { DB: D1Database; APP_MODE?: string } }>();
app.route("/api/sandbox", sandbox);
app.route("/api/public", pub);
app.use("/static/*", serveStatic({ root: "./public" }));
app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    mode: c.env?.APP_MODE === "sandbox" ? "local-sandbox" : "static",
    livePayments: false,
    persistence: c.env?.APP_MODE === "sandbox" && !!c.env?.DB,
  }),
);
// Diagnostic: shows what the worker sees so proxy/origin problems can be verified.
app.all("/api/origin-check", (c) => {
  const url = new URL(c.req.url);
  const pick = (h: string) => c.req.header(h) ?? null;
  return c.json({
    method: c.req.method,
    request_origin: url.origin,
    host: pick("host"),
    origin_header: pick("origin"),
    referer: pick("referer"),
    x_forwarded_host: pick("x-forwarded-host"),
    x_forwarded_proto: pick("x-forwarded-proto"),
    sec_fetch_site: pick("sec-fetch-site"),
  });
});
app.get("/", (c) => c.redirect("/workspace"));
app.get("/workspace", (c) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
  );
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex,nofollow"/><title>OLLO — Local workspace</title><link rel="icon" href="/static/favicon.svg"/><link rel="stylesheet" href="/static/style.css"/><link rel="stylesheet" href="/static/design.css"/><link rel="stylesheet" href="/static/app.css"/></head><body><div id="root"><p class="boot-message">Opening local workspace…</p></div><noscript>JavaScript is required. No live services are connected.</noscript><script type="module" src="/static/app.js"></script></body></html>`,
  );
});
const publicPage = (title: string, description: string) =>
  `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/><meta name="theme-color" content="#181b2a"/><meta name="robots" content="noindex,nofollow"/><meta name="description" content="${description}"/><title>${title}</title><link rel="icon" href="/static/favicon.svg" type="image/svg+xml"/><link rel="stylesheet" href="/static/style.css"/><link rel="stylesheet" href="/static/design.css"/><link rel="stylesheet" href="/static/app.css"/></head><body><div id="root"><p class="boot-message">Opening online booking…</p></div><noscript>Online booking needs JavaScript. No payment is taken in this local test.</noscript><script type="module" src="/static/app.js"></script></body></html>`;
const secure = (c: { header: (k: string, v: string) => void }) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
  );
};
// Customer-side plan, readable from the admin (Settings → Customer pages → Read the plan).
app.get("/docs/customer-plan", (c) =>
  c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OLLO · Customer plan</title><link rel="stylesheet" href="/static/design.css"><style>body{font-family:var(--font);max-width:80ch;margin:0 auto;padding:32px 20px;color:var(--ink);line-height:1.55}pre{white-space:pre-wrap;font:inherit;font-size:14px}h1{font-size:24px}a{color:var(--accent-dark)}</style></head><body><a href="/workspace">← Back to OLLO</a><h1>Customer side — plan</h1><pre>${customerPlan.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch] as string)}</pre></body></html>`),
);
app.get("/book/:slug", (c) => {
  if (c.env?.APP_MODE !== "sandbox") return c.notFound();
  secure(c);
  return c.html(
    publicPage(
      "Book a visit — OLLO",
      "Book your next visit online. Local test booking; no payment is taken.",
    ),
  );
});
app.get("/manage/:token", (c) => {
  if (c.env?.APP_MODE !== "sandbox") return c.notFound();
  secure(c);
  return c.html(
    publicPage(
      "Your booking — OLLO",
      "View, move or cancel your booking. Local test booking; no payment is taken.",
    ),
  );
});
app.notFound((c) =>
  c.text(
    "Not found. The app lives at /workspace; customers book at /book/<shop> and manage a visit at /manage/<token>.",
    404,
  ),
);
export default app;
