// OLLO master admin: oversee every shop, support them, and run billing.
//
// Access: a signed-in app user whose id is in platform_admins. Roles: SUPER (everything, incl.
// admins and prices), FINANCE (billing, invoices, discounts), SUPPORT (read, notes, grants,
// impersonate). Unknown users get 404 so the panel's existence is not confirmed. Every write is
// recorded in admin_audit with a required reason on financial/destructive actions.
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Database as DB } from "../db/client";
import { ACCOUNT_COOKIE, digest, type AppEnv } from "./accounts";
import { entitlements, features, logBilling, plans, platformBilling, setFeature, usageFor, estimate, type PlanRow, type FeatureRow } from "./billing";
import { providerStatus } from "./messaging";
import { stripeStatus } from "./stripe";

type Role = "SUPER" | "SUPPORT" | "FINANCE";
type Admin = { user_id: string; role: Role; name: string; email: string };
type Env = AppEnv & { Variables: { admin: Admin } };
type Ctx = Context<Env>;

const uid = () => crypto.randomUUID();
const fail = (status: 400 | 401 | 403 | 404 | 409, message: string): never => { throw new HTTPException(status, { message }); };

// Resolve the signed-in user from the normal session cookie, then check platform_admins.
// First request ever: seed from OLLO_ADMIN_EMAILS (comma-separated) if the table is empty.
async function resolveAdmin(c: Ctx): Promise<Admin | null> {
  const token = getCookie(c, ACCOUNT_COOKIE);
  if (!token) return null;
  const db = c.env.DB;
  const user = await db.prepare(
    "SELECT u.id, u.name, u.email FROM app_sessions s JOIN app_memberships m ON m.id=s.membership_id JOIN app_users u ON u.id=m.user_id WHERE s.token_hash=? AND s.expires_at>?",
  ).bind(await digest(token), Date.now()).first<{ id: string; name: string; email: string }>();
  if (!user) return null;
  const count = (await db.prepare("SELECT COUNT(*)::int AS n FROM platform_admins").first<{ n: number }>())?.n ?? 0;
  if (count === 0) {
    const seeds = (c.env.OLLO_ADMIN_EMAILS ?? process.env.OLLO_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (seeds.includes(user.email.toLowerCase())) {
      await db.prepare("INSERT INTO platform_admins(user_id,role,created_by,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO NOTHING").bind(user.id, "SUPER", "seed", Date.now()).run();
    }
  }
  const row = await db.prepare("SELECT role FROM platform_admins WHERE user_id=?").bind(user.id).first<{ role: Role }>();
  return row ? { user_id: user.id, role: row.role, name: user.name, email: user.email } : null;
}

const admin = new Hono<Env>();
admin.use("*", async (c, next) => {
  const a = await resolveAdmin(c);
  if (!a) fail(404, "Not found");
  c.set("admin", a!);
  c.header("Cache-Control", "no-store");
  await next();
});
const need = (c: Ctx, roles: Role[]) => { if (!roles.includes(c.get("admin").role)) { void audit(c, null, "DENIED", {}, { path: c.req.path }, ""); fail(403, "Your admin role cannot do that"); } };
async function audit(c: Ctx, shopId: string | null, action: string, before: unknown, after: unknown, reason: string) {
  await c.env.DB.prepare("INSERT INTO admin_audit(id,admin_id,shop_id,action,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(uid(), c.get("admin").user_id, shopId, action, JSON.stringify(before ?? {}), JSON.stringify(after ?? {}), reason, Date.now()).run();
}
const reasonSchema = z.string().trim().min(5, "Give a reason (at least 5 characters)").max(300);
async function body<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  const p = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) fail(400, p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return p.data as T;
}

admin.get("/me", (c) => c.json({ admin: c.get("admin") }));

// ---- Overview ------------------------------------------------------------------------------------
admin.get("/overview", async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const [shops, subs, trialsEnding, pastDue, failedMsgs, issues, mrr, pb, stripe] = await Promise.all([
    db.prepare("SELECT COUNT(*)::int AS n FROM shops").first<{ n: number }>(),
    db.prepare("SELECT status, COUNT(*)::int AS n FROM shop_subscriptions GROUP BY status").all<{ status: string; n: number }>(),
    db.prepare("SELECT COUNT(*)::int AS n FROM shop_subscriptions WHERE status='TRIAL' AND trial_ends_at BETWEEN ? AND ?").bind(now, now + 7 * 86400000).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*)::int AS n FROM shop_subscriptions WHERE status='PAST_DUE'").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*)::int AS n FROM notifications WHERE status='FAILED' AND created_at>?").bind(now - 86400000).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE status IN ('CONFIRMED','CHECKED_IN') AND start_at>? AND start_at<?").bind(now, now + 7 * 86400000).first<{ n: number }>(),
    // MRR from local truth: plan + billable seats + paid add-ons for ACTIVE/TRIAL shops (trial counted as pipeline separately)
    db.prepare(`SELECT ss.status, COALESCE(SUM(p.monthly_pence + GREATEST(0, ss.seats - p.included_seats) * p.seat_pence),0)::bigint AS base FROM shop_subscriptions ss JOIN plans p ON p.id=ss.plan_id GROUP BY ss.status`).all<{ status: string; base: number }>(),
    platformBilling(db),
    Promise.resolve(stripeStatus()),
  ]);
  const addonMrr = (await db.prepare("SELECT COALESCE(SUM(f.monthly_pence),0)::bigint AS n FROM shop_features sf JOIN features f ON f.key=sf.feature_key JOIN shop_subscriptions ss ON ss.shop_id=sf.shop_id WHERE sf.enabled=1 AND sf.source='ADDON' AND ss.status='ACTIVE'").first<{ n: number }>())?.n ?? 0;
  const activeBase = Number(mrr.results.find((r) => r.status === "ACTIVE")?.base ?? 0);
  const trialBase = Number(mrr.results.find((r) => r.status === "TRIAL")?.base ?? 0);
  const monthlyRevenue = activeBase + Number(addonMrr);
  return c.json({
    shops: shops?.n ?? 0,
    by_status: Object.fromEntries(subs.results.map((r) => [r.status, r.n])),
    trials_ending_7d: trialsEnding?.n ?? 0,
    past_due: pastDue?.n ?? 0,
    failed_messages_24h: failedMsgs?.n ?? 0,
    upcoming_appointments_7d: issues?.n ?? 0,
    mrr_pence: monthlyRevenue,
    trial_pipeline_pence: trialBase,
    vat: { mode: pb.vat_mode, threshold_pence: pb.vat_threshold_pence, annualised_pence: monthlyRevenue * 12, pct_of_threshold: pb.vat_threshold_pence ? Math.round((monthlyRevenue * 12 * 100) / pb.vat_threshold_pence) : 0 },
    providers: { ...providerStatus(), stripe },
  });
});

