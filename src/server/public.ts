import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  addonIdsSchema,
  calculateQuote,
  dateSchema,
  effectiveHours,
  localInstant,
  publicBookingSchema,
  groupBookingSchema,
  ref,
  shopToday,
  slotReason,
  weekday,
  type Addon,
  type AddonLink,
  type BookingItem,
  type Holiday,
  type Hours,
  type ScheduleOverride,
  type Service,
  type Shop,
  type Staff,
  type StaffDayOff,
  type StaffServiceRule,
  type StoredBooking,
  type ShopPage,
  defaultShopPage,
} from "./domain";
import { readInput, digest, sameOrigin, type AppEnv } from "./accounts";
import customerAccounts from "./customers";
import { autoOffer, helpers as wl, queueMessage, render, shopWithQueue, sweep, templatesOf, type OfferRow, type WaitlistRow } from "./waitlist";
import { leaveReview, ownReviewView, publicReviews, reviewEligibility, reviewForBooking, reviewSchema } from "./presence";
import {
  audit,
  availabilityContext,
  checkVersionUpdate,
  createBooking,
  fail,
  handleError,
  readBooking,
} from "./sandbox";

// Customer-facing booking. No account: the shop is chosen by public address and
// a saved visit is reachable only through its hashed manage link. Every write
// reuses the owner code path so quotes, availability and D1 guards are identical.
export type Ctx = Context<AppEnv>;
const pub = new Hono<AppEnv>();
const uid = () => crypto.randomUUID();
export const datePlus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export function clientKey(c: Ctx) {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
    "local"
  );
}
export async function throttle(c: Ctx, action: string, identity: string, max = 20) {
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `INSERT INTO auth_throttle(key_hash,attempts,resets_at) VALUES(?,1,?) ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN resets_at<=? THEN 1 ELSE attempts+1 END,resets_at=CASE WHEN resets_at<=? THEN excluded.resets_at ELSE resets_at END RETURNING attempts`,
  )
    .bind(await digest(`public:${action}:${identity}`), now + 600000, now, now)
    .first<{ attempts: number }>();
  if (row!.attempts > max) {
    c.header("Retry-After", "600");
    fail(429, "Too many attempts. Wait ten minutes before retrying.");
  }
}
export const publicGuard = async (c: Ctx, next: () => Promise<void>) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  if (c.env?.APP_MODE !== "sandbox" || !c.env.DB)
    return c.json(
      {
        error: "sandbox_disabled",
        message: "Online booking is disabled outside the local sandbox.",
      },
      404,
    );
  if (!["GET", "HEAD"].includes(c.req.method)) {
    if (!sameOrigin(c))
      return c.json(
        { error: "origin_forbidden", message: "Same-origin requests are required." },
        403,
      );
  }
  c.set("account", null);
  c.set("actor", "customer:online");
  await next();
};
pub.use("*", publicGuard);
pub.onError(handleError);
// Customer accounts live in their own module; mounted after the guard so it applies to them too.
pub.route("/shops/:slug/account", customerAccounts);

export async function shopBySlug(c: Ctx, slug: string) {
  const shop = await c.env.DB.prepare(
    "SELECT * FROM shops WHERE slug=? AND online_booking=1",
  )
    .bind(slug.toLowerCase())
    .first<Shop>();
  if (!shop) return fail(404, "This shop is not taking online bookings");
  c.set("shopId", shop.id);
  return shop;
}
// Customers may not book inside the lead time or beyond the booking window.
export function limits(shop: Shop, now = Date.now()) {
  const today = shopToday(shop.timezone, now);
  return {
    today,
    minStart: now + shop.lead_time_min * 60000,
    maxDate: datePlus(today, shop.booking_window_days),
  };
}
const publicShop = (s: Shop) => ({
  id: s.id,
  name: s.name,
  address: s.address,
  slug: s.slug,
  timezone: s.timezone,
  opens: s.opens,
  closes: s.closes,
  closed_days: JSON.parse(s.closed_days) as number[],
  deposit_pence: s.deposit_pence,
  cancel_hours: s.cancel_hours,
  lead_time_min: s.lead_time_min,
  booking_window_days: s.booking_window_days,
  version: s.version,
});

pub.get("/shops/:slug", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug"));
  const sid = shop.id;
  const r = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT id,name,role,title,bio,colour,photo_url,skills,instagram FROM staff WHERE shop_id=? AND active=1 AND online_visible=1 ORDER BY sort_order,name",
    ).bind(sid),
    c.env.DB.prepare(
      "SELECT id,name,category,duration_min,price_pence,version,description,colour,popular FROM services WHERE shop_id=? AND active=1 AND online_bookable=1 ORDER BY popular DESC,sort_order,category,name",
    ).bind(sid),
    c.env.DB.prepare(
      "SELECT id,name,price_pence,duration_min FROM addons WHERE shop_id=? AND active=1 ORDER BY name",
    ).bind(sid),
    c.env.DB.prepare(
      "SELECT addon_id,service_id FROM addon_services WHERE shop_id=?",
    ).bind(sid),
    c.env.DB.prepare(
      "SELECT staff_id,service_id,enabled,price_pence,duration_min FROM staff_service_rules WHERE shop_id=?",
    ).bind(sid),
    c.env.DB.prepare(
      "SELECT staff_id,weekday,enabled,starts,ends FROM staff_hours WHERE shop_id=?",
    ).bind(sid),
  ]);
  const { today, maxDate } = limits(shop);
  return c.json({
    shop: publicShop(shop),
    staff: r[0].results,
    services: r[1].results,
    addons: r[2].results,
    addon_links: r[3].results,
    service_rules: r[4].results,
    hours: r[5].results,
    today,
    max_date: maxDate,
    now: Date.now(),
    mode: "sandbox",
    livePayments: false,
  });
});


