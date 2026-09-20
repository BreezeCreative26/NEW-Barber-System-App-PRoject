// Shop setup: the guided wizard behind /workspace/setup.
//
// State lives in shops.setup_json ({step, done[], skipped[], completed_at}) so it survives devices
// and sign-outs. Every step is optional except the first save; the wizard is a front door onto
// settings that already exist (hours, services, team, online, payments), plus the pieces that
// only make sense at setup: contact verification, starter menus, a "send me a test".
import { Hono } from "hono";
import { z } from "zod";
import type { Database as DB } from "../db/client";
import { slugSchema, type Shop } from "./domain";
import { audit, fail, readShop } from "./sandbox";
import { digest, readInput, throttle, type AppEnv } from "./accounts";
import { drain, enqueue, msgShop, providerStatus } from "./messaging";

type Env = AppEnv;
const setup = new Hono<Env>();
const uid = () => crypto.randomUUID();

// ---- Wizard state ---------------------------------------------------------------------------------
export const SETUP_STEPS = ["shop", "hours", "services", "team", "messages", "online", "payments"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export type SetupState = { step: SetupStep; done: SetupStep[]; skipped: SetupStep[]; completed_at: number | null; started_at: number | null; dismissed: boolean };
export function setupState(shop: Pick<Shop, "setup_json">): SetupState {
  let j: Partial<SetupState> = {};
  try { j = JSON.parse(shop.setup_json || "{}"); } catch { /* default */ }
  return {
    step: SETUP_STEPS.includes(j.step as SetupStep) ? (j.step as SetupStep) : "shop",
    done: (j.done ?? []).filter((s): s is SetupStep => SETUP_STEPS.includes(s as SetupStep)),
    skipped: (j.skipped ?? []).filter((s): s is SetupStep => SETUP_STEPS.includes(s as SetupStep)),
    completed_at: j.completed_at ?? null,
    started_at: j.started_at ?? null,
    dismissed: !!j.dismissed,
  };
}
// What the data says is actually done — the wizard shows this, not just what was clicked through.
export async function setupProgress(db: DB, shop: Shop & { phone?: string; email?: string; phone_verified_at?: number | null; email_verified_at?: number | null }) {
  const [svc, staff, invites, members] = await Promise.all([
    db.prepare("SELECT COUNT(*)::int AS n FROM services WHERE shop_id=? AND active=1").bind(shop.id).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*)::int AS n FROM staff WHERE shop_id=? AND active=1").bind(shop.id).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*)::int AS n FROM staff_invitations WHERE shop_id=? AND revoked=0").bind(shop.id).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*)::int AS n FROM app_memberships WHERE shop_id=? AND role<>'OWNER' AND active=1").bind(shop.id).first<{ n: number }>(),
  ]);
  return {
    shop: { saved: !!(shop.address || shop.phone || shop.email), phone: shop.phone || "", email: shop.email || "", phone_verified: !!shop.phone_verified_at, email_verified: !!shop.email_verified_at },
    hours: { saved: true },
    services: { count: svc?.n ?? 0 },
    team: { staff: staff?.n ?? 0, invited: invites?.n ?? 0, joined: members?.n ?? 0 },
    messages: { sms_sender: (shop as { msg_sms_sender?: string }).msg_sms_sender || "", providers: providerStatus() },
    online: { slug: shop.slug || "", live: shop.online_booking === 1 },
    payments: { deposits_online: shop.deposits_online === 1, mode: shop.payment_mode, connected: !!shop.stripe_account_id },
  };
}