// ---- Shops ------------------------------------------------------------------------------------
admin.get("/shops", async (c) => {
  const q = (c.req.query("q") || "").trim().toLowerCase();
  const status = c.req.query("status") || "";
  const rows = (await c.env.DB.prepare(
    `SELECT s.id, s.name, s.slug, s.kind, s.timezone, s.created_at, s.online_booking,
            ss.status, ss.plan_id, ss.seats, ss.trial_ends_at, ss.current_period_end, ss.past_due_since,
            u.email AS owner_email, u.name AS owner_name,
            (SELECT COUNT(*)::int FROM staff st WHERE st.shop_id=s.id AND st.active=1) AS active_staff,
            (SELECT MAX(b.created_at) FROM bookings b WHERE b.shop_id=s.id) AS last_booking_at,
            (SELECT COUNT(*)::int FROM bookings b WHERE b.shop_id=s.id AND b.created_at>?) AS bookings_30d,
            p.monthly_pence + GREATEST(0, ss.seats - p.included_seats) * p.seat_pence AS base_pence
     FROM shops s
     LEFT JOIN shop_subscriptions ss ON ss.shop_id=s.id
     LEFT JOIN plans p ON p.id=ss.plan_id
     LEFT JOIN shop_owners so ON so.shop_id=s.id
     LEFT JOIN app_users u ON u.id=so.user_id
     WHERE (? = '' OR LOWER(s.name) LIKE ? OR LOWER(s.slug) LIKE ? OR LOWER(u.email) LIKE ?)
       AND (? = '' OR ss.status = ?)
     ORDER BY s.created_at DESC LIMIT 500`,
  ).bind(Date.now() - 30 * 86400000, q, `%${q}%`, `%${q}%`, `%${q}%`, status, status).all()).results;
  return c.json({ shops: rows });
});

