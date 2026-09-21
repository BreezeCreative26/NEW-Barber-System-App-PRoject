// foliyo master admin: oversee every shop, support them, and run billing.
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
import { providerStatus, enqueue, drain, msgShop } from "./messaging";
import { raiseAlert, segmentRecipients, sendBroadcast, snapshotMrr, sweepPlatform, type Segment } from "./lifecycle";
import { payRunStatementHtml, applyDunning, invoiceHtml, invoiceStats, issueCreditNote, issueManualInvoice, issuePeriodInvoice, markPaid, markUncollectible, prevPeriodKey, runPeriodClose, sendInvoice, voidInvoice, type InvoiceRow } from "./invoicing";
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
  const openAlerts = (await db.prepare("SELECT severity, COUNT(*)::int AS n FROM admin_alerts WHERE acked_at IS NULL GROUP BY severity").all<{ severity: string; n: number }>()).results;
  return c.json({
    alerts: Object.fromEntries(openAlerts.map((r) => [r.severity, r.n])),
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
    `SELECT s.id, s.name, s.slug, s.kind, s.timezone, s.created_at, s.online_booking, s.suspended_at,
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
       AND (? = '' OR (?='SUSPENDED' AND s.suspended_at IS NOT NULL) OR ss.status = ?)
     ORDER BY s.created_at DESC LIMIT 500`,
  ).bind(Date.now() - 30 * 86400000, q, `%${q}%`, `%${q}%`, `%${q}%`, status, status, status).all()).results;
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
    case "RESUME": sql = "UPDATE shop_subscriptions SET status='ACTIVE', past_due_since=NULL, cancelled_at=NULL, activated_at=COALESCE(activated_at, ?)"; args = [now]; summary = "Subscription resumed"; break;
    case "CANCEL": sql = "UPDATE shop_subscriptions SET status='CANCELLED', cancel_at=?, cancelled_at=?"; args = [now, now]; summary = "Subscription cancelled"; break;
    case "SET_PLAN": { if (!b.plan_id || !(await db.prepare("SELECT 1 FROM plans WHERE id=? AND active=1").bind(b.plan_id).first())) fail(400, "Unknown plan"); sql = "UPDATE shop_subscriptions SET plan_id=?"; args = [b.plan_id]; summary = `Plan changed to ${b.plan_id}`; break; }
    case "MARK_ACTIVE": sql = "UPDATE shop_subscriptions SET status='ACTIVE', past_due_since=NULL, current_period_start=COALESCE(current_period_start,?), current_period_end=COALESCE(current_period_end,?), activated_at=COALESCE(activated_at,?)"; args = [now, now + 30 * 86400000, now]; summary = "Marked active"; break;
    case "MARK_PAST_DUE": sql = "UPDATE shop_subscriptions SET status='PAST_DUE', past_due_since=COALESCE(past_due_since,?)"; args = [now]; summary = "Marked payment overdue"; break;
    case "CLEAR_PAST_DUE": sql = "UPDATE shop_subscriptions SET status='ACTIVE', past_due_since=NULL"; summary = "Overdue cleared"; break;
  }
  await db.prepare(`${sql}, version=version+1, updated_at=? WHERE shop_id=?`).bind(...args, now, shopId).run();
  const after = await db.prepare("SELECT * FROM shop_subscriptions WHERE shop_id=?").bind(shopId).first();
  await audit(c, shopId, `SUBSCRIPTION_${b.action}`, before, after, b.reason);
  await logBilling(db, shopId, `ADMIN_${b.action}`, `${summary} by foliyo support — ${b.reason}`, `admin:${c.get("admin").user_id}`);
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
    await logBilling(db, shopId, "ADMIN_FEATURE_CLEAR", `foliyo override removed for ${b.key} — ${b.reason}`, `admin:${c.get("admin").user_id}`);
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
  await db.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid(), shopId, "shop", shopId, "SUPPORT_ACCESS", `admin:${c.get("admin").user_id}`, `foliyo support opened the workspace (30 min): ${b.reason}`, now).run();
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
  const b = await body(c, z.object({
    vat_mode: z.enum(["NONE", "UK_20", "STRIPE_TAX"]), vat_number: z.string().trim().max(20), trial_days: z.number().int().min(0).max(90), grace_days: z.number().int().min(0).max(60),
    invoice_prefix: z.string().trim().max(12).optional(), due_days: z.number().int().min(0).max(60).optional(), company_name: z.string().trim().min(1).max(80).optional(), company_address: z.string().trim().max(400).optional(),
    company_email: z.string().trim().max(120).optional(), company_number: z.string().trim().max(40).optional(), bank_details: z.string().trim().max(600).optional(), invoice_footer: z.string().trim().max(300).optional(),
    reason: reasonSchema,
  }).strict());
  const before = await platformBilling(c.env.DB);
  const next = { ...before, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => k !== "reason" && v !== undefined)) };
  await c.env.DB.prepare("UPDATE platform_billing SET vat_mode=?, vat_number=?, trial_days=?, grace_days=?, invoice_prefix=?, due_days=?, company_name=?, company_address=?, company_email=?, company_number=?, bank_details=?, invoice_footer=?, updated_at=? WHERE id=1")
    .bind(next.vat_mode, next.vat_number, next.trial_days, next.grace_days, next.invoice_prefix, next.due_days, next.company_name, next.company_address, next.company_email, next.company_number, next.bank_details, next.invoice_footer, Date.now()).run();
  await audit(c, null, "PLATFORM_BILLING", before, b, b.reason);
  return c.json({ ok: true });
});

