import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  addonIdsSchema,
  calculateQuote,
  dateSchema,
  effectiveHours,
  localInstant,
  publicBookingSchema,
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
} from "./domain";
import { readInput, digest, type AppEnv } from "./accounts";
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
type Ctx = Context<AppEnv>;
const pub = new Hono<AppEnv>();
const uid = () => crypto.randomUUID();
const datePlus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
function clientKey(c: Ctx) {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
    "local"
  );
}
async function throttle(c: Ctx, action: string, identity: string, max = 20) {
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
pub.use("*", async (c, next) => {
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
    const origin = c.req.header("origin");
    if (!origin || origin !== new URL(c.req.url).origin)
      return c.json(
        { error: "origin_forbidden", message: "Same-origin requests are required." },
        403,
      );
  }
  c.set("account", null);
  c.set("actor", "customer:online");
  await next();
});
pub.onError(handleError);

async function shopBySlug(c: Ctx, slug: string) {
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
function limits(shop: Shop, now = Date.now()) {
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
      "SELECT id,name,role FROM staff WHERE shop_id=? AND active=1 ORDER BY name",
    ).bind(sid),
    c.env.DB.prepare(
      "SELECT id,name,category,duration_min,price_pence,version FROM services WHERE shop_id=? AND active=1 ORDER BY category,name",
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

// Fourteen-day availability summary so the date strip shows real open counts.
pub.get("/shops/:slug/days", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug"));
  const p = z
    .object({
      staff_id: z.string().uuid(),
      service_id: z.string().uuid(),
      from: dateSchema.optional(),
      addon_ids: z
        .string()
        .default("")
        .transform((s) => (s ? s.split(",") : []))
        .pipe(addonIdsSchema),
    })
    .safeParse(c.req.query());
  if (!p.success) fail(400, "Supply a valid staff_id and service_id");
  const q = p.data!;
  const { today, minStart, maxDate } = limits(shop);
  const from = q.from && q.from > today ? q.from : today;
  const to = datePlus(from, 13);
  const sid = shop.id;
  const r = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM staff WHERE shop_id=? AND id=? AND active=1").bind(
      sid,
      q.staff_id,
    ),
    c.env.DB.prepare("SELECT * FROM services WHERE shop_id=? AND id=? AND active=1").bind(
      sid,
      q.service_id,
    ),
    c.env.DB.prepare("SELECT * FROM staff_hours WHERE shop_id=? AND staff_id=?").bind(
      sid,
      q.staff_id,
    ),
    c.env.DB.prepare(
      "SELECT * FROM staff_schedule_overrides WHERE shop_id=? AND staff_id=? AND date BETWEEN ? AND ?",
    ).bind(sid, q.staff_id, from, to),
    c.env.DB.prepare(
      "SELECT * FROM holidays WHERE shop_id=? AND date BETWEEN ? AND ?",
    ).bind(sid, from, to),
    c.env.DB.prepare(
      "SELECT * FROM staff_days_off WHERE shop_id=? AND staff_id=? AND date BETWEEN ? AND ?",
    ).bind(sid, q.staff_id, from, to),
    c.env.DB.prepare(
      "SELECT id,staff_id,start_at,end_at,buffer_min,status FROM bookings WHERE shop_id=? AND staff_id=? AND date BETWEEN ? AND ? AND status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED')",
    ).bind(sid, q.staff_id, from, to),
    c.env.DB.prepare(
      "SELECT * FROM staff_service_rules WHERE shop_id=? AND staff_id=? AND service_id=?",
    ).bind(sid, q.staff_id, q.service_id),
    c.env.DB.prepare("SELECT * FROM addons WHERE shop_id=?").bind(sid),
    c.env.DB.prepare(
      "SELECT * FROM addon_services WHERE shop_id=? AND service_id=?",
    ).bind(sid, q.service_id),
  ]);
  const staff = r[0].results[0] as Staff | undefined;
  const service = r[1].results[0] as Service | undefined;
  if (!staff || !service) fail(404, "Barber or service is not available");
  const rule = (r[7].results[0] as StaffServiceRule) ?? null;
  if (rule?.enabled === 0) fail(409, "service_ineligible");
  const quote = calculateQuote(
    service!,
    rule,
    r[8].results as Addon[],
    r[9].results as AddonLink[],
    q.addon_ids,
  );
  const hours = r[2].results as Hours[];
  const overrides = r[3].results as ScheduleOverride[];
  const holidays = r[4].results as Holiday[];
  const daysOff = r[5].results as StaffDayOff[];
  const bookings = r[6].results as StoredBooking[];
  const days = Array.from({ length: 14 }, (_, i) => datePlus(from, i)).map(
    (date) => {
      if (date > maxDate) return { date, available: 0, closed: false, beyond: true };
      const h = effectiveHours(
        hours.find((x) => x.weekday === weekday(date)) ?? null,
        overrides.find((o) => o.date === date) ?? null,
      );
      let available = 0;
      let closed = true;
      for (let m = shop.opens; m < shop.closes; m += 15) {
        const reason = slotReason(
          shop,
          staff!,
          h,
          holidays,
          bookings,
          date,
          m,
          quote.duration_min,
          minStart,
          undefined,
          daysOff,
        );
        if (!reason) available++;
        if (!["Shop closed", "Barber off duty", "Barber has a day off"].includes(reason))
          closed = false;
      }
      return { date, available, closed, beyond: false };
    },
  );
  return c.json({
    from,
    to,
    max_date: maxDate,
    duration_min: quote.duration_min,
    price_pence: quote.price_pence,
    days,
  });
});