async function shopDetail(db: DB, shopId: string) {
  const shop = await db.prepare("SELECT s.*, u.email AS owner_email, u.name AS owner_name FROM shops s LEFT JOIN shop_owners so ON so.shop_id=s.id LEFT JOIN app_users u ON u.id=so.user_id WHERE s.id=?").bind(shopId).first();
  if (!shop) return null;
  const [ent, est, usage, invoices, adjustments, events, notes, adminAudit, members, staff, msgs, calls, connect, disputes, recentAudit, discounts, issues] = await Promise.all([
    entitlements(db, shopId),
    estimate(db, shopId),
    usageFor(db, shopId),
    db.prepare("SELECT * FROM invoices WHERE shop_id=? ORDER BY period_start DESC LIMIT 36").bind(shopId).all().then((r) => r.results),
    db.prepare("SELECT * FROM invoice_adjustments WHERE shop_id=? ORDER BY created_at DESC LIMIT 50").bind(shopId).all().then((r) => r.results),
    db.prepare("SELECT * FROM billing_events WHERE shop_id=? ORDER BY created_at DESC LIMIT 60").bind(shopId).all().then((r) => r.results),
    db.prepare("SELECT n.*, u.name AS admin_name FROM support_notes n LEFT JOIN app_users u ON u.id=n.admin_id WHERE n.shop_id=? ORDER BY n.created_at DESC LIMIT 100").bind(shopId).all().then((r) => r.results),
    db.prepare("SELECT a.*, u.name AS admin_name FROM admin_audit a LEFT JOIN app_users u ON u.id=a.admin_id WHERE a.shop_id=? ORDER BY a.created_at DESC LIMIT 100").bind(shopId).all().then((r) => r.results),
    db.prepare("SELECT m.id, m.role, m.active, u.name, u.email FROM app_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.shop_id=? ORDER BY m.role").bind(shopId).all().then((r) => r.results),
    db.prepare("SELECT id, name, role, active, photo_url FROM staff WHERE shop_id=? ORDER BY active DESC, name").bind(shopId).all().then((r) => r.results),
    db.prepare("SELECT channel, status, COUNT(*)::int AS n FROM notifications WHERE shop_id=? AND created_at>? GROUP BY channel, status").bind(shopId, Date.now() - 30 * 86400000).all().then((r) => r.results),
    db.prepare("SELECT COUNT(*)::int AS n, COALESCE(SUM(duration_s),0)::int AS secs FROM voice_calls WHERE shop_id=? AND created_at>?").bind(shopId, Date.now() - 30 * 86400000).first(),
    db.prepare("SELECT id, owner_type, owner_id, charges_enabled, payouts_enabled, disabled_reason FROM connected_accounts WHERE shop_id=?").bind(shopId).all().then((r) => r.results),
    db.prepare("SELECT COUNT(*)::int AS n FROM disputes WHERE shop_id=? AND status NOT IN ('won','lost','warning_closed')").bind(shopId).first().catch(() => ({ n: 0 })),
    db.prepare("SELECT * FROM audit_events WHERE shop_id=? ORDER BY created_at DESC LIMIT 40").bind(shopId).all().then((r) => r.results),
    db.prepare("SELECT d.*, sd.applied_at, sd.applied_by, sd.ends_at AS applied_until FROM shop_discounts sd JOIN discounts d ON d.id=sd.discount_id WHERE sd.shop_id=?").bind(shopId).all().then((r) => r.results),
    db.prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE shop_id=? AND status IN ('CONFIRMED','CHECKED_IN') AND start_at>?").bind(shopId, Date.now()).first(),
  ]);
  return { shop, entitlements: ent, estimate: est, usage, invoices, adjustments, events, notes, admin_audit: adminAudit, members, staff, messaging_30d: msgs, calls_30d: calls, connect, open_disputes: (disputes as { n: number })?.n ?? 0, audit: recentAudit, discounts, upcoming: (issues as { n: number })?.n ?? 0, features: await features(db), plans: await plans(db) };
}
admin.get("/shops/:id", async (c) => {
  const d = await shopDetail(c.env.DB, c.req.param("id"));
  if (!d) fail(404, "Shop not found");
  return c.json(d);
});