// ---- Invoices across shops -----------------------------------------------------------------------
const actor = (c: Ctx) => `admin:${c.get("admin").user_id}`;
const linesSchema = z.array(z.object({ label: z.string().trim().min(1).max(160), detail: z.string().trim().max(200).optional(), amount_pence: z.number().int().min(-1000000).max(1000000) })).min(1).max(30);
admin.get("/invoices", async (c) => {
  const status = c.req.query("status") || "";
  const q = (c.req.query("q") || "").trim().toLowerCase();
  const rows = (await c.env.DB.prepare(
    "SELECT i.*, s.name AS shop_name FROM invoices i JOIN shops s ON s.id=i.shop_id WHERE (?='' OR (?='OVERDUE' AND i.status='OPEN' AND i.due_at<?) OR i.status=?) AND (?='' OR LOWER(i.number) LIKE ? OR LOWER(s.name) LIKE ?) ORDER BY i.created_at DESC LIMIT 500",
  ).bind(status, status, Date.now(), status, q, `%${q}%`, `%${q}%`).all()).results;
  const adjustments = (await c.env.DB.prepare("SELECT a.*, s.name AS shop_name FROM invoice_adjustments a JOIN shops s ON s.id=a.shop_id WHERE a.invoice_id IS NULL ORDER BY a.created_at DESC LIMIT 200").all()).results;
  return c.json({ invoices: rows, pending_adjustments: adjustments, stats: await invoiceStats(c.env.DB) });
});
admin.get("/invoices/:id", async (c) => {
  const inv = await c.env.DB.prepare("SELECT i.*, s.name AS shop_name FROM invoices i JOIN shops s ON s.id=i.shop_id WHERE i.id=?").bind(c.req.param("id")).first<InvoiceRow & { shop_name: string }>();
  if (!inv) fail(404, "Invoice not found");
  const credit_notes = (await c.env.DB.prepare("SELECT * FROM invoices WHERE credit_note_for=? ORDER BY created_at").bind(inv!.id).all()).results;
  const adjustments = (await c.env.DB.prepare("SELECT * FROM invoice_adjustments WHERE invoice_id=? ORDER BY created_at").bind(inv!.id).all()).results;
  const events = (await c.env.DB.prepare("SELECT * FROM billing_events WHERE shop_id=? AND payload_json LIKE ? ORDER BY created_at DESC").bind(inv!.shop_id, `%${inv!.id}%`).all()).results;
  return c.json({ invoice: inv, credit_notes, adjustments, events, view_url: `/invoice/${inv!.id}?t=${inv!.view_token}` });
});
admin.get("/invoices/:id/html", async (c) => {
  const inv = await c.env.DB.prepare("SELECT * FROM invoices WHERE id=?").bind(c.req.param("id")).first<InvoiceRow>();
  if (!inv) fail(404, "Invoice not found");
  return c.html(await invoiceHtml(c.env.DB, inv!));
});
// Month close: issue every shop's invoice for a period (default: last month). Idempotent.
admin.post("/invoices/run", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const b = await body(c, z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional(), reason: reasonSchema }).strict());
  const period = b.period ?? prevPeriodKey();
  if (period >= new Date().toISOString().slice(0, 7)) fail(400, "That period has not finished yet");
  const result = await runPeriodClose(c.env.DB, period, actor(c));
  const dunning = await applyDunning(c.env.DB);
  await audit(c, null, "PERIOD_CLOSE", {}, { period, issued: result.issued.length, skipped: result.skipped.length, errors: result.errors.length, dunning }, b.reason);
  return c.json({ ...result, dunning });
});
admin.post("/invoices/dunning", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const r = await applyDunning(c.env.DB);
  await audit(c, null, "DUNNING_RUN", {}, r, "manual run");
  return c.json(r);
});
// Manual invoice for one shop, or close a single shop's period now.
admin.post("/shops/:id/invoices", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const shopId = c.req.param("id");
  const b = await body(c, z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("MANUAL"), lines: linesSchema, note: z.string().trim().max(300).optional(), due_days: z.number().int().min(0).max(60).optional(), send: z.boolean().optional(), reason: reasonSchema }).strict(),
    z.object({ kind: z.literal("PERIOD"), period: z.string().regex(/^\d{4}-\d{2}$/), force: z.boolean().optional(), send: z.boolean().optional(), reason: reasonSchema }).strict(),
  ]));
  let inv: InvoiceRow;
  if (b.kind === "MANUAL") {
    if (b.lines.reduce((n, l) => n + l.amount_pence, 0) <= 0) fail(400, "Invoice total must be above zero — use a credit note for refunds");
    inv = await issueManualInvoice(c.env.DB, shopId, b.lines, actor(c), b.note ?? "", b.due_days);
  } else {
    const r = await issuePeriodInvoice(c.env.DB, shopId, b.period, actor(c), { force: !!b.force });
    if (!("invoice" in r)) fail(409, `Nothing issued: ${r.skipped}`);
    if ("skipped" in r && r.skipped) fail(409, `Invoice for ${b.period} already issued (${(r as { invoice: InvoiceRow }).invoice.number})`);
    inv = (r as { invoice: InvoiceRow }).invoice;
  }
  await audit(c, shopId, "INVOICE_ISSUED", {}, { invoice_id: inv.id, number: inv.number, total_pence: inv.total_pence }, b.reason);
  let sent: { to: string } | null = null;
  if (b.send && inv.status === "OPEN") sent = await sendInvoice(c.env.DB, inv, "", actor(c), new URL(c.req.url).origin).catch(() => null);
  return c.json({ invoice: inv, sent }, 201);
});
admin.post("/invoices/:id/pay", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const b = await body(c, z.object({ amount_pence: z.number().int().min(1).nullable().optional(), via: z.enum(["bank_transfer", "card", "cash", "stripe", "other"]), ref: z.string().trim().max(80).optional(), reason: reasonSchema }).strict());
  try {
    const inv = await markPaid(c.env.DB, c.req.param("id"), b.amount_pence ?? null, b.via, b.ref ?? "", actor(c));
    await audit(c, inv.shop_id, "INVOICE_PAID", {}, { invoice_id: inv.id, paid_pence: inv.paid_pence, via: b.via, ref: b.ref }, b.reason);
    if (inv.status === "PAID") await sendInvoice(c.env.DB, inv, "", actor(c), new URL(c.req.url).origin).catch(() => {});
    return c.json({ invoice: inv });
  } catch (e) { return fail(409, (e as Error).message); }
});
admin.post("/invoices/:id/void", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const b = await body(c, z.object({ reason: reasonSchema }).strict());
  try { const inv = await voidInvoice(c.env.DB, c.req.param("id"), b.reason, actor(c)); await audit(c, inv.shop_id, "INVOICE_VOID", {}, { invoice_id: inv.id }, b.reason); return c.json({ invoice: inv }); }
  catch (e) { return fail(409, (e as Error).message); }
});
admin.post("/invoices/:id/write-off", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const b = await body(c, z.object({ reason: reasonSchema }).strict());
  try { const inv = await markUncollectible(c.env.DB, c.req.param("id"), b.reason, actor(c)); await audit(c, inv.shop_id, "INVOICE_WRITTEN_OFF", {}, { invoice_id: inv.id }, b.reason); return c.json({ invoice: inv }); }
  catch (e) { return fail(409, (e as Error).message); }
});
admin.post("/invoices/:id/credit-note", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const b = await body(c, z.object({ amount_pence: z.number().int().min(1).max(1000000), refund: z.object({ via: z.enum(["bank_transfer", "card", "stripe", "other"]), ref: z.string().trim().max(80) }).optional(), send: z.boolean().optional(), reason: reasonSchema }).strict());
  try {
    const cn = await issueCreditNote(c.env.DB, c.req.param("id"), b.amount_pence, b.reason, actor(c), b.refund);
    await audit(c, cn.shop_id, "CREDIT_NOTE", {}, { credit_note_id: cn.id, number: cn.number, amount_pence: b.amount_pence, refund: b.refund ?? null }, b.reason);
    if (b.send) await sendInvoice(c.env.DB, cn, "", actor(c), new URL(c.req.url).origin).catch(() => {});
    return c.json({ credit_note: cn }, 201);
  } catch (e) { return fail(409, (e as Error).message); }
});
admin.post("/invoices/:id/send", async (c) => {
  const b = await body(c, z.object({ to: z.string().trim().email().optional() }).strict());
  const inv = await c.env.DB.prepare("SELECT * FROM invoices WHERE id=?").bind(c.req.param("id")).first<InvoiceRow>();
  if (!inv) fail(404, "Invoice not found");
  if (inv!.status === "VOID") fail(409, "Void invoices are not sent");
  try { const r = await sendInvoice(c.env.DB, inv!, b.to ?? "", actor(c), new URL(c.req.url).origin); await audit(c, inv!.shop_id, "INVOICE_SENT", {}, { invoice_id: inv!.id, to: r.to }, ""); return c.json(r); }
  catch (e) { return fail(409, (e as Error).message); }
});
admin.put("/invoices/:id/lines", async (c) => {
  // Amend an OPEN, unpaid invoice's lines (typo, wrong quantity). Paid invoices need a credit note.
  need(c, ["SUPER", "FINANCE"]);
  const b = await body(c, z.object({ lines: linesSchema, note: z.string().trim().max(300).optional(), due_at: z.number().int().nullable().optional(), reason: reasonSchema }).strict());
  const inv = await c.env.DB.prepare("SELECT * FROM invoices WHERE id=?").bind(c.req.param("id")).first<InvoiceRow>();
  if (!inv) fail(404, "Invoice not found");
  if (inv!.status !== "OPEN" || inv!.paid_pence > 0 || inv!.kind === "CREDIT_NOTE") fail(409, "Only open, unpaid invoices can be amended — issue a credit note instead");
  const subtotal = b.lines.reduce((n, l) => n + l.amount_pence, 0);
  const pb = await platformBilling(c.env.DB);
  const discount = Math.min(inv!.discount_pence, subtotal);
  const tax = pb.vat_mode === "UK_20" ? Math.round((subtotal - discount) * 0.2) : 0;
  const total = Math.max(0, subtotal - discount + tax - inv!.credit_applied_pence);
  await c.env.DB.prepare("UPDATE invoices SET lines_json=?, subtotal_pence=?, discount_pence=?, tax_pence=?, total_pence=?, note=COALESCE(?, note), due_at=COALESCE(?, due_at), status=CASE WHEN ?=0 THEN 'PAID' ELSE status END, paid_at=CASE WHEN ?=0 THEN ? ELSE paid_at END, updated_at=? WHERE id=?")
    .bind(JSON.stringify(b.lines), subtotal, discount, tax, total, b.note ?? null, b.due_at ?? null, total, total, Date.now(), Date.now(), inv!.id).run();
  await audit(c, inv!.shop_id, "INVOICE_AMENDED", { lines: inv!.lines_json, total_pence: inv!.total_pence }, { lines: b.lines, total_pence: total }, b.reason);
  await logBilling(c.env.DB, inv!.shop_id, "INVOICE_AMENDED", `${inv!.number} amended · now £${(total / 100).toFixed(2)} — ${b.reason}`, actor(c), { invoice_id: inv!.id });
  return c.json({ invoice: await c.env.DB.prepare("SELECT * FROM invoices WHERE id=?").bind(inv!.id).first() });
});