// Load everything needed to evaluate slots for one or more barbers over a date range in one batch.
export async function rangeContext(
  c: Ctx,
  shop: Shop,
  staffIds: string[] | null,
  serviceId: string,
  from: string,
  to: string,
  addonIds: string[],
) {
  const sid = shop.id;
  const r = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM staff WHERE shop_id=? AND active=1 AND online_visible=1 ORDER BY sort_order,name").bind(sid),
    c.env.DB.prepare("SELECT * FROM services WHERE shop_id=? AND id=? AND active=1 AND online_bookable=1").bind(sid, serviceId),
    c.env.DB.prepare("SELECT * FROM staff_hours WHERE shop_id=?").bind(sid),
    c.env.DB.prepare(
      "SELECT * FROM staff_schedule_overrides WHERE shop_id=? AND date BETWEEN ? AND ?",
    ).bind(sid, from, to),
    c.env.DB.prepare("SELECT * FROM holidays WHERE shop_id=? AND date BETWEEN ? AND ?").bind(sid, from, to),
    c.env.DB.prepare("SELECT * FROM staff_days_off WHERE shop_id=? AND date BETWEEN ? AND ?").bind(sid, from, to),
    c.env.DB.prepare(
      "SELECT id,staff_id,start_at,end_at,buffer_min,status FROM bookings WHERE shop_id=? AND date BETWEEN ? AND ? AND status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED')",
    ).bind(sid, from, to),
    c.env.DB.prepare("SELECT * FROM staff_service_rules WHERE shop_id=? AND service_id=?").bind(sid, serviceId),
    c.env.DB.prepare("SELECT * FROM addons WHERE shop_id=?").bind(sid),
    c.env.DB.prepare("SELECT * FROM addon_services WHERE shop_id=? AND service_id=?").bind(sid, serviceId),
  ]);
  const service = r[1].results[0] as Service | undefined;
  if (!service) fail(404, "Service is not available");
  const rules = r[7].results as StaffServiceRule[];
  const staff = (r[0].results as Staff[]).filter(
    (s) =>
      (!staffIds || staffIds.includes(s.id)) &&
      rules.find((x) => x.staff_id === s.id)?.enabled !== 0,
  );
  if (!staff.length) fail(staffIds ? 404 : 409, staffIds ? "Barber is not available" : "service_ineligible");
  const quotes = new Map(
    staff.map((s) => [
      s.id,
      calculateQuote(
        service!,
        rules.find((x) => x.staff_id === s.id) ?? null,
        r[8].results as Addon[],
        r[9].results as AddonLink[],
        addonIds,
      ),
    ]),
  );
  return {
    service: service!,
    staff,
    quotes,
    hours: r[2].results as Hours[],
    overrides: r[3].results as ScheduleOverride[],
    holidays: r[4].results as Holiday[],
    daysOff: r[5].results as StaffDayOff[],
    bookings: r[6].results as StoredBooking[],
  };
}
export type Range = Awaited<ReturnType<typeof rangeContext>>;
export function slotFor(shop: Shop, ctx: Range, staff: Staff, date: string, minute: number, minStart: number) {
  const h = effectiveHours(
    ctx.hours.find((x) => x.staff_id === staff.id && x.weekday === weekday(date)) ?? null,
    ctx.overrides.find((o) => o.staff_id === staff.id && o.date === date) ?? null,
  );
  return slotReason(
    shop,
    staff,
    h,
    ctx.holidays,
    ctx.bookings,
    date,
    minute,
    ctx.quotes.get(staff.id)!.duration_min,
    minStart,
    undefined,
    ctx.daysOff,
  );
}
const closedReasons = ["Shop closed", "Barber off duty", "Barber has a day off"];
const staffQuery = z
  .string()
  .default("any")
  .transform((s) => (s === "any" || s === "" ? null : s))
  .refine((s) => s === null || z.string().uuid().safeParse(s).success, "Invalid staff_id");
const addonQuery = z
  .string()
  .default("")
  .transform((s) => (s ? s.split(",") : []))
  .pipe(addonIdsSchema);