// Subscription controls
admin.post("/shops/:id/subscription", async (c) => {
  need(c, ["SUPER", "FINANCE", "SUPPORT"]);
  const shopId = c.req.param("id");
  const b = await body(c, z.object({
    action: z.enum(["EXTEND_TRIAL", "PAUSE", "RESUME", "CANCEL", "SET_PLAN", "MARK_ACTIVE", "MARK_PAST_DUE", "CLEAR_PAST_DUE"]),
    days: z.number().int().min(1).max(365).optional(),
    plan_id: z.string().optional(),
    reason: reasonSchema,
  }).strict());
  if (["CANCEL", "SET_PLAN", "MARK_ACTIVE", "MARK_PAST_DUE"].includes(b.action)) need(c, ["SUPER", "FINANCE"]);
  const db = c.env.DB;
  const before = await db.prepare("SELECT * FROM shop_subscriptions WHERE shop_id=?").bind(shopId).first();
  if (!before) fail(404, "No subscription");
  const now = Date.now();
  let sql = "", args: unknown[] = [], summary = "";
  switch (b.action) {
    case "EXTEND_TRIAL": { const base = Math.max(now, Number((before as { trial_ends_at: number | null }).trial_ends_at ?? now)); sql = "UPDATE shop_subscriptions SET status='TRIAL', trial_ends_at=?, past_due_since=NULL"; args = [base + (b.days ?? 14) * 86400000]; summary = `Trial extended by ${b.days ?? 14} days`; break; }
    case "PAUSE": sql = "UPDATE shop_subscriptions SET status='PAUSED'"; summary = "Subscription paused"; break;
    case "RESUME": sql = "UPDATE shop_subscriptions SET status='ACTIVE', past_due_since=NULL"; summary = "Subscription resumed"; break;
    case "CANCEL": sql = "UPDATE shop_subscriptions SET status='CANCELLED', cancel_at=?"; args = [now]; summary = "Subscription cancelled"; break;
    case "SET_PLAN": { if (!b.plan_id || !(await db.prepare("SELECT 1 FROM plans WHERE id=? AND active=1").bind(b.plan_id).first())) fail(400, "Unknown plan"); sql = "UPDATE shop_subscriptions SET plan_id=?"; args = [b.plan_id]; summary = `Plan changed to ${b.plan_id}`; break; }
    case "MARK_ACTIVE": sql = "UPDATE shop_subscriptions SET status='ACTIVE', past_due_since=NULL, current_period_start=COALESCE(current_period_start,?), current_period_end=COALESCE(current_period_end,?)"; args = [now, now + 30 * 86400000]; summary = "Marked active"; break;
    case "MARK_PAST_DUE": sql = "UPDATE shop_subscriptions SET status='PAST_DUE', past_due_since=COALESCE(past_due_since,?)"; args = [now]; summary = "Marked payment overdue"; break;
    case "CLEAR_PAST_DUE": sql = "UPDATE shop_subscriptions SET status='ACTIVE', past_due_since=NULL"; summary = "Overdue cleared"; break;
  }
  await db.prepare(`${sql}, version=version+1, updated_at=? WHERE shop_id=?`).bind(...args, now, shopId).run();
  const after = await db.prepare("SELECT * FROM shop_subscriptions WHERE shop_id=?").bind(shopId).first();
  await audit(c, shopId, `SUBSCRIPTION_${b.action}`, before, after, b.reason);
  await logBilling(db, shopId, `ADMIN_${b.action}`, `${summary} by OLLO support — ${b.reason}`, `admin:${c.get("admin").user_id}`);
  await db.prepare("UPDATE shops SET version=version+1 WHERE id=?").bind(shopId).run();
  return c.json({ subscription: after });
});

