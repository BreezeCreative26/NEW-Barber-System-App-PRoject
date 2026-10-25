// A shop's own web address (book.northline.co.uk).
//
// One flow, two halves, verified separately:
//   web  : the domain is added to our Vercel project; the shop points a CNAME/A record at Vercel.
//   mail : the domain is added to Resend; the shop adds the SPF/DKIM records Resend gives back.
//
// Nothing switches until a half is VERIFIED, and it switches by itself the moment it is:
//   web  VERIFIED -> customers are served on the shop's domain, every customer-facing link in every
//                    email/text points there, and the <slug>.foliyo address redirects to it.
//   mail VERIFIED -> email goes out as "Shop Name <bookings@domain>" (and falls back to foliyo's
//                    sender if the provider refuses it, so a confirmation is never lost).
// Staff sign-in, invites and resets always stay on the <slug>.foliyo address.
//
// The Vercel/Resend calls are plain fetches against base URLs that can be overridden, so the whole flow
// is exercised in tests against stand-in servers and never touches a real account.
import type { Hono } from "hono";
import { z } from "zod";
import type { Database as DB } from "../db/client";
import { customOrigin, rootHost, shopOrigin, shopUrl } from "./hosts";

type Ctx = import("hono").Context<any>;
type Helpers = {
  input: <T>(c: Ctx, s: z.ZodType<T>) => Promise<T>;
  requireRole: (c: Ctx, roles: string[]) => void;
  fail: (status: 400 | 403 | 404 | 409 | 502 | 503, message: string) => never;
  audit: (c: Ctx, entity: string, id: string, action: string, reason?: string) => ReturnType<DB["prepare"]>;
};

export type DomainRecord = { purpose: "web" | "email"; type: string; host: string; value: string; priority?: number; status: string };
export type DomainRow = {
  shop_id: string; domain: string; web_status: "PENDING" | "VERIFIED" | "ERROR"; mail_status: "PENDING" | "VERIFIED" | "ERROR";
  resend_domain_id: string; records_json: string; last_checked_at: number; last_error: string; created_at: number; updated_at: number;
};