// ---- Shop lifecycle ------------------------------------------------------------------------------
admin.post("/shops/:id/suspend", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const shopId = c.req.param("id");
  const b = await body(c, z.object({ suspend: z.boolean(), reason: reasonSchema }).strict());
  const now = Date.now();
  await c.env.DB.prepare("UPDATE shops SET suspended_at=?, suspended_reason=?, version=version+1 WHERE id=?").bind(b.suspend ? now : null, b.suspend ? b.reason : "", shopId).run();
  if (b.suspend) await c.env.DB.prepare("DELETE FROM app_sessions WHERE membership_id IN (SELECT id FROM app_memberships WHERE shop_id=?)").bind(shopId).run();
  await audit(c, shopId, b.suspend ? "SHOP_SUSPENDED" : "SHOP_UNSUSPENDED", {}, {}, b.reason);
  await logBilling(c.env.DB, shopId, b.suspend ? "SUSPENDED" : "UNSUSPENDED", b.suspend ? `Account suspended by foliyo — ${b.reason}` : `Suspension lifted — ${b.reason}`, actor(c));
  await c.env.DB.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid(), shopId, "shop", shopId, b.suspend ? "SUSPENDED" : "UNSUSPENDED", actor(c), b.reason, now).run();
  return c.json({ ok: true });
});
// Edit the shop's account-level details (owner contact, slug) without impersonating.
admin.put("/shops/:id/account", async (c) => {
  need(c, ["SUPER", "SUPPORT"]);
  const shopId = c.req.param("id");
  const b = await body(c, z.object({ owner_email: z.string().trim().email().max(120).optional(), owner_name: z.string().trim().min(1).max(80).optional(), slug: z.string().trim().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/, "Lowercase letters, numbers and hyphens").optional(), name: z.string().trim().min(1).max(80).optional(), reason: reasonSchema }).strict());
  const db = c.env.DB;
  const before = await db.prepare("SELECT s.name, s.slug, u.id AS owner_id, u.email AS owner_email, u.name AS owner_name FROM shops s LEFT JOIN shop_owners so ON so.shop_id=s.id LEFT JOIN app_users u ON u.id=so.user_id WHERE s.id=?").bind(shopId).first<{ name: string; slug: string; owner_id: string | null; owner_email: string; owner_name: string }>();
  if (!before) fail(404, "Shop not found");
  if (b.slug && b.slug !== before!.slug && (await db.prepare("SELECT 1 FROM shops WHERE slug=? AND id<>?").bind(b.slug, shopId).first())) fail(409, "That web address is taken");
  if (b.owner_email && before!.owner_id && b.owner_email.toLowerCase() !== before!.owner_email.toLowerCase() && (await db.prepare("SELECT 1 FROM app_users WHERE email=? AND id<>?").bind(b.owner_email, before!.owner_id).first())) fail(409, "Another account already uses that email");
  if (b.name || b.slug) await db.prepare("UPDATE shops SET name=COALESCE(?, name), slug=COALESCE(?, slug), version=version+1 WHERE id=?").bind(b.name ?? null, b.slug ?? null, shopId).run();
  if ((b.owner_email || b.owner_name) && before!.owner_id) await db.prepare("UPDATE app_users SET email=COALESCE(?, email), name=COALESCE(?, name) WHERE id=?").bind(b.owner_email ?? null, b.owner_name ?? null, before!.owner_id).run();
  await audit(c, shopId, "SHOP_ACCOUNT_EDITED", before, b, b.reason);
  await db.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid(), shopId, "shop", shopId, "ACCOUNT_EDITED_BY_SUPPORT", actor(c), b.reason, Date.now()).run();
  return c.json({ ok: true });
});
// Transfer ownership to another existing member (e.g. shop sold, owner left).
admin.post("/shops/:id/owner", async (c) => {
  need(c, ["SUPER"]);
  const shopId = c.req.param("id");
  const b = await body(c, z.object({ membership_id: z.string().min(1), reason: reasonSchema }).strict());
  const db = c.env.DB;
  const target = await db.prepare("SELECT m.id, m.user_id, m.role, m.staff_id FROM app_memberships m WHERE m.id=? AND m.shop_id=? AND m.active=1").bind(b.membership_id, shopId).first<{ id: string; user_id: string; role: string; staff_id: string | null }>();
  if (!target) fail(404, "That member is not on this shop");
  if (target!.role === "OWNER") fail(409, "Already the owner");
  const current = await db.prepare("SELECT m.id, m.user_id FROM app_memberships m WHERE m.shop_id=? AND m.role='OWNER' AND m.active=1").bind(shopId).first<{ id: string; user_id: string }>();
  // Owner memberships carry no staff_id; the old owner becomes a manager linked to no chair (kept inactive).
  await db.batch([
    ...(current ? [db.prepare("UPDATE app_memberships SET active=0, version=version+1 WHERE id=?").bind(current.id), db.prepare("DELETE FROM app_sessions WHERE membership_id=?").bind(current.id)] : []),
    db.prepare("UPDATE app_memberships SET role='OWNER', staff_id=NULL, version=version+1 WHERE id=?").bind(target!.id),
    db.prepare("DELETE FROM app_sessions WHERE membership_id=?").bind(target!.id),
    db.prepare("INSERT INTO shop_owners(shop_id,user_id) VALUES(?,?) ON CONFLICT(shop_id) DO UPDATE SET user_id=EXCLUDED.user_id").bind(shopId, target!.user_id),
    db.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid(), shopId, "shop", shopId, "OWNER_TRANSFERRED", actor(c), b.reason, Date.now()),
  ]);
  await audit(c, shopId, "OWNER_TRANSFERRED", { from: current?.user_id ?? null }, { to: target!.user_id }, b.reason);
  return c.json({ ok: true });
});
// One-time sign-in link for a locked-out owner (15 min, single use). Emailed to the owner's address.
admin.post("/shops/:id/signin-link", async (c) => {
  need(c, ["SUPER", "SUPPORT"]);
  const shopId = c.req.param("id");
  const b = await body(c, z.object({ reason: reasonSchema, reveal: z.boolean().optional() }).strict());
  const db = c.env.DB;
  const m = await db.prepare("SELECT m.id, u.name, u.email FROM app_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.shop_id=? AND m.role='OWNER' AND m.active=1 LIMIT 1").bind(shopId).first<{ id: string; name: string; email: string }>();
  if (!m) fail(404, "This shop has no active owner account");
  const raw = uid().replace(/-/g, "") + uid().replace(/-/g, "");
  const now = Date.now();
  await db.prepare("INSERT INTO owner_links(token_hash,membership_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?)").bind(await digest(raw), m!.id, actor(c), now, now + 15 * 60000).run();
  const origin = new URL(c.req.url).origin;
  const link = `${origin}/api/admin-public/signin?token=${raw}`;
  const shop = await msgShop(c, shopId);
  const pb = await platformBilling(db);
  const stmts = enqueue(db, { ...shop, name: pb.company_name || "foliyo" }, { email: m!.email, name: m!.name }, "owner_signin_link", { link, shop: shop.name }, { related: { type: "owner_link", id: m!.id + ":" + now }, origin, channel: "EMAIL", now, force: true });
  if (stmts.length) { await db.batch(stmts); await drain(db, stmts.length, now, { type: "owner_link", id: m!.id + ":" + now }).catch(() => {}); }
  await audit(c, shopId, "SIGNIN_LINK_SENT", {}, { to: m!.email, revealed: !!b.reveal }, b.reason);
  await db.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid(), shopId, "shop", shopId, "SIGNIN_LINK_SENT", actor(c), `foliyo support sent a one-time sign-in link to ${m!.email}: ${b.reason}`, now).run();
  const delivered = providerStatus().email.provider !== "mailbox";
  // In preview (no email provider) or when explicitly asked, hand the link to the admin to pass on.
  return c.json({ ok: true, to: m!.email, delivered, link: b.reveal || !delivered ? link : undefined, expires_at: now + 15 * 60000 });
});
// Sign out every session on the shop (lost phone, leaver).
admin.post("/shops/:id/signout-all", async (c) => {
  need(c, ["SUPER", "SUPPORT"]);
  const shopId = c.req.param("id");
  const b = await body(c, z.object({ reason: reasonSchema }).strict());
  const r = await c.env.DB.prepare("DELETE FROM app_sessions WHERE membership_id IN (SELECT id FROM app_memberships WHERE shop_id=?)").bind(shopId).run();
  await audit(c, shopId, "SIGNOUT_ALL", {}, { sessions: r.meta?.changes ?? 0 }, b.reason);
  return c.json({ sessions: r.meta?.changes ?? 0 });
});

