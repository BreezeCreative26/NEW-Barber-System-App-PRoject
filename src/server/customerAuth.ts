// Customer accounts v2: email + password sign-in for the shop's installable app, alongside the
// one-time mobile code (kept as the recovery path and for people who never set a password).
//
// Mounted into the account router at /api/public/shops/:slug/account. The account row is global
// (one person, one login for every shop on foliyo); the session cookie is shop-scoped as before.
//
//   POST /register        name + mobile + email + password → account + session (+ links this shop)
//   POST /login           email + password → session
//   POST /forgot          email → reset link by email (and text, when the shop sends texts)
//   POST /reset           token + new password → session
//   PUT  /password        signed in: current + new
//   GET  /push            VAPID public key + whether this device is subscribed
//   POST /push            save a PushSubscription for this account + shop
//   DELETE /push          remove it
//   GET  /:slug/manifest.webmanifest  (mounted separately) per-shop PWA manifest
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { brandOf, emailSchema, phoneSchema, type Shop } from "./domain";
import { digest, passwordHash, readInput, type AppEnv } from "./accounts";
import { audit, fail } from "./sandbox";
import { drain, enqueue, msgShop } from "./messaging";
import { clientKey, shopBySlug, throttle, type Ctx } from "./public";
import { pushStatus } from "./push";
import { shopUrl, sessionCookieDomain } from "./hosts";

export const CUSTOMER_COOKIE = "ollo_customer";
const uid = () => crypto.randomUUID();
// A year: the installed app should stay signed in. Sessions are still revocable server-side.
export const SESSION_TTL = 365 * 86400000;
const RESET_TTL = 30 * 60000;
const WELCOME_TTL = 24 * 3600000;

export type AccountRow = {
  id: string; phone: string; email: string; name: string; created_at: number; last_seen_at: number; version: number;
  password_hash: string; password_salt: string; email_verified: number; password_set_at: number | null;
};

const COMMON = new Set(["password", "password1", "12345678", "123456789", "qwerty123", "iloveyou", "letmein1", "welcome1", "football", "princess"]);
export const customerPassword = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(128)
  .refine((p) => !COMMON.has(p.toLowerCase()), "That password is too easy to guess");
const requiredEmail = emailSchema.refine((s) => s !== "", "Enter your email address");
// Registration carries the customer's consent choices for this shop. Reminders by email are part of
// having an account; text reminders are offered only when the shop sends texts, and the customer can
// pick email-only (contact_pref EMAIL). Marketing is a separate, off-by-default opt-in (UK GDPR/PECR).
const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: phoneSchema,
  email: requiredEmail,
  password: customerPassword,
  marketing_opt_in: z.union([z.literal(0), z.literal(1)]).default(0),
  contact_pref: z.enum(["AUTO", "EMAIL"]).default("AUTO"),
  // The shop's terms version shown and ticked on the sign-up form (0 when the shop has none).
  accept_terms_version: z.number().int().min(0).default(0),
}).strict();
const loginSchema = z.object({ email: requiredEmail, password: z.string().min(1).max(128) }).strict();
const forgotSchema = z.object({ email: requiredEmail }).strict();
const resetSchema = z.object({ token: z.string().min(40).max(200), password: customerPassword }).strict();
const changeSchema = z.object({ current: z.string().max(128).default(""), password: customerPassword }).strict();
const pushSchema = z.object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().min(20).max(400), auth: z.string().min(10).max(200) }) }).strict();

