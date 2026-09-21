// OLLO → shop invoicing that works with or without Stripe.
//
// Period invoices: one per shop per calendar month, built from the same `estimate()` the Billing
// tab shows (plan, seats, add-ons, metered usage, discounts), plus any pending credits / charges.
// Unused credit carries forward. Manual invoices and credit notes are issued by finance admins.
// Payment is recorded by Stripe (webhook, when connected) or by hand (bank transfer / offline).
// Every invoice has a printable HTML copy reachable by a per-invoice token so it can be emailed.
import type { Database as DB } from "../db/client";
import { estimate, logBilling, platformBilling, subscriptionFor, type PlatformBilling } from "./billing";
import { enqueue, drain, msgShop } from "./messaging";

const uid = () => crypto.randomUUID();
const DAY = 86400000;
export const money = (p: number) => `${p < 0 ? "−" : ""}£${(Math.abs(p) / 100).toFixed(2)}`;

export type InvoiceLine = { label: string; detail?: string; quantity?: number; unit_pence?: number; amount_pence: number };
export type InvoiceRow = {
  id: string; shop_id: string; stripe_invoice_id: string; number: string; status: "DRAFT" | "OPEN" | "PAID" | "VOID" | "UNCOLLECTIBLE";
  kind: "PERIOD" | "MANUAL" | "CREDIT_NOTE"; credit_note_for: string | null; period_key: string; period_start: number; period_end: number;
  subtotal_pence: number; discount_pence: number; tax_pence: number; total_pence: number; paid_pence: number; credit_applied_pence: number; currency: string;
  hosted_url: string; pdf_url: string; due_at: number | null; paid_at: number | null; paid_via: string; paid_ref: string; issued_at: number | null; issued_by: string;
  sent_at: number | null; sent_to: string; voided_at: number | null; void_reason: string; note: string; lines_json: string; bill_to_json: string; view_token: string; created_at: number; updated_at: number;
};

// Month bounds for a period key like "2026-09" (UTC).
export function periodBounds(key: string) {
  const [y, m] = key.split("-").map(Number);
  return { start: Date.UTC(y, m - 1, 1), end: Date.UTC(y, m, 1) - 1 };
}
export const prevPeriodKey = (ts = Date.now()) => { const d = new Date(ts); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7); };

async function nextNumber(db: DB, pb: PlatformBilling, kind: "invoice" | "credit_note") {
  const row = await db.prepare("UPDATE invoice_counters SET next=next+1 WHERE key=? RETURNING next-1 AS n").bind(kind).first<{ n: number }>();
  const n = row?.n ?? 1;
  return kind === "invoice" ? `${pb.invoice_prefix}${n}` : `${pb.invoice_prefix}CN-${String(n).padStart(4, "0")}`;
}

async function billTo(db: DB, shopId: string) {
  const sub = await subscriptionFor(db, shopId);
  const shop = await db.prepare("SELECT name, address FROM shops WHERE id=?").bind(shopId).first<{ name: string; address: string }>();
  const owner = await db.prepare("SELECT u.name, u.email FROM app_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.shop_id=? AND m.role='OWNER' AND m.active=1 LIMIT 1").bind(shopId).first<{ name: string; email: string }>();
  return { name: sub.billing_name || shop?.name || "", email: sub.billing_email || owner?.email || "", address: (() => { try { const a = JSON.parse(sub.address_json || "{}"); return typeof a.line1 === "string" ? [a.line1, a.line2, a.city, a.postcode].filter(Boolean).join(", ") : shop?.address || ""; } catch { return shop?.address || ""; } })(), shop: shop?.name || "", owner: owner?.name || "" };
}

// Pending credits/charges not yet on an invoice, oldest first.
async function pendingAdjustments(db: DB, shopId: string) {
  return (await db.prepare("SELECT * FROM invoice_adjustments WHERE shop_id=? AND invoice_id IS NULL AND kind IN ('CREDIT','CHARGE') ORDER BY created_at").bind(shopId).all<{ id: string; kind: "CREDIT" | "CHARGE"; amount_pence: number; reason: string }>()).results;
}

export type IssueResult = { invoice: InvoiceRow; skipped?: string };

