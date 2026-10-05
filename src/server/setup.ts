import { testAuthEnabled, oneTimeCode } from "./security";
// Shop setup: the guided wizard behind /workspace/setup.
//
// State lives in shops.setup_json ({step, done[], skipped[], completed_at}) so it survives devices
// and sign-outs. Every step is optional except the first save; the wizard is a front door onto
// settings that already exist (hours, services, team, online, payments), plus the pieces that
// only make sense at setup: contact verification, starter menus, a "send me a test".
import { Hono } from "hono";
import { z } from "zod";
import type { Database as DB } from "../db/client";
import { slugSchema, serviceSchema, onlineBookingSchema, type Shop } from "./domain";
import { audit, fail, readShop } from "./sandbox";
import { digest, readInput, throttle, type AppEnv } from "./accounts";
import { drain, enqueue, msgShop, providerStatus } from "./messaging";
import { shopUrl } from "./hosts";

type Env = AppEnv;
const setup = new Hono<Env>();
const uid = () => crypto.randomUUID();

// ---- Wizard state ---------------------------------------------------------------------------------
export const SETUP_STEPS = ["shop", "brand", "hours", "services", "team", "messages", "terms", "online", "payments"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export type SetupState = { step: SetupStep; done: SetupStep[]; skipped: SetupStep[]; completed_at: number | null; started_at: number | null; dismissed: boolean };
export function setupState(shop: Pick<Shop, "setup_json">): SetupState {
  let j: Partial<SetupState> = {};
  try { const parsed = JSON.parse(shop.setup_json || "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) j = parsed; } catch { /* default */ }
  return {
    step: SETUP_STEPS.includes(j.step as SetupStep) ? (j.step as SetupStep) : "shop",
    done: (Array.isArray(j.done) ? [...new Set(j.done)] : []).filter((s): s is SetupStep => SETUP_STEPS.includes(s as SetupStep)),
    skipped: (Array.isArray(j.skipped) ? [...new Set(j.skipped)] : []).filter((s): s is SetupStep => SETUP_STEPS.includes(s as SetupStep)),
    completed_at: j.completed_at ?? null,
    started_at: j.started_at ?? null,
    dismissed: !!j.dismissed,
  };
}
// What the data says is actually done — the wizard shows this, not just what was clicked through.
export async function setupProgress(db: DB, shop: Shop & { phone?: string; email?: string; phone_verified_at?: number | null; email_verified_at?: number | null }) {
  const [svc, staff, invites, members, pageRow] = await Promise.all([
    db.prepare("SELECT COUNT(*)::int AS n FROM services WHERE shop_id=? AND active=1").bind(shop.id).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*)::int AS n FROM staff WHERE shop_id=? AND active=1").bind(shop.id).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*)::int AS n FROM staff_invitations WHERE shop_id=? AND revoked=0").bind(shop.id).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*)::int AS n FROM app_memberships WHERE shop_id=? AND role<>'OWNER' AND active=1").bind(shop.id).first<{ n: number }>(),
    db.prepare("SELECT logo_url, cover_url, accent, primary_hex FROM shop_pages WHERE shop_id=?").bind(shop.id).first<{ logo_url: string; cover_url: string; accent: string; primary_hex: string }>(),
  ]);
  return {
    brand: { logo: !!pageRow?.logo_url, cover: !!pageRow?.cover_url, accent: pageRow?.primary_hex || pageRow?.accent || "ollo" },
    terms: { text: !!(shop as { terms_text?: string }).terms_text, cancel_hours: shop.cancel_hours, lead_time_min: shop.lead_time_min, booking_window_days: shop.booking_window_days },
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
  const s = await c.env.DB.transaction(async db => {
  const shop = (await db.prepare("SELECT * FROM shops WHERE id=? FOR UPDATE").bind(c.get("shopId")).first<Shop>())!;
  let s = setupState(shop);
  const now = Date.now();
  if (b.restart) s = { step: "shop", done: [], skipped: [], completed_at: null, started_at: now, dismissed: false };
  if (!s.started_at) s.started_at = now;
  if (b.step) s.step = b.step;
  if (b.done) { s.done = [...new Set([...s.done, b.done])]; s.skipped = s.skipped.filter((x) => x !== b.done); }
  if (b.skipped) { s.skipped = [...new Set([...s.skipped, b.skipped])]; s.done = s.done.filter(step => step !== b.skipped); }
  if (b.complete) s.completed_at = s.completed_at ?? now;
  if (b.dismissed !== undefined) s.dismissed = b.dismissed;
  await db.batch([
    c.env.DB.prepare("UPDATE shops SET setup_json=? WHERE id=?").bind(JSON.stringify(s), shop.id),
    ...(b.complete && !setupState(shop).completed_at ? [audit(c, "shop", shop.id, "SETUP_COMPLETED", `${s.done.length} of ${SETUP_STEPS.length} steps done, ${s.skipped.length} skipped.`)] : []),
  ]);
  return s;
  });
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
  timezone: z.string().trim().min(1).max(64).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Unknown timezone"),
  currency: z.enum(["GBP", "EUR", "USD"]),
  // Optional business identity (Settings → Business details).
  legal_name: z.string().trim().max(160).optional(),
  vat_number: z.string().trim().max(32).optional(),
  company_number: z.string().trim().max(32).optional(),
  website: z.union([z.literal(""), z.string().trim().url().max(300)]).optional(),
}).strict();
setup.put("/contact", async (c) => {
  requireManager(c);
  const b = await readInput(c, contactSchema);
  const phone = b.phone ? ukMobile(b.phone) : "";
  if (b.phone && !phone) fail(400, "Enter a UK mobile number (07… or +447…)");
  await c.env.DB.transaction(async db => {
  const shop = (await db.prepare("SELECT * FROM shops WHERE id=? FOR UPDATE").bind(c.get("shopId")).first<Shop & { phone?: string; email?: string }>())!;
  // Changing a verified value un-verifies it.
  const phoneChanged = (phone || "") !== (shop.phone || ""), emailChanged = b.email !== (shop.email || "");
  await db.batch([
    c.env.DB.prepare(
      `UPDATE shops SET name=?, kind=?, phone=?, email=?, address=?, timezone=?, currency=?, legal_name=COALESCE(?,legal_name), vat_number=COALESCE(?,vat_number), company_number=COALESCE(?,company_number), website=COALESCE(?,website), version=version+1${phoneChanged ? ", phone_verified_at=NULL" : ""}${emailChanged ? ", email_verified_at=NULL" : ""} WHERE id=?`,
    ).bind(b.name, b.kind, phone || "", b.email, b.address, b.timezone, b.currency, b.legal_name ?? null, b.vat_number ?? null, b.company_number ?? null, b.website ?? null, shop.id),
    ...(phoneChanged ? [c.env.DB.prepare("DELETE FROM contact_codes WHERE shop_id=? AND kind='PHONE'").bind(shop.id)] : []),
    ...(emailChanged ? [c.env.DB.prepare("DELETE FROM contact_codes WHERE shop_id=? AND kind='EMAIL'").bind(shop.id)] : []),
    audit(c, "shop", shop.id, "SHOP_CONTACT_UPDATED", `${b.kind.toLowerCase()} · ${phone ? "mobile set" : "no mobile"} · ${b.email ? "email set" : "no email"}.`),
  ]);
  });
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
  const code = oneTimeCode();
  const now = Date.now();
  const ms = await msgShop(c, shop.id);
  const origin = new URL(c.req.url).origin;
  const ps = providerStatus();
  const live = b.kind === "PHONE" ? ps.sms.provider !== "mailbox" : ps.email.provider !== "mailbox";
  if (!live && !testAuthEnabled()) fail(503, "Contact verification is temporarily unavailable");
  const stmts = enqueue(c.env.DB, ms, b.kind === "PHONE" ? { phone: target } : { email: target }, "verify_contact", { code, kind: b.kind }, { related: { type: "shop_verify", id: shop.id }, origin, channel: b.kind === "PHONE" ? "SMS" : "EMAIL", now, force: true });
  await c.env.DB.transaction(async db => {
    const contact = b.kind === "PHONE" ? "phone" : "email";
    const current = await db.prepare(`SELECT ${contact} AS target FROM shops WHERE id=? FOR UPDATE`).bind(shop.id).first<{ target: string }>();
    if (current?.target !== target) return fail(409, "Contact details changed. Send a new code.");
    await db.batch([
    c.env.DB.prepare(
      "INSERT INTO contact_codes(shop_id,kind,target,code_hash,expires_at,attempts,created_at) VALUES(?,?,?,?,?,0,?) ON CONFLICT(shop_id,kind) DO UPDATE SET target=excluded.target,code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,created_at=excluded.created_at",
    ).bind(shop.id, b.kind, target, await digest(`${shop.id}:${b.kind}:${target}:${code}`), now + CODE_TTL, now),
    ...stmts,
    audit(c, "shop", shop.id, "CONTACT_CODE_SENT", `${b.kind === "PHONE" ? "SMS" : "Email"} verification code ${live ? "sent" : "shown on screen (no provider)"}.`),
  ]);
  });
  if (stmts.length) await drain(c.env.DB, stmts.length, now, { type: "shop_verify", id: shop.id }).catch(() => {});
  return c.json({ ok: true, kind: b.kind, target, expires_at: now + CODE_TTL, delivery: live ? (b.kind === "PHONE" ? "sms" : "email") : "on_screen", ...(live ? {} : { sandbox_code: code }) }, 201);
});
setup.post("/verify/confirm", async (c) => {
  requireManager(c);
  const b = await readInput(c, z.object({ kind: z.enum(["PHONE", "EMAIL"]), code: z.string().trim().regex(/^\d{6}$/, "Six digits") }).strict());
  const shop = await readShop(c);
  await throttle(c, "verify-confirm", shop.id);
  const now = Date.now();
  const result = await c.env.DB.transaction(async db => {
    const contact = b.kind === "PHONE" ? "phone" : "email";
    const current = await db.prepare(`SELECT ${contact} AS target FROM shops WHERE id=? FOR UPDATE`).bind(shop.id).first<{ target: string }>();
    const row = await db.prepare("SELECT * FROM contact_codes WHERE shop_id=? AND kind=? FOR UPDATE").bind(shop.id, b.kind).first<{ target: string; code_hash: string; expires_at: number; attempts: number }>();
    if (!row || row.expires_at <= now) return { status: 409 as const, message: "That code has expired. Send a new one." };
    if (current?.target !== row.target) return { status: 409 as const, message: "Contact details changed. Send a new code." };
    if (row.attempts >= 5) return { status: 429 as const, message: "Too many wrong codes. Send a new one." };
    if (row.code_hash !== await digest(`${shop.id}:${b.kind}:${row.target}:${b.code}`)) {
      await db.prepare("UPDATE contact_codes SET attempts=attempts+1 WHERE shop_id=? AND kind=?").bind(shop.id, b.kind).run();
      return { status: 401 as const, message: "That code is not right. Check it and try again." };
    }
    const col = b.kind === "PHONE" ? "phone_verified_at" : "email_verified_at";
    await db.batch([
      db.prepare(`UPDATE shops SET ${col}=? WHERE id=? AND ${contact}=?`).bind(now, shop.id, row.target),
      db.prepare("DELETE FROM contact_codes WHERE shop_id=? AND kind=?").bind(shop.id, b.kind),
      audit(c, "shop", shop.id, "CONTACT_VERIFIED", `${b.kind === "PHONE" ? "Mobile" : "Email"} verified.`),
    ]);
    return null;
  });
  if (result) return fail(result.status, result.message);
  return c.json({ ok: true, shop: await readShop(c) });
});