export function setSession(c: Ctx, raw: string) {
  setCookie(c, CUSTOMER_COOKIE, raw, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL / 1000, ...(sessionCookieDomain() ? { domain: sessionCookieDomain()! } : {}) });
}
export async function openSession(c: Ctx, shop: Shop, account: AccountRow, how: string) {
  const now = Date.now();
  const raw = uid() + uid();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE customer_accounts SET last_seen_at=? WHERE id=?").bind(now, account.id),
    c.env.DB.prepare("INSERT INTO customer_sessions(token_hash,account_id,shop_id,created_at,expires_at) VALUES(?,?,?,?,?)").bind(await digest(raw), account.id, shop.id, now, now + SESSION_TTL),
    audit(c, "customer_account", account.id, "CUSTOMER_SIGNED_IN", `Customer signed in online (${how}).`),
  ]);
  c.set("actor", `customer:${account.id}`);
  setSession(c, raw);
}
export async function currentAccount(c: Ctx, shop: Shop): Promise<AccountRow | null> {
  const raw = getCookie(c, CUSTOMER_COOKIE);
  if (!raw || raw.length < 60) return null;
  return c.env.DB.prepare("SELECT a.* FROM customer_sessions s JOIN customer_accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.shop_id=? AND s.expires_at>?")
    .bind(await digest(raw), shop.id, Date.now())
    .first<AccountRow>();
}
const byEmail = (c: Ctx, email: string) => c.env.DB.prepare("SELECT * FROM customer_accounts WHERE lower(email)=lower(?) AND email<>''").bind(email).first<AccountRow>();
const byPhone = (c: Ctx, phone: string) => c.env.DB.prepare("SELECT * FROM customer_accounts WHERE phone=?").bind(phone).first<AccountRow>();

async function passwordOk(password: string, a: AccountRow | null) {
  const actual = await passwordHash(password, a?.password_salt || "customer-unknown-constant-salt");
  const expected = a?.password_hash || "0".repeat(64);
  let delta = actual.length ^ expected.length;
  for (let i = 0; i < Math.min(actual.length, expected.length); i++) delta |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return delta === 0 && !!a?.password_hash;
}

// Create (or adopt) the global account for a booker. Used by /register and by the public booking
// route so a first booking ends with an account. Returns the row and whether it was created now.
export async function ensureAccount(c: Ctx, shop: Shop, who: { name: string; phone: string; email: string }, password?: string): Promise<{ account: AccountRow; created: boolean; conflict?: "email" }> {
  const now = Date.now();
  let account = await byPhone(c, who.phone);
  const emailOwner = who.email ? await byEmail(c, who.email) : null;
  if (emailOwner && (!account || emailOwner.id !== account.id)) {
    // The email already belongs to a different account (a different mobile). Don't merge silently.
    if (account) return { account, created: false, conflict: "email" };
    // No account for this phone but the email exists: adopt the phone onto that account only if it
    // has no password yet (a code-only legacy account). Otherwise it's a conflict.
    if (!emailOwner.password_hash) {
      await c.env.DB.prepare("UPDATE customer_accounts SET phone=?, name=COALESCE(NULLIF(name,''),?), last_seen_at=? WHERE id=?").bind(who.phone, who.name, now, emailOwner.id).run().catch(() => null);
      account = (await byPhone(c, who.phone)) ?? emailOwner;
    } else return { account: emailOwner, created: false, conflict: "email" };
  }
  let created = false;
  if (!account) {
    const salt = password ? uid() + uid() : "";
    const hash = password ? await passwordHash(password, salt) : "";
    await c.env.DB.prepare("INSERT INTO customer_accounts(id,phone,email,name,created_at,last_seen_at,version,password_hash,password_salt,email_verified,password_set_at) VALUES(?,?,?,?,?,?,0,?,?,0,?)")
      .bind(uid(), who.phone, who.email, who.name, now, now, hash, salt, password ? now : null)
      .run();
    account = (await byPhone(c, who.phone))!;
    created = true;
  } else {
    // Fill blanks; never overwrite an email that already has a password behind it.
    const sets: string[] = [];
    const args: unknown[] = [];
    if (!account.email && who.email) { sets.push("email=?"); args.push(who.email); }
    if (!account.name && who.name) { sets.push("name=?"); args.push(who.name); }
    if (password && !account.password_hash) {
      const salt = uid() + uid();
      sets.push("password_hash=?", "password_salt=?", "password_set_at=?");
      args.push(await passwordHash(password, salt), salt, now);
    }
    if (sets.length) {
      await c.env.DB.prepare(`UPDATE customer_accounts SET ${sets.join(",")}, version=version+1 WHERE id=?`).bind(...args, account.id).run();
      account = (await byPhone(c, who.phone))!;
    }
  }
  return { account, created };
}

