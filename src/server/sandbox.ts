import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { Database as D1Database, Statement as D1PreparedStatement } from "../db/client";
import { putObject, deleteObject, type ObjectStore } from "../db/storage";
import { z } from "zod";
import {
  addonSchema,
  serviceRuleSchema,
  overrideSchema,
  addonIdsSchema,
  effectiveHours,
  calculateQuote,
  type Addon,
  type AddonLink,
  type StaffServiceRule,
  type ScheduleOverride,
  type BookingItem,
  bookingSchema,
  publicBookingSchema,
  onlineBookingSchema,
  seriesSchema,
  customerSchema,
  ruleMatrixSchema,
  type Customer,
  bookingDetailsSchema,
  dayOffSchema,
  type StaffDayOff,
  dateSchema,
  holidaySchema,
  hoursSchema,
  localInstant,
  moveSchema,
  ref,
  serviceSchema,
  shopSchema,
  shopDay,
  shopWeek,
  weekEnvelope,
  shopToday,
  slotReason,
  staffSchema,
  statusSchema,
  checkoutSchema,
  voidPaymentSchema,
  payRunCreateSchema,
  payRunUpdateSchema,
  payTermsOf,
  calculatePayRun,
  shopPageSchema,
  defaultShopPage,
  type ShopPage,
  type Payment,
  type PayRun,
  weekday,
  type Shop,
  type Staff,
  type Service,
  type Hours,
  type StoredBooking,
  type Holiday,
  type AuditEvent,
} from "./domain";

import { autoOffer, makeOffer, matchesFor, queueReviewRequest, shopWithQueue, sweep, templatesSchema, templatesOf, DEFAULT_TEMPLATES, type WaitlistRow } from "./waitlist";
import { optimiseImage } from "./images";
import { drain, enqueue, msgShop, providerStatus, sweepReminders, MESSAGE_TEMPLATES } from "./messaging";
import { accountLink, accountStatus, createConnectedAccount, depositsOnline, expireHolds, refundDeposit, stripeConnect, stripeLive, stripeStatus } from "./stripe";
import { MEDIA_MAX_BYTES, imageSize, mediaKinds, mediaUrl, replySchema, reviewStatusSchema, scrubMediaReferences, sniffImage, type MediaRow, type ReviewRow } from "./presence";
import accounts, {
  ACCOUNT_COOKIE,
  resolveAccount,
  readInput,
  sameOrigin,
  type AppEnv,
} from "./accounts";
type Env = AppEnv;
type Ctx = Context<Env>;
const sandbox = new Hono<Env>();
const id = () => crypto.randomUUID();
const hash = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  )
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
export const fail = (
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429,
  message: string,
): never => {
  throw new HTTPException(status, { message });
};
const input = readInput;
function scopeStaff(c: Ctx, staffId: string) {
  const a = c.get("account");
  if (a?.role === "BARBER" && a.staff_id !== staffId)
    fail(403, "Assigned barber access only");
}
export function audit(
  c: Ctx,
  entity: string,
  entityId: string,
  action: string,
  reason = "",
  conditional = false,
  eventId = id(),
): D1PreparedStatement {
  return c.env.DB.prepare(
    `INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) SELECT ?,?,?,?,?,?,?,? ${conditional ? "WHERE changes() > 0" : ""}`,
  ).bind(
    eventId,
    c.get("shopId"),
    entity,
    entityId,
    action,
    c.get("actor"),
    reason,
    Date.now(),
  );
}
export async function readShop(c: Ctx) {
  const shop = await c.env.DB.prepare("SELECT * FROM shops WHERE id=?")
    .bind(c.get("shopId"))
    .first<Shop>();
  if (!shop) return fail(404, "Workspace not found");
  return shop;
}
export async function readBooking(c: Ctx, bookingId: string) {
  const b = await c.env.DB.prepare(
    "SELECT * FROM bookings WHERE shop_id=? AND id=?",
  )
    .bind(c.get("shopId"), bookingId)
    .first<StoredBooking>();
  if (!b) return fail(404, "Booking not found");
  scopeStaff(c, b.staff_id);
  return b;
}
export async function checkVersionUpdate(
  c: Ctx,
  update: D1PreparedStatement,
  event: D1PreparedStatement,
) {
  const result = await c.env.DB.batch([update, event]);
  if (!result[0].meta.changes) fail(409, "record_changed");
  return result;
}
sandbox.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  if (!c.env?.DB)
    return c.json(
      { error: "database_unavailable", message: "The database is not configured on this deployment." },
      503,
    );
  if (!["GET", "HEAD"].includes(c.req.method)) {
    if (!sameOrigin(c))
      return c.json(
        {
          error: "origin_forbidden",
          message: "Same-origin requests are required.",
        },
        403,
      );
  }
  const accountToken = getCookie(c, ACCOUNT_COOKIE);
  const account = accountToken ? await resolveAccount(c, accountToken) : null;
  c.set("account", account);
  if (account) {
    c.set("shopId", account.shop_id);
    c.set("actor", `user:${account.user_id}`);
  }
  const path = c.req.path.replace(/^\/api\/(app|sandbox)/, ""),
    method = c.req.method;
  const publicAuth =
    (method === "POST" &&
      ["/auth/login", "/auth/signup", "/auth/accept", "/auth/logout", "/auth/demo"].includes(path)) ||
    (method === "GET" && path === "/auth/me");
  if (!account && !publicAuth)
    return c.json(
      {
        error: "session_required",
        message: "Sign in to continue.",
      },
      401,
    );
  if (account && !path.startsWith("/auth/")) {
    const operational =
      (method === "GET" &&
        ["/workspace", "/bookings", "/availability", "/customers"].includes(
          path,
        )) ||
      (method === "GET" && /^\/customers\/[^/]+$/.test(path)) ||
      (method === "POST" && path === "/customers") ||
      (method === "PUT" && /^\/customers\/[^/]+$/.test(path)) ||
      (method === "POST" && /^\/customers\/[^/]+\/merge$/.test(path)) ||
      (method === "GET" && ["/waitlist", "/notifications", "/reviews", "/media", "/dev/mailbox"].includes(path)) ||
      (method === "GET" && /^\/notifications\/[^/]+$/.test(path)) ||
      (method === "GET" && /^\/waitlist\/[^/]+\/matches$/.test(path)) ||
      (method === "POST" && /^\/waitlist\/[^/]+\/offer$/.test(path)) ||
      (method === "GET" && ["/bookings/range", "/insights", "/wallet", "/pay-runs", "/shop/page"].includes(path)) ||
      (method === "GET" && path === "/pay-runs/preview") ||
      (method === "POST" && /^\/bookings\/[^/]+\/checkout$/.test(path)) ||
      (method === "POST" && /^\/bookings\/[^/]+\/deposit\/refund$/.test(path)) ||
      (method === "POST" && /^\/payments\/[^/]+\/void$/.test(path)) ||
      (method === "GET" && path === "/shop/payments") ||
      (method === "POST" && ["/series/preview", "/series"].includes(path)) ||
      (method === "POST" && /^\/series\/[^/]+\/(cancel|reschedule)$/.test(path)) ||
      (method === "GET" && /^\/bookings\/[^/]+\/timeline$/.test(path)) ||
      (method === "POST" && /^\/bookings\/[^/]+\/manage-link$/.test(path)) ||
      (method === "POST" && /^\/waitlist\/[^/]+\/status$/.test(path)) ||
      (method === "GET" && /^\/bookings\/[^/]+$/.test(path)) ||
      (method === "POST" &&
        (path === "/bookings" ||
          /^\/bookings\/[^/]+\/(status|reschedule)$/.test(path))) ||
      (method === "PATCH" && /^\/bookings\/[^/]+\/details$/.test(path));
    const setup =
      (method === "PUT" && ["/shop", "/shop/online", "/shop/page", "/shop/waitlist", "/shop/messaging", "/shop/payments"].includes(path)) ||
      (method === "POST" && ["/notifications/test", "/notifications/sweep", "/shop/payments/connect"].includes(path)) ||
      (method === "POST" && /^\/notifications\/[^/]+\/resend$/.test(path)) ||
      (method === "POST" && /^\/reviews\/[^/]+\/(status|reply)$/.test(path)) ||
      (method === "POST" && path === "/media") ||
      (method === "DELETE" && /^\/media\/[^/]+$/.test(path)) ||
      (["POST", "PUT", "DELETE"].includes(method) &&
        /^\/(staff|services|addons|holidays|service-rules|pay-runs)(\/|$)/.test(path));
    if (!(
      operational ||
      (["OWNER", "MANAGER"].includes(account.role) && setup)
    ))
      fail(403, "Your account cannot perform this operation");
  }
  await next();
});
export function handleError(err: Error, c: Ctx) {
  if (err instanceof HTTPException)
    return c.json({ error: err.message, message: err.message }, err.status);
  const message = String(err);
  const known = [
    "account_changed",
    "invitation_unavailable",
    "owner_protected",
    "quote_changed",
    "staff_day_off",
    "service_ineligible",
    "addon_unavailable",
    "invalid_booking_items",
    "service_unavailable",
    "slot_taken",
    "barber_unavailable",
    "service_changed",
    "shop_closed",
    "outside_hours",
    "outside_booking_window",
    "no_show_grace_not_elapsed",
    "invalid_transition",
  ];
  const code = known.find((s) => message.includes(s));
  if (code) return c.json({ error: code, message: code }, 409);
  if (message.includes("UNIQUE constraint") || message.includes("duplicate key"))
    return c.json(
      {
        error: "duplicate_record",
        message:
          "This record already exists or changed. Refresh and try again.",
      },
      409,
    );
  // Never log customer bodies or session credentials; the SQL text and Postgres code are safe.
  const pg = err as { code?: string; message?: string; query?: string; constraint_name?: string };
  console.error("Database operation failed", pg.code ?? (err instanceof Error ? err.name : "UnknownError"), pg.constraint_name ?? "", (pg.message ?? "").slice(0, 300), (pg.query ?? "").slice(0, 200));
  return c.json(
    {
      error: "database_error",
      message:
        "The database could not complete this operation. Nothing should be assumed saved; refresh to verify.",
    },
    500,
  );
}
sandbox.onError(handleError);

sandbox.route("/auth", accounts);

