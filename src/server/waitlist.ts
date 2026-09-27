// Waiting list procedure: matching, offers, auto-offer on freed slots, and the notifications outbox.
// See docs/WAITLIST-PLAN.md. Messages are queued through messaging.ts (shop-branded SMS/email) and
// drained right after each batch; the offer link is also surfaced to staff.
import type { Context } from "hono";
import type { Statement as D1PreparedStatement } from "../db/client";
import { z } from "zod";
import { calculateQuote, dayStarts, effectiveHours, localInstant, ref, shopToday, slotReason, weekday, type Addon, type AddonLink, type Holiday, type Hours, type ScheduleOverride, type Service, type Shop, type Staff, type StaffDayOff, type StaffServiceRule, type StoredBooking } from "./domain";
import type { AppEnv } from "./accounts";
import { digest } from "./accounts";
import { drain, emailHtml, type MessageTemplate } from "./messaging";
import { brandOf } from "./domain";

type Ctx = Context<AppEnv>;
const uid = () => crypto.randomUUID();

export type WaitlistRow = {
  id: string; shop_id: string; staff_id: string | null; service_id: string; customer_name: string; phone: string; email: string; date: string;
  daypart: "ANY" | "MORNING" | "AFTERNOON" | "EVENING"; notes: string; status: "OPEN" | "OFFERED" | "BOOKED" | "CLOSED" | "EXPIRED";
  booking_id: string | null; offer_id: string | null; offers_made: number; version: number; created_at: number; updated_at: number;
  // v2: the day window (minutes from midnight) and the last date of a range. `date` is the first.
  date_to: string; from_min: number; to_min: number;
};
export type OfferRow = {
  id: string; shop_id: string; entry_id: string; staff_id: string; service_id: string; date: string; start_min: number; token_hash: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "SUPERSEDED" | "LOST"; source: "MANUAL" | "AUTO"; booking_id: string | null;
  expires_at: number; created_at: number; responded_at: number | null;
};
export type ShopQueueSettings = {
  waitlist_auto_offer: number; waitlist_offer_hold_min: number; waitlist_templates_json: string;
  // ORDER: soft-hold offer to the next in line. EVERYONE: announce to all who fit; first to book wins.
  waitlist_mode: "ORDER" | "EVERYONE";
  // Minutes a freed slot waits before anyone is told, so the shop can re-book by hand first.
  waitlist_delay_min: number;
};
// Daypart presets ↔ minute windows. The customer picks a preset or an explicit window; we store both.
export const DAYPART_WINDOW: Record<WaitlistRow["daypart"], [number, number]> = { ANY: [0, 1440], MORNING: [0, 720], AFTERNOON: [720, 1020], EVENING: [1020, 1440] };
export function daypartFor(from: number, to: number): WaitlistRow["daypart"] {
  for (const k of ["MORNING", "AFTERNOON", "EVENING"] as const) { const [a, b] = DAYPART_WINDOW[k]; if (from === a && to === b) return k; }
  return "ANY";
}