// ---- Starter menus --------------------------------------------------------------------------------
// Typical UK prices; every row is editable before it is saved. Categories match what the catalogue
// UI groups by.
type Starter = { name: string; category: string; duration_min: number; price_pence: number; popular?: boolean };
export const STARTER_MENUS: Record<"BARBER" | "HAIR" | "SALON", Starter[]> = {
  BARBER: [
    { name: "Haircut", category: "Hair", duration_min: 30, price_pence: 2200, popular: true },
    { name: "Skin fade", category: "Hair", duration_min: 45, price_pence: 2800, popular: true },
    { name: "Cut & beard", category: "Hair & beard", duration_min: 60, price_pence: 3500, popular: true },
    { name: "Beard trim", category: "Beard", duration_min: 20, price_pence: 1500 },
    { name: "Beard trim & hot towel shave", category: "Beard", duration_min: 40, price_pence: 2500 },
    { name: "Hot towel shave", category: "Beard", duration_min: 30, price_pence: 2200 },
    { name: "Kids cut (under 12)", category: "Hair", duration_min: 30, price_pence: 1600 },
    { name: "Buzz cut", category: "Hair", duration_min: 15, price_pence: 1400 },
    { name: "Scissor cut", category: "Hair", duration_min: 40, price_pence: 2600 },
    { name: "Line up / edge up", category: "Hair", duration_min: 15, price_pence: 1000 },
    { name: "Wash & style", category: "Extras", duration_min: 15, price_pence: 800 },
    { name: "Eyebrow tidy", category: "Extras", duration_min: 10, price_pence: 600 },
  ],
  HAIR: [
    { name: "Cut & finish", category: "Cut", duration_min: 45, price_pence: 4200, popular: true },
    { name: "Wash, cut & blow-dry", category: "Cut", duration_min: 60, price_pence: 5500, popular: true },
    { name: "Blow-dry", category: "Styling", duration_min: 30, price_pence: 2800 },
    { name: "Fringe trim", category: "Cut", duration_min: 15, price_pence: 1000 },
    { name: "Full head colour", category: "Colour", duration_min: 120, price_pence: 7500, popular: true },
    { name: "Root touch-up", category: "Colour", duration_min: 90, price_pence: 5500 },
    { name: "Half head highlights", category: "Colour", duration_min: 120, price_pence: 8500 },
    { name: "Full head highlights", category: "Colour", duration_min: 150, price_pence: 11000 },
    { name: "Balayage", category: "Colour", duration_min: 180, price_pence: 14000 },
    { name: "Toner", category: "Colour", duration_min: 30, price_pence: 2500 },
    { name: "Conditioning treatment", category: "Treatments", duration_min: 20, price_pence: 1800 },
    { name: "Children's cut", category: "Cut", duration_min: 30, price_pence: 2000 },
  ],
  SALON: [
    { name: "Cut & finish", category: "Hair", duration_min: 45, price_pence: 4200, popular: true },
    { name: "Blow-dry", category: "Hair", duration_min: 30, price_pence: 2800 },
    { name: "Full head colour", category: "Hair", duration_min: 120, price_pence: 7500 },
    { name: "Gel manicure", category: "Nails", duration_min: 45, price_pence: 3200, popular: true },
    { name: "Pedicure", category: "Nails", duration_min: 50, price_pence: 3500 },
    { name: "Brow shape & tint", category: "Brows & lashes", duration_min: 30, price_pence: 2200, popular: true },
    { name: "Lash lift", category: "Brows & lashes", duration_min: 45, price_pence: 4000 },
    { name: "Express facial", category: "Skin", duration_min: 30, price_pence: 3000 },
    { name: "Deluxe facial", category: "Skin", duration_min: 60, price_pence: 5500 },
    { name: "Half leg wax", category: "Waxing", duration_min: 20, price_pence: 1800 },
    { name: "Full leg wax", category: "Waxing", duration_min: 40, price_pence: 3000 },
    { name: "Back massage", category: "Massage", duration_min: 30, price_pence: 3500 },
  ],
};

// ---- UK bank holidays (England & Wales) for the closures step --------------------------------------
export const BANK_HOLIDAYS: Record<string, string> = {
  "2026-01-01": "New Year's Day", "2026-04-03": "Good Friday", "2026-04-06": "Easter Monday", "2026-05-04": "Early May bank holiday",
  "2026-05-25": "Spring bank holiday", "2026-08-31": "Summer bank holiday", "2026-12-25": "Christmas Day", "2026-12-28": "Boxing Day (substitute)",
  "2027-01-01": "New Year's Day", "2027-03-26": "Good Friday", "2027-03-29": "Easter Monday", "2027-05-03": "Early May bank holiday",
  "2027-05-31": "Spring bank holiday", "2027-08-30": "Summer bank holiday", "2027-12-27": "Christmas Day (substitute)", "2027-12-28": "Boxing Day (substitute)",
};

// ---- Routes ---------------------------------------------------------------------------------------
const requireManager = (c: { get: (k: "account") => { role: string } | null }) => {
  const a = c.get("account");
  if (a && !["OWNER", "MANAGER"].includes(a.role)) fail(403, "Owner or manager required");
};

setup.get("/", async (c) => {
  requireManager(c);
  const shop = await readShop(c);
  return c.json({ state: setupState(shop), progress: await setupProgress(c.env.DB, shop), kind: (shop as { kind?: string }).kind || "BARBER", bank_holidays: BANK_HOLIDAYS });
});

