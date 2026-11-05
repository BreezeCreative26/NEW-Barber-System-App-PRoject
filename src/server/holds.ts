// Online slot holds. When a customer taps a time it is held for them while they finish booking:
//   - at most HOLD_MAX_MS (5 minutes) from when they picked it;
//   - only while the page keeps checking in. A hold whose page hasn't checked in for LEFT_MS
//     (they closed the tab or left the page) is released, so leaving keeps it 2 minutes.
// Other customers don't see held times. The shop sees "Booking in progress" on the timetable and may
// book over it (the hold is then marked released='taken' and the customer is told it has gone).
// Inserts take the same per-shop advisory lock as bookings, so a hold and a booking can't both land.
import type { Database as DB } from "../db/client";
import { digest } from "./accounts";

export const HOLD_MAX_MS = 5 * 60 * 1000;
export const LEFT_MS = 2 * 60 * 1000;
// The page checks in every 20 s; allow a little slack before treating it as gone.
const SEEN_SLACK_MS = 10 * 1000;

export type SlotHold = {
  id: string;
  staff_id: string;
  date: string;
  start_min: number;
  duration_min: number;
  start_at: number;
  end_at: number;
  service_name: string;
  customer_name: string;
  account_id: string | null;
  created_at: number;
  seen_at: number;
  expires_at: number;
  left_at: number | null;
};

// SQL fragment (alias h) for a hold that still counts. Bind: now, now - (LEFT_MS + slack).
export const LIVE = "h.released IS NULL AND h.expires_at>? AND h.seen_at>?";
export const liveArgs = (now = Date.now()) => [now, now - LEFT_MS - SEEN_SLACK_MS];

export const holderHash = (shopId: string, key: string) => digest(`hold:${shopId}:${key}`);

// When the hold really ends: 5 minutes from picking, or 2 minutes after the page was left.
export const holdEnds = (h: Pick<SlotHold, "expires_at" | "seen_at" | "left_at">) =>
  h.left_at ? Math.min(h.expires_at, h.left_at + LEFT_MS) : h.expires_at;

// Live holds as pseudo-bookings, so the normal slot rules ("Slot taken") apply to them.
export async function holdsAsBookings(db: DB, shopId: string, from: string, to: string, excludeHash = "", now = Date.now()) {
  const rows = (
    await db
      .prepare(`SELECT h.id,h.staff_id,h.start_at,h.end_at FROM slot_holds h WHERE h.shop_id=? AND h.date BETWEEN ? AND ? AND ${LIVE} AND h.holder_hash<>?`)
      .bind(shopId, from, to, ...liveArgs(now), excludeHash)
      .all<{ id: string; staff_id: string; start_at: number; end_at: number }>()
  ).results;
  return rows.map((r) => ({ id: `hold:${r.id}`, staff_id: r.staff_id, start_at: Number(r.start_at), end_at: Number(r.end_at), buffer_min: 0, status: "CONFIRMED" }));
}

// Live holds the shop sees on the timetable (today onwards).
export async function liveHolds(db: DB, shopId: string, fromDate: string, now = Date.now()): Promise<SlotHold[]> {
  return (
    await db
      .prepare(`SELECT h.id,h.staff_id,h.date,h.start_min,h.duration_min,h.start_at,h.end_at,h.service_name,h.customer_name,h.account_id,h.created_at,h.seen_at,h.expires_at,h.left_at FROM slot_holds h WHERE h.shop_id=? AND h.date>=? AND ${LIVE} ORDER BY h.start_at`)
      .bind(shopId, fromDate, ...liveArgs(now))
      .all<SlotHold>()
  ).results.map((h) => ({ ...h, start_at: Number(h.start_at), end_at: Number(h.end_at), created_at: Number(h.created_at), seen_at: Number(h.seen_at), expires_at: Number(h.expires_at), left_at: h.left_at === null ? null : Number(h.left_at) }));
}

// Change marker for the timetable's 2-second heartbeat: moves when a hold appears, is left or ends.
export async function holdsCursor(db: DB, shopId: string, now = Date.now()) {
  const r = await db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(h.created_at),0) AS at, COUNT(h.left_at) AS gone FROM slot_holds h WHERE h.shop_id=? AND ${LIVE}`)
    .bind(shopId, ...liveArgs(now))
    .first<{ n: number; at: number; gone: number }>();
  return `${r?.n ?? 0}.${r?.at ?? 0}.${r?.gone ?? 0}`;
}

// Statements for a booking transaction (run right after ollo_lock_shop):
//   ONLINE: refuse a time someone else holds; the booker's own hold becomes 'booked'.
//   OWNER without force: refuse with slot_held (the form warns and offers "Book anyway").
//   OWNER with force: the customer's hold ends as 'taken'.
export function holdStatements(
  db: DB,
  o: { shopId: string; staffId: string; startAt: number; endAt: number; channel: "ONLINE" | "OWNER"; force: boolean; ownHash: string; now?: number },
) {
  const now = o.now ?? Date.now();
  const overlap = `h.shop_id=? AND h.staff_id=? AND ${LIVE} AND h.holder_hash<>? AND h.start_at<? AND ?<h.end_at`;
  const args = [o.shopId, o.staffId, ...liveArgs(now), o.ownHash, o.endAt, o.startAt];
  if (o.channel === "OWNER" && o.force)
    return [db.prepare(`UPDATE slot_holds h SET released='taken' WHERE ${overlap}`).bind(...args)];
  const code = o.channel === "OWNER" ? "slot_held" : "slot_taken";
  const out = [db.prepare(`SELECT ollo_abort('${code}') WHERE EXISTS (SELECT 1 FROM slot_holds h WHERE ${overlap})`).bind(...args)];
  if (o.channel === "ONLINE" && o.ownHash)
    out.push(db.prepare("UPDATE slot_holds SET released='booked' WHERE shop_id=? AND holder_hash=? AND released IS NULL").bind(o.shopId, o.ownHash));
  return out;
}
