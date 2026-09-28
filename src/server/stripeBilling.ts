// foliyo ↔ shop subscription billing on Stripe.
//
// Local tables stay the ledger (invoices, usage_events, shop_subscriptions); Stripe is the collector:
//   1. The owner adds a card once (Checkout in setup mode) → Stripe customer + default payment method
//      saved on shop_subscriptions.stripe_customer_id. Trial → ACTIVE when the trial ends.
//   2. At month close, every local PERIOD invoice is mirrored to a Stripe invoice with the same lines
//      (plan, seats, add-ons, each metered unit total) and finalised with automatic collection, so
//      the saved card is charged on the due date. stripe_invoice_id / hosted_url / pdf_url are stored.
//   3. Webhooks (invoice.paid / invoice.payment_failed) mark the local invoice paid or the shop past due.
// With no STRIPE_SECRET_KEY nothing here runs; invoices are still issued locally and paid by hand.
import type { Database as DB } from "../db/client";
import { logBilling, platformBilling, subscriptionFor } from "./billing";
import { markPaid, type InvoiceLine, type InvoiceRow } from "./invoicing";

type Env = { STRIPE_SECRET_KEY?: string; APP_ORIGIN?: string };
const env = (): Env => (typeof process !== "undefined" ? (process.env as Env) : {});
export const billingLive = () => !!env().STRIPE_SECRET_KEY;

class StripeError extends Error {
  constructor(message: string, public status = 500, public code = "") { super(message); }
}
async function stripe<T>(path: string, body?: Record<string, string | number | boolean | undefined>, opts: { method?: "GET" | "POST"; idempotency?: string } = {}): Promise<T> {
  const key = env().STRIPE_SECRET_KEY;
  if (!key) throw new StripeError("Stripe is not configured", 503, "stripe_off");
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" };
  if (opts.idempotency) headers["Idempotency-Key"] = opts.idempotency;
  let url = `https://api.stripe.com/v1${path}`;
  let init: RequestInit = { method: opts.method ?? (body ? "POST" : "GET"), headers };
  if (body) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v !== undefined) form.set(k, String(v));
    if (init.method === "GET") url += `?${form}`;
    else { headers["Content-Type"] = "application/x-www-form-urlencoded"; init = { ...init, body: form.toString() }; }
  }
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } } & T;
  if (!res.ok) throw new StripeError(json.error?.message || `Stripe ${res.status}`, res.status, json.error?.code || "");
  return json;
}

// ---- Customer + card -----------------------------------------------------------------------------
export async function ensureCustomer(db: DB, shopId: string): Promise<string> {
  const sub = await subscriptionFor(db, shopId);
  if (sub.stripe_customer_id) return sub.stripe_customer_id;
  const shop = await db.prepare("SELECT name, email, address FROM shops WHERE id=?").bind(shopId).first<{ name: string; email: string; address: string }>();
  const owner = await db.prepare("SELECT u.name, u.email FROM app_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.shop_id=? AND m.role='OWNER' AND m.active=1 LIMIT 1").bind(shopId).first<{ name: string; email: string }>();
  const c = await stripe<{ id: string }>("/customers", {
    name: sub.billing_name || shop?.name || "",
    email: sub.billing_email || owner?.email || shop?.email || undefined,
    description: `foliyo shop ${shopId}`,
    "metadata[shop_id]": shopId,
  }, { idempotency: `cust-${shopId}` });
  await db.prepare("UPDATE shop_subscriptions SET stripe_customer_id=?, version=version+1, updated_at=? WHERE shop_id=?").bind(c.id, Date.now(), shopId).run();
  return c.id;
}

/** Checkout (setup mode): the owner saves a card; nothing is charged now. */
export async function cardSetupSession(db: DB, shopId: string, origin: string) {
  const customer = await ensureCustomer(db, shopId);
  const s = await stripe<{ id: string; url: string }>("/checkout/sessions", {
    mode: "setup",
    customer,
    "payment_method_types[0]": "card",
    "payment_method_types[1]": "bacs_debit",
    success_url: `${origin}/workspace?billing=card-saved`,
    cancel_url: `${origin}/workspace?billing=card-cancelled`,
    "metadata[shop_id]": shopId,
    "metadata[purpose]": "billing_card",
  });
  return s;
}