// One-time link for setting (WELCOME) or resetting (RESET) the password. Replaces any live token.
export async function issueToken(c: Ctx, shop: Shop, account: AccountRow, purpose: "RESET" | "WELCOME", now = Date.now()) {
  const raw = uid() + uid();
  const ttl = purpose === "RESET" ? RESET_TTL : WELCOME_TTL;
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM customer_reset_tokens WHERE account_id=? AND used_at IS NULL").bind(account.id),
    c.env.DB.prepare("INSERT INTO customer_reset_tokens(token_hash,account_id,shop_id,purpose,created_at,expires_at) VALUES(?,?,?,?,?,?)").bind(await digest(raw), account.id, shop.id, purpose, now, now + ttl),
  ]);
  return raw;
}
export function accountLink(origin: string, shop: Shop, token: string, purpose: "RESET" | "WELCOME") {
  return shopUrl(shop.slug!, `/me?${purpose === "RESET" ? "reset" : "welcome"}=${token}`, origin);
}

// Welcome message after a booking created an account. With a password already chosen the link
// opens the account; without one (legacy/code-only accounts) it is a one-time "set your password" link.
export async function sendWelcome(c: Ctx, shop: Shop, account: AccountRow, origin: string, now = Date.now(), created = !account.password_hash) {
  if (!created) return [];
  const ms = await msgShop(c, shop.id);
  const vars = account.password_hash
    ? { link: shopUrl(shop.slug || "", "/me", origin), install: 1, ready: 1, email: account.email }
    : { link: accountLink(origin, shop, await issueToken(c, shop, account, "WELCOME", now), "WELCOME"), install: 1 };
  return enqueue(c.env.DB, ms, { name: account.name, phone: account.phone, email: account.email }, "account_welcome", vars, { related: { type: "customer_account", id: account.id }, origin, channel: account.email ? "EMAIL" : "AUTO", now });
}

// Write the customer's messaging consent onto this shop's customer record (creating it when this is
// their first contact with the shop) and link it to the account, so reminders and marketing follow
// the choice they made at sign-up rather than the shop's defaults.
export async function recordConsent(c: Ctx, shop: Shop, account: AccountRow, v: { name: string; email: string; marketing_opt_in: 0 | 1; contact_pref: "AUTO" | "EMAIL" }) {
  const now = Date.now();
  let cust = await c.env.DB.prepare("SELECT id, merged_into FROM customers WHERE shop_id=? AND phone=?").bind(shop.id, account.phone).first<{ id: string; merged_into: string | null }>();
  if (cust?.merged_into) cust = { id: cust.merged_into, merged_into: null };
  if (!cust) {
    const id = uid();
    await c.env.DB.prepare(
      "INSERT INTO customers(id,shop_id,name,phone,email,notes,tags,birthday,preferred_staff_id,marketing_opt_in,contact_pref,created_at,updated_at) VALUES(?,?,?,?,?,'','[]',NULL,NULL,?,?,?,?)",
    ).bind(id, shop.id, v.name, account.phone, v.email, v.marketing_opt_in, v.contact_pref, now, now).run();
    cust = { id, merged_into: null };
  } else {
    await c.env.DB.prepare("UPDATE customers SET email=CASE WHEN email='' THEN ? ELSE email END, marketing_opt_in=?, contact_pref=?, version=version+1, updated_at=? WHERE shop_id=? AND id=?")
      .bind(v.email, v.marketing_opt_in, v.contact_pref, now, shop.id, cust.id).run();
  }
  await c.env.DB.prepare("INSERT INTO customer_account_links(account_id,shop_id,customer_id,linked_at) VALUES(?,?,?,?) ON CONFLICT (account_id,shop_id) DO UPDATE SET customer_id=EXCLUDED.customer_id, linked_at=EXCLUDED.linked_at")
    .bind(account.id, shop.id, cust.id, now).run();
}