// Range read for week view: compact rows for up to 31 days, barber-scoped.
sandbox.get("/bookings/range", async (c) => {
  const p = z
    .object({ from: dateSchema, to: dateSchema })
    .refine((q) => q.to >= q.from, "to must be on or after from")
    .safeParse(c.req.query());
  if (!p.success) fail(400, "Supply a valid from and to date");
  const { from, to } = p.data!;
  const span = (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000;
  if (span > 31) fail(400, "Range is limited to 31 days");
  const a = c.get("account");
  const assigned = a?.role === "BARBER" ? a.staff_id : null;
  const rows = await c.env.DB.prepare(
    "SELECT id,staff_id,service_id,customer_name,service_name,date,start_min,start_at,end_at,duration_min,price_pence,status,channel,source,series_id FROM bookings WHERE shop_id=? AND date BETWEEN ? AND ? AND (? IS NULL OR staff_id=?) ORDER BY date,start_at,id LIMIT 2000",
  )
    .bind(c.get("shopId"), from, to, assigned, assigned)
    .all();
  return c.json({ from, to, bookings: rows.results, truncated: rows.results.length >= 2000 });
});
// Insights: aggregates computed from saved records only. Not payment or accounting data.
sandbox.get("/insights", async (c) => {
  const p = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) }).safeParse(c.req.query());
  if (!p.success) fail(400, "Invalid insights query");
  const days = p.data!.days;
  const shop = await readShop(c);
  const a = c.get("account");
  const assigned = a?.role === "BARBER" ? a.staff_id : null;
  const today = shopToday(shop.timezone);
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  const from = d.toISOString().slice(0, 10);
  const sid = c.get("shopId");
  const r = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT status, channel, COUNT(*) AS n, SUM(price_pence) AS value FROM bookings WHERE shop_id=? AND date BETWEEN ? AND ? AND (? IS NULL OR staff_id=?) GROUP BY status, channel`,
    ).bind(sid, from, today, assigned, assigned),
    c.env.DB.prepare(
      `SELECT service_name AS name, COUNT(*) AS n, SUM(CASE WHEN status='COMPLETED' THEN price_pence ELSE 0 END) AS completed_value FROM bookings WHERE shop_id=? AND date BETWEEN ? AND ? AND status NOT IN ('CANCELLED','NO_SHOW') AND (? IS NULL OR staff_id=?) GROUP BY service_name ORDER BY n DESC LIMIT 8`,
    ).bind(sid, from, today, assigned, assigned),
    c.env.DB.prepare(
      `SELECT b.staff_id, s.name, COUNT(*) AS n, SUM(b.duration_min) AS minutes, SUM(CASE WHEN b.status='COMPLETED' THEN b.price_pence ELSE 0 END) AS completed_value, SUM(CASE WHEN b.status='NO_SHOW' THEN 1 ELSE 0 END) AS no_shows FROM bookings b JOIN staff s ON s.shop_id=b.shop_id AND s.id=b.staff_id WHERE b.shop_id=? AND b.date BETWEEN ? AND ? AND b.status NOT IN ('CANCELLED') AND (? IS NULL OR b.staff_id=?) GROUP BY b.staff_id, s.name ORDER BY n DESC`,
    ).bind(sid, from, today, assigned, assigned),
    c.env.DB.prepare(
      `SELECT (start_min/60) AS hour, COUNT(*) AS n FROM bookings WHERE shop_id=? AND date BETWEEN ? AND ? AND status NOT IN ('CANCELLED','NO_SHOW') AND (? IS NULL OR staff_id=?) GROUP BY hour ORDER BY hour`,
    ).bind(sid, from, today, assigned, assigned),
    c.env.DB.prepare(
      `SELECT ollo_weekday(date) AS weekday, COUNT(*) AS n FROM bookings WHERE shop_id=? AND date BETWEEN ? AND ? AND status NOT IN ('CANCELLED','NO_SHOW') AND (? IS NULL OR staff_id=?) GROUP BY weekday`,
    ).bind(sid, from, today, assigned, assigned),
    c.env.DB.prepare(
      `SELECT date, COUNT(*) AS n, SUM(CASE WHEN status='COMPLETED' THEN price_pence ELSE 0 END) AS completed_value FROM bookings WHERE shop_id=? AND date BETWEEN ? AND ? AND status NOT IN ('CANCELLED','NO_SHOW') AND (? IS NULL OR staff_id=?) GROUP BY date ORDER BY date`,
    ).bind(sid, from, today, assigned, assigned),
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT phone) AS customers, SUM(CASE WHEN first_seen>=? THEN 1 ELSE 0 END) AS new_customers FROM (SELECT phone, MIN(date) AS first_seen FROM bookings WHERE shop_id=? AND status NOT IN ('CANCELLED') AND (? IS NULL OR staff_id=?) GROUP BY phone) WHERE phone IN (SELECT phone FROM bookings WHERE shop_id=? AND date BETWEEN ? AND ?)`,
    ).bind(from, sid, assigned, assigned, sid, from, today),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(price_pence) AS value FROM bookings WHERE shop_id=? AND date>? AND status IN ('CONFIRMED','CHECKED_IN') AND (? IS NULL OR staff_id=?)`,
    ).bind(sid, today, assigned, assigned),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM waitlist_entries WHERE shop_id=? AND status='OPEN' AND date>=?`,
    ).bind(sid, today),
  ]);
  return c.json({
    from,
    to: today,
    days,
    by_status: r[0].results,
    services: r[1].results,
    barbers: r[2].results,
    hours: r[3].results,
    weekdays: r[4].results,
    daily: r[5].results,
    customers: r[6].results[0],
    upcoming: r[7].results[0],
    waitlist_open: (r[8].results[0] as { n: number }).n,
    note: "Saved appointment records only. Value is booked service price, not collected payment.",
  });
});
// Standing bookings: preview every date with the same guards, then create in one pass.
async function seriesDates(b: z.infer<typeof seriesSchema>) {
  const dates: string[] = [];
  for (let i = 0; i < b.occurrences; i++) {
    const d = new Date(`${b.date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i * 7 * b.interval_weeks);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}
async function seriesPreview(c: Ctx, b: z.infer<typeof seriesSchema>) {
  const dates = await seriesDates(b);
  const out: { date: string; reason: string; skipped: boolean }[] = [];
  for (const date of dates) {
    if (b.skip_dates.includes(date)) {
      out.push({ date, reason: "", skipped: true });
      continue;
    }
    const data = await availabilityContext(c, b.staff_id, b.service_id, date);
    const quote = calculateQuote(data.service, data.rule, data.addons, data.links, b.addon_ids);
    const reason = slotReason(
      data.shop,
      data.staff,
      data.hours,
      data.holidays,
      data.bookings,
      date,
      b.start_min,
      quote.duration_min,
      Date.now(),
      undefined,
      data.daysOff,
    );
    out.push({ date, reason, skipped: false });
  }
  return out;
}
sandbox.post("/series/preview", async (c) => {
  const b = await input(c, seriesSchema);
  const preview = await seriesPreview(c, b);
  return c.json({
    dates: preview,
    bookable: preview.filter((p) => !p.skipped && !p.reason).length,
  });
});
sandbox.post("/series", async (c) => {
  const b = await input(c, seriesSchema);
  const preview = await seriesPreview(c, b);
  const targets = preview.filter((p) => !p.skipped && !p.reason);
  if (targets.length < 2) fail(409, "A series needs at least two bookable dates. Skip or move the conflicts first.");
  if (preview.some((p) => !p.skipped && p.reason))
    fail(409, "Some dates are unavailable. Skip them explicitly before saving the series.");
  const seriesId = id();
  await c.env.DB.prepare(
    "INSERT INTO booking_series(id,shop_id,staff_id,service_id,customer_name,phone,interval_weeks,start_date,start_min,occurrences,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(seriesId, c.get("shopId"), b.staff_id, b.service_id, b.customer_name, b.phone, b.interval_weeks, b.date, b.start_min, b.occurrences, Date.now())
    .run();
  const created: StoredBooking[] = [];
  const failed: { date: string; reason: string }[] = [];
  const { interval_weeks, occurrences, skip_dates, ...single } = b;
  for (const t of targets) {
    try {
      const result = await createBooking(
        c,
        { ...single, email: "", date: t.date, request_id: id() },
        "OWNER",
        { seriesId },
      );
      created.push(result.booking);
    } catch (err) {
      // A concurrent booking may have taken one date; report it, keep the rest.
      failed.push({ date: t.date, reason: err instanceof HTTPException ? err.message : String(err).slice(0, 60) });
    }
  }
  await c.env.DB.batch([
    audit(c, "series", seriesId, "SERIES_CREATED", `${created.length} standing appointments every ${b.interval_weeks} week(s); ${failed.length} failed.`),
  ]);
  return c.json({ series_id: seriesId, created, failed }, 201);
});
// Complete, tenant-scoped day reads. The legacy workspace snapshot is not a calendar data source.
sandbox.get("/bookings", async (c) => {
  const parsed = z
    .object({
      date: dateSchema,
      limit: z.coerce.number().int().min(1).max(200).default(100),
      cursor_start: z.coerce.number().int().nonnegative().optional(),
      cursor_id: z.string().uuid().optional(),
      staff_id: z.string().uuid().optional(),
      status: z
        .enum([
          "CONFIRMED",
          "CHECKED_IN",
          "IN_SERVICE",
          "COMPLETED",
          "CANCELLED",
          "NO_SHOW",
        ])
        .optional(),
    })
    .strict()
    .refine(
      (q) => (q.cursor_start === undefined) === (q.cursor_id === undefined),
      "Supply both cursor fields",
    )
    .safeParse(c.req.query());
  if (!parsed.success) return fail(400, "Invalid booking query");
  const q = parsed.data;
  const account = c.get("account");
  if (q.staff_id) scopeStaff(c, q.staff_id);
  if (account?.role === "BARBER") q.staff_id = account.staff_id!;
  const conditions = ["shop_id=?", "date=?"];
  const values: (string | number)[] = [c.get("shopId"), q.date];
  if (q.staff_id) {
    conditions.push("staff_id=?");
    values.push(q.staff_id);
  }
  if (q.status) {
    conditions.push("status=?");
    values.push(q.status);
  }
  if (q.cursor_id !== undefined) {
    conditions.push("(start_at>? OR (start_at=? AND id>?))");
    values.push(q.cursor_start!, q.cursor_start!, q.cursor_id);
  }
  const result = await c.env.DB.prepare(
    `SELECT * FROM bookings WHERE ${conditions.join(" AND ")} ORDER BY start_at,id LIMIT ?`,
  )
    .bind(...values, q.limit + 1)
    .all<StoredBooking>();
  const rows = result.results.slice(0, q.limit);
  const last = rows.at(-1);
  return c.json({
    date: q.date,
    bookings: rows,
    next_cursor:
      result.results.length > q.limit && last
        ? { cursor_start: last.start_at, cursor_id: last.id }
        : null,
  });
});

sandbox.get("/workspace", async (c) => {
  const sid = c.get("shopId");
  const shop = await readShop(c);
  const account = c.get("account");
  const assigned = account?.role === "BARBER" ? account.staff_id : null;
  const scoped = (sql: string) =>
    c.env.DB.prepare(sql).bind(sid, assigned, assigned);
  const result = await c.env.DB.batch([
    scoped(
      "SELECT * FROM staff WHERE shop_id=? AND (? IS NULL OR id=?) ORDER BY name",
    ),
    c.env.DB.prepare(
      "SELECT * FROM services WHERE shop_id=? ORDER BY name",
    ).bind(sid),
    scoped(
      "SELECT * FROM staff_hours WHERE shop_id=? AND (? IS NULL OR staff_id=?) ORDER BY staff_id,weekday",
    ),
    c.env.DB.prepare(
      "SELECT * FROM holidays WHERE shop_id=? ORDER BY date",
    ).bind(sid),
    scoped(
      "SELECT * FROM bookings WHERE shop_id=? AND (? IS NULL OR staff_id=?) ORDER BY start_at DESC LIMIT 500",
    ),
    c.env.DB.prepare(
      "SELECT * FROM audit_events WHERE shop_id=? AND ?=1 ORDER BY created_at DESC,id DESC LIMIT 200",
    ).bind(
      sid,
      !account || ["OWNER", "MANAGER"].includes(account.role) ? 1 : 0,
    ),
    scoped(
      "SELECT * FROM staff_days_off WHERE shop_id=? AND (? IS NULL OR staff_id=?) ORDER BY date,staff_id",
    ),
    c.env.DB.prepare("SELECT * FROM addons WHERE shop_id=? ORDER BY name").bind(
      sid,
    ),
    c.env.DB.prepare("SELECT * FROM addon_services WHERE shop_id=?").bind(sid),
    scoped(
      "SELECT * FROM staff_service_rules WHERE shop_id=? AND (? IS NULL OR staff_id=?)",
    ),
    scoped(
      "SELECT * FROM staff_schedule_overrides WHERE shop_id=? AND (? IS NULL OR staff_id=?) ORDER BY date",
    ),
    c.env.DB.prepare("SELECT logo_url FROM shop_pages WHERE shop_id=?").bind(sid),
  ]);
  const staff = result[0].results as Staff[];
  const services = result[1].results as Service[];
  const hours = result[2].results as Hours[];
  const holidays = result[3].results as Holiday[];
  const bookings = result[4].results as StoredBooking[];
  const daysOff = result[6].results as StaffDayOff[];
  const rules = result[9].results as StaffServiceRule[];
  const overrides = result[10].results as ScheduleOverride[];
  // Impact warnings must not inherit the display snapshot's 500-record cap.
  const future = await c.env.DB.prepare(
    "SELECT * FROM bookings WHERE shop_id=? AND (? IS NULL OR staff_id=?) AND start_at>? AND status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE') ORDER BY start_at,id",
  )
    .bind(sid, assigned, assigned, Date.now())
    .all<StoredBooking>();
  const issues = future.results
    .filter(
      (b) =>
        b.start_at > Date.now() &&
        !["CANCELLED", "NO_SHOW", "COMPLETED"].includes(b.status),
    )
    .flatMap((b) => {
      const reason = rules.some(
        (r) =>
          r.staff_id === b.staff_id &&
          r.service_id === b.service_id &&
          !r.enabled,
      )
        ? "Barber no longer offers this service"
        : slotReason(
            shop,
            staff.find((s) => s.id === b.staff_id) ?? null,
            effectiveHours(
              hours.find(
                (h) =>
                  h.staff_id === b.staff_id && h.weekday === weekday(b.date),
              ) ?? null,
              overrides.find(
                (o) => o.staff_id === b.staff_id && o.date === b.date,
              ) ?? null,
            ),
            holidays,
            [],
            b.date,
            b.start_min,
            b.duration_min,
            Date.now(),
            undefined,
            daysOff,
          );
      return reason ? [{ booking_id: b.id, ref: ref(b), reason }] : [];
    });
  const payments = (
    await c.env.DB.prepare(
      "SELECT * FROM payments WHERE shop_id=? AND (? IS NULL OR staff_id=?) AND date>=? ORDER BY created_at DESC LIMIT 2000",
    )
      .bind(sid, assigned, assigned, new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10))
      .all<Payment>()
  ).results;
  return c.json({
    shop,
    logo_url: (result[11].results[0] as { logo_url?: string } | undefined)?.logo_url || "",
    account,
    staff,
    services,
    hours,
    holidays,
    bookings,
    payments,
    audit: result[5].results as AuditEvent[],
    days_off: daysOff,
    addons: result[7].results as Addon[],
    addon_links: result[8].results as AddonLink[],
    service_rules: rules,
    schedule_overrides: overrides,
    today: shopToday(shop.timezone),
    now: Date.now(),
    mode: "sandbox",
    issues,
  });
});
sandbox.put("/shop", async (c) => {
  const b = await input(c, shopSchema);
  const week = b.week.map((d) => ({ enabled: d.enabled, starts: d.starts, ends: d.ends }));
  const env = weekEnvelope(week);
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE shops SET name=?,address=?,timezone=?,currency=?,opens=?,closes=?,closed_days=?,week_json=?,deposit_pence=?,cancel_hours=?,no_show_grace=?,till_access=?,version=version+1 WHERE id=? AND version=?",
    ).bind(
      b.name,
      b.address,
      b.timezone,
      b.currency,
      env.opens,
      env.closes,
      JSON.stringify(env.closed_days),
      JSON.stringify(week),
      b.deposit_pence,
      b.cancel_hours,
      b.no_show_grace,
      b.till_access,
      c.get("shopId"),
      b.version,
    ),
    audit(
      c,
      "shop",
      c.get("shopId"),
      "SHOP_UPDATED",
      "Schedule changes may require review of existing bookings.",
      true,
    ),
  );
  return c.json({ ok: true });
});

// Online booking settings: public address, on/off switch, lead time and window.

// ---- Shop home page content (Settings → Online presence) ----
sandbox.get("/shop/page", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM shop_pages WHERE shop_id=?").bind(c.get("shopId")).first<ShopPage>();
  return c.json({ page: row ?? defaultShopPage(c.get("shopId")) });
});
sandbox.put("/shop/page", async (c) => {
  const b = await input(c, shopPageSchema);
  const sid = c.get("shopId");
  const now = Date.now();
  const existing = await c.env.DB.prepare("SELECT version FROM shop_pages WHERE shop_id=?").bind(sid).first<{ version: number }>();
  if (existing && existing.version !== b.version) fail(409, "record_changed");
  if (!existing && b.version !== 0) fail(409, "record_changed");
  const sections = JSON.stringify([...new Set(b.sections)]);
  const stmt = existing
    ? c.env.DB.prepare(
        "UPDATE shop_pages SET strapline=?,about=?,cover_url=?,logo_url=?,gallery_json=?,phone=?,email=?,instagram=?,map_url=?,transport_note=?,policy_text=?,sections_json=?,accent=?,theme_json=?,published=?,version=version+1,updated_at=? WHERE shop_id=? AND version=?",
      ).bind(b.strapline, b.about, b.cover_url, b.logo_url, JSON.stringify(b.gallery), b.phone, b.email, b.instagram.replace(/^@/, ""), b.map_url, b.transport_note, b.policy_text, sections, b.accent, JSON.stringify(b.theme), b.published, now, sid, b.version)
    : c.env.DB.prepare(
        "INSERT INTO shop_pages(shop_id,strapline,about,cover_url,logo_url,gallery_json,phone,email,instagram,map_url,transport_note,policy_text,sections_json,accent,theme_json,published,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)",
      ).bind(sid, b.strapline, b.about, b.cover_url, b.logo_url, JSON.stringify(b.gallery), b.phone, b.email, b.instagram.replace(/^@/, ""), b.map_url, b.transport_note, b.policy_text, sections, b.accent, JSON.stringify(b.theme), b.published, now);
  await checkVersionUpdate(c, stmt, audit(c, "shop", sid, "SHOP_PAGE_UPDATED", `${b.published ? "Published" : "Unpublished"}; ${b.sections.length} sections.`, true));
  const row = await c.env.DB.prepare("SELECT * FROM shop_pages WHERE shop_id=?").bind(sid).first<ShopPage>();
  return c.json({ page: row });
});
sandbox.put("/shop/online", async (c) => {
  const b = await input(c, onlineBookingSchema);
  try {
    await checkVersionUpdate(
      c,
      c.env.DB.prepare(
        "UPDATE shops SET slug=?,online_booking=?,lead_time_min=?,booking_window_days=?,version=version+1 WHERE id=? AND version=?",
      ).bind(
        b.slug,
        b.online_booking,
        b.lead_time_min,
        b.booking_window_days,
        c.get("shopId"),
        b.version,
      ),
      audit(
        c,
        "shop",
        c.get("shopId"),
        b.online_booking ? "ONLINE_BOOKING_ENABLED" : "ONLINE_BOOKING_DISABLED",
        `Public address /book/${b.slug}; lead time ${b.lead_time_min} min; window ${b.booking_window_days} days.`,
        true,
      ),
    );
  } catch (err) {
    if (String(err).includes("shops_slug") || String(err).includes("UNIQUE"))
      fail(409, "slug_taken");
    throw err;
  }
  return c.json({ shop: await readShop(c) });
});
// Customer directory derived from saved visits: grouped by normalised mobile number.
// ---- Customers: editable profile rows plus SQL-derived visit statistics ----
const customerStats = `
  COUNT(b.id) AS visits,
  SUM(CASE WHEN b.status='COMPLETED' THEN 1 ELSE 0 END) AS completed,
  SUM(CASE WHEN b.status='NO_SHOW' THEN 1 ELSE 0 END) AS no_shows,
  SUM(CASE WHEN b.status='CANCELLED' THEN 1 ELSE 0 END) AS cancelled,
  SUM(CASE WHEN b.status='COMPLETED' THEN b.price_pence ELSE 0 END) AS completed_value_pence,
  MIN(CASE WHEN b.status<>'CANCELLED' THEN b.start_at END) AS first_visit_at,
  MAX(CASE WHEN b.status='COMPLETED' THEN b.start_at END) AS last_visit_at,
  MIN(CASE WHEN b.start_at>? AND b.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE') THEN b.start_at END) AS next_visit_at,
  SUM(CASE WHEN b.start_at>? AND b.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE') THEN 1 ELSE 0 END) AS upcoming,
  (SELECT MAX(a.last_seen_at) FROM customer_account_links l JOIN customer_accounts a ON a.id=l.account_id WHERE l.shop_id=c.shop_id AND l.customer_id=c.id) AS account_last_seen_at`;
function customerScope(c: Ctx) {
  const a = c.get("account");
  return a?.role === "BARBER" ? a.staff_id : null;
}
async function readCustomer(c: Ctx, id: string) {
  const row = await c.env.DB.prepare("SELECT * FROM customers WHERE shop_id=? AND id=?")
    .bind(c.get("shopId"), id)
    .first<Customer>();
  if (!row) return fail(404, "Customer not found");
  return row;
}
sandbox.get("/customers", async (c) => {
  const parsed = z
    .object({
      q: z.string().trim().max(100).default(""),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      filter: z.enum(["all", "new", "regulars", "lapsed", "no_shows", "upcoming"]).default("all"),
      sort: z.enum(["recent", "spend", "visits", "name", "next"]).default("recent"),
    })
    .safeParse(c.req.query());
  if (!parsed.success) fail(400, "Invalid customer query");
  const { q, limit, filter, sort } = parsed.data!;
  const assigned = customerScope(c);
  const now = Date.now();
  // Postgres cannot reference output aliases in HAVING; spell the aggregates out.
  const having = {
    all: "TRUE",
    new: "MIN(CASE WHEN b.status<>'CANCELLED' THEN b.start_at END) >= ?",
    regulars: "SUM(CASE WHEN b.status='COMPLETED' THEN 1 ELSE 0 END) >= 4",
    lapsed: "SUM(CASE WHEN b.status='COMPLETED' THEN 1 ELSE 0 END) >= 1 AND MAX(CASE WHEN b.status='COMPLETED' THEN b.start_at END) < ? AND SUM(CASE WHEN b.start_at>? AND b.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE') THEN 1 ELSE 0 END) = 0",
    no_shows: "SUM(CASE WHEN b.status='NO_SHOW' THEN 1 ELSE 0 END) >= 2",
    upcoming: "SUM(CASE WHEN b.start_at>? AND b.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE') THEN 1 ELSE 0 END) >= 1",
  }[filter];
  const order = {
    recent: "COALESCE(MAX(CASE WHEN b.status='COMPLETED' THEN b.start_at END), c.created_at) DESC",
    spend: "completed_value_pence DESC, visits DESC",
    visits: "visits DESC, completed_value_pence DESC",
    name: "lower(c.name) ASC",
    next: "(MIN(CASE WHEN b.start_at>? AND b.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE') THEN b.start_at END) IS NULL), MIN(CASE WHEN b.start_at>? AND b.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE') THEN b.start_at END) ASC",
  }[sort];
  const binds: unknown[] = [now, now, assigned, assigned, c.get("shopId"), q, q, q, q, q];
  if (filter === "new") binds.push(now - 30 * 86400000);
  if (filter === "lapsed") binds.push(now - 60 * 86400000, now);
  if (filter === "upcoming") binds.push(now);
  if (sort === "next") binds.push(now, now);
  binds.push(limit);
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.phone, c.email, c.tags, c.notes, c.preferred_staff_id, c.birthday, c.marketing_opt_in, c.version, c.created_at, ${customerStats},
      (SELECT b2.staff_id FROM bookings b2 WHERE b2.shop_id=c.shop_id AND b2.customer_id=c.id AND b2.status='COMPLETED' GROUP BY b2.staff_id ORDER BY COUNT(*) DESC, MAX(b2.start_at) DESC LIMIT 1) AS favourite_staff_id,
      (SELECT b3.service_name FROM bookings b3 WHERE b3.shop_id=c.shop_id AND b3.customer_id=c.id AND b3.status='COMPLETED' GROUP BY b3.service_name ORDER BY COUNT(*) DESC, MAX(b3.start_at) DESC LIMIT 1) AS favourite_service
     FROM customers c
     LEFT JOIN bookings b ON b.shop_id=c.shop_id AND b.customer_id=c.id AND (? IS NULL OR b.staff_id=?)
     WHERE c.shop_id=? AND c.merged_into IS NULL
     AND (?='' OR c.name ILIKE '%'||?||'%' OR c.phone LIKE '%'||?||'%' OR c.email ILIKE '%'||?||'%' OR c.tags ILIKE '%'||?||'%')
     GROUP BY c.id HAVING ${having} ORDER BY ${order} LIMIT ?`,
  )
    .bind(...binds)
    .all();
  // Barbers only see customers they have actually served.
  const results = assigned ? rows.results.filter((r) => (r as { visits: number }).visits > 0) : rows.results;
  return c.json({ customers: results, limit });
});
sandbox.post("/customers", async (c) => {
  const b = await input(c, customerSchema);
  const existing = await c.env.DB.prepare("SELECT id, merged_into FROM customers WHERE shop_id=? AND phone=?")
    .bind(c.get("shopId"), b.phone)
    .first<{ id: string; merged_into: string | null }>();
  if (existing) fail(409, "A customer with this mobile number already exists");
  const now = Date.now();
  const customerId = id();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO customers(id,shop_id,name,phone,email,notes,tags,birthday,preferred_staff_id,marketing_opt_in,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(customerId, c.get("shopId"), b.name, b.phone, b.email, b.notes, JSON.stringify(b.tags), b.birthday || null, b.preferred_staff_id || null, b.marketing_opt_in, now, now),
    audit(c, "customer", customerId, "CUSTOMER_CREATED", "Customer record added."),
  ]);
  return c.json({ customer: await readCustomer(c, customerId) }, 201);
});
sandbox.get("/customers/:id", async (c) => {
  const param = c.req.param("id");
  const assigned = customerScope(c);
  const now = Date.now();
  // Accept a phone number for older links; canonical id otherwise.
  const byPhone = /^(?:\+44|0)7\d{9}$/.test(param.replace(/[\s()-]/g, ""));
  const cust = await c.env.DB.prepare(
    `SELECT * FROM customers WHERE shop_id=? AND ${byPhone ? "phone" : "id"}=?`,
  )
    .bind(c.get("shopId"), byPhone ? param.replace(/[\s()-]/g, "") : param)
    .first<Customer>();
  if (!cust) return fail(404, "Customer not found");
  const target = cust.merged_into ?? cust.id;
  const [profile, bookings, byBarber, byService] = await Promise.all([
    c.env.DB.prepare(
      `SELECT c.*, ${customerStats},
        AVG(CASE WHEN b.status='COMPLETED' THEN b.price_pence END) AS avg_spend_pence
       FROM customers c LEFT JOIN bookings b ON b.shop_id=c.shop_id AND b.customer_id=c.id AND (? IS NULL OR b.staff_id=?)
       WHERE c.shop_id=? AND c.id=? GROUP BY c.id`,
    ).bind(now, now, assigned, assigned, c.get("shopId"), target).first<Customer & Record<string, number | null>>(),
    c.env.DB.prepare(
      "SELECT * FROM bookings WHERE shop_id=? AND customer_id=? AND (? IS NULL OR staff_id=?) ORDER BY start_at DESC LIMIT 200",
    ).bind(c.get("shopId"), target, assigned, assigned).all<StoredBooking>(),
    c.env.DB.prepare(
      "SELECT b.staff_id, s.name, COUNT(*) AS n, MAX(b.start_at) AS last_at FROM bookings b JOIN staff s ON s.shop_id=b.shop_id AND s.id=b.staff_id WHERE b.shop_id=? AND b.customer_id=? AND b.status='COMPLETED' GROUP BY b.staff_id, s.name ORDER BY n DESC, last_at DESC",
    ).bind(c.get("shopId"), target).all(),
    c.env.DB.prepare(
      "SELECT service_name AS name, COUNT(*) AS n, MAX(start_at) AS last_at FROM bookings WHERE shop_id=? AND customer_id=? AND status='COMPLETED' GROUP BY service_name ORDER BY n DESC, last_at DESC LIMIT 5",
    ).bind(c.get("shopId"), target).all(),
  ]);
  if (!profile) return fail(404, "Customer not found");
  if (assigned && !bookings.results.length) return fail(404, "Customer not found");
  // Average gap between completed visits, in days.
  const completed = bookings.results.filter((b) => b.status === "COMPLETED").map((b) => b.start_at).sort((a, b) => a - b);
  const gaps = completed.slice(1).map((t, i) => (t - completed[i]) / 86400000);
  const avg_gap_days = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;
  // Preferred time of day from completed visits.
  const parts = { morning: 0, afternoon: 0, evening: 0 };
  for (const b of bookings.results) if (b.status === "COMPLETED") parts[b.start_min < 720 ? "morning" : b.start_min < 1020 ? "afternoon" : "evening"]++;
  const preferred_daypart = completed.length ? (Object.entries(parts).sort((a, b) => b[1] - a[1])[0][0]) : null;
  return c.json({
    customer: profile,
    bookings: bookings.results,
    barbers: byBarber.results,
    services: byService.results,
    avg_gap_days,
    preferred_daypart,
    favourite_staff_id: (byBarber.results[0] as { staff_id?: string } | undefined)?.staff_id ?? null,
    favourite_service: (byService.results[0] as { name?: string } | undefined)?.name ?? null,
  });
});
sandbox.put("/customers/:id", async (c) => {
  const b = await input(c, customerSchema);
  if (b.version === undefined) fail(400, "version is required");
  const current = await readCustomer(c, c.req.param("id"));
  if (current.merged_into) fail(409, "This customer was merged into another record");
  const clash = await c.env.DB.prepare("SELECT id FROM customers WHERE shop_id=? AND phone=? AND id<>?")
    .bind(c.get("shopId"), b.phone, current.id)
    .first();
  if (clash) fail(409, "Another customer already uses this mobile number");
  const changes: string[] = [];
  if (current.name !== b.name) changes.push("name");
  if (current.phone !== b.phone) changes.push("phone");
  if (current.email !== b.email) changes.push("email");
  if (current.notes !== b.notes) changes.push("notes");
  if (current.tags !== JSON.stringify(b.tags)) changes.push("tags");
  if ((current.birthday || "") !== b.birthday) changes.push("birthday");
  if ((current.preferred_staff_id || "") !== b.preferred_staff_id) changes.push("preferred barber");
  if (current.marketing_opt_in !== b.marketing_opt_in) changes.push("marketing preference");
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE customers SET name=?,phone=?,email=?,notes=?,tags=?,birthday=?,preferred_staff_id=?,marketing_opt_in=?,version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?",
    ).bind(b.name, b.phone, b.email, b.notes, JSON.stringify(b.tags), b.birthday || null, b.preferred_staff_id || null, b.marketing_opt_in, Date.now(), c.get("shopId"), current.id, b.version),
    audit(c, "customer", current.id, "CUSTOMER_UPDATED", changes.length ? `Changed ${changes.join(", ")}.` : "No field changes.", true),
  );
  return c.json({ customer: await readCustomer(c, current.id) });
});
// Merge duplicate records: every booking of the loser moves to the winner; the loser
// row stays (pointing at the winner) so old links keep resolving.
sandbox.post("/customers/:id/merge", async (c) => {
  const a = c.get("account");
  if (a && !["OWNER", "MANAGER"].includes(a.role)) fail(403, "Owner or manager required");
  const b = await input(c, z.object({ into: z.string().min(32).max(36), version: z.number().int().min(0) }).strict());
  const loser = await readCustomer(c, c.req.param("id"));
  const winner = await readCustomer(c, b.into);
  if (loser.id === winner.id) fail(400, "Choose a different customer to merge into");
  if (loser.merged_into || winner.merged_into) fail(409, "One of these records was already merged");
  if (loser.version !== b.version) fail(409, "record_changed");
  const moved = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE shop_id=? AND customer_id=?")
    .bind(c.get("shopId"), loser.id)
    .first<{ n: number }>();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE bookings SET customer_id=? WHERE shop_id=? AND customer_id=?").bind(winner.id, c.get("shopId"), loser.id),
    c.env.DB.prepare("UPDATE customers SET merged_into=?, version=version+1, updated_at=? WHERE shop_id=? AND id=? AND version=?").bind(winner.id, Date.now(), c.get("shopId"), loser.id, b.version),
    c.env.DB.prepare(
      "UPDATE customers SET email=CASE WHEN email='' THEN ? ELSE email END, notes=CASE WHEN ?<>'' AND notes NOT LIKE '%'||?||'%' THEN TRIM(notes||chr(10)||?) ELSE notes END, version=version+1, updated_at=? WHERE shop_id=? AND id=?",
    ).bind(loser.email, loser.notes, loser.notes, loser.notes, Date.now(), c.get("shopId"), winner.id),
    audit(c, "customer", winner.id, "CUSTOMER_MERGED", `Merged ${loser.name} (${loser.phone}) into this record; ${moved?.n ?? 0} visits moved.`),
    audit(c, "customer", loser.id, "CUSTOMER_MERGED_AWAY", `Merged into ${winner.name} (${winner.phone}).`),
  ]);
  return c.json({ customer: await readCustomer(c, winner.id), moved: moved?.n ?? 0 });
});
// Waitlist: open requests for full days, scoped like bookings.
// ---- Waiting list (queue) — see docs/WAITLIST-PLAN.md ----
const queueSelect =
  "SELECT w.*, s.name AS service_name, st.name AS staff_name, o.date AS offer_date, o.start_min AS offer_start_min, o.expires_at AS offer_expires_at, o.staff_id AS offer_staff_id, os.name AS offer_staff_name, o.source AS offer_source FROM waitlist_entries w JOIN services s ON s.shop_id=w.shop_id AND s.id=w.service_id LEFT JOIN staff st ON st.shop_id=w.shop_id AND st.id=w.staff_id LEFT JOIN waitlist_offers o ON o.id=w.offer_id LEFT JOIN staff os ON os.shop_id=o.shop_id AND os.id=o.staff_id";