// ---- Alerts ---------------------------------------------------------------------------------------
admin.get("/alerts", async (c) => {
  const all = c.req.query("all") === "1";
  const rows = (await c.env.DB.prepare(`SELECT a.*, s.name AS shop_name FROM admin_alerts a LEFT JOIN shops s ON s.id=a.shop_id WHERE ${all ? "1=1" : "a.acked_at IS NULL"} ORDER BY CASE a.severity WHEN 'CRIT' THEN 0 WHEN 'WARN' THEN 1 ELSE 2 END, a.created_at DESC LIMIT 300`).all()).results;
  return c.json({ alerts: rows, alert_email: process.env.OLLO_ALERT_EMAIL || "" });
});
admin.post("/alerts/:id/ack", async (c) => {
  await c.env.DB.prepare("UPDATE admin_alerts SET acked_at=?, acked_by=? WHERE id=? AND acked_at IS NULL").bind(Date.now(), c.get("admin").user_id, c.req.param("id")).run();
  return c.json({ ok: true });
});
admin.post("/alerts/ack-all", async (c) => {
  const r = await c.env.DB.prepare("UPDATE admin_alerts SET acked_at=?, acked_by=? WHERE acked_at IS NULL").bind(Date.now(), c.get("admin").user_id).run();
  return c.json({ acked: r.meta?.changes ?? 0 });
});
// Run the platform sweep now (lifecycle emails, alert detection, MRR snapshot).
admin.post("/sweep", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const r = await sweepPlatform(c.env.DB, new URL(c.req.url).origin);
  return c.json(r);
});