// Fourteen-day availability summary so the date strip shows real open counts.
// Shop home page: content + live "open now" + soonest slots per barber. Public, read-only.
pub.get("/shops/:slug/page", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug"));
  const sid = shop.id;
  const [page, staff, services, hours, holidays, daysOff, reviews] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM shop_pages WHERE shop_id=?").bind(sid).first<ShopPage>(),
    c.env.DB.prepare("SELECT id,name,role,title,bio,colour,photo_url,skills,instagram FROM staff WHERE shop_id=? AND active=1 AND online_visible=1 ORDER BY sort_order,name").bind(sid).all(),
    c.env.DB.prepare("SELECT id,name,category,duration_min,price_pence,description,colour,popular FROM services WHERE shop_id=? AND active=1 AND online_bookable=1 ORDER BY popular DESC,sort_order,category,name").bind(sid).all(),
    c.env.DB.prepare("SELECT staff_id,weekday,enabled,starts,ends FROM staff_hours WHERE shop_id=?").bind(sid).all<{ staff_id: string; weekday: number; enabled: number; starts: number; ends: number }>(),
    c.env.DB.prepare("SELECT date,label FROM holidays WHERE shop_id=? AND date>=? ORDER BY date LIMIT 6").bind(sid, shopToday(shop.timezone)).all<{ date: string; label: string }>(),
    c.env.DB.prepare("SELECT staff_id,date FROM staff_days_off WHERE shop_id=? AND date>=? AND date<=?").bind(sid, shopToday(shop.timezone), datePlus(shopToday(shop.timezone), 14)).all<{ staff_id: string; date: string }>(),
    publicReviews(c.env.DB, sid),
  ]);
  const content = page ?? defaultShopPage(sid);
  // Hidden pages are not public; /book/<slug> still works.
  if (!content.published) fail(404, "This shop page is not available");
  const closed = JSON.parse(shop.closed_days) as number[];
  // Shop-level weekly hours: earliest start / latest end across rostered barbers, per weekday.
  const week = Array.from({ length: 7 }, (_, wd) => {
    if (closed.includes(wd)) return { weekday: wd, open: false as const };
    const on = hours.results.filter((h) => h.weekday === wd && h.enabled);
    if (!on.length) return { weekday: wd, open: false as const };
    return { weekday: wd, open: true as const, starts: Math.max(shop.opens, Math.min(...on.map((h) => h.starts))), ends: Math.min(shop.closes, Math.max(...on.map((h) => h.ends))) };
  });
  const now = Date.now();
  const today = shopToday(shop.timezone, now);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: shop.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const minute = Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
  const todayHours = week[weekday(today)];
  const holidayToday = holidays.results.find((h) => h.date === today);
  const openNow = !holidayToday && todayHours.open && minute >= todayHours.starts && minute < todayHours.ends;
  // Soonest bookable slot per barber for their most popular service, cheap enough to run per view.
  const popular = (services.results as { id: string; popular: number }[])[0];
  const soonest: { staff_id: string; staff_name: string; date: string; start_min: number; service_id: string; price_pence: number }[] = [];
  if (popular) {
    const { minStart, maxDate } = limits(shop, now);
    const horizon = datePlus(today, 7) < maxDate ? datePlus(today, 7) : maxDate;
    const ctx = await rangeContext(c, shop, null, popular.id, today, horizon, []);
    for (const st of ctx.staff) {
      let found = false;
      for (let date = today; date <= horizon && !found; date = datePlus(date, 1))
        for (let m = shop.opens; m < shop.closes; m += 15)
          if (!slotFor(shop, ctx, st, date, m, minStart)) {
            soonest.push({ staff_id: st.id, staff_name: st.name, date, start_min: m, service_id: popular.id, price_pence: ctx.quotes.get(st.id)!.price_pence });
            found = true;
            break;
          }
    }
    soonest.sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min);
  }
  return c.json({
    shop: publicShop(shop),
    page: {
      strapline: content.strapline,
      about: content.about,
      cover_url: content.cover_url,
      gallery: JSON.parse(content.gallery_json) as string[],
      phone: content.phone,
      email: content.email,
      instagram: content.instagram,
      map_url: content.map_url,
      transport_note: content.transport_note,
      policy_text: content.policy_text,
      sections: JSON.parse(content.sections_json) as string[],
      accent: content.accent,
      published: content.published,
    },
    staff: staff.results,
    services: services.results,
    week,
    open_now: openNow,
    today,
    closures: holidays.results,
    days_off: daysOff.results,
    soonest,
    reviews: reviews.reviews,
    rating: reviews.summary,
    now,
  });
});
pub.get("/shops/:slug/days", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug"));
  const p = z
    .object({
      staff_id: staffQuery,
      service_id: z.string().uuid(),
      from: dateSchema.optional(),
      addon_ids: addonQuery,
    })
    .safeParse(c.req.query());
  if (!p.success) fail(400, "Supply a valid service_id");
  const q = p.data!;
  const { today, minStart, maxDate } = limits(shop);
  const from = q.from && q.from > today ? q.from : today;
  const to = datePlus(from, 13);
  const ctx = await rangeContext(c, shop, q.staff_id ? [q.staff_id] : null, q.service_id, from, to, q.addon_ids);
  const days = Array.from({ length: 14 }, (_, i) => datePlus(from, i)).map((date) => {
    if (date > maxDate) return { date, available: 0, closed: false, beyond: true };
    const open = new Set<number>();
    let closed = true;
    for (const staff of ctx.staff)
      for (let m = shop.opens; m < shop.closes; m += 15) {
        const reason = slotFor(shop, ctx, staff, date, m, minStart);
        if (!reason) open.add(m);
        if (!closedReasons.includes(reason)) closed = false;
      }
    return { date, available: open.size, closed, beyond: false };
  });
  const durations = [...ctx.quotes.values()].map((q) => q.duration_min);
  const prices = [...ctx.quotes.values()].map((q) => q.price_pence);
  return c.json({
    from,
    to,
    max_date: maxDate,
    duration_min: Math.min(...durations),
    price_pence: Math.min(...prices),
    price_to_pence: Math.max(...prices),
    days,
  });
});

// Next open times across the booking window: for one barber or any eligible barber.
pub.get("/shops/:slug/next", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug"));
  const p = z
    .object({
      staff_id: staffQuery,
      service_id: z.string().uuid(),
      addon_ids: addonQuery,
      limit: z.coerce.number().int().min(1).max(12).default(6),
    })
    .safeParse(c.req.query());
  if (!p.success) fail(400, "Supply a valid service_id");
  const q = p.data!;
  const { today, minStart, maxDate } = limits(shop);
  const ctx = await rangeContext(c, shop, q.staff_id ? [q.staff_id] : null, q.service_id, today, maxDate, q.addon_ids);
  const results: { date: string; start_min: number; staff_id: string; staff_name: string; price_pence: number; duration_min: number }[] = [];
  const seenDays = new Set<string>();
  for (let date = today; date <= maxDate && results.length < q.limit; date = datePlus(date, 1)) {
    let firstOnDay: (typeof results)[number] | null = null;
    for (let m = shop.opens; m < shop.closes && !firstOnDay; m += 15)
      for (const staff of ctx.staff)
        if (!slotFor(shop, ctx, staff, date, m, minStart)) {
          const quote = ctx.quotes.get(staff.id)!;
          firstOnDay = { date, start_min: m, staff_id: staff.id, staff_name: staff.name, price_pence: quote.price_pence, duration_min: quote.duration_min };
          break;
        }
    if (firstOnDay && !seenDays.has(date)) {
      seenDays.add(date);
      results.push(firstOnDay);
    }
  }
  return c.json({ next: results, max_date: maxDate });
});

