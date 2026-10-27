// Stripe: foliyo is the merchant of record (separate charges and transfers). Customers pay foliyo's
// platform balance through Checkout / Terminal; pay runs transfer each barber's and shop's share to
// their connected (recipient) accounts. See docs/STRIPE_PLAN.md and docs/PAYMENTS.md. Env:
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
import { shopUrl } from "./hosts";

type Env = { STRIPE_API_BASE?: string; STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; STRIPE_WEBHOOK_SECRET_CONNECT?: string; STRIPE_CONNECT?: string; APP_ORIGIN?: string };
const env = (): Env => (typeof process !== "undefined" ? (process.env as Env) : {});
export const stripeLive = () => !!env().STRIPE_SECRET_KEY;
// Where Stripe's API lives. Only a TEST key may be pointed elsewhere (a local fake for automated
// tests); a live key always talks to Stripe itself, whatever the environment says.
export function stripeApi(): string {
  const e = env();
  return e.STRIPE_API_BASE && (e.STRIPE_SECRET_KEY || "").startsWith("sk_test_") ? e.STRIPE_API_BASE.replace(/\/+$/, "") : "https://api.stripe.com";
}
// Connect is the model (platform charges, transfers out). STRIPE_CONNECT=0 turns the shop/barber
// account layer off for a single-shop deployment where the platform account IS the shop.
export const stripeConnect = () => (env().STRIPE_CONNECT ?? "1") !== "0";

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
export function depositsOnline(shop: Pick<Shop, "deposits_online" | "deposit_pence" | "stripe_account_id" | "payment_mode">) {
  if (!stripeLive()) return false;
  if ((shop.deposits_online ?? 0) !== 1) return false;
  // PREPAY takes the full price so a zero deposit is fine; DEPOSIT needs an amount.
  if ((shop.payment_mode ?? "DEPOSIT") === "DEPOSIT" && shop.deposit_pence <= 0) return false;
  return true;
}

// The one sentence customers see about paying, everywhere (shop page, booking, manage page,
// messages). It follows the shop's single choice, and if online payments were chosen but card
// payments aren't actually connected, it says "pay in the shop" rather than promise a deposit.
export type PaymentPolicy = { mode: "IN_STORE" | "DEPOSIT" | "FULL"; deposit_pence: number; line: string };
export function paymentPolicy(shop: Pick<Shop, "deposits_online" | "deposit_pence" | "stripe_account_id" | "payment_mode" | "currency">): PaymentPolicy {
  const fmt = (p: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: shop.currency || "GBP" }).format(p / 100);
  const mode = shop.payment_mode ?? "DEPOSIT";
  if (mode === "PAY_AT_VISIT" || !depositsOnline(shop)) return { mode: "IN_STORE", deposit_pence: 0, line: "Pay in the shop on the day. No payment is taken online." };
  if (mode === "PREPAY") return { mode: "FULL", deposit_pence: 0, line: "The full price is taken by card when you book." };
  return { mode: "DEPOSIT", deposit_pence: shop.deposit_pence, line: `A ${fmt(shop.deposit_pence)} deposit is taken by card when you book. The rest is paid in the shop.` };
}

