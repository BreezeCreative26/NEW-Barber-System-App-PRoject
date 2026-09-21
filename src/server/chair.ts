// Card at the chair. Two ways, both charging the platform so the pay run treats them as card money:
//   LINK     — a Checkout session for the visit's amount; shown as a QR on the shop device and/or
//              texted to the customer. Works on any phone today, no hardware.
//   TERMINAL — a PaymentIntent handed to a Stripe Terminal reader (WisePOS, or Tap to Pay on the
//              barber's phone, which registers as a reader) via server-driven integration.
// When Stripe confirms, we write the ledger row exactly as a hand-recorded CARD tender would be,
// plus the Stripe refs and fees, and move the visit forward. Idempotent on the request id.
import type { Database as DB } from "../db/client";
import type { Shop, StoredBooking } from "./domain";
import { StripeError, chargeFee, platformFee, retrieveSession, stripeLive } from "./stripe";
import { platformPolicy } from "./payouts";

type Env = { STRIPE_SECRET_KEY?: string };
const env = (): Env => (typeof process !== "undefined" ? (process.env as Env) : {});
async function stripe<T>(path: string, body?: Record<string, string | number | boolean | undefined>, method?: "GET" | "POST" | "DELETE", opts: { idempotency?: string } = {}): Promise<T> {
  const key = env().STRIPE_SECRET_KEY;
  if (!key) throw new StripeError("Stripe is not configured", 503, "stripe_off");
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" };
  if (opts.idempotency) headers["Idempotency-Key"] = opts.idempotency;
  let url = `https://api.stripe.com/v1${path}`;
  let init: RequestInit = { method: method ?? (body ? "POST" : "GET"), headers };
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

export type PaymentRequest = {
  id: string; shop_id: string; booking_id: string; staff_id: string; kind: "LINK" | "TERMINAL";
  service_pence: number; tip_pence: number; discount_pence: number; complete: number; note: string;
  stripe_session_id: string; stripe_payment_intent: string; url: string;
  status: "OPEN" | "PAID" | "EXPIRED" | "CANCELLED"; payment_id: string | null; sent_to: string;
  created_by: string; created_at: number; expires_at: number; paid_at: number | null;
};
export const REQUEST_TTL_MIN = 30;

// ---- LINK / QR --------------------------------------------------------------------------------------------
export async function createLinkRequest(db: DB, shop: Shop, booking: StoredBooking, amounts: { service_pence: number; tip_pence: number; discount_pence: number; complete: boolean; note: string }, actor: string, origin: string) {
  if (!stripeLive()) throw new StripeError("Card payments are not switched on for foliyo yet", 409, "stripe_off");
  const total = amounts.service_pence + amounts.tip_pence;
  if (total <= 0) throw new StripeError("Nothing to charge", 400, "zero");
  const id = crypto.randomUUID();
  const now = Date.now();
  const expires = now + REQUEST_TTL_MIN * 60000;
  const ref = booking.id.slice(0, 6).toUpperCase();
  const body: Record<string, string | number> = {
    mode: "payment",
    "managed_payments[enabled]": "false", // foliyo is merchant of record (see stripe.ts)
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": (shop.currency || "GBP").toLowerCase(),
    "line_items[0][price_data][unit_amount]": amounts.service_pence,
    "line_items[0][price_data][product_data][name]": booking.service_name,
    "line_items[0][price_data][product_data][description]": `${shop.name} · ref ${ref}`,
    success_url: `${origin}/pay/${id}?done=1`,
    cancel_url: `${origin}/pay/${id}?done=0`,
    client_reference_id: booking.id,
    expires_at: Math.floor(expires / 1000) + 30 * 60, // Stripe minimum 30 min after creation
    "metadata[shop_id]": shop.id,
    "metadata[booking_id]": booking.id,
    "metadata[payment_request_id]": id,
    "payment_intent_data[metadata][shop_id]": shop.id,
    "payment_intent_data[metadata][booking_id]": booking.id,
    "payment_intent_data[metadata][payment_request_id]": id,
    "payment_intent_data[description]": `${shop.name} · ${booking.service_name} · ${booking.date}`,
  };
  if (amounts.tip_pence > 0) {
    body["line_items[1][quantity]"] = 1;
    body["line_items[1][price_data][currency]"] = (shop.currency || "GBP").toLowerCase();
    body["line_items[1][price_data][unit_amount]"] = amounts.tip_pence;
    body["line_items[1][price_data][product_data][name]"] = "Tip";
  }
  if (booking.email) body.customer_email = booking.email;
  const session = await stripe<{ id: string; url: string; payment_intent?: string | null }>("/checkout/sessions", body);
  await db
    .prepare("INSERT INTO payment_requests(id,shop_id,booking_id,staff_id,kind,service_pence,tip_pence,discount_pence,complete,note,stripe_session_id,stripe_payment_intent,url,status,created_by,created_at,expires_at) VALUES(?,?,?,?,'LINK',?,?,?,?,?,?,?,?,'OPEN',?,?,?)")
    .bind(id, shop.id, booking.id, booking.staff_id, amounts.service_pence, amounts.tip_pence, amounts.discount_pence, amounts.complete ? 1 : 0, amounts.note, session.id, typeof session.payment_intent === "string" ? session.payment_intent : "", session.url, actor, now, expires)
    .run();
  return (await db.prepare("SELECT * FROM payment_requests WHERE id=?").bind(id).first<PaymentRequest>())!;
}

// ---- TERMINAL --------------------------------------------------------------------------------------------
export async function ensureLocation(db: DB, shop: Shop) {
  if (shop.stripe_location_id) return shop.stripe_location_id;
  const loc = await stripe<{ id: string }>("/terminal/locations", {
    display_name: shop.name.slice(0, 100),
    "address[line1]": (shop.address || shop.name).slice(0, 100),
    "address[city]": "London",
    "address[country]": shop.currency === "GBP" ? "GB" : "GB",
    "address[postal_code]": "EC1A 1BB",
    "metadata[shop_id]": shop.id,
  });
  await db.prepare("UPDATE shops SET stripe_location_id=? WHERE id=? AND stripe_location_id=''").bind(loc.id, shop.id).run();
  return loc.id;
}
export async function registerReader(db: DB, shop: Shop, code: string, label: string) {
  const location = await ensureLocation(db, shop);
  const r = await stripe<{ id: string; label: string; device_type: string; status: string }>("/terminal/readers", { registration_code: code, label: label.slice(0, 60), location, "metadata[shop_id]": shop.id });
  const now = Date.now();
  await db.prepare("INSERT INTO terminal_readers(id,shop_id,label,device_type,location_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label, status=excluded.status, updated_at=excluded.updated_at")
    .bind(r.id, shop.id, r.label || label, r.device_type || "", location, r.status || "online", now, now).run();
  return r;
}
export async function listReaders(db: DB, shopId: string) {
  return (await db.prepare("SELECT * FROM terminal_readers WHERE shop_id=? ORDER BY created_at").bind(shopId).all<{ id: string; label: string; device_type: string; status: string }>()).results;
}
export async function refreshReader(db: DB, readerId: string) {
  const r = await stripe<{ id: string; status: string; device_type: string; label: string }>(`/terminal/readers/${encodeURIComponent(readerId)}`);
  await db.prepare("UPDATE terminal_readers SET status=?, device_type=?, label=?, updated_at=? WHERE id=?").bind(r.status || "offline", r.device_type || "", r.label || "", Date.now(), readerId).run();
  return r;
}
export async function removeReader(db: DB, shopId: string, readerId: string) {
  await stripe(`/terminal/readers/${encodeURIComponent(readerId)}`, undefined, "DELETE").catch(() => null);
  await db.prepare("DELETE FROM terminal_readers WHERE shop_id=? AND id=?").bind(shopId, readerId).run();
}
// Connection token for the Terminal JS SDK (Tap to Pay / browser-driven readers). Scoped to the shop's location.
export async function connectionToken(locationId: string) {
  return stripe<{ secret: string }>("/terminal/connection_tokens", locationId ? { location: locationId } : {});
}
// Create the intent and hand it to a reader. Reader shows the amount, customer taps.
export async function createTerminalRequest(db: DB, shop: Shop, booking: StoredBooking, readerId: string, amounts: { service_pence: number; tip_pence: number; discount_pence: number; complete: boolean; note: string }, actor: string) {
  if (!stripeLive()) throw new StripeError("Card payments are not switched on for foliyo yet", 409, "stripe_off");
  const total = amounts.service_pence + amounts.tip_pence;
  if (total <= 0) throw new StripeError("Nothing to charge", 400, "zero");
  const id = crypto.randomUUID();
  const now = Date.now();
  const pi = await stripe<{ id: string; client_secret: string }>("/payment_intents", {
    amount: total,
    currency: (shop.currency || "GBP").toLowerCase(),
    "payment_method_types[0]": "card_present",
    capture_method: "automatic",
    description: `${shop.name} · ${booking.service_name} · ${booking.date}`,
    "metadata[shop_id]": shop.id,
    "metadata[booking_id]": booking.id,
    "metadata[payment_request_id]": id,
  }, "POST", { idempotency: `terminal-${id}` });
  if (readerId !== "sdk") {
    await stripe(`/terminal/readers/${encodeURIComponent(readerId)}/process_payment_intent`, { payment_intent: pi.id, "process_config[skip_tipping]": true });
  }
  await db
    .prepare("INSERT INTO payment_requests(id,shop_id,booking_id,staff_id,kind,service_pence,tip_pence,discount_pence,complete,note,stripe_payment_intent,url,status,created_by,created_at,expires_at) VALUES(?,?,?,?,'TERMINAL',?,?,?,?,?,?,?,'OPEN',?,?,?)")
    .bind(id, shop.id, booking.id, booking.staff_id, amounts.service_pence, amounts.tip_pence, amounts.discount_pence, amounts.complete ? 1 : 0, amounts.note, pi.id, readerId, actor, now, now + 10 * 60000)
    .run();
  const row = (await db.prepare("SELECT * FROM payment_requests WHERE id=?").bind(id).first<PaymentRequest>())!;
  return { request: row, client_secret: pi.client_secret };
}
export async function cancelReaderAction(readerId: string) {
  return stripe(`/terminal/readers/${encodeURIComponent(readerId)}/cancel_action`, {}).catch(() => null);
}

// ---- Settling ------------------------------------------------------------------------------------------------
// Ask Stripe whether the request has been paid; if so write the ledger row. Returns the request.
export async function pollRequest(db: DB, req: PaymentRequest, actor: string) {
  if (req.status !== "OPEN") return req;
  if (req.kind === "LINK" && req.stripe_session_id) {
    const s = await retrieveSession(req.stripe_session_id).catch(() => null);
    if (s?.payment_status === "paid") return settleRequest(db, req, typeof s.payment_intent === "string" ? s.payment_intent : req.stripe_payment_intent, actor);
    if (s?.status === "expired") await db.prepare("UPDATE payment_requests SET status='EXPIRED' WHERE id=? AND status='OPEN'").bind(req.id).run();
  } else if (req.stripe_payment_intent) {
    const pi = await stripe<{ id: string; status: string }>(`/payment_intents/${encodeURIComponent(req.stripe_payment_intent)}`).catch(() => null);
    if (pi?.status === "succeeded") return settleRequest(db, req, pi.id, actor);
    if (pi?.status === "canceled") await db.prepare("UPDATE payment_requests SET status='CANCELLED' WHERE id=? AND status='OPEN'").bind(req.id).run();
  }
  if (req.expires_at < Date.now()) await db.prepare("UPDATE payment_requests SET status='EXPIRED' WHERE id=? AND status='OPEN'").bind(req.id).run();
  return (await db.prepare("SELECT * FROM payment_requests WHERE id=?").bind(req.id).first<PaymentRequest>())!;
}
// Write the ledger row for a paid request. Idempotent: claims the request row first.
export async function settleRequest(db: DB, req: PaymentRequest, paymentIntent: string, actor: string) {
  const now = Date.now();
  const claim = await db.prepare("UPDATE payment_requests SET status='PAID', paid_at=?, stripe_payment_intent=? WHERE id=? AND status='OPEN'").bind(now, paymentIntent, req.id).run();
  if (!claim.meta.changes) return (await db.prepare("SELECT * FROM payment_requests WHERE id=?").bind(req.id).first<PaymentRequest>())!;
  const shop = await db.prepare("SELECT * FROM shops WHERE id=?").bind(req.shop_id).first<Shop>();
  const b = await db.prepare("SELECT * FROM bookings WHERE shop_id=? AND id=?").bind(req.shop_id, req.booking_id).first<StoredBooking>();
  const staff = await db.prepare("SELECT commission_pct FROM staff WHERE shop_id=? AND id=?").bind(req.shop_id, req.staff_id).first<{ commission_pct: number }>();
  if (!shop || !b) return req;
  const fee = await chargeFee(paymentIntent).catch(() => ({ charge: "", fee_pence: 0 }));
  const policy = await platformPolicy(db);
  const pid = crypto.randomUUID();
  const today = new Date(now).toLocaleDateString("en-CA", { timeZone: shop.timezone });
  const stmts = [];
  // Ledger trigger needs the visit to be in service.
  if (["CONFIRMED", "CHECKED_IN"].includes(b.status)) stmts.push(db.prepare("UPDATE bookings SET status='IN_SERVICE', version=version+1, updated_at=? WHERE shop_id=? AND id=? AND status IN ('CONFIRMED','CHECKED_IN')").bind(now, shop.id, b.id));
  stmts.push(
    db.prepare(
      "INSERT INTO payments(id,shop_id,booking_id,staff_id,customer_id,date,method,service_pence,tip_pence,discount_pence,commission_pct,note,recorded_by,created_at,stripe_payment_intent,stripe_charge,stripe_fee_pence,platform_fee_pence) VALUES(?,?,?,?,?,?,'CARD',?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(pid, shop.id, b.id, req.staff_id, b.customer_id, today, req.service_pence, req.tip_pence, req.discount_pence, staff?.commission_pct ?? 50, req.note || (req.kind === "LINK" ? "Paid by card via link" : "Paid by card at the chair"), actor, now, paymentIntent, fee.charge, fee.fee_pence, platformFee(req.service_pence + req.tip_pence, policy)),
  );
  stmts.push(db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), shop.id, "payment", pid, "PAYMENT_RECORDED", actor, `CARD ${req.service_pence}p service + ${req.tip_pence}p tip via ${req.kind === "LINK" ? "pay link" : "reader"} (${paymentIntent})`, now));
  if (req.complete) {
    stmts.push(db.prepare("UPDATE bookings SET status='COMPLETED', version=version+1, updated_at=? WHERE shop_id=? AND id=? AND status<>'COMPLETED' AND status<>'CANCELLED'").bind(now, shop.id, b.id));
    stmts.push(db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), shop.id, "booking", b.id, "COMPLETED", actor, "Checked out; card payment confirmed by Stripe.", now));
  }
  stmts.push(db.prepare("UPDATE payment_requests SET payment_id=? WHERE id=?").bind(pid, req.id));
  await db.batch(stmts);
  return (await db.prepare("SELECT * FROM payment_requests WHERE id=?").bind(req.id).first<PaymentRequest>())!;
}
// Webhook path: a Checkout session / PaymentIntent with payment_request_id metadata succeeded.
export async function settleByMetadata(db: DB, requestId: string, paymentIntent: string) {
  const req = await db.prepare("SELECT * FROM payment_requests WHERE id=?").bind(requestId).first<PaymentRequest>();
  if (!req) return null;
  return settleRequest(db, req, paymentIntent, "stripe");
}
export async function expireRequests(db: DB, now = Date.now()) {
  const r = await db.prepare("UPDATE payment_requests SET status='EXPIRED' WHERE status='OPEN' AND expires_at<?").bind(now).run();
  return r.meta.changes;
}
