import { testAuthEnabled, clientIp } from "./security";
import { Hono, type Context } from "hono";
import { drain, enqueue, msgShop, platformSender, providerStatus } from "./messaging";
import { platformBilling } from "./billing";
import { acceptanceStatements, ipHash, outstandingFor, LEGAL_VERSIONS, OWNER_DOCS, STAFF_DOCS, type LegalDoc } from "./legal";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { Database } from "../db/client";
import { z } from "zod";
import { demoRoute } from "./demo";
import { slugSchema, smsSenderFor } from "./domain";
import { RESERVED_SUBDOMAINS, SHOP_HOST_HEADER, rootHost, sessionCookieDomain, shopOrigin } from "./hosts";

export type Account = {
  id: string;
  user_id: string;
  shop_id: string;
  name: string;
  email: string;
  role: "OWNER" | "MANAGER" | "RECEPTION" | "BARBER";
  staff_id: string | null;
  version: number;
  // Small per-user UI preferences (calendar density …). Raw JSON text; parsed on the client.
  prefs_json?: string;
  // When the login email was confirmed via the welcome / confirm-email link; null until then.
  email_verified_at?: number | null;
  // Staff onboarding (non-owners): when they finished the first-sign-in flow; null until then.
  onboarded_at?: number | null;
};
export type AppEnv = {
  Bindings: { DB: Database; APP_MODE?: string; ALLOWED_ORIGINS?: string; DEMO_ENABLED?: string; FOLIYO_ADMIN_EMAILS?: string; OLLO_ADMIN_EMAILS?: string };
  Variables: { shopId: string; actor: string; account: Account | null };
};
type Ctx = Context<AppEnv>;
export const ACCOUNT_COOKIE = "ollo_session";
// Same-origin guard for every write. Development proxies (preview wrappers, HTTPS
// tunnels) rewrite Host, so the forwarded host/proto and an explicit sandbox-only
// allow-list also count as "this site". Cross-site origins are always refused.
export function sameOrigin(c: { req: { url: string; header(k: string): string | undefined }; env: { ALLOWED_ORIGINS?: string } }): boolean {
  const actual = new URL(c.req.url).origin;
  const origin = c.req.header("origin");
  const allowed = new Set([actual]);
  // Only the deployment's trusted proxy may supply the external host.
  if (process.env.VERCEL) {
    const host = c.req.header("x-forwarded-host");
    if (host && /^[a-z0-9.-]+(?::[0-9]+)?$/i.test(host)) allowed.add(`https://${host}`);
  }
  for (const value of (c.env.ALLOWED_ORIGINS || "").split(",")) {
    try { if (value.trim()) allowed.add(new URL(value.trim()).origin); } catch { /* no wildcards */ }
  }
  if (origin) return allowed.has(origin);
  const ref = c.req.header("referer");
  try { return !!ref && allowed.has(new URL(ref).origin); } catch { return false; }
}
const LEGACY_COOKIES = ["barbershop_account", "barbershop_test_session"];
const uid = () => crypto.randomUUID();
export const digest = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
const reject = (
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429,
  message: string,
): never => {
  throw new HTTPException(status, { message });
};
export async function readInput<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16384) {
          await reader.cancel();
          reject(413, "Request is too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return reject(400, "Invalid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return reject(
      400,
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  return parsed.data;
}
// Versioned hashes support gradual upgrades without invalidating existing accounts.
async function derivePasswordHash(password: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return [...new Uint8Array(bits)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export async function passwordHash(password: string, salt: string) {
  return `pbkdf2-sha256$600000$${await derivePasswordHash(password, salt, 600000)}`;
}
export async function matches(password: string, user: { password_hash: string; password_salt: string } | null) {
  const stored = user?.password_hash || "";
  const modern = /^pbkdf2-sha256\$600000\$([a-f0-9]{64})$/.exec(stored);
  const legacy = /^[a-f0-9]{64}$/.test(stored);
  const expected = modern?.[1] || (legacy ? stored : "0".repeat(64));
  const actual = await derivePasswordHash(password, user?.password_salt || "unknown-account-constant-salt", legacy ? 100000 : 600000);
  let delta = 0;
  for (let i = 0; i < 64; i++) delta |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return !!user && !!(modern || legacy) && delta === 0;
}
// Per-identity cap always; the global cap guards password guessing on login only (a busy
// launch day must not lock out new shops).
export async function throttle(c: Ctx, action: string, identity: string) {
  const now = Date.now();
  const limits: [string, number][] = [[`${action}:${identity}`, 12]];
  if (action === "login") {
    limits.push([`${action}:global`, 180]);
    // Per-IP cap too, so one host cannot spray many emails at 12 attempts each.
    const ip = clientIp(c.req);
    if (ip) limits.push([`${action}:ip:${ip}`, Number(process.env.LOGIN_IP_LIMIT) || 60]);
  }
  if (action === "signup") {
    const ip = clientIp(c.req);
    // SIGNUP_IP_LIMIT raises the cap for test runners that create hundreds of shops from one host.
    const cap = Number(process.env.SIGNUP_IP_LIMIT) || 60;
    if (ip) limits.push([`${action}:ip:${ip}`, cap]);
  }
  for (const [key, max] of limits) {
    const row = await c.env.DB.prepare(
      `INSERT INTO auth_throttle(key_hash,attempts,resets_at) VALUES(?,1,?) ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN auth_throttle.resets_at<=? THEN 1 ELSE auth_throttle.attempts+1 END,resets_at=CASE WHEN auth_throttle.resets_at<=? THEN excluded.resets_at ELSE auth_throttle.resets_at END RETURNING attempts`,
    )
      .bind(await digest(key), now + 600000, now, now)
      .first<{ attempts: number }>();
    if (row!.attempts > max) {
      c.header("Retry-After", "600");
      reject(429, "Too many attempts. Wait ten minutes before retrying.");
    }
  }
}
export async function resolveAccount(
  c: Ctx,
  token: string,
): Promise<Account | null> {
  // On a shop's sub-domain the session must belong to that shop: a cookie shared across
  // *.foliyo.co.uk never opens another shop's workspace. Platform admin routes (/api/admin) are
  // served on the root host and are unaffected.
  const hostSlug = c.req.header(SHOP_HOST_HEADER) || "";
  return c.env.DB.prepare(
    `SELECT m.id,m.user_id,m.shop_id,m.role,m.staff_id,m.version,m.prefs_json,m.onboarded_at,u.name,u.email,u.email_verified_at FROM app_sessions s JOIN app_memberships m ON m.id=s.membership_id JOIN app_users u ON u.id=m.user_id JOIN shops sh ON sh.id=m.shop_id LEFT JOIN staff b ON b.shop_id=m.shop_id AND b.id=m.staff_id WHERE s.token_hash=? AND s.expires_at>? AND m.active=1 AND (m.role='OWNER' OR b.active=1)${hostSlug ? " AND sh.slug=?" : ""}`,
  )
    .bind(...(hostSlug ? [await digest(token), Date.now(), hostSlug] : [await digest(token), Date.now()]))
    .first<Account>();
}
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12, "Use at least 12 characters").max(128);
const credentials = z
  .object({ email, password: z.string().min(1).max(128) })
  .strict();
const registration = z
  .object({ email, password, name: z.string().trim().min(2).max(100) })
  .strict();
function owner(c: Ctx) {
  const a = c.get("account");
  if (!a || a.role !== "OWNER") return reject(403, "Owner account required");
  return a;
}
function member(c: Ctx) {
  const a = c.get("account");
  if (!a) return reject(401, "Account sign-in required");
  return a;
}
function event(
  c: Ctx,
  shop: string,
  actor: string,
  entity: string,
  action: string,
) {
  return c.env.DB.prepare(
    "INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).bind(
    uid(),
    shop,
    "account",
    entity,
    action,
    actor,
    "Account access change.",
    Date.now(),
  );
}
export async function newSession(
  c: Ctx,
  membership: string,
  expectedHash: string | null = null,
  version = 0,
) {
  const raw = uid() + uid();
  const hash = await digest(raw);
  return {
    raw,
    write: c.env.DB.prepare(
      "INSERT INTO app_sessions(token_hash,membership_id,created_at,expires_at) SELECT ?,m.id,?,? FROM app_memberships m JOIN app_users u ON u.id=m.user_id LEFT JOIN staff b ON b.shop_id=m.shop_id AND b.id=m.staff_id WHERE m.id=? AND m.version=? AND m.active=1 AND (m.role='OWNER' OR b.active=1) AND (? IS NULL OR u.password_hash=?)",
    ).bind(
      hash,
      Date.now(),
      Date.now() + 7 * 86400000,
      membership,
      version,
      expectedHash,
      expectedHash,
    ),
  };
}
export function cookies(c: Ctx, raw: string) {
  const domain = sessionCookieDomain();
  setCookie(c, ACCOUNT_COOKIE, raw, {
    httpOnly: true,
    secure: true,
    // Lax (not Strict) so the redirect from root signup to <slug>.<root>/workspace carries it.
    sameSite: "Lax",
    path: "/",
    maxAge: 7 * 86400,
    ...(domain ? { domain } : {}),
  });
  for (const name of LEGACY_COOKIES) deleteCookie(c, name, { path: "/", secure: true });
}
const accounts = new Hono<AppEnv>();
export const demoEnabled = (_c: Ctx) => testAuthEnabled();
const timezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown timezone");
const signup = z
  .object({
    shop_name: z.string().trim().min(2).max(100),
    // The shop's address: <slug>.foliyo.co.uk. Chosen at signup so the owner lands on their own
    // sub-domain; unique, validated, reserved words refused. Optional only for legacy callers.
    slug: slugSchema.optional(),
    name: z.string().trim().min(2).max(100),
    email,
    password,
    timezone: timezone.default("Europe/London"),
    kind: z.enum(["BARBER", "HAIR", "SALON"]).default("BARBER"),
    // Explicit agreement to Terms + Privacy + DPA is required to create a shop (the owner becomes
    // a data controller and appoints foliyo as processor). Recorded with version, time, IP hash.
    accept_legal: z.literal(true, { error: "You need to agree to the Terms, Privacy Policy and Data Processing Agreement." }),
  })
  .strict();
// POST /auth/signup — the only way a real shop starts. Creates the shop, the owner's user +
// OWNER membership, and adds the owner as the first bookable barber (most owners cut hair; the
// profile can be deactivated in Team if not). No fictional services or staff are seeded.
// ---- Login-email verification -----------------------------------------------------------------
// One live token per user (issuing a new one retires the old). 24 h, single use, hash stored.
// `owner_welcome` goes out as foliyo (it is the platform welcoming a new customer); `email_verify`
// goes out as the shop (an invited barber confirming the address they joined with, or a re-send).
const VERIFY_TTL = 24 * 3600000;
async function issueEmailVerification(
  c: Ctx,
  user: { id: string; email: string; name: string; shop_id: string },
  kind: "owner_welcome" | "email_verify",
  now = Date.now(),
): Promise<{ stmts: ReturnType<typeof enqueue>; token: string }> {
  const token = uid() + uid();
  const origin = new URL(c.req.url).origin;
  const link = `${origin}/verify?token=${token}`;
  const shop = await msgShop(c, user.shop_id);
  const pb = kind === "owner_welcome" ? await platformBilling(c.env.DB) : null;
  const sender = pb ? platformSender(shop, pb) : shop;
  const vars = kind === "owner_welcome" ? { link, shop: shop.name, trial_days: pb!.trial_days } : { link, email: user.email };
  const stmts = [
    c.env.DB.prepare("UPDATE email_verifications SET used_at=? WHERE user_id=? AND used_at IS NULL").bind(now, user.id),
    c.env.DB.prepare("INSERT INTO email_verifications(token_hash,user_id,email,created_at,expires_at) VALUES(?,?,?,?,?)").bind(await digest(token), user.id, user.email, now, now + VERIFY_TTL),
    ...enqueue(c.env.DB, sender, { email: user.email, name: user.name }, kind, vars, { related: { type: "email_verify", id: user.id }, origin, channel: "EMAIL", now, force: true }),
  ];
  return { stmts, token };
}
// Root-host sign-in helper: "where do I sign in?". A typed shop address resolves instantly; an
// email gets the link mailed (never revealed in the response, so addresses can't be enumerated).
accounts.post("/find-shop", async (c) => {
  const b = await readInput(c, z.object({ slug: z.string().trim().toLowerCase().max(64).default(""), email: z.union([z.literal(""), email]).default("") }).strict());
  await throttle(c, "find-shop", `${c.req.header("x-forwarded-for") || "local"}:${Math.floor(Date.now() / 60000)}`);
  const origin = new URL(c.req.url).origin;
  if (b.slug) {
    const row = await c.env.DB.prepare("SELECT slug FROM shops WHERE slug=?").bind(b.slug.replace(/^https?:\/\//, "").split(".")[0].replace(/[^a-z0-9-]/g, "")).first<{ slug: string }>();
    return c.json(row ? { ok: true, workspace_url: `${shopOrigin(row.slug, origin)}/signin` } : { ok: false, reason: "We couldn't find a shop at that address." });
  }
  if (b.email) {
    const rows = await c.env.DB.prepare("SELECT DISTINCT s.id, s.slug, s.name, u.name AS user_name FROM app_users u JOIN app_memberships m ON m.user_id=u.id AND m.active=1 JOIN shops s ON s.id=m.shop_id WHERE u.email=? AND s.slug IS NOT NULL").bind(b.email).all<{ id: string; slug: string; name: string; user_name: string }>();
    const now = Date.now();
    for (const r of rows.results) {
      const ms = await msgShop(c, r.id);
      const stmts = enqueue(c.env.DB, ms, { email: b.email, name: r.user_name }, "shop_address", { shop: r.name, link: `${shopOrigin(r.slug, origin)}/signin` }, { related: { type: "signin_link", id: r.id }, origin, channel: "EMAIL", now, force: true });
      if (stmts.length) { await c.env.DB.batch(stmts); await drain(c.env.DB, stmts.length, now, { type: "signin_link", id: r.id }).catch(() => {}); }
    }
    return c.json({ ok: true, mailed: true });
  }
  return c.json({ ok: false, reason: "Enter your shop address or email." });
});
// Signup form: is this address free? Public, throttled, no side effects.
accounts.get("/slug-check", async (c) => {
  const raw = (c.req.query("slug") || "").trim().toLowerCase();
  // Typing in the form fires this per keystroke; key the throttle per minute bucket so a genuine
  // signup never trips it while a scraper still does.
  await throttle(c, "slug-check", `${c.req.header("x-forwarded-for") || "local"}:${Math.floor(Date.now() / 60000)}`);
  const parsed = slugSchema.safeParse(raw);
  if (!parsed.success) return c.json({ ok: false, reason: parsed.error.issues[0]?.message || "Letters, numbers and dashes only" });
  if (RESERVED_SUBDOMAINS.has(raw)) return c.json({ ok: false, reason: "That address is reserved" });
  const taken = await c.env.DB.prepare("SELECT 1 AS x FROM shops WHERE slug=?").bind(raw).first();
  return c.json({ ok: !taken, reason: taken ? "Already taken" : "", host: rootHost() ? `${raw}.${rootHost()}` : "" });
});
accounts.post("/signup", async (c) => {
  const b = await readInput(c, signup);
  if (c.get("account")) return reject(409, "You are already signed in. Sign out first to create another shop.");
  await throttle(c, "signup", b.email);
  const existing = await c.env.DB.prepare("SELECT 1 AS x FROM app_users WHERE email=?").bind(b.email).first();
  if (existing) return reject(409, "An account with this email already exists. Sign in instead.");
  if (b.slug) {
    if (RESERVED_SUBDOMAINS.has(b.slug)) return reject(409, "That address is reserved. Try another.");
    const taken = await c.env.DB.prepare("SELECT 1 AS x FROM shops WHERE slug=?").bind(b.slug).first();
    if (taken) return reject(409, "That address is already taken. Try another.");
  }
  const shop = uid(),
    user = uid(),
    membership = uid(),
    staffId = uid(),
    salt = uid() + uid(),
    now = Date.now();
  const encoded = await passwordHash(b.password, salt);
  const session = await newSession(c, membership);
  const writes = [
    // Every shop texts under its own name from day one (alphanumeric sender, editable in Settings → Messages).
    c.env.DB.prepare("INSERT INTO shops(id,name,timezone,kind,email,setup_json,created_at,slug,msg_sms_sender) VALUES(?,?,?,?,?,?,?,?,?)").bind(shop, b.shop_name, b.timezone, b.kind, b.email, JSON.stringify({ step: "shop", done: [], skipped: [], started_at: now }), now, b.slug ?? null, smsSenderFor(b.shop_name)),
    c.env.DB.prepare("INSERT INTO app_users(id,email,name,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?)").bind(user, b.email, b.name, encoded, salt, now),
    c.env.DB.prepare("INSERT INTO shop_owners(shop_id,user_id) VALUES(?,?)").bind(shop, user),
    c.env.DB.prepare("INSERT INTO staff(id,shop_id,name,role,title,start_date) VALUES(?,?,?,?,?,?)").bind(staffId, shop, b.name, "Owner", "Owner & barber", new Date(now).toISOString().slice(0, 10)),
    // The owner's barber profile is not bound to the membership: owners see the whole shop, and a
    // bound profile would block inviting someone else onto it. Linking comes with "my day" later.
    c.env.DB.prepare("INSERT INTO app_memberships(id,shop_id,user_id,role) VALUES(?,?,?,'OWNER')").bind(membership, shop, user),
  ];
  // Default week: Mon–Sat 09:00–18:00, closed Sunday (matches the shop defaults).
  for (let day = 0; day < 7; day++)
    writes.push(
      c.env.DB.prepare("INSERT INTO staff_hours(shop_id,staff_id,weekday,enabled,starts,ends,break_start,break_end) VALUES(?,?,?,?,540,1080,780,780)").bind(shop, staffId, day, day === 0 ? 0 : 1),
    );
  writes.push(
    session.write,
    c.env.DB.prepare("INSERT INTO account_assertions(ok) VALUES(changes())"),
    c.env.DB.prepare("DELETE FROM account_assertions"),
    c.env.DB.prepare(
      "INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(uid(), shop, "shop", shop, "SHOP_CREATED", `user:${user}`, "Shop created at signup.", now),
    event(c, shop, `user:${user}`, user, "OWNER_ACCOUNT_CREATED"),
    ...acceptanceStatements(c.env.DB, c, { user_id: user, shop_id: shop, subject: "OWNER" }, OWNER_DOCS, { ip_hash: await ipHash(c), now }),
    event(c, shop, `user:${user}`, user, "LEGAL_ACCEPTED"),
  );
  await c.env.DB.batch(writes);
  // Welcome + confirm-email, after the shop exists (msgShop reads it). A mail failure must never
  // fail the signup: the workspace nudge offers a re-send.
  let sandboxToken: string | undefined;
  try {
    const v = await issueEmailVerification(c, { id: user, email: b.email, name: b.name, shop_id: shop }, "owner_welcome", now);
    await c.env.DB.batch(v.stmts);
    await drain(c.env.DB, 2, now, { type: "email_verify", id: user }).catch(() => {});
    if (providerStatus().email.provider === "mailbox" && demoEnabled(c)) sandboxToken = v.token;
  } catch (e) {
    console.error("welcome email failed", e instanceof Error ? e.message : e);
  }
  cookies(c, session.raw);
  // Where the owner works from now on: their own sub-domain (when the platform has a root host).
  const origin = new URL(c.req.url).origin;
  const workspace = b.slug ? `${shopOrigin(b.slug, origin)}/workspace` : `${origin}/workspace`;
  return c.json({ ok: true, shop_id: shop, slug: b.slug ?? null, workspace_url: workspace, cross_host_session: !!sessionCookieDomain(), ...(sandboxToken ? { sandbox_verify_token: sandboxToken } : {}) }, 201);
});
accounts.post("/login", async (c) => {
  const b = await readInput(c, credentials);
  await throttle(c, "login", b.email);
  const u = await c.env.DB.prepare(
    "SELECT id,password_hash,password_salt FROM app_users WHERE email=?",
  )
    .bind(b.email)
    .first<{ id: string; password_hash: string; password_salt: string }>();
  const valid = await matches(b.password, u);
  // On a shop's sub-domain only that shop's team can sign in; on the root host (local dev, legacy)
  // the first active membership wins as before.
  const hostSlug = c.req.header(SHOP_HOST_HEADER) || "";
  const m = u
    ? await c.env.DB.prepare(
        `SELECT m.id,m.shop_id,m.version,s.slug FROM app_memberships m JOIN shops s ON s.id=m.shop_id LEFT JOIN staff b ON b.shop_id=m.shop_id AND b.id=m.staff_id WHERE m.user_id=? AND m.active=1 AND (m.role='OWNER' OR b.active=1)${hostSlug ? " AND s.slug=?" : ""} ORDER BY m.role='OWNER' DESC LIMIT 1`,
      )
        .bind(...(hostSlug ? [u.id, hostSlug] : [u.id]))
        .first<{ id: string; shop_id: string; version: number; slug: string | null }>()
    : null;
  if (valid && u && !m && hostSlug) {
    // Right password, wrong shop address: point them at theirs rather than a bare 401.
    const theirs = await c.env.DB.prepare("SELECT s.slug FROM app_memberships m JOIN shops s ON s.id=m.shop_id WHERE m.user_id=? AND m.active=1 AND s.slug IS NOT NULL ORDER BY m.role='OWNER' DESC LIMIT 1").bind(u.id).first<{ slug: string }>();
    if (theirs?.slug) return c.json({ error: "wrong_shop", message: `Your account belongs to a different shop. Sign in at ${theirs.slug}.${rootHost()}.`, workspace_url: `${shopOrigin(theirs.slug, new URL(c.req.url).origin)}/workspace` }, 403);
  }
  if (!valid || !m || !u)
    return reject(401, "Unable to sign in with these details");
  if (!u.password_hash.startsWith("pbkdf2-sha256$")) {
    const upgraded = await passwordHash(b.password, u.password_salt);
    const r = await c.env.DB.prepare("UPDATE app_users SET password_hash=? WHERE id=? AND password_hash=?").bind(upgraded, u.id, u.password_hash).run();
    if (!r.meta.changes) return reject(409, "Account changed. Sign in again.");
    u.password_hash = upgraded;
  }
  const session = await newSession(c, m.id, u.password_hash, m.version);
  const old = getCookie(c, ACCOUNT_COOKIE);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM app_sessions WHERE token_hash=?").bind(
      old ? await digest(old) : "",
    ),
    session.write,
    c.env.DB.prepare("INSERT INTO account_assertions(ok) VALUES(changes())"),
    c.env.DB.prepare("DELETE FROM account_assertions"),
    event(c, m.shop_id, `user:${u.id}`, u.id, "ACCOUNT_SIGNED_IN"),
  ]);
  cookies(c, session.raw);
  return c.json({ ok: true });
});
accounts.post("/demo", async (c) => {
  if (!demoEnabled(c)) return reject(404, "The demo is not enabled on this deployment");
  return demoRoute(c);
});
accounts.post("/logout", async (c) => {
  await readInput(c, z.object({}).strict());
  const token = getCookie(c, ACCOUNT_COOKIE);
  if (token)
    await c.env.DB.prepare("DELETE FROM app_sessions WHERE token_hash=?")
      .bind(await digest(token))
      .run();
  deleteCookie(c, ACCOUNT_COOKIE, { path: "/", secure: true, ...(sessionCookieDomain() ? { domain: sessionCookieDomain() } : {}) });
  for (const name of LEGACY_COOKIES) deleteCookie(c, name, { path: "/", secure: true });
  return c.json({ ok: true });
});
accounts.get("/me", (c) =>
  c.json({ account: c.get("account") || null, demo: demoEnabled(c) }),
);
// Owners and managers see the team's access; only owners change roles or transfer ownership.
function managerOrOwner(c: Ctx) {
  const a = c.get("account");
  if (!a || !["OWNER", "MANAGER"].includes(a.role)) return reject(403, "Owner or manager account required");
  return a;
}
accounts.get("/access", async (c) => {
  const a = managerOrOwner(c);
  const [members, invitations] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT m.id,m.role,m.staff_id,m.active,m.version,m.onboarded_at,u.name,u.email FROM app_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.shop_id=? ORDER BY u.name",
    ).bind(a.shop_id),
    c.env.DB.prepare(
      "SELECT id,staff_id,email,phone,role,channel,sent_count,last_sent_at,expires_at,accepted_at,revoked,created_at FROM staff_invitations WHERE shop_id=? ORDER BY created_at DESC LIMIT 100",
    ).bind(a.shop_id),
  ]);
  return c.json({ members: members.results, invitations: invitations.results, providers: providerStatus() });
});
// UK mobile → E.164, or null.
const ukMobile = (raw: string) => {
  const d = raw.replace(/[^\d+]/g, "");
  if (/^07\d{9}$/.test(d)) return `+44${d.slice(1)}`;
  if (/^\+447\d{9}$/.test(d)) return d;
  if (/^447\d{9}$/.test(d)) return `+${d}`;
  return null;
};
// Link returned to the owner's UI for copying. Built on the request origin (the owner is already
// on their shop's host in production, so it matches the emailed link there).
async function inviteLink(c: Ctx, _shopId: string, token: string) {
  return `${new URL(c.req.url).origin}/workspace?invite=${token}`;
}
// Deliver (or re-deliver) an invitation on the requested channel. Returns what actually went out.
async function sendInvite(c: Ctx, shopId: string, inviterUserId: string, inv: { id: string; email: string; phone: string; role: string; channel: string }, token: string) {
  const ms = await msgShop(c, shopId);
  const origin = new URL(c.req.url).origin;
  const inviter = await c.env.DB.prepare("SELECT name FROM app_users WHERE id=?").bind(inviterUserId).first<{ name: string }>();
  const vars = { inviter: inviter?.name || ms.name, role: inv.role.charAt(0) + inv.role.slice(1).toLowerCase(), link: `${ms.slug ? shopOrigin(ms.slug, origin) : origin}/workspace?invite=${token}` };
  const opts = { related: { type: "invite", id: inv.id }, origin, force: true as const };
  const stmts = [
    ...(inv.channel === "EMAIL" || inv.channel === "BOTH" ? enqueue(c.env.DB, ms, { email: inv.email }, "staff_invite", vars, { ...opts, channel: "EMAIL" }) : []),
    ...((inv.channel === "SMS" || inv.channel === "BOTH") && inv.phone ? enqueue(c.env.DB, ms, { phone: inv.phone }, "staff_invite", vars, { ...opts, channel: "SMS" }) : []),
  ];
  if (stmts.length) {
    await c.env.DB.batch(stmts);
    await drain(c.env.DB, stmts.length, Date.now(), { type: "invite", id: inv.id }).catch(() => {});
  }
  const ps = providerStatus();
  const sent: string[] = [];
  if ((inv.channel === "EMAIL" || inv.channel === "BOTH") && ps.email.provider !== "mailbox") sent.push("email");
  if ((inv.channel === "SMS" || inv.channel === "BOTH") && inv.phone && ps.sms.provider !== "mailbox") sent.push("sms");
  return { sent, queued: stmts.length };
}
// Invite someone onto a team profile. channel: EMAIL (default), SMS, BOTH, or LINK (nothing sent —
// the owner shares the link themselves, e.g. WhatsApp). The link is always returned once.
accounts.post("/invites", async (c) => {
  const a = managerOrOwner(c);
  const b = await readInput(
    c,
    z
      .object({
        email: z.union([z.literal(""), email]).default(""),
        phone: z.string().trim().max(20).default(""),
        staff_id: z.string().uuid(),
        role: z.enum(["MANAGER", "RECEPTION", "BARBER"]),
        channel: z.enum(["EMAIL", "SMS", "BOTH", "LINK"]).default("EMAIL"),
      })
      .strict(),
  );
  if (b.role === "MANAGER" && a.role !== "OWNER") return reject(403, "Only the owner can invite a manager");
  const phone = b.phone ? ukMobile(b.phone) : "";
  if (b.phone && !phone) return reject(400, "Enter a UK mobile number (07… or +447…)");
  if (!b.email && !phone) return reject(400, "Add an email address or a mobile number");
  if ((b.channel === "EMAIL" || b.channel === "BOTH") && !b.email) return reject(400, "An email address is needed to invite by email");
  if ((b.channel === "SMS" || b.channel === "BOTH") && !phone) return reject(400, "A mobile number is needed to invite by text");
  const staff = await c.env.DB.prepare(
    "SELECT id FROM staff WHERE shop_id=? AND id=? AND active=1",
  )
    .bind(a.shop_id, b.staff_id)
    .first();
  if (!staff) return reject(404, "Active staff profile not found");
  if (
    await c.env.DB.prepare(
      "SELECT id FROM app_memberships WHERE shop_id=? AND staff_id=?",
    )
      .bind(a.shop_id, b.staff_id)
      .first()
  )
    return reject(409, "This staff profile already has an account");
  const token = uid() + uid(),
    id = uid(),
    now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE staff_invitations SET revoked=1 WHERE shop_id=? AND staff_id=? AND accepted_at IS NULL",
    ).bind(a.shop_id, b.staff_id),
    c.env.DB.prepare(
      "INSERT INTO staff_invitations(id,shop_id,staff_id,email,phone,role,channel,token_hash,expires_at,created_at,sent_count,last_sent_at,invited_by) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)",
    ).bind(id, a.shop_id, b.staff_id, b.email || `${phone}@sms.invite`, phone || "", b.role, b.channel, await digest(token), now + 7 * 86400000, now, now, `user:${a.user_id}`),
    event(c, a.shop_id, `user:${a.user_id}`, id, "STAFF_INVITED"),
  ]);
  const delivery = await sendInvite(c, a.shop_id, a.user_id, { id, email: b.email, phone: phone || "", role: b.role, channel: b.channel }, token);
  return c.json({ id, token, link: await inviteLink(c, a.shop_id, token), expires_in_hours: 7 * 24, delivery: delivery.sent.length ? delivery.sent.join("+") : "manual", sent: delivery.sent }, 201);
});
// Send it again (same channel by default, or a different one). Issues a fresh token — the old link
// stops working — so a lost email doesn't leave a live link lying around.
accounts.post("/invites/:id/resend", async (c) => {
  const a = managerOrOwner(c);
  const b = await readInput(c, z.object({ channel: z.enum(["EMAIL", "SMS", "BOTH", "LINK"]).optional() }).strict());
  const inv = await c.env.DB.prepare("SELECT * FROM staff_invitations WHERE id=? AND shop_id=? AND accepted_at IS NULL AND revoked=0").bind(c.req.param("id"), a.shop_id).first<{ id: string; email: string; phone: string; role: string; channel: string; sent_count: number; last_sent_at: number | null }>();
  if (!inv) return reject(404, "Pending invitation not found");
  if (inv.last_sent_at && Date.now() - inv.last_sent_at < 60000) return reject(429, "Just sent — wait a minute before resending");
  if (inv.sent_count >= 10) return reject(429, "This invitation has been sent 10 times. Revoke it and create a new one.");
  const channel = b.channel || inv.channel;
  const token = uid() + uid(), now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE staff_invitations SET token_hash=?, expires_at=?, channel=?, sent_count=sent_count+1, last_sent_at=? WHERE id=?").bind(await digest(token), now + 7 * 86400000, channel, now, inv.id),
    event(c, a.shop_id, `user:${a.user_id}`, inv.id, "STAFF_INVITE_RESENT"),
  ]);
  const email = inv.email.endsWith("@sms.invite") ? "" : inv.email;
  const delivery = await sendInvite(c, a.shop_id, a.user_id, { id: inv.id, email, phone: inv.phone, role: inv.role, channel }, token);
  return c.json({ id: inv.id, token, link: await inviteLink(c, a.shop_id, token), expires_in_hours: 7 * 24, delivery: delivery.sent.length ? delivery.sent.join("+") : "manual", sent: delivery.sent }, 201);
});
accounts.post("/invites/:id/revoke", async (c) => {
  const a = managerOrOwner(c);
  await readInput(c, z.object({}).strict());
  const r = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE staff_invitations SET revoked=1 WHERE id=? AND shop_id=? AND accepted_at IS NULL AND revoked=0",
    ).bind(c.req.param("id"), a.shop_id),
    c.env.DB.prepare(
      "INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) SELECT ?,?,'account',?,'INVITATION_REVOKED',?,'Invitation revoked',? WHERE changes()>0",
    ).bind(
      uid(),
      a.shop_id,
      c.req.param("id"),
      `user:${a.user_id}`,
      Date.now(),
    ),
  ]);
  if (!r[0].meta.changes) return reject(404, "Pending invitation not found");
  return c.json({ ok: true });
});
// What an invite link points at, before the person commits to a password: shop name/logo, who
// invited them, role, whether the address is fixed. Public (token is the secret).
accounts.get("/invites/peek", async (c) => {
  const token = c.req.query("token") || "";
  if (token.length < 60) return reject(404, "Invitation not found");
  const inv = await c.env.DB.prepare(
    "SELECT i.email,i.phone,i.role,i.expires_at,i.invited_by,s.name AS staff_name,sh.name AS shop_name,COALESCE(p.logo_url,'') AS logo_url,COALESCE(p.accent,'ollo') AS accent FROM staff_invitations i JOIN staff s ON s.shop_id=i.shop_id AND s.id=i.staff_id JOIN shops sh ON sh.id=i.shop_id LEFT JOIN shop_pages p ON p.shop_id=i.shop_id WHERE i.token_hash=? AND i.revoked=0 AND i.accepted_at IS NULL",
  ).bind(await digest(token)).first<{ email: string; phone: string; role: string; expires_at: number; invited_by: string; staff_name: string; shop_name: string; logo_url: string; accent: string }>();
  if (!inv) return reject(404, "This invitation has been used or withdrawn. Ask the shop for a new one.");
  if (inv.expires_at <= Date.now()) return reject(409, "This invitation has expired. Ask the shop to send it again.");
  const inviter = inv.invited_by.startsWith("user:") ? await c.env.DB.prepare("SELECT name FROM app_users WHERE id=?").bind(inv.invited_by.slice(5)).first<{ name: string }>() : null;
  const smsOnly = inv.email.endsWith("@sms.invite");
  return c.json({ shop_name: inv.shop_name, logo_url: inv.logo_url, accent: inv.accent, staff_name: inv.staff_name, role: inv.role, inviter: inviter?.name || "", email: smsOnly ? "" : inv.email, email_fixed: !smsOnly, phone_hint: inv.phone ? `••••${inv.phone.slice(-3)}` : "", expires_at: inv.expires_at });
});
accounts.post("/accept", async (c) => {
  const b = await readInput(
    c,
    registration.extend({ token: z.string().min(60).max(100), accept_legal: z.literal(true, { error: "You need to agree to the Terms and Privacy Policy." }) }).strict(),
  );
  await throttle(c, "accept", b.email);
  // Email invites are bound to the address they went to; SMS/link invites take whatever address
  // the person signs up with (recorded on the invitation for the audit trail).
  const invite = await c.env.DB.prepare(
    "SELECT i.* FROM staff_invitations i JOIN staff s ON s.shop_id=i.shop_id AND s.id=i.staff_id WHERE i.token_hash=? AND (i.email=? OR i.email LIKE '%@sms.invite') AND i.revoked=0 AND i.accepted_at IS NULL AND i.expires_at>? AND s.active=1",
  )
    .bind(await digest(b.token), b.email, Date.now())
    .first<{ id: string; shop_id: string; staff_id: string; role: string; invited_by: string; email: string }>();
  if (!invite)
    return reject(400, "Invitation is unavailable or details do not match");
  // One email = one shop = one account, by design. A barber at two shops holds two separate accounts.
  if (await c.env.DB.prepare("SELECT 1 AS x FROM app_users WHERE email=?").bind(b.email).first())
    return reject(409, "That email already has an account at another shop. Accounts are one per shop — use a different email for this one.");
  const user = uid(),
    membership = uid(),
    salt = uid() + uid(),
    encoded = await passwordHash(b.password, salt);
  const session = await newSession(c, membership);
  // A user has one shop membership in this local slice; existing emails are not silently linked.
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO app_users(id,email,name,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?)",
    ).bind(user, b.email, b.name, encoded, salt, Date.now()),
    c.env.DB.prepare(
      "INSERT INTO app_memberships(id,shop_id,user_id,role,staff_id) SELECT ?,shop_id,?,role,staff_id FROM staff_invitations WHERE id=? AND token_hash=? AND revoked=0 AND accepted_at IS NULL AND expires_at>?"
    ).bind(
      membership,
      user,
      invite.id,
      await digest(b.token),
      Date.now(),
    ),
    c.env.DB.prepare("INSERT INTO account_assertions(ok) VALUES(changes())"),
    c.env.DB.prepare("DELETE FROM account_assertions"),
    c.env.DB.prepare(
      "UPDATE staff_invitations SET accepted_at=?, email=? WHERE id=? AND accepted_at IS NULL AND revoked=0 AND expires_at>?",
    ).bind(Date.now(), b.email, invite.id, Date.now()),
    session.write,
    c.env.DB.prepare("INSERT INTO account_assertions(ok) VALUES(changes())"),
    c.env.DB.prepare("DELETE FROM account_assertions"),
    event(
      c,
      invite.shop_id,
      `user:${user}`,
      membership,
      "STAFF_INVITATION_ACCEPTED",
    ),
    ...acceptanceStatements(c.env.DB, c, { user_id: user, shop_id: invite.shop_id, subject: "STAFF" }, STAFF_DOCS, { ip_hash: await ipHash(c) }),
  ]);
  // An email invite already proved the address (the token came from that inbox); SMS/link
  // invites did not, so those sign-ups get a confirm-email message.
  const emailInvite = !String(invite.email || "").endsWith("@sms.invite") && invite.email === b.email;
  const now = Date.now();
  if (emailInvite) {
    await c.env.DB.prepare("UPDATE app_users SET email_verified_at=? WHERE id=?").bind(now, user).run();
  } else {
    try {
      const v = await issueEmailVerification(c, { id: user, email: b.email, name: b.name, shop_id: invite.shop_id }, "email_verify", now);
      await c.env.DB.batch(v.stmts);
      await drain(c.env.DB, 2, now, { type: "email_verify", id: user }).catch(() => {});
    } catch (e) {
      console.error("confirm email failed", e instanceof Error ? e.message : e);
    }
  }
  cookies(c, session.raw);
  return c.json({ ok: true }, 201);
});
// Confirm-email link: `GET /verify?token=` (page) → `peek` for the copy, then POST to stamp it.
// Works signed-in or not; on success while signed out the page offers sign-in.
accounts.get("/verify-email/peek", async (c) => {
  const token = c.req.query("token") || "";
  if (token.length < 60) return reject(404, "This confirmation link is not valid.");
  const row = await c.env.DB.prepare("SELECT v.expires_at,v.used_at,v.email,u.email_verified_at FROM email_verifications v JOIN app_users u ON u.id=v.user_id WHERE v.token_hash=?").bind(await digest(token)).first<{ expires_at: number; used_at: number | null; email: string; email_verified_at: number | null }>();
  if (!row) return reject(404, "This confirmation link is not valid.");
  if (row.used_at) return row.email_verified_at ? c.json({ ok: true, already: true, email: row.email }) : reject(404, "This confirmation link has been replaced by a newer one. Use the latest email.");
  if (row.expires_at <= Date.now()) return reject(409, "This confirmation link has expired. Sign in and ask for a new one.");
  return c.json({ ok: true, already: false, email: row.email });
});
accounts.post("/verify-email", async (c) => {
  const b = await readInput(c, z.object({ token: z.string().min(60).max(100) }).strict());
  await throttle(c, "verify", b.token.slice(0, 16));
  const now = Date.now();
  const hash = await digest(b.token);
  const row = await c.env.DB.prepare("SELECT v.user_id,v.email,v.expires_at,v.used_at,u.email AS current_email,m.shop_id FROM email_verifications v JOIN app_users u ON u.id=v.user_id LEFT JOIN app_memberships m ON m.user_id=u.id AND m.active=1 WHERE v.token_hash=?").bind(hash).first<{ user_id: string; email: string; expires_at: number; used_at: number | null; current_email: string; shop_id: string | null }>();
  if (!row || row.used_at || row.expires_at <= now) return reject(409, "This confirmation link is no longer valid. Sign in and ask for a new one.");
  // The link confirms the address it was sent to; if the login email changed since, it proves nothing.
  if (row.email.toLowerCase() !== row.current_email.toLowerCase()) return reject(409, "Your sign-in email has changed since this link was sent. Ask for a new one.");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE email_verifications SET used_at=? WHERE token_hash=? AND used_at IS NULL").bind(now, hash),
    c.env.DB.prepare("UPDATE app_users SET email_verified_at=COALESCE(email_verified_at,?) WHERE id=?").bind(now, row.user_id),
    ...(row.shop_id ? [event(c, row.shop_id, `user:${row.user_id}`, row.user_id, "EMAIL_VERIFIED")] : []),
  ]);
  return c.json({ ok: true, email: row.email, signed_in: !!c.get("account") });
});
// Re-send from the workspace nudge. Signed-in only; 1/min per user; a fresh token each time.
accounts.post("/verify-email/resend", async (c) => {
  await readInput(c, z.object({}).strict());
  const a = member(c);
  if (a.email_verified_at) return c.json({ ok: true, already: true });
  const now = Date.now();
  const last = await c.env.DB.prepare("SELECT created_at FROM email_verifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1").bind(a.user_id).first<{ created_at: number }>();
  if (last && now - Number(last.created_at) < 60000) {
    c.header("Retry-After", "60");
    return reject(429, "A confirmation email went out less than a minute ago. Check your inbox (and spam), then try again.");
  }
  const v = await issueEmailVerification(c, { id: a.user_id, email: a.email, name: a.name, shop_id: a.shop_id }, a.role === "OWNER" ? "owner_welcome" : "email_verify", now);
  await c.env.DB.batch(v.stmts);
  await drain(c.env.DB, 2, now, { type: "email_verify", id: a.user_id }).catch(() => {});
  const ps = providerStatus();
  return c.json({ ok: true, delivery: ps.email.provider === "mailbox" ? [] : ["email"], ...(ps.email.provider === "mailbox" && demoEnabled(c) ? { sandbox_token: v.token } : {}) });
});
accounts.put("/members/:id", async (c) => {
  const a = owner(c);
  const b = await readInput(
    c,
    z
      .object({
        role: z.enum(["MANAGER", "RECEPTION", "BARBER"]),
        active: z.number().int().min(0).max(1),
        version: z.number().int().nonnegative(),
      })
      .strict(),
  );
  const writes = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE app_memberships SET role=?,active=?,version=version+1 WHERE id=? AND shop_id=? AND role<>'OWNER' AND version=?",
    ).bind(b.role, b.active, c.req.param("id"), a.shop_id, b.version),
    c.env.DB.prepare("INSERT INTO account_assertions(ok) VALUES(changes())"),
    c.env.DB.prepare("DELETE FROM account_assertions"),
    event(
      c,
      a.shop_id,
      `user:${a.user_id}`,
      c.req.param("id"),
      "MEMBERSHIP_UPDATED",
    ),
    c.env.DB.prepare("DELETE FROM app_sessions WHERE membership_id=?").bind(
      c.req.param("id"),
    ),
  ]);
  if (!writes[0].meta.changes)
    return reject(
      409,
      "Access changed elsewhere or owner is protected. Reload access.",
    );
  return c.json({ ok: true });
});
// Forgot password. Always answers 200 so the form can't be used to discover accounts. Delivery:
// email to the account address, plus SMS to the shop's verified mobile when the account is the
// owner. Token: 30 min, single use; requesting again voids earlier links.
accounts.post("/forgot", async (c) => {
  const b = await readInput(c, z.object({ email }).strict());
  await throttle(c, "forgot", b.email);
  const user = await c.env.DB.prepare(
    "SELECT u.id,u.name,m.shop_id,m.role FROM app_users u JOIN app_memberships m ON m.user_id=u.id WHERE u.email=? AND m.active=1 LIMIT 1",
  ).bind(b.email).first<{ id: string; name: string; shop_id: string; role: string }>();
  const now = Date.now();
  let delivery: string[] = [];
  let sandboxToken: string | undefined;
  if (user) {
    const token = uid() + uid();
    const shop = await msgShop(c, user.shop_id);
    const origin = new URL(c.req.url).origin;
    const link = `${shop.slug ? shopOrigin(shop.slug, origin) : origin}/reset?token=${token}`;
    // msgShop's `phone` is the public shop-page number; the verified owner mobile lives on shops.
    const own = user.role === "OWNER" ? await c.env.DB.prepare("SELECT phone, phone_verified_at FROM shops WHERE id=?").bind(user.shop_id).first<{ phone: string; phone_verified_at: number | null }>() : null;
    const ownerPhone = own?.phone_verified_at ? own.phone : "";
    const stmts = [
      ...enqueue(c.env.DB, shop, { email: b.email, name: user.name }, "password_reset", { link }, { related: { type: "password_reset", id: user.id }, origin, channel: "EMAIL", now, force: true }),
      ...(ownerPhone ? enqueue(c.env.DB, shop, { phone: ownerPhone, name: user.name }, "password_reset", { link }, { related: { type: "password_reset", id: user.id }, origin, channel: "SMS", now, force: true }) : []),
    ];
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL").bind(now, user.id),
      c.env.DB.prepare("INSERT INTO password_resets(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)").bind(await digest(token), user.id, now, now + 30 * 60000),
      ...stmts,
      event(c, user.shop_id, `user:${user.id}`, user.id, "PASSWORD_RESET_REQUESTED"),
    ]);
    if (stmts.length) await drain(c.env.DB, stmts.length, now, { type: "password_reset", id: user.id }).catch(() => {});
    const ps = providerStatus();
    if (ps.email.provider !== "mailbox") delivery.push("email");
    if (ownerPhone && ps.sms.provider !== "mailbox") delivery.push("sms");
    if (!delivery.length && demoEnabled(c)) sandboxToken = token;
  }
  return c.json({ ok: true, delivery, ...(sandboxToken ? { sandbox_token: sandboxToken } : {}) });
});
// Is this reset link still good? (Shown before the new-password form.)
accounts.get("/reset/peek", async (c) => {
  const token = c.req.query("token") || "";
  if (token.length < 60) return reject(404, "This reset link is not valid.");
  const row = await c.env.DB.prepare("SELECT r.expires_at,r.used_at,u.email FROM password_resets r JOIN app_users u ON u.id=r.user_id WHERE r.token_hash=?").bind(await digest(token)).first<{ expires_at: number; used_at: number | null; email: string }>();
  if (!row || row.used_at) return reject(404, "This reset link has already been used. Request a new one.");
  if (row.expires_at <= Date.now()) return reject(409, "This reset link has expired. Request a new one.");
  const [l, d] = row.email.split("@");
  return c.json({ ok: true, email_hint: `${l.slice(0, 2)}•••@${d}`, expires_at: row.expires_at });
});
accounts.post("/reset", async (c) => {
  const b = await readInput(c, z.object({ token: z.string().min(60).max(100), password }).strict());
  await throttle(c, "reset", b.token.slice(0, 16));
  const now = Date.now();
  const row = await c.env.DB.prepare("SELECT r.user_id,r.expires_at,r.used_at,m.id AS membership_id,m.shop_id,m.version FROM password_resets r JOIN app_memberships m ON m.user_id=r.user_id WHERE r.token_hash=? AND m.active=1").bind(await digest(b.token)).first<{ user_id: string; expires_at: number; used_at: number | null; membership_id: string; shop_id: string; version: number }>();
  if (!row || row.used_at || row.expires_at <= now) return reject(409, "This reset link is no longer valid. Request a new one.");
  const salt = uid() + uid();
  const encoded = await passwordHash(b.password, salt);
  const session = await newSession(c, row.membership_id, null, row.version);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE password_resets SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?").bind(now, await digest(b.token), now),
    c.env.DB.prepare("INSERT INTO account_assertions(ok) VALUES(changes())"),
    c.env.DB.prepare("DELETE FROM account_assertions"),
    c.env.DB.prepare("UPDATE app_users SET password_hash=?, password_salt=? WHERE id=?").bind(encoded, salt, row.user_id),
    c.env.DB.prepare("DELETE FROM app_sessions WHERE membership_id IN (SELECT id FROM app_memberships WHERE user_id=?)").bind(row.user_id),
    session.write,
    event(c, row.shop_id, `user:${row.user_id}`, row.user_id, "PASSWORD_RESET"),
  ]);
  cookies(c, session.raw);
  return c.json({ ok: true });
});
// ---- Legal acceptance -------------------------------------------------------------------------
// Which documents this account has agreed to, at which version, and which still need agreeing
// (after a version bump). The workspace shows a re-accept prompt when `outstanding` is non-empty.
accounts.get("/legal/status", async (c) => {
  const a = member(c);
  const required = a.role === "OWNER" ? OWNER_DOCS : STAFF_DOCS;
  const outstanding = await outstandingFor(c.env.DB, a.user_id, required);
  const history = (
    await c.env.DB.prepare("SELECT document, version, accepted_at FROM legal_acceptances WHERE user_id=? ORDER BY accepted_at DESC LIMIT 50").bind(a.user_id).all<{ document: LegalDoc; version: string; accepted_at: number }>()
  ).results;
  return c.json({ required, current: LEGAL_VERSIONS, outstanding, history });
});
accounts.post("/legal/accept", async (c) => {
  const a = member(c);
  const b = await readInput(c, z.object({ documents: z.array(z.enum(["terms", "privacy", "dpa", "cookies"])).min(1).max(4) }).strict());
  const required = a.role === "OWNER" ? OWNER_DOCS : STAFF_DOCS;
  const docs = b.documents.filter((d) => required.includes(d));
  if (!docs.length) return reject(400, "Nothing to accept for your role.");
  await c.env.DB.batch([
    ...acceptanceStatements(c.env.DB, c, { user_id: a.user_id, shop_id: a.shop_id, subject: a.role === "OWNER" ? "OWNER" : "STAFF" }, docs, { ip_hash: await ipHash(c) }),
    event(c, a.shop_id, `user:${a.user_id}`, a.user_id, "LEGAL_ACCEPTED"),
  ]);
  return c.json({ ok: true, outstanding: await outstandingFor(c.env.DB, a.user_id, required) });
});
accounts.post("/password", async (c) => {
  const a = member(c);
  const b = await readInput(
    c,
    z
      .object({ current_password: z.string().min(1).max(128), password })
      .strict(),
  );
  await throttle(c, "password", a.user_id);
  const u = await c.env.DB.prepare(
    "SELECT password_hash,password_salt FROM app_users WHERE id=?",
  )
    .bind(a.user_id)
    .first<{ password_hash: string; password_salt: string }>();
  if (!(await matches(b.current_password, u)))
    return reject(401, "Current password was not accepted");
  const salt = uid() + uid(),
    encoded = await passwordHash(b.password, salt),
    session = await newSession(c, a.id, encoded, a.version);
  const oldHash = u!.password_hash;
  // Transactional optimistic guard: concurrent password changes cannot overwrite each other.
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE app_users SET password_hash=?,password_salt=? WHERE id=? AND password_hash=?",
    ).bind(encoded, salt, a.user_id, oldHash),
    c.env.DB.prepare("INSERT INTO account_assertions(ok) VALUES(changes())"),
    c.env.DB.prepare("DELETE FROM account_assertions"),
    c.env.DB.prepare("DELETE FROM app_sessions WHERE membership_id=?").bind(
      a.id,
    ),
    session.write,
    c.env.DB.prepare("INSERT INTO account_assertions(ok) VALUES(changes())"),
    c.env.DB.prepare("DELETE FROM account_assertions"),
    event(c, a.shop_id, `user:${a.user_id}`, a.user_id, "PASSWORD_CHANGED"),
  ]);
  cookies(c, session.raw);
  return c.json({ ok: true });
});
export default accounts;
