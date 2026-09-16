// Waiting list procedure: matching, offers, auto-offer on freed slots, and the notifications outbox.
// See docs/WAITLIST-PLAN.md. Nothing here sends a message: every intended message is written to the
// outbox as SKIPPED until a provider exists, and the offer link is surfaced to staff.
import type { Context } from "hono";
import type { Statement as D1PreparedStatement } from "../db/client";
import { z } from "zod";
import { calculateQuote, effectiveHours, localInstant, ref, shopToday, slotReason, weekday, type Addon, type AddonLink, type Holiday, type Hours, type ScheduleOverride, type Service, type Shop, type Staff, type StaffDayOff, type StaffServiceRule, type StoredBooking } from "./domain";
import type { AppEnv } from "./accounts";
import { digest } from "./accounts";

type Ctx = Context<AppEnv>;
const uid = () => crypto.randomUUID();

export type WaitlistRow = {
  id: string; shop_id: string; staff_id: string | null; service_id: string; customer_name: string; phone: string; email: string; date: string;
  daypart: "ANY" | "MORNING" | "AFTERNOON" | "EVENING"; notes: string; status: "OPEN" | "OFFERED" | "BOOKED" | "CLOSED" | "EXPIRED";
  booking_id: string | null; offer_id: string | null; offers_made: number; version: number; created_at: number; updated_at: number;
};
export type OfferRow = {
  id: string; shop_id: string; entry_id: string; staff_id: string; service_id: string; date: string; start_min: number; token_hash: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "SUPERSEDED" | "LOST"; source: "MANUAL" | "AUTO"; booking_id: string | null;
  expires_at: number; created_at: number; responded_at: number | null;
};
export type ShopQueueSettings = { waitlist_auto_offer: number; waitlist_offer_hold_min: number; waitlist_templates_json: string };

// ---- Templates -------------------------------------------------------------
export const TEMPLATE_KEYS = ["waitlist_joined", "waitlist_offer", "waitlist_booked", "waitlist_released", "review_request"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export const DEFAULT_TEMPLATES: Record<TemplateKey, string> = {
  waitlist_joined: "Hi {first}, you're on the list at {shop} for {date} ({daypart}). We'll message you if a time opens up.",
  waitlist_offer: "Hi {first}, a {service} with {barber} has opened at {shop} on {date} at {time}. It's held for you until {expires}: {link}",
  waitlist_booked: "You're booked: {service} with {barber} at {shop}, {date} {time}. Ref {ref}. Manage: {manage}",
  waitlist_released: "No problem, {first} — we've put you back on the list at {shop} for {date}.",
  review_request: "Thanks for coming in, {first}. How was your {service} with {barber} at {shop}? Leave a quick rating: {link}",
};
export const templatesSchema = z.object(Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, z.string().trim().min(10).max(400)])) as Record<TemplateKey, z.ZodString>).strict();
export function templatesOf(shop: ShopQueueSettings): Record<TemplateKey, string> {
  let custom: Partial<Record<TemplateKey, string>> = {};
  try {
    custom = JSON.parse(shop.waitlist_templates_json || "{}");
  } catch {
    custom = {};
  }
  return { ...DEFAULT_TEMPLATES, ...Object.fromEntries(Object.entries(custom).filter(([k, v]) => TEMPLATE_KEYS.includes(k as TemplateKey) && typeof v === "string" && v.trim())) };
}
export function render(template: string, vars: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}
const fmtDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const fmtTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fmtStamp = (ms: number, tz: string) => new Date(ms).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: tz });
const daypartLabel: Record<string, string> = { ANY: "any time", MORNING: "morning", AFTERNOON: "afternoon", EVENING: "evening" };

// Outbox write. Channel is SMS when we have a mobile, EMAIL otherwise. Status is SKIPPED (no provider).
export function queueMessage(c: Ctx, shopId: string, to: { phone: string; email: string }, template: TemplateKey, body: string, related: { type: string; id: string }) {
  const channel = to.phone ? "SMS" : "EMAIL";
  return c.env.DB.prepare(
    "INSERT INTO notifications(id,shop_id,channel,recipient,template,body,status,status_note,related_type,related_id,created_at) VALUES(?,?,?,?,?,?,'SKIPPED','No message provider connected; copy and send by hand.',?,?,?)",
  ).bind(uid(), shopId, channel, to.phone || to.email, template, body, related.type, related.id, Date.now());
}