// Feature grant / block / clear
admin.post("/shops/:id/features", async (c) => {
  need(c, ["SUPER", "FINANCE", "SUPPORT"]);
  const shopId = c.req.param("id");
  const b = await body(c, z.object({ key: z.string(), mode: z.enum(["GRANT", "BLOCK", "CLEAR"]), ends_at: z.number().int().nullable().optional(), reason: reasonSchema }).strict());
  const db = c.env.DB;
  const before = await db.prepare("SELECT * FROM shop_features WHERE shop_id=? AND feature_key=?").bind(shopId, b.key).first();
  if (b.mode === "CLEAR") {
    await db.prepare("DELETE FROM shop_features WHERE shop_id=? AND feature_key=? AND source IN ('ADMIN_GRANT','ADMIN_BLOCK')").bind(shopId, b.key).run();
    await logBilling(db, shopId, "ADMIN_FEATURE_CLEAR", `OLLO override removed for ${b.key} — ${b.reason}`, `admin:${c.get("admin").user_id}`);
  } else {
    await setFeature(db, shopId, b.key, b.mode === "GRANT", b.mode === "GRANT" ? "ADMIN_GRANT" : "ADMIN_BLOCK", `admin:${c.get("admin").user_id}`, b.reason, b.ends_at ?? null);
  }
  const after = await db.prepare("SELECT * FROM shop_features WHERE shop_id=? AND feature_key=?").bind(shopId, b.key).first();
  await audit(c, shopId, `FEATURE_${b.mode}`, before, after, b.reason);
  await db.prepare("UPDATE shops SET version=version+1 WHERE id=?").bind(shopId).run();
  return c.json({ entitlements: await entitlements(db, shopId) });
});

// Discounts on a shop
admin.post("/shops/:id/discounts", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const shopId = c.req.param("id");
  const b = await body(c, z.object({ code: z.string().trim().min(2), remove: z.boolean().default(false), ends_at: z.number().int().nullable().optional(), reason: reasonSchema }).strict());
  const db = c.env.DB;
  const d = await db.prepare("SELECT * FROM discounts WHERE LOWER(code)=LOWER(?)").bind(b.code).first<{ id: string; name: string; max_redemptions: number | null; redeemed: number }>();
  if (!d) fail(404, "No such discount code");
  if (b.remove) {
    await db.prepare("DELETE FROM shop_discounts WHERE shop_id=? AND discount_id=?").bind(shopId, d!.id).run();
    await logBilling(db, shopId, "DISCOUNT_REMOVED", `Discount ${b.code} removed — ${b.reason}`, `admin:${c.get("admin").user_id}`);
  } else {
    if (d!.max_redemptions !== null && d!.redeemed >= d!.max_redemptions) fail(409, "This code has no redemptions left");
    const r = await db.prepare("INSERT INTO shop_discounts(shop_id,discount_id,applied_at,applied_by,ends_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING").bind(shopId, d!.id, Date.now(), `admin:${c.get("admin").user_id}`, b.ends_at ?? null).run();
    if (r.meta.changes) await db.prepare("UPDATE discounts SET redeemed=redeemed+1 WHERE id=?").bind(d!.id).run();
    await logBilling(db, shopId, "DISCOUNT_APPLIED", `Discount ${b.code} (${d!.name}) applied — ${b.reason}`, `admin:${c.get("admin").user_id}`);
  }
  await audit(c, shopId, b.remove ? "DISCOUNT_REMOVE" : "DISCOUNT_APPLY", {}, { code: b.code }, b.reason);
  return c.json({ estimate: await estimate(db, shopId) });
});