export const customerAuth = new Hono<AppEnv>();

customerAuth.post("/register", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const b = await readInput(c, registerSchema);
  await throttle(c, "cust-register", `${shop.id}:${clientKey(c)}`, 20);
  const termsNeeded = !!shop.terms_text && (shop.terms_version || 0) > 0;
  if (termsNeeded && b.accept_terms_version !== shop.terms_version) fail(400, "Please accept the booking terms to create an account");
  const existing = await byPhone(c, b.phone);
  if (existing?.password_hash) fail(409, "There's already an account for this mobile. Sign in, or reset your password.");
  const { account, conflict } = await ensureAccount(c, shop, { name: b.name, phone: b.phone, email: b.email }, b.password);
  if (conflict === "email") fail(409, "That email is already used by another account. Sign in with it, or use a different email.");
  await c.env.DB.prepare("UPDATE customer_accounts SET name=?, email=? WHERE id=? AND password_set_at>=?").bind(b.name, b.email, account.id, Date.now() - 5000).run();
  // The shop's customer record carries the consent: how to message them, and whether marketing is
  // allowed. Text is only a real choice when the shop sends texts; otherwise the record says email.
  const pref = b.contact_pref === "EMAIL" || (shop as { msg_sms?: number }).msg_sms === 0 ? "EMAIL" : "AUTO";
  await recordConsent(c, shop, account, { name: b.name, email: b.email, marketing_opt_in: b.marketing_opt_in, contact_pref: pref });
  if (termsNeeded) await c.env.DB.prepare("UPDATE customer_account_links SET terms_version=?, terms_accepted_at=? WHERE account_id=? AND shop_id=?").bind(shop.terms_version, Date.now(), account.id, shop.id).run();
  await c.env.DB.batch([
    audit(c, "customer_account", account.id, "CUSTOMER_REGISTERED", `Customer created an account (email + password). Reminders by ${pref === "EMAIL" ? "email" : "text and email"}; marketing ${b.marketing_opt_in ? "on" : "off"}${termsNeeded ? `; accepted booking terms v${shop.terms_version}` : ""}.`),
  ]);
  await openSession(c, shop, { ...account, name: b.name, email: b.email }, "new account");
  // Welcome email: confirms the account exists, where reminders will go, and how to install the app.
  try {
    const origin = process.env.APP_ORIGIN || new URL(c.req.url).origin;
    const welcome = await sendWelcome(c, shop, { ...account, name: b.name, email: b.email }, origin, Date.now(), true);
    if (welcome.length) { await c.env.DB.batch(welcome); await drain(c.env.DB, welcome.length, Date.now(), { type: "customer_account", id: account.id }).catch(() => {}); }
  } catch { /* the account stands even if the welcome cannot be queued */ }
  return c.json({ ok: true, new_account: true }, 201);
});

customerAuth.post("/login", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const b = await readInput(c, loginSchema);
  await throttle(c, "cust-login", `${shop.id}:${clientKey(c)}`, 30);
  await throttle(c, "cust-login-email", `${b.email}`, 10);
  const account = await byEmail(c, b.email);
  if (!(await passwordOk(b.password, account))) {
    if (account && !account.password_hash) fail(409, "This account signs in with a mobile code. Use \u201cText me a code\u201d, or set a password from Forgot password.");
    fail(401, "Email or password is not right.");
  }
  await openSession(c, shop, account!, "email + password");
  return c.json({ ok: true }, 201);
});

