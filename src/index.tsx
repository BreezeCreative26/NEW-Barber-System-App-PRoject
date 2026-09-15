import { Hono } from "hono";
import { serveStatic } from "hono/cloudflare-workers";

import sandbox from "./server/sandbox";
import pub from "./server/public";
import customerPlan from "../docs/CUSTOMER-PLAN.md?raw";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { Shop } from "./server/domain";
import { headData, shopPageHead, type MediaRow } from "./server/presence";
const app = new Hono<{ Bindings: { DB: D1Database; MEDIA?: R2Bucket; APP_MODE?: string } }>();
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
// Head is either the generic private one (noindex) or a server-rendered SEO head for shop pages.
const shell = (head: string, boot = "Opening online booking…") =>
  `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/><meta name="theme-color" content="#181b2a"/>${head}<link rel="icon" href="/static/favicon.svg" type="image/svg+xml"/><link rel="stylesheet" href="/static/style.css"/><link rel="stylesheet" href="/static/design.css"/><link rel="stylesheet" href="/static/app.css"/></head><body><div id="root"><p class="boot-message">${boot}</p></div><noscript>Online booking needs JavaScript. No payment is taken in this local test.</noscript><script type="module" src="/static/app.js"></script></body></html>`;
const publicPage = (title: string, description: string) => shell(`<meta name="robots" content="noindex,nofollow"/><meta name="description" content="${description}"/><title>${title}</title>`);
// Public origin as the visitor sees it (dev proxies rewrite Host).
const publicOrigin = (c: { req: { url: string; header: (k: string) => string | undefined } }) => {
  const u = new URL(c.req.url);
  const host = c.req.header("x-forwarded-host") || u.host;
  const proto = c.req.header("x-forwarded-proto") || u.protocol.replace(":", "");
  return `${proto}://${host}`;
};
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
// Shop home page: /<slug>. Only for shops that are online; anything else falls through to 404.
app.get("/:slug", async (c, next) => {
  if (c.env?.APP_MODE !== "sandbox") return next();
  const slug = c.req.param("slug").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || ["api", "static", "workspace", "book", "manage", "docs", "offer", "media", "robots.txt", "sitemap.xml"].includes(slug)) return next();
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
  if (c.env?.APP_MODE !== "sandbox") return c.notFound();
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
  if (c.env?.APP_MODE !== "sandbox" || !c.env.MEDIA) return c.notFound();
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
  return c.body(obj.body as unknown as ReadableStream);
});
// Customer account area: /<slug>/me (sign-in, visits, profile). Same guard as the home page.
app.get("/:slug/me", async (c, next) => {
  if (c.env?.APP_MODE !== "sandbox") return next();
  const slug = c.req.param("slug").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || ["api", "static", "workspace", "book", "manage", "docs", "offer", "media", "robots.txt", "sitemap.xml"].includes(slug)) return next();
  const shop = await c.env.DB.prepare("SELECT name FROM shops WHERE slug=? AND online_booking=1").bind(slug).first<{ name: string }>();
  if (!shop) return next();
  secure(c);
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
  return c.html(publicPage(`Your visits · ${esc(shop.name)}`, esc(`Sign in to see, move or rebook your visits at ${shop.name}.`)));
});
app.get("/offer/:token", (c) => {
  if (c.env?.APP_MODE !== "sandbox") return c.notFound();
  secure(c);
  return c.html(publicPage("A time has opened up — OLLO", "Accept or decline the time the shop is holding for you. Local test; no payment is taken."));
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