// Credits and one-off charges (mirrored to Stripe when connected)
admin.post("/shops/:id/adjustments", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const shopId = c.req.param("id");
  const b = await body(c, z.object({ kind: z.enum(["CREDIT", "CHARGE"]), amount_pence: z.number().int().min(1).max(1000000), reason: reasonSchema }).strict());
  const id = uid();
  await c.env.DB.prepare("INSERT INTO invoice_adjustments(id,shop_id,kind,amount_pence,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?)").bind(id, shopId, b.kind, b.amount_pence, b.reason, `admin:${c.get("admin").user_id}`, Date.now()).run();
  await logBilling(c.env.DB, shopId, `ADJUSTMENT_${b.kind}`, `${b.kind === "CREDIT" ? "Credit" : "One-off charge"} of £${(b.amount_pence / 100).toFixed(2)} on your next invoice — ${b.reason}`, `admin:${c.get("admin").user_id}`);
  await audit(c, shopId, `ADJUSTMENT_${b.kind}`, {}, { id, amount_pence: b.amount_pence }, b.reason);
  return c.json({ id });
});

// Support notes
admin.post("/shops/:id/notes", async (c) => {
  const shopId = c.req.param("id");
  const b = await body(c, z.object({ body: z.string().trim().min(1).max(4000) }).strict());
  const id = uid();
  await c.env.DB.prepare("INSERT INTO support_notes(id,shop_id,admin_id,body,created_at) VALUES(?,?,?,?,?)").bind(id, shopId, c.get("admin").user_id, b.body, Date.now()).run();
  return c.json({ id }, 201);
});

// Impersonation: a 30-minute session as the shop owner, flagged so the workspace shows a banner.
admin.post("/shops/:id/impersonate", async (c) => {
  need(c, ["SUPER", "SUPPORT", "FINANCE"]);
  const shopId = c.req.param("id");
  const b = await body(c, z.object({ reason: reasonSchema }).strict());
  const db = c.env.DB;
  const m = await db.prepare("SELECT m.id, m.version FROM app_memberships m WHERE m.shop_id=? AND m.role='OWNER' AND m.active=1 LIMIT 1").bind(shopId).first<{ id: string; version: number }>();
  if (!m) fail(404, "This shop has no active owner account");
  const raw = uid() + uid();
  const now = Date.now();
  await db.prepare("INSERT INTO app_sessions(token_hash,membership_id,created_at,expires_at) VALUES(?,?,?,?)").bind(await digest(raw), m!.id, now, now + 30 * 60000).run();
  await audit(c, shopId, "IMPERSONATE", {}, { membership_id: m!.id, expires_at: now + 30 * 60000 }, b.reason);
  await db.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid(), shopId, "shop", shopId, "SUPPORT_ACCESS", `admin:${c.get("admin").user_id}`, `OLLO support opened the workspace (30 min): ${b.reason}`, now).run();
  // Remember the admin so the workspace can show the red bar and a way back.
  setCookie(c, "ollo_impersonating", JSON.stringify({ admin: c.get("admin").name, shop: shopId, until: now + 30 * 60000 }), { path: "/", secure: true, sameSite: "Strict", maxAge: 30 * 60 });
  setCookie(c, ACCOUNT_COOKIE, raw, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 30 * 60 });
  return c.json({ ok: true, until: now + 30 * 60000 });
});

