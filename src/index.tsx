import { Hono, type Context } from "hono";

import sandbox from "./server/sandbox";
import pub from "./server/public";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Shop } from "./server/domain";
import { headData, shopPageHead, type MediaRow } from "./server/presence";
import { drain, maybeSweep, providerStatus, sweepReminders } from "./server/messaging";
import { report, telemetryStatus } from "./server/telemetry";
import { landingPage } from "./server/landing";
import { getCookie } from "hono/cookie";
import { ACCOUNT_COOKIE } from "./server/accounts";
import { expireHolds, markDepositPaid, stripeStatus, verifyWebhook } from "./server/stripe";
import { afterDepositPaid } from "./server/public";
import { handleConnectEvent, type ConnectEvent } from "./server/payouts";
import { settleByMetadata, type PaymentRequest } from "./server/chair";
import { applyDeliveryReports, applyInbound, waWebhookOk } from "./server/whatsapp";
import type { Database } from "./db/client";
import type { ObjectStore } from "./db/storage";
export type AppBindings = { DB: Database; MEDIA?: ObjectStore; APP_MODE?: string; ALLOWED_ORIGINS?: string; DEMO_ENABLED?: string };
const app = new Hono<{ Bindings: AppBindings; Variables: { shopId: string; actor: string; account: null } }>();
// Lazy sweep: any public/app API request may trigger the reminder + outbox sweep, at most once per
// 5 minutes across the deployment (platform_kv claim). Runs after the response so it never slows
// the request. Vercel Cron hits /api/cron/messages every 5 minutes as the guaranteed path.
app.use("/api/*", async (c, next) => {
  await next();
  if (!c.env?.DB || c.req.path.startsWith("/api/cron")) return;
  const origin = new URL(c.req.url).origin;
  // Fire and forget. On Node (Vercel) the promise runs to completion after the response; on
  // Workers, executionCtx.waitUntil keeps the isolate alive — Hono throws when there is none.
  const job = maybeSweep(c.env.DB, origin).catch(() => null);
  try {
    c.executionCtx.waitUntil(job);
  } catch {
    /* no execution context: Node runtime, promise continues on its own */
  }
});
app.get("/api/cron/messages", async (c) => {
  const secret = process.env.CRON_SECRET;
  if (secret && c.req.header("authorization") !== `Bearer ${secret}`) return c.json({ error: "unauthorised" }, 401);
  const origin = process.env.APP_ORIGIN || new URL(c.req.url).origin;
  const holds = await expireHolds(c.env.DB);
  const reminders = await sweepReminders(c.env.DB, origin);
  const drained = await drain(c.env.DB, 100);
  return c.json({ ok: true, reminders, drained, holds_released: holds.length, providers: providerStatus() });
});
// Stripe webhook: the guaranteed path for "deposit paid" (the customer's return trip is the fast
// path). Signature-verified, idempotent on event id. Always 2xx once verified so Stripe stops retrying.
app.post("/api/stripe/webhook", async (c) => {
  const raw = await c.req.text();
  const v = await verifyWebhook(raw, c.req.header("stripe-signature"));
  if (!v.ok) return c.json({ error: v.reason }, v.reason === "no_secret" ? 503 : 400);
  const evt = JSON.parse(raw) as { id: string; type: string; data: { object: { id: string; payment_status?: string; payment_intent?: string | null; amount_total?: number; metadata?: Record<string, string>; client_reference_id?: string | null } } };
  const seen = await c.env.DB.prepare("INSERT INTO stripe_events(id,type,received_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING").bind(evt.id, evt.type, Date.now()).run();
  if (!seen.meta.changes) return c.json({ ok: true, duplicate: true });
  const o = evt.data.object;
  const shopId = o.metadata?.shop_id, bookingId = o.metadata?.booking_id || o.client_reference_id || "";
  const requestId = o.metadata?.payment_request_id || "";
  if (requestId && (evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded" || evt.type === "payment_intent.succeeded")) {
    // Card at the chair (pay link / reader) — writes the ledger row.
    const pi = evt.type === "payment_intent.succeeded" ? o.id : typeof o.payment_intent === "string" ? o.payment_intent : "";
    if (evt.type !== "payment_intent.succeeded" && o.payment_status !== "paid") return c.json({ ok: true });
    await settleByMetadata(c.env.DB, requestId, pi);
  } else if (evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded") {
    if (shopId && bookingId && o.payment_status === "paid") {
      const changed = await markDepositPaid(c.env.DB, shopId, bookingId, o.amount_total ?? 0, typeof o.payment_intent === "string" ? o.payment_intent : "", o.id);
      if (changed) {
        c.set("shopId", shopId);
        c.set("actor", "stripe");
        await afterDepositPaid(c as never, shopId, bookingId);
      }
    }
  } else if (evt.type === "checkout.session.expired") {
    // Release the hold now rather than waiting for the sweep.
    if (shopId && bookingId) await c.env.DB.prepare("UPDATE bookings SET deposit_hold_until=0 WHERE shop_id=? AND id=? AND deposit_status='PENDING'").bind(shopId, bookingId).run();
    await expireHolds(c.env.DB);
  } else {
    await handleConnectEvent(c.env.DB, evt as ConnectEvent);
  }
  return c.json({ ok: true });
});
app.route("/api/app", sandbox);
// Legacy path kept for one release so old tabs keep working.
app.route("/api/sandbox", sandbox);
app.route("/api/public", pub);
app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    mode: process.env.NODE_ENV === "production" ? "production" : "development",
    livePayments: stripeStatus().provider === "stripe",
    payments: stripeStatus(),
    messaging: providerStatus(),
    telemetry: telemetryStatus(),
    persistence: !!c.env?.DB,
  }),
);
// Browser error reports (from the React boundary / window.onerror). Tiny schema, same-origin only,
// 30 per client per 10 minutes, forwarded to the same sink as server errors.
const clientErrorSchema = (b: unknown) => {
  const o = (b ?? {}) as Record<string, unknown>;
  const str = (k: string, max: number) => (typeof o[k] === "string" ? (o[k] as string).slice(0, max) : undefined);
  const message = str("message", 500);
  if (!message) return null;
  return { message, stack: str("stack", 4000), route: str("route", 200), tags: { ua: str("ua", 200) ?? "", screen: str("screen", 40) ?? "" } };
};
// Infobip WhatsApp webhooks. Delivery reports mark outbox rows delivered/failed; inbound replies
// are stored against the shop that last messaged that number (and STOP/START toggle the opt-out).
// Always 200 so Infobip does not retry a report we could not parse; a shared secret in the URL
// (`?key=`) or the X-Ollo-Webhook header keeps strangers out when one is configured.
app.post("/api/whatsapp/status", async (c) => {
  if (!waWebhookOk(c.req.query("key"), c.req.header("x-ollo-webhook"))) return c.json({ ok: false }, 403);
  const body = await c.req.json().catch(() => null);
  const n = body ? await applyDeliveryReports(c.env.DB, body).catch(() => 0) : 0;
  return c.json({ ok: true, applied: n });
});
app.post("/api/whatsapp/inbound", async (c) => {
  if (!waWebhookOk(c.req.query("key"), c.req.header("x-ollo-webhook"))) return c.json({ ok: false }, 403);
  const body = await c.req.json().catch(() => null);
  const n = body ? await applyInbound(c.env.DB, body).catch(() => 0) : 0;
  return c.json({ ok: true, stored: n });
});
const clientErrorHits = new Map<string, { n: number; until: number }>();
app.post("/api/telemetry/error", async (c) => {
  const origin = new URL(c.req.url).origin;
  const from = c.req.header("origin") ?? "";
  if (from && from !== origin) return c.json({ ok: false }, 403);
  const ip = (c.req.header("x-forwarded-for") || "").split(",")[0].trim() || "anon";
  const now = Date.now();
  const hit = clientErrorHits.get(ip);
  if (hit && hit.until > now) {
    if (hit.n >= 30) return c.json({ ok: false }, 429);
    hit.n++;
  } else clientErrorHits.set(ip, { n: 1, until: now + 600000 });
  if (clientErrorHits.size > 5000) clientErrorHits.clear();
  const body = clientErrorSchema(await c.req.json().catch(() => null));
  if (!body) return c.json({ ok: false }, 400);
  void report({ ...body, method: "GET", status: 0, source: "client" });
  return c.json({ ok: true });
});
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
app.get("/workspace", workspaceShell);
app.get("/workspace/setup", workspaceShell);
app.get("/signin", workspaceShell);
app.get("/signup", workspaceShell);
app.get("/forgot", workspaceShell);
app.get("/reset", workspaceShell);
function workspaceShell(c: Context<{ Bindings: AppBindings }>) {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
  );
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex,nofollow"/><title>OLLO</title><link rel="icon" href="/static/favicon.svg"/><link rel="stylesheet" href="/static/style.css"/><link rel="stylesheet" href="/static/design.css"/><link rel="stylesheet" href="/static/app.css"/><link rel="stylesheet" href="/static/shop-theme.css"/></head><body><div id="root"><p class="boot-message">Opening workspace…</p></div><noscript>JavaScript is required.</noscript><script type="module" src="/static/app.js"></script></body></html>`,
  );
}
// Head is either the generic private one (noindex) or a server-rendered SEO head for shop pages.
const shell = (head: string, boot = "Opening online booking…") =>
  `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/><meta name="theme-color" content="#181b2a"/>${head}<link rel="icon" href="/static/favicon.svg" type="image/svg+xml"/><link rel="stylesheet" href="/static/style.css"/><link rel="stylesheet" href="/static/design.css"/><link rel="stylesheet" href="/static/app.css"/><link rel="stylesheet" href="/static/theme-fonts.css"/><link rel="stylesheet" href="/static/shop-theme.css"/></head><body><div id="root"><p class="boot-message">${boot}</p></div><noscript>Online booking needs JavaScript.</noscript><script type="module" src="/static/app.js"></script></body></html>`;
