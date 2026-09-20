// Owner / manager alerts: what the shop hears about, on which channel. Preferences live in
// shops.notify_json; recipients are the owner (shop mobile + owner login email) and any active
// managers (their login email). Defaults: email on for bookings and cancellations, everything else
// off — quiet by default, one tap to turn texts on.
//
//   alertOwners(db, shopId, "new_booking", booking, extra)  — fire-and-forget after the customer message
//   sweepDailySummaries(db, origin, now)                     — 07:00 shop-local, from the 5-minute sweep
import type { Database as DB } from "../db/client";
import type { StoredBooking } from "./domain";
import { drain, enqueue, fmtDate, fmtTime, msgShop, type MessageTemplate } from "./messaging";

export type AlertKind = "new_booking" | "cancelled" | "no_show" | "daily_summary";
export type AlertChannel = "OFF" | "EMAIL" | "SMS" | "BOTH";
export type AlertPrefs = Record<AlertKind, AlertChannel> & { managers: boolean; summary_hour: number };
export const ALERT_KINDS: { key: AlertKind; label: string; hint: string }[] = [
  { key: "new_booking", label: "New online booking", hint: "When a customer books through your link." },
  { key: "cancelled", label: "Cancellation", hint: "When a customer cancels online." },
  { key: "no_show", label: "No-show marked", hint: "When someone on the team marks a visit as a no-show." },
  { key: "daily_summary", label: "Morning summary", hint: "Today's visits, first and last, free slots." },
];
export const DEFAULT_PREFS: AlertPrefs = { new_booking: "EMAIL", cancelled: "EMAIL", no_show: "OFF", daily_summary: "OFF", managers: true, summary_hour: 7 };
const CHANNELS: AlertChannel[] = ["OFF", "EMAIL", "SMS", "BOTH"];
export function prefsOf(json: string | null | undefined): AlertPrefs {
  let j: Partial<AlertPrefs> = {};
  try { j = JSON.parse(json || "{}"); } catch { /* default */ }
  const pick = (k: AlertKind) => (CHANNELS.includes(j[k] as AlertChannel) ? (j[k] as AlertChannel) : DEFAULT_PREFS[k]);
  return { new_booking: pick("new_booking"), cancelled: pick("cancelled"), no_show: pick("no_show"), daily_summary: pick("daily_summary"), managers: j.managers ?? true, summary_hour: Number.isInteger(j.summary_hour) && (j.summary_hour as number) >= 5 && (j.summary_hour as number) <= 12 ? (j.summary_hour as number) : 7 };
}

type Recipient = { name: string; email?: string; phone?: string };
// Owner: login email + the shop's mobile (only when it has been verified — unverified numbers could
// be anyone's). Managers: login email only.
async function recipients(db: DB, shopId: string, prefs: AlertPrefs): Promise<Recipient[]> {
  const shop = await db.prepare("SELECT phone, phone_verified_at FROM shops WHERE id=?").bind(shopId).first<{ phone: string; phone_verified_at: number | null }>();
  const rows = (await db.prepare("SELECT u.name,u.email,m.role FROM app_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.shop_id=? AND m.active=1 AND m.role IN ('OWNER','MANAGER')").bind(shopId).all<{ name: string; email: string; role: string }>()).results;
  const out: Recipient[] = [];
  for (const r of rows) {
    if (r.role === "OWNER") out.push({ name: r.name, email: r.email, phone: shop?.phone_verified_at ? shop.phone : undefined });
    else if (prefs.managers) out.push({ name: r.name, email: r.email });
  }
  return out;
}
const TEMPLATE: Record<Exclude<AlertKind, "daily_summary">, MessageTemplate> = { new_booking: "owner_new_booking", cancelled: "owner_cancelled", no_show: "owner_no_show" };