sandbox.get("/waitlist", async (c) => {
  const p = z
    .object({
      status: z.enum(["OPEN", "OFFERED", "BOOKED", "CLOSED", "EXPIRED", "ACTIVE"]).default("ACTIVE"),
      from: dateSchema.optional(),
    })
    .safeParse(c.req.query());
  if (!p.success) fail(400, "Invalid waitlist query");
  const shop = await shopWithQueue(c, c.get("shopId"));
  await sweep(c, shop);
  const a = c.get("account");
  const assigned = a?.role === "BARBER" ? a.staff_id : null;
  const statuses = p.data!.status === "ACTIVE" ? ["OPEN", "OFFERED"] : [p.data!.status];
  const rows = await c.env.DB.prepare(
    `${queueSelect} WHERE w.shop_id=? AND w.status IN (${statuses.map(() => "?").join(",")}) AND (? IS NULL OR w.staff_id=? OR w.staff_id IS NULL) AND (? IS NULL OR w.date>=?) ORDER BY w.date, w.created_at LIMIT 200`,
  )
    .bind(c.get("shopId"), ...statuses, assigned, assigned, p.data!.from ?? null, p.data!.from ?? null)
    .all();
  const counts = await c.env.DB.prepare("SELECT status, COUNT(*) AS n FROM waitlist_entries WHERE shop_id=? AND date>=? GROUP BY status").bind(c.get("shopId"), shopToday(shop.timezone)).all<{ status: string; n: number }>();
  return c.json({ waitlist: rows.results, counts: Object.fromEntries(counts.results.map((r) => [r.status, r.n])), settings: { auto_offer: shop.waitlist_auto_offer, hold_min: shop.waitlist_offer_hold_min } });
});
sandbox.get("/waitlist/:id/matches", async (c) => {
  const shop = await shopWithQueue(c, c.get("shopId"));
  const entry = await c.env.DB.prepare("SELECT * FROM waitlist_entries WHERE shop_id=? AND id=?").bind(shop.id, c.req.param("id")).first<WaitlistRow>();
  if (!entry) return fail(404, "Waitlist entry not found");
  const a = c.get("account");
  const matches = (await matchesFor(c, shop, entry)).filter((m) => a?.role !== "BARBER" || m.staff_id === a.staff_id);
  return c.json({ entry, matches });
});
// Offer a specific time to a waiting customer. Records the offer + queues the message (not sent).
sandbox.post("/waitlist/:id/offer", async (c) => {
  const b = await input(c, z.object({ staff_id: z.string().uuid(), start_min: z.number().int().min(0).max(1425).refine((v) => v % 15 === 0), version: z.number().int().min(0) }).strict());
  const shop = await shopWithQueue(c, c.get("shopId"));
  scopeStaff(c, b.staff_id);
  const entry = await c.env.DB.prepare("SELECT * FROM waitlist_entries WHERE shop_id=? AND id=?").bind(shop.id, c.req.param("id")).first<WaitlistRow>();
  if (!entry) return fail(404, "Waitlist entry not found");
  if (entry.version !== b.version) fail(409, "record_changed");
  if (!["OPEN", "OFFERED"].includes(entry.status)) fail(409, "invalid_transition");
  const matches = await matchesFor(c, shop, entry);
  if (!matches.some((m) => m.staff_id === b.staff_id && m.start_min === b.start_min)) fail(409, "slot_taken");
  const offer = await makeOffer(c, shop, entry, b, "MANUAL", c.get("actor"));
  if (!offer) return fail(404, "Barber or service not available");
  return c.json({ ok: true, offer }, 201);
});
sandbox.post("/waitlist/:id/status", async (c) => {
  const b = await input(
    c,
    z
      .object({
        status: z.enum(["BOOKED", "CLOSED", "OPEN"]),
        booking_id: z.string().uuid().optional(),
        version: z.number().int().min(0),
      })
      .strict(),
  );
  const now = Date.now();
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE waitlist_entries SET status=?,booking_id=COALESCE(?,booking_id),offer_id=CASE WHEN ?='OPEN' THEN NULL ELSE offer_id END,version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?",
    ).bind(b.status, b.booking_id ?? null, b.status, now, c.get("shopId"), c.req.param("id"), b.version),
    audit(c, "waitlist", c.req.param("id"), `WAITLIST_${b.status}`, b.booking_id ? `Linked to booking ${b.booking_id}.` : "", true),
  );
  // Any pending offer is superseded by the shop's decision.
  await c.env.DB.prepare("UPDATE waitlist_offers SET status='SUPERSEDED',responded_at=? WHERE shop_id=? AND entry_id=? AND status='PENDING'").bind(now, c.get("shopId"), c.req.param("id")).run();
  return c.json({ ok: true });
});
// Queue settings: auto-offer, hold time, message wording.
export const waitlistSettingsSchema = z
  .object({
    waitlist_auto_offer: z.union([z.literal(0), z.literal(1)]),
    waitlist_offer_hold_min: z.number().int().min(15).max(1440),
    templates: templatesSchema,
    version: z.number().int().min(0),
  })
  .strict();