// ---- Trend (MRR, shops, conversion, churn) -----------------------------------------------------------
admin.get("/trend", async (c) => {
  const days = Math.min(365, Math.max(7, Number(c.req.query("days") || 90)));
  await snapshotMrr(c.env.DB).catch(() => null);
  const rows = (await c.env.DB.prepare("SELECT * FROM mrr_snapshots WHERE day >= ? ORDER BY day").bind(new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)).all()).results;
  const since = Date.now() - 30 * 86400000;
  const [signups, converted, churned, trialsStarted30] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*)::int AS n FROM shops WHERE created_at>?").bind(since).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*)::int AS n FROM shop_subscriptions WHERE activated_at>?").bind(since).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*)::int AS n FROM shop_subscriptions WHERE cancelled_at>?").bind(since).first<{ n: number }>(),
    // Trials that reached their end date in the last 30 days (converted or not).
    c.env.DB.prepare("SELECT COUNT(*)::int AS n FROM shop_subscriptions WHERE (trial_ends_at BETWEEN ? AND ?) OR (activated_at BETWEEN ? AND ?)").bind(since, Date.now(), since, Date.now()).first<{ n: number }>(),
  ]);
  const active = (await c.env.DB.prepare("SELECT COUNT(*)::int AS n FROM shop_subscriptions WHERE status IN ('ACTIVE','PAST_DUE')").first<{ n: number }>())?.n ?? 0;
  return c.json({ snapshots: rows, last_30d: { signups: signups?.n ?? 0, converted: converted?.n ?? 0, churned: churned?.n ?? 0, trials_finished: trialsStarted30?.n ?? 0, conversion_pct: trialsStarted30?.n ? Math.round(((converted?.n ?? 0) * 100) / trialsStarted30.n) : null, churn_pct: active ? Math.round(((churned?.n ?? 0) * 1000) / (active + (churned?.n ?? 0))) / 10 : null } });
});