pub.get("/shops/:slug/availability", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug"));
  const p = z
    .object({
      date: dateSchema,
      staff_id: z.string().uuid(),
      service_id: z.string().uuid(),
      addon_ids: z
        .string()
        .default("")
        .transform((s) => (s ? s.split(",") : []))
        .pipe(addonIdsSchema),
    })
    .safeParse(c.req.query());
  if (!p.success) fail(400, "Supply a valid date, staff_id and service_id");
  const q = p.data!;
  const { today, minStart, maxDate } = limits(shop);
  if (q.date < today || q.date > maxDate) fail(409, "outside_booking_window");
  const data = await availabilityContext(c, q.staff_id, q.service_id, q.date);
  if (!data.staff.active || !data.service.active) fail(409, "service_unavailable");
  if (data.rule?.enabled === 0) fail(409, "service_ineligible");
  const quote = calculateQuote(
    data.service,
    data.rule,
    data.addons,
    data.links,
    q.addon_ids,
  );
  const slots = Array.from({ length: 96 }, (_, i) => i * 15)
    .filter((n) => n >= shop.opens && n < shop.closes)
    .map((start_min) => {
      const reason = slotReason(
        data.shop,
        data.staff,
        data.hours,
        data.holidays,
        data.bookings,
        q.date,
        start_min,
        quote.duration_min,
        minStart,
        undefined,
        data.daysOff,
      );
      // Customers see whether a time is open, never who holds it.
      return {
        start_min,
        available: !reason,
        reason: reason === "Slot taken" ? "Unavailable" : reason,
      };
    });
  return c.json({
    slots,
    duration_min: quote.duration_min,
    price_pence: quote.price_pence,
    items: quote.items,
    overridden: data.rule?.price_pence != null || data.rule?.duration_min != null,
    deposit_policy_pence: Math.min(shop.deposit_pence, quote.price_pence),
    cancel_hours: shop.cancel_hours,
    timezone: shop.timezone,
    quote: { service_version: data.service.version, shop_version: shop.version },
    holds: false,
    mode: "sandbox",
  });
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

// Customer manage links ---------------------------------------------------
function customerView(b: StoredBooking, shop: Shop, staffName: string | null) {
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
  return c.json({ booking: customerView(booking, shop, staffName) });
});
pub.get("/manage/:token/calendar.ics", async (c) => {
  const { shop, booking, staffName } = await bookingByToken(c);
  const stamp = (ms: number) =>
    new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Barbershop OS//Local test//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${booking.id}@barbershop-os.local`,
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
});
pub.get("/manage/:token/availability", async (c) => {
  const p = z.object({ date: dateSchema }).safeParse(c.req.query());
  if (!p.success) fail(400, "Supply a valid date");
  const { shop, booking } = await bookingByToken(c);
  const { today, minStart, maxDate } = limits(shop);
  if (p.data!.date < today || p.data!.date > maxDate)
    fail(409, "outside_booking_window");
  const data = await availabilityContext(
    c,
    booking.staff_id,
    booking.service_id,
    p.data!.date,
  );
  const slots = Array.from({ length: 96 }, (_, i) => i * 15)
    .filter((n) => n >= shop.opens && n < shop.closes)
    .map((start_min) => {
      const reason = slotReason(
        data.shop,
        data.staff,
        data.hours,
        data.holidays,
        data.bookings,
        p.data!.date,
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
  return c.json({ slots, duration_min: booking.duration_min, max_date: maxDate, today });
});
pub.post("/manage/:token/cancel", async (c) => {
  const body = await readInput(
    c,
    z.object({ version: z.number().int().min(0) }).strict(),
  );
  const { shop, booking, staffName } = await bookingByToken(c);
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
  return c.json({
    booking: customerView(await readBooking(c, booking.id), shop, staffName),
    late,
  });
});
pub.post("/manage/:token/reschedule", async (c) => {
  const body = await readInput(
    c,
    z
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
      .strict(),
  );
  const { shop, booking, staffName } = await bookingByToken(c);
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
  return c.json({
    booking: customerView(await readBooking(c, booking.id), shop, staffName),
  });
});
export default pub;