const publicPage = (title: string, description: string) => shell(`<meta name="robots" content="noindex,nofollow"/><meta name="description" content="${description}"/><title>${title}</title>`);
// Public origin as the visitor sees it (dev proxies rewrite Host).
const publicOrigin = (c: { req: { url: string; header: (k: string) => string | undefined } }) => {
  const u = new URL(c.req.url);
  const host = c.req.header("x-forwarded-host") || u.host;
  const proto = c.req.header("x-forwarded-proto") || u.protocol.replace(":", "");
  return `${proto}://${host}`;
};
// Front door: owners with a session go straight to work; everyone else sees the marketing page.
// The cookie's presence is only a routing hint — the workspace validates it and shows sign-in if
// it is stale, so a forged cookie buys nothing.
app.get("/", (c) => {
  if (getCookie(c, ACCOUNT_COOKIE)) return c.redirect("/workspace");
  c.header("Cache-Control", "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400");
  c.header("Vary", "Cookie");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
  );
  return c.html(landingPage(publicOrigin(c)));
});
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
app.get("/docs/customer-plan", (c) => {
  let customerPlan = "";
  try {
    customerPlan = readFileSync(join(process.cwd(), "docs", "CUSTOMER-PLAN.md"), "utf8");
  } catch {
    customerPlan = "This page is not available.";
  }
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OLLO · Customer plan</title><link rel="stylesheet" href="/static/design.css"><style>body{font-family:var(--font);max-width:80ch;margin:0 auto;padding:32px 20px;color:var(--ink);line-height:1.55}pre{white-space:pre-wrap;font:inherit;font-size:14px}h1{font-size:24px}a{color:var(--accent-dark)}</style></head><body><a href="/workspace">← Back to OLLO</a><h1>Customer side — plan</h1><pre>${customerPlan.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch] as string)}</pre></body></html>`);
});
app.get("/book/:slug", (c) => {
  secure(c);
  return c.html(
    publicPage(
      "Book a visit — OLLO",
      "Book your next visit online.",
    ),
  );
});
// Shop home page: /<slug>. Only for shops that are online; anything else falls through to 404.
app.get("/:slug", async (c, next) => {
  const slug = c.req.param("slug").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || ["api", "static", "workspace", "book", "manage", "docs", "offer", "media", "signin", "signup", "forgot", "reset", "admin", "robots.txt", "sitemap.xml"].includes(slug)) return next();
  const shop = await c.env.DB.prepare("SELECT * FROM shops WHERE slug=? AND online_booking=1").bind(slug).first<Shop>();
  if (!shop) return next();
  const data = await headData(c.env.DB, shop);
  // Hidden pages are not served at all; /book/<slug> keeps working.
  if (!data.page.published) return next();
  secure(c);
  // Cover/gallery/barber photos are uploads (/media) or owner-supplied https URLs.
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
  );
  const head = shopPageHead({ origin: publicOrigin(c), shop, ...data });
  return c.html(shell(head.html, `Opening ${shop.name}…`));
});
// Search engines: shop pages are indexable, everything private is not.
app.get("/robots.txt", (c) => {
  c.header("Cache-Control", "public, max-age=3600");
  return c.text(["User-agent: *", "Allow: /", "Disallow: /api/", "Disallow: /workspace", "Disallow: /manage/", "Disallow: /offer/", "Disallow: /book/", "Disallow: /*/me$", `Sitemap: ${publicOrigin(c)}/sitemap.xml`, ""].join("\n"));
});
app.get("/sitemap.xml", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT s.slug, COALESCE(p.updated_at, 0) AS updated_at FROM shops s LEFT JOIN shop_pages p ON p.shop_id=s.id WHERE s.online_booking=1 AND s.slug<>'' AND COALESCE(p.published,1)=1 ORDER BY s.slug",
  ).all<{ slug: string; updated_at: number }>();
  const origin = publicOrigin(c);
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
  const urls = rows.results.map((r) => `<url><loc>${esc(`${origin}/${r.slug}`)}</loc>${r.updated_at ? `<lastmod>${new Date(r.updated_at).toISOString().slice(0, 10)}</lastmod>` : ""}<changefreq>weekly</changefreq></url>`).join("");
  c.header("Content-Type", "application/xml; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
});
// Uploaded photos. Ids are unique per upload, so the response can be cached hard.
app.get("/media/:id", async (c) => {
  if (!c.env.MEDIA) return c.notFound();
  const id = c.req.param("id");
  if (!/^[a-f0-9-]{36}$/.test(id)) return c.notFound();
  const row = await c.env.DB.prepare("SELECT object_key,content_type,bytes FROM shop_media WHERE id=?").bind(id).first<MediaRow>();
  if (!row) return c.notFound();
  const obj = await c.env.MEDIA.get(row.object_key);
  if (!obj) return c.notFound();
  c.header("Content-Type", row.content_type);
  c.header("Content-Length", String(row.bytes));
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Security-Policy", "default-src 'none'; sandbox");
  return c.body(obj.body instanceof Uint8Array ? (obj.body as unknown as ArrayBuffer) : (obj.body as ReadableStream));
});
// Customer account area: /<slug>/me (sign-in, visits, profile). Same guard as the home page.
app.get("/:slug/me", async (c, next) => {
  const slug = c.req.param("slug").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || ["api", "static", "workspace", "book", "manage", "docs", "offer", "media", "signin", "signup", "forgot", "reset", "admin", "robots.txt", "sitemap.xml"].includes(slug)) return next();
  const shop = await c.env.DB.prepare("SELECT name FROM shops WHERE slug=? AND online_booking=1").bind(slug).first<{ name: string }>();
  if (!shop) return next();
  secure(c);
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
  return c.html(publicPage(`Your visits · ${esc(shop.name)}`, esc(`Sign in to see, move or rebook your visits at ${shop.name}.`)));
});
app.get("/offer/:token", (c) => {
  secure(c);
  return c.html(publicPage("A time has opened up — OLLO", "Accept or decline the time the shop is holding for you."));
});
// Card-at-the-chair landing: after Stripe Checkout the customer sees a receipt-style page.
app.get("/pay/:id", async (c) => {
  secure(c);
  const req = await c.env.DB.prepare("SELECT r.status, r.service_pence, r.tip_pence, r.url, r.expires_at, s.name, s.currency FROM payment_requests r JOIN shops s ON s.id=r.shop_id WHERE r.id=?").bind(c.req.param("id")).first<Pick<PaymentRequest, "status" | "service_pence" | "tip_pence" | "url" | "expires_at"> & { name: string; currency: string }>();
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
  if (!req) return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment link</title><main style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:24px;text-align:center"><h1>This payment link has gone</h1><p>Ask the shop for a new one.</p></main>`, 404);
  const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: req.currency || "GBP" }).format((req.service_pence + req.tip_pence) / 100);
  const done = c.req.query("done");
  const body =
    req.status === "PAID" || done === "1"
      ? `<h1>Paid — thank you</h1><p>${money} to ${esc(req.name)}. Your card statement will show ${esc(req.name)}.</p>`
      : req.status === "OPEN" && req.expires_at > Date.now()
        ? `<h1>${money} to ${esc(req.name)}</h1><p>Pay by card on your phone.</p><p><a href="${esc(req.url)}" style="display:inline-block;padding:14px 22px;border-radius:12px;background:#111;color:#fff;text-decoration:none;font-weight:600">Pay ${money}</a></p><p style="color:#666;font-size:14px">${done === "0" ? "Payment not completed — you can try again." : "The link is valid for 30 minutes."}</p>`
        : `<h1>This payment link has expired</h1><p>Ask ${esc(req.name)} for a new one.</p>`;
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Pay ${esc(req.name)}</title></head><body style="margin:0;background:#f6f6f4"><main style="font-family:system-ui,-apple-system,sans-serif;max-width:420px;margin:12vh auto;padding:28px;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.06);text-align:center;color:#111">${body}<p style="color:#999;font-size:12px;margin-top:28px">Powered by OLLO</p></main></body></html>`);
});
app.get("/manage/:token", (c) => {
  secure(c);
  return c.html(
    publicPage(
      "Your booking — OLLO",
      "View, move or cancel your booking.",
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
