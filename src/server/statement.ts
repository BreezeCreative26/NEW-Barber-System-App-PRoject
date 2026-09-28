// The shop's running bill: what this month's invoice looks like *right now*, rebuilt from live
// usage every time it is read, plus a forecast of next month's invoice.
//
// Every metered unit (each text, each WhatsApp message, each receptionist minute) appears as its
// own dated line so an owner can see exactly what they are paying for. The month closes on the 1st
// (invoicing.runPeriodClose → a real invoice); until then this is the statement that "builds".
import type { Database as DB } from "../db/client";
import { entitlements, estimate, features, periodKey, platformBilling, usageFor, type UsageLine } from "./billing";
import { periodBounds } from "./invoicing";

const DAY = 86400000;

export type UsageItem = { id: string; at: number; feature_key: string; unit: string; label: string; detail: string; recipient: string; quantity: number; unit_pence: number; amount_pence: number; billable: boolean };
export type DailyTotal = { day: string; quantity: number; amount_pence: number };
export type RunningStatement = {
  period: string;
  period_start: number;
  period_end: number;
  closes_at: number; // when the invoice is issued (1st of next month, 00:00 UTC)
  due_at: number; // closes_at + due_days
  days_left: number;
  status: "TRIAL" | "BUILDING" | "PAUSED";
  lines: { label: string; amount_pence: number; detail: string }[];
  subtotal_pence: number;
  discount_pence: number;
  tax_pence: number;
  total_pence: number;
  vat_mode: string;
  usage: UsageLine[];
  items: UsageItem[]; // newest first, capped
  items_total: number;
  daily: DailyTotal[]; // one row per day of the month so far
  forecast: { period: string; lines: { label: string; amount_pence: number; detail: string }[]; total_pence: number; basis: string };
};

const TEMPLATE_LABEL: Record<string, string> = {
  booking_confirmed: "Booking confirmation",
  booking_moved: "Booking moved",
  booking_cancelled: "Booking cancelled",
  booking_reminder: "Reminder",
  booking_reminder_soon: "Reminder (soon)",
  signin_code: "Sign-in code",
  staff_invite: "Team invite",
  waitlist_joined: "Waitlist joined",
  waitlist_offer: "Waitlist offer",
  waitlist_open: "Waitlist: slot open",
  waitlist_booked: "Waitlist booked",
  waitlist_released: "Waitlist released",
  review_request: "Review request",
  test_message: "Test message",
  pay_link: "Payment link",
  verify_contact: "Verification code",
  password_reset: "Password reset",
  account_welcome: "Account welcome",
  account_reset: "Account reset",
  shop_address: "Shop address",
  owner_new_booking: "Owner alert: new booking",
  owner_cancelled: "Owner alert: cancellation",
  owner_no_show: "Owner alert: no-show",
  owner_daily_summary: "Owner daily summary",
  owner_callback: "Owner alert: callback",
};
export const usageLabel = (template: string) => TEMPLATE_LABEL[template] ?? template.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// Mask a phone/email for the statement: 07405 427407 → 07405 •••407.
export function maskRecipient(r: string) {
  if (r.includes("@")) { const [u, d] = r.split("@"); return `${u.slice(0, 2)}•••@${d}`; }
  const digits = r.replace(/\s+/g, "");
  return digits.length > 6 ? `${digits.slice(0, 5)} •••${digits.slice(-3)}` : "•••";
}