customerAuth.post("/forgot", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const b = await readInput(c, forgotSchema);
  await throttle(c, "cust-forgot", `${shop.id}:${clientKey(c)}`, 10);
  const account = await byEmail(c, b.email);
  const now = Date.now();
  const origin = process.env.APP_ORIGIN || new URL(c.req.url).origin;
  // Same response whether or not the email exists.
  if (account) {
    const token = await issueToken(c, shop, account, "RESET", now);
    const ms = await msgShop(c, shop.id);
    const stmts = enqueue(c.env.DB, ms, { name: account.name, phone: account.phone, email: account.email }, "account_reset", { link: accountLink(origin, shop, token, "RESET") }, { related: { type: "customer_account", id: account.id }, origin, channel: "EMAIL", now });
    await c.env.DB.batch([...stmts, audit(c, "customer_account", account.id, "CUSTOMER_RESET_REQUESTED", "Customer asked for a password reset link.")]);
    if (stmts.length) await drain(c.env.DB, stmts.length, now, { type: "customer_account", id: account.id }).catch(() => {});
    const live = !!process.env.RESEND_API_KEY;
    return c.json({ ok: true, ...(live ? {} : { sandbox_token: token }) }, 201);
  }
  return c.json({ ok: true }, 201);
});

// Consumes a RESET or WELCOME token. WELCOME also marks the email verified (they got the link there).
customerAuth.post("/reset", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const b = await readInput(c, resetSchema);
  await throttle(c, "cust-reset", `${shop.id}:${clientKey(c)}`, 20);
  const now = Date.now();
  const row = await c.env.DB.prepare("SELECT t.*, a.email FROM customer_reset_tokens t JOIN customer_accounts a ON a.id=t.account_id WHERE t.token_hash=? AND t.used_at IS NULL AND t.expires_at>?").bind(await digest(b.token), now).first<{ account_id: string; purpose: "RESET" | "WELCOME"; email: string }>();
  if (!row) fail(409, "That link has expired or was already used. Ask for a new one.");
  const salt = uid() + uid();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE customer_accounts SET password_hash=?, password_salt=?, password_set_at=?, email_verified=CASE WHEN ?='WELCOME' THEN 1 ELSE email_verified END, version=version+1 WHERE id=?").bind(await passwordHash(b.password, salt), salt, now, row!.purpose, row!.account_id),
    c.env.DB.prepare("UPDATE customer_reset_tokens SET used_at=? WHERE token_hash=?").bind(now, await digest(b.token)),
    // A reset signs every other device out.
    c.env.DB.prepare("DELETE FROM customer_sessions WHERE account_id=?").bind(row!.account_id),
    audit(c, "customer_account", row!.account_id, row!.purpose === "WELCOME" ? "CUSTOMER_PASSWORD_SET" : "CUSTOMER_PASSWORD_RESET", row!.purpose === "WELCOME" ? "Customer set their first password." : "Customer reset their password; other sessions signed out."),
  ]);
  const account = (await c.env.DB.prepare("SELECT * FROM customer_accounts WHERE id=?").bind(row!.account_id).first<AccountRow>())!;
  await openSession(c, shop, account, row!.purpose === "WELCOME" ? "welcome link" : "reset link");
  return c.json({ ok: true, email: account.email }, 201);
});

customerAuth.put("/password", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const account = await currentAccount(c, shop);
  if (!account) return fail(401, "Sign in first");
  const b = await readInput(c, changeSchema);
  if (account.password_hash && !(await passwordOk(b.current, account))) fail(401, "Your current password is not right.");
  const salt = uid() + uid();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE customer_accounts SET password_hash=?, password_salt=?, password_set_at=?, version=version+1 WHERE id=?").bind(await passwordHash(b.password, salt), salt, now, account.id),
    audit(c, "customer_account", account.id, "CUSTOMER_PASSWORD_CHANGED", account.password_hash ? "Customer changed their password." : "Customer set a password."),
  ]);
  return c.json({ ok: true });
});