pub.get("/shops/:slug/availability", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug"));
  const p = z
    .object({
      date: dateSchema,
      staff_id: staffQuery,
      service_id: z.string().uuid(),
      addon_ids: addonQuery,
    })
    .safeParse(c.req.query());
  if (!p.success) fail(400, "Supply a valid date and service_id");
  const q = p.data!;
  const { today, minStart, maxDate } = limits(shop);
  if (q.date < today || q.date > maxDate) fail(409, "outside_booking_window");
  const ctx = await rangeContext(c, shop, q.staff_id ? [q.staff_id] : null, q.service_id, q.date, q.date, q.addon_ids);
  // Any-barber: each open slot is assigned to the least-booked eligible barber so demand spreads.
  const load = new Map(ctx.staff.map((s) => [s.id, ctx.bookings.filter((b) => b.staff_id === s.id).length]));
  const slots = Array.from({ length: 96 }, (_, i) => i * 15)
    .filter((n) => n >= shop.opens && n < shop.closes)
    .map((start_min) => {
      const open = ctx.staff
        .filter((s) => !slotFor(shop, ctx, s, q.date, start_min, minStart))
        .sort((a, b) => load.get(a.id)! - load.get(b.id)! || a.name.localeCompare(b.name));
      if (open.length) {
        const chosen = open[0];
        return {
          start_min,
          available: true,
          reason: "",
          staff_id: chosen.id,
          staff_name: chosen.name,
          barbers: open.length,
          price_pence: ctx.quotes.get(chosen.id)!.price_pence,
          duration_min: ctx.quotes.get(chosen.id)!.duration_min,
        };
      }
      const reasons = ctx.staff.map((s) => slotFor(shop, ctx, s, q.date, start_min, minStart));
      const reason = reasons.find((r) => !closedReasons.includes(r) && r !== "Slot taken") || reasons[0];
      // Customers see whether a time is open, never who holds it.
      return { start_min, available: false, reason: reason === "Slot taken" ? "Unavailable" : reason, barbers: 0 };
    });
  const primary = ctx.staff[0];
  const quote = ctx.quotes.get(primary.id)!;
  const single = ctx.staff.length === 1;
  const rule = single ? await c.env.DB.prepare(
    "SELECT price_pence,duration_min FROM staff_service_rules WHERE shop_id=? AND staff_id=? AND service_id=?",
  ).bind(shop.id, primary.id, q.service_id).first<{ price_pence: number | null; duration_min: number | null }>() : null;
  return c.json({
    slots,
    any_barber: !q.staff_id,
    duration_min: quote.duration_min,
    price_pence: quote.price_pence,
    items: quote.items,
    overridden: !!rule && (rule.price_pence != null || rule.duration_min != null),
    deposit_policy_pence: Math.min(shop.deposit_pence, quote.price_pence),
    cancel_hours: shop.cancel_hours,
    timezone: shop.timezone,
    quote: { service_version: ctx.service.version, shop_version: shop.version },
    holds: false,
    mode: "sandbox",
  });
});

// Waitlist: recorded for the owner when a date is full. No hold, no message.
pub.post("/shops/:slug/waitlist", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug"));
  const b = await readInput(
    c,
    z
      .object({
        staff_id: z.string().uuid().nullable().default(null),
        service_id: z.string().uuid(),
        customer_name: z.string().trim().min(2).max(100),
        phone: publicBookingSchema.shape.phone,
        email: publicBookingSchema.shape.email,
        date: dateSchema,
        daypart: z.enum(["ANY", "MORNING", "AFTERNOON", "EVENING"]).default("ANY"),
        notes: z.string().trim().max(300).default(""),
      })
      .strict(),
  );
  await throttle(c, "waitlist", `${shop.id}:${b.phone}`, 10);
  const { today, maxDate } = limits(shop);
  if (b.date < today || b.date > maxDate) fail(409, "outside_booking_window");
  const service = await c.env.DB.prepare("SELECT id FROM services WHERE shop_id=? AND id=? AND active=1")
    .bind(shop.id, b.service_id)
    .first();
  if (!service) fail(404, "Service is not available");
  if (b.staff_id) {
    const staff = await c.env.DB.prepare("SELECT id FROM staff WHERE shop_id=? AND id=? AND active=1")
      .bind(shop.id, b.staff_id)
      .first();
    if (!staff) fail(404, "Barber is not available");
  }
  const id = uid(),
    now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO waitlist_entries(id,shop_id,staff_id,service_id,customer_name,phone,email,date,daypart,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(shop_id,date,phone,service_id) DO UPDATE SET staff_id=excluded.staff_id,daypart=excluded.daypart,notes=excluded.notes,customer_name=excluded.customer_name,email=excluded.email,status='OPEN',version=version+1,updated_at=excluded.updated_at",
    ).bind(id, shop.id, b.staff_id, b.service_id, b.customer_name, b.phone, b.email, b.date, b.daypart, b.notes, now, now),
    audit(c, "waitlist", id, "WAITLIST_JOINED", `Customer asked to be contacted for ${b.date} (${b.daypart.toLowerCase()}). Confirmation queued, not sent.`),
  ]);
  const q = await shopWithQueue(c, shop.id);
  const stored = await c.env.DB.prepare("SELECT id FROM waitlist_entries WHERE shop_id=? AND date=? AND phone=? AND service_id=?").bind(shop.id, b.date, b.phone, b.service_id).first<{ id: string }>();
  await queueMessage(c, shop.id, b, "waitlist_joined", render(templatesOf(q).waitlist_joined, { first: b.customer_name.split(" ")[0], shop: shop.name, date: wl.fmtDate(b.date), daypart: wl.daypartLabel[b.daypart] }), { type: "waitlist", id: stored?.id ?? id }).run();
  return c.json({ ok: true, date: b.date, daypart: b.daypart, auto_offer: !!q.waitlist_auto_offer, hold_min: q.waitlist_offer_hold_min }, 201);
});

async function issueManageToken(c: Ctx, booking: StoredBooking) {
  const raw = uid() + uid();
  await c.env.DB.prepare(
    "INSERT INTO booking_manage_tokens(token_hash,shop_id,booking_id,created_at) VALUES(?,?,?,?) ON CONFLICT(booking_id) DO NOTHING",
  )
    .bind(await digest(raw), booking.shop_id, booking.id, Date.now())
    .run();
  const stored = await c.env.DB.prepare(
    "SELECT token_hash FROM booking_manage_tokens WHERE booking_id=?",
  )
    .bind(booking.id)
    .first<{ token_hash: string }>();
  // A replayed request keeps the original link; only the first issue returns a raw token.
  return stored?.token_hash === (await digest(raw)) ? raw : null;
}
pub.post("/shops/:slug/bookings", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug"));
  const b = await readInput(c, publicBookingSchema);
  // Scoped per shop so one busy shop cannot lock customers out of another.
  await throttle(c, "book", `${shop.id}:${clientKey(c)}`, 120);
  await throttle(c, "book-phone", `${shop.id}:${b.phone}`, 12);
  const { minStart, maxDate } = limits(shop);
  const result = await createBooking(
    c,
    { ...b, source: "TEST_BOOKING" },
    "ONLINE",
    { minStart, maxDate },
  );
  if (result.booking.channel !== "ONLINE")
    fail(409, "idempotency_payload_changed");
  const token = await issueManageToken(c, result.booking);
  const staff = await c.env.DB.prepare(
    "SELECT name FROM staff WHERE shop_id=? AND id=?",
  )
    .bind(shop.id, result.booking.staff_id)
    .first<{ name: string }>();
  return c.json(
    {
      booking: customerView(result.booking, shop, staff?.name ?? null),
      replayed: result.replayed,
      manage_token: token,
      reference: ref(result.booking),
    },
    result.replayed ? 200 : 201,
  );
});