// ---- Matching ----------------------------------------------------------------
const inDaypart = (m: number, part: string) => part === "ANY" || (part === "MORNING" && m < 720) || (part === "AFTERNOON" && m >= 720 && m < 1020) || (part === "EVENING" && m >= 1020);

// Open times on the entry's date that fit its request. Barber-agnostic when staff_id is null.
export async function matchesFor(c: Ctx, shop: Shop & ShopQueueSettings, entry: WaitlistRow, now = Date.now()) {
  const sid = shop.id;
  const r = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM staff WHERE shop_id=? AND active=1 ORDER BY sort_order,name").bind(sid),
    c.env.DB.prepare("SELECT * FROM services WHERE shop_id=? AND id=? AND active=1").bind(sid, entry.service_id),
    c.env.DB.prepare("SELECT * FROM staff_hours WHERE shop_id=? AND weekday=?").bind(sid, weekday(entry.date)),
    c.env.DB.prepare("SELECT * FROM staff_schedule_overrides WHERE shop_id=? AND date=?").bind(sid, entry.date),
    c.env.DB.prepare("SELECT * FROM holidays WHERE shop_id=? AND date=?").bind(sid, entry.date),
    c.env.DB.prepare("SELECT * FROM staff_days_off WHERE shop_id=? AND date=?").bind(sid, entry.date),
    c.env.DB.prepare("SELECT id,staff_id,start_at,end_at,buffer_min,status FROM bookings WHERE shop_id=? AND date=? AND status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED')").bind(sid, entry.date),
    c.env.DB.prepare("SELECT * FROM staff_service_rules WHERE shop_id=? AND service_id=?").bind(sid, entry.service_id),
    c.env.DB.prepare("SELECT * FROM addons WHERE shop_id=?").bind(sid),
    c.env.DB.prepare("SELECT * FROM addon_services WHERE shop_id=? AND service_id=?").bind(sid, entry.service_id),
    // Slots already offered (pending) to someone else are not offered twice.
    c.env.DB.prepare("SELECT staff_id,start_min FROM waitlist_offers WHERE shop_id=? AND date=? AND status='PENDING' AND expires_at>? AND entry_id<>?").bind(sid, entry.date, now, entry.id),
  ]);
  const service = r[1].results[0] as Service | undefined;
  if (!service) return [];
  const rules = r[7].results as StaffServiceRule[];
  const pending = new Set((r[10].results as { staff_id: string; start_min: number }[]).map((o) => `${o.staff_id}:${o.start_min}`));
  const staff = (r[0].results as Staff[]).filter((s) => (!entry.staff_id || s.id === entry.staff_id) && rules.find((x) => x.staff_id === s.id)?.enabled !== 0);
  const minStart = now + shop.lead_time_min * 60000;
  const out: { staff_id: string; staff_name: string; start_min: number; price_pence: number; duration_min: number }[] = [];
  for (const st of staff) {
    const q = calculateQuote(service, rules.find((x) => x.staff_id === st.id) ?? null, r[8].results as Addon[], r[9].results as AddonLink[], []);
    const h = effectiveHours((r[2].results as Hours[]).find((x) => x.staff_id === st.id) ?? null, (r[3].results as ScheduleOverride[]).find((o) => o.staff_id === st.id) ?? null);
    for (let m = shop.opens; m < shop.closes; m += 15) {
      if (!inDaypart(m, entry.daypart) || pending.has(`${st.id}:${m}`)) continue;
      if (!slotReason(shop, st, h, r[4].results as Holiday[], r[6].results as StoredBooking[], entry.date, m, q.duration_min, minStart, undefined, r[5].results as StaffDayOff[])) {
        out.push({ staff_id: st.id, staff_name: st.name, start_min: m, price_pence: q.price_pence, duration_min: q.duration_min });
      }
    }
  }
  return out.sort((a, b) => a.start_min - b.start_min || a.staff_name.localeCompare(b.staff_name));
}

