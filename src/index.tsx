import { Hono, type Context } from "hono";

import sandbox from "./server/sandbox";
import pub from "./server/public";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brandOf, type Shop } from "./server/domain";
import { headData, shopPageHead, type MediaRow } from "./server/presence";
import { shopManifest } from "./server/customerAuth";
import { SHOP_HOST_HEADER, shopOrigin } from "./server/hosts";
import { shopIcon } from "./server/images";
import { currentBuild, entryTags, shopAssetList } from "./server/assets";
import { drain, maybeSweep, providerStatus, sweepReminders } from "./server/messaging";
import { sweepWaitlistPlatform } from "./server/waitlist";
import { report, telemetryStatus } from "./server/telemetry";
import { landingPage, VERTICALS } from "./server/landing";
import { legalPage, LEGAL_DOCS, type LegalDoc } from "./server/legal";
import { getCookie } from "hono/cookie";
import { ACCOUNT_COOKIE } from "./server/accounts";
import { expireHolds, markDepositPaid, stripeStatus, verifyWebhook } from "./server/stripe";
import { afterDepositPaid } from "./server/public";
import { handleConnectEvent, type ConnectEvent } from "./server/payouts";
import { settleByMetadata, type PaymentRequest } from "./server/chair";
import { applyDeliveryReports, applyInbound, waWebhookOk } from "./server/whatsapp";
import voice from "./server/voice";
import admin, { adminPublic } from "./server/admin";
import type { Database } from "./db/client";
import type { ObjectStore } from "./db/storage";
export type AppBindings = { DB: Database; MEDIA?: ObjectStore; APP_MODE?: string; ALLOWED_ORIGINS?: string; DEMO_ENABLED?: string; FOLIYO_ADMIN_EMAILS?: string; OLLO_ADMIN_EMAILS?: string };
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
  const waitlist = await sweepWaitlistPlatform(c.env.DB, origin).catch(() => 0);
  return c.json({ ok: true, reminders, drained, holds_released: holds.length, waitlist, providers: providerStatus() });
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
// Which client build is live. Installed apps compare this with the build that rendered them and
// reload when it moves, so a phone is never a deploy behind the dashboard.
app.get("/api/public/build", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ build: currentBuild() });
});
app.route("/api/app", sandbox);
// Legacy path kept for one release so old tabs keep working.
app.route("/api/sandbox", sandbox);
app.route("/api/public", pub);
// AI receptionist tools (ElevenLabs agents). Per-shop bearer secret, no cookies, cross-origin by design.
app.route("/api/voice", voice);
app.route("/api/admin", admin);
app.route("/api/admin-public", adminPublic);
app.get("/pay-run/:id", (c) => adminPublic.fetch(new Request(new URL(`/pay-run/${c.req.param("id")}${new URL(c.req.url).search}`, c.req.url), c.req.raw), c.env));
// Printable invoice / credit note (token in the query string; emailed to billing contacts).
app.get("/invoice/:id", (c) => adminPublic.fetch(new Request(new URL(`/invoice/${c.req.param("id")}${new URL(c.req.url).search}`, c.req.url), c.req.raw), c.env));
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
app.get("/admin", workspaceShell);
app.get("/admin/*", workspaceShell);
app.get("/workspace/setup", workspaceShell);
app.get("/signin", workspaceShell);
app.get("/signup", workspaceShell);
app.get("/forgot", workspaceShell);
app.get("/reset", workspaceShell);
app.get("/verify", workspaceShell);
function workspaceShell(c: Context<{ Bindings: AppBindings }>) {
  // In production every shop's team signs in on the shop's own address. The root host only
  // hosts signup (and a "find your shop" helper at /signin); the shell tells the client which.
  const hostSlug = c.req.header(SHOP_HOST_HEADER) || "";
  const root = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).host : "";
  // "local" on localhost/IP roots: every shop's team can still sign in at the root, as before.
  const rootIsLocal = !root || /^(localhost|\d+\.\d+\.\d+\.\d+)(:\d+)?$/.test(root);
  const meta = `<meta name="foliyo-host" content="${hostSlug ? "shop" : rootIsLocal ? "local" : "root"}"/>${hostSlug ? `<meta name="foliyo-shop" content="${hostSlug}"/>` : ""}${root ? `<meta name="foliyo-root" content="${root}"/>` : ""}`;
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
  );
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex,nofollow"/><title>foliyo</title>${meta}<link rel="icon" href="/static/favicon.svg" type="image/svg+xml"/><link rel="icon" href="/favicon.ico" sizes="32x32"/><link rel="apple-touch-icon" href="/foliyo-apple-touch-icon.png"/><link rel="manifest" href="/site.webmanifest"/>${STYLES}</head><body><div id="root"><p class="boot-message">Opening workspace…</p></div><noscript>JavaScript is required.</noscript>${entryTags("app")}</body></html>`,
  );
}
// Hand-written stylesheets, versioned by build so a deploy invalidates them everywhere at once.
const STYLES = ["style", "design", "theme-fonts", "shop-theme"].map((n) => `<link rel="stylesheet" href="/static/${n}.css?v=${currentBuild()}"/>`).join("");
// Customer-facing boot screen: the shop's own colours and logo (or initials) paint before any
// JavaScript arrives, so an installed app opens straight into the shop rather than a grey
// "loading" line. Dark/light and the accent come from the shop page theme.
type BootBrand = { name: string; slug?: string; logo_url?: string; dark?: boolean; accent?: string; theme_json?: string; sms?: boolean; email?: boolean };
// Embedded for the client: the full brand, so the very first React render is already in the shop's
// theme (no unthemed frame between the boot screen and the screen).
const brandScript = (b?: BootBrand) => (b ? `<script type="application/json" id="foliyo-brand">${JSON.stringify({ name: b.name, slug: b.slug || "", brand: brandOf({ logo_url: b.logo_url || "", accent: b.accent, theme_json: b.theme_json }), channels: { sms: b.sms !== false, email: b.email !== false } }).replace(/</g, "\\u003c")}</script>` : "");
const BOOT_ACCENT: Record<string, string> = { ollo: "#1f6f5f", ink: "#111318", sage: "#5b7a68", clay: "#a0522d", plum: "#5a3e6b", slate: "#4a5568" };
function bootScreen(b?: BootBrand) {
  if (!b) return `<p class="boot-message">Opening online booking…</p>`;
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
  const initials = b.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const accent = BOOT_ACCENT[b.accent || "ollo"] || BOOT_ACCENT.ollo;
  const mark = b.logo_url
    ? `<img src="${esc(b.logo_url)}" alt="" class="boot-logo${b.dark ? " flip" : ""}"/>`
    : `<span class="boot-initials" style="background:${accent}">${esc(initials)}</span>`;
  return `<div class="boot-shop${b.dark ? " dark" : ""}" aria-busy="true" aria-label="Opening ${esc(b.name)}">${mark}<span class="boot-bar"><i></i></span></div>`;
}
const bootThemeColor = (b?: BootBrand) => (b?.dark ? "#17181e" : "#ffffff");
// Head is either the generic private one (noindex) or a server-rendered SEO head for shop pages.
const shell = (head: string, brand?: BootBrand) =>
  `<!doctype html><html lang="en"${brand?.dark ? ' class="boot-dark"' : ""}><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/><meta name="theme-color" content="${bootThemeColor(brand)}"/>${head}<link rel="icon" href="/static/favicon.svg" type="image/svg+xml"/><link rel="icon" href="/favicon.ico" sizes="32x32"/>${head.includes("data-shop") ? "" : `<link rel="apple-touch-icon" href="/foliyo-apple-touch-icon.png"/><link rel="manifest" href="/site.webmanifest"/>`}${STYLES}</head><body><div id="root">${bootScreen(brand)}</div><noscript>Online booking needs JavaScript.</noscript>${brandScript(brand)}${entryTags("shop")}</body></html>`;
