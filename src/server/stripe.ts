// Online deposits through Stripe Checkout — Model A: the customer pays the shop's own connected
// Stripe account; OLLO never holds funds. Platform keys come from env:
//   STRIPE_SECRET_KEY      sk_live_… / sk_test_…   (platform account)
//   STRIPE_WEBHOOK_SECRET  whsec_…                 (endpoint: POST /api/stripe/webhook)
//   STRIPE_CONNECT=1       when set, charges run on the shop's connected account
//                          (shops.stripe_account_id, Express onboarding). Without it, charges go to the
//                          platform account and are tagged with the shop id — fine for a single-shop deploy.
// With no STRIPE_SECRET_KEY the app runs in preview mode: no session is created, deposits are
// "recorded, payable in the shop", and Settings → Payments says so.
//
// Uses Stripe's REST API over fetch (no SDK) so it runs on Node and edge alike.
import type { Database as DB } from "../db/client";
import type { Shop, StoredBooking } from "./domain";

type Env = { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; STRIPE_CONNECT?: string; APP_ORIGIN?: string };
const env = (): Env => (typeof process !== "undefined" ? (process.env as Env) : {});
export const stripeLive = () => !!env().STRIPE_SECRET_KEY;
export const stripeConnect = () => env().STRIPE_CONNECT === "1";

export type StripeStatus = {
  provider: "stripe" | "none";
  mode: "live" | "test" | "preview";
  connect: boolean;
  webhook: boolean;
};
export function stripeStatus(): StripeStatus {
  const k = env().STRIPE_SECRET_KEY || "";
  return {
    provider: k ? "stripe" : "none",
    mode: !k ? "preview" : k.startsWith("sk_live") ? "live" : "test",
    connect: stripeConnect(),
    webhook: !!env().STRIPE_WEBHOOK_SECRET,
  };
}

// Whether this shop can take a deposit online right now: toggled on, a deposit amount, live keys, and
// (with Connect) a connected account.
export function depositsOnline(shop: Pick<Shop, "deposits_online" | "deposit_pence" | "stripe_account_id">) {
  if (!stripeLive()) return false;
  if ((shop.deposits_online ?? 0) !== 1 || shop.deposit_pence <= 0) return false;
  if (stripeConnect() && !shop.stripe_account_id) return false;
  return true;
}

class StripeError extends Error {
  constructor(message: string, public status: number, public code = "") {
    super(message);
  }
}
async function stripe<T>(path: string, body?: Record<string, string | number | boolean | undefined>, opts: { account?: string; method?: "GET" | "POST"; idempotency?: string } = {}): Promise<T> {
  const key = env().STRIPE_SECRET_KEY;
  if (!key) throw new StripeError("Stripe is not configured", 503, "stripe_off");
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" };
  if (opts.account) headers["Stripe-Account"] = opts.account;
  if (opts.idempotency) headers["Idempotency-Key"] = opts.idempotency;
  let url = `https://api.stripe.com/v1${path}`;
  let init: RequestInit = { method: opts.method ?? (body ? "POST" : "GET"), headers };
  if (body) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v !== undefined) form.set(k, String(v));
    if (init.method === "GET") url += `?${form}`;
    else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      init = { ...init, body: form.toString() };
    }
  }
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } } & T;
  if (!res.ok) throw new StripeError(json.error?.message || `Stripe ${res.status}`, res.status, json.error?.code || "");
  return json;
}

// ---- Checkout -------------------------------------------------------------------------------------
export type CheckoutSession = { id: string; url: string; payment_intent?: string | null; payment_status?: string; status?: string };

