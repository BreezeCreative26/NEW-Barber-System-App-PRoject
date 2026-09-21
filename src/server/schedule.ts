// Schedule changes with conflict management.
//
// Any change that shrinks availability — dated hours, weekly hours, a day off, a shop closure —
// may land on appointments already booked. Rather than saving first and flagging later, the
// shop previews the change: we apply it to an in-memory copy of the roster, run the same
// `slotReason` the booking engine uses over every future appointment, and return each clash with
// up to three concrete alternatives. The shop then decides per appointment (move / keep / cancel /
// waitlist) and `apply` writes the change plus every decision in one pass, refunding deposits and
// messaging customers through their preferred channel. Nothing is written if the preview is stale.
import { z } from "zod";
import type { Context } from "hono";
import type { Database as DB, Statement } from "../db/client";
import {
  dateSchema,
  dayOffSchema,
  effectiveHours,
  holidaySchema,
  hoursSchema,
  localInstant,
  overrideSchema,
  ref,
  shopDay,
  slotReason,
  weekday,
  type Holiday,
  type Hours,
  type ScheduleOverride,
  type Shop,
  type Staff,
  type StaffBlock,
  type StaffDayOff,
  type StaffServiceRule,
  type StoredBooking,
} from "./domain";
import { channelsFor, enqueue, fmtDate, fmtTime, msgShop, drain } from "./messaging";
import { refundDeposit } from "./stripe";

export const changeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("override"), staff_id: z.string().uuid(), override_id: z.string().uuid().optional(), change: overrideSchema }),
  z.object({ kind: z.literal("weekly"), staff_id: z.string().uuid(), change: hoursSchema }),
  z.object({ kind: z.literal("day_off"), staff_id: z.string().uuid(), change: dayOffSchema }),
  z.object({ kind: z.literal("holiday"), change: holidaySchema }),
  z.object({ kind: z.literal("shop_week"), change: z.object({ week: z.array(z.object({ enabled: z.number().int().min(0).max(1), starts: z.number().int(), ends: z.number().int() })).length(7) }) }),
]);
export type ScheduleChange = z.infer<typeof changeSchema>;

export const decisionSchema = z.object({
  booking_id: z.string().uuid(),
  version: z.number().int(),
  action: z.enum(["MOVE", "KEEP", "CANCEL", "WAITLIST", "LATER"]),
  notify: z.boolean().default(true),
  move_to: z.object({ staff_id: z.string().uuid(), date: dateSchema, start_min: z.number().int().min(0).max(1425) }).optional(),
});
export type Decision = z.infer<typeof decisionSchema>;

export type Suggestion = { staff_id: string; staff_name: string; date: string; start_min: number; same_barber: boolean; same_day: boolean };
export type Conflict = {
  booking_id: string; ref: string; version: number; staff_id: string; staff_name: string;
  customer_name: string; attendee_name: string; phone: string; email: string; contact_pref: string; channel: string | null;
  service_id: string; service_name: string; date: string; start_min: number; duration_min: number; price_pence: number;
  deposit_status: string; deposit_paid_pence: number; series_id: string | null; reason: string;
  suggestions: Suggestion[];
};

type Roster = {
  shop: Shop; staff: Staff[]; hours: Hours[]; overrides: ScheduleOverride[]; daysOff: StaffDayOff[];
  holidays: Holiday[]; blocks: StaffBlock[]; rules: StaffServiceRule[]; bookings: (StoredBooking & { contact_pref: string | null; customer_email: string | null })[];
};

const HORIZON_DAYS = 60; // weekly-pattern changes are checked this far ahead; dated changes only touch their day

