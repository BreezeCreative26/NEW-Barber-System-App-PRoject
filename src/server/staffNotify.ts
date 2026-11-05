// Team notifications (the bell and push for people who run the shop).
//
// Events are written once per thing that happens. Who may see one is decided when it is read, so a
// permission change takes effect straight away:
//   owner, manager, reception, shop login  -> every event
//   barber with "all_notifications"        -> every event
//   barber                                 -> only events on their own bookings
import webpush from "web-push";
import type { Database as DB } from "../db/client";
import type { StoredBooking } from "./domain";
import { pushStatus } from "./push";
import { effectivePerms } from "./perms";

export type EventKind = "new_booking" | "cancelled" | "moved" | "no_show" | "waitlist";
export type Viewer = { id: string; role: string; staff_id: string | null; perms?: Record<string, boolean | undefined> | null };
export type ShopEvent = { id: string; kind: string; title: string; body: string; booking_id: string | null; staff_id: string | null; created_at: number };

export const seesAll = (v: Viewer) => v.role === "OWNER" || !!v.perms?.all_notifications;
const visibleSql = (v: Viewer) => (seesAll(v) ? { sql: "", args: [] as string[] } : { sql: " AND staff_id=?", args: [v.staff_id || "none"] });

const when = (b: StoredBooking) => {
  const [y, m, d] = b.date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const h = Math.floor(b.start_min / 60), mm = String(b.start_min % 60).padStart(2, "0");
  return `${day} at ${String(h).padStart(2, "0")}:${mm}`;
};
const COPY: Record<EventKind, (b: StoredBooking, barber: string) => { title: string; body: string }> = {
  new_booking: (b, s) => ({ title: "New booking", body: `${b.attendee_name || b.customer_name} · ${b.service_name} with ${s} · ${when(b)}` }),
  cancelled: (b, s) => ({ title: "Booking cancelled", body: `${b.attendee_name || b.customer_name} cancelled ${b.service_name} with ${s} · ${when(b)}` }),
  moved: (b, s) => ({ title: "Booking moved", body: `${b.attendee_name || b.customer_name} moved ${b.service_name} with ${s} to ${when(b)}` }),
  no_show: (b, s) => ({ title: "No-show", body: `${b.attendee_name || b.customer_name} did not arrive for ${b.service_name} with ${s} · ${when(b)}` }),
  waitlist: (b, s) => ({ title: "Waiting list", body: `${b.customer_name} · ${b.service_name} with ${s}` }),
};

let configured = false;
function ensure() {
  const e = process.env;
  if (configured || !e.PUSH_VAPID_PUBLIC_KEY || !e.PUSH_VAPID_PRIVATE_KEY) return configured;
  webpush.setVapidDetails(e.PUSH_VAPID_SUBJECT || "https://foliyo.co.uk", e.PUSH_VAPID_PUBLIC_KEY, e.PUSH_VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

// Record the event, then push it to every signed-in team device that is allowed to see it.
export async function recordEvent(db: DB, shopId: string, kind: EventKind, booking: StoredBooking, staffName?: string | null, by: "customer" | "shop" = "customer") {
  const first = (staffName || "the team").split(" ")[0];
  const copy = kind === "cancelled" && by === "shop"
    ? { title: "Booking cancelled by the shop", body: `${booking.attendee_name || booking.customer_name}'s ${booking.service_name} with ${first} · ${when(booking)}` }
    : kind === "new_booking" && by === "shop"
      ? { title: "New booking", body: `${booking.attendee_name || booking.customer_name} · ${booking.service_name} with ${first} · ${when(booking)} (added by the shop)` }
      : COPY[kind](booking, first);
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.prepare("INSERT INTO shop_events(id,shop_id,kind,title,body,booking_id,staff_id,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(id, shopId, kind, copy.title, copy.body, booking.id, booking.staff_id || null, now).run();
  await pushToTeam(db, shopId, { title: copy.title, body: copy.body, staff_id: booking.staff_id || null, tag: `evt-${id}` }).catch(() => {});
  return id;
}

type SubRow = { id: string; account_id: string; endpoint: string; p256dh: string; auth: string; failures: number; role: string; staff_id: string | null; permissions_json: string | null };
async function pushToTeam(db: DB, shopId: string, p: { title: string; body: string; staff_id: string | null; tag: string }) {
  if (!ensure()) return;
  // account_id is the membership id: role, barber link and permissions are read fresh each time.
  const subs = (await db.prepare(
    "SELECT s.id,s.account_id,s.endpoint,s.p256dh,s.auth,s.failures,m.role,m.staff_id,m.permissions_json FROM staff_push_subscriptions s JOIN app_memberships m ON m.id=s.account_id AND m.shop_id=s.shop_id WHERE s.shop_id=? AND m.active=1",
  ).bind(shopId).all<SubRow>()).results;
  for (const s of subs) {
    const role = s.role === "SHOP" ? "RECEPTION" : s.role;
    const v: Viewer = { id: s.account_id, role, staff_id: s.staff_id, perms: effectivePerms(role, s.permissions_json) };
    if (!seesAll(v) && p.staff_id !== v.staff_id) continue;
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: p.title, body: p.body, url: "/workspace", tag: p.tag }), { TTL: 6 * 3600, urgency: "high" });
      await db.prepare("UPDATE staff_push_subscriptions SET last_used_at=?, failures=0 WHERE id=?").bind(Date.now(), s.id).run();
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode ?? 0;
      if (code === 404 || code === 410 || s.failures + 1 >= 5) await db.prepare("DELETE FROM staff_push_subscriptions WHERE id=?").bind(s.id).run();
      else await db.prepare("UPDATE staff_push_subscriptions SET failures=failures+1 WHERE id=?").bind(s.id).run();
    }
  }
}

