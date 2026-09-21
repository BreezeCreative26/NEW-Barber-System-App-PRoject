// OLLO ↔ shop billing: entitlements, subscription state, metered usage, invoices.
//
// Stripe Billing is the ledger once STRIPE_SECRET_KEY has Billing enabled; until then everything
// here still works from local tables (trial, seats, usage, entitlements) and the Stripe-facing
// calls are no-ops that record what *would* have been sent. No VAT (platform_billing.vat_mode).
import type { Database as DB } from "../db/client";

export type PlanRow = { id: string; name: string; monthly_pence: number; included_seats: number; seat_pence: number; stripe_price_id: string; stripe_seat_price_id: string; active: number; sort: number };
export type FeatureRow = { key: string; name: string; description: string; kind: "ADDON" | "FLAG"; monthly_pence: number; unit: string; unit_pence: number; included_units: number; in_plan: number; stripe_price_id: string; stripe_metered_price_id: string; active: number; sort: number };
export type SubscriptionRow = {
  shop_id: string; plan_id: string; status: "TRIAL" | "ACTIVE" | "PAST_DUE" | "PAUSED" | "CANCELLED";
  stripe_customer_id: string; stripe_subscription_id: string; seats: number; trial_ends_at: number | null;
  current_period_start: number | null; current_period_end: number | null; past_due_since: number | null; cancel_at: number | null;
  billing_email: string; billing_name: string; address_json: string; version: number; created_at: number; updated_at: number;
};
export type ShopFeatureRow = { shop_id: string; feature_key: string; enabled: number; source: "PLAN" | "ADDON" | "ADMIN_GRANT" | "ADMIN_BLOCK"; stripe_item_id: string; stripe_metered_item_id: string; granted_by: string; note: string; starts_at: number; ends_at: number | null; updated_at: number };
export type PlatformBilling = { vat_mode: "NONE" | "UK_20" | "STRIPE_TAX"; vat_number: string; trial_days: number; grace_days: number; vat_threshold_pence: number };

export type Entitlements = {
  plan: PlanRow;
  subscription: SubscriptionRow;
  seats: { used: number; included: number; billable: number };
  features: Record<string, { enabled: boolean; source: ShopFeatureRow["source"] | "PLAN_DEFAULT" | "OFF"; note: string; ends_at: number | null }>;
  readOnly: boolean;
  reasons: string[];
  trial_days_left: number | null;
};

const uid = () => crypto.randomUUID();
const DAY = 86400000;
export const periodKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 7);

export async function platformBilling(db: DB): Promise<PlatformBilling> {
  const row = await db.prepare("SELECT vat_mode, vat_number, trial_days, grace_days, vat_threshold_pence FROM platform_billing WHERE id=1").first<PlatformBilling>();
  return row ?? { vat_mode: "NONE", vat_number: "", trial_days: 14, grace_days: 7, vat_threshold_pence: 9000000 };
}
export async function plans(db: DB) { return (await db.prepare("SELECT * FROM plans ORDER BY sort, name").all<PlanRow>()).results; }
export async function features(db: DB) { return (await db.prepare("SELECT * FROM features WHERE active=1 ORDER BY sort").all<FeatureRow>()).results; }

// Ensure a subscription row exists (trial from now) — called lazily so new shops need no extra step.
export async function subscriptionFor(db: DB, shopId: string): Promise<SubscriptionRow> {
  const existing = await db.prepare("SELECT * FROM shop_subscriptions WHERE shop_id=?").bind(shopId).first<SubscriptionRow>();
  if (existing) return existing;
  const pb = await platformBilling(db);
  const seats = (await db.prepare("SELECT COUNT(*)::int AS n FROM staff WHERE shop_id=? AND active=1").bind(shopId).first<{ n: number }>())?.n || 1;
  const now = Date.now();
  await db.prepare("INSERT INTO shop_subscriptions(shop_id,plan_id,status,seats,trial_ends_at,created_at,updated_at) VALUES(?,?,'TRIAL',?,?,?,?) ON CONFLICT(shop_id) DO NOTHING")
    .bind(shopId, "core", Math.max(1, seats), now + pb.trial_days * DAY, now, now).run();
  await logBilling(db, shopId, "TRIAL_STARTED", `${pb.trial_days}-day trial started · ${Math.max(1, seats)} seat${seats === 1 ? "" : "s"}`, "system");
  return (await db.prepare("SELECT * FROM shop_subscriptions WHERE shop_id=?").bind(shopId).first<SubscriptionRow>())!;
}