async function loadRoster(db: DB, shop: Shop, from: string, to: string): Promise<Roster> {
  const sid = shop.id;
  const r = await db.batch([
    db.prepare("SELECT * FROM staff WHERE shop_id=?").bind(sid),
    db.prepare("SELECT * FROM staff_hours WHERE shop_id=?").bind(sid),
    db.prepare("SELECT * FROM staff_schedule_overrides WHERE shop_id=? AND date BETWEEN ? AND ?").bind(sid, from, to),
    db.prepare("SELECT * FROM staff_days_off WHERE shop_id=? AND date BETWEEN ? AND ?").bind(sid, from, to),
    db.prepare("SELECT * FROM holidays WHERE shop_id=? AND date BETWEEN ? AND ?").bind(sid, from, to),
    db.prepare("SELECT * FROM staff_blocks WHERE shop_id=? AND date BETWEEN ? AND ?").bind(sid, from, to),
    db.prepare("SELECT * FROM staff_service_rules WHERE shop_id=?").bind(sid),
    db.prepare(
      "SELECT b.*, cu.contact_pref, cu.email AS customer_email FROM bookings b LEFT JOIN customers cu ON cu.id=b.customer_id WHERE b.shop_id=? AND b.date BETWEEN ? AND ? AND b.status IN ('CONFIRMED','CHECKED_IN') ORDER BY b.date, b.start_min",
    ).bind(sid, from, to),
  ]);
  return {
    shop,
    staff: r[0].results as Staff[],
    hours: r[1].results as Hours[],
    overrides: r[2].results as ScheduleOverride[],
    daysOff: r[3].results as StaffDayOff[],
    holidays: r[4].results as Holiday[],
    blocks: r[5].results as StaffBlock[],
    rules: r[6].results as StaffServiceRule[],
    bookings: r[7].results as Roster["bookings"],
  };
}

const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Apply the proposed change to a copy of the roster. Pure.
function patch(roster: Roster, change: ScheduleChange): Roster {
  const r: Roster = { ...roster, hours: [...roster.hours], overrides: [...roster.overrides], daysOff: [...roster.daysOff], holidays: [...roster.holidays], shop: { ...roster.shop } };
  if (change.kind === "override") {
    r.overrides = r.overrides.filter((o) => !(o.staff_id === change.staff_id && (o.id === change.override_id || o.date === change.change.date)));
    r.overrides.push({ id: change.override_id ?? "preview", shop_id: r.shop.id, staff_id: change.staff_id, version: 0, ...change.change } as ScheduleOverride);
  } else if (change.kind === "weekly") {
    r.hours = r.hours.filter((h) => h.staff_id !== change.staff_id);
    for (const row of change.change.rows) r.hours.push({ shop_id: r.shop.id, staff_id: change.staff_id, ...row } as Hours);
  } else if (change.kind === "day_off") {
    r.daysOff.push({ id: "preview", shop_id: r.shop.id, staff_id: change.staff_id, date: change.change.date, reason: change.change.reason, created_at: Date.now() });
  } else if (change.kind === "holiday") {
    r.holidays.push({ id: "preview", shop_id: r.shop.id, date: change.change.date, label: change.change.label });
  } else if (change.kind === "shop_week") {
    r.shop = { ...r.shop, week_json: JSON.stringify(change.change.week) } as Shop;
  }
  return r;
}

function reasonFor(r: Roster, b: StoredBooking, now: number, excludeBlocks = false): string {
  const staff = r.staff.find((s) => s.id === b.staff_id) ?? null;
  if (r.rules.some((x) => x.staff_id === b.staff_id && x.service_id === b.service_id && !x.enabled)) return "Barber no longer offers this service";
  const hours = effectiveHours(
    r.hours.find((h) => h.staff_id === b.staff_id && h.weekday === weekday(b.date)) ?? null,
    r.overrides.find((o) => o.staff_id === b.staff_id && o.date === b.date) ?? null,
  );
  // Evaluate the booking against the schedule only (not other bookings, not "time has passed").
  const why = slotReason(r.shop, staff, hours, r.holidays, [], b.date, b.start_min, b.duration_min, 0, b.id, r.daysOff, excludeBlocks ? [] : r.blocks);
  return why === "Time has passed" ? "" : why;
}

// Dates a change can touch: a dated change → that day; a pattern change → the horizon.
function window(change: ScheduleChange, today: string): { from: string; to: string } {
  if (change.kind === "override" || change.kind === "day_off" || change.kind === "holiday") return { from: change.change.date, to: change.change.date };
  return { from: today, to: plusDays(today, HORIZON_DAYS) };
}