// What the customer sees after foliyo's name on their card statement, so a charge reads as the barber's.
// Stripe caps the whole statement line at 22 characters including foliyo's own prefix, so keep the
// shop part short (12). Needs at least one letter and none of < > \\ ' " *.
export function descriptorSuffix(name: string): string {
  const clean = (name || "").normalize("NFKD").replace(/[^\x20-\x7E]/g, "").replace(/[<>\\'"*]/g, "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 12).trim();
  return /[A-Z]/.test(clean) ? clean : "";
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
  let url = `${stripeApi()}/v1${path}`;
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
// Accounts v2 (JSON body, preview version). Stripe rejects v1 account creation on new platforms, so
// connected accounts are created here; everything else about them (transfers, login links, payout
// schedule, account.updated) still works through v1 with the same acct_ id.
const V2_VERSION = "2026-05-27.preview";
async function stripeV2<T>(path: string, body?: Record<string, unknown>, opts: { idempotency?: string } = {}): Promise<T> {
  const key = env().STRIPE_SECRET_KEY;
  if (!key) throw new StripeError("Stripe is not configured", 503, "stripe_off");
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Stripe-Version": V2_VERSION, "Content-Type": "application/json" };
  if (opts.idempotency) headers["Idempotency-Key"] = opts.idempotency;
  const res = await fetch(`${stripeApi()}/v2${path}`, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } } & T;
  if (!res.ok) throw new StripeError(json.error?.message || `Stripe ${res.status}`, res.status, json.error?.code || "");
  return json;
}

// ---- Checkout -------------------------------------------------------------------------------------
export type CheckoutSession = { id: string; url: string; payment_intent?: string | null; payment_status?: string; status?: string };

// Create a Checkout session for the booking's deposit. The slot is already held (booking row exists
// with deposit_status=PENDING); Checkout returns to the manage page which confirms.
export async function createDepositSession(shop: Shop, booking: StoredBooking, origin: string, manageToken: string, holdMinutes: number) {
  // deposit_policy_pence already reflects the payment mode: full price for PREPAY, the shop's
  // deposit otherwise (never more than the price).
  const amount = Math.min(booking.deposit_policy_pence || Math.min(shop.deposit_pence, booking.price_pence), booking.price_pence);
  const prepay = amount >= booking.price_pence;
  const currency = (shop.currency || "GBP").toLowerCase();
  const manage = shopUrl(shop.slug!, `/manage/${manageToken}`, origin);
  const expires = Math.floor(Date.now() / 1000) + Math.max(30, holdMinutes) * 60; // Stripe minimum 30 min
  const body: Record<string, string | number | boolean> = {
    mode: "payment",
    // New accounts default to Managed Payments (Stripe as merchant of record). foliyo is the merchant
    // of record for the Connect split, so it is off here; otherwise Stripe demands product tax codes.
    "managed_payments[enabled]": false,
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": currency,
    "line_items[0][price_data][unit_amount]": amount,
    "line_items[0][price_data][product_data][name]": `${prepay ? "Payment" : "Deposit"} · ${booking.service_name}`,
    "line_items[0][price_data][product_data][description]": `${shop.name} · ${booking.date} · ref BRB-${String(booking.sequence).padStart(4, "0")}`,
    success_url: `${manage}?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${manage}?paid=0`,
    client_reference_id: booking.id,
    expires_at: expires,
    "metadata[shop_id]": shop.id,
    "metadata[booking_id]": booking.id,
    "payment_intent_data[metadata][shop_id]": shop.id,
    "payment_intent_data[metadata][booking_id]": booking.id,
    "payment_intent_data[description]": `${shop.name} ${prepay ? "payment" : "deposit"} · ${booking.service_name} · ${booking.date}`,
  };
  // Receipts: the account has Managed Payments on, which always emails the customer a receipt and
  // rejects payment_intent_data.receipt_email — customer_email is enough.
  if (booking.email) body.customer_email = booking.email;
  // Platform is the merchant of record: the charge lands on foliyo's balance and the pay run moves the
  // shop's and barber's shares out with Transfers. No Stripe-Account header.
  const suffix = descriptorSuffix(shop.name);
  if (suffix) body["payment_intent_data[statement_descriptor_suffix]"] = suffix;
  // A refused statement suffix must never stop the customer paying: retry once without it (the
  // idempotency key changes because the parameters do).
  return stripe<CheckoutSession>("/checkout/sessions", body, { idempotency: `deposit-${booking.id}${suffix ? "-d" : ""}` }).catch((e) => {
    if (suffix && e instanceof StripeError && e.status === 400) { delete body["payment_intent_data[statement_descriptor_suffix]"]; return stripe<CheckoutSession>("/checkout/sessions", body, { idempotency: `deposit-${booking.id}` }); }
    return Promise.reject(e);
  });
}
export async function retrieveSession(sessionId: string, account?: string) {
  return stripe<CheckoutSession>(`/checkout/sessions/${encodeURIComponent(sessionId)}`, undefined, { account });
}
export async function expireSession(sessionId: string, account?: string) {
  return stripe<CheckoutSession>(`/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {}, { account });
}
export async function refundIntent(paymentIntent: string, account?: string, idempotency?: string, amountPence?: number) {
  return stripe<{ id: string; status: string }>("/refunds", { payment_intent: paymentIntent, ...(amountPence ? { amount: amountPence } : {}) }, { account, idempotency });
}

// ---- Connect platform: Express accounts for shops AND barbers ------------------------------------
export type OwnerType = "SHOP" | "STAFF";
// Recipient-only configuration: the account receives Transfers from foliyo's balance and pays out to
// its bank. It never charges customers itself, so card_payments is deliberately not requested — that
// would force full merchant KYC on every barber. foliyo owns pricing and losses (separate charges and
// transfers require both), Express dashboard for balance/payouts.
export async function createExpressAccount(opts: { shopId: string; ownerType: OwnerType; ownerId: string; email: string; name: string; country?: string; individual?: boolean }) {
  return stripeV2<{ id: string }>("/core/accounts", {
    display_name: opts.name.slice(0, 100),
    contact_email: opts.email || undefined,
    identity: { country: (opts.country || "GB").toLowerCase(), entity_type: opts.individual ? "individual" : "company" },
    dashboard: "express",
    defaults: { currency: "gbp", responsibilities: { fees_collector: "application", losses_collector: "application" } },
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
    metadata: { shop_id: opts.shopId, owner_type: opts.ownerType, owner_id: opts.ownerId },
  }, { idempotency: `acct2-${opts.ownerType}-${opts.ownerId}` });
}
export async function accountLink(accountId: string, origin: string, returnPath = "/workspace?stripe=return", refreshPath = "/workspace?stripe=refresh") {
  return stripeV2<{ url: string; expires_at: string }>("/core/account_links", {
    account: accountId,
    use_case: { type: "account_onboarding", account_onboarding: { configurations: ["recipient"], refresh_url: `${origin}${refreshPath}`, return_url: `${origin}${returnPath}` } },
  });
}
// One-time link into the Express dashboard (balance, payouts, "pay out now").
export async function loginLink(accountId: string) {
  return stripe<{ url: string }>(`/accounts/${encodeURIComponent(accountId)}/login_links`, {});
}
export type AccountSnapshot = { id: string; charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; due: string[]; disabled_reason: string; payout_schedule: string };
export function snapshotOf(a: { id: string; charges_enabled?: boolean; payouts_enabled?: boolean; details_submitted?: boolean; requirements?: { currently_due?: string[]; disabled_reason?: string | null }; settings?: { payouts?: { schedule?: { interval?: string } } } }): AccountSnapshot {
  return {
    id: a.id,
    charges_enabled: !!a.charges_enabled,
    payouts_enabled: !!a.payouts_enabled,
    details_submitted: !!a.details_submitted,
    due: a.requirements?.currently_due ?? [],
    disabled_reason: a.requirements?.disabled_reason ?? "",
    payout_schedule: a.settings?.payouts?.schedule?.interval ?? "daily",
  };
}
export async function accountStatus(accountId: string): Promise<AccountSnapshot> {
  return snapshotOf(await stripe<Parameters<typeof snapshotOf>[0]>(`/accounts/${encodeURIComponent(accountId)}`));
}
export async function setPayoutSchedule(accountId: string, interval: "daily" | "weekly" | "monthly") {
  return stripe(`/accounts/${encodeURIComponent(accountId)}`, { "settings[payouts][schedule][interval]": interval, ...(interval === "weekly" ? { "settings[payouts][schedule][weekly_anchor]": "friday" } : {}), ...(interval === "monthly" ? { "settings[payouts][schedule][monthly_anchor]": 1 } : {}) });
}

// ---- Money movement ---------------------------------------------------------------------------------
export type Transfer = { id: string; amount: number; destination: string; transfer_group: string | null };
// Move funds from the platform balance to a connected account. Idempotent per key.
export async function createTransfer(opts: { amountPence: number; destination: string; currency: string; group: string; description: string; metadata: Record<string, string>; idempotency: string }) {
  const body: Record<string, string | number> = {
    amount: opts.amountPence,
    currency: opts.currency.toLowerCase(),
    destination: opts.destination,
    transfer_group: opts.group,
    description: opts.description,
  };
  for (const [k, v] of Object.entries(opts.metadata)) body[`metadata[${k}]`] = v;
  return stripe<Transfer>("/transfers", body, { idempotency: opts.idempotency });
}
export async function reverseTransfer(transferId: string, amountPence: number | undefined, reason: string, idempotency: string) {
  return stripe<{ id: string; amount: number }>(`/transfers/${encodeURIComponent(transferId)}/reversals`, { ...(amountPence ? { amount: amountPence } : {}), "metadata[reason]": reason.slice(0, 200) }, { idempotency });
}
// Platform balance: available (can transfer now) vs pending (still settling). The float is the
// available figure; FAST payouts spend it ahead of settlement.
export async function platformBalance() {
  const b = await stripe<{ available: { amount: number; currency: string }[]; pending: { amount: number; currency: string }[] }>("/balance");
  const sum = (rows: { amount: number; currency: string }[], cur: string) => rows.filter((r) => r.currency === cur).reduce((n, r) => n + r.amount, 0);
  return { available_pence: sum(b.available, "gbp"), pending_pence: sum(b.pending, "gbp") };
}
// Balance held on a connected account (a barber's or the shop's wallet): available = can be paid out
// now; pending = transferred but not yet settled on their side. Read with the Stripe-Account header.
export async function accountBalance(accountId: string) {
  const b = await stripe<{ available: { amount: number; currency: string }[]; pending: { amount: number; currency: string }[] }>("/balance", undefined, { account: accountId });
  const sum = (rows: { amount: number; currency: string }[], cur: string) => rows.filter((r) => r.currency === cur).reduce((n, r) => n + r.amount, 0);
  return { available_pence: sum(b.available, "gbp"), pending_pence: sum(b.pending, "gbp") };
}
// Top up the platform balance from the platform's bank account (UK: Bacs/Faster Payments).
export async function topUp(amountPence: number, description: string, idempotency: string) {
  return stripe<{ id: string; status: string; expected_availability_date?: number }>("/topups", { amount: amountPence, currency: "gbp", description }, { idempotency });
}
// Fee Stripe took on a charge (for "commission net of fees" policies and honest wallets).
export async function chargeFee(paymentIntent: string) {
  const pi = await stripe<{ latest_charge?: string }>(`/payment_intents/${encodeURIComponent(paymentIntent)}`);
  if (!pi.latest_charge) return { charge: "", fee_pence: 0 };
  const ch = await stripe<{ id: string; balance_transaction?: string }>(`/charges/${encodeURIComponent(pi.latest_charge)}`);
  if (!ch.balance_transaction) return { charge: ch.id, fee_pence: 0 };
  const bt = await stripe<{ fee: number }>(`/balance_transactions/${encodeURIComponent(ch.balance_transaction)}`);
  return { charge: ch.id, fee_pence: bt.fee };
}
// Platform take on a card payment, from platform_payments.
export const platformFee = (amountPence: number, fee: { fee_bps: number; fee_fixed_pence: number }) => (amountPence <= 0 ? 0 : Math.round((amountPence * fee.fee_bps) / 10000) + fee.fee_fixed_pence);

// ---- Webhook signature (Stripe-Signature: t=…,v1=…) ----------------------------------------------
// Two endpoints can point at the same URL (platform events, connected-account events), each with
// its own signing secret; accept a signature from either.
export async function verifyWebhook(rawBody: string, header: string | undefined, tolerance = 300) {
  const secrets = [env().STRIPE_WEBHOOK_SECRET, env().STRIPE_WEBHOOK_SECRET_CONNECT].filter((s): s is string => !!s);
  if (!secrets.length) return { ok: false as const, reason: "no_secret" };
  if (!header) return { ok: false as const, reason: "no_signature" };
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts.t;
  const v1s = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !v1s.length) return { ok: false as const, reason: "malformed" };
  if (Math.abs(Date.now() / 1000 - Number(t)) > tolerance) return { ok: false as const, reason: "stale" };
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`)));
    const hex = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (v1s.some((v) => timingSafeEqual(v, hex))) return { ok: true as const };
  }
  return { ok: false as const, reason: "bad_signature" };
}
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// ---- Applying results ------------------------------------------------------------------------------
// Mark a booking's deposit paid (idempotent). Returns true when this call made the change.
// A Checkout payment landed for a booking. Returns what happened so callers can message the customer:
//   "paid"     the normal case: the hold was still open.
//              Also returned when the hold had lapsed but the customer paid anyway (slow 3-D Secure, delayed
//              webhook) and the slot was still free: the booking is restored.
//   "refunded" the hold lapsed and the slot is gone (or the visit was cancelled): the money goes straight
//              back and the customer is told, rather than being charged for nothing.
//   null       already recorded (duplicate event) or nothing to do.
export async function markDepositPaid(db: DB, shopId: string, bookingId: string, amountPence: number, paymentIntent: string, sessionId: string): Promise<"paid" | "refunded" | null> {
  const now = Date.now();
  const r = await db
    .prepare("UPDATE bookings SET deposit_status='PAID', deposit_paid_pence=?, stripe_payment_intent=?, stripe_session_id=COALESCE(NULLIF(stripe_session_id,''),?), deposit_hold_until=NULL, version=version+1, updated_at=? WHERE shop_id=? AND id=? AND deposit_status='PENDING' AND status='CONFIRMED'")
    .bind(amountPence, paymentIntent, sessionId, now, shopId, bookingId)
    .run();
  if (r.meta.changes > 0) return "paid";
  const b = await db.prepare("SELECT status, deposit_status, deposit_hold_until, stripe_payment_intent FROM bookings WHERE shop_id=? AND id=?").bind(shopId, bookingId).first<{ status: string; deposit_status: string; deposit_hold_until: number | null; stripe_payment_intent: string }>();
  if (!b || !paymentIntent || b.stripe_payment_intent === paymentIntent || b.deposit_status === "PAID" || b.deposit_status === "REFUNDED") return null;
  // Only a hold that LAPSED can be revived (a customer who cancelled themselves stays cancelled).
  if (b.status === "CANCELLED" && b.deposit_status === "EXPIRED" && b.deposit_hold_until !== null) {
    try {
      const rv = await db
        .prepare("UPDATE bookings SET status='CONFIRMED', deposit_status='PAID', deposit_paid_pence=?, stripe_payment_intent=?, stripe_session_id=COALESCE(NULLIF(stripe_session_id,''),?), deposit_hold_until=NULL, version=version+1, updated_at=? WHERE shop_id=? AND id=? AND deposit_status='EXPIRED' AND status='CANCELLED'")
        .bind(amountPence, paymentIntent, sessionId, now, shopId, bookingId)
        .run();
      if (rv.meta.changes > 0) {
        await db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .bind(crypto.randomUUID(), shopId, "booking", bookingId, "CONFIRMED", "stripe", "Deposit arrived after the hold lapsed; the slot was still free so the booking was restored.", now).run();
        return "paid";
      }
    } catch {
      /* slot taken meanwhile: fall through to the refund */
    }
  }
  // Cannot honour it: give the money back straight away and record it on the booking.
  try {
    const rf = await refundIntent(paymentIntent, undefined, `late-${bookingId}-${paymentIntent}`);
    await db.batch([
      db.prepare("UPDATE bookings SET deposit_status='REFUNDED', deposit_paid_pence=?, stripe_payment_intent=?, stripe_refund_id=?, deposit_hold_until=NULL, updated_at=? WHERE shop_id=? AND id=? AND deposit_status IN ('PENDING','EXPIRED')").bind(amountPence, paymentIntent, rf.id, now, shopId, bookingId),
      db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), shopId, "booking", bookingId, "DEPOSIT_REFUNDED", "stripe", `Deposit ${amountPence}p arrived after the booking was released and the slot is no longer free; refunded automatically.`, now),
    ]);
    return "refunded";
  } catch (err) {
    // Could not refund either: leave a loud audit line and let the webhook retry (the caller 500s on throw).
    await db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), shopId, "booking", bookingId, "DEPOSIT_REFUND_FAILED", "stripe", `Late payment ${amountPence}p could not be refunded: ${err instanceof Error ? err.message : "error"}. Refund payment ${paymentIntent} from the Stripe dashboard.`, now).run().catch(() => null);
    throw err;
  }
}

