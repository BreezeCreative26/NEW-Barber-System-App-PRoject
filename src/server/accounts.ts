import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";

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
  Bindings: { DB: D1Database; APP_MODE?: string };
  Variables: { shopId: string; actor: string; account: Account | null };
};
type Ctx = Context<AppEnv>;
export const ACCOUNT_COOKIE = "barbershop_account";
const LEGACY_COOKIE = "barbershop_test_session";
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
async function passwordHash(password: string, salt: string) {
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
async function throttle(c: Ctx, action: string, identity: string) {
  const now = Date.now();
  for (const [key, max] of [
    [`${action}:${identity}`, 12],
    [`${action}:global`, 180],
  ] as const) {
    const row = await c.env.DB.prepare(
      `INSERT INTO auth_throttle(key_hash,attempts,resets_at) VALUES(?,1,?) ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN resets_at<=? THEN 1 ELSE attempts+1 END,resets_at=CASE WHEN resets_at<=? THEN excluded.resets_at ELSE resets_at END RETURNING attempts`,
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
    "Local test access management; no message sent.",
    Date.now(),
  );
}
async function newSession(
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
function cookies(c: Ctx, raw: string) {
  setCookie(c, ACCOUNT_COOKIE, raw, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 7 * 86400,
  });
  deleteCookie(c, LEGACY_COOKIE, { path: "/", secure: true });
}
const accounts = new Hono<AppEnv>();
accounts.post("/register", async (c) => {
  const b = await readInput(c, registration);
  if (!c.get("shopId") || c.get("account"))
    return reject(403, "Create or open your unclaimed test workspace first");
  await throttle(c, "register", b.email);
  const shop = c.get("shopId"),
    user = uid(),
    membership = uid(),
    salt = uid() + uid();
  const encoded = await passwordHash(b.password, salt);
  const session = await newSession(c, membership);
  // Unique shop ownership and user email serialize competing claims. All writes rollback together.
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO app_users(id,email,name,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?)",
    ).bind(user, b.email, b.name, encoded, salt, Date.now()),
    c.env.DB.prepare(
      "INSERT INTO shop_owners(shop_id,user_id) VALUES(?,?)",
    ).bind(shop, user),
    c.env.DB.prepare(
      "INSERT INTO app_memberships(id,shop_id,user_id,role) VALUES(?,?,?,'OWNER')",
    ).bind(membership, shop, user),
    session.write,
    c.env.DB.prepare("INSERT INTO account_assertions(ok) VALUES(changes())"),
    c.env.DB.prepare("DELETE FROM account_assertions"),
    c.env.DB.prepare("DELETE FROM sandbox_sessions WHERE shop_id=?").bind(shop),
    event(c, shop, `user:${user}`, user, "OWNER_ACCOUNT_CREATED"),
  ]);
  cookies(c, session.raw);
  return c.json({ ok: true }, 201);
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
accounts.post("/logout", async (c) => {
  await readInput(c, z.object({}).strict());
  const token = getCookie(c, ACCOUNT_COOKIE);
  if (token)
    await c.env.DB.prepare("DELETE FROM app_sessions WHERE token_hash=?")
      .bind(await digest(token))
      .run();
  deleteCookie(c, ACCOUNT_COOKIE, { path: "/", secure: true });
  deleteCookie(c, LEGACY_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});
accounts.get("/me", (c) =>
  c.json({ account: c.get("account") || null, mode: "local-test" }),
);
accounts.get("/access", async (c) => {
  const a = owner(c);
  const [members, invitations] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT m.id,m.role,m.staff_id,m.active,m.version,u.name,u.email FROM app_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.shop_id=? ORDER BY u.name",
    ).bind(a.shop_id),
    c.env.DB.prepare(
      "SELECT id,staff_id,email,role,expires_at,accepted_at,revoked FROM staff_invitations WHERE shop_id=? ORDER BY created_at DESC LIMIT 100",
    ).bind(a.shop_id),
  ]);
  return c.json({ members: members.results, invitations: invitations.results });
});
accounts.post("/invites", async (c) => {
  const a = owner(c);
  const b = await readInput(
    c,
    z
      .object({
        email,
        staff_id: z.string().uuid(),
        role: z.enum(["MANAGER", "RECEPTION", "BARBER"]),
      })
      .strict(),
  );
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
    id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE staff_invitations SET revoked=1 WHERE shop_id=? AND staff_id=? AND accepted_at IS NULL",
    ).bind(a.shop_id, b.staff_id),
    c.env.DB.prepare(
      "INSERT INTO staff_invitations(id,shop_id,staff_id,email,role,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(
      id,
      a.shop_id,
      b.staff_id,
      b.email,
      b.role,
      await digest(token),
      Date.now() + 48 * 3600000,
      Date.now(),
    ),
    event(c, a.shop_id, `user:${a.user_id}`, id, "STAFF_INVITED"),
  ]);
  return c.json(
    { id, token, expires_in_hours: 48, delivery: "manual-local-test" },
    201,
  );
});
accounts.post("/invites/:id/revoke", async (c) => {
  const a = owner(c);
  await readInput(c, z.object({}).strict());
  const r = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE staff_invitations SET revoked=1 WHERE id=? AND shop_id=? AND accepted_at IS NULL AND revoked=0",
    ).bind(c.req.param("id"), a.shop_id),
    c.env.DB.prepare(
      "INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) SELECT ?,?,'account',?,'INVITATION_REVOKED',?,'Local invitation revoked',? WHERE changes()>0",
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
accounts.post("/accept", async (c) => {
  const b = await readInput(
    c,
    registration.extend({ token: z.string().min(60).max(100) }).strict(),
  );
  await throttle(c, "accept", b.email);
  const invite = await c.env.DB.prepare(
    "SELECT i.* FROM staff_invitations i JOIN staff s ON s.shop_id=i.shop_id AND s.id=i.staff_id WHERE i.token_hash=? AND i.email=? AND i.revoked=0 AND i.accepted_at IS NULL AND i.expires_at>? AND s.active=1",
  )
    .bind(await digest(b.token), b.email, Date.now())
    .first<{ id: string; shop_id: string; staff_id: string; role: string }>();
  if (!invite)
    return reject(400, "Invitation is unavailable or details do not match");
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
      "INSERT INTO app_memberships(id,shop_id,user_id,role,staff_id) SELECT ?,shop_id,?,role,staff_id FROM staff_invitations WHERE id=? AND token_hash=? AND email=? AND revoked=0 AND accepted_at IS NULL AND expires_at>?",
    ).bind(
      membership,
      user,
      invite.id,
      await digest(b.token),
      b.email,
      Date.now(),
    ),
    c.env.DB.prepare("INSERT INTO account_assertions(ok) VALUES(changes())"),
    c.env.DB.prepare("DELETE FROM account_assertions"),
    c.env.DB.prepare(
      "UPDATE staff_invitations SET accepted_at=? WHERE id=? AND accepted_at IS NULL AND revoked=0 AND expires_at>?",
    ).bind(Date.now(), invite.id, Date.now()),
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