// ---- Templates -------------------------------------------------------------
export const TEMPLATE_KEYS = ["waitlist_joined", "waitlist_offer", "waitlist_open", "waitlist_booked", "waitlist_released", "review_request"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export const DEFAULT_TEMPLATES: Record<TemplateKey, string> = {
  waitlist_joined: "Hi {first}, you're on the list at {shop} for {date} ({daypart}). We'll message you if a time opens up.",
  waitlist_offer: "Hi {first}, a {service} with {barber} has opened at {shop} on {date} at {time}. It's held for you until {expires}: {link}",
  waitlist_open: "Hi {first}, a {service} with {barber} has just opened at {shop} on {date} at {time}. First to book gets it: {link}",
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
// Preset windows read as words ("morning"); anything else as an explicit HH:MM–HH:MM range.
export const fmtWindow = (from: number, to: number) => {
  for (const k of ["ANY", "MORNING", "AFTERNOON", "EVENING"] as const) { const [a, b] = DAYPART_WINDOW[k]; if (from === a && to === b) return daypartLabel[k]; }
  return `${fmtTime(from)}–${fmtTime(to >= 1440 ? 1439 : to)}`;
};
// Inclusive ISO dates from..to (capped so a runaway range can't fan out).
export function rangeDates(from: string, to: string, cap = 31) {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < cap; i++) {
    const iso = d.toISOString().slice(0, 10);
    if (iso > to) break;
    out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
export const fmtRange = (from: string, to: string) => (from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`);

// Outbox write. The owner's editable template is the SMS text; email wraps the same text in the
// shop-branded shell. Channel is SMS when we have a mobile, EMAIL otherwise. Row is QUEUED; callers
// run drainSoon() after their batch so it goes out within the request.
type MsgShopLite = { id: string; name: string; address: string; slug: string | null; msg_sms?: number; msg_email?: number; logo_url?: string; accent?: string; theme_json?: string; phone?: string; email?: string };
const SUBJECTS: Record<TemplateKey, (shop: string) => string> = {
  waitlist_joined: (s) => `You're on the list at ${s}`,
  waitlist_offer: (s) => `A time has opened at ${s}`,
  waitlist_open: (s) => `A time has just opened at ${s}`,
  waitlist_booked: (s) => `You're booked at ${s}`,
  waitlist_released: (s) => `Back on the list at ${s}`,
  review_request: (s) => `How was your visit to ${s}?`,
};
export function queueMessage(c: Ctx, shop: MsgShopLite | string, to: { phone: string; email: string }, template: TemplateKey, body: string, related: { type: string; id: string }) {
  const sh: MsgShopLite = typeof shop === "string" ? { id: shop, name: "", address: "", slug: null } : shop;
  const sms = !!to.phone && (sh.msg_sms ?? 1) === 1;
  const email = !!to.email && (sh.msg_email ?? 1) === 1;
  const channel = sms ? "SMS" : email ? "EMAIL" : to.phone ? "SMS" : "EMAIL";
  const link = body.match(/https?:\/\/\S+/)?.[0];
  const subject = channel === "EMAIL" ? SUBJECTS[template](sh.name || "the shop") : "";
  const html = channel === "EMAIL"
    ? emailHtml(sh, brandOf(sh), new URL(c.req.url).origin, { sms: body, subject, heading: subject, lines: [body.replace(/https?:\/\/\S+/g, "").trim()], cta: link ? { label: "Open", href: link } : undefined }, { phone: sh.phone, email: sh.email })
    : "";
  const now = Date.now();
  return c.env.DB.prepare(
    "INSERT INTO notifications(id,shop_id,channel,recipient,template,body,subject,html,status,status_note,related_type,related_id,created_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,'QUEUED','',?,?,?,?)",
  ).bind(uid(), sh.id, channel, channel === "SMS" ? to.phone : to.email, template, body, subject, html, related.type, related.id, now, now);
}
// Scoped to the record whose message was just queued, so a backlog can never starve it.
export const drainSoon = (c: Ctx, n = 5, related?: { type: string; id: string }) => drain(c.env.DB, n, Date.now(), related).catch(() => undefined);
export type { MessageTemplate };

// ---- Matching ----------------------------------------------------------------
const inDaypart = (m: number, part: string) => part === "ANY" || (part === "MORNING" && m < 720) || (part === "AFTERNOON" && m >= 720 && m < 1020) || (part === "EVENING" && m >= 1020);
// v2 entries carry an explicit window; legacy rows (from_min 0 / to_min 1440 with a daypart) fall back to the preset.
const inWindow = (m: number, e: Pick<WaitlistRow, "from_min" | "to_min" | "daypart">) =>
  e.from_min === 0 && e.to_min === 1440 ? inDaypart(m, e.daypart) : m >= e.from_min && m < e.to_min;
const inRange = (d: string, e: Pick<WaitlistRow, "date" | "date_to">) => d >= e.date && d <= (e.date_to || e.date);

// Open times on the entry's date that fit its request. Barber-agnostic when staff_id is null.
export async function matchesFor(c: Ctx, shop: Shop & ShopQueueSettings, entry0: WaitlistRow, now = Date.now(), onDate?: string) {
  // For a date-range entry the caller says which day to look at; default is the first day.
  const entry = onDate && onDate !== entry0.date ? { ...entry0, date: onDate } : entry0;
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
    for (const m of dayStarts(shop, entry.date)) {
      if (!inWindow(m, entry) || pending.has(`${st.id}:${m}`)) continue;
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
      queueMessage(c, shop, o, "waitlist_released", render(templates.waitlist_released, { first: o.customer_name.split(" ")[0], shop: shop.name, date: fmtDate(o.entry_date) }), { type: "waitlist", id: o.entry_id }),
      c.env.DB.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid(), shop.id, "waitlist", o.entry_id, "WAITLIST_OFFER_EXPIRED", "system:waitlist", `Offer for ${o.date} ${fmtTime(o.start_min)} expired unanswered; customer returned to the queue.`, now),
    );
  }
  statements.push(c.env.DB.prepare("UPDATE waitlist_entries SET status='EXPIRED',version=version+1,updated_at=? WHERE shop_id=? AND status IN ('OPEN','OFFERED') AND date<?").bind(now, shop.id, today));
  await c.env.DB.batch(statements);
  if (expired.results.length) await drainSoon(c, expired.results.length);
  // Re-offer freed slots to the next in line if auto-offer is on (an expired hold is already "old news" — no extra delay).
  if (shop.waitlist_auto_offer) for (const o of expired.results) await releaseSlot(c, shop, { staff_id: o.staff_id, date: o.date, start_min: o.start_min }, "expiry", now);
  await releaseDueSlots(c, shop, now);
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
    queueMessage(c, shop, entry, "waitlist_offer", body, { type: "waitlist_offer", id: offerId }),
    c.env.DB.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid(), shop.id, "waitlist", entry.id, source === "AUTO" ? "WAITLIST_AUTO_OFFERED" : "WAITLIST_OFFERED", actor, `${service.name} with ${staff.name} on ${entry.date} at ${fmtTime(slot.start_min)} offered until ${fmtStamp(expires, shop.timezone)}. Message queued, not sent.`, now),
  ]);
  await drainSoon(c, 2, { type: "waitlist_offer", id: offerId });
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
    "SELECT e.* FROM waitlist_entries e WHERE e.shop_id=? AND e.status='OPEN' AND e.date<=? AND e.date_to>=? AND (e.staff_id IS NULL OR e.staff_id=?) AND NOT EXISTS (SELECT 1 FROM waitlist_offers o WHERE o.entry_id=e.id AND o.staff_id=? AND o.date=? AND o.start_min=? AND o.status IN ('DECLINED','EXPIRED')) ORDER BY e.created_at LIMIT 20",
  )
    .bind(shop.id, freed.date, freed.date, freed.staff_id, freed.staff_id, freed.date, freed.start_min)
    .all<WaitlistRow>();
  for (const entry of candidates.results) {
    if (!inRange(freed.date, entry) || !inWindow(freed.start_min, entry)) continue;
    const matches = await matchesFor(c, shop, entry, now, freed.date);
    const fit = matches.find((m) => m.staff_id === freed.staff_id && m.start_min === freed.start_min);
    if (!fit) continue;
    return makeOffer(c, shop, { ...entry, date: freed.date }, { staff_id: freed.staff_id, start_min: freed.start_min }, "AUTO", `system:waitlist:${why}`, now);
  }
  return null;
}