export async function runningStatement(db: DB, shopId: string, now = Date.now(), itemLimit = 200): Promise<RunningStatement> {
  const period = periodKey(now);
  const { start, end } = periodBounds(period);
  const closes_at = end + 1;
  const pb = await platformBilling(db);
  const est = await estimate(db, shopId, period);
  const e = est.entitlements;
  const fs = await features(db);
  const byKey = new Map(fs.map((f) => [f.key, f]));

  // Every metered unit this period, joined to the notification it came from for a readable label.
  const rows = (
    await db
      .prepare(
        `SELECT u.id, u.occurred_at, u.feature_key, u.quantity, u.unit_pence, u.ref_type, u.ref_id,
                n.template, n.recipient, n.channel
         FROM usage_events u LEFT JOIN notifications n ON u.ref_type='notification' AND n.id=u.ref_id
         WHERE u.shop_id=? AND u.period_key=? ORDER BY u.occurred_at DESC`,
      )
      .bind(shopId, period)
      .all<{ id: string; occurred_at: number; feature_key: string; quantity: number; unit_pence: number; ref_type: string; ref_id: string; template: string | null; recipient: string | null; channel: string | null }>()
  ).results;

  // Included units are consumed oldest-first, so the earliest N of the month are free and the rest billable.
  const consumed = new Map<string, number>();
  const chronological = [...rows].reverse();
  const billableIds = new Set<string>();
  for (const r of chronological) {
    const inc = byKey.get(r.feature_key)?.included_units ?? 0;
    const used = consumed.get(r.feature_key) ?? 0;
    if (used + r.quantity > inc) billableIds.add(r.id);
    consumed.set(r.feature_key, used + r.quantity);
  }
  const items: UsageItem[] = rows.slice(0, itemLimit).map((r) => {
    const f = byKey.get(r.feature_key);
    const unit = f?.unit || "unit";
    const billable = billableIds.has(r.id);
    const label = r.ref_type === "notification" ? usageLabel(r.template || "") : r.ref_type === "call" ? "Receptionist call" : usageLabel(r.ref_type);
    const detail = r.ref_type === "notification" ? `${r.channel === "WA" ? "WhatsApp" : "Text"} to ${maskRecipient(r.recipient || "")}` : `${r.quantity} ${unit}${r.quantity === 1 ? "" : "s"}`;
    return { id: r.id, at: r.occurred_at, feature_key: r.feature_key, unit, label, detail, recipient: maskRecipient(r.recipient || ""), quantity: r.quantity, unit_pence: r.unit_pence, amount_pence: billable ? r.quantity * r.unit_pence : 0, billable };
  });

  // Daily totals for the whole month so far (zero-filled), for the chart / "builds each day" view.
  const daily: DailyTotal[] = [];
  const today = new Date(now);
  const firstDay = new Date(start);
  for (let d = new Date(firstDay); d.getTime() <= Math.min(now, end); d.setUTCDate(d.getUTCDate() + 1)) daily.push({ day: d.toISOString().slice(0, 10), quantity: 0, amount_pence: 0 });
  for (const r of rows) {
    const key = new Date(r.occurred_at).toISOString().slice(0, 10);
    const row = daily.find((x) => x.day === key);
    if (row) { row.quantity += r.quantity; row.amount_pence += billableIds.has(r.id) ? r.quantity * r.unit_pence : 0; }
  }

  // Forecast next month: plan + seats + add-ons at today's settings, usage at this month's daily run-rate.
  const daysSoFar = Math.max(1, Math.floor((now - start) / DAY) + 1);
  const nextKey = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
  const nextDays = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 0)).getUTCDate();
  const fixed = est.lines.filter((l) => !est.usage.some((u) => l.label.startsWith(`${u.name} ·`)));
  const forecastLines = [...fixed];
  for (const u of est.usage) {
    if (!u.quantity) continue;
    const projected = Math.round((u.quantity / daysSoFar) * nextDays);
    const billable = Math.max(0, projected - u.included);
    forecastLines.push({ label: `${u.name} · ~${projected} ${u.unit}${projected === 1 ? "" : "s"}`, amount_pence: billable * u.unit_pence, detail: `at this month's pace · ${u.unit_pence}p each` });
  }
  const forecastTotal = Math.max(0, forecastLines.reduce((n, l) => n + l.amount_pence, 0) - est.discount_pence);
  const forecastTax = pb.vat_mode === "UK_20" ? Math.round(forecastTotal * 0.2) : 0;

  const sub = e.subscription;
  const status: RunningStatement["status"] = sub.status === "TRIAL" ? "TRIAL" : sub.status === "PAUSED" || sub.status === "CANCELLED" ? "PAUSED" : "BUILDING";
  return {
    period,
    period_start: start,
    period_end: end,
    closes_at,
    due_at: closes_at + pb.due_days * DAY,
    days_left: Math.max(0, Math.ceil((closes_at - now) / DAY)),
    status,
    lines: est.lines,
    subtotal_pence: est.subtotal_pence,
    discount_pence: est.discount_pence,
    tax_pence: est.tax_pence,
    total_pence: est.total_pence,
    vat_mode: est.vat_mode,
    usage: est.usage,
    items,
    items_total: rows.length,
    daily,
    forecast: { period: nextKey, lines: forecastLines, total_pence: forecastTotal + forecastTax, basis: `${daysSoFar} day${daysSoFar === 1 ? "" : "s"} of usage so far` },
  };
}

// CSV of every metered unit this period — owners export it for their accountant.
export async function statementCsv(db: DB, shopId: string, period = periodKey()) {
  const rows = (
    await db
      .prepare(
        `SELECT u.occurred_at, u.feature_key, u.quantity, u.unit_pence, n.template, n.recipient, n.channel
         FROM usage_events u LEFT JOIN notifications n ON u.ref_type='notification' AND n.id=u.ref_id
         WHERE u.shop_id=? AND u.period_key=? ORDER BY u.occurred_at`,
      )
      .bind(shopId, period)
      .all<{ occurred_at: number; feature_key: string; quantity: number; unit_pence: number; template: string | null; recipient: string | null; channel: string | null }>()
  ).results;
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const out = ["Date,Time,Type,Channel,Recipient,Quantity,Unit price (p),Amount (£)"];
  for (const r of rows) {
    const d = new Date(r.occurred_at);
    out.push([d.toISOString().slice(0, 10), d.toISOString().slice(11, 16), q(usageLabel(r.template || r.feature_key)), r.channel === "WA" ? "WhatsApp" : r.channel === "SMS" ? "Text" : r.feature_key, q(maskRecipient(r.recipient || "")), r.quantity, r.unit_pence, ((r.quantity * r.unit_pence) / 100).toFixed(2)].join(","));
  }
  return out.join("\n");
}