// Group bookings ------------------------------------------------------------
// Availability for a party: for every 15-minute start on the day, which members could be seated
// simultaneously (distinct barbers, one per member) and, for back-to-back with one barber, whether
// the consecutive chain fits. Members carry service/addons/optional preferred barber.
const groupQuery = z.object({
  date: dateSchema,
  members: z
    .string()
    .transform((s) => s.split(";").filter(Boolean).map((m) => {
      const [service_id, staff_id, addons] = m.split(":");
      return { service_id, staff_id: staff_id && staff_id !== "any" ? staff_id : null, addon_ids: addons ? addons.split(",") : [] };
    }))
    .pipe(z.array(z.object({ service_id: z.string().uuid(), staff_id: z.string().uuid().nullable(), addon_ids: addonIdsSchema })).min(2).max(4)),
});
pub.get("/shops/:slug/group-availability", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug"));
  const p = groupQuery.safeParse(c.req.query());
  if (!p.success) fail(400, "Supply a valid date and 2-4 members as service_id:staff_id|any:addon,addon");
  const { date, members } = p.data!;
  const { today, minStart, maxDate } = limits(shop);
  if (date < today || date > maxDate) fail(409, "outside_booking_window");
  const ctxs = await Promise.all(members.map((m) => rangeContext(c, shop, m.staff_id ? [m.staff_id] : null, m.service_id, date, date, m.addon_ids)));
  const starts = Array.from({ length: 96 }, (_, i) => i * 15).filter((n) => n >= shop.opens && n < shop.closes);
  const freeAt = (i: number, minute: number) => ctxs[i].staff.filter((st) => !slotFor(shop, ctxs[i], st, date, minute, minStart));
  // Together: assign distinct barbers greedily by fewest options first (bipartite matching for <=4 is fine by backtracking).
  const together = starts.map((start_min) => {
    const options = members.map((_, i) => freeAt(i, start_min).map((st) => st.id));
    const order = options.map((o, i) => i).sort((a, b) => options[a].length - options[b].length);
    const used = new Set<string>();
    const pick: (string | null)[] = members.map(() => null);
    const solve = (k: number): boolean => {
      if (k === order.length) return true;
      const i = order[k];
      for (const id of options[i]) {
        if (used.has(id)) continue;
        used.add(id);
        pick[i] = id;
        if (solve(k + 1)) return true;
        used.delete(id);
        pick[i] = null;
      }
      return false;
    };
    const ok = solve(0);
    return {
      start_min,
      available: ok,
      assignment: ok
        ? members.map((_, i) => {
            const st = ctxs[i].staff.find((x) => x.id === pick[i])!;
            const q = ctxs[i].quotes.get(st.id)!;
            return { staff_id: st.id, staff_name: st.name, start_min, price_pence: q.price_pence, duration_min: q.duration_min };
          })
        : null,
    };
  });
  // Back to back: one barber takes everyone in sequence (only meaningful when a single barber can do every service).
  const common = ctxs.map((x) => new Set(x.staff.map((st) => st.id))).reduce((acc, set) => new Set([...acc].filter((id) => set.has(id))));
  const backToBack = starts.map((start_min) => {
    for (const id of common) {
      let cursor = start_min;
      const chain: { staff_id: string; staff_name: string; start_min: number; price_pence: number; duration_min: number }[] = [];
      let ok = true;
      for (let i = 0; i < members.length; i++) {
        const st = ctxs[i].staff.find((x) => x.id === id)!;
        const q = ctxs[i].quotes.get(id)!;
        // Each visit reserves duration + the shop's 10-minute buffer; the next starts on the following quarter hour.
        if (cursor % 15 !== 0 || slotFor(shop, ctxs[i], st, date, cursor, minStart)) {
          ok = false;
          break;
        }
        chain.push({ staff_id: id, staff_name: st.name, start_min: cursor, price_pence: q.price_pence, duration_min: q.duration_min });
        cursor = Math.ceil((cursor + q.duration_min + 10) / 15) * 15;
      }
      if (ok) return { start_min, available: true, assignment: chain };
    }
    return { start_min, available: false, assignment: null };
  });
  return c.json({
    date,
    together,
    back_to_back: backToBack,
    back_to_back_possible: common.size > 0,
    quotes: members.map((_, i) => ({ service_version: ctxs[i].service.version, shop_version: shop.version })),
    cancel_hours: shop.cancel_hours,
    deposit_pence: shop.deposit_pence,
  });
});
// Save a group: every member is a normal booking through createBooking (all guards apply) sharing a
// group_id. Partial failure is reported honestly: created members stand, failed ones are listed.
pub.post("/shops/:slug/group-bookings", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug"));
  const b = await readInput(c, groupBookingSchema);
  await throttle(c, "book", `${shop.id}:${clientKey(c)}`, 120);
  await throttle(c, "book-phone", `${shop.id}:${b.phone}`, 12);
  const { minStart, maxDate } = limits(shop);
  // Replay: the same request id returns the same group.
  const prior = await c.env.DB.prepare("SELECT group_id FROM bookings WHERE shop_id=? AND request_id LIKE ? LIMIT 1").bind(shop.id, `${b.request_id}:%`).first<{ group_id: string }>();
  const groupId = prior?.group_id ?? uid();
  const created: ReturnType<typeof customerView>[] = [];
  const failed: { index: number; attendee_name: string; error: string }[] = [];
  let firstToken: string | null = null;
  const names = new Map<string, string>();
  for (const [i, m] of b.members.entries()) {
    try {
      const result = await createBooking(
        c,
        { request_id: `${b.request_id}:${i}`, staff_id: m.staff_id, service_id: m.service_id, customer_name: b.customer_name, attendee_name: m.attendee_name, phone: b.phone, email: b.email, notes: b.notes, date: b.date, start_min: m.start_min, addon_ids: m.addon_ids, quote: m.quote, source: "TEST_BOOKING" },
        "ONLINE",
        { minStart, maxDate, groupId },
      );
      if (!names.has(result.booking.staff_id)) {
        const st = await c.env.DB.prepare("SELECT name FROM staff WHERE shop_id=? AND id=?").bind(shop.id, result.booking.staff_id).first<{ name: string }>();
        names.set(result.booking.staff_id, st?.name ?? "");
      }
      const token = await issueManageToken(c, result.booking);
      if (!firstToken && token) firstToken = token;
      created.push(customerView(result.booking, shop, names.get(result.booking.staff_id) ?? null));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ index: i, attendee_name: m.attendee_name || b.customer_name, error: message.includes("slot_taken") || message.includes("Slot taken") ? "slot_taken" : message });
    }
  }
  if (!created.length) fail(409, failed[0]?.error || "slot_taken");
  await c.env.DB.prepare(
    "INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(uid(), shop.id, "group", groupId, "GROUP_BOOKED", c.get("actor"), `Customer booked a group of ${b.members.length} online: ${created.length} saved, ${failed.length} failed. No payment taken.`, Date.now())
    .run();
  return c.json({ group_id: groupId, bookings: created, failed, manage_token: firstToken, reference: created[0] ? created[0].reference : null }, failed.length ? 207 : 201);
});