// EVERYONE mode: tell every OPEN entry that fits the freed slot, once per (entry, slot). No hold —
// the link opens the booking flow with that slot preselected and the first to confirm gets it.
export async function announceToAll(c: Ctx, shop: Shop & ShopQueueSettings, freed: { staff_id: string; date: string; start_min: number }, why: string, now = Date.now()) {
  const rows = await c.env.DB.prepare(
    "SELECT e.* FROM waitlist_entries e WHERE e.shop_id=? AND e.status='OPEN' AND e.date<=? AND e.date_to>=? AND (e.staff_id IS NULL OR e.staff_id=?) AND NOT EXISTS (SELECT 1 FROM waitlist_announcements a WHERE a.entry_id=e.id AND a.staff_id=? AND a.date=? AND a.start_min=?) ORDER BY e.created_at LIMIT 200",
  ).bind(shop.id, freed.date, freed.date, freed.staff_id, freed.staff_id, freed.date, freed.start_min).all<WaitlistRow>();
  const fits = rows.results.filter((e) => inRange(freed.date, e) && inWindow(freed.start_min, e));
  if (!fits.length) return 0;
  const staff = await c.env.DB.prepare("SELECT name FROM staff WHERE shop_id=? AND id=? AND active=1").bind(shop.id, freed.staff_id).first<{ name: string }>();
  if (!staff) return 0;
  const templates = templatesOf(shop);
  const origin = new URL(c.req.url).origin;
  const stmts: D1PreparedStatement[] = [];
  let told = 0;
  for (const e of fits) {
    // The slot must actually be bookable for this entry's service by this barber right now.
    const matches = await matchesFor(c, shop, e, now, freed.date);
    if (!matches.find((m) => m.staff_id === freed.staff_id && m.start_min === freed.start_min)) continue;
    const service = await c.env.DB.prepare("SELECT name FROM services WHERE shop_id=? AND id=?").bind(shop.id, e.service_id).first<{ name: string }>();
    const link = `${origin}/book/${shop.slug}?service=${e.service_id}&staff=${freed.staff_id}&date=${freed.date}&start=${freed.start_min}&step=2&wl=${e.id}`;
    const body = render(templates.waitlist_open, { first: e.customer_name.split(" ")[0], shop: shop.name, service: service?.name || "visit", barber: staff.name.split(" ")[0], date: fmtDate(freed.date), time: fmtTime(freed.start_min), link });
    stmts.push(
      c.env.DB.prepare("INSERT INTO waitlist_announcements(id,shop_id,entry_id,staff_id,date,start_min,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").bind(uid(), shop.id, e.id, freed.staff_id, freed.date, freed.start_min, now),
      queueMessage(c, shop, e, "waitlist_open", body, { type: "waitlist", id: e.id }),
    );
    told++;
  }
  if (told) {
    stmts.push(c.env.DB.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid(), shop.id, "waitlist", `${freed.staff_id}:${freed.date}:${freed.start_min}`, "WAITLIST_ANNOUNCED", `system:waitlist:${why}`, `${staff.name} ${freed.date} ${fmtTime(freed.start_min)} announced to ${told} waiting customer${told === 1 ? "" : "s"}; first to book gets it.`, now));
    await c.env.DB.batch(stmts);
    await drainSoon(c, told + 1);
  }
  return told;
}