// Step 3 — starter menu. Adds the chosen rows in one batch; existing names are skipped.
setup.get("/starter", async (c) => {
  requireManager(c);
  const shop = (await readShop(c)) as Shop & { kind?: string };
  const kind = (c.req.query("kind") || shop.kind || "BARBER") as keyof typeof STARTER_MENUS;
  return c.json({ kind, menu: STARTER_MENUS[kind] || STARTER_MENUS.BARBER, all: STARTER_MENUS });
});
const starterRow = z.object({ name: serviceSchema.shape.name, category: z.string().trim().max(40).default("Services"), duration_min: serviceSchema.shape.duration_min, price_pence: serviceSchema.shape.price_pence, popular: z.boolean().default(false) });
setup.post("/starter", async (c) => {
  requireManager(c);
  const b = await readInput(c, z.object({ services: z.array(starterRow).min(1).max(40) }).strict());
  const shop = await readShop(c);
  const result = await c.env.DB.transaction(async db => {
    await db.prepare("SELECT id FROM shops WHERE id=? FOR UPDATE").bind(shop.id).first();
  const existing = new Set(((await db.prepare("SELECT lower(name) AS n FROM services WHERE shop_id=?").bind(shop.id).all<{ n: string }>()).results).map((r) => r.n));
  const rows = b.services.filter(s => { const name = s.name.toLowerCase(); if (existing.has(name)) return false; existing.add(name); return true; });
  const stmts = rows.map((s, i) =>
    db.prepare("INSERT INTO services(id,shop_id,name,category,duration_min,price_pence,active,description,colour,online_bookable,popular,sort_order,payment_mode) VALUES(?,?,?,?,?,?,1,'','sage',1,?,?,NULL)")
      .bind(uid(), shop.id, s.name, s.category || "Services", s.duration_min, s.price_pence, s.popular ? 1 : 0, existing.size + i),
  );
  if (stmts.length) await db.batch([...stmts, audit(c, "shop", shop.id, "STARTER_MENU_ADDED", `${rows.length} services added from the starter menu.`)]);
  return { added: rows.length, skipped: b.services.length - rows.length };
  });
  return c.json(result, 201);
});