// Move the pointer / mark a step done or skipped / complete / dismiss. The client calls this as the
// owner moves through; it never changes shop data itself.
const stateSchema = z.object({
  step: z.enum(SETUP_STEPS).optional(),
  done: z.enum(SETUP_STEPS).optional(),
  skipped: z.enum(SETUP_STEPS).optional(),
  complete: z.boolean().optional(),
  dismissed: z.boolean().optional(),
  restart: z.boolean().optional(),
}).strict();
setup.put("/state", async (c) => {
  requireManager(c);
  const b = await readInput(c, stateSchema);
  const shop = await readShop(c);
  let s = setupState(shop);
  const now = Date.now();
  if (b.restart) s = { step: "shop", done: [], skipped: [], completed_at: null, started_at: now, dismissed: false };
  if (!s.started_at) s.started_at = now;
  if (b.step) s.step = b.step;
  if (b.done) { s.done = [...new Set([...s.done, b.done])]; s.skipped = s.skipped.filter((x) => x !== b.done); }
  if (b.skipped) { s.skipped = [...new Set([...s.skipped, b.skipped])]; }
  if (b.complete) s.completed_at = s.completed_at ?? now;
  if (b.dismissed !== undefined) s.dismissed = b.dismissed;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE shops SET setup_json=? WHERE id=?").bind(JSON.stringify(s), shop.id),
    ...(b.complete && !setupState(shop).completed_at ? [audit(c, "shop", shop.id, "SETUP_COMPLETED", `${s.done.length} of ${SETUP_STEPS.length} steps done, ${s.skipped.length} skipped.`)] : []),
  ]);
  return c.json({ state: s });
});

