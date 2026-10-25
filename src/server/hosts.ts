// Shop sub-domains. Every shop lives at <slug>.<root> (root = the host APP_ORIGIN points at, e.g.
// foliyo.co.uk). The wildcard DNS/cert already exists, so a new shop's address works the second the
// slug is chosen: nothing is provisioned per shop.
//
// Layout on a shop host:
//   /                     shop page            (was /<slug>)
//   /book                 booking flow         (was /book/<slug>)
//   /me                   customer account     (was /<slug>/me)
//   /workspace, /signin…  owner + staff sign-in and back office for THIS shop
//   /manage/:t, /offer/:t, /pay/:id, /api/*   unchanged paths
// The root host keeps marketing + owner signup only; shop paths there redirect to the sub-domain.
//
// Implementation: a Hono middleware rewrites the request URL to the historical path form, so every
// existing route keeps working untouched, and sets c.var.shopHost so link builders know the host.
import type { MiddlewareHandler } from "hono";

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// Sub-domains no shop may take. Kept in one place with the slug validator's list (domain.ts).
export const RESERVED_SUBDOMAINS = new Set(["www", "app", "api", "mail", "smtp", "imap", "pop", "admin", "help", "support", "status", "blog", "docs", "static", "cdn", "assets", "dev", "staging", "preview", "test", "demo", "send", "resend", "email", "ns1", "ns2", "mx", "ftp", "shop", "shops", "book", "pay", "billing", "account", "accounts", "login", "signin", "signup", "barbers", "hair-salons", "beauty-and-nails", "tattoo-studios", "clinics", "personal-trainers", "for", "industries"]);

export type HostInfo = { root: string; slug: string | null; secure: boolean; port: string };