// ---- Billing catalogue: plans, features, discounts ---------------------------------------------
admin.get("/catalogue", async (c) => c.json({ plans: await plans(c.env.DB), features: (await c.env.DB.prepare("SELECT * FROM features ORDER BY sort").all<FeatureRow>()).results, discounts: (await c.env.DB.prepare("SELECT d.*, (SELECT COUNT(*)::int FROM shop_discounts sd WHERE sd.discount_id=d.id) AS shops FROM discounts d ORDER BY created_at DESC").all()).results, platform: await platformBilling(c.env.DB) }));
admin.put("/catalogue/plans/:id", async (c) => {
  need(c, ["SUPER"]);
  const b = await body(c, z.object({ name: z.string().trim().min(2).max(60), monthly_pence: z.number().int().min(0), included_seats: z.number().int().min(0), seat_pence: z.number().int().min(0), active: z.boolean(), reason: reasonSchema }).strict());
  const before = await c.env.DB.prepare("SELECT * FROM plans WHERE id=?").bind(c.req.param("id")).first<PlanRow>();
  await c.env.DB.prepare("INSERT INTO plans(id,name,monthly_pence,included_seats,seat_pence,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, monthly_pence=EXCLUDED.monthly_pence, included_seats=EXCLUDED.included_seats, seat_pence=EXCLUDED.seat_pence, active=EXCLUDED.active, updated_at=EXCLUDED.updated_at")
    .bind(c.req.param("id"), b.name, b.monthly_pence, b.included_seats, b.seat_pence, b.active ? 1 : 0, Date.now(), Date.now()).run();
  await audit(c, null, "PLAN_UPSERT", before, b, b.reason);
  return c.json({ ok: true });
});
admin.put("/catalogue/features/:key", async (c) => {
  need(c, ["SUPER"]);
  const b = await body(c, z.object({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(300), monthly_pence: z.number().int().min(0), unit_pence: z.number().int().min(0), included_units: z.number().int().min(0), in_plan: z.boolean(), active: z.boolean(), reason: reasonSchema }).strict());
  const before = await c.env.DB.prepare("SELECT * FROM features WHERE key=?").bind(c.req.param("key")).first();
  if (!before) fail(404, "Unknown feature");
  await c.env.DB.prepare("UPDATE features SET name=?, description=?, monthly_pence=?, unit_pence=?, included_units=?, in_plan=?, active=?, updated_at=? WHERE key=?").bind(b.name, b.description, b.monthly_pence, b.unit_pence, b.included_units, b.in_plan ? 1 : 0, b.active ? 1 : 0, Date.now(), c.req.param("key")).run();
  await audit(c, null, "FEATURE_UPSERT", before, b, b.reason);
  return c.json({ ok: true });
});
admin.post("/catalogue/discounts", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const b = await body(c, z.object({
    code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, - and _ only").transform((s) => s.toUpperCase()),
    name: z.string().trim().min(2).max(80), kind: z.enum(["PERCENT", "FIXED", "FREE_MONTHS", "SEATS_FREE"]), value: z.number().int().min(0),
    applies_to: z.string().default("ALL"), duration: z.enum(["ONCE", "REPEATING", "FOREVER"]).default("ONCE"), duration_months: z.number().int().min(1).default(1),
    max_redemptions: z.number().int().min(1).nullable().default(null), ends_at: z.number().int().nullable().default(null), note: z.string().trim().max(300).default(""), reason: reasonSchema,
  }).strict());
  if (b.kind === "PERCENT" && b.value > 100) fail(400, "Percent must be 0–100");
  const id = uid();
  await c.env.DB.prepare("INSERT INTO discounts(id,code,name,kind,value,applies_to,duration,duration_months,max_redemptions,ends_at,created_by,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, b.code, b.name, b.kind, b.value, b.applies_to, b.duration, b.duration_months, b.max_redemptions, b.ends_at, `admin:${c.get("admin").user_id}`, b.note, Date.now()).run().catch(() => fail(409, "That code already exists"));
  await audit(c, null, "DISCOUNT_CREATE", {}, b, b.reason);
  return c.json({ id }, 201);
});
admin.post("/catalogue/discounts/:id/deactivate", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const b = await body(c, z.object({ reason: reasonSchema }).strict());
  await c.env.DB.prepare("UPDATE discounts SET active=0 WHERE id=?").bind(c.req.param("id")).run();
  await audit(c, null, "DISCOUNT_DEACTIVATE", {}, { id: c.req.param("id") }, b.reason);
  return c.json({ ok: true });
});
admin.put("/catalogue/platform", async (c) => {
  need(c, ["SUPER"]);
  const b = await body(c, z.object({ vat_mode: z.enum(["NONE", "UK_20", "STRIPE_TAX"]), vat_number: z.string().trim().max(20), trial_days: z.number().int().min(0).max(90), grace_days: z.number().int().min(0).max(60), reason: reasonSchema }).strict());
  const before = await platformBilling(c.env.DB);
  await c.env.DB.prepare("UPDATE platform_billing SET vat_mode=?, vat_number=?, trial_days=?, grace_days=?, updated_at=? WHERE id=1").bind(b.vat_mode, b.vat_number, b.trial_days, b.grace_days, Date.now()).run();
  await audit(c, null, "PLATFORM_BILLING", before, b, b.reason);
  return c.json({ ok: true });
});