function suggest(r: Roster, b: StoredBooking, max = 3): Suggestion[] {
  const out: Suggestion[] = [];
  const buf = 0; // slotReason applies the shop buffer itself
  void buf;
  const others = r.staff.filter((s) => s.active && s.id !== b.staff_id && !r.rules.some((x) => x.staff_id === s.id && x.service_id === b.service_id && !x.enabled));
  const tryDay = (staff: Staff, date: string, fromMin: number) => {
    const hours = effectiveHours(r.hours.find((h) => h.staff_id === staff.id && h.weekday === weekday(date)) ?? null, r.overrides.find((o) => o.staff_id === staff.id && o.date === date) ?? null);
    const dayBookings = r.bookings.filter((x) => x.staff_id === staff.id && x.date === date && x.id !== b.id);
    const day = shopDay(r.shop, weekday(date));
    for (let m = Math.max(0, fromMin); m < Math.min(1440, day.ends); m += 15) {
      if (!slotReason(r.shop, staff, hours, r.holidays, dayBookings, date, m, b.duration_min, Date.now(), b.id, r.daysOff, r.blocks)) return m;
    }
    return null;
  };
  const me = r.staff.find((s) => s.id === b.staff_id);
  const push = (staff: Staff, date: string, start_min: number) => {
    if (out.some((o) => o.staff_id === staff.id && o.date === date && o.start_min === start_min)) return;
    out.push({ staff_id: staff.id, staff_name: staff.name, date, start_min, same_barber: staff.id === b.staff_id, same_day: date === b.date });
  };
  // 1. Same barber, same day, nearest later then earlier
  if (me?.active) {
    const later = tryDay(me, b.date, b.start_min + 15);
    if (later !== null) push(me, b.date, later);
    else {
      const earlier = tryDay(me, b.date, 0);
      if (earlier !== null && earlier < b.start_min) push(me, b.date, earlier);
    }
  }
  // 2. Another barber, same day, same time or nearest after
  for (const s of others) {
    if (out.length >= max) break;
    const m = tryDay(s, b.date, b.start_min);
    if (m !== null) { push(s, b.date, m); break; }
  }
  // 3. Same barber, next 7 days, same time or nearest after
  if (me?.active) {
    for (let d = 1; d <= 7 && out.length < max; d++) {
      const date = plusDays(b.date, d);
      const m = tryDay(me, date, b.start_min);
      if (m !== null) { push(me, date, m); break; }
    }
  }
  // 4. Fill remaining with other barbers on later days
  for (let d = 1; d <= 7 && out.length < max; d++) {
    const date = plusDays(b.date, d);
    for (const s of others) {
      if (out.length >= max) break;
      const m = tryDay(s, date, b.start_min);
      if (m !== null) push(s, date, m);
    }
  }
  return out.slice(0, max);
}

export async function previewChange(db: DB, shop: Shop, today: string, change: ScheduleChange): Promise<{ conflicts: Conflict[]; summary: { count: number; value_pence: number; deposits_pence: number }; window: { from: string; to: string } }> {
  const win = window(change, today);
  // Suggestions may land up to 7 days past the window; load a little extra.
  const roster = await loadRoster(db, shop, win.from, plusDays(win.to, 7));
  const patched = patch(roster, change);
  const now = Date.now();
  const msgShopRow = await msgShop({ env: { DB: db } }, shop.id).catch(() => null);
  const conflicts: Conflict[] = [];
  for (const b of patched.bookings) {
    if (b.date < win.from || b.date > win.to) continue;
    if (b.start_at <= now) continue;
    const before = reasonFor(roster, b, now);
    const after = reasonFor(patched, b, now);
    if (!after || after === before) continue; // only new conflicts caused by this change
    const staff = patched.staff.find((s) => s.id === b.staff_id);
    const pref = (b.contact_pref || "AUTO") as "AUTO" | "SMS" | "WA" | "EMAIL" | "NONE";
    const to = { name: b.attendee_name || b.customer_name, phone: b.phone, email: b.email || b.customer_email || "" };
    const channel = !msgShopRow || pref === "NONE" ? null : (channelsFor(msgShopRow, to, pref === "AUTO" ? "AUTO" : pref)[0] ?? null);
    conflicts.push({
      booking_id: b.id, ref: ref(b), version: b.version, staff_id: b.staff_id, staff_name: staff?.name ?? "", customer_name: b.customer_name, attendee_name: b.attendee_name || "",
      phone: b.phone, email: to.email, contact_pref: pref, channel, service_id: b.service_id, service_name: b.service_name, date: b.date, start_min: b.start_min, duration_min: b.duration_min,
      price_pence: b.price_pence, deposit_status: b.deposit_status ?? "NONE", deposit_paid_pence: b.deposit_paid_pence ?? 0, series_id: b.series_id ?? null, reason: after,
      suggestions: suggest(patched, b),
    });
  }
  return {
    conflicts,
    summary: { count: conflicts.length, value_pence: conflicts.reduce((n, c) => n + c.price_pence, 0), deposits_pence: conflicts.reduce((n, c) => n + (c.deposit_status === "PAID" ? c.deposit_paid_pence : 0), 0) },
    window: win,
  };
}