// Waitlist offers: /offer/:token — the customer's accept / decline capability -----------------
async function offerByToken(c: Ctx) {
  const token = c.req.param("token") || "";
  if (token.length < 60 || token.length > 100) fail(404, "Offer link not found");
  const offer = await c.env.DB.prepare("SELECT * FROM waitlist_offers WHERE token_hash=?").bind(await digest(token)).first<OfferRow>();
  if (!offer) return fail(404, "Offer link not found");
  c.set("shopId", offer.shop_id);
  const shop = await shopWithQueue(c, offer.shop_id);
  await sweep(c, shop);
  const fresh = (await c.env.DB.prepare("SELECT * FROM waitlist_offers WHERE id=?").bind(offer.id).first<OfferRow>())!;
  const entry = (await c.env.DB.prepare("SELECT * FROM waitlist_entries WHERE id=?").bind(offer.entry_id).first<WaitlistRow>())!;
  const [staff, service] = await Promise.all([
    c.env.DB.prepare("SELECT name FROM staff WHERE shop_id=? AND id=?").bind(shop.id, offer.staff_id).first<{ name: string }>(),
    c.env.DB.prepare("SELECT name,price_pence,duration_min FROM services WHERE shop_id=? AND id=?").bind(shop.id, offer.service_id).first<{ name: string; price_pence: number; duration_min: number }>(),
  ]);
  return { shop, offer: fresh, entry, staffName: staff?.name ?? "", service };
}
const offerView = (o: OfferRow, entry: WaitlistRow, shop: Shop, staffName: string, service: { name: string; price_pence: number; duration_min: number } | null) => ({
  id: o.id,
  status: o.status,
  date: o.date,
  start_min: o.start_min,
  expires_at: o.expires_at,
  staff_name: staffName,
  service_name: service?.name ?? "",
  price_pence: service?.price_pence ?? 0,
  duration_min: service?.duration_min ?? 0,
  customer_first: entry.customer_name.split(" ")[0],
  booking_id: o.booking_id,
  shop: { name: shop.name, address: shop.address, slug: shop.slug, timezone: shop.timezone, cancel_hours: shop.cancel_hours },
});
pub.get("/offer/:token", async (c) => {
  await throttle(c, "offer", clientKey(c), 60);
  const { shop, offer, entry, staffName, service } = await offerByToken(c);
  return c.json({ offer: offerView(offer, entry, shop, staffName, service) });
});
pub.post("/offer/:token/accept", async (c) => {
  await readInput(c, z.object({}).strict());
  await throttle(c, "offer-write", clientKey(c), 30);
  const { shop, offer, entry, staffName, service } = await offerByToken(c);
  if (offer.status === "ACCEPTED" && offer.booking_id) {
    return c.json({ offer: offerView(offer, entry, shop, staffName, service), booking: customerView(await readBooking(c, offer.booking_id), shop, staffName), manage_token: null, replayed: true });
  }
  if (offer.status !== "PENDING") fail(409, offer.status === "EXPIRED" ? "This offer has expired. You are still on the list." : "This offer is no longer open.");
  const svc = await c.env.DB.prepare("SELECT version FROM services WHERE shop_id=? AND id=?").bind(shop.id, offer.service_id).first<{ version: number }>();
  const { minStart, maxDate } = limits(shop);
  let result: Awaited<ReturnType<typeof createBooking>>;
  try {
    result = await createBooking(
      c,
      { request_id: offer.id, staff_id: offer.staff_id, service_id: offer.service_id, customer_name: entry.customer_name, attendee_name: "", phone: entry.phone, email: entry.email, notes: entry.notes, date: offer.date, start_min: offer.start_min, addon_ids: [], quote: { service_version: svc!.version, shop_version: shop.version }, source: "TEST_BOOKING" },
      "ONLINE",
      { minStart, maxDate },
    );
  } catch (err) {
    // Someone took the time first: the offer is lost, the customer stays in the queue.
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE waitlist_offers SET status='LOST',responded_at=? WHERE id=? AND status='PENDING'").bind(now, offer.id),
      c.env.DB.prepare("UPDATE waitlist_entries SET status='OPEN',offer_id=NULL,version=version+1,updated_at=? WHERE id=? AND offer_id=?").bind(now, entry.id, offer.id),
      audit(c, "waitlist", entry.id, "WAITLIST_OFFER_LOST", `Customer accepted but the time had gone (${err instanceof Error ? err.message : String(err)}). Returned to the queue.`),
    ]);
    fail(409, "slot_taken");
  }
  const now = Date.now();
  const manage = await issueManageToken(c, result!.booking);
  const templates = templatesOf(shop);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE waitlist_offers SET status='ACCEPTED',booking_id=?,responded_at=? WHERE id=? AND status='PENDING'").bind(result!.booking.id, now, offer.id),
    c.env.DB.prepare("UPDATE waitlist_entries SET status='BOOKED',booking_id=?,version=version+1,updated_at=? WHERE id=?").bind(result!.booking.id, now, entry.id),
    queueMessage(c, shop.id, entry, "waitlist_booked", render(templates.waitlist_booked, { service: service?.name ?? "", barber: staffName.split(" ")[0], shop: shop.name, date: wl.fmtDate(offer.date), time: wl.fmtTime(offer.start_min), ref: ref(result!.booking), manage: manage ? `${new URL(c.req.url).origin}/manage/${manage}` : "(see the shop)" }), { type: "booking", id: result!.booking.id }),
    audit(c, "waitlist", entry.id, "WAITLIST_OFFER_ACCEPTED", `Customer accepted the offer online; booking ${ref(result!.booking)} created.`),
  ]);
  const fresh = (await c.env.DB.prepare("SELECT * FROM waitlist_offers WHERE id=?").bind(offer.id).first<OfferRow>())!;
  return c.json({ offer: offerView(fresh, entry, shop, staffName, service), booking: customerView(result!.booking, shop, staffName), manage_token: manage, replayed: result!.replayed }, 201);
});
pub.post("/offer/:token/decline", async (c) => {
  const body = await readInput(c, z.object({ leave: z.boolean().default(false) }).strict());
  await throttle(c, "offer-write", clientKey(c), 30);
  const { shop, offer, entry, staffName, service } = await offerByToken(c);
  if (offer.status !== "PENDING") fail(409, "This offer is no longer open.");
  const now = Date.now();
  const leave = body.leave;
  const templates = templatesOf(shop);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE waitlist_offers SET status='DECLINED',responded_at=? WHERE id=? AND status='PENDING'").bind(now, offer.id),
    c.env.DB.prepare("UPDATE waitlist_entries SET status=?,offer_id=NULL,version=version+1,updated_at=? WHERE id=?").bind(leave ? "CLOSED" : "OPEN", now, entry.id),
    ...(leave ? [] : [queueMessage(c, shop.id, entry, "waitlist_released", render(templates.waitlist_released, { first: entry.customer_name.split(" ")[0], shop: shop.name, date: wl.fmtDate(entry.date) }), { type: "waitlist", id: entry.id })]),
    audit(c, "waitlist", entry.id, leave ? "WAITLIST_LEFT" : "WAITLIST_OFFER_DECLINED", leave ? "Customer declined the offer and left the list." : "Customer declined the offer; still waiting."),
  ]);
  // The freed slot goes to the next in line.
  await autoOffer(c, shop, { staff_id: offer.staff_id, date: offer.date, start_min: offer.start_min }, "decline");
  const fresh = (await c.env.DB.prepare("SELECT * FROM waitlist_offers WHERE id=?").bind(offer.id).first<OfferRow>())!;
  return c.json({ offer: offerView(fresh, entry, shop, staffName, service), left: leave });
});

