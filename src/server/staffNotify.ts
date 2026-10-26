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

export async function listFor(db: DB, shopId: string, v: Viewer) {
  const vis = visibleSql(v);
  const seen = await db.prepare("SELECT seen_at FROM shop_event_seen WHERE shop_id=? AND viewer_id=?").bind(shopId, v.id).first<{ seen_at: number }>();
  const since = seen?.seen_at ?? 0;
  const rows = (await db.prepare(`SELECT id,kind,title,body,booking_id,staff_id,created_at FROM shop_events WHERE shop_id=? AND created_at>? ${vis.sql} ORDER BY created_at DESC LIMIT 50`).bind(shopId, Date.now() - 14 * 86400000, ...vis.args).all<ShopEvent>()).results;
  return { events: rows.map((r) => ({ ...r, unread: r.created_at > since })), unread: rows.filter((r) => r.created_at > since).length, all: seesAll(v) };
}
export async function markSeen(db: DB, shopId: string, viewerId: string) {
  await db.prepare("INSERT INTO shop_event_seen(shop_id,viewer_id,seen_at) VALUES(?,?,?) ON CONFLICT (shop_id,viewer_id) DO UPDATE SET seen_at=EXCLUDED.seen_at").bind(shopId, viewerId, Date.now()).run();
}
export const staffPushStatus = pushStatus;