// ---- Invoices across shops -----------------------------------------------------------------------
admin.get("/invoices", async (c) => {
  const status = c.req.query("status") || "";
  const rows = (await c.env.DB.prepare("SELECT i.*, s.name AS shop_name FROM invoices i JOIN shops s ON s.id=i.shop_id WHERE (?='' OR i.status=?) ORDER BY i.period_start DESC LIMIT 500").bind(status, status).all()).results;
  const adjustments = (await c.env.DB.prepare("SELECT a.*, s.name AS shop_name FROM invoice_adjustments a JOIN shops s ON s.id=a.shop_id WHERE a.invoice_id IS NULL ORDER BY a.created_at DESC LIMIT 200").all()).results;
  return c.json({ invoices: rows, pending_adjustments: adjustments });
});

// ---- Ops -------------------------------------------------------------------------------------------
admin.get("/ops", async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const [failed, queued, recentEvents, unreported] = await Promise.all([
    db.prepare("SELECT n.id, n.shop_id, s.name AS shop_name, n.channel, n.recipient, n.template, n.error, n.created_at FROM notifications n JOIN shops s ON s.id=n.shop_id WHERE n.status='FAILED' AND n.created_at>? ORDER BY n.created_at DESC LIMIT 100").bind(now - 7 * 86400000).all().then((r) => r.results),
    db.prepare("SELECT COUNT(*)::int AS n FROM notifications WHERE status IN ('QUEUED','SENDING')").first<{ n: number }>(),
    db.prepare("SELECT type, COUNT(*)::int AS n, MAX(received_at) AS last FROM stripe_events WHERE received_at>? GROUP BY type ORDER BY last DESC LIMIT 30").bind(now - 7 * 86400000).all().then((r) => r.results),
    db.prepare("SELECT COUNT(*)::int AS n, COALESCE(SUM(quantity*unit_pence),0)::int AS pence FROM usage_events WHERE reported_at IS NULL").first<{ n: number; pence: number }>(),
  ]);
  return c.json({ providers: { ...providerStatus(), stripe: stripeStatus() }, failed_messages_7d: failed, queued: queued?.n ?? 0, stripe_events_7d: recentEvents, usage_unreported: unreported });
});

// ---- Admin team ------------------------------------------------------------------------------------
admin.get("/team", async (c) => c.json({ admins: (await c.env.DB.prepare("SELECT a.user_id, a.role, a.created_at, u.name, u.email FROM platform_admins a JOIN app_users u ON u.id=a.user_id ORDER BY a.created_at").all()).results }));
admin.post("/team", async (c) => {
  need(c, ["SUPER"]);
  const b = await body(c, z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(["SUPER", "SUPPORT", "FINANCE"]), reason: reasonSchema }).strict());
  const u = await c.env.DB.prepare("SELECT id FROM app_users WHERE email=?").bind(b.email).first<{ id: string }>();
  if (!u) fail(404, "No OLLO account with that email — they need to sign up first");
  await c.env.DB.prepare("INSERT INTO platform_admins(user_id,role,created_by,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role").bind(u!.id, b.role, c.get("admin").user_id, Date.now()).run();
  await audit(c, null, "ADMIN_UPSERT", {}, b, b.reason);
  return c.json({ ok: true });
});
admin.delete("/team/:userId", async (c) => {
  need(c, ["SUPER"]);
  if (c.req.param("userId") === c.get("admin").user_id) fail(400, "You cannot remove yourself");
  await c.env.DB.prepare("DELETE FROM platform_admins WHERE user_id=?").bind(c.req.param("userId")).run();
  await audit(c, null, "ADMIN_REMOVE", { user_id: c.req.param("userId") }, {}, "removed");
  return c.json({ ok: true });
});

export default admin;
export { resolveAdmin };