const env = () => (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
const TIMEOUT = 15000;

// ---- Settings: what the platform has been given to work with ----------------------------------
export function domainsConfigured() {
  const e = env();
  return { vercel: !!(e.DOMAINS_VERCEL_TOKEN && (e.DOMAINS_VERCEL_PROJECT_ID || e.VERCEL_PROJECT_ID)), resend: !!e.DOMAINS_RESEND_KEY };
}

// ---- Who may have one --------------------------------------------------------------------------
// Same resolution as entitlements(): a live per-shop row wins, otherwise the feature's plan default.
export const featureOnSql = (shopRef: string, now = Date.now()) =>
  `(COALESCE((SELECT sf.enabled FROM shop_features sf WHERE sf.shop_id=${shopRef} AND sf.feature_key='custom_domain' AND (sf.ends_at IS NULL OR sf.ends_at>${Math.floor(now)}) LIMIT 1), (SELECT f.in_plan FROM features f WHERE f.key='custom_domain' AND f.active=1), 0)=1)`;
/** Select-list fragments for a query aliased `s` over shops. Only a VERIFIED half, on a shop that still has the feature. */
export const webDomainSql = (now = Date.now()) => `(SELECT d.domain FROM shop_domains d WHERE d.shop_id=s.id AND d.web_status='VERIFIED' AND ${featureOnSql("s.id", now)}) AS custom_web_domain`;
export const mailDomainSql = (now = Date.now()) => `(SELECT d.domain FROM shop_domains d WHERE d.shop_id=s.id AND d.mail_status='VERIFIED' AND ${featureOnSql("s.id", now)}) AS custom_mail_domain`;
export async function customDomainAllowed(db: DB, shopId: string) {
  return !!(await db.prepare(`SELECT 1 AS x WHERE ${featureOnSql("?")}`.replace("?", `'${shopId.replace(/'/g, "''")}'`)).first());
}

// ---- Validation --------------------------------------------------------------------------------
export function normaliseDomain(input: string): { ok: true; domain: string } | { ok: false; error: string } {
  let d = (input || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (!d) return { ok: false, error: "Enter your web address, for example book.yourshop.co.uk" };
  if (d.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(d)) return { ok: false, error: "That doesn't look like a web address. Use something like book.yourshop.co.uk" };
  const root = rootHost();
  if (root && (d === root || d.endsWith(`.${root}`))) return { ok: false, error: `Addresses on ${root} are already yours. Enter a domain you own.` };
  if (/(^|\.)(vercel\.app|vercel\.com|resend\.dev|localhost)$/.test(d)) return { ok: false, error: "Enter a domain you own." };
  return { ok: true, domain: d };
}

// ---- Provider clients --------------------------------------------------------------------------
type Reply = { ok: boolean; status: number; j: any };
async function http(url: string, init: RequestInit): Promise<Reply> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  const text = await res.text();
  let j: any = {};
  try { j = text ? JSON.parse(text) : {}; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, j };
}
const vercel = () => {
  const e = env();
  const project = e.DOMAINS_VERCEL_PROJECT_ID || e.VERCEL_PROJECT_ID || "";
  const team = e.DOMAINS_VERCEL_TEAM_ID || "";
  const base = e.DOMAINS_VERCEL_URL || "https://api.vercel.com";
  const q = (extra = "") => { const p = [team ? `teamId=${encodeURIComponent(team)}` : "", extra].filter(Boolean).join("&"); return p ? `?${p}` : ""; };
  const headers = { Authorization: `Bearer ${e.DOMAINS_VERCEL_TOKEN}`, "Content-Type": "application/json" };
  const dom = (d: string) => `${base}/v9/projects/${project}/domains/${encodeURIComponent(d)}`;
  return {
    add: (d: string) => http(`${base}/v10/projects/${project}/domains${q()}`, { method: "POST", headers, body: JSON.stringify({ name: d }) }),
    get: (d: string) => http(`${dom(d)}${q()}`, { headers }),
    verify: (d: string) => http(`${dom(d)}/verify${q()}`, { method: "POST", headers }),
    config: (d: string) => http(`${base}/v6/domains/${encodeURIComponent(d)}/config${q(`projectIdOrName=${encodeURIComponent(project)}`)}`, { headers }),
    remove: (d: string) => http(`${dom(d)}${q()}`, { method: "DELETE", headers }),
  };
};
const resend = () => {
  const e = env();
  const base = e.DOMAINS_RESEND_URL || "https://api.resend.com";
  const headers = { Authorization: `Bearer ${e.DOMAINS_RESEND_KEY}`, "Content-Type": "application/json" };
  return {
    create: (name: string) => http(`${base}/domains`, { method: "POST", headers, body: JSON.stringify({ name, region: "eu-west-1", capabilities: { sending: "enabled", receiving: "disabled" } }) }),
    list: () => http(`${base}/domains`, { headers }),
    get: (id: string) => http(`${base}/domains/${id}`, { headers }),
    verify: (id: string) => http(`${base}/domains/${id}/verify`, { method: "POST", headers }),
    remove: (id: string) => http(`${base}/domains/${id}`, { method: "DELETE", headers }),
  };
};

// ---- Lookups used on every request (cached briefly) --------------------------------------------
const slugByHostCache = new Map<string, { v: string | null; at: number }>();
const domainBySlugCache = new Map<string, { v: string | null; at: number }>();
const TTL = 30000;
export function clearDomainCache() { slugByHostCache.clear(); domainBySlugCache.clear(); }
const remember = (m: Map<string, { v: string | null; at: number }>, k: string, v: string | null) => { if (m.size > 2000) m.clear(); m.set(k, { v, at: Date.now() }); return v; };

export type DomainLookup = { slugByHost: (host: string) => Promise<string | null>; domainBySlug: (slug: string) => Promise<string | null> };
export function hostLookup(db: DB): DomainLookup {
  return {
    async slugByHost(host) {
      const hit = slugByHostCache.get(host);
      if (hit && Date.now() - hit.at < TTL) return hit.v;
      const row = await db.prepare(`SELECT s.slug FROM shop_domains d JOIN shops s ON s.id=d.shop_id WHERE d.domain=? AND d.web_status='VERIFIED' AND s.slug IS NOT NULL AND ${featureOnSql("d.shop_id")}`).bind(host).first<{ slug: string }>().catch(() => null);
      return remember(slugByHostCache, host, row?.slug ?? null);
    },
    async domainBySlug(slug) {
      const hit = domainBySlugCache.get(slug);
      if (hit && Date.now() - hit.at < TTL) return hit.v;
      const row = await db.prepare(`SELECT d.domain FROM shop_domains d JOIN shops s ON s.id=d.shop_id WHERE s.slug=? AND d.web_status='VERIFIED' AND ${featureOnSql("d.shop_id")}`).bind(slug).first<{ domain: string }>().catch(() => null);
      return remember(domainBySlugCache, slug, row?.domain ?? null);
    },
  };
}

/** A customer-facing link for a shop: its own domain when that is live, otherwise the foliyo address. */
export async function publicShopUrl(db: DB, slug: string, path: string, fallbackOrigin: string) {
  const d = await hostLookup(db).domainBySlug(slug);
  return d ? `${customOrigin(d)}${path === "" ? "/" : path}` : shopUrl(slug, path, fallbackOrigin);
}

// ---- Links in messages -------------------------------------------------------------------------
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Move customer-facing links (shop page, booking, account, manage/offer/pay links, unsubscribe) from the
 * foliyo address onto the shop's own domain. Staff links (/workspace, /signin, /verify, /reset ...) are
 * left alone: the team always signs in on the foliyo address.
 */
export function toCustomerDomain(text: string, slug: string | null | undefined, customDomain: string | null | undefined, fallbackOrigin: string): string {
  if (!text || !slug || !customDomain || !rootHost()) return text;
  const base = shopOrigin(slug, fallbackOrigin);
  const re = new RegExp(`${esc(base)}(?=/(?:book|me)(?![A-Za-z0-9_-])|/(?:manage|offer|pay|u)/|/?(?:[\\s"'<>?#]|$))`, "g");
  return text.replace(re, customOrigin(customDomain));
}

// ---- State: connect, check, remove -------------------------------------------------------------
const apexOf = (domain: string, hinted?: string) => (hinted && domain.endsWith(hinted) ? hinted : domain.split(".").length <= 2 ? domain : "");
const trimDot = (v: string) => v.replace(/\.$/, "");

export async function readDomain(db: DB, shopId: string) {
  return db.prepare("SELECT * FROM shop_domains WHERE shop_id=?").bind(shopId).first<DomainRow>();
}

/** Bring both providers and our row in line: create what is missing, ask them to re-check, read the answers. */
export async function refreshDomain(db: DB, shopId: string, now = Date.now()): Promise<DomainRow | null> {
  const row = await readDomain(db, shopId);
  if (!row) return null;
  const cfg = domainsConfigured();
  const errors: string[] = [];
  const records: DomainRecord[] = [];
  let webStatus: DomainRow["web_status"] = "PENDING";
  let mailStatus: DomainRow["mail_status"] = "PENDING";
  let resendId = row.resend_domain_id;

  // -- web (Vercel)
  if (cfg.vercel) {
    try {
      const v = vercel();
      let proj = await v.get(row.domain);
      if (proj.status === 404) {
        const added = await v.add(row.domain);
        if (!added.ok) throw new Error(added.status === 409 ? "That domain is already connected somewhere else." : added.j?.error?.message || `Vercel said ${added.status}`);
        proj = added;
      }
      if (!proj.ok) throw new Error(proj.j?.error?.message || `Vercel said ${proj.status}`);
      if (!proj.j.verified) { const again = await v.verify(row.domain); if (again.ok) proj = again; }
      const conf = await v.config(row.domain);
      const apex = apexOf(row.domain, proj.j.apexName);
      const isApex = apex === row.domain;
      const a = conf.j?.recommendedIPv4?.[0]?.value?.[0] || "76.76.21.21";
      const cname = trimDot(conf.j?.recommendedCNAME?.[0]?.value || "cname.vercel-dns.com");
      const live = !!proj.j.verified && conf.ok && conf.j?.misconfigured === false;
      records.push(isApex
        ? { purpose: "web", type: "A", host: "@", value: a, status: live ? "verified" : "pending" }
        : { purpose: "web", type: "CNAME", host: apex ? row.domain.slice(0, -(apex.length + 1)) : row.domain.split(".")[0], value: cname, status: live ? "verified" : "pending" });
      for (const ch of (proj.j.verification as { type: string; domain: string; value: string }[] | undefined) ?? [])
        if (!proj.j.verified) records.push({ purpose: "web", type: ch.type, host: ch.domain, value: ch.value, status: "pending" });
      webStatus = live ? "VERIFIED" : "PENDING";
    } catch (e) { webStatus = "ERROR"; errors.push(`Web address: ${e instanceof Error ? e.message : "could not reach Vercel"}`); }
  } else errors.push("Web address: the platform hasn't been connected to Vercel yet.");

  // -- email (Resend)
  if (cfg.resend) {
    try {
      const r = resend();
      if (!resendId) {
        const made = await r.create(row.domain);
        if (made.ok && made.j?.id) resendId = made.j.id;
        else {
          // Already in the account (a previous attempt, or added by hand): reuse it.
          const all = await r.list();
          const hit = (all.j?.data as { id: string; name: string }[] | undefined)?.find((d) => d.name === row.domain);
          if (!hit) throw new Error(made.j?.message || `Resend said ${made.status}`);
          resendId = hit.id;
        }
      }
      let d = await r.get(resendId);
      if (d.status === 404) { resendId = ""; throw new Error("The email domain was removed from Resend. Check again to re-create it."); }
      if (!d.ok) throw new Error(d.j?.message || `Resend said ${d.status}`);
      if (d.j.status !== "verified") { await r.verify(resendId); d = await r.get(resendId); }
      for (const rec of (d.j.records as { type: string; name: string; value: string; priority?: number; status: string }[] | undefined) ?? [])
        if (rec.type !== "MX" || rec.priority !== 0 || rec.name !== "") // skip the optional "receiving" record
          records.push({ purpose: "email", type: rec.type, host: rec.name || "@", value: rec.value, ...(rec.priority != null ? { priority: rec.priority } : {}), status: rec.status });
      mailStatus = d.j.status === "verified" ? "VERIFIED" : d.j.status === "failed" ? "ERROR" : "PENDING";
      if (d.j.status === "failed") errors.push("Email: the records weren't found. Check they match exactly, then check again.");
    } catch (e) { mailStatus = "ERROR"; errors.push(`Email: ${e instanceof Error ? e.message : "could not reach Resend"}`); }
  } else errors.push("Email: the platform hasn't been connected to Resend yet.");

  await db.prepare("UPDATE shop_domains SET web_status=?, mail_status=?, resend_domain_id=?, records_json=?, last_checked_at=?, last_error=?, updated_at=? WHERE shop_id=?")
    .bind(webStatus, mailStatus, resendId, JSON.stringify(records), now, errors.join(" ").slice(0, 600), now, shopId).run();
  clearDomainCache();
  return readDomain(db, shopId);
}

/** Take the domain out of both providers (best effort) and forget it. */
export async function removeDomain(db: DB, shopId: string) {
  const row = await readDomain(db, shopId);
  if (!row) return;
  const cfg = domainsConfigured();
  if (cfg.vercel) await vercel().remove(row.domain).catch(() => null);
  if (cfg.resend && row.resend_domain_id) await resend().remove(row.resend_domain_id).catch(() => null);
  await db.prepare("DELETE FROM shop_domains WHERE shop_id=?").bind(shopId).run();
  clearDomainCache();
}

/** Called from the 5-minute sweep: finish pending ones, and re-check live ones every few hours so a broken DNS record falls back to foliyo. */
export async function sweepDomains(db: DB, now = Date.now()) {
  if (!domainsConfigured().vercel && !domainsConfigured().resend) return 0;
  const due = (await db.prepare(
    `SELECT shop_id FROM shop_domains
      WHERE (web_status<>'VERIFIED' OR mail_status<>'VERIFIED') AND last_checked_at<?
         OR last_checked_at<?
      ORDER BY last_checked_at LIMIT 10`,
  ).bind(now - 4 * 60000, now - 6 * 3600000).all<{ shop_id: string }>()).results;
  for (const d of due) await refreshDomain(db, d.shop_id, now).catch(() => null);
  return due.length;
}

// ---- Routes (Settings -> Your web address) ------------------------------------------------------
const view = async (db: DB, shopId: string, shopSlug: string | null, origin: string) => {
  const row = await readDomain(db, shopId);
  const cfg = domainsConfigured();
  return {
    allowed: await customDomainAllowed(db, shopId),
    configured: cfg.vercel && cfg.resend,
    foliyo_url: shopSlug ? shopOrigin(shopSlug, origin) : "",
    domain: row
      ? { domain: row.domain, web: row.web_status, mail: row.mail_status, records: JSON.parse(row.records_json || "[]") as DomainRecord[], error: row.last_error, checked_at: row.last_checked_at, url: customOrigin(row.domain), live: row.web_status === "VERIFIED" }
      : null,
  };
};

export function mountDomains(app: Hono<any>, h: Helpers) {
  const origin = (c: Ctx) => new URL(c.req.url).origin;
  const slugOf = async (c: Ctx) => (await c.env.DB.prepare("SELECT slug FROM shops WHERE id=?").bind(c.get("shopId")).first()) as { slug: string | null } | null;

  app.get("/domain", async (c) => {
    h.requireRole(c, ["OWNER"]);
    return c.json(await view(c.env.DB, c.get("shopId"), (await slugOf(c))?.slug ?? null, origin(c)));
  });

  app.put("/domain", async (c) => {
    h.requireRole(c, ["OWNER"]);
    const db: DB = c.env.DB;
    const shopId: string = c.get("shopId");
    const b = await h.input(c, z.object({ domain: z.string().max(300) }).strict());
    if (!(await customDomainAllowed(db, shopId))) h.fail(403, "Your own web address isn't part of your plan yet. Contact foliyo to switch it on.");
    const cfg = domainsConfigured();
    if (!cfg.vercel || !cfg.resend) h.fail(503, "Your own web address isn't switched on for the platform yet. foliyo will let you know when it is.");
    const n = normaliseDomain(b.domain);
    if (!n.ok) h.fail(400, n.error);
    const domain = (n as { ok: true; domain: string }).domain;

    const mine = await readDomain(db, shopId);
    if (mine && mine.domain !== domain) await removeDomain(db, shopId);
    const other = await db.prepare("SELECT shop_id, web_status FROM shop_domains WHERE domain=? AND shop_id<>?").bind(domain, shopId).first<{ shop_id: string; web_status: string }>();
    if (other) {
      // A live domain belongs to its shop. An unfinished claim never blocks the person who really owns the domain.
      if (other.web_status === "VERIFIED") h.fail(409, "That web address is already in use by another shop.");
      await removeDomain(db, other.shop_id);
    }
    if (!mine || mine.domain !== domain) {
      const now = Date.now();
      await db.batch([
        db.prepare("INSERT INTO shop_domains(shop_id,domain,created_at,updated_at) VALUES(?,?,?,?)").bind(shopId, domain, now, now),
        h.audit(c, "shop", shopId, "DOMAIN_ADDED", `Connected ${domain}.`),
      ]);
    }
    await refreshDomain(db, shopId);
    return c.json(await view(db, shopId, (await slugOf(c))?.slug ?? null, origin(c)));
  });

  app.post("/domain/check", async (c) => {
    h.requireRole(c, ["OWNER"]);
    const db: DB = c.env.DB;
    const shopId: string = c.get("shopId");
    const row = await readDomain(db, shopId);
    if (!row) h.fail(404, "No web address connected yet.");
    if (Date.now() - row!.last_checked_at < 8000) return c.json(await view(db, shopId, (await slugOf(c))?.slug ?? null, origin(c)));
    await refreshDomain(db, shopId);
    return c.json(await view(db, shopId, (await slugOf(c))?.slug ?? null, origin(c)));
  });

  app.delete("/domain", async (c) => {
    h.requireRole(c, ["OWNER"]);
    const db: DB = c.env.DB;
    const shopId: string = c.get("shopId");
    const row = await readDomain(db, shopId);
    if (row) {
      await removeDomain(db, shopId);
      await db.batch([h.audit(c, "shop", shopId, "DOMAIN_REMOVED", `Disconnected ${row.domain}. Customers use the foliyo address again.`)]);
    }
    return c.json(await view(db, shopId, (await slugOf(c))?.slug ?? null, origin(c)));
  });
}
