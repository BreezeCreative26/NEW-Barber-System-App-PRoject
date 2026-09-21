import { Hono, type Context } from "hono";
import { drain, enqueue, msgShop, providerStatus } from "./messaging";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { Database } from "../db/client";
import { z } from "zod";
import { demoRoute } from "./demo";

export type Account = {
  id: string;
  user_id: string;
  shop_id: string;
  name: string;
  email: string;
  role: "OWNER" | "MANAGER" | "RECEPTION" | "BARBER";
  staff_id: string | null;
  version: number;
};
export type AppEnv = {
  Bindings: { DB: Database; APP_MODE?: string; ALLOWED_ORIGINS?: string; DEMO_ENABLED?: string; OLLO_ADMIN_EMAILS?: string };
  Variables: { shopId: string; actor: string; account: Account | null };
};
type Ctx = Context<AppEnv>;
export const ACCOUNT_COOKIE = "ollo_session";
// Same-origin guard for every write. Development proxies (preview wrappers, HTTPS
// tunnels) rewrite Host, so the forwarded host/proto and an explicit sandbox-only
// allow-list also count as "this site". Cross-site origins are always refused.
export function sameOrigin(c: Ctx): boolean {
  const url = new URL(c.req.url);
  const origin = c.req.header("origin") ?? "";
  const hostOf = (v: string | undefined | null) => {
    if (!v) return "";
    try {
      return new URL(v.includes("://") ? v : `https://${v}`).host.toLowerCase();
    } catch {
      return "";
    }
  };
  const originHost = hostOf(origin);
  // 1. Exact match.
  if (origin && origin === url.origin) return true;
  // 2. Browser-asserted same-origin/same-site fetch (cannot be forged cross-site).
  const site = c.req.header("sec-fetch-site");
  if (site === "same-origin" || site === "same-site") return true;
  // 3. Proxies rewrite the scheme and/or Host; compare hosts only against the
  //    request host and any forwarded host.
  const candidates = [
    url.host,
    hostOf(c.req.header("host")),
    ...(c.req.header("x-forwarded-host") || "").split(",").map((h) => hostOf(h.trim())),
  ].filter(Boolean);
  if (originHost && candidates.includes(originHost)) return true;
  // 4. No Origin (older browsers on same-origin POST) but a same-host Referer.
  if (!origin) {
    const ref = hostOf(c.req.header("referer"));
    if (ref && candidates.includes(ref)) return true;
  }
  // 5. Explicit sandbox allow-list.
  const allowed = (c.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (allowed.some((a) => a === "*" || a === origin || hostOf(a) === originHost)) return true;
  // Diagnostics only: no bodies or cookies are logged.
  console.warn(
    "origin_forbidden",
    JSON.stringify({
      url_origin: url.origin,
      origin,
      host: c.req.header("host") ?? null,
      x_forwarded_host: c.req.header("x-forwarded-host") ?? null,
      sec_fetch_site: site ?? null,
      referer_host: hostOf(c.req.header("referer")) || null,
    }),
  );
  return false;
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
// Web Crypto's portable Workers PBKDF2 limit is 100,000. Local test adapter only;
// production managed identity, MFA/recovery and security acceptance remain separate.
export async function passwordHash(password: string, salt: string) {
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
      iterations: 100000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return [...new Uint8Array(bits)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
async function matches(
  password: string,
  user: { password_hash: string; password_salt: string } | null,
) {
  const actual = await passwordHash(
    password,
    user?.password_salt || "local-unknown-account-constant-salt",
  );
  const expected = user?.password_hash || "0".repeat(64);
  let delta = 0;
  for (let i = 0; i < 64; i++)
    delta |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return !!user && delta === 0;
}
// Per-identity cap always; the global cap guards password guessing on login only (a busy
// launch day must not lock out new shops).
export async function throttle(c: Ctx, action: string, identity: string) {
  const now = Date.now();
  const limits: [string, number][] = [[`${action}:${identity}`, 12]];
  if (action === "login") {
    limits.push([`${action}:global`, 180]);
    // Per-IP cap too, so one host cannot spray many emails at 12 attempts each.
    const ip = (c.req.header("x-forwarded-for") || "").split(",")[0].trim() || c.req.header("x-real-ip") || "";
    if (ip) limits.push([`${action}:ip:${ip}`, Number(process.env.LOGIN_IP_LIMIT) || 60]);
  }
  if (action === "signup") {
    const ip = (c.req.header("x-forwarded-for") || "").split(",")[0].trim() || c.req.header("x-real-ip") || "";
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
  return c.env.DB.prepare(
    `SELECT m.id,m.user_id,m.shop_id,m.role,m.staff_id,m.version,u.name,u.email FROM app_sessions s JOIN app_memberships m ON m.id=s.membership_id JOIN app_users u ON u.id=m.user_id LEFT JOIN staff b ON b.shop_id=m.shop_id AND b.id=m.staff_id WHERE s.token_hash=? AND s.expires_at>? AND m.active=1 AND (m.role='OWNER' OR b.active=1)`,
  )
    .bind(await digest(token), Date.now())
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
  setCookie(c, ACCOUNT_COOKIE, raw, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 7 * 86400,
  });
  for (const name of LEGACY_COOKIES) deleteCookie(c, name, { path: "/", secure: true });
}
const accounts = new Hono<AppEnv>();
export const demoEnabled = (c: Ctx) => (c.env.DEMO_ENABLED ?? process.env.DEMO_ENABLED ?? "") === "1";
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
    name: z.string().trim().min(2).max(100),
    email,
    password,
    timezone: timezone.default("Europe/London"),
    kind: z.enum(["BARBER", "HAIR", "SALON"]).default("BARBER"),
  })
  .strict();
// POST /auth/signup — the only way a real shop starts. Creates the shop, the owner's user +
// OWNER membership, and adds the owner as the first bookable barber (most owners cut hair; the
// profile can be deactivated in Team if not). No fictional services or staff are seeded.
accounts.post("/signup", async (c) => {
  const b = await readInput(c, signup);
  if (c.get("account")) return reject(409, "You are already signed in. Sign out first to create another shop.");
  await throttle(c, "signup", b.email);
  const existing = await c.env.DB.prepare("SELECT 1 AS x FROM app_users WHERE email=?").bind(b.email).first();
  if (existing) return reject(409, "An account with this email already exists. Sign in instead.");
  const shop = uid(),
    user = uid(),
    membership = uid(),
    staffId = uid(),
    salt = uid() + uid(),
    now = Date.now();
  const encoded = await passwordHash(b.password, salt);
  const session = await newSession(c, membership);
  const writes = [
    c.env.DB.prepare("INSERT INTO shops(id,name,timezone,kind,email,setup_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(shop, b.shop_name, b.timezone, b.kind, b.email, JSON.stringify({ step: "shop", done: [], skipped: [], started_at: now }), now),
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
  );
  await c.env.DB.batch(writes);
  cookies(c, session.raw);
  return c.json({ ok: true, shop_id: shop }, 201);
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
  const m = u
    ? await c.env.DB.prepare(
        "SELECT m.id,m.shop_id,m.version FROM app_memberships m LEFT JOIN staff b ON b.shop_id=m.shop_id AND b.id=m.staff_id WHERE m.user_id=? AND m.active=1 AND (m.role='OWNER' OR b.active=1)",
      )
        .bind(u.id)
        .first<{ id: string; shop_id: string; version: number }>()
    : null;
  if (!valid || !m || !u)
    return reject(401, "Unable to sign in with these details");
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
  deleteCookie(c, ACCOUNT_COOKIE, { path: "/", secure: true });
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
      "SELECT m.id,m.role,m.staff_id,m.active,m.version,u.name,u.email FROM app_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.shop_id=? ORDER BY u.name",
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
// Deliver (or re-deliver) an invitation on the requested channel. Returns what actually went out.
async function sendInvite(c: Ctx, shopId: string, inviterUserId: string, inv: { id: string; email: string; phone: string; role: string; channel: string }, token: string) {
  const ms = await msgShop(c, shopId);
  const origin = new URL(c.req.url).origin;
  const inviter = await c.env.DB.prepare("SELECT name FROM app_users WHERE id=?").bind(inviterUserId).first<{ name: string }>();
  const vars = { inviter: inviter?.name || ms.name, role: inv.role.charAt(0) + inv.role.slice(1).toLowerCase(), link: `${origin}/workspace?invite=${token}` };
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
  return c.json({ id, token, link: `${new URL(c.req.url).origin}/workspace?invite=${token}`, expires_in_hours: 7 * 24, delivery: delivery.sent.length ? delivery.sent.join("+") : "manual", sent: delivery.sent }, 201);
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
  return c.json({ id: inv.id, token, link: `${new URL(c.req.url).origin}/workspace?invite=${token}`, expires_in_hours: 7 * 24, delivery: delivery.sent.length ? delivery.sent.join("+") : "manual", sent: delivery.sent }, 201);
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
    registration.extend({ token: z.string().min(60).max(100) }).strict(),
  );
  await throttle(c, "accept", b.email);
  // Email invites are bound to the address they went to; SMS/link invites take whatever address
  // the person signs up with (recorded on the invitation for the audit trail).
  const invite = await c.env.DB.prepare(
    "SELECT i.* FROM staff_invitations i JOIN staff s ON s.shop_id=i.shop_id AND s.id=i.staff_id WHERE i.token_hash=? AND (i.email=? OR i.email LIKE '%@sms.invite') AND i.revoked=0 AND i.accepted_at IS NULL AND i.expires_at>? AND s.active=1",
  )
    .bind(await digest(b.token), b.email, Date.now())
    .first<{ id: string; shop_id: string; staff_id: string; role: string; invited_by: string }>();
  if (!invite)
    return reject(400, "Invitation is unavailable or details do not match");
  if (await c.env.DB.prepare("SELECT 1 AS x FROM app_users WHERE email=?").bind(b.email).first())
    return reject(409, "An account with this email already exists. Sign in instead.");
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
  ]);
  cookies(c, session.raw);
  return c.json({ ok: true }, 201);
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
    const link = `${origin}/reset?token=${token}`;
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
  const row = await c.env.DB.prepare("SELECT r.user_id,r.expires_at,r.used_at,m.id AS membership_id,m.shop_id FROM password_resets r JOIN app_memberships m ON m.user_id=r.user_id WHERE r.token_hash=? AND m.active=1").bind(await digest(b.token)).first<{ user_id: string; expires_at: number; used_at: number | null; membership_id: string; shop_id: string }>();
  if (!row || row.used_at || row.expires_at <= now) return reject(409, "This reset link is no longer valid. Request a new one.");
  const salt = uid() + uid();
  const encoded = await passwordHash(b.password, salt);
  const session = await newSession(c, row.membership_id);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE app_users SET password_hash=?, password_salt=? WHERE id=?").bind(encoded, salt, row.user_id),
    c.env.DB.prepare("UPDATE password_resets SET used_at=? WHERE token_hash=?").bind(now, await digest(b.token)),
    c.env.DB.prepare("DELETE FROM app_sessions WHERE membership_id=?").bind(row.membership_id),
    session.write,
    event(c, row.shop_id, `user:${row.user_id}`, row.user_id, "PASSWORD_RESET"),
  ]);
  cookies(c, session.raw);
  return c.json({ ok: true });
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