/** After setup completes: make the new payment method the customer's default for invoices. */
export async function cardSaved(db: DB, shopId: string, setupIntentId: string) {
  const si = await stripe<{ payment_method?: string; customer?: string }>(`/setup_intents/${encodeURIComponent(setupIntentId)}`);
  if (!si.payment_method || !si.customer) return false;
  await stripe(`/customers/${si.customer}`, { "invoice_settings[default_payment_method]": si.payment_method });
  const pm = await stripe<{ type: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number }; bacs_debit?: { last4: string } }>(`/payment_methods/${si.payment_method}`);
  const label = pm.card ? `${pm.card.brand} •••• ${pm.card.last4} (exp ${String(pm.card.exp_month).padStart(2, "0")}/${pm.card.exp_year})` : pm.bacs_debit ? `Direct Debit •••• ${pm.bacs_debit.last4}` : pm.type;
  const now = Date.now();
  // A saved card converts a trial into an active subscription at trial end; already-active shops just get a new card.
  await db.prepare("UPDATE shop_subscriptions SET status=CASE WHEN status='TRIAL' AND (trial_ends_at IS NULL OR trial_ends_at<=?) THEN 'ACTIVE' WHEN status='PAST_DUE' THEN 'ACTIVE' ELSE status END, past_due_since=NULL, version=version+1, updated_at=? WHERE shop_id=?").bind(now, now, shopId).run();
  await logBilling(db, shopId, "CARD_SAVED", `Payment method saved · ${label}. Invoices are charged automatically on the due date.`, "owner", { payment_method: si.payment_method });
  return true;
}

export async function paymentMethodSummary(db: DB, shopId: string): Promise<{ label: string } | null> {
  if (!billingLive()) return null;
  const sub = await subscriptionFor(db, shopId);
  if (!sub.stripe_customer_id) return null;
  const c = await stripe<{ invoice_settings?: { default_payment_method?: string | null } }>(`/customers/${sub.stripe_customer_id}`).catch(() => null);
  const pmId = c?.invoice_settings?.default_payment_method;
  if (!pmId) return null;
  const pm = await stripe<{ type: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number }; bacs_debit?: { last4: string } }>(`/payment_methods/${pmId}`).catch(() => null);
  if (!pm) return null;
  return { label: pm.card ? `${pm.card.brand[0].toUpperCase()}${pm.card.brand.slice(1)} •••• ${pm.card.last4} · exp ${String(pm.card.exp_month).padStart(2, "0")}/${String(pm.card.exp_year).slice(-2)}` : pm.bacs_debit ? `Direct Debit •••• ${pm.bacs_debit.last4}` : pm.type };
}

/** Stripe's customer portal: update card, see Stripe-side receipts. */
export async function portalSession(db: DB, shopId: string, origin: string) {
  const customer = await ensureCustomer(db, shopId);
  return stripe<{ url: string }>("/billing_portal/sessions", { customer, return_url: `${origin}/workspace` });
}