export async function alertOwners(db: DB, shopId: string, kind: Exclude<AlertKind, "daily_summary">, booking: StoredBooking, opts: { staffName?: string | null; origin: string; extra?: Record<string, string | number> }) {
  const shop = await msgShop({ env: { DB: db } }, shopId);
  const prefs = prefsOf(shop.notify_json);
  const channel = prefs[kind];
  if (channel === "OFF") return 0;
  const to = await recipients(db, shopId, prefs);
  if (!to.length) return 0;
  const money = (p: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: shop.currency || "GBP" }).format(p / 100);
  const vars = {
    customer: booking.attendee_name || booking.customer_name, service: booking.service_name, barber: (opts.staffName || "the team").split(" ")[0],
    date: fmtDate(booking.date), time: fmtTime(booking.start_min), ref: `BRB-${booking.id.slice(0, 4).toUpperCase()}`,
    deposit: booking.deposit_status === "PAID" ? `${money(booking.deposit_paid_pence ?? 0)} paid` : booking.deposit_status === "REFUNDED" ? "refunded" : "",
    link: `${opts.origin}/workspace`, ...opts.extra,
  };
  const now = Date.now();
  const stmts = to.flatMap((r) => [
    ...(channel === "EMAIL" || channel === "BOTH" ? enqueue(db, shop, { name: r.name, email: r.email }, TEMPLATE[kind], vars, { related: { type: "alert", id: booking.id }, origin: opts.origin, channel: "EMAIL", now, force: true }) : []),
    ...((channel === "SMS" || channel === "BOTH") && r.phone ? enqueue(db, shop, { name: r.name, phone: r.phone }, TEMPLATE[kind], vars, { related: { type: "alert", id: booking.id }, origin: opts.origin, channel: "SMS", now, force: true }) : []),
  ]);
  if (!stmts.length) return 0;
  await db.batch(stmts);
  await drain(db, stmts.length, now, { type: "alert", id: booking.id }).catch(() => {});
  return stmts.length;
}

// Morning summary: once per shop per day, at prefs.summary_hour shop-local. Idempotent via
// platform_kv key summary:<shop>:<date>.
export async function sweepDailySummaries(db: DB, origin: string, now = Date.now()) {
  const shops = (await db.prepare("SELECT id, timezone, notify_json FROM shops WHERE notify_json LIKE '%daily_summary%' AND notify_json NOT LIKE '%\"daily_summary\":\"OFF\"%'").all<{ id: string; timezone: string; notify_json: string }>()).results;
  let sent = 0;
  for (const s of shops) {
    const prefs = prefsOf(s.notify_json);
    if (prefs.daily_summary === "OFF") continue;
    const local = new Date(now).toLocaleString("en-GB", { timeZone: s.timezone || "Europe/London", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" });
    const [d, h] = [local.slice(0, 10).split("/").reverse().join("-"), Number(local.slice(-2))];
    if (h < prefs.summary_hour) continue;
    const key = `summary:${s.id}:${d}`;
    const claim = await db.prepare("INSERT INTO platform_kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING").bind(key, "1", now).run();
    if (!claim.meta.changes) continue;
    const rows = (await db.prepare("SELECT start_min, channel, deposit_paid_pence FROM bookings WHERE shop_id=? AND date=? AND status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED') ORDER BY start_min").bind(s.id, d).all<{ start_min: number; channel: string; deposit_paid_pence: number }>()).results;
    if (!rows.length) continue; // nothing on: no message
    const shop = await msgShop({ env: { DB: db } }, s.id);
    const to = await recipients(db, s.id, prefs);
    const money = (p: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: shop.currency || "GBP" }).format(p / 100);
    const online = rows.filter((r) => r.channel === "ONLINE").length;
    const deposits = rows.reduce((n, r) => n + (r.deposit_paid_pence || 0), 0);
    // Rough free-slot count: 30-minute slots across the shop day minus booked ones.
    const span = Math.max(0, (shop.closes - shop.opens) / 30);
    const gaps = Math.max(0, Math.round(span - rows.length));
    const vars = { date: fmtDate(d), count: rows.length, first_time: fmtTime(rows[0].start_min), last_time: fmtTime(rows[rows.length - 1].start_min), online, walkin: rows.length - online, gaps, deposits: deposits ? money(deposits) : "", link: `${origin}/workspace` };
    const ch = prefs.daily_summary;
    const stmts = to.flatMap((r) => [
      ...(ch === "EMAIL" || ch === "BOTH" ? enqueue(db, shop, { name: r.name, email: r.email }, "owner_daily_summary", vars, { related: { type: "summary", id: `${s.id}:${d}` }, origin, channel: "EMAIL", now, force: true }) : []),
      ...((ch === "SMS" || ch === "BOTH") && r.phone ? enqueue(db, shop, { name: r.name, phone: r.phone }, "owner_daily_summary", vars, { related: { type: "summary", id: `${s.id}:${d}` }, origin, channel: "SMS", now, force: true }) : []),
    ]);
    if (stmts.length) { await db.batch(stmts); sent += stmts.length; }
  }
  if (sent) await drain(db, sent, now).catch(() => {});
  return sent;
}