// A deposit the shop KEEPS (customer cancelled inside the policy window, or no-show): it is shop money
// like any card payment, so it goes into the ledger as an ONLINE tender and the next pay run moves it.
// Idempotent: nothing happens if the deposit already has a live ledger row.
export async function keepDepositInLedger(db: DB, shop: Shop, booking: StoredBooking, actor: string, why: string) {
  const paid = booking.deposit_paid_pence ?? 0;
  if (booking.deposit_status !== "PAID" || !(paid > 0)) return false;
  const have = await db.prepare("SELECT 1 FROM payments WHERE shop_id=? AND booking_id=? AND method='ONLINE' AND voided_at IS NULL").bind(shop.id, booking.id).first();
  if (have) return false;
  const { platformPolicy } = await import("./payouts");
  const { shopToday } = await import("./domain");
  const staff = await db.prepare("SELECT commission_pct FROM staff WHERE shop_id=? AND id=?").bind(shop.id, booking.staff_id).first<{ commission_pct: number }>();
  const amount = Math.min(paid, booking.price_pence);
  const pid = crypto.randomUUID();
  const now = Date.now();
  const policy = await platformPolicy(db);
  await db.batch([
    db.prepare("INSERT INTO payments(id,shop_id,booking_id,staff_id,customer_id,date,method,service_pence,tip_pence,discount_pence,commission_pct,note,recorded_by,created_at,stripe_payment_intent,platform_fee_pence) VALUES(?,?,?,?,?,?,'ONLINE',?,0,0,?,?,?,?,?,?)")
      .bind(pid, shop.id, booking.id, booking.staff_id, booking.customer_id, shopToday(shop.timezone, now), amount, staff?.commission_pct ?? 50, `Deposit kept: ${why}`.slice(0, 200), actor, now, booking.stripe_payment_intent || "", platformFee(amount, policy)),
    db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), shop.id, "payment", pid, "PAYMENT_RECORDED", actor, `ONLINE ${amount}p deposit kept (${why})`, now),
  ]);
  return true;
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