// Create a Checkout session for the booking's deposit. The slot is already held (booking row exists
// with deposit_status=PENDING); Checkout returns to the manage page which confirms.
export async function createDepositSession(shop: Shop, booking: StoredBooking, origin: string, manageToken: string, holdMinutes: number) {
  const amount = Math.min(shop.deposit_pence, booking.price_pence);
  const currency = (shop.currency || "GBP").toLowerCase();
  const manage = `${origin}/manage/${manageToken}`;
  const expires = Math.floor(Date.now() / 1000) + Math.max(30, holdMinutes) * 60; // Stripe minimum 30 min
  const body: Record<string, string | number> = {
    mode: "payment",
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": currency,
    "line_items[0][price_data][unit_amount]": amount,
    "line_items[0][price_data][product_data][name]": `Deposit · ${booking.service_name}`,
    "line_items[0][price_data][product_data][description]": `${shop.name} · ${booking.date} · ref ${booking.id.slice(0, 6).toUpperCase()}`,
    success_url: `${manage}?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${manage}?paid=0`,
    client_reference_id: booking.id,
    expires_at: expires,
    "metadata[shop_id]": shop.id,
    "metadata[booking_id]": booking.id,
    "payment_intent_data[metadata][shop_id]": shop.id,
    "payment_intent_data[metadata][booking_id]": booking.id,
    "payment_intent_data[description]": `${shop.name} deposit · ${booking.service_name} · ${booking.date}`,
  };
  if (booking.email) body.customer_email = booking.email;
  return stripe<CheckoutSession>("/checkout/sessions", body, { account: stripeConnect() ? shop.stripe_account_id : undefined, idempotency: `deposit-${booking.id}` });
}
export async function retrieveSession(sessionId: string, account?: string) {
  return stripe<CheckoutSession>(`/checkout/sessions/${encodeURIComponent(sessionId)}`, undefined, { account });
}
export async function expireSession(sessionId: string, account?: string) {
  return stripe<CheckoutSession>(`/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {}, { account });
}
export async function refundIntent(paymentIntent: string, account?: string, idempotency?: string) {
  return stripe<{ id: string; status: string }>("/refunds", { payment_intent: paymentIntent }, { account, idempotency });
}

// ---- Connect onboarding (Express) ------------------------------------------------------------------
export async function createConnectedAccount(shop: Shop, email: string) {
  return stripe<{ id: string }>("/accounts", {
    type: "express",
    country: shop.currency === "GBP" ? "GB" : undefined,
    email,
    "business_profile[name]": shop.name,
    "capabilities[card_payments][requested]": true,
    "capabilities[transfers][requested]": true,
    "metadata[shop_id]": shop.id,
  }, { idempotency: `acct-${shop.id}` });
}
export async function accountLink(accountId: string, origin: string) {
  return stripe<{ url: string }>("/account_links", {
    account: accountId,
    refresh_url: `${origin}/workspace?stripe=refresh`,
    return_url: `${origin}/workspace?stripe=return`,
    type: "account_onboarding",
  });
}
export async function accountStatus(accountId: string) {
  const a = await stripe<{ id: string; charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; requirements?: { currently_due?: string[] } }>(`/accounts/${encodeURIComponent(accountId)}`);
  return { id: a.id, charges_enabled: !!a.charges_enabled, payouts_enabled: !!a.payouts_enabled, details_submitted: !!a.details_submitted, due: a.requirements?.currently_due ?? [] };
}

// ---- Webhook signature (Stripe-Signature: t=…,v1=…) ----------------------------------------------
export async function verifyWebhook(rawBody: string, header: string | undefined, tolerance = 300) {
  const secret = env().STRIPE_WEBHOOK_SECRET;
  if (!secret) return { ok: false as const, reason: "no_secret" };
  if (!header) return { ok: false as const, reason: "no_signature" };
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts.t;
  const v1s = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !v1s.length) return { ok: false as const, reason: "malformed" };
  if (Math.abs(Date.now() / 1000 - Number(t)) > tolerance) return { ok: false as const, reason: "stale" };
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`)));
  const hex = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
  return v1s.some((v) => timingSafeEqual(v, hex)) ? { ok: true as const } : { ok: false as const, reason: "bad_signature" };
}
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// ---- Applying results ------------------------------------------------------------------------------
// Mark a booking's deposit paid (idempotent). Returns true when this call made the change.
export async function markDepositPaid(db: DB, shopId: string, bookingId: string, amountPence: number, paymentIntent: string, sessionId: string) {
  const r = await db
    .prepare("UPDATE bookings SET deposit_status='PAID', deposit_paid_pence=?, stripe_payment_intent=?, stripe_session_id=COALESCE(NULLIF(stripe_session_id,''),?), deposit_hold_until=NULL, version=version+1, updated_at=? WHERE shop_id=? AND id=? AND deposit_status IN ('PENDING','EXPIRED')")
    .bind(amountPence, paymentIntent, sessionId, Date.now(), shopId, bookingId)
    .run();
  return r.meta.changes > 0;
}