// ---- Housekeeping ---------------------------------------------------------------
// Lazily expire offers and past-date entries for a shop. Cheap; called on every queue read.
export async function sweep(c: Ctx, shop: Shop & ShopQueueSettings, now = Date.now()) {
  const today = shopToday(shop.timezone, now);
  const expired = await c.env.DB.prepare("SELECT o.*, e.customer_name, e.phone, e.email, e.date AS entry_date FROM waitlist_offers o JOIN waitlist_entries e ON e.id=o.entry_id WHERE o.shop_id=? AND o.status='PENDING' AND o.expires_at<=?")
    .bind(shop.id, now)
    .all<OfferRow & { customer_name: string; phone: string; email: string; entry_date: string }>();
  const statements: D1PreparedStatement[] = [];
  const templates = templatesOf(shop);
  for (const o of expired.results) {
    statements.push(
      c.env.DB.prepare("UPDATE waitlist_offers SET status='EXPIRED',responded_at=? WHERE id=? AND status='PENDING'").bind(now, o.id),
      c.env.DB.prepare("UPDATE waitlist_entries SET status='OPEN',offer_id=NULL,version=version+1,updated_at=? WHERE id=? AND status='OFFERED' AND offer_id=?").bind(now, o.entry_id, o.id),
      queueMessage(c, shop.id, o, "waitlist_released", render(templates.waitlist_released, { first: o.customer_name.split(" ")[0], shop: shop.name, date: fmtDate(o.entry_date) }), { type: "waitlist", id: o.entry_id }),
      c.env.DB.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid(), shop.id, "waitlist", o.entry_id, "WAITLIST_OFFER_EXPIRED", "system:waitlist", `Offer for ${o.date} ${fmtTime(o.start_min)} expired unanswered; customer returned to the queue.`, now),
    );
  }
  statements.push(c.env.DB.prepare("UPDATE waitlist_entries SET status='EXPIRED',version=version+1,updated_at=? WHERE shop_id=? AND status IN ('OPEN','OFFERED') AND date<?").bind(now, shop.id, today));
  await c.env.DB.batch(statements);
  // Re-offer freed slots to the next in line if auto-offer is on.
  if (shop.waitlist_auto_offer) for (const o of expired.results) await autoOffer(c, shop, { staff_id: o.staff_id, date: o.date, start_min: o.start_min }, "expiry");
}

// ---- Offers ------------------------------------------------------------------------
export async function makeOffer(c: Ctx, shop: Shop & ShopQueueSettings, entry: WaitlistRow, slot: { staff_id: string; start_min: number }, source: "MANUAL" | "AUTO", actor: string, now = Date.now()) {
  const staff = await c.env.DB.prepare("SELECT name FROM staff WHERE shop_id=? AND id=? AND active=1").bind(shop.id, slot.staff_id).first<{ name: string }>();
  const service = await c.env.DB.prepare("SELECT name FROM services WHERE shop_id=? AND id=?").bind(shop.id, entry.service_id).first<{ name: string }>();
  if (!staff || !service) return null;
  const raw = uid() + uid();
  const offerId = uid();
  const expires = now + shop.waitlist_offer_hold_min * 60000;
  const link = `${new URL(c.req.url).origin}/offer/${raw}`;
  const templates = templatesOf(shop);
  const body = render(templates.waitlist_offer, { first: entry.customer_name.split(" ")[0], shop: shop.name, service: service.name, barber: staff.name.split(" ")[0], date: fmtDate(entry.date), time: fmtTime(slot.start_min), expires: fmtStamp(expires, shop.timezone), link });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE waitlist_offers SET status='SUPERSEDED',responded_at=? WHERE shop_id=? AND entry_id=? AND status='PENDING'").bind(now, shop.id, entry.id),
    c.env.DB.prepare("INSERT INTO waitlist_offers(id,shop_id,entry_id,staff_id,service_id,date,start_min,token_hash,status,source,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,'PENDING',?,?,?)").bind(offerId, shop.id, entry.id, slot.staff_id, entry.service_id, entry.date, slot.start_min, await digest(raw), source, expires, now),
    c.env.DB.prepare("UPDATE waitlist_entries SET status='OFFERED',offer_id=?,offers_made=offers_made+1,version=version+1,updated_at=? WHERE id=? AND status IN ('OPEN','OFFERED')").bind(offerId, now, entry.id),
    queueMessage(c, shop.id, entry, "waitlist_offer", body, { type: "waitlist_offer", id: offerId }),
    c.env.DB.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid(), shop.id, "waitlist", entry.id, source === "AUTO" ? "WAITLIST_AUTO_OFFERED" : "WAITLIST_OFFERED", actor, `${service.name} with ${staff.name} on ${entry.date} at ${fmtTime(slot.start_min)} offered until ${fmtStamp(expires, shop.timezone)}. Message queued, not sent.`, now),
  ]);
  return { offer_id: offerId, link, expires_at: expires, body, staff_name: staff.name, service_name: service.name };
}