// Customer manage links ---------------------------------------------------
export function customerView(b: StoredBooking, shop: Shop, staffName: string | null) {
  const now = Date.now();
  const late = b.start_at - now < b.cancel_hours_snapshot * 3600000;
  return {
    id: b.id,
    reference: ref(b),
    status: b.status,
    date: b.date,
    start_min: b.start_min,
    start_at: b.start_at,
    end_at: b.end_at,
    duration_min: b.duration_min,
    service_name: b.service_name,
    items: JSON.parse(b.items_json) as BookingItem[],
    price_pence: b.price_pence,
    deposit_policy_pence: b.deposit_policy_pence,
    cancel_hours: b.cancel_hours_snapshot,
    customer_name: b.customer_name,
    phone: b.phone,
    email: b.email,
    notes: b.notes,
    staff_id: b.staff_id,
    staff_name: staffName,
    attendee_name: b.attendee_name || "",
    group_id: b.group_id,
    channel: b.channel,
    version: b.version,
    shop: { name: shop.name, address: shop.address, slug: shop.slug, timezone: shop.timezone },
    can_manage: b.status === "CONFIRMED" && b.start_at > now + shop.lead_time_min * 60000,
    late_change: late,
  };
}
async function bookingByToken(c: Ctx) {
  const token = c.req.param("token") || "";
  if (token.length < 60 || token.length > 100) fail(404, "Booking link not found");
  const row = await c.env.DB.prepare(
    "SELECT t.booking_id,t.shop_id FROM booking_manage_tokens t WHERE t.token_hash=?",
  )
    .bind(await digest(token))
    .first<{ booking_id: string; shop_id: string }>();
  if (!row) return fail(404, "Booking link not found");
  c.set("shopId", row.shop_id);
  const shop = await c.env.DB.prepare("SELECT * FROM shops WHERE id=?")
    .bind(row.shop_id)
    .first<Shop>();
  const booking = await readBooking(c, row.booking_id);
  const staff = await c.env.DB.prepare(
    "SELECT name FROM staff WHERE shop_id=? AND id=?",
  )
    .bind(row.shop_id, booking.staff_id)
    .first<{ name: string }>();
  return { shop: shop!, booking, staffName: staff?.name ?? null };
}
pub.get("/manage/:token", async (c) => {
  await throttle(c, "manage", clientKey(c), 600);
  const { shop, booking, staffName } = await bookingByToken(c);
  const review = await reviewForBooking(c.env.DB, booking.id);
  const can = reviewEligibility(booking, review);
  return c.json({ booking: customerView(booking, shop, staffName), review: ownReviewView(review), can_review: can.ok, review_blocked: can.ok ? null : can.reason });
});
// Leave a review for a completed visit through the manage link (one per booking, 60 days).
pub.post("/manage/:token/review", async (c) => {
  await throttle(c, "review", clientKey(c), 30);
  const { shop, booking } = await bookingByToken(c);
  const b = await readInput(c, reviewSchema);
  const r = await leaveReview(c, shop, booking, b, `customer:manage:${booking.id}`);
  if (r.error) fail(409, r.error);
  return c.json({ review: ownReviewView(r.review) }, 201);
});
export function calendarResponse(c: Ctx, shop: Shop, booking: StoredBooking, staffName: string | null) {
  const stamp = (ms: number) =>
    new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OLLO//Local test//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${booking.id}@ollo.local`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(booking.start_at)}`,
    `DTEND:${stamp(booking.end_at)}`,
    `SUMMARY:${esc(`${booking.service_name} at ${shop.name}`)}`,
    `DESCRIPTION:${esc(`Reference ${ref(booking)}${staffName ? ` with ${staffName}` : ""}. Local test booking; no payment taken.`)}`,
    `LOCATION:${esc(shop.address || shop.name)}`,
    `STATUS:${booking.status === "CANCELLED" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="${ref(booking)}.ics"`,
  );
  return c.body(body);
}
pub.get("/manage/:token/calendar.ics", async (c) => {
  const { shop, booking, staffName } = await bookingByToken(c);
  return calendarResponse(c, shop, booking, staffName);
});
// Slots a confirmed visit could move to on one day (same barber and service).
export async function moveOptions(c: Ctx, shop: Shop, booking: StoredBooking, date: string) {
  const { today, minStart, maxDate } = limits(shop);
  if (date < today || date > maxDate) fail(409, "outside_booking_window");
  const data = await availabilityContext(c, booking.staff_id, booking.service_id, date);
  const slots = Array.from({ length: 96 }, (_, i) => i * 15)
    .filter((n) => n >= shop.opens && n < shop.closes)
    .map((start_min) => {
      const reason = slotReason(
        data.shop,
        data.staff,
        data.hours,
        data.holidays,
        data.bookings,
        date,
        start_min,
        booking.duration_min,
        minStart,
        booking.id,
        data.daysOff,
      );
      return {
        start_min,
        available: !reason,
        reason: reason === "Slot taken" ? "Unavailable" : reason,
      };
    });
  return { slots, duration_min: booking.duration_min, max_date: maxDate, today };
}
pub.get("/manage/:token/availability", async (c) => {
  const p = z.object({ date: dateSchema }).safeParse(c.req.query());
  if (!p.success) fail(400, "Supply a valid date");
  const { shop, booking } = await bookingByToken(c);
  return c.json(await moveOptions(c, shop, booking, p.data!.date));
});
export const cancelBody = z.object({ version: z.number().int().min(0) }).strict();
export const moveBody = z
  .object({
    date: dateSchema,
    start_min: z
      .number()
      .int()
      .min(0)
      .max(1425)
      .refine((v) => v % 15 === 0),
    version: z.number().int().min(0),
  })
  .strict();