// Expire holds whose payment window lapsed: cancel the booking so the slot frees. Called from the
// lazy sweep and the cron. Returns the bookings released so callers can notify/auto-offer.
export async function expireHolds(db: DB, now = Date.now()) {
  const due = await db
    .prepare("SELECT id, shop_id, staff_id, date, start_min, stripe_session_id FROM bookings WHERE deposit_status='PENDING' AND deposit_hold_until IS NOT NULL AND deposit_hold_until<? AND status='CONFIRMED' LIMIT 50")
    .bind(now)
    .all<{ id: string; shop_id: string; staff_id: string; date: string; start_min: number; stripe_session_id: string }>();
  const released: typeof due.results = [];
  for (const b of due.results) {
    const r = await db
      .prepare("UPDATE bookings SET status='CANCELLED', deposit_status='EXPIRED', version=version+1, updated_at=? WHERE shop_id=? AND id=? AND deposit_status='PENDING' AND status='CONFIRMED'")
      .bind(now, b.shop_id, b.id)
      .run();
    if (!r.meta.changes) continue;
    await db
      .prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), b.shop_id, "booking", b.id, "CANCELLED", "system", "Deposit not paid in time; hold released.", now)
      .run();
    released.push(b);
    if (b.stripe_session_id && stripeLive()) expireSession(b.stripe_session_id).catch(() => null);
  }
  return released;
}


// Refund a paid deposit through Stripe and record it. Idempotent on the booking id. Never throws:
// a failed refund is audited so the owner can do it from the Stripe dashboard.
export async function refundDeposit(db: DB, shop: Shop, booking: StoredBooking, actor: string, why: string) {
  if (booking.deposit_status !== "PAID" || !booking.stripe_payment_intent) return false;
  const now = Date.now();
  try {
    const r = await refundIntent(booking.stripe_payment_intent, stripeConnect() ? shop.stripe_account_id : undefined, `refund-${booking.id}`);
    await db.batch([
      db.prepare("UPDATE bookings SET deposit_status='REFUNDED', stripe_refund_id=?, updated_at=? WHERE shop_id=? AND id=? AND deposit_status='PAID'").bind(r.id, now, shop.id, booking.id),
      db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), shop.id, "booking", booking.id, "DEPOSIT_REFUNDED", actor, `Deposit ${booking.deposit_paid_pence}p refunded to card (${why}).`, now),
    ]);
    return true;
  } catch (err) {
    await db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), shop.id, "booking", booking.id, "DEPOSIT_REFUND_FAILED", actor, `Refund failed: ${err instanceof Error ? err.message : "error"}. Refund from the Stripe dashboard.`, now)
      .run();
    return false;
  }
}

// Customer-facing summary for payloads.
export function depositView(b: Pick<StoredBooking, "deposit_status" | "deposit_paid_pence" | "deposit_hold_until" | "deposit_policy_pence">) {
  return {
    deposit_status: b.deposit_status ?? "NONE",
    deposit_paid_pence: b.deposit_paid_pence ?? 0,
    deposit_hold_until: b.deposit_hold_until ?? null,
    deposit_due_pence: (b.deposit_status ?? "NONE") === "PENDING" ? b.deposit_policy_pence : 0,
  };
}
export { StripeError };