export async function logBilling(db: DB, shopId: string, type: string, summary: string, actor: string, payload: unknown = {}) {
  await db.prepare("INSERT INTO billing_events(id,shop_id,type,summary,payload_json,actor,created_at) VALUES(?,?,?,?,?,?,?)")
    .bind(uid(), shopId, type, summary, JSON.stringify(payload), actor, Date.now()).run();
}

// The single source of truth the app enforces. Merge order: plan defaults → ADDON → ADMIN_GRANT → ADMIN_BLOCK.
export async function entitlements(db: DB, shopId: string): Promise<Entitlements> {
  const [sub, pb, fs, rows, seatCount] = await Promise.all([
    subscriptionFor(db, shopId),
    platformBilling(db),
    features(db),
    db.prepare("SELECT * FROM shop_features WHERE shop_id=?").bind(shopId).all<ShopFeatureRow>().then((r) => r.results),
    db.prepare("SELECT COUNT(*)::int AS n FROM staff WHERE shop_id=? AND active=1").bind(shopId).first<{ n: number }>().then((r) => r?.n || 0),
  ]);
  const plan = (await db.prepare("SELECT * FROM plans WHERE id=?").bind(sub.plan_id).first<PlanRow>()) ?? { id: "core", name: "OLLO", monthly_pence: 2499, included_seats: 1, seat_pence: 799, stripe_price_id: "", stripe_seat_price_id: "", active: 1, sort: 0 };
  const now = Date.now();
  const out: Entitlements["features"] = {};
  for (const f of fs) {
    let enabled = !!f.in_plan;
    let source: Entitlements["features"][string]["source"] = f.in_plan ? "PLAN_DEFAULT" : "OFF";
    let note = "";
    let ends_at: number | null = null;
    const row = rows.find((r) => r.feature_key === f.key && (!r.ends_at || r.ends_at > now));
    if (row) {
      if (row.source === "ADMIN_BLOCK") { enabled = false; source = "ADMIN_BLOCK"; }
      else { enabled = !!row.enabled; source = row.source; }
      note = row.note; ends_at = row.ends_at;
    }
    out[f.key] = { enabled, source, note, ends_at };
  }
  // Account state gates
  const reasons: string[] = [];
  let readOnly = false;
  if (sub.status === "CANCELLED" || sub.status === "PAUSED") { readOnly = true; reasons.push(sub.status === "PAUSED" ? "Subscription paused" : "Subscription cancelled"); }
  if (sub.status === "TRIAL" && sub.trial_ends_at && sub.trial_ends_at < now) { readOnly = true; reasons.push("Trial ended — add a payment method to continue"); }
  if (sub.status === "PAST_DUE" && sub.past_due_since && sub.past_due_since + pb.grace_days * DAY < now) { readOnly = true; reasons.push("Payment overdue — update your card"); }
  const trial_days_left = sub.status === "TRIAL" && sub.trial_ends_at ? Math.max(0, Math.ceil((sub.trial_ends_at - now) / DAY)) : null;
  return { plan, subscription: sub, seats: { used: seatCount, included: plan.included_seats, billable: Math.max(0, seatCount - plan.included_seats) }, features: out, readOnly, reasons, trial_days_left };
}

export const hasFeature = (e: Entitlements, key: string) => !!e.features[key]?.enabled;

// ---- Usage -----------------------------------------------------------------------------------
// Idempotent on (ref_type, ref_id). Called from messaging (per SENT notification) and voice (per call).
export async function recordUsage(db: DB, shopId: string, featureKey: string, quantity: number, refType: string, refId: string, occurredAt = Date.now()) {
  if (quantity <= 0) return;
  const f = await db.prepare("SELECT unit_pence FROM features WHERE key=?").bind(featureKey).first<{ unit_pence: number }>();
  if (!f) return;
  await db.prepare("INSERT INTO usage_events(id,shop_id,feature_key,quantity,unit_pence,ref_type,ref_id,occurred_at,period_key) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(ref_type,ref_id) DO NOTHING")
    .bind(uid(), shopId, featureKey, quantity, f.unit_pence, refType, refId, occurredAt, periodKey(occurredAt)).run().catch(() => {});
}