// Customer-initiated cancel: same guards whether it comes from a manage link or a signed-in account.
export async function cancelByCustomer(c: Ctx, shop: Shop, booking: StoredBooking, staffName: string | null, body: z.infer<typeof cancelBody>) {
  await throttle(c, "manage-write", booking.id, 30);
  if (booking.version !== body.version) fail(409, "record_changed");
  if (booking.status !== "CONFIRMED") fail(409, "invalid_transition");
  if (booking.start_at <= Date.now()) fail(409, "Time has passed");
  const late = booking.start_at - Date.now() < booking.cancel_hours_snapshot * 3600000;
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE bookings SET status='CANCELLED',version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=? AND status='CONFIRMED'",
    ).bind(Date.now(), shop.id, booking.id, booking.version),
    audit(
      c,
      "booking",
      booking.id,
      "CANCELLED",
      late
        ? `Cancelled by customer online inside the ${booking.cancel_hours_snapshot}-hour policy window. No payment was held.`
        : "Cancelled by customer online. No payment was held.",
      true,
    ),
  );
  await autoOffer(c, await shopWithQueue(c, shop.id), { staff_id: booking.staff_id, date: booking.date, start_min: booking.start_min }, "customer-cancel");
  return {
    booking: customerView(await readBooking(c, booking.id), shop, staffName),
    late,
  };
}
pub.post("/manage/:token/cancel", async (c) => {
  const body = await readInput(c, cancelBody);
  const { shop, booking, staffName } = await bookingByToken(c);
  return c.json(await cancelByCustomer(c, shop, booking, staffName, body));
});
export async function moveByCustomer(c: Ctx, shop: Shop, booking: StoredBooking, staffName: string | null, body: z.infer<typeof moveBody>) {
  await throttle(c, "manage-write", booking.id, 30);
  if (booking.status !== "CONFIRMED") fail(409, "invalid_transition");
  const { today, minStart, maxDate } = limits(shop);
  if (booking.start_at <= minStart)
    fail(409, "Too close to the appointment to change online. Contact the shop.");
  if (body.date < today || body.date > maxDate) fail(409, "outside_booking_window");
  const data = await availabilityContext(
    c,
    booking.staff_id,
    booking.service_id,
    body.date,
  );
  if (data.rule?.enabled === 0) fail(409, "service_ineligible");
  const reason = slotReason(
    data.shop,
    data.staff,
    data.hours,
    data.holidays,
    data.bookings,
    body.date,
    body.start_min,
    booking.duration_min,
    minStart,
    booking.id,
    data.daysOff,
  );
  if (reason) fail(409, reason === "Slot taken" ? "slot_taken" : reason);
  const start = localInstant(body.date, body.start_min, shop.timezone)!;
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE bookings SET date=?,start_min=?,start_at=?,end_at=?,version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=? AND status='CONFIRMED'",
    ).bind(
      body.date,
      body.start_min,
      start,
      start + booking.duration_min * 60000,
      Date.now(),
      shop.id,
      booking.id,
      body.version,
    ),
    audit(
      c,
      "booking",
      booking.id,
      "RESCHEDULED",
      `Moved by customer online from ${booking.date} ${String(Math.floor(booking.start_min / 60)).padStart(2, "0")}:${String(booking.start_min % 60).padStart(2, "0")}.`,
      true,
    ),
  );
  await autoOffer(c, await shopWithQueue(c, shop.id), { staff_id: booking.staff_id, date: booking.date, start_min: booking.start_min }, "customer-move");
  return {
    booking: customerView(await readBooking(c, booking.id), shop, staffName),
  };
}
pub.post("/manage/:token/reschedule", async (c) => {
  const body = await readInput(c, moveBody);
  const { shop, booking, staffName } = await bookingByToken(c);
  return c.json(await moveByCustomer(c, shop, booking, staffName, body));
});
export default pub;