// A slot has just freed. Don't tell anyone yet: park it for `waitlist_delay_min` so the shop can
// re-book by hand (cancel → book someone else) without a text firing. The sweep releases it.
// Delay 0 = act now. Re-freeing the same slot pushes the timer back.
export async function slotFreed(c: Ctx, shop: Shop & ShopQueueSettings, freed: { staff_id: string; date: string; start_min: number }, why: string, now = Date.now()) {
  if (!shop.waitlist_auto_offer) return null;
  const today = shopToday(shop.timezone, now);
  if (freed.date < today) return null;
  const delay = Math.max(0, Number(shop.waitlist_delay_min ?? 5));
  if (delay === 0) return releaseSlot(c, shop, freed, why, now);
  await c.env.DB.prepare(
    "INSERT INTO waitlist_pending_slots(shop_id,staff_id,date,start_min,why,freed_at,notify_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(shop_id,staff_id,date,start_min) DO UPDATE SET why=EXCLUDED.why, freed_at=EXCLUDED.freed_at, notify_at=EXCLUDED.notify_at",
  ).bind(shop.id, freed.staff_id, freed.date, freed.start_min, why, now, now + delay * 60000).run();
  return { pending: true, notify_at: now + delay * 60000 };
}
// Actually offer / announce a freed slot, according to the shop's mode.
async function releaseSlot(c: Ctx, shop: Shop & ShopQueueSettings, freed: { staff_id: string; date: string; start_min: number }, why: string, now = Date.now()) {
  if (shop.waitlist_mode === "EVERYONE") return announceToAll(c, shop, freed, why, now);
  return autoOffer(c, shop, freed, why, now);
}
// Sweep step: every parked slot whose delay has passed. If it has been re-filled meanwhile the row is
// simply dropped (that's the whole point of the delay). Called from the shop sweep and the cron.
export async function releaseDueSlots(c: Ctx, shop: Shop & ShopQueueSettings, now = Date.now()) {
  const due = await c.env.DB.prepare("SELECT * FROM waitlist_pending_slots WHERE shop_id=? AND notify_at<=? ORDER BY notify_at LIMIT 50").bind(shop.id, now).all<{ staff_id: string; date: string; start_min: number; why: string }>();
  let acted = 0;
  for (const s of due.results) {
    await c.env.DB.prepare("DELETE FROM waitlist_pending_slots WHERE shop_id=? AND staff_id=? AND date=? AND start_min=?").bind(shop.id, s.staff_id, s.date, s.start_min).run();
    const taken = await c.env.DB.prepare(
      "SELECT 1 AS x FROM bookings WHERE shop_id=? AND staff_id=? AND date=? AND status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED') AND start_min<=? AND start_min+duration_min>? LIMIT 1",
    ).bind(shop.id, s.staff_id, s.date, s.start_min, s.start_min).first();
    if (taken) continue; // shop filled it by hand — nobody needed to know
    const r = await releaseSlot(c, shop, s, `${s.why}+delay`, now);
    if (r) acted++;
  }
  return acted;
}