// Root host from APP_ORIGIN (prod) — locally there is none, so no sub-domain handling unless
// APP_ROOT_HOST is set (tests set it to "lvh.me"-style names via Host headers).
export function rootHost(): string {
  const env = typeof process !== "undefined" ? process.env : ({} as Record<string, string | undefined>);
  if (env.APP_ROOT_HOST) return env.APP_ROOT_HOST.toLowerCase().replace(/:\d+$/, "");
  try {
    return env.APP_ORIGIN ? new URL(env.APP_ORIGIN).hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}
const stripPort = (h: string) => h.replace(/:\d+$/, "");

// Given the request host, is it <slug>.<root>? Returns the slug or null.
export function hostInfo(hostHeader: string | undefined, url: string): HostInfo {
  const u = new URL(url);
  const raw = (hostHeader || u.host).toLowerCase();
  const host = stripPort(raw);
  const port = raw.includes(":") ? raw.slice(raw.lastIndexOf(":")) : "";
  const root = rootHost();
  const secure = u.protocol === "https:" || !!root;
  if (!root || host === root || host === `www.${root}` || !host.endsWith(`.${root}`)) return { root, slug: null, secure, port };
  const sub = host.slice(0, -(root.length + 1));
  if (!SLUG.test(sub) || sub.includes(".") || RESERVED_SUBDOMAINS.has(sub)) return { root, slug: null, secure, port };
  return { root, slug: sub, secure, port };
}

// Public origin for a shop: https://<slug>.<root>. Falls back to the path form when there is no
// root host (local dev without APP_ORIGIN), so links keep working everywhere.
function rootPort(): string {
  const env = typeof process !== "undefined" ? process.env : ({} as Record<string, string | undefined>);
  try {
    const u = env.APP_ORIGIN ? new URL(env.APP_ORIGIN) : null;
    return u?.port ? `:${u.port}` : "";
  } catch {
    return "";
  }
}
export function shopOrigin(slug: string, fallbackOrigin: string): string {
  const root = rootHost();
  if (!root) return fallbackOrigin;
  const proto = root === "localhost" || root.endsWith(".localhost") || /^\d/.test(root) ? "http" : "https";
  return `${proto}://${slug}.${root}${rootPort()}`;
}
// Where a shop's team works: its own address, never the platform host (which has no sign-in) and
// never whichever host happened to serve the request that queued the email (a customer booking on
// shop A must not make shop B's morning summary link to A). Falls back to the given origin when
// the shop has no slug or the platform has no root host (local dev).
export function teamUrl(slug: string | null | undefined, fallbackOrigin: string, path = "/workspace"): string {
  return `${slug ? shopOrigin(slug, fallbackOrigin) : fallbackOrigin}${path}`;
}
// A shop's own domain (verified by domains.ts). Always https: browsers and Vercel require it.
export const customOrigin = (domain: string) => `https://${domain}`;
export function platformOrigin(fallbackOrigin: string): string {
  const root = rootHost();
  if (!root) return fallbackOrigin;
  const proto = root === "localhost" || root.endsWith(".localhost") || /^\d/.test(root) ? "http" : "https";
  return `${proto}://${root}${rootPort()}`;
}
// Build a customer-facing URL for a shop. `path` is the path *on the shop host* ("/book", "/me",
// "/manage/<t>"). Without a root host the path form is used.
export function shopUrl(slug: string, path: string, fallbackOrigin: string): string {
  const root = rootHost();
  if (!root) {
    if (path === "/" || path === "") return `${fallbackOrigin}/${slug}`;
    if (path === "/book" || path.startsWith("/book?")) return `${fallbackOrigin}/book/${slug}${path.slice(5)}`;
    if (path === "/me" || path.startsWith("/me?")) return `${fallbackOrigin}/${slug}${path}`;
    return `${fallbackOrigin}${path}`;
  }
  return `${shopOrigin(slug, fallbackOrigin)}${path === "" ? "/" : path}`;
}

// Paths that mean "this shop" on a sub-domain and need rewriting to the path routes.
function rewritePath(slug: string, pathname: string): string | null {
  if (pathname === "/" || pathname === "") return `/${slug}`;
  if (pathname === "/book" || pathname === "/book/") return `/book/${slug}`;
  if (pathname === "/me" || pathname === "/me/") return `/${slug}/me`;
  if (pathname === "/manifest.webmanifest") return `/${slug}/manifest.webmanifest`;
  if (/^\/icon-(192|512)\.png$/.test(pathname)) return `/${slug}${pathname}`;
  return null; // everything else (api, workspace, staff, manage, offer, pay, static) is host-agnostic
}

// Paths on the ROOT host that belong to a shop and should live on its sub-domain.
export function rootRedirectFor(pathname: string, isShopSlug: (s: string) => Promise<boolean>): Promise<string | null> {
  return (async () => {
    const m = /^\/book\/([a-z0-9-]+)\/?$/.exec(pathname);
    if (m) return (await isShopSlug(m[1])) ? `${m[1]}|/book` : null;
    const me = /^\/([a-z0-9-]+)\/me\/?$/.exec(pathname);
    if (me) return (await isShopSlug(me[1])) ? `${me[1]}|/me` : null;
    const page = /^\/([a-z0-9-]+)\/?$/.exec(pathname);
    if (page && !RESERVED_SUBDOMAINS.has(page[1])) return (await isShopSlug(page[1])) ? `${page[1]}|/` : null;
    return null;
  })();
}

// Entry-point rewrite (app/[[...path]]/route.ts): on a shop host, map the short paths onto the
// historical path routes and tag the request so link builders know the shop host. Returns the
// request to hand to Hono, or a redirect Response (root-host shop paths → the sub-domain).
export const SHOP_HOST_HEADER = "x-foliyo-shop-host";
// Set when the visitor arrived on the shop's own domain rather than <slug>.<root>.
export const CUSTOM_HOST_HEADER = "x-foliyo-custom-host";
export type CustomHosts = { slugByHost: (host: string) => Promise<string | null>; domainBySlug: (slug: string) => Promise<string | null> };
// Team pages and sign-in always live on the foliyo address; a shop's own domain is for customers.
const STAFF_PATH = /^\/(workspace|signin|staff|forgot|reset|verify)(\/|$)/;
// Customer pages that move to the shop's own domain once it is live (GET only; APIs and payment returns stay put).
const CUSTOMER_PAGE = /^\/(?:$|book\/?$|me\/?$|manage\/|offer\/)/;
export async function routeByHost(req: Request, isShopSlug: (s: string) => Promise<boolean>, custom?: CustomHosts): Promise<Request | Response> {
  const rawHost = req.headers.get("x-forwarded-host") || req.headers.get("host") || undefined;
  const info = hostInfo(rawHost, req.url);
  const u = new URL(req.url);
  const host = stripPort((rawHost || u.host).toLowerCase());
  const tag = (slug: string, isCustom: boolean) => {
    const to = rewritePath(slug, u.pathname);
    const headers = new Headers(req.headers);
    headers.set(SHOP_HOST_HEADER, slug);
    if (isCustom) headers.set(CUSTOM_HOST_HEADER, host); else headers.delete(CUSTOM_HOST_HEADER);
    const url = new URL(u.toString());
    if (to && to !== u.pathname) url.pathname = to;
    return new Request(url.toString(), { method: req.method, headers, body: req.body, redirect: "manual", // @ts-expect-error duplex is required by undici for streamed bodies
      duplex: "half" });
  };
  if (info.slug) {
    // The shop has its own live domain: its customer pages live there now.
    if (custom && req.method === "GET" && CUSTOMER_PAGE.test(u.pathname)) {
      const d = await custom.domainBySlug(info.slug);
      if (d) return Response.redirect(`${customOrigin(d)}${u.pathname}${u.search}`, 301);
    }
    return tag(info.slug, false);
  }
  // Not a foliyo address: is it a shop's own domain?
  if (custom && info.root && host && host !== info.root && host !== `www.${info.root}` && !host.endsWith(`.${info.root}`)) {
    const slug = await custom.slugByHost(host);
    if (slug) {
      if (STAFF_PATH.test(u.pathname) && req.method === "GET") return Response.redirect(`${shopOrigin(slug, u.origin)}${u.pathname}${u.search}`, 302);
      return tag(slug, true);
    }
  }
  // Root host in production: shop paths move to the sub-domain (GET only; APIs stay put).
  if (info.root && req.method === "GET" && !u.pathname.startsWith("/api/")) {
    const hit = await rootRedirectFor(u.pathname, isShopSlug);
    if (hit) {
      const [slug, path] = hit.split("|");
      const d = custom ? await custom.domainBySlug(slug) : null;
      return Response.redirect(`${d ? customOrigin(d) : shopOrigin(slug, u.origin)}${path === "/" ? "/" : path}${u.search}`, 301);
    }
  }
  return req;
}

// Cookie domain for the owner/team session: the platform root, so a session opened on one host
// (signup on the root, then straight to <slug>.<root>/workspace) is valid on the shop's host too.
// Customers' cookies stay host-only. Browsers refuse Domain=localhost, so local dev gets none.
export function sessionCookieDomain(): string | undefined {
  const root = rootHost();
  if (!root || root === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(root)) return undefined;
  return `.${root}`;
}