sandbox.put("/shop/waitlist", async (c) => {
  const b = await input(c, waitlistSettingsSchema);
  await checkVersionUpdate(
    c,
    c.env.DB.prepare("UPDATE shops SET waitlist_auto_offer=?,waitlist_offer_hold_min=?,waitlist_templates_json=?,version=version+1 WHERE id=? AND version=?").bind(b.waitlist_auto_offer, b.waitlist_offer_hold_min, JSON.stringify(b.templates), c.get("shopId"), b.version),
    audit(c, "shop", c.get("shopId"), "WAITLIST_SETTINGS_UPDATED", `Auto-offer ${b.waitlist_auto_offer ? "on" : "off"}; hold ${b.waitlist_offer_hold_min} min.`, true),
  );
  const shop = await shopWithQueue(c, c.get("shopId"));
  return c.json({ shop: await readShop(c), templates: templatesOf(shop), defaults: DEFAULT_TEMPLATES });
});
sandbox.get("/notifications", async (c) => {
  const p = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), status: z.enum(["QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED"]).optional() }).safeParse(c.req.query());
  const lim = p.success ? p.data.limit : 50;
  const st = p.success ? p.data.status : undefined;
  const rows = await (st
    ? c.env.DB.prepare("SELECT id,shop_id,channel,recipient,template,body,subject,status,status_note,provider,provider_id,attempts,error,related_type,related_id,created_at,sent_at FROM notifications WHERE shop_id=? AND status=? ORDER BY created_at DESC LIMIT ?").bind(c.get("shopId"), st, lim)
    : c.env.DB.prepare("SELECT id,shop_id,channel,recipient,template,body,subject,status,status_note,provider,provider_id,attempts,error,related_type,related_id,created_at,sent_at FROM notifications WHERE shop_id=? ORDER BY created_at DESC LIMIT ?").bind(c.get("shopId"), lim)
  ).all();
  const counts = await c.env.DB.prepare("SELECT status, COUNT(*)::int AS n FROM notifications WHERE shop_id=? AND created_at>? GROUP BY status").bind(c.get("shopId"), Date.now() - 30 * 86400000).all<{ status: string; n: number }>();
  const shop = await shopWithQueue(c, c.get("shopId"));
  const ms = await msgShop(c, c.get("shopId"));
  return c.json({
    notifications: rows.results,
    counts_30d: Object.fromEntries(counts.results.map((r) => [r.status, r.n])),
    providers: providerStatus(),
    messaging: { msg_sms: ms.msg_sms ?? 1, msg_email: ms.msg_email ?? 1, msg_reminders: ms.msg_reminders ?? 1, msg_reminder_hours: ms.msg_reminder_hours ?? 24, msg_reply_to: ms.msg_reply_to || "", msg_sms_sender: ms.msg_sms_sender || "" },
    templates: templatesOf(shop),
    defaults: DEFAULT_TEMPLATES,
    settings: { waitlist_auto_offer: shop.waitlist_auto_offer, waitlist_offer_hold_min: shop.waitlist_offer_hold_min },
  });
});
const requireRole = (c: Ctx, roles: string[]) => {
  const a = c.get("account");
  if (a && !roles.includes(a.role)) fail(403, "Owner or manager required");
};
// Owner reads one message in full (email HTML) — for the preview drawer.
sandbox.get("/notifications/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM notifications WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first();
  if (!row) fail(404, "Message not found");
  return c.json({ notification: row });
});
const messagingSchema = z
  .object({
    msg_sms: z.union([z.literal(0), z.literal(1)]),
    msg_email: z.union([z.literal(0), z.literal(1)]),
    msg_reminders: z.union([z.literal(0), z.literal(1)]),
    msg_reminder_hours: z.number().int().min(1).max(72),
    msg_reply_to: z.union([z.literal(""), z.string().trim().email().max(120)]),
    msg_sms_sender: z.string().trim().max(11).regex(/^[A-Za-z0-9 ]*$/, "Letters and numbers only"),
  })
  .strict();
sandbox.put("/shop/messaging", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const b = await input(c, messagingSchema);
  const sid = c.get("shopId");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE shops SET msg_sms=?,msg_email=?,msg_reminders=?,msg_reminder_hours=?,msg_reply_to=?,msg_sms_sender=?,version=version+1 WHERE id=?").bind(b.msg_sms, b.msg_email, b.msg_reminders, b.msg_reminder_hours, b.msg_reply_to, b.msg_sms_sender, sid),
    audit(c, "shop", sid, "MESSAGING_UPDATED", `SMS ${b.msg_sms ? "on" : "off"}, email ${b.msg_email ? "on" : "off"}, reminders ${b.msg_reminders ? `${b.msg_reminder_hours}h` : "off"}.`),
  ]);
  return c.json({ ok: true, messaging: b });
});
// Send a test message to the signed-in owner (or a given address/mobile).
sandbox.post("/notifications/test", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const b = await input(c, z.object({ channel: z.enum(["SMS", "EMAIL"]), to: z.string().trim().min(5).max(120) }).strict());
  const ms = await msgShop(c, c.get("shopId"));
  const origin = new URL(c.req.url).origin;
  const stmts = enqueue(c.env.DB, ms, b.channel === "SMS" ? { phone: b.to } : { email: b.to }, "test_message", {}, { related: { type: "test", id: c.get("actor") }, origin, channel: b.channel });
  if (!stmts.length) fail(409, b.channel === "SMS" ? "SMS is switched off for this shop" : "Email is switched off for this shop");
  await c.env.DB.batch(stmts);
  const r = await drain(c.env.DB, 1);
  const row = await c.env.DB.prepare("SELECT id,status,status_note,provider,error FROM notifications WHERE shop_id=? AND template='test_message' ORDER BY created_at DESC LIMIT 1").bind(c.get("shopId")).first();
  return c.json({ ok: true, result: r, notification: row }, 201);
});
// Retry a FAILED message now.
sandbox.post("/notifications/:id/resend", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  await input(c, z.object({}).strict());
  const r = await c.env.DB.prepare("UPDATE notifications SET status='QUEUED', next_attempt_at=?, attempts=0, error='', status_note='Resend requested.' WHERE shop_id=? AND id=? AND status IN ('FAILED','SKIPPED')").bind(Date.now(), c.get("shopId"), c.req.param("id")).run();
  if (!r.meta.changes) fail(409, "Only failed messages can be resent");
  await drain(c.env.DB, 1);
  const row = await c.env.DB.prepare("SELECT id,status,status_note,provider,error FROM notifications WHERE id=?").bind(c.req.param("id")).first();
  return c.json({ ok: true, notification: row });
});
// Dev mailbox: every message this shop would have sent, with rendered email HTML. Only when the demo
// is enabled (never in a production deployment with the demo off).
sandbox.get("/dev/mailbox", async (c) => {
  if ((process.env.DEMO_ENABLED ?? "") !== "1") fail(404, "Not found");
  const rows = await c.env.DB.prepare("SELECT id,channel,recipient,template,body,subject,html,status,provider,created_at,sent_at FROM notifications WHERE shop_id=? ORDER BY created_at DESC LIMIT 100").bind(c.get("shopId")).all();
  return c.json({ messages: rows.results, templates: MESSAGE_TEMPLATES });
});
// Manual sweep (also what the cron route calls).
sandbox.post("/notifications/sweep", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  await input(c, z.object({}).strict());
  const origin = new URL(c.req.url).origin;
  const holds = await expireHolds(c.env.DB);
  const reminders = await sweepReminders(c.env.DB, origin);
  const drained = await drain(c.env.DB, 50);
  return c.json({ reminders, drained, holds_released: holds.length });
});

// ---- Payments (online deposits via the shop's Stripe account) ---------------------------------
// Status: platform provider, this shop's toggle + connected account, and 30-day deposit totals.
sandbox.get("/shop/payments", async (c) => {
  const shop = await readShop(c);
  const since = Date.now() - 30 * 86400000;
  const totals = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(CASE WHEN deposit_status='PAID' THEN deposit_paid_pence ELSE 0 END),0)::int AS paid_pence, COUNT(*) FILTER (WHERE deposit_status='PAID')::int AS paid, COUNT(*) FILTER (WHERE deposit_status='REFUNDED')::int AS refunded, COUNT(*) FILTER (WHERE deposit_status='EXPIRED')::int AS expired, COUNT(*) FILTER (WHERE deposit_status='PENDING')::int AS pending FROM bookings WHERE shop_id=? AND created_at>?",
  ).bind(shop.id, since).first<{ paid_pence: number; paid: number; refunded: number; expired: number; pending: number }>();
  let account: Awaited<ReturnType<typeof accountStatus>> | null = null;
  if (stripeLive() && stripeConnect() && shop.stripe_account_id) account = await accountStatus(shop.stripe_account_id).catch(() => null);
  return c.json({
    stripe: stripeStatus(),
    settings: { deposits_online: shop.deposits_online ?? 0, deposit_hold_min: shop.deposit_hold_min ?? 15, deposit_pence: shop.deposit_pence, stripe_account_id: shop.stripe_account_id || "" },
    account,
    active: depositsOnline(shop),
    totals_30d: totals,
  });
});
const paymentsSchema = z.object({ deposits_online: z.union([z.literal(0), z.literal(1)]), deposit_hold_min: z.number().int().min(5).max(120) }).strict();
sandbox.put("/shop/payments", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const b = await input(c, paymentsSchema);
  const shop = await readShop(c);
  if (b.deposits_online && !stripeLive()) fail(409, "Card payments are not set up on this OLLO deployment yet");
  if (b.deposits_online && stripeConnect() && !shop.stripe_account_id) fail(409, "Connect your Stripe account first");
  if (b.deposits_online && shop.deposit_pence <= 0) fail(409, "Set a deposit amount above zero first");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE shops SET deposits_online=?, deposit_hold_min=?, version=version+1 WHERE id=?").bind(b.deposits_online, b.deposit_hold_min, shop.id),
    audit(c, "shop", shop.id, b.deposits_online ? "DEPOSITS_ONLINE_ENABLED" : "DEPOSITS_ONLINE_DISABLED", b.deposits_online ? `Deposits taken by card at booking; slot held ${b.deposit_hold_min} min.` : "Deposits payable in the shop."),
  ]);
  return c.json({ ok: true, settings: b });
});
// Stripe Connect (Express) onboarding: create the shop's account once, then hand back an onboarding link.
sandbox.post("/shop/payments/connect", async (c) => {
  requireRole(c, ["OWNER"]);
  await input(c, z.object({}).strict());
  if (!stripeLive()) fail(409, "Card payments are not set up on this OLLO deployment yet");
  if (!stripeConnect()) fail(409, "This deployment charges through the platform account; no connection needed");
  const shop = await readShop(c);
  let accountId = shop.stripe_account_id || "";
  if (!accountId) {
    const acct = await createConnectedAccount(shop, c.get("account")?.email || "");
    accountId = acct.id;
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE shops SET stripe_account_id=?, version=version+1 WHERE id=? AND stripe_account_id=''").bind(accountId, shop.id),
      audit(c, "shop", shop.id, "STRIPE_ACCOUNT_CREATED", `Stripe account ${accountId} created for onboarding.`),
    ]);
  }
  const link = await accountLink(accountId, new URL(c.req.url).origin);
  return c.json({ ok: true, account_id: accountId, url: link.url }, 201);
});
// Owner refunds a paid deposit (e.g. shop cancelled, goodwill).
sandbox.post("/bookings/:id/deposit/refund", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const body = await input(c, z.object({ reason: z.string().trim().min(3).max(200) }).strict());
  const b = await readBooking(c, c.req.param("id"));
  if (b.deposit_status !== "PAID") fail(409, "No paid deposit on this visit");
  const shop = await readShop(c);
  const ok = await refundDeposit(c.env.DB, shop, b, c.get("actor"), body.reason);
  if (!ok) fail(409, "Stripe could not refund this deposit. Try again or refund from the Stripe dashboard.");
  return c.json({ ok: true, booking: await readBooking(c, b.id) });
});
// Owner retrieves or creates the customer's manage link so it can be shared by hand.
sandbox.post("/bookings/:id/manage-link", async (c) => {
  await input(c, z.object({}).strict());
  const b = await readBooking(c, c.req.param("id"));
  const shop = await readShop(c);
  if (!shop.slug) fail(409, "Set a public address in Settings → Online booking first");
  const raw = crypto.randomUUID() + crypto.randomUUID();
  // Rotate: one live link per booking. The previous link stops working.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM booking_manage_tokens WHERE booking_id=?").bind(b.id),
    c.env.DB.prepare(
      "INSERT INTO booking_manage_tokens(token_hash,shop_id,booking_id,created_at) VALUES(?,?,?,?)",
    ).bind(await hash(raw), b.shop_id, b.id, Date.now()),
    audit(c, "booking", b.id, "MANAGE_LINK_ISSUED", "Owner generated a customer manage link; previous link revoked. Share it by hand."),
  ]);
  return c.json({ token: raw, path: `/manage/${raw}` }, 201);
});
// ---- Reviews (Settings → Reviews): read, hide/show, reply. Words are the customer's. ----
sandbox.get("/reviews", async (c) => {
  const a = c.get("account");
  const rows = await c.env.DB.prepare(
    "SELECT r.*, s.name AS staff_name, b.date AS visit_date FROM reviews r LEFT JOIN staff s ON s.shop_id=r.shop_id AND s.id=r.staff_id LEFT JOIN bookings b ON b.id=r.booking_id WHERE r.shop_id=? AND (? IS NULL OR r.staff_id=?) ORDER BY r.created_at DESC LIMIT 200",
  )
    .bind(c.get("shopId"), a?.role === "BARBER" ? a.staff_id : null, a?.role === "BARBER" ? a.staff_id : null)
    .all<ReviewRow & { staff_name: string | null; visit_date: string }>();
  const agg = await c.env.DB.prepare("SELECT COUNT(*) AS n, AVG(rating) AS avg, SUM(CASE WHEN status='HIDDEN' THEN 1 ELSE 0 END) AS hidden FROM reviews WHERE shop_id=? AND status='PUBLISHED'").bind(c.get("shopId")).first<{ n: number; avg: number | null }>();
  const hidden = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE shop_id=? AND status='HIDDEN'").bind(c.get("shopId")).first<{ n: number }>();
  return c.json({ reviews: rows.results, summary: { count: agg?.n ?? 0, average: agg?.n ? Math.round((agg.avg ?? 0) * 10) / 10 : null, hidden: hidden?.n ?? 0 } });
});
async function readReview(c: Ctx, id: string) {
  const r = await c.env.DB.prepare("SELECT * FROM reviews WHERE shop_id=? AND id=?").bind(c.get("shopId"), id).first<ReviewRow>();
  if (!r) return fail(404, "Review not found");
  return r;
}
sandbox.post("/reviews/:id/status", async (c) => {
  const b = await input(c, reviewStatusSchema);
  const r = await readReview(c, c.req.param("id"));
  if (r.status === b.status) return c.json({ review: r });
  await checkVersionUpdate(
    c,
    c.env.DB.prepare("UPDATE reviews SET status=?,version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?").bind(b.status, Date.now(), c.get("shopId"), r.id, b.version),
    audit(c, "review", r.id, b.status === "HIDDEN" ? "REVIEW_HIDDEN" : "REVIEW_SHOWN", b.status === "HIDDEN" ? "Review kept but no longer shown on the shop page." : "Review shown on the shop page again.", true),
  );
  return c.json({ review: await readReview(c, r.id) });
});
sandbox.post("/reviews/:id/reply", async (c) => {
  const b = await input(c, replySchema);
  const r = await readReview(c, c.req.param("id"));
  const now = Date.now();
  await checkVersionUpdate(
    c,
    c.env.DB.prepare("UPDATE reviews SET reply=?,reply_at=?,version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?").bind(b.reply, b.reply ? now : null, now, c.get("shopId"), r.id, b.version),
    audit(c, "review", r.id, "REVIEW_REPLIED", b.reply ? "Owner replied publicly." : "Owner removed their reply.", true),
  );
  return c.json({ review: await readReview(c, r.id) });
});