// A slot has just been freed (cancel, move, declined/expired offer). Offer it to the oldest OPEN
// entry that fits: same date, service the barber can do, daypart, preferred barber or any.
export async function autoOffer(c: Ctx, shop: Shop & ShopQueueSettings, freed: { staff_id: string; date: string; start_min: number }, why: string, now = Date.now()) {
  if (!shop.waitlist_auto_offer) return null;
  const today = shopToday(shop.timezone, now);
  if (freed.date < today) return null;
  // Skip anyone who already declined or let this exact slot lapse — the slot goes to the next in line, not back to them.
  const candidates = await c.env.DB.prepare(
    "SELECT e.* FROM waitlist_entries e WHERE e.shop_id=? AND e.status='OPEN' AND e.date=? AND (e.staff_id IS NULL OR e.staff_id=?) AND NOT EXISTS (SELECT 1 FROM waitlist_offers o WHERE o.entry_id=e.id AND o.staff_id=? AND o.start_min=? AND o.status IN ('DECLINED','EXPIRED')) ORDER BY e.created_at LIMIT 20",
  )
    .bind(shop.id, freed.date, freed.staff_id, freed.staff_id, freed.start_min)
    .all<WaitlistRow>();
  for (const entry of candidates.results) {
    if (!inDaypart(freed.start_min, entry.daypart)) continue;
    const matches = await matchesFor(c, shop, entry, now);
    const fit = matches.find((m) => m.staff_id === freed.staff_id && m.start_min === freed.start_min);
    if (!fit) continue;
    return makeOffer(c, shop, entry, { staff_id: freed.staff_id, start_min: freed.start_min }, "AUTO", `system:waitlist:${why}`, now);
  }
  return null;
}

// Load a shop with its queue settings.
export async function shopWithQueue(c: Ctx, shopId: string) {
  return (await c.env.DB.prepare("SELECT * FROM shops WHERE id=?").bind(shopId).first<Shop & ShopQueueSettings>())!;
}

export const helpers = { fmtDate, fmtTime, fmtStamp, daypartLabel, ref, localInstant };

// After a visit is completed: ask for a review through the customer's manage link (issued if
// needed; never rotated here so an existing link keeps working). Recorded in the outbox only.
export async function queueReviewRequest(c: Ctx, shopId: string, bookingId: string, now = Date.now()) {
  const shop = await shopWithQueue(c, shopId);
  const b = await c.env.DB.prepare("SELECT b.*, s.name AS staff_name FROM bookings b LEFT JOIN staff s ON s.shop_id=b.shop_id AND s.id=b.staff_id WHERE b.shop_id=? AND b.id=?").bind(shopId, bookingId).first<{ id: string; status: string; customer_name: string; attendee_name: string; phone: string; email: string; service_name: string; staff_name: string | null; channel: string }>();
  if (!b || b.status !== "COMPLETED" || (!b.phone && !b.email)) return null;
  const already = await c.env.DB.prepare("SELECT 1 FROM notifications WHERE shop_id=? AND template='review_request' AND related_type='booking' AND related_id=?").bind(shopId, bookingId).first();
  if (already) return null;
  let token = await c.env.DB.prepare("SELECT token_hash FROM booking_manage_tokens WHERE booking_id=?").bind(bookingId).first<{ token_hash: string }>();
  let raw: string | null = null;
  if (!token) {
    raw = uid() + uid();
    await c.env.DB.prepare("INSERT INTO booking_manage_tokens(token_hash,shop_id,booking_id,created_at) VALUES(?,?,?,?) ON CONFLICT(booking_id) DO NOTHING").bind(await digest(raw), shopId, bookingId, now).run();
    token = await c.env.DB.prepare("SELECT token_hash FROM booking_manage_tokens WHERE booking_id=?").bind(bookingId).first<{ token_hash: string }>();
    if (!token || token.token_hash !== (await digest(raw))) raw = null;
  }
  // When a link already exists we cannot recover the raw token; the message points at the shop's
  // account area instead, where the customer can review from their history.
  const link = raw ? `${new URL(c.req.url).origin}/manage/${raw}` : `${new URL(c.req.url).origin}/${shop.slug}/me`;
  const body = render(templatesOf(shop).review_request, { first: (b.attendee_name || b.customer_name).split(" ")[0], shop: shop.name, service: b.service_name, barber: (b.staff_name || "us").split(" ")[0], link });
  await queueMessage(c, shopId, b, "review_request", body, { type: "booking", id: bookingId }).run();
  return body;
}