export type UsageLine = { feature_key: string; name: string; unit: string; quantity: number; included: number; billable: number; unit_pence: number; amount_pence: number };
export async function usageFor(db: DB, shopId: string, period = periodKey()): Promise<UsageLine[]> {
  const fs = await features(db);
  const rows = (await db.prepare("SELECT feature_key, COALESCE(SUM(quantity),0)::int AS q FROM usage_events WHERE shop_id=? AND period_key=? GROUP BY feature_key").bind(shopId, period).all<{ feature_key: string; q: number }>()).results;
  return fs.filter((f) => f.unit).map((f) => {
    const q = rows.find((r) => r.feature_key === f.key)?.q ?? 0;
    const billable = Math.max(0, q - f.included_units);
    return { feature_key: f.key, name: f.name, unit: f.unit, quantity: q, included: f.included_units, billable, unit_pence: f.unit_pence, amount_pence: billable * f.unit_pence };
  });
}

// Estimated next invoice from local truth (Stripe's figure wins once it exists).
export async function estimate(db: DB, shopId: string) {
  const e = await entitlements(db, shopId);
  const usage = await usageFor(db, shopId);
  const fs = await features(db);
  const lines: { label: string; amount_pence: number; detail: string }[] = [];
  lines.push({ label: `${e.plan.name} plan`, amount_pence: e.plan.monthly_pence, detail: `includes ${e.plan.included_seats} seat${e.plan.included_seats === 1 ? "" : "s"}` });
  if (e.seats.billable > 0) lines.push({ label: `Extra seats × ${e.seats.billable}`, amount_pence: e.seats.billable * e.plan.seat_pence, detail: `£${(e.plan.seat_pence / 100).toFixed(2)} each` });
  for (const f of fs.filter((x) => x.kind === "ADDON" && x.monthly_pence > 0)) {
    const ent = e.features[f.key];
    if (ent?.enabled) lines.push({ label: f.name, amount_pence: ent.source === "ADMIN_GRANT" ? 0 : f.monthly_pence, detail: ent.source === "ADMIN_GRANT" ? "complimentary" : "monthly" });
  }
  for (const u of usage) if (u.quantity > 0) lines.push({ label: `${u.name} · ${u.quantity} ${u.unit}${u.quantity === 1 ? "" : "s"}`, amount_pence: u.amount_pence, detail: u.included ? `${Math.min(u.quantity, u.included)} included, ${u.billable} × ${u.unit_pence}p` : `${u.quantity} × ${u.unit_pence}p` });
  const discounts = (await db.prepare("SELECT d.* FROM shop_discounts sd JOIN discounts d ON d.id=sd.discount_id WHERE sd.shop_id=? AND d.active=1 AND (sd.ends_at IS NULL OR sd.ends_at > ?)").bind(shopId, Date.now()).all<{ code: string; name: string; kind: string; value: number; applies_to: string }>()).results;
  let subtotal = lines.reduce((n, l) => n + l.amount_pence, 0);
  let discount = 0;
  for (const d of discounts) {
    const base = d.applies_to === "ALL" ? subtotal : d.applies_to === "PLAN" ? e.plan.monthly_pence : lines.filter((l) => l.label.startsWith(fs.find((f) => `FEATURE:${f.key}` === d.applies_to)?.name ?? "\u0000")).reduce((n, l) => n + l.amount_pence, 0);
    if (d.kind === "PERCENT") discount += Math.round((base * d.value) / 100);
    else if (d.kind === "FIXED") discount += Math.min(base, d.value);
    else if (d.kind === "FREE_MONTHS") discount += e.plan.monthly_pence;
    else if (d.kind === "SEATS_FREE") discount += Math.min(e.seats.billable, d.value) * e.plan.seat_pence;
  }
  discount = Math.min(discount, subtotal);
  const pb = await platformBilling(db);
  const tax = pb.vat_mode === "UK_20" ? Math.round((subtotal - discount) * 0.2) : 0;
  return { lines, subtotal_pence: subtotal, discount_pence: discount, discounts: discounts.map((d) => ({ code: d.code, name: d.name })), tax_pence: tax, total_pence: subtotal - discount + tax, vat_mode: pb.vat_mode, period: periodKey(), usage, entitlements: e };
}