// ---- Push subscriptions -----------------------------------------------------------
customerAuth.get("/push", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const account = await currentAccount(c, shop);
  const st = pushStatus();
  const endpoint = c.req.query("endpoint");
  const subscribed = account && endpoint ? !!(await c.env.DB.prepare("SELECT 1 AS x FROM customer_push_subscriptions WHERE shop_id=? AND account_id=? AND endpoint=?").bind(shop.id, account.id, endpoint).first()) : false;
  return c.json({ enabled: st.enabled, public_key: st.public_key, subscribed });
});
customerAuth.post("/push", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const account = await currentAccount(c, shop);
  if (!account) return fail(401, "Sign in first");
  const b = await readInput(c, pushSchema);
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO customer_push_subscriptions(id,account_id,shop_id,endpoint,p256dh,auth,user_agent,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT (shop_id,endpoint) DO UPDATE SET account_id=EXCLUDED.account_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, failures=0",
  ).bind(uid(), account.id, shop.id, b.endpoint, b.keys.p256dh, b.keys.auth, (c.req.header("user-agent") || "").slice(0, 200), now).run();
  await c.env.DB.batch([audit(c, "customer_account", account.id, "CUSTOMER_PUSH_ON", "Customer turned on app notifications.")]);
  return c.json({ ok: true }, 201);
});
customerAuth.delete("/push", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const account = await currentAccount(c, shop);
  if (!account) return fail(401, "Sign in first");
  const b = await readInput(c, z.object({ endpoint: z.string().url().max(2000) }).strict());
  await c.env.DB.prepare("DELETE FROM customer_push_subscriptions WHERE shop_id=? AND account_id=? AND endpoint=?").bind(shop.id, account.id, b.endpoint).run();
  return c.json({ ok: true });
});

// ---- Per-shop web app manifest ------------------------------------------------------
// Served at /<slug>/manifest.webmanifest. Name, colours and icon come from the shop page so the
// installed app is the shop's, not foliyo's. start_url is the account page.
export async function shopManifest(c: Ctx, slug: string) {
  const shop = await shopBySlug(c, slug);
  // On the shop's own host every path is short and the app scope is the whole origin.
  const onHost = (c.req.header("x-foliyo-shop-host") || "") === slug;
  const P = (p: "/" | "/book" | "/me") => (onHost ? p : p === "/" ? `/${slug}` : p === "/book" ? `/book/${slug}` : `/${slug}/me`);
  const scope = onHost ? "/" : `/${slug}/`;
  const page = await c.env.DB.prepare("SELECT logo_url, accent, theme_json, logo_tone FROM shop_pages WHERE shop_id=?").bind(shop.id).first<{ logo_url: string; accent: string; theme_json: string }>();
  const brand = brandOf({ ...shop, ...(page || {}) } as Shop & { logo_url?: string; accent?: string; theme_json?: string });
  const theme = (() => { try { return JSON.parse(page?.theme_json || "{}") as { mode?: string }; } catch { return {}; } })();
  const dark = theme.mode === "dark";
  const ACCENT_HEX: Record<string, string> = { ollo: "#1f6f5f", ink: "#111318", sage: "#5b7a68", clay: "#a0522d", plum: "#5a3e6b", slate: "#4a5568" };
  const accent = ACCENT_HEX[brand.accent] || ACCENT_HEX.ollo;
  const iconBase = onHost ? "" : `/${encodeURIComponent(slug)}`;
  const icons = [
    { src: `${iconBase}/icon-192.png`, sizes: "192x192", type: "image/png" },
    { src: `${iconBase}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ];
  const manifest = {
    id: `${P("/me")}`,
    name: shop.name,
    short_name: shop.name.length > 12 ? shop.name.split(/\s+/)[0].slice(0, 12) : shop.name,
    description: `Book and manage your visits at ${shop.name}.`,
    start_url: `${P("/me")}?source=pwa`,
    scope,
    display: "standalone",
    orientation: "portrait",
    background_color: dark ? "#0b0b0c" : "#ffffff",
    theme_color: dark ? "#0b0b0c" : accent,
    icons,
    shortcuts: [
      { name: "Book a visit", url: `${P("/book")}?source=pwa`, description: `Book at ${shop.name}` },
      { name: "My visits", url: `${P("/me")}?source=pwa` },
    ],
  };
  c.header("Content-Type", "application/manifest+json");
  c.header("Cache-Control", "public, max-age=300");
  return c.body(JSON.stringify(manifest));
}