// ---- CSV exports ---------------------------------------------------------------------------------------
const csv = (rows: Record<string, unknown>[], cols: string[]) => [cols.join(","), ...rows.map((r) => cols.map((k) => { const v = r[k]; const s = v == null ? "" : typeof v === "number" && /pence$/.test(k) ? (v / 100).toFixed(2) : /_at$/.test(k) && typeof v === "number" ? new Date(v).toISOString() : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(","))].join("\n");
const download = (c: Ctx, name: string, body: string) => { c.header("Content-Type", "text/csv; charset=utf-8"); c.header("Content-Disposition", `attachment; filename="${name}"`); return c.body(body); };
admin.get("/export/shops.csv", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const rows = (await c.env.DB.prepare("SELECT s.id, s.name, s.slug, s.created_at, s.suspended_at, ss.status, ss.plan_id, ss.seats, ss.trial_ends_at, ss.activated_at, ss.cancelled_at, ss.billing_email, u.email AS owner_email, u.name AS owner_name, (SELECT COUNT(*)::int FROM staff st WHERE st.shop_id=s.id AND st.active=1) AS active_staff FROM shops s LEFT JOIN shop_subscriptions ss ON ss.shop_id=s.id LEFT JOIN shop_owners so ON so.shop_id=s.id LEFT JOIN app_users u ON u.id=so.user_id ORDER BY s.created_at").all<Record<string, unknown>>()).results;
  await audit(c, null, "EXPORT_SHOPS", {}, { rows: rows.length }, "");
  return download(c, `ollo-shops-${new Date().toISOString().slice(0, 10)}.csv`, csv(rows, ["id", "name", "slug", "owner_name", "owner_email", "billing_email", "status", "plan_id", "seats", "active_staff", "created_at", "trial_ends_at", "activated_at", "cancelled_at", "suspended_at"]));
});
admin.get("/export/invoices.csv", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const from = c.req.query("from") || "1970-01-01", to = c.req.query("to") || "2999-12-31";
  const rows = (await c.env.DB.prepare("SELECT i.number, i.kind, i.status, s.name AS shop, i.period_key, i.issued_at, i.due_at, i.paid_at, i.paid_via, i.paid_ref, i.subtotal_pence, i.discount_pence, i.tax_pence, i.credit_applied_pence, i.total_pence, i.paid_pence, i.void_reason FROM invoices i JOIN shops s ON s.id=i.shop_id WHERE COALESCE(i.issued_at, i.created_at) BETWEEN ? AND ? ORDER BY i.issued_at").bind(Date.parse(from), Date.parse(to) + 86400000).all<Record<string, unknown>>()).results;
  await audit(c, null, "EXPORT_INVOICES", {}, { rows: rows.length, from, to }, "");
  return download(c, `ollo-invoices-${from}-to-${to}.csv`, csv(rows, ["number", "kind", "status", "shop", "period_key", "issued_at", "due_at", "paid_at", "paid_via", "paid_ref", "subtotal_pence", "discount_pence", "tax_pence", "credit_applied_pence", "total_pence", "paid_pence", "void_reason"]));
});
admin.get("/export/usage.csv", async (c) => {
  need(c, ["SUPER", "FINANCE"]);
  const period = c.req.query("period") || new Date().toISOString().slice(0, 7);
  const rows = (await c.env.DB.prepare("SELECT s.name AS shop, u.feature_key, SUM(u.quantity)::int AS quantity, MAX(u.unit_pence) AS unit_pence, (SUM(u.quantity)*MAX(u.unit_pence))::int AS gross_pence FROM usage_events u JOIN shops s ON s.id=u.shop_id WHERE u.period_key=? GROUP BY s.name, u.feature_key ORDER BY s.name, u.feature_key").bind(period).all<Record<string, unknown>>()).results;
  return download(c, `ollo-usage-${period}.csv`, csv(rows, ["shop", "feature_key", "quantity", "unit_pence", "gross_pence"]));
});