// Close a shop's period: build the invoice from the estimate + pending adjustments. Idempotent per
// (shop, period). Trials and cancelled shops with nothing to bill are skipped.
export async function issuePeriodInvoice(db: DB, shopId: string, periodKey: string, actor: string, opts: { force?: boolean } = {}): Promise<IssueResult | { skipped: string }> {
  const existing = await db.prepare("SELECT * FROM invoices WHERE shop_id=? AND period_key=? AND kind='PERIOD' AND status<>'VOID'").bind(shopId, periodKey).first<InvoiceRow>();
  if (existing) return { invoice: existing, skipped: "already issued" };
  const sub = await subscriptionFor(db, shopId);
  const { start, end } = periodBounds(periodKey);
  const now = Date.now();
  // Only bill periods in which the shop was paying (ACTIVE / PAST_DUE at any point). Trials convert on
  // their first paid period; cancelled/paused shops are billed only for what they used before.
  const paying = sub.status === "ACTIVE" || sub.status === "PAST_DUE" || (sub.status === "CANCELLED" && sub.cancel_at && sub.cancel_at > start);
  if (!paying && !opts.force) return { skipped: sub.status === "TRIAL" ? "on trial" : `subscription ${sub.status.toLowerCase()}` };
  const est = await estimate(db, shopId, periodKey);
  const lines: InvoiceLine[] = est.lines.map((l) => ({ label: l.label, detail: l.detail, amount_pence: l.amount_pence }));
  const adj = await pendingAdjustments(db, shopId);
  for (const a of adj.filter((x) => x.kind === "CHARGE")) lines.push({ label: a.reason, detail: "one-off charge", amount_pence: a.amount_pence });
  const subtotal = lines.reduce((n, l) => n + l.amount_pence, 0);
  const discount = Math.min(est.discount_pence, subtotal);
  const pb = await platformBilling(db);
  const taxable = subtotal - discount;
  const tax = pb.vat_mode === "UK_20" ? Math.round(taxable * 0.2) : 0;
  const gross = taxable + tax;
  const creditAvail = adj.filter((x) => x.kind === "CREDIT").reduce((n, a) => n + a.amount_pence, 0);
  const creditApplied = Math.min(creditAvail, gross);
  const total = gross - creditApplied;
  if (subtotal === 0 && creditApplied === 0 && !opts.force) return { skipped: "nothing to bill" };
  const id = uid();
  const number = await nextNumber(db, pb, "invoice");
  const status = total === 0 ? "PAID" : "OPEN";
  const bt = await billTo(db, shopId);
  const token = uid().replace(/-/g, "") + uid().replace(/-/g, "");
  await db.prepare(
    "INSERT INTO invoices(id,shop_id,number,status,kind,period_key,period_start,period_end,subtotal_pence,discount_pence,tax_pence,total_pence,paid_pence,credit_applied_pence,currency,due_at,paid_at,paid_via,issued_at,issued_by,lines_json,bill_to_json,view_token,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(id, shopId, number, status, "PERIOD", periodKey, start, end, subtotal, discount, tax, total, status === "PAID" ? 0 : 0, creditApplied, "GBP", now + pb.due_days * DAY, status === "PAID" ? now : null, status === "PAID" ? "credit" : "", now, actor, JSON.stringify(lines), JSON.stringify(bt), token, est.discounts.length ? `Discount: ${est.discounts.map((d) => d.code).join(", ")}` : "", now, now).run();
  // Stamp the adjustments we consumed. Credit is consumed oldest-first; a partially used credit is
  // split so the remainder carries forward.
  let remaining = creditApplied;
  for (const a of adj) {
    if (a.kind === "CHARGE") { await db.prepare("UPDATE invoice_adjustments SET invoice_id=?, applied_at=? WHERE id=?").bind(id, now, a.id).run(); continue; }
    if (remaining <= 0) break;
    if (a.amount_pence <= remaining) { await db.prepare("UPDATE invoice_adjustments SET invoice_id=?, applied_at=? WHERE id=?").bind(id, now, a.id).run(); remaining -= a.amount_pence; }
    else {
      await db.prepare("UPDATE invoice_adjustments SET amount_pence=?, invoice_id=?, applied_at=? WHERE id=?").bind(remaining, id, now, a.id).run();
      await db.prepare("INSERT INTO invoice_adjustments(id,shop_id,kind,amount_pence,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?)").bind(uid(), shopId, "CREDIT", a.amount_pence - remaining, `${a.reason} (carried forward)`, "system", now).run();
      remaining = 0;
    }
  }
  await db.prepare("UPDATE shop_subscriptions SET current_period_start=?, current_period_end=?, updated_at=? WHERE shop_id=?").bind(end + 1, new Date(end + 1 + 32 * DAY).setUTCDate(1) - 1, now, shopId).run();
  await logBilling(db, shopId, "INVOICE_ISSUED", `Invoice ${number} issued · ${money(total)}${creditApplied ? ` (${money(creditApplied)} credit applied)` : ""}${status === "PAID" ? " · settled by credit" : ` · due ${new Date(now + pb.due_days * DAY).toLocaleDateString("en-GB")}`}`, actor, { invoice_id: id });
  const invoice = (await db.prepare("SELECT * FROM invoices WHERE id=?").bind(id).first<InvoiceRow>())!;
  return { invoice };
}

// Run the month close for every shop (idempotent). Called from admin "Run period close" and lazily
// from the first admin request each month. Returns a summary for the UI.
export async function runPeriodClose(db: DB, periodKey: string, actor: string) {
  const shops = (await db.prepare("SELECT s.id, s.name FROM shops s JOIN shop_subscriptions ss ON ss.shop_id=s.id WHERE s.suspended_at IS NULL AND ss.status IN ('ACTIVE','PAST_DUE','CANCELLED') ORDER BY s.name").all<{ id: string; name: string }>()).results;
  const out = { period: periodKey, issued: [] as { shop: string; number: string; total_pence: number }[], skipped: [] as { shop: string; why: string }[], errors: [] as { shop: string; error: string }[] };
  for (const s of shops) {
    try {
      const r = await issuePeriodInvoice(db, s.id, periodKey, actor);
      if ("invoice" in r && !r.skipped) out.issued.push({ shop: s.name, number: r.invoice.number, total_pence: r.invoice.total_pence });
      else out.skipped.push({ shop: s.name, why: ("skipped" in r && r.skipped) || "already issued" });
    } catch (e) { out.errors.push({ shop: s.name, error: (e as Error).message }); }
  }
  await db.prepare("UPDATE platform_billing SET last_period_close=?, updated_at=? WHERE id=1").bind(periodKey, Date.now()).run();
  // Send the new invoices to billing contacts.
  for (const i of out.issued) { const row = await db.prepare("SELECT * FROM invoices WHERE number=?").bind(i.number).first<InvoiceRow>(); if (row && row.status === "OPEN") await sendInvoice(db, row, "", actor).catch(() => {}); }
  return out;
}

// Manual invoice with free-form lines (setup fee, hardware, consultancy, corrections).
export async function issueManualInvoice(db: DB, shopId: string, lines: InvoiceLine[], actor: string, note = "", dueDays?: number) {
  const pb = await platformBilling(db);
  const now = Date.now();
  const subtotal = lines.reduce((n, l) => n + l.amount_pence, 0);
  const tax = pb.vat_mode === "UK_20" ? Math.round(subtotal * 0.2) : 0;
  const id = uid();
  const number = await nextNumber(db, pb, "invoice");
  const bt = await billTo(db, shopId);
  const token = uid().replace(/-/g, "") + uid().replace(/-/g, "");
  await db.prepare(
    "INSERT INTO invoices(id,shop_id,number,status,kind,period_key,period_start,period_end,subtotal_pence,discount_pence,tax_pence,total_pence,paid_pence,currency,due_at,issued_at,issued_by,lines_json,bill_to_json,view_token,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(id, shopId, number, "OPEN", "MANUAL", "", now, now, subtotal, 0, tax, subtotal + tax, 0, "GBP", now + (dueDays ?? pb.due_days) * DAY, now, actor, JSON.stringify(lines), JSON.stringify(bt), token, note, now, now).run();
  await logBilling(db, shopId, "INVOICE_ISSUED", `Invoice ${number} issued · ${money(subtotal + tax)}${note ? ` — ${note}` : ""}`, actor, { invoice_id: id });
  return (await db.prepare("SELECT * FROM invoices WHERE id=?").bind(id).first<InvoiceRow>())!;
}

// Credit note against an invoice: reduces what is owed (OPEN) or creates a refundable credit (PAID).
export async function issueCreditNote(db: DB, invoiceId: string, amountPence: number, reason: string, actor: string, refund?: { via: string; ref: string }) {
  const inv = await db.prepare("SELECT * FROM invoices WHERE id=?").bind(invoiceId).first<InvoiceRow>();
  if (!inv) throw new Error("Invoice not found");
  if (inv.kind === "CREDIT_NOTE") throw new Error("Cannot credit a credit note");
  if (inv.status === "VOID") throw new Error("Invoice is void");
  const already = (await db.prepare("SELECT COALESCE(SUM(total_pence),0)::int AS n FROM invoices WHERE credit_note_for=? AND status<>'VOID'").bind(invoiceId).first<{ n: number }>())?.n ?? 0;
  if (amountPence <= 0 || amountPence > inv.total_pence - already) throw new Error(`Credit must be between £0.01 and ${money(inv.total_pence - already)}`);
  const pb = await platformBilling(db);
  const now = Date.now();
  const id = uid();
  const number = await nextNumber(db, pb, "credit_note");
  const token = uid().replace(/-/g, "") + uid().replace(/-/g, "");
  await db.prepare(
    "INSERT INTO invoices(id,shop_id,number,status,kind,credit_note_for,period_key,period_start,period_end,subtotal_pence,discount_pence,tax_pence,total_pence,paid_pence,currency,due_at,paid_at,issued_at,issued_by,lines_json,bill_to_json,view_token,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(id, inv.shop_id, number, "PAID", "CREDIT_NOTE", invoiceId, inv.period_key, inv.period_start, inv.period_end, -amountPence, 0, 0, -amountPence, 0, "GBP", null, now, now, actor, JSON.stringify([{ label: `Credit against ${inv.number}`, detail: reason, amount_pence: -amountPence }]), inv.bill_to_json, token, reason, now, now).run();
  let outcome = "";
  if (inv.status === "OPEN" || inv.status === "UNCOLLECTIBLE") {
    // Reduce the balance owed on the original invoice.
    const newTotal = inv.total_pence - amountPence;
    const settled = newTotal <= inv.paid_pence;
    await db.prepare("UPDATE invoices SET total_pence=?, status=?, paid_at=COALESCE(paid_at, ?), paid_via=CASE WHEN ?=1 AND paid_via='' THEN 'credit' ELSE paid_via END, updated_at=? WHERE id=?").bind(newTotal, settled ? "PAID" : inv.status, settled ? now : null, settled ? 1 : 0, now, invoiceId).run();
    outcome = settled ? `${inv.number} now settled` : `${inv.number} balance now ${money(newTotal - inv.paid_pence)}`;
  } else if (refund) {
    await db.prepare("INSERT INTO invoice_adjustments(id,shop_id,invoice_id,kind,amount_pence,reason,created_by,refund_via,refund_ref,applied_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(uid(), inv.shop_id, invoiceId, "REFUND", amountPence, reason, actor, refund.via, refund.ref, now, now).run();
    outcome = `refunded ${money(amountPence)} via ${refund.via}`;
  } else {
    // Paid invoice, no refund: carry the credit to the next invoice.
    await db.prepare("INSERT INTO invoice_adjustments(id,shop_id,kind,amount_pence,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?)").bind(uid(), inv.shop_id, "CREDIT", amountPence, `Credit note ${number}: ${reason}`, actor, now).run();
    outcome = "credit carried to next invoice";
  }
  await logBilling(db, inv.shop_id, "CREDIT_NOTE", `Credit note ${number} · ${money(amountPence)} against ${inv.number} — ${reason} · ${outcome}`, actor, { invoice_id: id, against: invoiceId });
  return (await db.prepare("SELECT * FROM invoices WHERE id=?").bind(id).first<InvoiceRow>())!;
}

export async function markPaid(db: DB, invoiceId: string, amountPence: number | null, via: string, ref: string, actor: string) {
  const inv = await db.prepare("SELECT * FROM invoices WHERE id=?").bind(invoiceId).first<InvoiceRow>();
  if (!inv) throw new Error("Invoice not found");
  if (inv.status === "VOID" || inv.kind === "CREDIT_NOTE") throw new Error("This invoice cannot be paid");
  const now = Date.now();
  const paid = Math.min(inv.total_pence, inv.paid_pence + (amountPence ?? inv.total_pence - inv.paid_pence));
  const full = paid >= inv.total_pence;
  await db.prepare("UPDATE invoices SET paid_pence=?, status=?, paid_at=CASE WHEN ?=1 THEN ? ELSE paid_at END, paid_via=?, paid_ref=?, updated_at=? WHERE id=?").bind(paid, full ? "PAID" : inv.status, full ? 1 : 0, now, via, ref, now, invoiceId).run();
  if (full) {
    // Paying clears overdue.
    const open = (await db.prepare("SELECT COUNT(*)::int AS n FROM invoices WHERE shop_id=? AND status IN ('OPEN','UNCOLLECTIBLE') AND kind<>'CREDIT_NOTE' AND id<>?").bind(inv.shop_id, invoiceId).first<{ n: number }>())?.n ?? 0;
    if (open === 0) await db.prepare("UPDATE shop_subscriptions SET status=CASE WHEN status='PAST_DUE' THEN 'ACTIVE' ELSE status END, past_due_since=NULL, version=version+1, updated_at=? WHERE shop_id=?").bind(now, inv.shop_id).run();
  }
  await logBilling(db, inv.shop_id, "INVOICE_PAID", `${inv.number} ${full ? "paid" : `part-paid ${money(paid - inv.paid_pence)}`} via ${via}${ref ? ` (${ref})` : ""}`, actor, { invoice_id: invoiceId });
  return (await db.prepare("SELECT * FROM invoices WHERE id=?").bind(invoiceId).first<InvoiceRow>())!;
}

export async function voidInvoice(db: DB, invoiceId: string, reason: string, actor: string) {
  const inv = await db.prepare("SELECT * FROM invoices WHERE id=?").bind(invoiceId).first<InvoiceRow>();
  if (!inv) throw new Error("Invoice not found");
  if (inv.status === "PAID" && inv.paid_pence > 0) throw new Error("A paid invoice cannot be voided — issue a credit note instead");
  const now = Date.now();
  await db.prepare("UPDATE invoices SET status='VOID', voided_at=?, void_reason=?, updated_at=? WHERE id=?").bind(now, reason, now, invoiceId).run();
  // Release adjustments consumed by this invoice so they land on the next one.
  await db.prepare("UPDATE invoice_adjustments SET invoice_id=NULL, applied_at=NULL WHERE invoice_id=? AND kind IN ('CREDIT','CHARGE')").bind(invoiceId).run();
  await logBilling(db, inv.shop_id, "INVOICE_VOID", `${inv.number} voided — ${reason}`, actor, { invoice_id: invoiceId });
  return (await db.prepare("SELECT * FROM invoices WHERE id=?").bind(invoiceId).first<InvoiceRow>())!;
}

export async function markUncollectible(db: DB, invoiceId: string, reason: string, actor: string) {
  const inv = await db.prepare("SELECT * FROM invoices WHERE id=?").bind(invoiceId).first<InvoiceRow>();
  if (!inv || inv.status !== "OPEN") throw new Error("Only open invoices can be written off");
  const now = Date.now();
  await db.prepare("UPDATE invoices SET status='UNCOLLECTIBLE', updated_at=? WHERE id=?").bind(now, invoiceId).run();
  await logBilling(db, inv.shop_id, "INVOICE_WRITTEN_OFF", `${inv.number} written off — ${reason}`, actor, { invoice_id: invoiceId });
  return (await db.prepare("SELECT * FROM invoices WHERE id=?").bind(invoiceId).first<InvoiceRow>())!;
}

// Email the invoice (link to the printable copy) to the billing contact, or an override address.
export async function sendInvoice(db: DB, inv: InvoiceRow, toOverride: string, actor: string, origin = process.env.APP_ORIGIN || process.env.PUBLIC_ORIGIN || "https://new-barber-system-app-p-roject.vercel.app") {
  const bt = JSON.parse(inv.bill_to_json || "{}") as { name?: string; email?: string; owner?: string };
  const to = toOverride || bt.email || "";
  if (!to) throw new Error("No billing email on file — add one on the shop's Billing tab");
  const shop = await msgShop({ env: { DB: db } }, inv.shop_id);
  const now = Date.now();
  const link = `${origin}/invoice/${inv.id}?t=${inv.view_token}`;
  const pb = await platformBilling(db);
  const stmts = enqueue(db, { ...shop, name: pb.company_name || "OLLO" } as typeof shop, { email: to, name: bt.owner || bt.name }, inv.kind === "CREDIT_NOTE" ? "credit_note" : "invoice", {
    number: inv.number, total: money(inv.total_pence), due: inv.due_at ? new Date(inv.due_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "", link, shop: bt.name, status: inv.status, bank: pb.bank_details,
  }, { related: { type: "invoice", id: inv.id + ":" + now }, origin, channel: "EMAIL", now, force: true });
  if (stmts.length) { await db.batch(stmts); await drain(db, stmts.length, now, { type: "invoice", id: inv.id + ":" + now }).catch(() => {}); }
  await db.prepare("UPDATE invoices SET sent_at=?, sent_to=?, updated_at=? WHERE id=?").bind(now, to, now, inv.id).run();
  await logBilling(db, inv.shop_id, "INVOICE_SENT", `${inv.number} sent to ${to}`, actor, { invoice_id: inv.id });
  return { to, link };
}

// Dunning: overdue OPEN invoices flip the subscription to PAST_DUE (grace then read-only, per billing.ts).
export async function applyDunning(db: DB, now = Date.now()) {
  const overdue = (await db.prepare("SELECT DISTINCT shop_id FROM invoices WHERE status='OPEN' AND kind<>'CREDIT_NOTE' AND due_at IS NOT NULL AND due_at < ?").bind(now).all<{ shop_id: string }>()).results;
  let flipped = 0;
  for (const o of overdue) {
    const r = await db.prepare("UPDATE shop_subscriptions SET status='PAST_DUE', past_due_since=COALESCE(past_due_since,?), version=version+1, updated_at=? WHERE shop_id=? AND status='ACTIVE'").bind(now, now, o.shop_id).run();
    if ((r.meta?.changes ?? 0) > 0) { flipped++; await logBilling(db, o.shop_id, "PAST_DUE", "Invoice overdue — payment reminder sent. Bookings go read-only after the grace period.", "system"); }
  }
  return { overdue: overdue.length, flipped };
}

// Printable invoice / credit note (HTML with print CSS — Save as PDF from the browser).
export async function invoiceHtml(db: DB, inv: InvoiceRow) {
  const pb = await platformBilling(db);
  const bt = JSON.parse(inv.bill_to_json || "{}") as { name?: string; email?: string; address?: string; shop?: string };
  const lines = JSON.parse(inv.lines_json || "[]") as InvoiceLine[];
  const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const d = (t: number | null) => (t ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "—");
  const isCN = inv.kind === "CREDIT_NOTE";
  const title = isCN ? "Credit note" : "Invoice";
  const balance = inv.total_pence - inv.paid_pence;
  const stamp = inv.status === "VOID" ? "VOID" : isCN ? "CREDIT" : inv.status === "PAID" ? "PAID" : balance > 0 && inv.due_at && inv.due_at < Date.now() ? "OVERDUE" : "";
  const against = inv.credit_note_for ? await db.prepare("SELECT number FROM invoices WHERE id=?").bind(inv.credit_note_for).first<{ number: string }>() : null;
  const refunds = (await db.prepare("SELECT * FROM invoice_adjustments WHERE invoice_id=? AND kind='REFUND'").bind(inv.id).all<{ amount_pence: number; refund_via: string; refund_ref: string; created_at: number }>()).results;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} ${esc(inv.number)} · ${esc(pb.company_name)}</title>
<style>
:root{--ink:#0b1a17;--muted:#6b6f6d;--line:#e3e1d8;--bg:#f4f3ee}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,Inter,Segoe UI,Roboto,sans-serif}
.sheet{max-width:800px;margin:32px auto;background:#fff;border:1px solid var(--line);border-radius:16px;padding:40px;position:relative}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:32px;padding-right:0}h1+.muted{margin-bottom:28px}h1{margin:0;font-size:28px;letter-spacing:-.02em}.brand{font-weight:700;font-size:22px;letter-spacing:-.02em}.muted{color:var(--muted)}small{font-size:12px}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:28px}.meta h3{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
table{width:100%;border-collapse:collapse}th,td{padding:10px 8px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tfoot td{border:0;padding:6px 8px}tfoot tr.total td{font-weight:700;font-size:16px;border-top:2px solid var(--ink);padding-top:12px}
.stamp{position:absolute;top:110px;right:40px;border:3px solid;border-radius:8px;padding:4px 14px;font-weight:800;letter-spacing:.12em;font-size:14px;transform:rotate(-6deg);opacity:.85}.stamp.PAID,.stamp.CREDIT{color:#2f6152}.stamp.OVERDUE{color:#a33}.stamp.VOID{color:#777}
.pay{margin-top:28px;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--bg)}.pay h3{margin:0 0 6px;font-size:13px}pre{margin:0;font:inherit;white-space:pre-wrap}
footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
.actions{max-width:800px;margin:0 auto 24px;display:flex;justify-content:flex-end;gap:8px}.actions button{height:40px;border-radius:10px;border:1px solid var(--ink);background:var(--ink);color:#fff;padding:0 16px;font:inherit;cursor:pointer}
@media print{body{background:#fff}.sheet{margin:0;border:0;border-radius:0;padding:24px}.actions{display:none}}
</style></head><body>
<div class="actions"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
<article class="sheet">
${stamp ? `<div class="stamp ${stamp}">${stamp}</div>` : ""}
<header><div><div class="brand">${esc(pb.company_name)}</div><small class="muted">${esc(pb.company_address).replace(/\n/g, "<br>")}${pb.company_number ? `<br>Company no. ${esc(pb.company_number)}` : ""}${pb.vat_number ? `<br>VAT ${esc(pb.vat_number)}` : ""}${pb.company_email ? `<br>${esc(pb.company_email)}` : ""}</small></div>
<div style="text-align:right"><h1>${title}</h1><div class="muted">${esc(inv.number)}</div></div></header>
<section class="meta">
<div><h3>Billed to</h3><strong>${esc(bt.name || bt.shop)}</strong>${bt.shop && bt.shop !== bt.name ? `<br>${esc(bt.shop)}` : ""}${bt.address ? `<br><span class="muted">${esc(bt.address)}</span>` : ""}${bt.email ? `<br><span class="muted">${esc(bt.email)}</span>` : ""}</div>
<div><h3>Details</h3><div>Issued <strong>${d(inv.issued_at ?? inv.created_at)}</strong></div>${isCN ? `<div>Against invoice <strong>${esc(against?.number ?? "")}</strong></div>` : `<div>Due <strong>${d(inv.due_at)}</strong></div>`}${inv.period_key ? `<div>Period <strong>${d(inv.period_start)} – ${d(inv.period_end)}</strong></div>` : ""}${inv.paid_at && inv.status === "PAID" && !isCN ? `<div>Paid <strong>${d(inv.paid_at)}</strong>${inv.paid_via ? ` via ${esc(inv.paid_via.replace(/_/g, " "))}` : ""}</div>` : ""}</div>
</section>
<table><thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
<tbody>${lines.map((l) => `<tr><td>${esc(l.label)}${l.detail ? `<br><small class="muted">${esc(l.detail)}</small>` : ""}</td><td class="num">${money(l.amount_pence)}</td></tr>`).join("")}</tbody>
<tfoot>
${inv.discount_pence ? `<tr><td class="num muted">Subtotal</td><td class="num">${money(inv.subtotal_pence)}</td></tr><tr><td class="num muted">Discount${inv.note?.startsWith("Discount:") ? ` (${esc(inv.note.slice(10))})` : ""}</td><td class="num">−${money(inv.discount_pence)}</td></tr>` : ""}
${inv.tax_pence ? `<tr><td class="num muted">VAT 20%</td><td class="num">${money(inv.tax_pence)}</td></tr>` : `<tr><td class="num muted" colspan="2"><small>No VAT is charged.</small></td></tr>`}
${inv.credit_applied_pence ? `<tr><td class="num muted">Account credit applied</td><td class="num">−${money(inv.credit_applied_pence)}</td></tr>` : ""}
<tr class="total"><td class="num">${isCN ? "Credit total" : "Total"}</td><td class="num">${money(Math.abs(inv.total_pence))}</td></tr>
${!isCN && inv.paid_pence ? `<tr><td class="num muted">Paid</td><td class="num">−${money(inv.paid_pence)}</td></tr><tr class="total"><td class="num">Balance due</td><td class="num">${money(Math.max(0, balance))}</td></tr>` : ""}
${refunds.length ? refunds.map((r) => `<tr><td class="num muted">Refunded via ${esc(r.refund_via.replace(/_/g, " "))}${r.refund_ref ? ` (${esc(r.refund_ref)})` : ""} on ${d(r.created_at)}</td><td class="num">${money(r.amount_pence)}</td></tr>`).join("") : ""}
</tfoot></table>
${!isCN && inv.status === "OPEN" && pb.bank_details ? `<section class="pay"><h3>How to pay</h3><pre>${esc(pb.bank_details)}</pre><small class="muted">Please quote ${esc(inv.number)} as the payment reference.</small></section>` : ""}
${inv.note && !inv.note.startsWith("Discount:") ? `<p class="muted"><small>${esc(inv.note)}</small></p>` : ""}
${inv.status === "VOID" ? `<p class="muted"><small>Voided ${d(inv.voided_at)}${inv.void_reason ? ` — ${esc(inv.void_reason)}` : ""}</small></p>` : ""}
<footer><span>${esc(pb.invoice_footer)}</span><span>${esc(pb.company_name)} · ${esc(inv.number)}</span></footer>
</article></body></html>`;
}

// Everything the admin invoice screens need.
export async function invoiceStats(db: DB) {
  const now = Date.now();
  const r = await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN status='OPEN' AND kind<>'CREDIT_NOTE' THEN total_pence-paid_pence END),0)::int AS outstanding_pence,
    COALESCE(SUM(CASE WHEN status='OPEN' AND kind<>'CREDIT_NOTE' AND due_at < ? THEN total_pence-paid_pence END),0)::int AS overdue_pence,
    COUNT(*) FILTER (WHERE status='OPEN' AND kind<>'CREDIT_NOTE' AND due_at < ?)::int AS overdue_n,
    COALESCE(SUM(CASE WHEN status='PAID' AND kind<>'CREDIT_NOTE' AND paid_at >= ? THEN paid_pence END),0)::int AS paid_30d_pence,
    COALESCE(SUM(CASE WHEN kind<>'CREDIT_NOTE' AND status<>'VOID' AND issued_at >= ? THEN total_pence END),0)::int AS issued_ytd_pence,
    COALESCE(SUM(CASE WHEN status='UNCOLLECTIBLE' THEN total_pence-paid_pence END),0)::int AS written_off_pence
    FROM invoices`).bind(now, now, now - 30 * DAY, Date.UTC(new Date().getUTCFullYear(), 0, 1)).first();
  const pending = await db.prepare("SELECT COALESCE(SUM(CASE WHEN kind='CREDIT' THEN amount_pence END),0)::int AS credits_pence, COALESCE(SUM(CASE WHEN kind='CHARGE' THEN amount_pence END),0)::int AS charges_pence FROM invoice_adjustments WHERE invoice_id IS NULL").first();
  const pb = await platformBilling(db);
  return { ...(r as object), ...(pending as object), last_period_close: pb.last_period_close, closable_period: prevPeriodKey(now) };
}