// Step 1 — contact details + kind. Separate from PUT /shop (which needs the full hours payload).
const ukMobile = (raw: string) => {
  const d = raw.replace(/[^\d+]/g, "");
  if (/^07\d{9}$/.test(d)) return `+44${d.slice(1)}`;
  if (/^\+447\d{9}$/.test(d)) return d;
  if (/^447\d{9}$/.test(d)) return `+${d}`;
  return null;
};
const contactSchema = z.object({
  name: z.string().trim().min(2).max(100),
  kind: z.enum(["BARBER", "HAIR", "SALON"]),
  phone: z.string().trim().max(20),
  email: z.string().trim().toLowerCase().max(254).refine((s) => s === "" || z.string().email().safeParse(s).success, "Enter a valid email address"),
  address: z.string().trim().max(300),
  timezone: z.string().trim().min(1).max(64),
  currency: z.enum(["GBP", "EUR", "USD"]),
}).strict();
setup.put("/contact", async (c) => {
  requireManager(c);
  const b = await readInput(c, contactSchema);
  const shop = await readShop(c) as Shop & { phone?: string; email?: string };
  const phone = b.phone ? ukMobile(b.phone) : "";
  if (b.phone && !phone) fail(400, "Enter a UK mobile number (07… or +447…)");
  // Changing a verified value un-verifies it.
  const phoneChanged = (phone || "") !== (shop.phone || ""), emailChanged = b.email !== (shop.email || "");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE shops SET name=?, kind=?, phone=?, email=?, address=?, timezone=?, currency=?, version=version+1${phoneChanged ? ", phone_verified_at=NULL" : ""}${emailChanged ? ", email_verified_at=NULL" : ""} WHERE id=?`,
    ).bind(b.name, b.kind, phone || "", b.email, b.address, b.timezone, b.currency, shop.id),
    audit(c, "shop", shop.id, "SHOP_CONTACT_UPDATED", `${b.kind.toLowerCase()} · ${phone ? "mobile set" : "no mobile"} · ${b.email ? "email set" : "no email"}.`),
  ]);
  return c.json({ shop: await readShop(c) });
});

// Verification: 6-digit code to the shop's own phone/email (10 min, 5 attempts). Sandbox / no
// provider: the code is returned so the flow can be exercised.
const CODE_TTL = 10 * 60000;
setup.post("/verify/start", async (c) => {
  requireManager(c);
  const b = await readInput(c, z.object({ kind: z.enum(["PHONE", "EMAIL"]) }).strict());
  const shop = (await readShop(c)) as Shop & { phone?: string; email?: string };
  const target = b.kind === "PHONE" ? shop.phone || "" : shop.email || "";
  if (!target) fail(409, b.kind === "PHONE" ? "Add a mobile number first" : "Add an email address first");
  await throttle(c, "verify-start", `${shop.id}:${b.kind}`);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const now = Date.now();
  const ms = await msgShop(c, shop.id);
  const origin = new URL(c.req.url).origin;
  const ps = providerStatus();
  const live = b.kind === "PHONE" ? ps.sms.provider !== "mailbox" : ps.email.provider !== "mailbox";
  const stmts = enqueue(c.env.DB, ms, b.kind === "PHONE" ? { phone: target } : { email: target }, "verify_contact", { code, kind: b.kind }, { related: { type: "shop_verify", id: shop.id }, origin, channel: b.kind === "PHONE" ? "SMS" : "EMAIL", now, force: true });
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO contact_codes(shop_id,kind,target,code_hash,expires_at,attempts,created_at) VALUES(?,?,?,?,?,0,?) ON CONFLICT(shop_id,kind) DO UPDATE SET target=excluded.target,code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,created_at=excluded.created_at",
    ).bind(shop.id, b.kind, target, await digest(`${shop.id}:${b.kind}:${target}:${code}`), now + CODE_TTL, now),
    ...stmts,
    audit(c, "shop", shop.id, "CONTACT_CODE_SENT", `${b.kind === "PHONE" ? "SMS" : "Email"} verification code ${live ? "sent" : "shown on screen (no provider)"}.`),
  ]);
  if (stmts.length) await drain(c.env.DB, stmts.length, now, { type: "shop_verify", id: shop.id }).catch(() => {});
  return c.json({ ok: true, kind: b.kind, target, expires_at: now + CODE_TTL, delivery: live ? (b.kind === "PHONE" ? "sms" : "email") : "on_screen", ...(live ? {} : { sandbox_code: code }) }, 201);
});
setup.post("/verify/confirm", async (c) => {
  requireManager(c);
  const b = await readInput(c, z.object({ kind: z.enum(["PHONE", "EMAIL"]), code: z.string().trim().regex(/^\d{6}$/, "Six digits") }).strict());
  const shop = await readShop(c);
  await throttle(c, "verify-confirm", shop.id);
  const now = Date.now();
  const row = await c.env.DB.prepare("SELECT * FROM contact_codes WHERE shop_id=? AND kind=?").bind(shop.id, b.kind).first<{ target: string; code_hash: string; expires_at: number; attempts: number }>();
  if (!row || row.expires_at <= now) return fail(409, "That code has expired. Send a new one.");
  if (row.attempts >= 5) fail(429, "Too many wrong codes. Send a new one.");
  if (row.code_hash !== (await digest(`${shop.id}:${b.kind}:${row.target}:${b.code}`))) {
    await c.env.DB.prepare("UPDATE contact_codes SET attempts=attempts+1 WHERE shop_id=? AND kind=?").bind(shop.id, b.kind).run();
    fail(401, "That code is not right. Check it and try again.");
  }
  const col = b.kind === "PHONE" ? "phone_verified_at" : "email_verified_at";
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE shops SET ${col}=? WHERE id=?`).bind(now, shop.id),
    c.env.DB.prepare("DELETE FROM contact_codes WHERE shop_id=? AND kind=?").bind(shop.id, b.kind),
    audit(c, "shop", shop.id, "CONTACT_VERIFIED", `${b.kind === "PHONE" ? "Mobile" : "Email"} verified.`),
  ]);
  return c.json({ ok: true, shop: await readShop(c) });
});