// The bell for one login. Clearing, reading one item and dismissing a "needs attention" item are
// stored per login in shop_bell_marks, so tidying your bell never changes anyone else's.
const DAY = 86400000;
export async function listFor(db: DB, shopId: string, v: Viewer) {
  const vis = visibleSql(v);
  const seen = await db.prepare("SELECT seen_at FROM shop_event_seen WHERE shop_id=? AND viewer_id=?").bind(shopId, v.id).first<{ seen_at: number }>();
  const since = seen?.seen_at ?? 0;
  const rows = (await db.prepare(
    `SELECT e.id,e.kind,e.title,e.body,e.booking_id,e.staff_id,e.created_at FROM shop_events e WHERE e.shop_id=? AND e.created_at>? ${vis.sql.replace("staff_id", "e.staff_id")}
       AND NOT EXISTS (SELECT 1 FROM shop_bell_marks m WHERE m.shop_id=e.shop_id AND m.viewer_id=? AND m.item_key='clear:'||e.id)
     ORDER BY e.created_at DESC LIMIT 50`,
  ).bind(shopId, Date.now() - 14 * DAY, ...vis.args, v.id).all<ShopEvent>()).results;
  const marks = (await db.prepare("SELECT item_key FROM shop_bell_marks WHERE shop_id=? AND viewer_id=? AND (item_key LIKE 'read:%' OR item_key LIKE 'dismiss:%')").bind(shopId, v.id).all<{ item_key: string }>()).results.map((m) => m.item_key);
  const read = new Set(marks.filter((k) => k.startsWith("read:")).map((k) => k.slice(5)));
  const events = rows.map((r) => ({ ...r, unread: r.created_at > since && !read.has(r.id) }));
  return {
    events,
    unread: events.filter((r) => r.unread).length,
    all: seesAll(v),
    dismissed: marks.filter((k) => k.startsWith("dismiss:")).map((k) => k.slice(8)),
  };
}
export async function markSeen(db: DB, shopId: string, viewerId: string) {
  await db.prepare("INSERT INTO shop_event_seen(shop_id,viewer_id,seen_at) VALUES(?,?,?) ON CONFLICT (shop_id,viewer_id) DO UPDATE SET seen_at=EXCLUDED.seen_at").bind(shopId, viewerId, Date.now()).run();
}
// Only events this login can see may be marked; anything else is ignored silently.
async function visibleIds(db: DB, shopId: string, v: Viewer, ids?: string[]) {
  const vis = visibleSql(v);
  if (ids && !ids.length) return [];
  const rows = (await db.prepare(
    `SELECT id FROM shop_events WHERE shop_id=? AND created_at>? ${vis.sql}${ids ? ` AND id IN (${ids.map(() => "?").join(",")})` : ""}`,
  ).bind(shopId, Date.now() - 14 * DAY, ...vis.args, ...(ids ?? [])).all<{ id: string }>()).results;
  return rows.map((r) => r.id);
}
async function putMarks(db: DB, shopId: string, viewerId: string, keys: string[]) {
  const now = Date.now();
  // Activity marks outlive the 14-day feed comfortably; tidy older ones as we go.
  const stmts = [db.prepare("DELETE FROM shop_bell_marks WHERE shop_id=? AND viewer_id=? AND at<? AND item_key NOT LIKE 'dismiss:%'").bind(shopId, viewerId, now - 30 * DAY)];
  for (const k of keys) stmts.push(db.prepare("INSERT INTO shop_bell_marks(shop_id,viewer_id,item_key,at) VALUES(?,?,?,?) ON CONFLICT (shop_id,viewer_id,item_key) DO UPDATE SET at=EXCLUDED.at").bind(shopId, viewerId, k, now));
  await db.batch(stmts);
}
export async function markRead(db: DB, shopId: string, v: Viewer, ids: string[]) {
  const ok = await visibleIds(db, shopId, v, ids);
  await putMarks(db, shopId, v.id, ok.map((id) => `read:${id}`));
  return ok;
}
// No ids = everything currently in this person's bell. Returns what was cleared, for Undo.
export async function clearEvents(db: DB, shopId: string, v: Viewer, ids?: string[]) {
  const ok = await visibleIds(db, shopId, v, ids);
  await putMarks(db, shopId, v.id, ok.map((id) => `clear:${id}`));
  return ok;
}
export async function dismissIssues(db: DB, shopId: string, viewerId: string, keys: string[]) {
  await putMarks(db, shopId, viewerId, keys.map((k) => `dismiss:${k}`));
}
// Undo: bring back cleared items / dismissed issues for this login.
export async function restoreMarks(db: DB, shopId: string, viewerId: string, cleared: string[], dismissed: string[]) {
  const keys = [...cleared.map((id) => `clear:${id}`), ...dismissed.map((k) => `dismiss:${k}`)];
  if (!keys.length) return;
  await db.prepare(`DELETE FROM shop_bell_marks WHERE shop_id=? AND viewer_id=? AND item_key IN (${keys.map(() => "?").join(",")})`).bind(shopId, viewerId, ...keys).run();
}
export const staffPushStatus = pushStatus;