// ---- Invoices ------------------------------------------------------------------------------------
/** Mirror a local OPEN invoice to Stripe and let Stripe collect it. Idempotent per invoice. */
export async function pushInvoice(db: DB, inv: InvoiceRow): Promise<{ stripe_invoice_id: string; hosted_url: string; pdf_url: string } | null> {
  if (!billingLive() || inv.status !== "OPEN" || inv.kind === "CREDIT_NOTE" || inv.total_pence <= 0) return null;
  if (inv.stripe_invoice_id) return { stripe_invoice_id: inv.stripe_invoice_id, hosted_url: inv.hosted_url, pdf_url: inv.pdf_url };
  const customer = await ensureCustomer(db, inv.shop_id);
  const pb = await platformBilling(db);
  const dueDays = Math.max(1, Math.round(((inv.due_at ?? Date.now()) - Date.now()) / 86400000)) || pb.due_days;
  const lines = JSON.parse(inv.lines_json || "[]") as InvoiceLine[];
  // Draft invoice first so the items attach to it (not to the next automatic invoice).
  const draft = await stripe<{ id: string }>("/invoices", {
    customer,
    collection_method: "charge_automatically",
    auto_advance: true,
    currency: (inv.currency || "GBP").toLowerCase(),
    description: `foliyo · ${inv.period_key ? new Date(inv.period_start).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : inv.number}`,
    "metadata[shop_id]": inv.shop_id,
    "metadata[invoice_id]": inv.id,
    "metadata[number]": inv.number,
    footer: pb.invoice_footer || undefined,
    days_until_due: undefined,
  }, { idempotency: `inv-${inv.id}` });
  let i = 0;
  for (const l of lines) {
    if (!l.amount_pence) continue;
    await stripe("/invoiceitems", { customer, invoice: draft.id, currency: (inv.currency || "GBP").toLowerCase(), amount: l.amount_pence, description: l.detail ? `${l.label} — ${l.detail}` : l.label }, { idempotency: `invitem-${inv.id}-${i++}` });
  }
  if (inv.discount_pence) await stripe("/invoiceitems", { customer, invoice: draft.id, currency: (inv.currency || "GBP").toLowerCase(), amount: -inv.discount_pence, description: "Discount" }, { idempotency: `invitem-${inv.id}-disc` });
  if (inv.credit_applied_pence) await stripe("/invoiceitems", { customer, invoice: draft.id, currency: (inv.currency || "GBP").toLowerCase(), amount: -inv.credit_applied_pence, description: "Account credit applied" }, { idempotency: `invitem-${inv.id}-credit` });
  if (inv.tax_pence) await stripe("/invoiceitems", { customer, invoice: draft.id, currency: (inv.currency || "GBP").toLowerCase(), amount: inv.tax_pence, description: "VAT 20%" }, { idempotency: `invitem-${inv.id}-vat` });
  const fin = await stripe<{ id: string; hosted_invoice_url?: string; invoice_pdf?: string; status: string }>(`/invoices/${draft.id}/finalize_invoice`, { auto_advance: true }, { idempotency: `invfin-${inv.id}` });
  void dueDays;
  await db.prepare("UPDATE invoices SET stripe_invoice_id=?, hosted_url=?, pdf_url=?, updated_at=? WHERE id=?").bind(fin.id, fin.hosted_invoice_url || "", fin.invoice_pdf || "", Date.now(), inv.id).run();
  await logBilling(db, inv.shop_id, "INVOICE_SENT_STRIPE", `${inv.number} handed to Stripe for collection`, "system", { stripe_invoice_id: fin.id });
  return { stripe_invoice_id: fin.id, hosted_url: fin.hosted_invoice_url || "", pdf_url: fin.invoice_pdf || "" };
}

/** Webhook side: Stripe says an invoice was paid / failed. */
export async function applyInvoiceEvent(db: DB, type: string, obj: { id: string; metadata?: Record<string, string>; amount_paid?: number; charge?: string | null; payment_intent?: string | null; hosted_invoice_url?: string; invoice_pdf?: string }) {
  const localId = obj.metadata?.invoice_id;
  const inv = localId
    ? await db.prepare("SELECT * FROM invoices WHERE id=?").bind(localId).first<InvoiceRow>()
    : await db.prepare("SELECT * FROM invoices WHERE stripe_invoice_id=?").bind(obj.id).first<InvoiceRow>();
  if (!inv) return "unknown";
  if (type === "invoice.paid") {
    if (inv.status !== "PAID") await markPaid(db, inv.id, obj.amount_paid ?? null, "stripe", (typeof obj.payment_intent === "string" && obj.payment_intent) || (typeof obj.charge === "string" && obj.charge) || obj.id, "stripe");
    if (obj.invoice_pdf) await db.prepare("UPDATE invoices SET pdf_url=?, hosted_url=COALESCE(NULLIF(?, ''), hosted_url) WHERE id=?").bind(obj.invoice_pdf, obj.hosted_invoice_url || "", inv.id).run();
    return "paid";
  }
  if (type === "invoice.payment_failed") {
    const now = Date.now();
    await db.prepare("UPDATE shop_subscriptions SET status='PAST_DUE', past_due_since=COALESCE(past_due_since, ?), version=version+1, updated_at=? WHERE shop_id=? AND status IN ('ACTIVE','PAST_DUE')").bind(now, now, inv.shop_id).run();
    await logBilling(db, inv.shop_id, "PAYMENT_FAILED", `Payment for ${inv.number} failed — Stripe will retry; update the card under Settings → Billing.`, "stripe", { stripe_invoice_id: obj.id });
    return "failed";
  }
  return "ignored";
}