// Brand for the boot screen of /book and /me: one small read, cached per process for a minute.
const bootCache = new Map<string, { at: number; brand: BootBrand | undefined }>();
async function bootBrand(db: Database, slug: string): Promise<BootBrand | undefined> {
  const hit = bootCache.get(slug);
  if (hit && Date.now() - hit.at < 60000) return hit.brand;
  let brand: BootBrand | undefined;
  try {
    const row = await db.prepare("SELECT s.name,s.msg_sms,s.msg_email,COALESCE(p.logo_url,'') AS logo_url,COALESCE(p.accent,'ollo') AS accent,COALESCE(p.theme_json,'{}') AS theme_json FROM shops s LEFT JOIN shop_pages p ON p.shop_id=s.id WHERE s.slug=? AND s.online_booking=1").bind(slug).first<{ name: string; msg_sms: number; msg_email: number; logo_url: string; accent: string; theme_json: string }>();
    if (row) {
      let dark = false;
      try { dark = (JSON.parse(row.theme_json) as { mode?: string }).mode === "dark"; } catch { /* default light */ }
      brand = { name: row.name, slug, logo_url: row.logo_url || undefined, dark, accent: row.accent, theme_json: row.theme_json, sms: row.msg_sms !== 0, email: row.msg_email !== 0 };
    }
  } catch { brand = undefined; }
  bootCache.set(slug, { at: Date.now(), brand });
  return brand;
}
const onShopHost = (c: { req: { header: (k: string) => string | undefined } }, slug: string) => (c.req.header(SHOP_HOST_HEADER) || "") === slug;
const publicPage = (title: string, description: string, slug?: string, onHost = false, brand?: BootBrand) => shell(`<meta name="robots" content="noindex,nofollow"/><meta name="description" content="${description}"/><title>${brand ? `${title} · ${brand.name}` : title}</title>${slug ? shopAppHead(slug, onHost, !!brand?.dark) : ""}`, brand);
// Installable shop app: per-shop manifest (name/icon/colours from the shop page) and the shared
// service worker registered at the shop's scope. Overrides the platform manifest in shell().
const shopAppHead = (slug: string, onHost = false, dark = false) => `${onHost ? `<meta name="foliyo-shop" content="${slug}"/>` : ""}<link rel="manifest" href="${onHost ? "" : `/${encodeURIComponent(slug)}`}/manifest.webmanifest" data-shop/><link rel="apple-touch-icon" sizes="192x192" href="${onHost ? "" : `/${encodeURIComponent(slug)}`}/icon-192.png"/><link rel="apple-touch-icon" sizes="512x512" href="${onHost ? "" : `/${encodeURIComponent(slug)}`}/icon-512.png"/><meta name="apple-mobile-web-app-capable" content="yes"/><meta name="mobile-web-app-capable" content="yes"/><meta name="apple-mobile-web-app-title" content="${slug}"/><meta name="apple-mobile-web-app-status-bar-style" content="${dark ? "black-translucent" : "default"}"/>`;
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
  return c.html(landingPage(publicOrigin(c), VERTICALS.universal));
});
// Vertical landing pages share the layout; only the story changes. Signed-in owners still go to work.
app.get("/barbers", (c) => {
  if (getCookie(c, ACCOUNT_COOKIE)) return c.redirect("/workspace");
  c.header("Cache-Control", "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400");
  c.header("Vary", "Cookie");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
  );
  return c.html(landingPage(publicOrigin(c), VERTICALS.barbers));
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
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>foliyo · Customer plan</title><link rel="stylesheet" href="/static/design.css"><style>body{font-family:var(--font);max-width:80ch;margin:0 auto;padding:32px 20px;color:var(--ink);line-height:1.55}pre{white-space:pre-wrap;font:inherit;font-size:14px}h1{font-size:24px}a{color:var(--accent-dark)}</style></head><body><a href="/workspace">← Back to foliyo</a><h1>Customer side — plan</h1><pre>${customerPlan.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch] as string)}</pre></body></html>`);
});
app.get("/book/:slug", async (c) => {
  secure(c);
  const slug = c.req.param("slug").toLowerCase();
  const brand = await bootBrand(c.env.DB, slug);
  return c.html(publicPage("Book a visit", "Book your next visit online.", slug, onShopHost(c, slug), brand));
});
// Service worker: the static file with this build's asset list and id stamped in. Served with
// max-age 0 so browsers re-check it on every open (they cap it at 24h anyway).
let swSource = "";
app.get("/sw.js", (c) => {
  if (!swSource) {
    try { swSource = readFileSync(join(process.cwd(), "src", "server", "sw.template.txt"), "utf8"); } catch { swSource = ""; }
  }
  const body = swSource.replaceAll("__BUILD__", currentBuild()).replaceAll("__ASSETS__", JSON.stringify([...shopAssetList(), ...["style", "design", "theme-fonts", "shop-theme"].map((n) => `/static/${n}.css?v=${currentBuild()}`)]));
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "no-cache, max-age=0, must-revalidate");
  c.header("Service-Worker-Allowed", "/");
  return c.body(body);
});
// Installable shop app: manifest + icons + service worker, per shop.
app.get("/:slug/manifest.webmanifest", async (c, next) => {
  const slug = c.req.param("slug").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) return next();
  try { return await shopManifest(c as unknown as Parameters<typeof shopManifest>[0], slug); } catch { return next(); }
});
app.get("/:slug/:icon{icon-(192|512)\\.png}", async (c, next) => {
  const slug = c.req.param("slug").toLowerCase();
  const size = (c.req.param("icon").includes("512") ? 512 : 192) as 192 | 512;
  const shop = await c.env.DB.prepare("SELECT s.id,s.name,COALESCE(p.logo_url,'') AS logo_url,COALESCE(p.accent,'ollo') AS accent,COALESCE(p.theme_json,'{}') AS theme_json FROM shops s LEFT JOIN shop_pages p ON p.shop_id=s.id WHERE s.slug=? AND s.online_booking=1").bind(slug).first<{ id: string; name: string; logo_url: string; accent: string; theme_json: string }>();
  if (!shop) return next();
  let logo: Uint8Array | null = null;
  const m = /^\/media\/([a-f0-9-]{36})$/.exec(shop.logo_url);
  if (m && c.env.MEDIA) {
    const row = await c.env.DB.prepare("SELECT object_key FROM shop_media WHERE id=?").bind(m[1]).first<{ object_key: string }>();
    const obj = row ? await c.env.MEDIA.get(row.object_key) : null;
    if (obj) logo = obj.body instanceof Uint8Array ? obj.body : new Uint8Array(await new Response(obj.body as ReadableStream).arrayBuffer());
  } else if (/^https?:\/\//.test(shop.logo_url) || shop.logo_url.startsWith("/static/")) {
    try {
      const r = await fetch(shop.logo_url.startsWith("/") ? publicOrigin(c) + shop.logo_url : shop.logo_url, { signal: AbortSignal.timeout(4000) });
      if (r.ok) logo = new Uint8Array(await r.arrayBuffer());
    } catch { /* monogram fallback */ }
  }
  const dark = (() => { try { return (JSON.parse(shop.theme_json) as { mode?: string }).mode === "dark"; } catch { return false; } })();
  const ACCENT: Record<string, string> = { ollo: "#1f6f5f", ink: "#111318", sage: "#5b7a68", clay: "#a0522d", plum: "#5a3e6b", slate: "#4a5568" };
  const bg = logo ? (dark ? "#0b0b0c" : "#ffffff") : ACCENT[shop.accent] || ACCENT.ollo;
  const png = await shopIcon(size, logo, shop.name, bg, "#ffffff");
  c.header("Content-Type", "image/png");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(png as unknown as ArrayBuffer);
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
  let dark = false;
  try { dark = (JSON.parse(data.page.theme_json || "{}") as { mode?: string }).mode === "dark"; } catch { /* light */ }
  return c.html(shell(head.html + shopAppHead(slug, onShopHost(c, slug), dark), { name: shop.name, slug, logo_url: data.page.logo_url || undefined, dark, accent: data.page.accent, theme_json: data.page.theme_json }));
});
// Apple Pay on the pay-link / deposit checkout: Stripe verifies the domain by fetching this file
// (public/.well-known/…). Served explicitly so no hosting rewrite can swallow the dot-directory.
app.get("/.well-known/apple-developer-merchantid-domain-association", async (c) => {
  const res = await fetch("https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association");
  if (!res.ok) return c.notFound();
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(await res.text(), 200, { "Content-Type": "text/plain" });
});
// Search engines: shop pages are indexable, everything private is not.
// Legal documents: server-rendered, indexable, no JS. Versioned in src/server/legal.ts.
app.get("/legal/:doc", (c) => {
  const doc = c.req.param("doc") as LegalDoc;
  if (!LEGAL_DOCS.includes(doc)) return c.notFound();
  c.header("Cache-Control", "public, max-age=600");
  return c.html(legalPage(doc, publicOrigin(c)));
});
app.get("/legal", (c) => c.redirect("/legal/terms", 302));
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
  const statics = ["/", "/barbers"].map((p) => `<url><loc>${esc(origin + p)}</loc><changefreq>monthly</changefreq></url>`).join("");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${statics}${urls}</urlset>`);
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
  return c.html(publicPage("Your visits", esc(`Sign in to see, move or rebook your visits at ${shop.name}.`), slug, onShopHost(c, slug), await bootBrand(c.env.DB, slug)));
});
app.get("/offer/:token", (c) => {
  secure(c);
  return c.html(publicPage("A time has opened up — foliyo", "Accept or decline the time the shop is holding for you."));
});
// Card-at-the-chair landing: after Stripe Checkout the customer sees a receipt-style page.
app.get("/pay/:id", async (c) => {
  secure(c);
  const req = await c.env.DB.prepare("SELECT r.status, r.service_pence, r.tip_pence, r.url, r.expires_at, s.name, s.currency FROM payment_requests r JOIN shops s ON s.id=r.shop_id WHERE r.id=?").bind(c.req.param("id")).first<Pick<PaymentRequest, "status" | "service_pence" | "tip_pence" | "url" | "expires_at"> & { name: string; currency: string }>();
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
  if (!req) return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment link</title><main style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:24px;text-align:center"><h1>This payment link has gone</h1><p>Ask the shop for a new one.</p></main>`, 404);
  const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: req.currency || "GBP" }).format((req.service_pence + req.tip_pence) / 100);
  const done = c.req.query("done");
  // Scanned from the QR at the chair: skip the interstitial and open Stripe Checkout directly.
  if (c.req.query("go") === "1" && req.status === "OPEN" && req.expires_at > Date.now() && req.url) return c.redirect(req.url, 302);
  const body =
    req.status === "PAID" || done === "1"
      ? `<h1>Paid — thank you</h1><p>${money} to ${esc(req.name)}. Your card statement will show ${esc(req.name)}.</p>`
      : req.status === "OPEN" && req.expires_at > Date.now()
        ? `<h1>${money} to ${esc(req.name)}</h1><p>Pay by card on your phone.</p><p><a href="${esc(req.url)}" style="display:inline-block;padding:14px 22px;border-radius:12px;background:#0b1a17;color:#a8d5c2;text-decoration:none;font-weight:600">Pay ${money}</a></p><p style="color:#666;font-size:14px">${done === "0" ? "Payment not completed — you can try again." : "The link is valid for 30 minutes."}</p>`
        : `<h1>This payment link has expired</h1><p>Ask ${esc(req.name)} for a new one.</p>`;
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Pay ${esc(req.name)}</title></head><body style="margin:0;background:#f6f6f4"><main style="font-family:system-ui,-apple-system,sans-serif;max-width:420px;margin:12vh auto;padding:28px;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.06);text-align:center;color:#111">${body}<p style="color:#999;font-size:12px;margin-top:28px">Powered by foliyo</p></main></body></html>`);
});
app.get("/manage/:token", (c) => {
  secure(c);
  return c.html(
    publicPage(
      "Your booking — foliyo",
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