// ---- Feature toggles (shop self-serve add-ons and admin grants) --------------------------------
export async function setFeature(db: DB, shopId: string, key: string, enabled: boolean, source: ShopFeatureRow["source"], actor: string, note = "", endsAt: number | null = null) {
  const f = await db.prepare("SELECT * FROM features WHERE key=?").bind(key).first<FeatureRow>();
  if (!f) throw new Error("Unknown feature");
  const now = Date.now();
  if (source === "ADDON" && !enabled) {
    await db.prepare("DELETE FROM shop_features WHERE shop_id=? AND feature_key=? AND source='ADDON'").bind(shopId, key).run();
  } else {
    await db.prepare("INSERT INTO shop_features(shop_id,feature_key,enabled,source,granted_by,note,starts_at,ends_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(shop_id,feature_key) DO UPDATE SET enabled=EXCLUDED.enabled, source=EXCLUDED.source, granted_by=EXCLUDED.granted_by, note=EXCLUDED.note, starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at, updated_at=EXCLUDED.updated_at")
      .bind(shopId, key, enabled ? 1 : 0, source, actor, note, now, endsAt, now).run();
  }
  const priceNote = f.monthly_pence && source === "ADDON" ? ` · ${enabled ? "+" : "−"}£${(f.monthly_pence / 100).toFixed(2)}/mo${enabled ? " prorated from today" : " from the end of this period"}` : source === "ADMIN_GRANT" ? " · complimentary" : source === "ADMIN_BLOCK" ? " · blocked by OLLO" : "";
  await logBilling(db, shopId, enabled ? "FEATURE_ON" : "FEATURE_OFF", `${f.name} ${enabled ? "switched on" : "switched off"}${priceNote}${note ? ` — ${note}` : ""}`, actor, { key, source, ends_at: endsAt });
  // Stripe: add/remove the subscription item here when connected (stripe_item_id).
}

// Seat sync: called when staff.active changes. Records the proration the next invoice will show.
export async function syncSeats(db: DB, shopId: string, actor: string, change?: { name: string; added: boolean }) {
  const sub = await subscriptionFor(db, shopId);
  const n = (await db.prepare("SELECT COUNT(*)::int AS n FROM staff WHERE shop_id=? AND active=1").bind(shopId).first<{ n: number }>())?.n || 1;
  const seats = Math.max(1, n);
  if (seats === sub.seats) return { seats, delta_pence: 0 };
  const plan = await db.prepare("SELECT * FROM plans WHERE id=?").bind(sub.plan_id).first<PlanRow>();
  const seatPence = plan?.seat_pence ?? 799;
  const billableBefore = Math.max(0, sub.seats - (plan?.included_seats ?? 1));
  const billableAfter = Math.max(0, seats - (plan?.included_seats ?? 1));
  const deltaMonthly = (billableAfter - billableBefore) * seatPence;
  // Proration for the remainder of the current period (or the whole month on trial).
  const periodEnd = sub.current_period_end ?? (sub.trial_ends_at ?? Date.now() + 30 * DAY);
  const periodStart = sub.current_period_start ?? Date.now() - 30 * DAY + Math.max(0, periodEnd - Date.now() - 30 * DAY);
  const frac = Math.max(0, Math.min(1, (periodEnd - Date.now()) / Math.max(DAY, periodEnd - periodStart)));
  const delta = sub.status === "TRIAL" ? 0 : Math.round(deltaMonthly * frac);
  await db.prepare("UPDATE shop_subscriptions SET seats=?, version=version+1, updated_at=? WHERE shop_id=?").bind(seats, Date.now(), shopId).run();
  const who = change ? ` (${change.name} ${change.added ? "added" : "removed"})` : "";
  const money = (p: number) => `${p < 0 ? "−" : "+"}£${(Math.abs(p) / 100).toFixed(2)}`;
  await logBilling(db, shopId, "SEATS_CHANGED", `Seats ${sub.seats} → ${seats}${who} · ${money(deltaMonthly)}/mo${sub.status === "TRIAL" ? " once your trial ends" : ` · ${money(delta)} on this invoice`}`, actor, { from: sub.seats, to: seats, delta_monthly_pence: deltaMonthly, delta_pence: delta });
  // Stripe: update seat item quantity with proration_behavior=create_prorations when connected.
  return { seats, delta_pence: delta, delta_monthly_pence: deltaMonthly };
}

export async function billingSummary(db: DB, shopId: string) {
  const est = await estimate(db, shopId);
  const invoices = (await db.prepare("SELECT * FROM invoices WHERE shop_id=? ORDER BY period_start DESC LIMIT 24").bind(shopId).all()).results;
  const events = (await db.prepare("SELECT * FROM billing_events WHERE shop_id=? ORDER BY created_at DESC LIMIT 40").bind(shopId).all()).results;
  const fs = await features(db);
  return { ...est, invoices, events, features: fs };
}