// ---- Broadcasts ------------------------------------------------------------------------------------
const segmentSchema = z.object({ status: z.array(z.enum(["TRIAL", "ACTIVE", "PAST_DUE", "PAUSED", "CANCELLED"])).optional(), trial_ending_days: z.number().int().min(1).max(60).optional(), feature: z.string().optional(), shop_ids: z.array(z.string()).max(500).optional(), joined_after: z.number().int().optional(), joined_before: z.number().int().optional() }).strict();
admin.get("/broadcasts", async (c) => c.json({ broadcasts: (await c.env.DB.prepare("SELECT b.*, u.name AS author FROM broadcasts b LEFT JOIN app_users u ON u.id=b.created_by ORDER BY b.created_at DESC LIMIT 100").all()).results }));
admin.post("/broadcasts/preview", async (c) => {
  const seg = await body(c, segmentSchema);
  const rec = await segmentRecipients(c.env.DB, seg as Segment);
  return c.json({ count: rec.length, sample: rec.slice(0, 8) });
});
admin.post("/broadcasts", async (c) => {
  need(c, ["SUPER", "SUPPORT"]);
  const b = await body(c, z.object({ subject: z.string().trim().min(3).max(120), heading: z.string().trim().max(120).optional(), body: z.string().trim().min(10).max(5000), cta_label: z.string().trim().max(40).optional(), cta_url: z.string().trim().url().max(300).or(z.literal("")).optional(), segment: segmentSchema }).strict());
  const id = uid();
  await c.env.DB.prepare("INSERT INTO broadcasts(id,subject,heading,body,cta_label,cta_url,segment_json,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,'DRAFT',?,?)").bind(id, b.subject, b.heading ?? "", b.body, b.cta_label ?? "", b.cta_url ?? "", JSON.stringify(b.segment), c.get("admin").user_id, Date.now()).run();
  await audit(c, null, "BROADCAST_DRAFTED", {}, { id, subject: b.subject }, "");
  return c.json({ id }, 201);
});
admin.post("/broadcasts/:id/test", async (c) => {
  const b = await body(c, z.object({ to: z.string().trim().email() }).strict());
  try { return c.json(await sendBroadcast(c.env.DB, c.req.param("id"), new URL(c.req.url).origin, { testTo: b.to })); } catch (e) { return fail(409, (e as Error).message); }
});
admin.post("/broadcasts/:id/send", async (c) => {
  need(c, ["SUPER"]);
  const b = await body(c, z.object({ reason: reasonSchema }).strict());
  try {
    const r = await sendBroadcast(c.env.DB, c.req.param("id"), new URL(c.req.url).origin);
    await audit(c, null, "BROADCAST_SENT", {}, { id: c.req.param("id"), ...r }, b.reason);
    return c.json(r);
  } catch (e) { return fail(409, (e as Error).message); }
});
admin.post("/broadcasts/:id/cancel", async (c) => {
  await c.env.DB.prepare("UPDATE broadcasts SET status='CANCELLED' WHERE id=? AND status='DRAFT'").bind(c.req.param("id")).run();
  return c.json({ ok: true });
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
  if (!u) fail(404, "No foliyo account with that email — they need to sign up first");
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

// ---- Public (no admin cookie): printable invoices by token, owner one-time sign-in ------------------
export const adminPublic = new Hono<AppEnv>();
adminPublic.get("/invoice/:id", async (c) => {
  const t = c.req.query("t") || "";
  const inv = await c.env.DB.prepare("SELECT * FROM invoices WHERE id=? AND view_token<>'' AND view_token=?").bind(c.req.param("id"), t).first<InvoiceRow>();
  if (!inv) return c.html("<!doctype html><meta charset=utf-8><title>Not found</title><p style='font:15px system-ui;padding:40px'>This invoice link is not valid.</p>", 404);
  c.header("Cache-Control", "private, no-store");
  c.header("X-Robots-Tag", "noindex");
  return c.html(await invoiceHtml(c.env.DB, inv));
});
adminPublic.get("/pay-run/:id", async (c) => {
  const html = await payRunStatementHtml(c.env.DB, c.req.param("id"), c.req.query("t") || "");
  if (!html) return c.html("<!doctype html><meta charset=utf-8><title>Not found</title><p style='font:15px system-ui;padding:40px'>This statement link is not valid.</p>", 404);
  c.header("Cache-Control", "private, no-store"); c.header("X-Robots-Tag", "noindex");
  return c.html(html);
});
adminPublic.get("/signin", async (c) => {
  const raw = c.req.query("token") || "";
  if (raw.length < 40) return c.redirect("/workspace?link=invalid");
  const db = c.env.DB;
  const now = Date.now();
  const row = await db.prepare("SELECT l.token_hash, l.membership_id, l.expires_at, l.used_at, m.shop_id FROM owner_links l JOIN app_memberships m ON m.id=l.membership_id WHERE l.token_hash=? AND m.active=1").bind(await digest(raw)).first<{ token_hash: string; membership_id: string; expires_at: number; used_at: number | null; shop_id: string }>();
  if (!row || row.used_at || row.expires_at < now) return c.redirect("/workspace?link=expired");
  const session = uid() + uid();
  await db.batch([
    db.prepare("UPDATE owner_links SET used_at=? WHERE token_hash=?").bind(now, row.token_hash),
    db.prepare("INSERT INTO app_sessions(token_hash,membership_id,created_at,expires_at) VALUES(?,?,?,?)").bind(await digest(session), row.membership_id, now, now + 7 * 86400000),
    db.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid(), row.shop_id, "shop", row.shop_id, "SIGNIN_LINK_USED", "owner", "Signed in with a one-time link from foliyo support", now),
  ]);
  setCookie(c, ACCOUNT_COOKIE, session, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 7 * 86400 });
  return c.redirect("/workspace#settings/account");
});