export type Outcome = { booking_id: string; action: string; ok: boolean; note: string; notified: string[] };

// Apply decisions after the schedule change itself has been written. Each booking is version-guarded;
// a stale version records a failed outcome rather than aborting the others (the change is already in).
export async function applyDecisions(
  c: Context, db: DB, shop: Shop, actor: string, origin: string, why: string, change: ScheduleChange, decisions: Decision[],
  audit: (entity: string, id: string, action: string, reason: string) => Statement,
): Promise<Outcome[]> {
  const shopMsg = await msgShop(c, shop.id);
  const win = window(change, new Date().toISOString().slice(0, 10));
  const roster = await loadRoster(db, shop, win.from, plusDays(win.to, 7)); // post-write roster
  const outcome: Outcome[] = [];
  for (const d of decisions) {
    if (d.action === "LATER") { outcome.push({ booking_id: d.booking_id, action: "LATER", ok: true, note: "Left for review", notified: [] }); continue; }
    const b = roster.bookings.find((x) => x.id === d.booking_id);
    if (!b) { outcome.push({ booking_id: d.booking_id, action: d.action, ok: false, note: "Appointment not found", notified: [] }); continue; }
    if (b.version !== d.version) { outcome.push({ booking_id: d.booking_id, action: d.action, ok: false, note: "Changed elsewhere — review it", notified: [] }); continue; }
    const staff = roster.staff.find((s) => s.id === b.staff_id);
    const first = (staff?.name ?? "").split(" ")[0];
    const pref = (b.contact_pref || "AUTO") as "AUTO" | "SMS" | "WA" | "EMAIL" | "NONE";
    const to = { name: b.attendee_name || b.customer_name, phone: b.phone, email: b.email || b.customer_email || "" };
    const ch = pref === "NONE" ? null : pref;
    const vars = { service: b.service_name, barber: first, date: fmtDate(b.date), time: fmtTime(b.start_min), ref: ref(b), link: `${origin}/${shop.slug}/me`, book_link: `${origin}/book/${shop.slug}`, address: shop.address };
    let notified: string[] = [];
    try {
      if (d.action === "KEEP") {
        await db.batch([audit("booking", b.id, "SCHEDULE_OVERRIDE_KEPT", `Kept although ${why.toLowerCase()}: shop chose to honour it.`)]);
        outcome.push({ booking_id: b.id, action: "KEEP", ok: true, note: "Kept as booked", notified: [] });
      } else if (d.action === "CANCEL" || d.action === "WAITLIST") {
        const r = await db.batch([
          db.prepare("UPDATE bookings SET status='CANCELLED', version=version+1, updated_at=? WHERE shop_id=? AND id=? AND version=?").bind(Date.now(), shop.id, b.id, b.version),
          audit("booking", b.id, "STATUS_CANCELLED", `Cancelled by the shop: ${why}.`),
        ]);
        if (!r[0].meta.changes) throw new Error("Changed elsewhere");
        if (b.deposit_status === "PAID") await refundDeposit(db, shop, b, actor, `cancelled: ${why}`);
        if (d.action === "WAITLIST") {
          const daypart = b.start_min < 12 * 60 ? "MORNING" : b.start_min < 17 * 60 ? "AFTERNOON" : "EVENING";
          await db.prepare(
            "INSERT INTO waitlist_entries(id,shop_id,staff_id,service_id,customer_name,phone,email,date,daypart,notes,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'OPEN',?,?) ON CONFLICT(shop_id,date,phone,service_id) DO NOTHING",
          ).bind(crypto.randomUUID(), shop.id, b.staff_id, b.service_id, b.customer_name, b.phone, to.email, b.date, daypart, `Added when ${why.toLowerCase()}; had ${fmtTime(b.start_min)}.`, Date.now(), Date.now()).run().catch(() => {});
        }
        if (d.notify && ch) {
          const q = enqueue(db, shopMsg, to, "booking_cancelled", vars, { related: { type: "booking", id: b.id }, origin, channel: ch });
          if (q.length) { await db.batch(q); notified = channelsFor(shopMsg, to, ch); }
        }
        outcome.push({ booking_id: b.id, action: d.action, ok: true, note: `${d.action === "WAITLIST" ? "Cancelled · on the waitlist" : "Cancelled"}${b.deposit_status === "PAID" ? " · deposit refunded" : ""}`, notified });
      } else if (d.action === "MOVE" && d.move_to) {
        const target = roster.staff.find((s) => s.id === d.move_to!.staff_id);
        if (!target) throw new Error("Barber not found");
        const hours = effectiveHours(roster.hours.find((h) => h.staff_id === target.id && h.weekday === weekday(d.move_to!.date)) ?? null, roster.overrides.find((o) => o.staff_id === target.id && o.date === d.move_to!.date) ?? null);
        const dayBookings = roster.bookings.filter((x) => x.staff_id === target.id && x.date === d.move_to!.date && x.id !== b.id);
        const bad = slotReason(shop, target, hours, roster.holidays, dayBookings, d.move_to.date, d.move_to.start_min, b.duration_min, Date.now(), b.id, roster.daysOff, roster.blocks);
        if (bad) throw new Error(bad);
        const start = localInstant(d.move_to.date, d.move_to.start_min, shop.timezone)!;
        const r = await db.batch([
          db.prepare("UPDATE bookings SET staff_id=?,date=?,start_min=?,start_at=?,end_at=?,version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?").bind(target.id, d.move_to.date, d.move_to.start_min, start, start + b.duration_min * 60000, Date.now(), shop.id, b.id, b.version),
          audit("booking", b.id, "RESCHEDULED", `Moved by the shop: ${why}.`),
        ]);
        if (!r[0].meta.changes) throw new Error("Changed elsewhere");
        // keep the in-memory roster honest for subsequent decisions
        Object.assign(b, { staff_id: target.id, date: d.move_to.date, start_min: d.move_to.start_min, start_at: start, end_at: start + b.duration_min * 60000, version: b.version + 1 });
        const nb = target.name.split(" ")[0];
        if (d.notify && ch) {
          const q = enqueue(db, shopMsg, to, "booking_moved", { ...vars, barber: nb, date: fmtDate(d.move_to.date), time: fmtTime(d.move_to.start_min) }, { related: { type: "booking", id: b.id }, origin, channel: ch });
          if (q.length) { await db.batch(q); notified = channelsFor(shopMsg, to, ch); }
        }
        outcome.push({ booking_id: b.id, action: "MOVE", ok: true, note: `Moved to ${fmtDate(d.move_to.date)} ${fmtTime(d.move_to.start_min)} with ${nb}`, notified });
      } else {
        outcome.push({ booking_id: b.id, action: d.action, ok: false, note: "No target time chosen", notified: [] });
      }
    } catch (err) {
      outcome.push({ booking_id: b.id, action: d.action, ok: false, note: err instanceof Error ? err.message : "Failed", notified: [] });
    }
  }
  await drain(db, 10).catch(() => {});
  return outcome;
}

export const describeChange = (change: ScheduleChange, staffName?: string): string => {
  const who = staffName ? staffName.split(" ")[0] : "the shop";
  switch (change.kind) {
    case "override": return change.change.enabled ? `${who}'s hours on ${fmtDate(change.change.date)} changed to ${fmtTime(change.change.starts)}–${fmtTime(change.change.ends)}` : `${who} is off on ${fmtDate(change.change.date)}`;
    case "weekly": return `${who}'s weekly hours changed`;
    case "day_off": return `${who} is off on ${fmtDate(change.change.date)} (${change.change.reason})`;
    case "holiday": return `the shop is closed on ${fmtDate(change.change.date)} (${change.change.label})`;
    case "shop_week": return "the shop's opening hours changed";
  }
};