// Load a shop with its queue settings.
// Platform pass (lazy sweep / cron): release every parked slot whose delay has passed, across all
// shops that have one. Builds a minimal request context because message links need the origin.
export async function sweepWaitlistPlatform(db: Ctx["env"]["DB"], origin: string, now = Date.now()) {
  const due = await db.prepare("SELECT DISTINCT shop_id FROM waitlist_pending_slots WHERE notify_at<=? LIMIT 100").bind(now).all<{ shop_id: string }>();
  if (!due.results.length) return 0;
  const c = { env: { DB: db }, req: { url: `${origin}/api/cron/messages` } } as unknown as Ctx;
  let acted = 0;
  for (const { shop_id } of due.results) {
    const shop = await shopWithQueue(c, shop_id);
    if (!shop) continue;
    acted += await releaseDueSlots(c, shop, now).catch(() => 0);
  }
  return acted;
}

export async function shopWithQueue(c: Ctx, shopId: string) {
  return (await c.env.DB.prepare("SELECT s.*, COALESCE(p.logo_url,'') AS logo_url, COALESCE(p.accent,'ollo') AS accent, COALESCE(p.theme_json,'{}') AS theme_json, COALESCE(p.phone,'') AS page_phone, COALESCE(p.email,'') AS page_email FROM shops s LEFT JOIN shop_pages p ON p.shop_id=s.id WHERE s.id=?").bind(shopId).first<Shop & ShopQueueSettings & { logo_url: string; accent: string; theme_json: string; page_phone: string; page_email: string }>())!;
}

export const helpers = { fmtDate, fmtTime, fmtStamp, daypartLabel, ref, localInstant, fmtWindow, fmtRange, daypartFor, rangeDates, DAYPART_WINDOW };

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
  await queueMessage(c, shop, b, "review_request", body, { type: "booking", id: bookingId }).run();
  await drainSoon(c, 2, { type: "booking", id: bookingId });
  return body;
}