// Step 6 — slug availability, live as the owner types.
setup.get("/slug", async (c) => {
  requireManager(c);
  const raw = (c.req.query("slug") || "").toLowerCase().trim();
  const parsed = slugSchema.safeParse(raw);
  if (!parsed.success) return c.json({ slug: raw, ok: false, reason: parsed.error.issues[0]?.message || "Letters, numbers and dashes only" });
  const shop = await readShop(c);
  const taken = await c.env.DB.prepare("SELECT 1 AS x FROM shops WHERE slug=? AND id<>?").bind(parsed.data, shop.id).first();
  const reserved = ["book", "api", "static", "workspace", "signup", "login", "admin", "ollo", "manage", "pay", "offer", "s", "barbers", "salons", "beauty", "tattoo", "clinics", "trainers", "pricing", "industries"].includes(parsed.data);
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
    lead_time_min: onlineBookingSchema.shape.lead_time_min.optional(),
    booking_window_days: onlineBookingSchema.shape.booking_window_days.optional(),
    terms_text: onlineBookingSchema.shape.terms_text.optional(),
    version: z.number().int().min(0).optional(),
  }).strict().refine(b => (b.terms_text === undefined && b.lead_time_min === undefined && b.booking_window_days === undefined) || b.version !== undefined, "Reload before saving booking rules"));
  await c.env.DB.transaction(async db => {
    const shop = (await db.prepare("SELECT * FROM shops WHERE id=? FOR UPDATE").bind(c.get("shopId")).first<Shop>())!;
    if (b.version !== undefined && b.version !== shop.version) return fail(409, "Shop changed elsewhere. Reload before saving.");
    const terms = b.terms_text ?? shop.terms_text;
    const changed = terms !== shop.terms_text;
    await db.batch([
      db.prepare("UPDATE shops SET deposit_pence=?, cancel_hours=?, no_show_grace=?, payment_mode=?, lead_time_min=?, booking_window_days=?, terms_text=?, terms_version=terms_version+?, terms_updated_at=CASE WHEN ?=1 THEN ? ELSE terms_updated_at END, version=version+1 WHERE id=?")
        .bind(b.deposit_pence, b.cancel_hours, b.no_show_grace, b.payment_mode, b.lead_time_min ?? shop.lead_time_min, b.booking_window_days ?? shop.booking_window_days, terms, changed ? 1 : 0, changed ? 1 : 0, Date.now(), shop.id),
      audit(c, "shop", shop.id, "POLICY_UPDATED", `${b.payment_mode.toLowerCase().replace(/_/g, " ")}; deposit ${b.deposit_pence}p; cancel ${b.cancel_hours}h; no-show grace ${b.no_show_grace} min.`),
    ]);
  });
  return c.json({ shop: await readShop(c) });
});

// QR + link for the booking page (also used by the Online step's share card).
setup.get("/share", async (c) => {
  requireManager(c);
  const shop = await readShop(c);
  if (!shop.slug) return c.json({ url: "", qr: "" });
  const origin = new URL(c.req.url).origin;
  const url = shopUrl(shop.slug!, "/book", origin);
  const { default: QRCode } = await import("qrcode");
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 480 });
  return c.json({ url, page: shopUrl(shop.slug!, "/", origin), qr, embed: `<a href="${url}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font:600 15px system-ui">Book at ${shop.name.replace(/"/g, "&quot;")}</a>` });
});
export default setup;