// ---- Media library (R2): upload, list, delete. Served at /media/<id>. ----
const mediaBucket = (c: Ctx): ObjectStore => {
  const bucket = (c.env as unknown as { MEDIA?: ObjectStore }).MEDIA;
  if (!bucket) fail(409, "Photo uploads are not available in this environment");
  return bucket!;
};
sandbox.get("/media", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM shop_media WHERE shop_id=? ORDER BY created_at DESC LIMIT 200").bind(c.get("shopId")).all<MediaRow>();
  return c.json({ media: rows.results.map((m) => ({ ...m, url: mediaUrl(m.id) })) });
});
sandbox.post("/media", async (c) => {
  const bucket = mediaBucket(c);
  const len = Number(c.req.header("content-length") || 0);
  if (len > MEDIA_MAX_BYTES + 4096) fail(413, "Photos must be 5 MB or smaller");
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return fail(400, "Send the photo as multipart form data");
  }
  const file = form.get("file");
  const kind = String(form.get("kind") || "gallery");
  const alt = String(form.get("alt") || "").trim().slice(0, 200);
  if (!(file instanceof File)) fail(400, "Choose a photo to upload");
  if (!(mediaKinds as readonly string[]).includes(kind)) fail(400, "Unknown photo kind");
  const f = file as File;
  if (f.size > MEDIA_MAX_BYTES) fail(413, "Photos must be 5 MB or smaller");
  const raw = new Uint8Array(await f.arrayBuffer());
  const sniffed = sniffImage(raw);
  if (!sniffed) fail(400, "Only JPEG, PNG or WebP photos are accepted");
  // Resize + recompress so a 5 MB phone photo becomes a few hundred KB; logos keep their transparency.
  const opt = await optimiseImage(raw, kind as (typeof mediaKinds)[number], sniffed!);
  const bytes = opt.bytes;
  const type = opt.type;
  const size = opt.width && opt.height ? { width: opt.width, height: opt.height } : imageSize(raw, sniffed!);
  const mid = id();
  const key = `${c.get("shopId")}/${kind}/${mid}`;
  await putObject(bucket, key, bytes, type);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO shop_media(id,shop_id,kind,object_key,content_type,bytes,width,height,alt,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(mid, c.get("shopId"), kind, key, type, bytes.byteLength, size?.width ?? null, size?.height ?? null, alt, c.get("actor"), Date.now()),
    audit(c, "media", mid, "MEDIA_UPLOADED", `${kind} photo, ${Math.round(bytes.byteLength / 1024)} KB${size ? `, ${size.width}×${size.height}` : ""}.`),
  ]);
  return c.json({ media: { id: mid, kind, url: mediaUrl(mid), content_type: type, bytes: bytes.byteLength, width: size?.width ?? null, height: size?.height ?? null, alt } }, 201);
});
sandbox.delete("/media/:id", async (c) => {
  const bucket = mediaBucket(c);
  const m = await c.env.DB.prepare("SELECT * FROM shop_media WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first<MediaRow>();
  if (!m) return fail(404, "Photo not found");
  const now = Date.now();
  await scrubMediaReferences(c.env.DB, c.get("shopId"), mediaUrl(m.id), now);
  await c.env.DB.batch([c.env.DB.prepare("DELETE FROM shop_media WHERE id=?").bind(m.id), audit(c, "media", m.id, "MEDIA_DELETED", `${m.kind} photo removed; any cover, gallery or barber photo using it was cleared.`)]);
  await deleteObject(bucket, m.object_key);
  return c.json({ ok: true });
});
sandbox.post("/staff", async (c) => {
  const b = await input(c, staffSchema);
  const sid = c.get("shopId");
  const staffId = id();
  const shop = await readShop(c);
  const writes = [
    c.env.DB.prepare(
      "INSERT INTO staff(id,shop_id,name,role,active,title,bio,colour,photo_url,online_visible,skills,instagram,start_date,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(staffId, sid, b.name, b.role, b.active, b.title, b.bio, b.colour, b.photo_url, b.online_visible, JSON.stringify(b.skills), b.instagram.replace(/^@/, ""), b.start_date || null, b.sort_order),
  ];
  for (let day = 0; day < 7; day++)
    writes.push(
      c.env.DB.prepare(
        "INSERT INTO staff_hours(shop_id,staff_id,weekday,enabled,starts,ends,break_start,break_end) VALUES(?,?,?,?,?,?,?,?)",
      ).bind(
        sid,
        staffId,
        day,
        shopDay(shop, day).enabled,
        shopDay(shop, day).starts,
        shopDay(shop, day).ends,
        shopDay(shop, day).starts,
        shopDay(shop, day).starts,
      ),
    );
  writes.push(audit(c, "staff", staffId, "STAFF_CREATED"));
  await c.env.DB.batch(writes);
  return c.json({ id: staffId }, 201);
});
sandbox.put("/staff/:id", async (c) => {
  const b = await input(c, staffSchema);
  if (b.version === undefined) fail(400, "version is required");
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE staff SET name=?,role=?,active=?,title=?,bio=?,colour=?,photo_url=?,online_visible=?,skills=?,instagram=?,start_date=?,sort_order=?,commission_pct=?,pay_model=?,pay_period=?,base_pence=?,hourly_pence=?,rent_pence=?,commission_threshold_pence=?,commission_tiers=?,tip_share_pct=?,product_commission_pct=?,employment=?,pay_notes=?,version=version+1 WHERE shop_id=? AND id=? AND version=?",
    ).bind(
      b.name,
      b.role,
      b.active,
      b.title,
      b.bio,
      b.colour,
      b.photo_url,
      b.online_visible,
      JSON.stringify(b.skills),
      b.instagram.replace(/^@/, ""),
      b.start_date || null,
      b.sort_order,
      b.commission_pct,
      b.pay_model,
      b.pay_period,
      b.base_pence,
      b.hourly_pence,
      b.rent_pence,
      b.commission_threshold_pence,
      JSON.stringify(b.commission_tiers),
      b.tip_share_pct,
      b.product_commission_pct,
      b.employment,
      b.pay_notes,
      c.get("shopId"),
      c.req.param("id"),
      b.version,
    ),
    audit(
      c,
      "staff",
      c.req.param("id"),
      "STAFF_UPDATED",
      b.active ? "" : "Deactivated; existing appointments retained for review.",
      true,
    ),
  );
  return c.json({ ok: true });
});
sandbox.put("/staff/:id/hours", async (c) => {
  const b = await input(c, hoursSchema);
  const sid = c.get("shopId");
  const staffId = c.req.param("id");
  const writes = [
    c.env.DB.prepare(
      "UPDATE staff SET version=version+1 WHERE shop_id=? AND id=? AND version=?",
    ).bind(sid, staffId, b.version),
  ];
  // Conditional UPSERTs all use the new version plus an operation-specific audit row as the guard.
  const operation = id();
  writes.push(
    c.env.DB.prepare(
      "INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) SELECT ?,?,?,?,?,?,?,? WHERE changes()>0",
    ).bind(
      operation,
      sid,
      "staff",
      staffId,
      "HOURS_UPDATED",
      c.get("actor"),
      "Review existing appointments after changing hours.",
      Date.now(),
    ),
  );
  for (const row of b.rows)
    writes.push(
      c.env.DB.prepare(
        "UPDATE staff_hours SET enabled=?,starts=?,ends=?,break_start=?,break_end=? WHERE shop_id=? AND staff_id=? AND weekday=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=? AND shop_id=?)",
      ).bind(
        row.enabled,
        row.starts,
        row.ends,
        row.break_start,
        row.break_end,
        sid,
        staffId,
        row.weekday,
        operation,
        sid,
      ),
    );
  const result = await c.env.DB.batch(writes);
  if (!result[0].meta.changes) fail(409, "record_changed");
  return c.json({ ok: true });
});
sandbox.post("/staff/:id/days-off", async (c) => {
  const body = await input(c, dayOffSchema);
  const staffId = c.req.param("id");
  const staff = await c.env.DB.prepare(
    "SELECT id FROM staff WHERE shop_id=? AND id=?",
  )
    .bind(c.get("shopId"), staffId)
    .first();
  if (!staff) fail(404, "Barber not found");
  const leaveId = id();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO staff_days_off(id,shop_id,staff_id,date,reason,created_at) VALUES(?,?,?,?,?,?)",
    ).bind(
      leaveId,
      c.get("shopId"),
      staffId,
      body.date,
      body.reason,
      Date.now(),
    ),
    audit(
      c,
      "staff_day_off",
      leaveId,
      "DAY_OFF_ADDED",
      `${staffId}: ${body.date} — ${body.reason}. Review existing appointments.`,
    ),
  ]);
  return c.json({ id: leaveId }, 201);
});
sandbox.delete("/staff/:id/days-off/:leaveId", async (c) => {
  const leaveId = c.req.param("leaveId");
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM staff_days_off WHERE shop_id=? AND staff_id=? AND id=?",
    ).bind(c.get("shopId"), c.req.param("id"), leaveId),
    audit(
      c,
      "staff_day_off",
      leaveId,
      "DAY_OFF_REMOVED",
      "Dated day off removed; weekly hours apply again.",
      true,
    ),
  ]);
  if (!result[0].meta.changes) fail(404, "Day off not found");
  return c.json({ ok: true });
});