// Refund a paid deposit through Stripe and record it. Idempotent on the booking id. Never throws.
// A refund Stripe refuses is not forgotten: the booking is flagged (deposit_refund_retry_at) and the
// sweep tries again, and the Payments page shows the shop that one is outstanding. `attempt` makes the
// retry's idempotency key differ from the failed one (Stripe replays a failed result for the same key).
// Once the money is back with the customer, any ledger row for the deposit is voided and, if a pay run
// already paid it out, the transfers are reversed — otherwise the barber keeps money that was refunded.
export async function refundDeposit(db: DB, shop: Shop, booking: StoredBooking, actor: string, why: string, attempt = 0) {
  if (booking.deposit_status !== "PAID" || !booking.stripe_payment_intent) return false;
  const now = Date.now();
  const done = async (refundId: string, note: string) => {
    await db.batch([
      db.prepare("UPDATE bookings SET deposit_status='REFUNDED', stripe_refund_id=?, deposit_refund_retry_at=NULL, updated_at=? WHERE shop_id=? AND id=? AND deposit_status='PAID'").bind(refundId, now, shop.id, booking.id),
      db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), shop.id, "booking", booking.id, "DEPOSIT_REFUNDED", actor, `Deposit ${booking.deposit_paid_pence}p refunded to card (${why})${note}.`, now),
    ]);
    await unwindDepositLedger(db, shop.id, booking.id, `deposit refunded: ${why}`, actor).catch(() => null);
  };
  try {
    const r = await refundIntent(booking.stripe_payment_intent, undefined, attempt ? `refund-${booking.id}-${attempt}` : `refund-${booking.id}`);
    await done(r.id, "");
    return true;
  } catch (err) {
    // Stripe says it is already refunded (an earlier attempt landed, or it was done in the dashboard).
    if (err instanceof StripeError && err.code === "charge_already_refunded") { await done("", " — already refunded at Stripe"); return true; }
    const retryAt = now + 15 * 60000;
    await db.batch([
      db.prepare("UPDATE bookings SET deposit_refund_retry_at=? WHERE shop_id=? AND id=? AND deposit_status='PAID'").bind(retryAt, shop.id, booking.id),
      db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), shop.id, "booking", booking.id, "DEPOSIT_REFUND_FAILED", actor, `Refund failed: ${err instanceof Error ? err.message : "error"}. We will try again automatically; if it keeps failing, refund it from the Stripe dashboard.`, now),
    ]).catch(() => null);
    return false;
  }
}
// The ledger row for a deposit that has been refunded no longer counts: void it, and claw back what a
// pay run already sent out for it.
export async function unwindDepositLedger(db: DB, shopId: string, bookingId: string, reason: string, actor: string) {
  const row = await db.prepare("SELECT id, pay_run_id, service_pence, tip_pence FROM payments WHERE shop_id=? AND booking_id=? AND method='ONLINE' AND voided_at IS NULL").bind(shopId, bookingId).first<{ id: string; pay_run_id: string | null; service_pence: number; tip_pence: number }>();
  if (!row) return;
  await db.batch([
    db.prepare("UPDATE payments SET voided_at=?, void_reason=? WHERE shop_id=? AND id=? AND voided_at IS NULL").bind(Date.now(), reason.slice(0, 300), shopId, row.id),
    db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), shopId, "payment", row.id, "PAYMENT_VOIDED", actor, reason.slice(0, 300), Date.now()),
  ]);
  if (row.pay_run_id) {
    const { reverseForPayment } = await import("./payouts");
    await reverseForPayment(db, shopId, row.id, row.service_pence + row.tip_pence, reason, actor);
  }
}
// Refunds that failed earlier and are due another go (every 15 minutes). Called from the sweep. The
// Payments page keeps showing the shop that one is outstanding until it lands.
export async function retryDepositRefunds(db: DB, now = Date.now()) {
  const due = await db.prepare("SELECT b.*, s.id AS _sid FROM bookings b JOIN shops s ON s.id=b.shop_id WHERE b.deposit_status='PAID' AND b.deposit_refund_retry_at IS NOT NULL AND b.deposit_refund_retry_at<? LIMIT 20").bind(now).all<StoredBooking & { _sid: string; deposit_refund_retry_at: number }>();
  let n = 0;
  for (const b of due.results) {
    const shop = await db.prepare("SELECT * FROM shops WHERE id=?").bind(b.shop_id).first<Shop>();
    if (!shop) continue;
    if (await refundDeposit(db, shop, b, "system", "automatic retry", b.deposit_refund_retry_at)) n++;
  }
  return n;
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