// Step 3 — starter menu. Adds the chosen rows in one batch; existing names are skipped.
setup.get("/starter", async (c) => {
  requireManager(c);
  const shop = (await readShop(c)) as Shop & { kind?: string };
  const kind = (c.req.query("kind") || shop.kind || "BARBER") as keyof typeof STARTER_MENUS;
  return c.json({ kind, menu: STARTER_MENUS[kind] || STARTER_MENUS.BARBER, all: STARTER_MENUS });
});
const starterRow = z.object({ name: z.string().trim().min(1).max(80), category: z.string().trim().max(40).default(""), duration_min: z.number().int().min(5).max(480), price_pence: z.number().int().min(0).max(100000), popular: z.boolean().default(false) });
setup.post("/starter", async (c) => {
  requireManager(c);
  const b = await readInput(c, z.object({ services: z.array(starterRow).min(1).max(40) }).strict());
  const shop = await readShop(c);
  const existing = new Set(((await c.env.DB.prepare("SELECT lower(name) AS n FROM services WHERE shop_id=?").bind(shop.id).all<{ n: string }>()).results).map((r) => r.n));
  const rows = b.services.filter((s) => !existing.has(s.name.toLowerCase()));
  const stmts = rows.map((s, i) =>
    c.env.DB.prepare("INSERT INTO services(id,shop_id,name,category,duration_min,price_pence,active,description,colour,online_bookable,popular,sort_order,payment_mode) VALUES(?,?,?,?,?,?,1,'','sage',1,?,?,NULL)")
      .bind(uid(), shop.id, s.name, s.category, s.duration_min, s.price_pence, s.popular ? 1 : 0, existing.size + i),
  );
  if (stmts.length) await c.env.DB.batch([...stmts, audit(c, "shop", shop.id, "STARTER_MENU_ADDED", `${rows.length} services added from the starter menu.`)]);
  return c.json({ added: rows.length, skipped: b.services.length - rows.length }, 201);
});

// Step 6 — slug availability, live as the owner types.
setup.get("/slug", async (c) => {
  requireManager(c);
  const raw = (c.req.query("slug") || "").toLowerCase().trim();
  const parsed = slugSchema.safeParse(raw);
  if (!parsed.success) return c.json({ slug: raw, ok: false, reason: parsed.error.issues[0]?.message || "Letters, numbers and dashes only" });
  const shop = await readShop(c);
  const taken = await c.env.DB.prepare("SELECT 1 AS x FROM shops WHERE slug=? AND id<>?").bind(parsed.data, shop.id).first();
  const reserved = ["book", "api", "static", "workspace", "signup", "login", "admin", "ollo", "manage", "pay", "offer", "s"].includes(parsed.data);
  return c.json({ slug: parsed.data, ok: !taken && !reserved, reason: taken ? "Someone already has that address" : reserved ? "That one's reserved" : "" });
});
// Suggest a slug from the shop name (used to pre-fill).
export function suggestSlug(name: string) {
  return name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "my-shop";
}
setup.get("/slug/suggest", async (c) => {
  requireManager(c);
  const shop = await readShop(c);
  const base = suggestSlug(shop.name);
  const rows = (await c.env.DB.prepare("SELECT slug FROM shops WHERE slug LIKE ? AND id<>?").bind(`${base}%`, shop.id).all<{ slug: string }>()).results.map((r) => r.slug);
  let slug = base, n = 2;
  while (rows.includes(slug)) slug = `${base}-${n++}`;
  return c.json({ slug });
});

// Step 7 — the deposit/cancellation policy without the full /shop payload. Card-at-booking itself
// is switched on through PUT /shop/payments (needs Stripe live), which the step calls afterwards.
setup.put("/policy", async (c) => {
  requireManager(c);
  const b = await readInput(c, z.object({
    deposit_pence: z.number().int().min(0).max(50000),
    cancel_hours: z.number().int().min(0).max(168),
    no_show_grace: z.number().int().min(0).max(120),
    payment_mode: z.enum(["PREPAY", "DEPOSIT", "PAY_AT_VISIT"]),
  }).strict());
  const shop = await readShop(c);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE shops SET deposit_pence=?, cancel_hours=?, no_show_grace=?, payment_mode=?, version=version+1 WHERE id=?").bind(b.deposit_pence, b.cancel_hours, b.no_show_grace, b.payment_mode, shop.id),
    audit(c, "shop", shop.id, "POLICY_UPDATED", `${b.payment_mode.toLowerCase().replace(/_/g, " ")}; deposit ${b.deposit_pence}p; cancel ${b.cancel_hours}h; no-show grace ${b.no_show_grace} min.`),
  ]);
  return c.json({ shop: await readShop(c) });
});

// QR + link for the booking page (also used by the Online step's share card).
setup.get("/share", async (c) => {
  requireManager(c);
  const shop = await readShop(c);
  if (!shop.slug) return c.json({ url: "", qr: "" });
  const origin = new URL(c.req.url).origin;
  const url = `${origin}/book/${shop.slug}`;
  const { default: QRCode } = await import("qrcode");
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 480 });
  return c.json({ url, page: `${origin}/${shop.slug}`, qr, embed: `<a href="${url}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font:600 15px system-ui">Book at ${shop.name.replace(/"/g, "&quot;")}</a>` });
});
export default setup;