sandbox.post("/services", async (c) => {
  const b = await input(c, serviceSchema);
  const serviceId = id();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO services(id,shop_id,name,category,duration_min,price_pence,active,description,colour,online_bookable,popular,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      serviceId,
      c.get("shopId"),
      b.name,
      b.category,
      b.duration_min,
      b.price_pence,
      b.active,
      b.description,
      b.colour,
      b.online_bookable,
      b.popular,
      b.sort_order,
    ),
    audit(c, "service", serviceId, "SERVICE_CREATED"),
  ]);
  return c.json({ id: serviceId }, 201);
});
// Rename a service category across the shop (services keep their versions bumped so open
// editors notice). Empty result when nothing matched.
sandbox.post("/services/categories/rename", async (c) => {
  const b = await input(
    c,
    z.object({ from: z.string().trim().min(2).max(40), to: z.string().trim().min(2).max(40) }).strict(),
  );
  if (b.from === b.to) return c.json({ ok: true, renamed: 0 });
  const sid = c.get("shopId");
  const r = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE services SET category=?, version=version+1 WHERE shop_id=? AND category=?").bind(b.to, sid, b.from),
    audit(c, "service", sid, "CATEGORY_RENAMED", `"${b.from}" → "${b.to}"`, true),
  ]);
  return c.json({ ok: true, renamed: r[0].meta.changes ?? 0 });
});
sandbox.put("/services/:id", async (c) => {
  const b = await input(c, serviceSchema);
  if (b.version === undefined) fail(400, "version is required");
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE services SET name=?,category=?,duration_min=?,price_pence=?,active=?,description=?,colour=?,online_bookable=?,popular=?,sort_order=?,version=version+1 WHERE shop_id=? AND id=? AND version=?",
    ).bind(
      b.name,
      b.category,
      b.duration_min,
      b.price_pence,
      b.active,
      b.description,
      b.colour,
      b.online_bookable,
      b.popular,
      b.sort_order,
      c.get("shopId"),
      c.req.param("id"),
      b.version,
    ),
    audit(
      c,
      "service",
      c.req.param("id"),
      "SERVICE_UPDATED",
      "Existing booking snapshots are unchanged.",
      true,
    ),
  );
  return c.json({ ok: true });
});
async function requireStaff(c: Ctx, staffId: string) {
  if (
    !(await c.env.DB.prepare("SELECT id FROM staff WHERE shop_id=? AND id=?")
      .bind(c.get("shopId"), staffId)
      .first())
  )
    fail(404, "Barber not found");
}
async function validateServiceLinks(c: Ctx, ids: string[]) {
  const found = await c.env.DB.prepare(
    `SELECT id FROM services WHERE shop_id=? AND id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(c.get("shopId"), ...ids)
    .all();
  if (found.results.length !== ids.length)
    fail(404, "Service not found in this workspace");
}
async function saveAddon(c: Ctx, addonId: string, editing: boolean) {
  const b = await input(c, addonSchema);
  if (editing && b.version === undefined) fail(400, "version is required");
  await validateServiceLinks(c, b.service_ids);
  const sid = c.get("shopId"),
    marker = id();
  const writes = [
    editing
      ? c.env.DB.prepare(
          "UPDATE addons SET name=?,price_pence=?,duration_min=?,active=?,version=version+1 WHERE shop_id=? AND id=? AND version=?",
        ).bind(
          b.name,
          b.price_pence,
          b.duration_min,
          b.active,
          sid,
          addonId,
          b.version!,
        )
      : c.env.DB.prepare(
          "INSERT INTO addons(id,shop_id,name,price_pence,duration_min,active) VALUES(?,?,?,?,?,?)",
        ).bind(addonId, sid, b.name, b.price_pence, b.duration_min, b.active),
    audit(
      c,
      "addon",
      addonId,
      editing ? "ADDON_UPDATED" : "ADDON_CREATED",
      "Existing booking items are unchanged.",
      true,
      marker,
    ),
    c.env.DB.prepare(
      "DELETE FROM addon_services WHERE shop_id=? AND addon_id=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=? AND shop_id=?)",
    ).bind(sid, addonId, marker, sid),
  ];
  for (const serviceId of b.service_ids)
    writes.push(
      c.env.DB.prepare(
        "INSERT INTO addon_services(shop_id,addon_id,service_id) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM audit_events WHERE id=? AND shop_id=?)",
      ).bind(sid, addonId, serviceId, marker, sid),
    );
  writes.push(
    c.env.DB.prepare(
      "UPDATE shops SET version=version+1 WHERE id=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=? AND shop_id=?)",
    ).bind(sid, marker, sid),
  );
  const result = await c.env.DB.batch(writes);
  if (!result[0].meta.changes) fail(409, "record_changed");
  return c.json({ id: addonId }, editing ? 200 : 201);
}
sandbox.post("/addons", (c) => saveAddon(c, id(), false));
sandbox.put("/addons/:id", (c) => saveAddon(c, c.req.param("id"), true));
// Service studio matrix: save every barber's rule for a service (or every service for a barber) at once.
// Rules with no override and enabled=1 are removed (back to shop default).
sandbox.put("/service-rules", async (c) => {
  const b = await input(c, ruleMatrixSchema);
  const sid = c.get("shopId");
  const staffIds = [...new Set(b.rules.map((r) => r.staff_id))];
  const serviceIds = [...new Set(b.rules.map((r) => r.service_id))];
  const staffRows = await c.env.DB.prepare(`SELECT id FROM staff WHERE shop_id=? AND id IN (${staffIds.map(() => "?").join(",")})`).bind(sid, ...staffIds).all();
  if (staffRows.results.length !== staffIds.length) fail(404, "Barber not found");
  await validateServiceLinks(c, serviceIds);
  const statements: D1PreparedStatement[] = [];
  for (const r of b.rules) {
    const isDefault = r.enabled === 1 && r.price_pence === null && r.duration_min === null;
    statements.push(
      isDefault
        ? c.env.DB.prepare("DELETE FROM staff_service_rules WHERE shop_id=? AND staff_id=? AND service_id=?").bind(sid, r.staff_id, r.service_id)
        : c.env.DB.prepare(
            "INSERT INTO staff_service_rules(shop_id,staff_id,service_id,enabled,price_pence,duration_min) VALUES(?,?,?,?,?,?) ON CONFLICT(shop_id,staff_id,service_id) DO UPDATE SET enabled=excluded.enabled,price_pence=excluded.price_pence,duration_min=excluded.duration_min,version=staff_service_rules.version+1",
          ).bind(sid, r.staff_id, r.service_id, r.enabled, r.price_pence, r.duration_min),
    );
  }
  const subject = serviceIds.length === 1 ? ["service", serviceIds[0]] : ["staff", staffIds[0]];
  statements.push(audit(c, subject[0], subject[1], "SERVICE_RULES_UPDATED", `${b.rules.length} barber/service rule(s) saved from the studio.`));
  await c.env.DB.batch(statements);
  const rules = await c.env.DB.prepare("SELECT * FROM staff_service_rules WHERE shop_id=?").bind(sid).all();
  return c.json({ service_rules: rules.results });
});
sandbox.put("/staff/:id/services/:serviceId", async (c) => {
  const b = await input(c, serviceRuleSchema),
    sid = c.get("shopId"),
    staffId = c.req.param("id"),
    serviceId = c.req.param("serviceId");
  await requireStaff(c, staffId);
  await validateServiceLinks(c, [serviceId]);
  const statement =
    b.version === 0
      ? c.env.DB.prepare(
          "INSERT INTO staff_service_rules(shop_id,staff_id,service_id,enabled,price_pence,duration_min) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        ).bind(
          sid,
          staffId,
          serviceId,
          b.enabled,
          b.price_pence,
          b.duration_min,
        )
      : c.env.DB.prepare(
          "UPDATE staff_service_rules SET enabled=?,price_pence=?,duration_min=?,version=version+1 WHERE shop_id=? AND staff_id=? AND service_id=? AND version=?",
        ).bind(
          b.enabled,
          b.price_pence,
          b.duration_min,
          sid,
          staffId,
          serviceId,
          b.version,
        );
  const result = await c.env.DB.batch([
    statement,
    audit(
      c,
      "staff_service",
      staffId + ":" + serviceId,
      "SERVICE_RULE_UPDATED",
      "Eligibility and overrides updated; existing commercial snapshots retained.",
      true,
    ),
    c.env.DB.prepare(
      "UPDATE shops SET version=version+1 WHERE id=? AND changes()>0",
    ).bind(sid),
  ]);
  if (!result[0].meta.changes) fail(409, "record_changed");
  return c.json({ ok: true });
});
async function saveOverride(c: Ctx, overrideId: string, editing: boolean) {
  const b = await input(c, overrideSchema);
  if (editing && b.version === undefined) fail(400, "version is required");
  const sid = c.get("shopId"),
    staffId = c.req.param("id")!;
  await requireStaff(c, staffId);
  const write = editing
    ? c.env.DB.prepare(
        "UPDATE staff_schedule_overrides SET date=?,enabled=?,starts=?,ends=?,break_start=?,break_end=?,reason=?,version=version+1 WHERE shop_id=? AND staff_id=? AND id=? AND version=?",
      ).bind(
        b.date,
        b.enabled,
        b.starts,
        b.ends,
        b.break_start,
        b.break_end,
        b.reason,
        sid,
        staffId,
        overrideId,
        b.version!,
      )
    : c.env.DB.prepare(
        "INSERT INTO staff_schedule_overrides(id,shop_id,staff_id,date,enabled,starts,ends,break_start,break_end,reason) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        overrideId,
        sid,
        staffId,
        b.date,
        b.enabled,
        b.starts,
        b.ends,
        b.break_start,
        b.break_end,
        b.reason,
      );
  await checkVersionUpdate(
    c,
    write,
    audit(
      c,
      "schedule_override",
      overrideId,
      editing ? "DATED_HOURS_UPDATED" : "DATED_HOURS_CREATED",
      `${b.date}: ${b.reason}. Review existing appointments.`,
      true,
    ),
  );
  return c.json({ id: overrideId }, editing ? 200 : 201);
}
sandbox.post("/staff/:id/overrides", (c) => saveOverride(c, id(), false));
sandbox.put("/staff/:id/overrides/:overrideId", (c) =>
  saveOverride(c, c.req.param("overrideId"), true),
);
sandbox.delete("/staff/:id/overrides/:overrideId", async (c) => {
  const overrideId = c.req.param("overrideId");
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM staff_schedule_overrides WHERE shop_id=? AND staff_id=? AND id=?",
    ).bind(c.get("shopId"), c.req.param("id"), overrideId),
    audit(
      c,
      "schedule_override",
      overrideId,
      "DATED_HOURS_REMOVED",
      "Weekly hours apply again; existing appointments retained.",
      true,
    ),
  ]);
  if (!result[0].meta.changes) fail(404, "Dated hours not found");
  return c.json({ ok: true });
});

sandbox.post("/holidays", async (c) => {
  const b = await input(c, holidaySchema);
  const holidayId = id();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO holidays(id,shop_id,date,label) VALUES(?,?,?,?)",
    ).bind(holidayId, c.get("shopId"), b.date, b.label),
    audit(c, "holiday", holidayId, "HOLIDAY_CREATED", `${b.date}: ${b.label}`),
  ]);
  return c.json({ id: holidayId }, 201);
});
sandbox.delete("/holidays/:id", async (c) => {
  const r = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM holidays WHERE shop_id=? AND id=?").bind(
      c.get("shopId"),
      c.req.param("id"),
    ),
    audit(
      c,
      "holiday",
      c.req.param("id"),
      "HOLIDAY_REMOVED",
      "Closure removed; historical audit retained.",
      true,
    ),
  ]);
  if (!r[0].meta.changes) fail(404, "Closure not found");
  return c.json({ ok: true });
});

export async function availabilityContext(
  c: Ctx,
  staffId: string,
  serviceId: string,
  date: string,
) {
  scopeStaff(c, staffId);
  const sid = c.get("shopId");
  const shop = await readShop(c);
  const result = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM staff WHERE shop_id=? AND id=?").bind(
      sid,
      staffId,
    ),
    c.env.DB.prepare("SELECT * FROM services WHERE shop_id=? AND id=?").bind(
      sid,
      serviceId,
    ),
    c.env.DB.prepare(
      "SELECT * FROM staff_hours WHERE shop_id=? AND staff_id=? AND weekday=?",
    ).bind(sid, staffId, weekday(date)),
    c.env.DB.prepare("SELECT * FROM holidays WHERE shop_id=? AND date=?").bind(
      sid,
      date,
    ),
    c.env.DB.prepare(
      "SELECT * FROM bookings WHERE shop_id=? AND staff_id=? AND date>=? AND date<=?",
    ).bind(sid, staffId, date, date),
    c.env.DB.prepare(
      "SELECT * FROM staff_days_off WHERE shop_id=? AND staff_id=? AND date=?",
    ).bind(sid, staffId, date),
    c.env.DB.prepare(
      "SELECT * FROM staff_service_rules WHERE shop_id=? AND staff_id=? AND service_id=?",
    ).bind(sid, staffId, serviceId),
    c.env.DB.prepare("SELECT * FROM addons WHERE shop_id=?").bind(sid),
    c.env.DB.prepare(
      "SELECT * FROM addon_services WHERE shop_id=? AND service_id=?",
    ).bind(sid, serviceId),
    c.env.DB.prepare(
      "SELECT * FROM staff_schedule_overrides WHERE shop_id=? AND staff_id=? AND date=?",
    ).bind(sid, staffId, date),
  ]);
  const staff = result[0].results[0] as Staff | undefined;
  const service = result[1].results[0] as Service | undefined;
  if (!staff || !service)
    fail(404, "Staff or service not found in this workspace");
  return {
    shop,
    staff: staff!,
    service: service!,
    hours: effectiveHours(
      (result[2].results[0] as Hours) ?? null,
      (result[9].results[0] as ScheduleOverride) ?? null,
    ),
    rule: (result[6].results[0] as StaffServiceRule) ?? null,
    addons: result[7].results as Addon[],
    links: result[8].results as AddonLink[],
    holidays: result[3].results as Holiday[],
    bookings: result[4].results as StoredBooking[],
    daysOff: result[5].results as StaffDayOff[],
  };
}
sandbox.get("/availability", async (c) => {
  const parsed = z
    .object({
      date: dateSchema,
      staff_id: z.string().uuid(),
      service_id: z.string().uuid(),
      booking_id: z.string().uuid().optional(),
      // walk_in=1: the current 15-minute slot counts as free (seating someone now).
      walk_in: z.enum(["0", "1"]).default("0"),
      addon_ids: z
        .string()
        .default("")
        .transform((s) => (s ? s.split(",") : []))
        .pipe(addonIdsSchema),
    })
    .safeParse(c.req.query());
  if (!parsed.success)
    fail(400, "Supply a valid date, staff_id and service_id");
  const p = parsed.data!;
  const minStart = p.walk_in === "1" ? Date.now() - 15 * 60000 : Date.now();
  const data = await availabilityContext(c, p.staff_id, p.service_id, p.date);
  const booking = p.booking_id ? await readBooking(c, p.booking_id) : null;
  if (booking && booking.service_id !== p.service_id)
    fail(400, "Rescheduling must use the original service");
  if (data.rule?.enabled === 0) fail(409, "service_ineligible");
  const quote = booking
    ? {
        items: JSON.parse(booking.items_json) as BookingItem[],
        price_pence: booking.price_pence,
        duration_min: booking.duration_min,
      }
    : calculateQuote(
        data.service,
        data.rule,
        data.addons,
        data.links,
        p.addon_ids,
      );
  const duration = quote.duration_min;
  const dayHours = shopDay(data.shop, weekday(p.date));
  const slots = Array.from({ length: 96 }, (_, i) => i * 15)
    .filter((n) => n >= dayHours.starts && n < dayHours.ends)
    .map((start_min) => ({
      start_min,
      reason:
        !booking && !data.service.active
          ? "Service unavailable"
          : slotReason(
              data.shop,
              data.staff,
              data.hours,
              data.holidays,
              data.bookings,
              p.date,
              start_min,
              duration,
              minStart,
              booking?.id,
              data.daysOff,
            ),
    }));
  return c.json({
    slots,
    duration_min: duration,
    price_pence: quote.price_pence,
    items: quote.items,
    overridden:
      !booking &&
      (data.rule?.price_pence != null || data.rule?.duration_min != null),
    service_name: booking?.service_name ?? data.service.name,
    deposit_policy_pence:
      booking?.deposit_policy_pence ??
      Math.min(data.shop.deposit_pence, quote.price_pence),
    cancel_hours: booking?.cancel_hours_snapshot ?? data.shop.cancel_hours,
    timezone: data.shop.timezone,
    quote: {
      service_version: data.service.version,
      shop_version: data.shop.version,
    },
    holds: false,
    mode: "sandbox",
  });
});
// Shared by owner and public booking: identical quote, availability and D1 guards.
export async function createBooking(
  c: Ctx,
  b: Omit<z.infer<typeof publicBookingSchema>, "attendee_name"> & {
    source: "TEST_BOOKING" | "WALK_IN";
    attendee_name?: string;
  },
  channel: "OWNER" | "ONLINE",
  options: { minStart?: number; maxDate?: string; seriesId?: string | null; groupId?: string | null; depositHoldMin?: number } = {},
) {
  // Preserve request hashes for pre-add-on bookings with the same normalized payload.
  const { addon_ids, email, customer_id, attendee_name, ...originalPayload } = b as typeof b & { customer_id?: string; attendee_name?: string };
  const requestHash = await hash(
    JSON.stringify({
      ...originalPayload,
      ...(addon_ids.length ? { addon_ids } : {}),
      ...(email ? { email } : {}),
      ...(attendee_name ? { attendee_name } : {}),
    }),
  );
  const sid = c.get("shopId");
  const replay = async () => {
    const existing = await c.env.DB.prepare(
      "SELECT * FROM bookings WHERE shop_id=? AND request_id=?",
    )
      .bind(sid, b.request_id)
      .first<StoredBooking>();
    if (existing) scopeStaff(c, existing.staff_id);
    if (existing && existing.request_hash !== requestHash)
      fail(409, "idempotency_payload_changed");
    return existing;
  };
  const existing = await replay();
  if (existing) return { booking: existing, replayed: true };
  // A chosen customer record must be this shop's and not merged away; its current phone wins.
  let customerId: string | null = null;
  if (customer_id) {
    const cust = await c.env.DB.prepare(
      "SELECT id, merged_into FROM customers WHERE shop_id=? AND id=?",
    )
      .bind(sid, customer_id)
      .first<{ id: string; merged_into: string | null }>();
    if (!cust) return fail(404, "Customer not found");
    customerId = cust.merged_into ?? cust.id;
  }
  const data = await availabilityContext(c, b.staff_id, b.service_id, b.date);
  if (!data.service.active) fail(409, "service_unavailable");
  if (
    b.quote.service_version !== data.service.version ||
    b.quote.shop_version !== data.shop.version
  )
    fail(409, "quote_changed");
  const quote = calculateQuote(
    data.service,
    data.rule,
    data.addons,
    data.links,
    b.addon_ids,
  );
  if (options.maxDate && b.date > options.maxDate)
    fail(409, "outside_booking_window");
  const reason = slotReason(
    data.shop,
    data.staff,
    data.hours,
    data.holidays,
    data.bookings,
    b.date,
    b.start_min,
    quote.duration_min,
    options.minStart ?? Date.now(),
    undefined,
    data.daysOff,
  );
  if (reason) fail(409, reason === "Slot taken" ? "slot_taken" : reason);
  const start = localInstant(b.date, b.start_min, data.shop.timezone)!;
  const now = Date.now();
  const bookingId = id();
  const statement = c.env.DB.prepare(
    `INSERT INTO bookings(id,shop_id,sequence,request_id,request_hash,staff_id,service_id,customer_name,phone,notes,date,start_min,start_at,end_at,duration_min,service_name,price_pence,deposit_policy_pence,cancel_hours_snapshot,source,created_at,updated_at,quoted_service_version,quoted_shop_version,items_json,channel,email,series_id,customer_id,attendee_name,group_id,deposit_status,deposit_hold_until)
  SELECT ?,?,COALESCE(MAX(sequence),0)+1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM bookings WHERE shop_id=?`,
  ).bind(
    bookingId,
    sid,
    b.request_id,
    requestHash,
    b.staff_id,
    b.service_id,
    b.customer_name,
    b.phone,
    b.notes,
    b.date,
    b.start_min,
    start,
    start + quote.duration_min * 60000,
    quote.duration_min,
    data.service.name,
    quote.price_pence,
    Math.min(data.shop.deposit_pence, quote.price_pence),
    data.shop.cancel_hours,
    b.source,
    now,
    now,
    b.quote.service_version,
    b.quote.shop_version,
    JSON.stringify(quote.items),
    channel,
    email,
    options.seriesId ?? null,
    customerId,
    attendee_name || "",
    options.groupId ?? null,
    // Online deposit: the slot is held as PENDING until Stripe confirms or the hold lapses.
    options.depositHoldMin && Math.min(data.shop.deposit_pence, quote.price_pence) > 0 ? "PENDING" : "NONE",
    options.depositHoldMin && Math.min(data.shop.deposit_pence, quote.price_pence) > 0 ? now + options.depositHoldMin * 60000 : null,
    sid,
  );
  try {
    await c.env.DB.batch([
      // Serialise per-shop inserts so the sequence number (MAX+1) cannot collide under load.
      c.env.DB.prepare("SELECT ollo_lock_shop(?)").bind(sid),
      statement,
      audit(
        c,
        "booking",
        bookingId,
        "BOOKING_CREATED",
        channel === "ONLINE"
          ? options.depositHoldMin
            ? `Customer booked online. Slot held ${options.depositHoldMin} min for the deposit.`
            : "Customer booked online. Deposit payable in the shop; confirmation queued."
          : b.source === "WALK_IN" ? "Walk-in seated." : "Appointment saved by the shop.",
      ),
    ]);
  } catch (err) {
    // Same request_id racing itself: the loser may fail on the slot before the winner's row is
    // visible. Look for the winner, once immediately and once after a short pause.
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = await replay();
      if (previous) return { booking: previous, replayed: true };
      if (attempt === 0) await new Promise((r) => setTimeout(r, 150));
    }
    throw err;
  }
  return { booking: await readBooking(c, bookingId), replayed: false };
}
sandbox.post("/bookings", async (c) => {
  const b = await input(c, bookingSchema);
  // Walk-ins are seated in the current slot: allow a start up to 15 minutes ago.
  const result = await createBooking(c, { ...b, email: "" }, "OWNER", b.source === "WALK_IN" ? { minStart: Date.now() - 15 * 60000 } : {});
  return c.json(result, result.replayed ? 200 : 201);
});
sandbox.get("/bookings/:id", async (c) =>
  c.json({ booking: await readBooking(c, c.req.param("id")) }),
);
sandbox.patch("/bookings/:id/details", async (c) => {
  const body = await input(c, bookingDetailsSchema);
  const b = await readBooking(c, c.req.param("id"));
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE bookings SET customer_name=?,phone=?,notes=?,version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?",
    ).bind(
      body.customer_name,
      body.phone,
      body.notes,
      Date.now(),
      c.get("shopId"),
      b.id,
      body.version,
    ),
    audit(c, "booking", b.id, "DETAILS_UPDATED", body.reason, true),
  );
  return c.json({ booking: await readBooking(c, b.id) });
});
sandbox.post("/bookings/:id/status", async (c) => {
  const body = await input(c, statusSchema);
  const b = await readBooking(c, c.req.param("id"));
  const allowed: Record<string, string[]> = {
    CONFIRMED: ["CHECKED_IN", "CANCELLED", "NO_SHOW"],
    CHECKED_IN: ["IN_SERVICE", "CANCELLED"],
    IN_SERVICE: ["COMPLETED"],
    COMPLETED: [],
    CANCELLED: [],
    NO_SHOW: [],
  };
  if (b.version !== body.version) fail(409, "record_changed");
  if (!allowed[b.status]?.includes(body.status))
    fail(409, "invalid_transition");
  if (["CANCELLED", "NO_SHOW"].includes(body.status) && body.reason.length < 3)
    fail(400, "A reason of at least three characters is required");
  if (body.status === "NO_SHOW") {
    const shop = await readShop(c);
    if (Date.now() < b.start_at + shop.no_show_grace * 60000)
      fail(409, "no_show_grace_not_elapsed");
  }
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE bookings SET status=?,version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?",
    ).bind(body.status, Date.now(), c.get("shopId"), b.id, body.version),
    audit(
      c,
      "booking",
      b.id,
      body.status,
      body.reason || "Status updated by the shop.",
      true,
    ),
  );
  // A cancelled visit frees a slot: offer it to the queue if the shop has auto-offer on. If the
  // shop cancels, a paid deposit goes back to the customer; a pending hold is released.
  if (body.status === "CANCELLED") {
    if (b.deposit_status === "PAID") await refundDeposit(c.env.DB, await readShop(c), b, c.get("actor"), "cancelled by the shop");
    else if (b.deposit_status === "PENDING") await c.env.DB.prepare("UPDATE bookings SET deposit_status='EXPIRED', deposit_hold_until=NULL WHERE shop_id=? AND id=?").bind(c.get("shopId"), b.id).run();
    await autoOffer(c, await shopWithQueue(c, c.get("shopId")), { staff_id: b.staff_id, date: b.date, start_min: b.start_min }, "cancel");
  }
  // A completed visit earns a review request (outbox only).
  if (body.status === "COMPLETED") await queueReviewRequest(c, c.get("shopId"), b.id);
  return c.json({ booking: await readBooking(c, b.id) });
});

// ---- Payments ledger (Model A: records money taken at the chair; holds nothing) ----
function tillAllowed(c: Ctx, shop: Shop, staffId: string) {
  const a = c.get("account");
  if (!a || ["OWNER", "MANAGER"].includes(a.role)) return;
  if (shop.till_access === "ALL" && a.staff_id === staffId) return;
  fail(403, shop.till_access === "ALL" ? "Barbers can only check out their own visits" : "Only the shop device (owner or manager) can take payment");
}
sandbox.post("/bookings/:id/checkout", async (c) => {
  const body = await input(c, checkoutSchema);
  const b = await readBooking(c, c.req.param("id"));
  const shop = await readShop(c);
  tillAllowed(c, shop, b.staff_id);
  if (b.version !== body.version) fail(409, "record_changed");
  if (!["IN_SERVICE", "COMPLETED", "CHECKED_IN"].includes(b.status)) fail(409, "Check the customer in before taking payment");
  // A deposit paid by card online is already the shop's money: it lands in the ledger as an ONLINE
  // tender the first time the visit is checked out, and counts towards what is due at the chair.
  const depositRow = b.deposit_status === "PAID" && (b.deposit_paid_pence ?? 0) > 0
    ? await c.env.DB.prepare("SELECT id FROM payments WHERE shop_id=? AND booking_id=? AND method='ONLINE' AND voided_at IS NULL").bind(c.get("shopId"), b.id).first<{ id: string }>()
    : { id: "n/a" };
  const depositToPost = depositRow ? 0 : Math.min(b.deposit_paid_pence ?? 0, b.price_pence);
  const already = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(service_pence),0) AS paid FROM payments WHERE shop_id=? AND booking_id=? AND voided_at IS NULL",
  )
    .bind(c.get("shopId"), b.id)
    .first<{ paid: number }>();
  const due = Math.max(0, b.price_pence - body.discount_pence - (already?.paid ?? 0) - depositToPost);
  const service = body.tenders.reduce((n, t) => n + t.service_pence, 0);
  if (body.discount_pence > b.price_pence) fail(400, "Discount cannot exceed the visit price");
  if (service > due) fail(409, `Payment exceeds the amount due (${due}p)`);
  if (body.complete && service < due) fail(409, `Amount short by ${due - service}p; record the full amount or leave the visit open`);
  const staff = await c.env.DB.prepare("SELECT commission_pct FROM staff WHERE shop_id=? AND id=?")
    .bind(c.get("shopId"), b.staff_id)
    .first<{ commission_pct: number }>();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  // Move the visit forward so the ledger trigger sees a served visit, then record each tender.
  if (b.status === "CHECKED_IN")
    statements.push(
      c.env.DB.prepare("UPDATE bookings SET status='IN_SERVICE',version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?").bind(now, c.get("shopId"), b.id, b.version),
    );
  let version = b.version + (b.status === "CHECKED_IN" ? 1 : 0);
  const ids: string[] = [];
  if (depositToPost > 0) {
    const pid = id();
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO payments(id,shop_id,booking_id,staff_id,customer_id,date,method,service_pence,tip_pence,discount_pence,commission_pct,note,recorded_by,created_at) VALUES(?,?,?,?,?,?,'ONLINE',?,0,0,?,'Deposit paid by card at booking',?,?)",
      ).bind(pid, c.get("shopId"), b.id, b.staff_id, b.customer_id, shopToday(shop.timezone, now), depositToPost, staff?.commission_pct ?? 50, "stripe", now),
    );
    statements.push(audit(c, "payment", pid, "PAYMENT_RECORDED", `ONLINE ${depositToPost}p deposit (paid at booking) for ${ref(b)}`));
  }
  for (const t of body.tenders) {
    if (t.service_pence === 0 && t.tip_pence === 0) continue;
    const pid = id();
    ids.push(pid);
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO payments(id,shop_id,booking_id,staff_id,customer_id,date,method,service_pence,tip_pence,discount_pence,commission_pct,note,recorded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(pid, c.get("shopId"), b.id, b.staff_id, b.customer_id, shopToday(shop.timezone, now), t.method, t.service_pence, t.tip_pence, ids.length === 1 ? body.discount_pence : 0, staff?.commission_pct ?? 50, body.note, c.get("actor"), now),
    );
    statements.push(audit(c, "payment", pid, "PAYMENT_RECORDED", `${t.method} ${t.service_pence}p service + ${t.tip_pence}p tip for ${ref(b)}`));
  }
  if (!ids.length && !depositToPost) fail(400, "Nothing to record");
  if (body.complete && b.status !== "COMPLETED") {
    statements.push(
      c.env.DB.prepare("UPDATE bookings SET status='COMPLETED',version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?").bind(now, c.get("shopId"), b.id, version),
    );
    statements.push(audit(c, "booking", b.id, "COMPLETED", "Checked out; payment recorded in the ledger.", true));
  }
  await c.env.DB.batch(statements);
  const booking = await readBooking(c, b.id);
  if (body.complete && booking.status === "COMPLETED") await queueReviewRequest(c, c.get("shopId"), b.id);
  const payments = (await c.env.DB.prepare("SELECT * FROM payments WHERE shop_id=? AND booking_id=? ORDER BY created_at").bind(c.get("shopId"), b.id).all<Payment>()).results;
  return c.json({ booking, payments }, 201);
});
sandbox.post("/payments/:id/void", async (c) => {
  const body = await input(c, voidPaymentSchema);
  const a = c.get("account");
  if (a && !["OWNER", "MANAGER"].includes(a.role)) fail(403, "Only the owner or a manager can void a payment");
  const p = await c.env.DB.prepare("SELECT * FROM payments WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first<Payment>();
  if (!p) return fail(404, "Payment not found");
  if (p.voided_at) fail(409, "payment_already_voided");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE payments SET voided_at=?,void_reason=? WHERE shop_id=? AND id=? AND voided_at IS NULL").bind(Date.now(), body.reason, c.get("shopId"), p.id),
    audit(c, "payment", p.id, "PAYMENT_VOIDED", body.reason, true),
  ]);
  return c.json({ payment: { ...p, voided_at: Date.now(), void_reason: body.reason } });
});
// Wallet: ledger totals for a date range (defaults to today), per method and per barber.
sandbox.get("/wallet", async (c) => {
  const shop = await readShop(c);
  const a = c.get("account");
  const assigned = a?.role === "BARBER" ? a.staff_id : null;
  const today = shopToday(shop.timezone);
  const from = dateSchema.safeParse(c.req.query("from")).success ? (c.req.query("from") as string) : today;
  const to = dateSchema.safeParse(c.req.query("to")).success ? (c.req.query("to") as string) : from;
  if (to < from) fail(400, "to must be on or after from");
  const rows = (
    await c.env.DB.prepare(
      "SELECT p.*, b.customer_name, b.service_name, b.start_min FROM payments p JOIN bookings b ON b.shop_id=p.shop_id AND b.id=p.booking_id WHERE p.shop_id=? AND (? IS NULL OR p.staff_id=?) AND p.date BETWEEN ? AND ? ORDER BY p.created_at DESC LIMIT 1000",
    )
      .bind(c.get("shopId"), assigned, assigned, from, to)
      .all<Payment & { customer_name: string; service_name: string; start_min: number }>()
  ).results;
  const live = rows.filter((r) => !r.voided_at);
  const sum = (list: typeof live, f: (r: Payment) => number) => list.reduce((n, r) => n + f(r), 0);
  const byMethod = Object.fromEntries(
    ["CARD", "CASH", "TRANSFER", "VOUCHER"].map((m) => {
      const l = live.filter((r) => r.method === m);
      return [m, { service: sum(l, (r) => r.service_pence), tips: sum(l, (r) => r.tip_pence), count: l.length }];
    }),
  );
  const staffIds = [...new Set(live.map((r) => r.staff_id))];
  const byStaff = staffIds.map((sid) => {
    const l = live.filter((r) => r.staff_id === sid);
    const service = sum(l, (r) => r.service_pence);
    const tips = sum(l, (r) => r.tip_pence);
    const commission = l.reduce((n, r) => n + Math.round((r.service_pence * r.commission_pct) / 100), 0);
    return { staff_id: sid, service, tips, commission, earnings: commission + tips, visits: new Set(l.map((r) => r.booking_id)).size };
  });
  // Booked but not yet paid within the range (served or upcoming today).
  const unpaid = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(b.price_pence),0) AS value, COUNT(*) AS n FROM bookings b WHERE b.shop_id=? AND (? IS NULL OR b.staff_id=?) AND b.date BETWEEN ? AND ? AND b.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE') ",
  )
    .bind(c.get("shopId"), assigned, assigned, from, to)
    .first<{ value: number; n: number }>();
  return c.json({
    from,
    to,
    today,
    till_access: shop.till_access,
    totals: {
      service: sum(live, (r) => r.service_pence),
      tips: sum(live, (r) => r.tip_pence),
      discounts: sum(live, (r) => r.discount_pence),
      visits: new Set(live.map((r) => r.booking_id)).size,
      voided: rows.length - live.length,
      unpaid_value: unpaid?.value ?? 0,
      unpaid_visits: unpaid?.n ?? 0,
    },
    by_method: byMethod,
    by_staff: byStaff,
    payments: rows,
  });
});

// ---- Pay runs: settle a barber for a period from the ledger + their pay terms ----
async function payRunFigures(c: Ctx, staffId: string, from: string, to: string) {
  const sid = c.get("shopId");
  const [pay, hoursRows, offRows, overrideRows, staff, shop] = await Promise.all([
    c.env.DB.prepare(
      "SELECT COALESCE(SUM(service_pence),0) AS service, COALESCE(SUM(tip_pence),0) AS tips, COUNT(DISTINCT booking_id) AS visits FROM payments WHERE shop_id=? AND staff_id=? AND date BETWEEN ? AND ? AND voided_at IS NULL",
    ).bind(sid, staffId, from, to).first<{ service: number; tips: number; visits: number }>(),
    c.env.DB.prepare("SELECT * FROM staff_hours WHERE shop_id=? AND staff_id=?").bind(sid, staffId).all<Hours>(),
    c.env.DB.prepare("SELECT date FROM staff_days_off WHERE shop_id=? AND staff_id=? AND date BETWEEN ? AND ?").bind(sid, staffId, from, to).all<{ date: string }>(),
    c.env.DB.prepare("SELECT * FROM staff_schedule_overrides WHERE shop_id=? AND staff_id=? AND date BETWEEN ? AND ?").bind(sid, staffId, from, to).all<ScheduleOverride>(),
    c.env.DB.prepare("SELECT * FROM staff WHERE shop_id=? AND id=?").bind(sid, staffId).first<Staff>(),
    readShop(c),
  ]);
  if (!staff) return fail(404, "Barber not found");
  const holidays = (await c.env.DB.prepare("SELECT date FROM holidays WHERE shop_id=? AND date BETWEEN ? AND ?").bind(sid, from, to).all<{ date: string }>()).results.map((h) => h.date);
  const off = new Set(offRows.results.map((r) => r.date));
  // Rostered minutes across the period (weekly hours + dated overrides, less leave/closures/breaks).
  let minutes = 0;
  for (let d = from; d <= to; d = datePlusServer(d, 1)) {
    const day = shopDay(shop, weekday(d));
    if (off.has(d) || holidays.includes(d) || !day.enabled) continue;
    const h = effectiveHours(hoursRows.results.find((x) => x.weekday === weekday(d)) ?? null, overrideRows.results.find((o) => o.date === d) ?? null);
    if (!h?.enabled) continue;
    minutes += Math.max(0, Math.min(h.ends, day.ends) - Math.max(h.starts, day.starts)) - Math.max(0, h.break_end - h.break_start);
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const terms = payTermsOf(staff);
  const periodDays = terms.pay_period === "WEEKLY" ? 7 : terms.pay_period === "FORTNIGHTLY" ? 14 : 30;
  const periods = Math.max(1, Math.round(days / periodDays));
  return {
    staff,
    terms,
    input: { service_pence: pay?.service ?? 0, tips_pence: pay?.tips ?? 0, visits: pay?.visits ?? 0, hours_x100: Math.round((minutes / 60) * 100), periods },
  };
}
function datePlusServer(d: string, n: number) {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
sandbox.get("/pay-runs/preview", async (c) => {
  const q = z.object({ staff_id: z.string().uuid(), from: dateSchema, to: dateSchema }).safeParse(c.req.query());
  if (!q.success) fail(400, "Supply staff_id, from and to");
  scopeStaff(c, q.data!.staff_id);
  const { terms, input } = await payRunFigures(c, q.data!.staff_id, q.data!.from, q.data!.to);
  return c.json({ terms, input, result: calculatePayRun(terms, input) });
});
sandbox.get("/pay-runs", async (c) => {
  const a = c.get("account");
  const assigned = a?.role === "BARBER" ? a.staff_id : null;
  const rows = await c.env.DB.prepare(
    "SELECT * FROM pay_runs WHERE shop_id=? AND (? IS NULL OR staff_id=?) ORDER BY period_from DESC, created_at DESC LIMIT 300",
  )
    .bind(c.get("shopId"), assigned, assigned)
    .all<PayRun>();
  return c.json({ pay_runs: rows.results });
});
sandbox.post("/pay-runs", async (c) => {
  const b = await input(c, payRunCreateSchema);
  const { staff, terms, input: figures } = await payRunFigures(c, b.staff_id, b.period_from, b.period_to);
  const r = calculatePayRun(terms, figures, b.adjustments);
  const now = Date.now();
  const runId = id();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO pay_runs(id,shop_id,staff_id,period_from,period_to,pay_model,terms_json,service_pence,tips_pence,visits,hours_x100,commission_pence,base_pence,hourly_pence,tip_pence,rent_pence,adjustments_json,adjustments_pence,net_pence,status,note,created_by,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?,?)`,
      ).bind(runId, c.get("shopId"), staff.id, b.period_from, b.period_to, terms.pay_model, JSON.stringify(terms), figures.service_pence, figures.tips_pence, figures.visits, figures.hours_x100, r.commission_pence, r.base_pence, r.hourly_pence, r.tip_pence, r.rent_pence, JSON.stringify(b.adjustments), r.adjustments_pence, r.net_pence, b.note, c.get("actor"), now, now),
      audit(c, "pay_run", runId, "PAY_RUN_CREATED", `${staff.name} ${b.period_from}..${b.period_to} net ${r.net_pence}p`),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) fail(409, "A pay run already exists for this barber and period");
    throw e;
  }
  const run = await c.env.DB.prepare("SELECT * FROM pay_runs WHERE shop_id=? AND id=?").bind(c.get("shopId"), runId).first<PayRun>();
  return c.json({ pay_run: run }, 201);
});
sandbox.put("/pay-runs/:id", async (c) => {
  const b = await input(c, payRunUpdateSchema);
  const run = await c.env.DB.prepare("SELECT * FROM pay_runs WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first<PayRun>();
  if (!run) return fail(404, "Pay run not found");
  if (run.version !== b.version) fail(409, "record_changed");
  if (run.status === "VOID") fail(409, "This pay run is void");
  const next = b.status ?? run.status;
  const order = ["DRAFT", "APPROVED", "PAID"];
  if (next !== "VOID" && order.indexOf(next) < order.indexOf(run.status)) fail(409, "Pay runs only move forward: draft → approved → paid");
  if (run.status === "PAID" && next !== "VOID") fail(409, "Paid runs are frozen; void it to redo");
  if (next === "VOID" && b.reason.length < 3) fail(400, "A reason of at least three characters is required to void");
  if (next === "PAID" && !(b.paid_method ?? run.paid_method)) fail(400, "Record how it was paid (bank, cash or other)");
  // Adjustments/note only change on drafts; recompute net.
  const adjustments = run.status === "DRAFT" && b.adjustments ? b.adjustments : (JSON.parse(run.adjustments_json) as { label: string; pence: number }[]);
  const terms = JSON.parse(run.terms_json);
  const r = calculatePayRun(terms, { service_pence: run.service_pence, tips_pence: run.tips_pence, visits: run.visits, hours_x100: run.hours_x100, periods: 1 }, adjustments);
  // periods are baked into base/rent already; keep the stored base/rent and only re-sum.
  const net = next === "VOID" ? run.net_pence : (terms.pay_model === "CHAIR_RENT" ? run.tip_pence - run.rent_pence + r.adjustments_pence : run.commission_pence + run.base_pence + run.hourly_pence + run.tip_pence + r.adjustments_pence);
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE pay_runs SET status=?,paid_method=?,paid_reference=?,adjustments_json=?,adjustments_pence=?,net_pence=?,note=?,updated_at=?,version=version+1 WHERE shop_id=? AND id=? AND version=?",
    ).bind(next, b.paid_method ?? run.paid_method, b.paid_reference || run.paid_reference, JSON.stringify(adjustments), r.adjustments_pence, net, b.note ?? run.note, Date.now(), c.get("shopId"), run.id, b.version),
    audit(c, "pay_run", run.id, `PAY_RUN_${next}`, b.reason || (next === "PAID" ? `Paid by ${b.paid_method ?? run.paid_method}${b.paid_reference ? ` · ${b.paid_reference}` : ""}` : ""), true),
  );
  const fresh = await c.env.DB.prepare("SELECT * FROM pay_runs WHERE shop_id=? AND id=?").bind(c.get("shopId"), run.id).first<PayRun>();
  return c.json({ pay_run: fresh });
});
sandbox.post("/bookings/:id/reschedule", async (c) => {
  const body = await input(c, moveSchema);
  const b = await readBooking(c, c.req.param("id"));
  if (b.version !== body.version) fail(409, "record_changed");
  if (b.status !== "CONFIRMED")
    fail(409, "Only confirmed appointments can be rescheduled");
  const data = await availabilityContext(
    c,
    body.staff_id,
    b.service_id,
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
    b.duration_min,
    Date.now(),
    b.id,
    data.daysOff,
  );
  if (reason) fail(409, reason === "Slot taken" ? "slot_taken" : reason);
  const start = localInstant(body.date, body.start_min, data.shop.timezone)!;
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE bookings SET staff_id=?,date=?,start_min=?,start_at=?,end_at=?,version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?",
    ).bind(
      body.staff_id,
      body.date,
      body.start_min,
      start,
      start + b.duration_min * 60000,
      Date.now(),
      c.get("shopId"),
      b.id,
      body.version,
    ),
    audit(c, "booking", b.id, "RESCHEDULED", body.reason, true),
  );
  await autoOffer(c, await shopWithQueue(c, c.get("shopId")), { staff_id: b.staff_id, date: b.date, start_min: b.start_min }, "move");
  return c.json({ booking: await readBooking(c, b.id) });
});
// ---- Appointment panel: per-booking timeline and standing-series operations ----
sandbox.get("/bookings/:id/timeline", async (c) => {
  const b = await readBooking(c, c.req.param("id"));
  const [events, customer, series] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id,action,actor,reason,created_at FROM audit_events WHERE shop_id=? AND entity_type='booking' AND entity_id=? ORDER BY created_at ASC, id ASC LIMIT 100",
    ).bind(c.get("shopId"), b.id).all(),
    b.customer_id
      ? c.env.DB.prepare(
          `SELECT c.id, c.name, c.phone, c.email, c.tags, c.notes, c.preferred_staff_id, c.version,
            COUNT(x.id) AS visits,
            SUM(CASE WHEN x.status='COMPLETED' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN x.status='NO_SHOW' THEN 1 ELSE 0 END) AS no_shows,
            SUM(CASE WHEN x.status='COMPLETED' THEN x.price_pence ELSE 0 END) AS completed_value_pence,
            MAX(CASE WHEN x.status='COMPLETED' AND x.id<>? THEN x.start_at END) AS last_visit_at
           FROM customers c LEFT JOIN bookings x ON x.shop_id=c.shop_id AND x.customer_id=c.id
           WHERE c.shop_id=? AND c.id=? GROUP BY c.id`,
        ).bind(b.id, c.get("shopId"), b.customer_id).first()
      : Promise.resolve(null),
    b.series_id
      ? c.env.DB.prepare(
          "SELECT id,date,start_min,status,version FROM bookings WHERE shop_id=? AND series_id=? ORDER BY start_at",
        ).bind(c.get("shopId"), b.series_id).all()
      : Promise.resolve(null),
  ]);
  return c.json({
    booking: b,
    events: events.results,
    customer,
    series: series?.results ?? [],
  });
});
// Cancel every remaining (future, confirmed) visit in a standing series.
sandbox.post("/series/:id/cancel", async (c) => {
  const body = await input(c, z.object({ reason: z.string().trim().min(3).max(300), from_booking_id: z.string().uuid().optional() }).strict());
  const seriesId = c.req.param("id");
  const rows = await c.env.DB.prepare(
    "SELECT id,staff_id,status,start_at,version FROM bookings WHERE shop_id=? AND series_id=? AND status='CONFIRMED' ORDER BY start_at",
  ).bind(c.get("shopId"), seriesId).all<{ id: string; staff_id: string; status: string; start_at: number; version: number }>();
  if (!rows.results.length) fail(404, "No remaining visits in this series");
  for (const r of rows.results) scopeStaff(c, r.staff_id);
  let targets = rows.results;
  if (body.from_booking_id) {
    const pivot = rows.results.find((r) => r.id === body.from_booking_id);
    if (!pivot) fail(404, "Booking is not part of this series");
    targets = rows.results.filter((r) => r.start_at >= pivot!.start_at);
  }
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const t of targets) {
    statements.push(
      c.env.DB.prepare("UPDATE bookings SET status='CANCELLED',version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=? AND status='CONFIRMED'").bind(now, c.get("shopId"), t.id, t.version),
      audit(c, "booking", t.id, "STATUS_CANCELLED", `${body.reason} (whole series)`, true),
    );
  }
  statements.push(audit(c, "series", seriesId, "SERIES_CANCELLED", `${targets.length} remaining visits cancelled: ${body.reason}`));
  const result = await c.env.DB.batch(statements);
  const cancelled = result.filter((r, i) => i % 2 === 0 && i < targets.length * 2 && r.meta.changes).length;
  return c.json({ series_id: seriesId, cancelled, remaining: targets.length - cancelled });
});
// Move every remaining visit in a series to a new weekly time (same weekday offset kept).
sandbox.post("/series/:id/reschedule", async (c) => {
  const body = await input(
    c,
    z.object({
      staff_id: z.string().uuid(),
      start_min: z.number().int().min(0).max(1425).refine((v) => v % 15 === 0, "Choose a 15-minute start"),
      day_shift: z.number().int().min(-6).max(6).default(0),
      reason: z.string().trim().min(3).max(300),
      from_booking_id: z.string().uuid().optional(),
    }).strict(),
  );
  const seriesId = c.req.param("id");
  const rows = await c.env.DB.prepare(
    "SELECT * FROM bookings WHERE shop_id=? AND series_id=? AND status='CONFIRMED' ORDER BY start_at",
  ).bind(c.get("shopId"), seriesId).all<StoredBooking>();
  if (!rows.results.length) fail(404, "No remaining visits in this series");
  for (const r of rows.results) scopeStaff(c, r.staff_id);
  let targets = rows.results;
  if (body.from_booking_id) {
    const pivot = rows.results.find((r) => r.id === body.from_booking_id);
    if (!pivot) fail(404, "Booking is not part of this series");
    targets = rows.results.filter((r) => r.start_at >= pivot!.start_at);
  }
  const moved: StoredBooking[] = [];
  const failed: { id: string; date: string; reason: string }[] = [];
  for (const b of targets) {
    const d = new Date(`${b.date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + body.day_shift);
    const date = d.toISOString().slice(0, 10);
    try {
      const data = await availabilityContext(c, body.staff_id, b.service_id, date);
      if (data.rule?.enabled === 0) throw new Error("service_ineligible");
      const reason = slotReason(data.shop, data.staff, data.hours, data.holidays, data.bookings, date, body.start_min, b.duration_min, Date.now(), b.id, data.daysOff);
      if (reason) throw new Error(reason);
      const start = localInstant(date, body.start_min, data.shop.timezone)!;
      await checkVersionUpdate(
        c,
        c.env.DB.prepare(
          "UPDATE bookings SET staff_id=?,date=?,start_min=?,start_at=?,end_at=?,version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?",
        ).bind(body.staff_id, date, body.start_min, start, start + b.duration_min * 60000, Date.now(), c.get("shopId"), b.id, b.version),
        audit(c, "booking", b.id, "RESCHEDULED", `${body.reason} (whole series)`, true),
      );
      moved.push(await readBooking(c, b.id));
    } catch (err) {
      failed.push({ id: b.id, date, reason: err instanceof HTTPException ? err.message : String(err).replace(/^Error: /, "").slice(0, 80) });
    }
  }
  await c.env.DB.batch([audit(c, "series", seriesId, "SERIES_RESCHEDULED", `${moved.length} moved, ${failed.length} kept in place: ${body.reason}`)]);
  return c.json({ series_id: seriesId, moved, failed });
});
export default sandbox;
