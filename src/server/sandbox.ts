import { reportRequestError } from "./telemetry";
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
  bookingItemsSchema,
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
  overridable,
  dueAtBooking,
  paymentModeFor,
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
  type BookingAdjustment,
  type StaffBlock,
  blockSchema,
  weekday,
  type Shop,
  type Staff,
  type Service,
  type Hours,
  type StoredBooking,
  type Holiday,
  type AuditEvent,
 shopBuffer } from "./domain";

import { autoOffer, makeOffer, matchesFor, queueReviewRequest, shopWithQueue, sweep, templatesSchema, templatesOf, DEFAULT_TEMPLATES, type WaitlistRow } from "./waitlist";
import { optimiseImage } from "./images";
import { billingSummary, entitlements, setFeature, syncSeats, hasFeature, features as billingFeatures } from "./billing";
import { applyDecisions, changeSchema, decisionSchema, describeChange, previewChange, type ScheduleChange } from "./schedule";
import { channelsFor, drain, enqueue, fmtDate, fmtTime, msgShop, providerStatus, sweepReminders, MESSAGE_TEMPLATES } from "./messaging";
import { agentPrompt, newSecret, voiceEndpoints, voiceOf, voiceSettingsSchema } from "./voice";
import { StripeError, depositsOnline, expireHolds, expireSession, platformBalance, platformFee, refundDeposit, refundIntent, setPayoutSchedule, stripeConnect, stripeLive, stripeStatus } from "./stripe";
import QRCode from "qrcode";
import setup from "./setup";
import { ALERT_KINDS, DEFAULT_PREFS, alertOwners, prefsOf, type AlertPrefs } from "./alerts";
import { buildRows, detectMapping, parseCsv, type ImportPreview } from "./import";
import { cancelReaderAction, connectionToken, createLinkRequest, createTerminalRequest, ensureLocation, listReaders, pollRequest, refreshReader, registerReader, removeReader, type PaymentRequest } from "./chair";
import { accountState, accountsForShop, beginOnboarding, dashboardLink, executeRun, platformPolicy, refreshAccount, reverseForPayment, settlementFor, splitFigures, walletFor, type ConnectedAccount } from "./payouts";
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
  status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 429,
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
  before: D1PreparedStatement[] = [],
) {
  const result = await c.env.DB.batch([...before, update, event]);
  if (!result[before.length].meta.changes) fail(409, "record_changed");
  return result;
}
// Transaction-local flag the booking triggers read: lets the shop double-book or book outside the
// roster on purpose. Scoped to the batch it's included in, so nothing else is ever relaxed.
export function forceSlot(c: Ctx): D1PreparedStatement {
  return c.env.DB.prepare("SELECT set_config('ollo.force_slot', '1', true)");
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
      ["/auth/login", "/auth/signup", "/auth/accept", "/auth/logout", "/auth/demo", "/auth/forgot", "/auth/reset"].includes(path)) ||
    (method === "GET" && ["/auth/me", "/auth/invites/peek", "/auth/reset/peek"].includes(path));
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
        ["/workspace", "/bookings", "/availability", "/customers", "/changes"].includes(
          path,
        )) ||
      (method === "GET" && /^\/customers\/[^/]+$/.test(path)) ||
      (method === "POST" && path === "/customers") ||
      (method === "PUT" && /^\/customers\/[^/]+$/.test(path)) ||
      (method === "POST" && /^\/customers\/[^/]+\/merge$/.test(path)) ||
      (method === "POST" && ["/customers/import/preview", "/customers/import"].includes(path)) ||
      (method === "GET" && ["/waitlist", "/notifications", "/reviews", "/media", "/dev/mailbox"].includes(path)) ||
      (method === "GET" && /^\/notifications\/[^/]+$/.test(path)) ||
      (method === "GET" && /^\/waitlist\/[^/]+\/matches$/.test(path)) ||
      (method === "POST" && /^\/waitlist\/[^/]+\/offer$/.test(path)) ||
      (method === "GET" && ["/bookings/range", "/insights", "/wallet", "/pay-runs", "/shop/page"].includes(path)) ||
      (method === "GET" && path === "/pay-runs/preview") ||
      (method === "POST" && /^\/bookings\/[^/]+\/checkout$/.test(path)) ||
      (method === "POST" && /^\/bookings\/[^/]+\/(deposit\/refund|pay-link|terminal)$/.test(path)) ||
      (method === "GET" && /^\/payment-requests\/[^/]+$/.test(path)) ||
      (method === "POST" && /^\/payment-requests\/[^/]+\/(send|cancel)$/.test(path)) ||
      (method === "GET" && path === "/terminal/readers") ||
      (method === "POST" && ["/terminal/readers", "/terminal/connection-token"].includes(path)) ||
      (method === "POST" && /^\/terminal\/readers\/[^/]+\/refresh$/.test(path)) ||
      (method === "DELETE" && /^\/terminal\/readers\/[^/]+$/.test(path)) ||
      (method === "POST" && /^\/payments\/[^/]+\/void$/.test(path)) ||
      (method === "GET" && ["/shop/payments", "/payments/wallet", "/payments/balance"].includes(path)) ||
      (method === "GET" && /^\/pay-runs\/[^/]+\/transfers$/.test(path)) ||
      (method === "POST" && /^\/pay-runs\/[^/]+\/transfer$/.test(path)) ||
      (method === "POST" && /^\/staff\/[^/]+\/payments\/connect$/.test(path)) ||
      (method === "POST" && /^\/payments\/accounts\/[^/]+\/(refresh|dashboard)$/.test(path)) ||
      (method === "PUT" && /^\/payments\/accounts\/[^/]+\/schedule$/.test(path)) ||
      (method === "POST" && ["/series/preview", "/series"].includes(path)) ||
      (method === "POST" && /^\/series\/[^/]+\/(cancel|reschedule)$/.test(path)) ||
      (method === "GET" && /^\/bookings\/[^/]+\/timeline$/.test(path)) ||
      (method === "POST" && /^\/bookings\/[^/]+\/manage-link$/.test(path)) ||
      (method === "POST" && /^\/waitlist\/[^/]+\/status$/.test(path)) ||
      (method === "GET" && /^\/bookings\/[^/]+$/.test(path)) ||
      (method === "POST" &&
        (path === "/bookings" ||
          /^\/bookings\/[^/]+\/(status|reschedule)$/.test(path))) ||
      (method === "PATCH" && /^\/bookings\/[^/]+\/(details|items)$/.test(path)) ||
      (["GET", "POST"].includes(method) && /^\/staff\/[^/]+\/blocks(\/preview)?$/.test(path)) ||
      (method === "POST" && ["/schedule/preview", "/schedule/apply"].includes(path)) ||
      (method === "DELETE" && /^\/staff\/[^/]+\/blocks\/[^/]+$/.test(path));
    const setup =
      // The setup wizard (owner/manager): its own routes enforce the role again.
      path.startsWith("/setup") ||
      (method === "PUT" && ["/shop", "/shop/online", "/shop/page", "/shop/waitlist", "/shop/messaging", "/shop/payments", "/shop/alerts", "/shop/voice"].includes(path)) ||
      (method === "GET" && (path === "/shop/alerts" || path.startsWith("/shop/voice"))) ||
      (method === "POST" && path === "/shop/voice/rotate") ||
      (method === "POST" && ["/notifications/test", "/notifications/sweep", "/shop/payments/connect"].includes(path)) ||
      (method === "POST" && /^\/notifications\/[^/]+\/resend$/.test(path)) ||
      (method === "POST" && /^\/reviews\/[^/]+\/(status|reply)$/.test(path)) ||
      (method === "POST" && path === "/media") ||
      (["GET", "POST", "PUT"].includes(method) && path.startsWith("/billing")) ||
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
  // Stripe refused, or is switched off: surface its status and message (never a 500 for these).
  if (err instanceof StripeError) {
    const status = err.status === 503 || err.code === "stripe_off" ? 409 : err.status >= 400 && err.status < 500 ? (err.status as 400 | 402 | 404 | 409) : 409;
    return c.json({ error: err.code || "stripe_error", message: err.message }, status);
  }
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
  reportRequestError(err, c, 500);
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
sandbox.route("/setup", setup);

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
      data.blocks,
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

// Live view heartbeat. The till polls this every few seconds; it is one indexed read and returns
// the newest audit timestamp + count for the shop. When either moves, the client re-reads the
// workspace in the background (no flicker). Cheap enough to call constantly.
sandbox.get("/changes", async (c) => {
  const row = await c.env.DB.prepare("SELECT COALESCE(MAX(created_at),0) AS at, COUNT(*) AS n FROM audit_events WHERE shop_id=?")
    .bind(c.get("shopId"))
    .first<{ at: number; n: number }>();
  c.header("Cache-Control", "no-store");
  return c.json({ cursor: `${row?.at ?? 0}:${row?.n ?? 0}`, at: Number(row?.at ?? 0), now: Date.now() });
});
sandbox.get("/workspace", async (c) => {
  const sid = c.get("shopId");
  const shop = await readShop(c);
  const account = c.get("account");
  const assigned = account?.role === "BARBER" ? account.staff_id : null;
  const scoped = (sql: string, extra: unknown[] = []) =>
    c.env.DB.prepare(sql).bind(sid, assigned, assigned, ...extra);
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
    scoped("SELECT * FROM staff_blocks WHERE shop_id=? AND (? IS NULL OR staff_id=?) AND date>=? ORDER BY date,start_min", [shopToday(shop.timezone)]),
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
    blocks: (result[12]?.results ?? []) as StaffBlock[],
    addons: result[7].results as Addon[],
    addon_links: result[8].results as AddonLink[],
    service_rules: rules,
    schedule_overrides: overrides,
    today: shopToday(shop.timezone),
    now: Date.now(),
    mode: "sandbox",
    issues,
    entitlements: await entitlements(c.env.DB, sid).catch(() => null),
  });
});
sandbox.put("/shop", async (c) => {
  const b = await input(c, shopSchema);
  const week = b.week.map((d) => ({ enabled: d.enabled, starts: d.starts, ends: d.ends }));
  const env = weekEnvelope(week);
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE shops SET name=?,address=?,timezone=?,currency=?,opens=?,closes=?,closed_days=?,week_json=?,deposit_pence=?,cancel_hours=?,no_show_grace=?,till_access=?,buffer_min=?,card_colour=?,version=version+1 WHERE id=? AND version=?",
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
      b.buffer_min,
      b.card_colour,
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
  // Search: every word must match somewhere (name, email, tags, notes); digits match the phone with
  // spaces/dashes/+44 stripped, so "07700 900", "7700900" and "+44 7700" all find 07700900123.
  const words = q.split(/\s+/).filter(Boolean);
  const digits = q.replace(/\D/g, "").replace(/^44/, "0").replace(/^0044/, "0");
  const searchClauses: string[] = [];
  const searchBinds: unknown[] = [];
  for (const wd of words) {
    searchClauses.push("(c.name ILIKE '%'||?||'%' OR c.email ILIKE '%'||?||'%' OR c.tags ILIKE '%'||?||'%' OR c.notes ILIKE '%'||?||'%')");
    searchBinds.push(wd, wd, wd, wd);
  }
  let searchSql = searchClauses.length ? searchClauses.join(" AND ") : "TRUE";
  if (digits.length >= 3) {
    searchSql = `((${searchSql}) OR regexp_replace(c.phone, '\\D', '', 'g') LIKE '%'||?||'%' OR regexp_replace(regexp_replace(c.phone, '\\D', '', 'g'), '^44', '0') LIKE '%'||?||'%')`;
    searchBinds.push(digits, digits);
  }
  const binds: unknown[] = [now, now, assigned, assigned, c.get("shopId"), ...searchBinds];
  if (filter === "new") binds.push(now - 30 * 86400000);
  if (filter === "lapsed") binds.push(now - 60 * 86400000, now);
  if (filter === "upcoming") binds.push(now);
  if (sort === "next") binds.push(now, now);
  binds.push(limit);
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.phone, c.email, c.tags, c.notes, c.preferred_staff_id, c.birthday, c.marketing_opt_in, c.contact_pref, c.version, c.created_at, ${customerStats},
      (SELECT b2.staff_id FROM bookings b2 WHERE b2.shop_id=c.shop_id AND b2.customer_id=c.id AND b2.status='COMPLETED' GROUP BY b2.staff_id ORDER BY COUNT(*) DESC, MAX(b2.start_at) DESC LIMIT 1) AS favourite_staff_id,
      (SELECT b3.service_name FROM bookings b3 WHERE b3.shop_id=c.shop_id AND b3.customer_id=c.id AND b3.status='COMPLETED' GROUP BY b3.service_name ORDER BY COUNT(*) DESC, MAX(b3.start_at) DESC LIMIT 1) AS favourite_service
     FROM customers c
     LEFT JOIN bookings b ON b.shop_id=c.shop_id AND b.customer_id=c.id AND (? IS NULL OR b.staff_id=?)
     WHERE c.shop_id=? AND c.merged_into IS NULL
     AND (${searchSql})
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
// CSV import: preview (nothing written) then commit (creates + fills blanks on existing).
const importBody = z.object({ csv: z.string().min(1).max(2_000_000), mapping: z.record(z.string(), z.string().nullable()).optional() }).strict();
async function importPreview(c: Ctx, body: z.infer<typeof importBody>) {
  const table = parseCsv(body.csv);
  if (table.length < 2) fail(400, "The file needs a header row and at least one customer");
  const headers = table[0].map((h) => h.trim());
  const mapping = { ...detectMapping(headers), ...(body.mapping ?? {}) };
  if (!mapping.phone) fail(400, "Couldn't find a mobile number column — choose it below");
  if (!mapping.name && !(mapping.first_name || mapping.last_name)) fail(400, "Couldn't find a name column — choose it below");
  const records = table.slice(1, 5001);
  const existingRows = (await c.env.DB.prepare("SELECT id, name, phone, email, notes, tags, birthday, marketing_opt_in FROM customers WHERE shop_id=? AND merged_into IS NULL").bind(c.get("shopId")).all<{ id: string; name: string; phone: string; email: string; notes: string; tags: string; birthday: string | null; marketing_opt_in: number }>()).results;
  const existing = new Map(existingRows.map((r) => [r.phone, r]));
  const rows = buildRows(records, headers, mapping, existing);
  const counts = { create: 0, update: 0, skip: 0, invalid: 0, total: rows.length };
  for (const r of rows) counts[r.action]++;
  return { columns: headers, mapping, rows, counts } satisfies ImportPreview;
}
sandbox.post("/customers/import/preview", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const body = await input(c, importBody);
  const p = await importPreview(c, body);
  // Trim the row list for the wire; the client shows the first 200 and the counts.
  return c.json({ ...p, rows: p.rows.slice(0, 200), truncated: p.rows.length > 200 });
});
sandbox.post("/customers/import", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const body = await input(c, importBody);
  const p = await importPreview(c, body);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  let created = 0, updated = 0;
  for (const r of p.rows) {
    if (r.action === "create") {
      stmts.push(
        c.env.DB.prepare("INSERT INTO customers(id,shop_id,name,phone,email,notes,tags,birthday,preferred_staff_id,marketing_opt_in,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?) ON CONFLICT(shop_id,phone) DO NOTHING")
          .bind(id(), c.get("shopId"), r.name, r.phone, r.email, r.notes, JSON.stringify(r.tags), r.birthday || null, r.marketing_opt_in, now, now),
      );
      created++;
    } else if (r.action === "update" && r.existing_id) {
      // Fill blanks only; append notes; union tags; never turn marketing off.
      stmts.push(
        c.env.DB.prepare(
          `UPDATE customers SET
             email=CASE WHEN email='' THEN ? ELSE email END,
             notes=CASE WHEN ?<>'' AND POSITION(? IN notes)=0 THEN TRIM(BOTH E'\n' FROM notes || E'\n' || ?) ELSE notes END,
             tags=(SELECT COALESCE(jsonb_agg(DISTINCT t), '[]'::jsonb)::text FROM jsonb_array_elements_text(tags::jsonb || ?::jsonb) AS t),
             birthday=COALESCE(birthday, ?),
             marketing_opt_in=GREATEST(marketing_opt_in, ?),
             version=version+1, updated_at=?
           WHERE shop_id=? AND id=?`,
        ).bind(r.email, r.notes, r.notes, r.notes, JSON.stringify(r.tags), r.birthday || null, r.marketing_opt_in, now, c.get("shopId"), r.existing_id),
      );
      updated++;
    }
  }
  if (!stmts.length) fail(409, "Nothing to import — every row is invalid or already here");
  stmts.push(audit(c, "shop", c.get("shopId"), "CUSTOMERS_IMPORTED", `${created} added, ${updated} updated from a ${p.counts.total}-row file (${p.counts.invalid} invalid, ${p.counts.skip} skipped).`));
  // Batches of 200 keep each transaction small.
  for (let i = 0; i < stmts.length; i += 200) await c.env.DB.batch(stmts.slice(i, i + 200));
  return c.json({ ok: true, created, updated, skipped: p.counts.skip, invalid: p.counts.invalid, total: p.counts.total }, 201);
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
    messaging: { msg_sms: ms.msg_sms ?? 1, msg_email: ms.msg_email ?? 1, msg_wa: ms.msg_wa ?? 1, msg_reminders: ms.msg_reminders ?? 1, msg_reminder_hours: ms.msg_reminder_hours ?? 24, msg_reply_to: ms.msg_reply_to || "", msg_sms_sender: ms.msg_sms_sender || "" },
    templates: templatesOf(shop),
    defaults: DEFAULT_TEMPLATES,
    settings: { waitlist_auto_offer: shop.waitlist_auto_offer, waitlist_offer_hold_min: shop.waitlist_offer_hold_min },
    // Current shop version: sibling forms on the same tab (messaging, alerts, voice) bump it without a
    // workspace re-read, so the waitlist save must not rely on the stale workspace copy.
    shop_version: shop.version,
  });
});
const requireRole = (c: Ctx, roles: string[]) => {
  const a = c.get("account");
  if (a && !roles.includes(a.role)) fail(403, "Owner or manager required");
};
// WhatsApp replies from customers (matched to this shop by the last message we sent them).
sandbox.get("/notifications/inbound", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT i.id, i.shop_id, i.phone, i.body, i.received_at, COALESCE(cu.name,'') AS customer_name, cu.id AS customer_id FROM wa_inbound i LEFT JOIN customers cu ON cu.shop_id=i.shop_id AND regexp_replace(cu.phone,'\\D','','g') IN (i.phone, '0'||substr(i.phone,3)) AND cu.merged_into IS NULL WHERE i.shop_id=? ORDER BY i.received_at DESC LIMIT 100",
  ).bind(c.get("shopId")).all();
  return c.json({ inbound: rows.results });
});
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
    // Older clients omit this; WhatsApp stays on unless the shop switches it off.
    msg_wa: z.union([z.literal(0), z.literal(1)]).default(1),
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
    c.env.DB.prepare("UPDATE shops SET msg_sms=?,msg_email=?,msg_wa=?,msg_reminders=?,msg_reminder_hours=?,msg_reply_to=?,msg_sms_sender=?,version=version+1 WHERE id=?").bind(b.msg_sms, b.msg_email, b.msg_wa, b.msg_reminders, b.msg_reminder_hours, b.msg_reply_to, b.msg_sms_sender, sid),
    audit(c, "shop", sid, "MESSAGING_UPDATED", `SMS ${b.msg_sms ? "on" : "off"}, WhatsApp ${b.msg_wa ? "on" : "off"}, email ${b.msg_email ? "on" : "off"}, reminders ${b.msg_reminders ? `${b.msg_reminder_hours}h` : "off"}.`),
  ]);
  const shop_version = (await c.env.DB.prepare("SELECT version FROM shops WHERE id=?").bind(sid).first<{ version: number }>())?.version;
  return c.json({ ok: true, messaging: b, shop_version });
});
// AI receptionist (ElevenLabs) — per-shop agent id, secret and the endpoints to paste into the agent.
sandbox.get("/shop/voice", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const shop = await readShop(c);
  const v = voiceOf((shop as Shop & { voice_json?: string }).voice_json);
  const origin = new URL(c.req.url).origin;
  const calls = (await c.env.DB.prepare("SELECT id,conversation_id,caller,outcome,summary,booking_id,duration_s,started_at FROM voice_calls WHERE shop_id=? ORDER BY started_at DESC LIMIT 50").bind(shop.id).all()).results;
  return c.json({
    settings: { enabled: v.enabled, agent_id: v.agent_id, greeting: v.greeting, notes: v.notes, has_secret: !!v.secret, has_webhook_secret: !!v.webhook_secret, created_at: v.created_at ?? null },
    // The secret is shown in full only right after it is (re)generated; here just the tail.
    secret_hint: v.secret ? `…${v.secret.slice(-6)}` : "",
    endpoints: shop.slug ? voiceEndpoints(origin, shop.slug) : null,
    prompt: agentPrompt(shop.name),
    online_booking_required: !shop.online_booking || !shop.slug,
    calls,
  });
});
sandbox.put("/shop/voice", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const b = await input(c, voiceSettingsSchema);
  const shop = await readShop(c);
  const cur = voiceOf((shop as Shop & { voice_json?: string }).voice_json);
  if (b.enabled && (!shop.online_booking || !shop.slug)) fail(409, "Turn on online booking first — the receptionist books through the same diary.");
  // The receptionist is a paid add-on: switching it on enables the entitlement (billed from today,
  // shown on the next invoice); switching off removes it. Admin blocks win.
  if (b.enabled) {
    const e = await entitlements(c.env.DB, c.get("shopId"));
    if (e.features.ai_concierge?.source === "ADMIN_BLOCK") fail(403, "The AI Concierge is disabled for your account — contact OLLO support");
    if (!hasFeature(e, "ai_concierge")) await setFeature(c.env.DB, c.get("shopId"), "ai_concierge", true, "ADDON", c.get("actor"), "Switched on from Messages & AI");
  } else {
    const e = await entitlements(c.env.DB, c.get("shopId"));
    if (e.features.ai_concierge?.source === "ADDON") await setFeature(c.env.DB, c.get("shopId"), "ai_concierge", false, "ADDON", c.get("actor"), "Switched off from Messages & AI");
  }
  // First enable mints the secret; it is returned once here so the owner can paste it into ElevenLabs.
  const minted = b.enabled && !cur.secret;
  const { webhook_secret, ...rest } = b;
  const next = { ...cur, ...rest, webhook_secret: webhook_secret !== undefined ? webhook_secret : cur.webhook_secret, secret: cur.secret || (b.enabled ? newSecret() : ""), created_at: cur.created_at || (b.enabled ? Date.now() : undefined) };
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE shops SET voice_json=?, version=version+1 WHERE id=?").bind(JSON.stringify(next), shop.id),
    audit(c, "shop", shop.id, "VOICE_UPDATED", `AI receptionist ${b.enabled ? "on" : "off"}${b.agent_id ? ` · agent ${b.agent_id}` : ""}.`),
  ]);
  return c.json({ ok: true, settings: { enabled: next.enabled, agent_id: next.agent_id, greeting: next.greeting, notes: next.notes, has_secret: !!next.secret }, ...(minted ? { secret: next.secret } : {}) });
});
sandbox.post("/shop/voice/rotate", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  await input(c, z.object({}).strict());
  const shop = await readShop(c);
  const cur = voiceOf((shop as Shop & { voice_json?: string }).voice_json);
  const next = { ...cur, secret: newSecret(), created_at: Date.now() };
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE shops SET voice_json=?, version=version+1 WHERE id=?").bind(JSON.stringify(next), shop.id),
    audit(c, "shop", shop.id, "VOICE_SECRET_ROTATED", "AI receptionist secret regenerated; the old one stops working now."),
  ]);
  return c.json({ ok: true, secret: next.secret });
});
sandbox.get("/shop/voice/calls/:id", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const row = await c.env.DB.prepare("SELECT * FROM voice_calls WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first();
  if (!row) fail(404, "Call not found");
  return c.json({ call: row });
});
// Owner/manager alert preferences (shops.notify_json).
sandbox.get("/shop/alerts", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const shop = await readShop(c);
  const owner = await c.env.DB.prepare("SELECT u.email FROM shop_owners o JOIN app_users u ON u.id=o.user_id WHERE o.shop_id=?").bind(shop.id).first<{ email: string }>();
  const managers = (await c.env.DB.prepare("SELECT u.name,u.email FROM app_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.shop_id=? AND m.active=1 AND m.role='MANAGER'").bind(shop.id).all<{ name: string; email: string }>()).results;
  return c.json({ prefs: prefsOf(shop.notify_json), kinds: ALERT_KINDS, defaults: DEFAULT_PREFS, recipients: { owner_email: owner?.email || "", owner_phone: shop.phone_verified_at ? shop.phone : "", phone_unverified: !!shop.phone && !shop.phone_verified_at, managers } });
});
sandbox.put("/shop/alerts", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const ch = z.enum(["OFF", "EMAIL", "SMS", "BOTH"]);
  const b = await input(c, z.object({ new_booking: ch, cancelled: ch, no_show: ch, daily_summary: ch, managers: z.boolean(), summary_hour: z.number().int().min(5).max(12) }).strict());
  const sid = c.get("shopId");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE shops SET notify_json=?, version=version+1 WHERE id=?").bind(JSON.stringify(b satisfies AlertPrefs), sid),
    audit(c, "shop", sid, "ALERTS_UPDATED", `Booking ${b.new_booking.toLowerCase()}, cancel ${b.cancelled.toLowerCase()}, no-show ${b.no_show.toLowerCase()}, summary ${b.daily_summary.toLowerCase()}${b.daily_summary !== "OFF" ? ` at ${b.summary_hour}:00` : ""}; managers ${b.managers ? "included" : "excluded"}.`),
  ]);
  return c.json({ ok: true, prefs: b });
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
  const r = await drain(c.env.DB, 1, Date.now(), { type: "test", id: c.get("actor") });
  const row = await c.env.DB.prepare("SELECT id,status,status_note,provider,error FROM notifications WHERE shop_id=? AND template='test_message' ORDER BY created_at DESC LIMIT 1").bind(c.get("shopId")).first();
  return c.json({ ok: true, result: r, notification: row }, 201);
});
// Retry a FAILED message now.
sandbox.post("/notifications/:id/resend", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  await input(c, z.object({}).strict());
  const r = await c.env.DB.prepare("UPDATE notifications SET status='QUEUED', next_attempt_at=?, attempts=0, error='', status_note='Resend requested.' WHERE shop_id=? AND id=? AND status IN ('FAILED','SKIPPED')").bind(Date.now(), c.get("shopId"), c.req.param("id")).run();
  if (!r.meta.changes) fail(409, "Only failed messages can be resent");
  const target = await c.env.DB.prepare("SELECT related_type, related_id FROM notifications WHERE id=?").bind(c.req.param("id")).first<{ related_type: string; related_id: string }>();
  await drain(c.env.DB, 5, Date.now(), target ? { type: target.related_type, id: target.related_id } : undefined);
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

// ---- Payments: OLLO is the Stripe Connect platform ------------------------------------------------
// Status for Settings → Payments: provider, this shop's account, every barber's account, deposit +
// payout policy, 30-day totals. Barbers see only their own account.
sandbox.get("/shop/payments", async (c) => {
  const shop = await readShop(c);
  const a = c.get("account");
  const since = Date.now() - 30 * 86400000;
  const totals = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(CASE WHEN deposit_status='PAID' THEN deposit_paid_pence ELSE 0 END),0)::int AS deposits_pence, COUNT(*) FILTER (WHERE deposit_status='PAID')::int AS deposits, COUNT(*) FILTER (WHERE deposit_status='REFUNDED')::int AS refunded, COUNT(*) FILTER (WHERE deposit_status='EXPIRED')::int AS expired, COUNT(*) FILTER (WHERE deposit_status='PENDING')::int AS pending FROM bookings WHERE shop_id=? AND created_at>?",
  ).bind(shop.id, since).first();
  const moved = await c.env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN kind='PAYOUT' AND owner_type='STAFF' THEN amount_pence ELSE 0 END),0)::int AS to_barbers, COALESCE(SUM(CASE WHEN kind='PAYOUT' AND owner_type='SHOP' THEN amount_pence ELSE 0 END),0)::int AS to_shop, COALESCE(SUM(CASE WHEN kind='REVERSAL' THEN -amount_pence ELSE 0 END),0)::int AS reversed FROM transfers WHERE shop_id=? AND created_at>?").bind(shop.id, since).first();
  const accounts = await accountsForShop(c.env.DB, shop.id);
  const staff = (await c.env.DB.prepare("SELECT id,name,role,active FROM staff WHERE shop_id=? ORDER BY sort_order,name").bind(shop.id).all<{ id: string; name: string; role: string; active: number }>()).results;
  const mine = a?.role === "BARBER" ? a.staff_id : null;
  const shopAcct = accounts.find((x) => x.owner_type === "SHOP") ?? null;
  const policy = await platformPolicy(c.env.DB);
  return c.json({
    stripe: stripeStatus(),
    platform: { fee_bps: policy.fee_bps, fee_fixed_pence: policy.fee_fixed_pence, fast_payouts: policy.fast_payouts },
    settings: { deposits_online: shop.deposits_online ?? 0, deposit_hold_min: shop.deposit_hold_min ?? 15, payment_mode: shop.payment_mode ?? "DEPOSIT", deposit_pence: shop.deposit_pence, payout_tier: shop.payout_tier ?? "STANDARD", payrun_auto: shop.payrun_auto ?? "OFF", payrun_reserve_bps: shop.payrun_reserve_bps ?? 0 },
    shop_account: mine ? null : shopAcct && { ...shopAcct, state: accountState(shopAcct) },
    barbers: staff
      .filter((st) => !mine || st.id === mine)
      .map((st) => {
        const acct = accounts.find((x) => x.owner_type === "STAFF" && x.owner_id === st.id) ?? null;
        return { id: st.id, name: st.name, role: st.role, active: st.active, account: acct && { id: acct.id, email: acct.email, payout_schedule: acct.payout_schedule, details_submitted: acct.details_submitted, payouts_enabled: acct.payouts_enabled }, state: accountState(acct) };
      }),
    active: depositsOnline(shop),
    payouts_ready: stripeLive() && stripeConnect() && !!shopAcct?.payouts_enabled,
    totals_30d: { ...(totals as object), ...(moved as object) },
  });
});
const paymentsSchema = z
  .object({
    deposits_online: z.union([z.literal(0), z.literal(1)]),
    deposit_hold_min: z.number().int().min(5).max(120),
    payment_mode: z.enum(["PREPAY", "DEPOSIT", "PAY_AT_VISIT"]).default("DEPOSIT"),
    payout_tier: z.enum(["STANDARD", "FAST"]).default("STANDARD"),
    payrun_auto: z.enum(["OFF", "DAILY", "WEEKLY"]).default("OFF"),
    payrun_reserve_bps: z.number().int().min(0).max(5000).default(0),
  })
  .strict();
sandbox.put("/shop/payments", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const b = await input(c, paymentsSchema);
  const shop = await readShop(c);
  if (b.deposits_online && !stripeLive()) fail(409, "Card payments are not switched on for OLLO yet");
  if (b.deposits_online && b.payment_mode === "DEPOSIT" && shop.deposit_pence <= 0) fail(409, "Set a deposit amount above zero first");
  if (b.payment_mode === "PREPAY" && !b.deposits_online) fail(409, "Pre-payment needs card payments at booking switched on");
  if (b.payrun_auto !== "OFF" && !stripeLive()) fail(409, "Automatic pay runs need card payments switched on");
  const policy = await platformPolicy(c.env.DB);
  if (b.payout_tier === "FAST" && !policy.fast_payouts) fail(409, "Fast payouts are not available on this plan");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE shops SET deposits_online=?, deposit_hold_min=?, payment_mode=?, payout_tier=?, payrun_auto=?, payrun_reserve_bps=?, version=version+1 WHERE id=?").bind(b.deposits_online, b.deposit_hold_min, b.payment_mode, b.payout_tier, b.payrun_auto, b.payrun_reserve_bps, shop.id),
    audit(c, "shop", shop.id, "PAYMENTS_UPDATED", `Online payment: ${b.payment_mode.toLowerCase().replace(/_/g, " ")}; deposits by card ${b.deposits_online ? `on (hold ${b.deposit_hold_min} min)` : "off"}; payouts ${b.payout_tier.toLowerCase()}; auto pay runs ${b.payrun_auto.toLowerCase()}; reserve ${b.payrun_reserve_bps / 100}%.`),
  ]);
  return c.json({ ok: true, settings: b });
});
// Onboarding: the shop (owner only) or a barber (owner/manager, or the barber themself).
sandbox.post("/shop/payments/connect", async (c) => {
  requireRole(c, ["OWNER"]);
  await input(c, z.object({}).strict());
  if (!stripeLive() || !stripeConnect()) fail(409, "Card payments are not switched on for OLLO yet");
  const shop = await readShop(c);
  const { account, url } = await beginOnboarding(c.env.DB, shop, { type: "SHOP", id: shop.id, name: shop.name, email: c.get("account")?.email || "" }, new URL(c.req.url).origin, "/workspace?stripe=return&for=shop");
  await c.env.DB.batch([audit(c, "shop", shop.id, "STRIPE_ONBOARDING_STARTED", `Shop account ${account.id}.`)]);
  return c.json({ ok: true, account_id: account.id, url }, 201);
});
sandbox.post("/staff/:id/payments/connect", async (c) => {
  const body = await input(c, z.object({ email: z.union([z.literal(""), z.string().trim().email().max(120)]).default("") }).strict());
  const a = c.get("account");
  const staffId = c.req.param("id");
  if (a && a.role === "BARBER" && a.staff_id !== staffId) fail(403, "You can only set up your own payouts");
  if (a && !["OWNER", "MANAGER", "BARBER"].includes(a.role)) fail(403, "Owner or manager required");
  if (!stripeLive() || !stripeConnect()) fail(409, "Card payments are not switched on for OLLO yet");
  const shop = await readShop(c);
  const st = await c.env.DB.prepare("SELECT * FROM staff WHERE shop_id=? AND id=?").bind(shop.id, staffId).first<Staff>();
  if (!st) fail(404, "Barber not found");
  // Stripe needs a contact email on every recipient account. Prefer the barber's own login, then the
  // address typed in, then the person starting this (the owner) — Stripe's form lets the barber
  // correct it during onboarding.
  const email = (await c.env.DB.prepare("SELECT u.email FROM app_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.shop_id=? AND m.staff_id=? LIMIT 1").bind(shop.id, staffId).first<{ email: string }>())?.email || body.email || a?.email || "";
  if (!email) fail(400, "Add an email address for this barber first");
  const { account, url } = await beginOnboarding(c.env.DB, shop, { type: "STAFF", id: st!.id, name: st!.name, email }, new URL(c.req.url).origin, `/workspace?stripe=return&for=${st!.id}`);
  await c.env.DB.batch([audit(c, "staff", st!.id, "STRIPE_ONBOARDING_STARTED", `${st!.name}: account ${account.id}.`)]);
  return c.json({ ok: true, account_id: account.id, url }, 201);
});
// Re-read an account from Stripe (after the return trip, or on demand).
sandbox.post("/payments/accounts/:id/refresh", async (c) => {
  await input(c, z.object({}).strict());
  const acct = await c.env.DB.prepare("SELECT * FROM connected_accounts WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first<ConnectedAccount>();
  if (!acct) fail(404, "Account not found");
  const a = c.get("account");
  if (a?.role === "BARBER" && !(acct!.owner_type === "STAFF" && acct!.owner_id === a.staff_id)) fail(403, "Not your account");
  const snap = await refreshAccount(c.env.DB, acct!.id).catch(() => null);
  if (!snap) fail(409, "Could not reach Stripe");
  const fresh = await c.env.DB.prepare("SELECT * FROM connected_accounts WHERE id=?").bind(acct!.id).first<ConnectedAccount>();
  return c.json({ account: fresh, state: accountState(fresh!) });
});
// One-time link into the Express dashboard (balance, payouts, instant payout).
sandbox.post("/payments/accounts/:id/dashboard", async (c) => {
  await input(c, z.object({}).strict());
  const acct = await c.env.DB.prepare("SELECT * FROM connected_accounts WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first<ConnectedAccount>();
  if (!acct) fail(404, "Account not found");
  const a = c.get("account");
  if (a?.role === "BARBER" && !(acct!.owner_type === "STAFF" && acct!.owner_id === a.staff_id)) fail(403, "Not your account");
  if (a && acct!.owner_type === "SHOP" && !["OWNER", "MANAGER"].includes(a.role)) fail(403, "Owner or manager required");
  const url = await dashboardLink(acct!.id).catch(() => null);
  if (!url) fail(409, "Could not open the Stripe dashboard right now");
  return c.json({ url });
});
// Payout schedule for an account (daily / weekly / monthly).
sandbox.put("/payments/accounts/:id/schedule", async (c) => {
  const b = await input(c, z.object({ interval: z.enum(["daily", "weekly", "monthly"]) }).strict());
  const acct = await c.env.DB.prepare("SELECT * FROM connected_accounts WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first<ConnectedAccount>();
  if (!acct) fail(404, "Account not found");
  const a = c.get("account");
  if (a?.role === "BARBER" && !(acct!.owner_type === "STAFF" && acct!.owner_id === a.staff_id)) fail(403, "Not your account");
  await setPayoutSchedule(acct!.id, b.interval).catch(() => fail(409, "Stripe rejected the schedule change"));
  await c.env.DB.prepare("UPDATE connected_accounts SET payout_schedule=?, updated_at=? WHERE id=?").bind(b.interval, Date.now(), acct!.id).run();
  return c.json({ ok: true, payout_schedule: b.interval });
});
// Wallet: earned / transferred / paid out for the shop or one barber over a period.
sandbox.get("/payments/wallet", async (c) => {
  const q = z.object({ owner: z.enum(["SHOP", "STAFF"]), id: z.string().optional(), from: dateSchema, to: dateSchema }).safeParse(c.req.query());
  if (!q.success) fail(400, "Supply owner, from and to");
  const a = c.get("account");
  const ownerId = q.data!.owner === "SHOP" ? c.get("shopId") : q.data!.id || a?.staff_id || "";
  if (q.data!.owner === "STAFF") scopeStaff(c, ownerId);
  else if (a && !["OWNER", "MANAGER"].includes(a.role)) fail(403, "Owner or manager required");
  return c.json(await walletFor(c.env.DB, c.get("shopId"), { type: q.data!.owner, id: ownerId }, q.data!.from, q.data!.to));
});
// Platform balance (float) — owners see it so "waiting for settlement" makes sense.
sandbox.get("/payments/balance", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  if (!stripeLive()) return c.json({ available_pence: 0, pending_pence: 0, live: false });
  const b = await platformBalance().catch(() => null);
  return c.json({ ...(b ?? { available_pence: 0, pending_pence: 0 }), live: !!b });
});
// ---- Card at the chair: pay link / QR and Terminal readers ---------------------------------------
const chairAmounts = z
  .object({
    version: z.number().int().min(0),
    service_pence: z.number().int().min(0).max(1000000),
    tip_pence: z.number().int().min(0).max(100000).default(0),
    discount_pence: z.number().int().min(0).max(100000).default(0),
    complete: z.boolean().default(true),
    note: z.string().trim().max(300).default(""),
    reader_id: z.string().trim().max(60).optional(),
  })
  .strict();
async function chairPrecheck(c: Ctx, bookingId: string, body: z.infer<typeof chairAmounts>) {
  const b = await readBooking(c, bookingId);
  const shop = await readShop(c);
  tillAllowed(c, shop, b.staff_id);
  if (b.version !== body.version) fail(409, "record_changed");
  if (!["IN_SERVICE", "COMPLETED", "CHECKED_IN", "CONFIRMED"].includes(b.status)) fail(409, "This visit cannot take payment");
  const already = await c.env.DB.prepare("SELECT COALESCE(SUM(service_pence),0) AS paid FROM payments WHERE shop_id=? AND booking_id=? AND voided_at IS NULL").bind(shop.id, b.id).first<{ paid: number }>();
  const depositCredit = b.deposit_status === "PAID" ? Math.min(b.deposit_paid_pence ?? 0, b.price_pence) : 0;
  const due = Math.max(0, b.price_pence - body.discount_pence - (already?.paid ?? 0) - depositCredit);
  if (body.service_pence > due) fail(409, `Payment exceeds the amount due (${due}p)`);
  if (body.complete && body.service_pence < due) fail(409, `Amount short by ${due - body.service_pence}p; charge the full amount or leave the visit open`);
  const open = await c.env.DB.prepare("SELECT id FROM payment_requests WHERE shop_id=? AND booking_id=? AND status='OPEN'").bind(shop.id, b.id).first<{ id: string }>();
  if (open) fail(409, "A card request is already open for this visit — cancel it first");
  return { b, shop };
}
// Pay link / QR: the customer pays on their own phone (or scans the shop device).
sandbox.post("/bookings/:id/pay-link", async (c) => {
  const body = await input(c, chairAmounts);
  const { b, shop } = await chairPrecheck(c, c.req.param("id"), body);
  const req = await createLinkRequest(c.env.DB, shop, b, body, c.get("actor"), new URL(c.req.url).origin);
  await c.env.DB.batch([audit(c, "booking", b.id, "PAY_LINK_CREATED", `${body.service_pence + body.tip_pence}p card request via link (${req.id.slice(0, 8)}).`)]);
  // The QR carries OLLO's short /pay/:id URL (scans in a blink), which hands straight to Stripe
  // Checkout while the request is open. The long checkout.stripe.com URL would make a dense code.
  const short = `${new URL(c.req.url).origin}/pay/${req.id}?go=1`;
  const qr = await QRCode.toDataURL(short, { margin: 1, width: 320, errorCorrectionLevel: "M" });
  return c.json({ request: req, qr, short_url: short }, 201);
});
// Send the open link to the customer's phone/email (shop-branded message).
sandbox.post("/payment-requests/:id/send", async (c) => {
  const body = await input(c, z.object({ channel: z.enum(["SMS", "EMAIL"]) }).strict());
  const req = await c.env.DB.prepare("SELECT * FROM payment_requests WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first<PaymentRequest>();
  if (!req) return fail(404, "Request not found");
  if (req.status !== "OPEN") fail(409, "This request is no longer open");
  const b = await readBooking(c, req.booking_id);
  const to = body.channel === "SMS" ? { phone: b.phone, name: b.customer_name } : { email: b.email, name: b.customer_name };
  if (!(body.channel === "SMS" ? b.phone : b.email)) fail(409, `No ${body.channel === "SMS" ? "mobile number" : "email"} on this visit`);
  const ms = await msgShop(c, c.get("shopId"));
  const stmts = enqueue(c.env.DB, ms, to, "pay_link", { service: b.service_name, amount: new Intl.NumberFormat("en-GB", { style: "currency", currency: ms.currency || "GBP" }).format((req.service_pence + req.tip_pence) / 100), link: req.url }, { related: { type: "payment_request", id: req.id }, origin: new URL(c.req.url).origin, channel: body.channel });
  if (!stmts.length) fail(409, `${body.channel} is switched off for this shop`);
  await c.env.DB.batch([...stmts, c.env.DB.prepare("UPDATE payment_requests SET sent_to=? WHERE id=?").bind(body.channel === "SMS" ? b.phone : b.email, req.id)]);
  await drain(c.env.DB, 1, Date.now(), { type: "payment_request", id: req.id }).catch(() => null);
  return c.json({ ok: true, sent_to: body.channel === "SMS" ? b.phone : b.email });
});
// Terminal: hand the amount to a reader (or "sdk" for Tap to Pay driven from the browser/app).
sandbox.post("/bookings/:id/terminal", async (c) => {
  const body = await input(c, chairAmounts);
  if (!body.reader_id) fail(400, "Choose a reader");
  const { b, shop } = await chairPrecheck(c, c.req.param("id"), body);
  if (body.reader_id !== "sdk") {
    const reader = await c.env.DB.prepare("SELECT id FROM terminal_readers WHERE shop_id=? AND id=?").bind(shop.id, body.reader_id).first();
    if (!reader) fail(404, "Reader not found");
  }
  const { request: req, client_secret } = await createTerminalRequest(c.env.DB, shop, b, body.reader_id!, body, c.get("actor"));
  await c.env.DB.batch([audit(c, "booking", b.id, "TERMINAL_REQUEST", `${body.service_pence + body.tip_pence}p sent to reader ${body.reader_id}.`)]);
  return c.json({ request: req, client_secret }, 201);
});
// Poll a request (the till does this every few seconds while the QR / reader is showing).
sandbox.get("/payment-requests/:id", async (c) => {
  const req = await c.env.DB.prepare("SELECT * FROM payment_requests WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first<PaymentRequest>();
  if (!req) return fail(404, "Request not found");
  scopeStaff(c, req.staff_id);
  const fresh = stripeLive() ? await pollRequest(c.env.DB, req, c.get("actor")) : req;
  const payments = fresh.status === "PAID" ? (await c.env.DB.prepare("SELECT * FROM payments WHERE shop_id=? AND booking_id=? ORDER BY created_at").bind(c.get("shopId"), req.booking_id).all<Payment>()).results : [];
  const booking = fresh.status === "PAID" ? await readBooking(c, req.booking_id) : null;
  return c.json({ request: fresh, booking, payments });
});
sandbox.post("/payment-requests/:id/cancel", async (c) => {
  await input(c, z.object({}).strict());
  const req = await c.env.DB.prepare("SELECT * FROM payment_requests WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first<PaymentRequest>();
  if (!req) return fail(404, "Request not found");
  scopeStaff(c, req.staff_id);
  if (req.status !== "OPEN") return c.json({ request: req });
  if (req.kind === "TERMINAL" && req.url && req.url !== "sdk") await cancelReaderAction(req.url);
  if (req.kind === "LINK" && req.stripe_session_id && stripeLive()) await expireSession(req.stripe_session_id).catch(() => null);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE payment_requests SET status='CANCELLED' WHERE id=? AND status='OPEN'").bind(req.id),
    audit(c, "booking", req.booking_id, "PAY_REQUEST_CANCELLED", `Card request ${req.id.slice(0, 8)} cancelled.`),
  ]);
  return c.json({ request: { ...req, status: "CANCELLED" } });
});
// Readers: register (pairing code shown on the device), list, refresh, remove; connection token for Tap to Pay.
sandbox.get("/terminal/readers", async (c) => c.json({ readers: await listReaders(c.env.DB, c.get("shopId")), live: stripeLive() }));
sandbox.post("/terminal/readers", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const b = await input(c, z.object({ code: z.string().trim().min(3).max(60), label: z.string().trim().min(1).max(60) }).strict());
  if (!stripeLive()) fail(409, "Card payments are not switched on for OLLO yet");
  const shop = await readShop(c);
  const r = await registerReader(c.env.DB, shop, b.code, b.label).catch((e) => fail(409, e instanceof Error ? e.message : "Stripe rejected the reader"));
  await c.env.DB.batch([audit(c, "shop", shop.id, "READER_ADDED", `${b.label} (${(r as { id: string }).id}).`)]);
  return c.json({ reader: r }, 201);
});
sandbox.post("/terminal/readers/:id/refresh", async (c) => {
  await input(c, z.object({}).strict());
  const row = await c.env.DB.prepare("SELECT id FROM terminal_readers WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first();
  if (!row) return fail(404, "Reader not found");
  const r = await refreshReader(c.env.DB, c.req.param("id")).catch(() => fail(409, "Could not reach Stripe"));
  return c.json({ reader: r });
});
sandbox.delete("/terminal/readers/:id", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  const row = await c.env.DB.prepare("SELECT id FROM terminal_readers WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first();
  if (!row) return fail(404, "Reader not found");
  await removeReader(c.env.DB, c.get("shopId"), c.req.param("id"));
  return c.json({ ok: true });
});
sandbox.post("/terminal/connection-token", async (c) => {
  await input(c, z.object({}).strict());
  if (!stripeLive()) fail(409, "Card payments are not switched on for OLLO yet");
  const shop = await readShop(c);
  const location = await ensureLocation(c.env.DB, shop).catch(() => "");
  const t = await connectionToken(location).catch(() => fail(409, "Could not get a Terminal token"));
  return c.json({ secret: (t as { secret: string }).secret, location });
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
  const seats = await syncSeats(c.env.DB, sid, c.get("actor"), { name: b.name, added: true }).catch(() => null);
  return c.json({ id: staffId, seats }, 201);
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
  const seats = await syncSeats(c.env.DB, c.get("shopId"), c.get("actor"), { name: b.name, added: !!b.active }).catch(() => null);
  return c.json({ ok: true, seats });
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
// ---- Blocked time (lunch, training, sick, personal) with a reason on the calendar --------------
// Barbers may block their own time and choose what happens to affected customers (owner decision).
// Preview lists every appointment the block lands on with each customer's contact channel; create
// applies the per-booking decision (keep / cancel / move) and queues the messages.
async function blockCollisions(c: Ctx, staffId: string, date: string, start: number, end: number, excludeBlockId?: string) {
  const rows = (
    await c.env.DB.prepare(
      "SELECT b.*, cu.contact_pref, cu.email AS customer_email FROM bookings b LEFT JOIN customers cu ON cu.id=b.customer_id WHERE b.shop_id=? AND b.staff_id=? AND b.date=? AND b.status IN ('CONFIRMED','CHECKED_IN') AND b.start_min<? AND b.start_min+b.duration_min>? ORDER BY b.start_min",
    ).bind(c.get("shopId"), staffId, date, end, start).all<StoredBooking & { contact_pref: string | null; customer_email: string | null }>()
  ).results;
  void excludeBlockId;
  const shop = await msgShop(c, c.get("shopId"));
  return rows.map((b) => {
    const pref = (b.contact_pref || "AUTO") as "AUTO" | "SMS" | "WA" | "EMAIL" | "NONE";
    const to = { name: b.attendee_name || b.customer_name, phone: b.phone, email: b.email || b.customer_email || "" };
    const channel = pref === "NONE" ? null : (channelsFor(shop, to, pref === "AUTO" ? "AUTO" : pref)[0] ?? null);
    return {
      id: b.id, customer_name: b.customer_name, attendee_name: b.attendee_name, phone: b.phone, email: to.email, service_name: b.service_name, start_min: b.start_min, duration_min: b.duration_min, price_pence: b.price_pence, version: b.version, status: b.status,
      deposit_status: b.deposit_status ?? "NONE", deposit_paid_pence: b.deposit_paid_pence ?? 0, channel, service_id: b.service_id, contact_pref: pref,
    };
  });
}
sandbox.get("/staff/:id/blocks", async (c) => {
  const staffId = c.req.param("id");
  scopeStaff(c, staffId);
  const q = z.object({ from: dateSchema.optional(), to: dateSchema.optional() }).safeParse(c.req.query());
  const from = q.success ? q.data.from : undefined, to = q.success ? q.data.to : undefined;
  const rows = await c.env.DB.prepare("SELECT * FROM staff_blocks WHERE shop_id=? AND staff_id=? AND (? IS NULL OR date>=?) AND (? IS NULL OR date<=?) ORDER BY date,start_min")
    .bind(c.get("shopId"), staffId, from ?? null, from ?? null, to ?? null, to ?? null).all<StaffBlock>();
  return c.json({ blocks: rows.results });
});
sandbox.post("/staff/:id/blocks/preview", async (c) => {
  const staffId = c.req.param("id");
  scopeStaff(c, staffId);
  const b = await input(c, z.object({ date: dateSchema, start_min: z.number().int().min(0).max(1425), end_min: z.number().int().min(15).max(1440) }).strict());
  const affected = await blockCollisions(c, staffId, b.date, b.start_min, b.end_min);
  // Suggest the next free time with any active barber for each affected visit (same service).
  const suggestions: Record<string, { staff_id: string; staff_name: string; date: string; start_min: number } | null> = {};
  const staffRows = (await c.env.DB.prepare("SELECT * FROM staff WHERE shop_id=? AND active=1 ORDER BY (id=?) DESC, name").bind(c.get("shopId"), staffId).all<Staff>()).results;
  for (const a of affected) {
    suggestions[a.id] = null;
    outer: for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const date = datePlusServer(b.date, dayOffset);
      for (const s of staffRows) {
        const data = await availabilityContext(c, s.id, a.service_id, date).catch(() => null);
        if (!data || data.rule?.enabled === 0) continue;
        const blocks = s.id === staffId ? [...data.blocks, { staff_id: staffId, date: b.date, start_min: b.start_min, end_min: b.end_min }] : data.blocks;
        for (let m = dayOffset === 0 ? a.start_min : Math.max(data.shop.opens, 0); m < 1440; m += 15) {
          if (!slotReason(data.shop, data.staff, data.hours, data.holidays, data.bookings, date, m, a.duration_min, Date.now(), a.id, data.daysOff, blocks)) {
            suggestions[a.id] = { staff_id: s.id, staff_name: s.name, date, start_min: m };
            break outer;
          }
        }
      }
    }
  }
  return c.json({ affected, suggestions });
});
sandbox.post("/staff/:id/blocks", async (c) => {
  const staffId = c.req.param("id");
  scopeStaff(c, staffId);
  const b = await input(c, blockSchema);
  const staff = await c.env.DB.prepare("SELECT * FROM staff WHERE shop_id=? AND id=?").bind(c.get("shopId"), staffId).first<Staff>();
  if (!staff) fail(404, "Barber not found");
  const shop = await msgShop(c, c.get("shopId"));
  const origin = new URL(c.req.url).origin;
  const affected = await blockCollisions(c, staffId, b.date, b.start_min, b.end_min);
  const decided = new Map(b.resolutions.map((r) => [r.booking_id, r]));
  for (const a of affected) if (!decided.has(a.id)) fail(409, `Decide what happens to ${a.customer_name}'s ${fmtTime(a.start_min)} visit first`);
  const blockId = id();
  const label = b.reason || { LUNCH: "Lunch", TRAINING: "Training", PERSONAL: "Personal", SICK: "Off sick", OTHER: "Blocked" }[b.kind];
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare("INSERT INTO staff_blocks(id,shop_id,staff_id,date,start_min,end_min,reason,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(blockId, c.get("shopId"), staffId, b.date, b.start_min, b.end_min, b.reason, b.kind, c.get("actor"), now),
    audit(c, "staff_block", blockId, "BLOCK_ADDED", `${staff!.name} ${b.date} ${fmtTime(b.start_min)}–${fmtTime(b.end_min)}: ${label}. ${affected.length} appointment${affected.length === 1 ? "" : "s"} affected.`),
  ];
  const outcome: { booking_id: string; action: string; ok: boolean; note: string; notified: string[] }[] = [];
  await c.env.DB.batch(stmts);
  for (const a of affected) {
    const r = decided.get(a.id)!;
    const booking = await readBooking(c, a.id);
    const to = { name: a.attendee_name || a.customer_name, phone: a.phone, email: a.email };
    const vars = { service: a.service_name, barber: staff!.name.split(" ")[0], date: fmtDate(b.date), time: fmtTime(a.start_min), ref: ref(booking), link: `${origin}/${shop.slug}/me`, book_link: `${origin}/book/${shop.slug}`, address: shop.address };
    const pref = a.contact_pref === "NONE" ? null : a.contact_pref === "AUTO" ? "AUTO" : a.contact_pref;
    let notified: string[] = [];
    try {
      if (r.action === "CANCEL") {
        await c.env.DB.batch([
          c.env.DB.prepare("UPDATE bookings SET status='CANCELLED', version=version+1, updated_at=? WHERE shop_id=? AND id=? AND version=?").bind(Date.now(), c.get("shopId"), a.id, booking.version),
          audit(c, "booking", a.id, "STATUS_CANCELLED", `Cancelled by the shop: ${staff!.name} unavailable (${label}).`, true),
        ]);
        if (booking.deposit_status === "PAID") await refundDeposit(c.env.DB, await readShop(c), booking, c.get("actor"), "cancelled: barber unavailable");
        if (r.notify && pref) {
          const q = enqueue(c.env.DB, shop, to, "booking_cancelled", vars, { related: { type: "booking", id: a.id }, origin, channel: pref });
          if (q.length) { await c.env.DB.batch(q); notified = channelsFor(shop, to, pref); }
        }
        outcome.push({ booking_id: a.id, action: "CANCEL", ok: true, note: booking.deposit_status === "PAID" ? "Cancelled · deposit refunded" : "Cancelled", notified });
      } else if (r.action === "MOVE" && r.move_to) {
        const data = await availabilityContext(c, r.move_to.staff_id, booking.service_id, r.move_to.date);
        const why = slotReason(data.shop, data.staff, data.hours, data.holidays, data.bookings, r.move_to.date, r.move_to.start_min, booking.duration_min, Date.now(), booking.id, data.daysOff, r.move_to.staff_id === staffId ? [...data.blocks, { staff_id: staffId, date: b.date, start_min: b.start_min, end_min: b.end_min }] : data.blocks);
        if (why) throw new Error(why);
        const start = localInstant(r.move_to.date, r.move_to.start_min, data.shop.timezone)!;
        await checkVersionUpdate(
          c,
          c.env.DB.prepare("UPDATE bookings SET staff_id=?,date=?,start_min=?,start_at=?,end_at=?,version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?").bind(r.move_to.staff_id, r.move_to.date, r.move_to.start_min, start, start + booking.duration_min * 60000, Date.now(), c.get("shopId"), a.id, booking.version),
          audit(c, "booking", a.id, "RESCHEDULED", `Moved by the shop: ${staff!.name} unavailable (${label}).`, true),
        );
        const newBarber = data.staff.name.split(" ")[0];
        if (r.notify && pref) {
          const q = enqueue(c.env.DB, shop, to, "booking_moved", { ...vars, barber: newBarber, date: fmtDate(r.move_to.date), time: fmtTime(r.move_to.start_min) }, { related: { type: "booking", id: a.id }, origin, channel: pref });
          if (q.length) { await c.env.DB.batch(q); notified = channelsFor(shop, to, pref); }
        }
        outcome.push({ booking_id: a.id, action: "MOVE", ok: true, note: `Moved to ${fmtDate(r.move_to.date)} ${fmtTime(r.move_to.start_min)} with ${newBarber}`, notified });
      } else {
        outcome.push({ booking_id: a.id, action: "KEEP", ok: true, note: "Kept — sits on top of the block", notified: [] });
      }
    } catch (err) {
      outcome.push({ booking_id: a.id, action: r.action, ok: false, note: err instanceof Error ? err.message : "Failed", notified: [] });
    }
  }
  await drain(c.env.DB, 10).catch(() => {});
  const block = await c.env.DB.prepare("SELECT * FROM staff_blocks WHERE id=?").bind(blockId).first<StaffBlock>();
  return c.json({ block, outcome }, 201);
});
sandbox.delete("/staff/:id/blocks/:blockId", async (c) => {
  scopeStaff(c, c.req.param("id"));
  const result = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM staff_blocks WHERE shop_id=? AND staff_id=? AND id=?").bind(c.get("shopId"), c.req.param("id"), c.req.param("blockId")),
    audit(c, "staff_block", c.req.param("blockId"), "BLOCK_REMOVED", "Blocked time removed.", true),
  ]);
  if (!result[0].meta.changes) fail(404, "Block not found");
  return c.json({ ok: true });
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
      "INSERT INTO services(id,shop_id,name,category,duration_min,price_pence,active,description,colour,online_bookable,popular,sort_order,payment_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
      b.payment_mode,
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
      "UPDATE services SET name=?,category=?,duration_min=?,price_pence=?,active=?,description=?,colour=?,online_bookable=?,popular=?,sort_order=?,payment_mode=?,version=version+1 WHERE shop_id=? AND id=? AND version=?",
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
      b.payment_mode,
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

// ---- Billing (OLLO ↔ shop) -------------------------------------------------------------------
// Owner-only. Plan, seats, live usage this period, estimated next invoice, invoices, timeline,
// and self-serve add-ons. Stripe Billing mirrors in once connected; local truth drives entitlements.
sandbox.get("/billing", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  return c.json(await billingSummary(c.env.DB, c.get("shopId")));
});
sandbox.post("/billing/features/:key", async (c) => {
  requireRole(c, ["OWNER"]);
  const key = c.req.param("key");
  const b = await input(c, z.object({ enabled: z.boolean() }).strict());
  const f = (await billingFeatures(c.env.DB)).find((x) => x.key === key);
  if (!f) fail(404, "Unknown feature");
  if (f!.kind !== "ADDON" || f!.monthly_pence === 0) fail(400, "This feature is part of your plan");
  const e = await entitlements(c.env.DB, c.get("shopId"));
  if (e.features[key]?.source === "ADMIN_BLOCK") fail(403, "This feature has been disabled for your account — contact OLLO support");
  if (e.features[key]?.source === "ADMIN_GRANT") fail(400, "This feature is included on your account");
  await setFeature(c.env.DB, c.get("shopId"), key, b.enabled, "ADDON", c.get("actor"));
  await c.env.DB.prepare("UPDATE shops SET version=version+1 WHERE id=?").bind(c.get("shopId")).run();
  return c.json(await billingSummary(c.env.DB, c.get("shopId")));
});
sandbox.put("/billing/contact", async (c) => {
  requireRole(c, ["OWNER"]);
  const b = await input(c, z.object({ billing_email: z.string().trim().email().or(z.literal("")), billing_name: z.string().trim().max(120), address: z.object({ line1: z.string().trim().max(120).default(""), line2: z.string().trim().max(120).default(""), city: z.string().trim().max(80).default(""), postcode: z.string().trim().max(16).default("") }).default({ line1: "", line2: "", city: "", postcode: "" }) }).strict());
  await c.env.DB.prepare("UPDATE shop_subscriptions SET billing_email=?, billing_name=?, address_json=?, version=version+1, updated_at=? WHERE shop_id=?").bind(b.billing_email, b.billing_name, JSON.stringify(b.address), Date.now(), c.get("shopId")).run();
  return c.json({ ok: true });
});
// ---- Schedule changes with conflict management --------------------------------------------------
// Preview: what would clash if this change were saved, with alternatives. Apply: save the change and
// carry out the per-appointment decisions (move / keep / cancel / waitlist / later) in one go.
sandbox.post("/schedule/preview", async (c) => {
  const change = await input(c, changeSchema);
  if ("staff_id" in change) { scopeStaff(c, change.staff_id); await requireStaff(c, change.staff_id); }
  else requireRole(c, ["OWNER", "MANAGER"]);
  const shop = await readShop(c);
  return c.json(await previewChange(c.env.DB, shop, shopToday(shop.timezone), change));
});
sandbox.post("/schedule/apply", async (c) => {
  const body = await input(c, z.object({ change: changeSchema, decisions: z.array(decisionSchema).max(200).default([]) }).strict());
  const change = body.change;
  if ("staff_id" in change) { scopeStaff(c, change.staff_id); await requireStaff(c, change.staff_id); }
  else requireRole(c, ["OWNER", "MANAGER"]);
  const sid = c.get("shopId");
  const shop = await readShop(c);
  const staffName = "staff_id" in change ? (await c.env.DB.prepare("SELECT name FROM staff WHERE shop_id=? AND id=?").bind(sid, change.staff_id).first<{ name: string }>())?.name : undefined;
  const why = describeChange(change, staffName);
  const bookingAudit = (entity: string, entityId: string, action: string, reason: string) => audit(c, entity, entityId, action, reason, true);
  // 1. Write the schedule change itself (same guards as the individual endpoints).
  let changeId = "";
  if (change.kind === "override") {
    const b = change.change;
    changeId = change.override_id ?? id();
    const write = change.override_id
      ? c.env.DB.prepare("UPDATE staff_schedule_overrides SET date=?,enabled=?,starts=?,ends=?,break_start=?,break_end=?,reason=?,version=version+1 WHERE shop_id=? AND staff_id=? AND id=? AND version=?").bind(b.date, b.enabled, b.starts, b.ends, b.break_start, b.break_end, b.reason, sid, change.staff_id, changeId, b.version ?? -1)
      : c.env.DB.prepare("INSERT INTO staff_schedule_overrides(id,shop_id,staff_id,date,enabled,starts,ends,break_start,break_end,reason) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(changeId, sid, change.staff_id, b.date, b.enabled, b.starts, b.ends, b.break_start, b.break_end, b.reason);
    await checkVersionUpdate(c, write, audit(c, "schedule_override", changeId, change.override_id ? "DATED_HOURS_UPDATED" : "DATED_HOURS_CREATED", `${b.date}: ${b.reason}. ${body.decisions.length} appointment decision(s) applied.`, true));
  } else if (change.kind === "weekly") {
    const b = change.change;
    const writes = [c.env.DB.prepare("UPDATE staff SET version=version+1 WHERE shop_id=? AND id=? AND version=?").bind(sid, change.staff_id, b.version)];
    const operation = id();
    writes.push(c.env.DB.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) SELECT ?,?,?,?,?,?,?,? WHERE changes()>0").bind(operation, sid, "staff", change.staff_id, "HOURS_UPDATED", c.get("actor"), `Weekly hours changed; ${body.decisions.length} appointment decision(s) applied.`, Date.now()));
    for (const row of b.rows) writes.push(c.env.DB.prepare("UPDATE staff_hours SET enabled=?,starts=?,ends=?,break_start=?,break_end=? WHERE shop_id=? AND staff_id=? AND weekday=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=? AND shop_id=?)").bind(row.enabled, row.starts, row.ends, row.break_start, row.break_end, sid, change.staff_id, row.weekday, operation, sid));
    const result = await c.env.DB.batch(writes);
    if (!result[0].meta.changes) fail(409, "record_changed");
    changeId = operation;
  } else if (change.kind === "day_off") {
    changeId = id();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO staff_days_off(id,shop_id,staff_id,date,reason,created_at) VALUES(?,?,?,?,?,?)").bind(changeId, sid, change.staff_id, change.change.date, change.change.reason, Date.now()),
      audit(c, "staff_day_off", changeId, "DAY_OFF_ADDED", `${staffName}: ${change.change.date} — ${change.change.reason}. ${body.decisions.length} appointment decision(s) applied.`),
    ]);
  } else if (change.kind === "holiday") {
    changeId = id();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO holidays(id,shop_id,date,label) VALUES(?,?,?,?)").bind(changeId, sid, change.change.date, change.change.label),
      audit(c, "holiday", changeId, "HOLIDAY_CREATED", `${change.change.date}: ${change.change.label}. ${body.decisions.length} appointment decision(s) applied.`),
    ]);
  } else {
    fail(400, "Use Settings to change opening hours");
  }
  // 2. Carry out the decisions.
  const origin = new URL(c.req.url).origin;
  const outcome = await applyDecisions(c, c.env.DB, shop, c.get("actor"), origin, why, change as ScheduleChange, body.decisions, bookingAudit);
  await c.env.DB.prepare("UPDATE shops SET version=version+1 WHERE id=?").bind(sid).run();
  return c.json({ id: changeId, outcome }, 201);
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
    c.env.DB.prepare("SELECT * FROM staff_blocks WHERE shop_id=? AND staff_id=? AND date=?").bind(sid, staffId, date),
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
    blocks: result[10].results as StaffBlock[],
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
              data.blocks,
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
      dueAtBooking(data.shop, data.service, quote.price_pence),
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
  b: Omit<z.infer<typeof publicBookingSchema>, "attendee_name" | "contact_pref"> & {
    source: "TEST_BOOKING" | "WALK_IN";
    attendee_name?: string;
    contact_pref?: "AUTO" | "SMS" | "WA" | "EMAIL";
  },
  channel: "OWNER" | "ONLINE",
  options: { minStart?: number; maxDate?: string; seriesId?: string | null; groupId?: string | null; depositHoldMin?: number; force?: boolean } = {},
) {
  // Preserve request hashes for pre-add-on bookings with the same normalized payload.
  // `force` is a shop-side decision, not part of what the customer asked for, so it stays out of the hash.
  // contact_pref is how we talk to the customer, not what they booked: like `force` it stays out
  // of the idempotency hash so an older client (no picker) replays cleanly.
  const { addon_ids, email, customer_id, attendee_name, force: _force, contact_pref: _pref, ...originalPayload } = b as typeof b & { customer_id?: string; attendee_name?: string; force?: boolean; contact_pref?: string };
  const contactPref = b.contact_pref && ["SMS", "WA", "EMAIL"].includes(b.contact_pref) ? b.contact_pref : "AUTO";
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
    data.blocks,
  );
  // Shop users may knowingly double-book or book outside hours (Fresha behaviour); customers cannot.
  // Past time is never overridable, whichever reason slotReason happened to report first.
  const startInstant = localInstant(b.date, b.start_min, data.shop.timezone);
  const inPast = startInstant === null || startInstant < (options.minStart ?? Date.now());
  const overridden = !!reason && channel === "OWNER" && !!options.force && overridable(reason) && !inPast;
  if (reason && !overridden) fail(409, reason === "Slot taken" ? "slot_taken" : reason);
  const start = localInstant(b.date, b.start_min, data.shop.timezone)!;
  const now = Date.now();
  const bookingId = id();
  const statement = c.env.DB.prepare(
    `INSERT INTO bookings(id,shop_id,sequence,request_id,request_hash,staff_id,service_id,customer_name,phone,notes,date,start_min,start_at,end_at,duration_min,service_name,price_pence,deposit_policy_pence,cancel_hours_snapshot,source,created_at,updated_at,quoted_service_version,quoted_shop_version,items_json,channel,email,series_id,customer_id,attendee_name,group_id,deposit_status,deposit_hold_until,payment_mode,contact_pref,buffer_min)
  SELECT ?,?,COALESCE(MAX(sequence),0)+1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM bookings WHERE shop_id=?`,
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
    dueAtBooking(data.shop, data.service, quote.price_pence),
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
    options.depositHoldMin && dueAtBooking(data.shop, data.service, quote.price_pence) > 0 ? "PENDING" : "NONE",
    options.depositHoldMin && dueAtBooking(data.shop, data.service, quote.price_pence) > 0 ? now + options.depositHoldMin * 60000 : null,
    paymentModeFor(data.shop, data.service),
    contactPref,
    shopBuffer(data.shop),
    sid,
  );
  try {
    await c.env.DB.batch([
      // Serialise per-shop inserts so the sequence number (MAX+1) cannot collide under load.
      c.env.DB.prepare("SELECT ollo_lock_shop(?)").bind(sid),
      ...(overridden ? [forceSlot(c)] : []),
      statement,
      // A customer who picks WhatsApp/text/email online is telling us how to reach them from now on.
      // Shop-side bookings (AUTO) leave whatever the customer or shop already set alone.
      ...(channel === "ONLINE" && contactPref !== "AUTO" && b.phone
        ? [c.env.DB.prepare("UPDATE customers SET contact_pref=?, updated_at=? WHERE shop_id=? AND phone=? AND merged_into IS NULL AND contact_pref<>'NONE'").bind(contactPref, now, sid, b.phone)]
        : []),
      audit(
        c,
        "booking",
        bookingId,
        "BOOKING_CREATED",
        channel === "ONLINE"
          ? options.depositHoldMin
            ? `Customer booked online. Slot held ${options.depositHoldMin} min for the deposit.`
            : "Customer booked online. Deposit payable in the shop; confirmation queued."
          : (b.source === "WALK_IN" ? "Walk-in seated." : "Appointment saved by the shop.") + (overridden ? ` Overrode: ${reason}.` : ""),
      ),
    ]);
  } catch (err) {
    // Same request_id racing itself: the loser may fail on the slot before the winner's row is
    // visible. Look for the winner, once immediately and once after a short pause.
    for (let attempt = 0; attempt < 4; attempt++) {
      const previous = await replay();
      if (previous) return { booking: previous, replayed: true };
      if (attempt < 3) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
    throw err;
  }
  return { booking: await readBooking(c, bookingId), replayed: false };
}
sandbox.post("/bookings", async (c) => {
  // Read-only accounts (trial ended, overdue, paused) can look but not book.
  const ent = await entitlements(c.env.DB, c.get("shopId")).catch(() => null);
  if (ent?.readOnly) fail(402, ent.reasons[0] || "Your OLLO account needs attention before new bookings can be made");
  const b = await input(c, bookingSchema);
  // Walk-ins are seated in the current slot: allow a start up to 15 minutes ago.
  const result = await createBooking(c, { ...b, email: "" }, "OWNER", { force: b.force, ...(b.source === "WALK_IN" ? { minStart: Date.now() - 15 * 60000 } : {}) });
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
// ---- Edit the visit: service, add-ons, price, duration -------------------------------------------
// Rewrites the items snapshot under a transaction-local flag. Same roster/overlap checks as a
// reschedule for the new end time (force works the same way). Refuses once the visit is paid or
// closed. If the new total falls below a deposit already taken, the difference is refunded to the
// card now and recovered from the barber's next pay run (owner decision).
sandbox.patch("/bookings/:id/items", async (c) => {
  const body = await input(c, bookingItemsSchema);
  const b = await readBooking(c, c.req.param("id"));
  if (b.version !== body.version) fail(409, "record_changed");
  if (!["CONFIRMED", "CHECKED_IN", "IN_SERVICE"].includes(b.status)) fail(409, "Only open appointments can be edited");
  const paid = await c.env.DB.prepare("SELECT id FROM payments WHERE shop_id=? AND booking_id=? AND voided_at IS NULL").bind(c.get("shopId"), b.id).first();
  if (paid) fail(409, "This visit has been paid; adjust it as a refund instead");
  const data = await availabilityContext(c, b.staff_id, body.service_id, b.date);
  if (!data.service.active) fail(409, "service_unavailable");
  if (data.rule?.enabled === 0) fail(409, "service_ineligible");
  const quote = calculateQuote(data.service, data.rule, data.addons, data.links, body.addon_ids);
  const items: BookingItem[] = quote.items.map((it, i) => {
    if (i === 0)
      return { ...it, price_pence: body.service_price_pence ?? it.price_pence, duration_min: body.service_duration_min ?? it.duration_min };
    return { ...it, price_pence: body.addon_prices[it.id] ?? it.price_pence };
  });
  const price = items.reduce((n, it) => n + it.price_pence, 0);
  const duration = items.reduce((n, it) => n + it.duration_min, 0);
  const edited = items.some((it, i) => it.price_pence !== quote.items[i].price_pence || it.duration_min !== quote.items[i].duration_min);
  // Roster + overlap for the new footprint (only re-checked when it grows or moves service).
  const reason = duration !== b.duration_min || body.service_id !== b.service_id
    ? slotReason(data.shop, data.staff, data.hours, data.holidays, data.bookings, b.date, b.start_min, duration, 0, b.id, data.daysOff, data.blocks)
    : "";
  const overridden = !!reason && body.force && overridable(reason);
  if (reason && !overridden) fail(409, reason === "Slot taken" ? "slot_taken" : reason);
  const now = Date.now();
  const start = localInstant(b.date, b.start_min, data.shop.timezone)!;
  const before = JSON.parse(b.items_json) as BookingItem[];
  const summary = `${b.service_name} £${(b.price_pence / 100).toFixed(2)} ${b.duration_min}min → ${items[0].name}${items.length > 1 ? ` +${items.length - 1}` : ""} £${(price / 100).toFixed(2)} ${duration}min`;
  await c.env.DB.batch([
    c.env.DB.prepare("SELECT set_config('ollo.edit_items', '1', true)"),
    ...(overridden ? [forceSlot(c)] : []),
    c.env.DB.prepare(
      "UPDATE bookings SET service_id=?,service_name=?,price_pence=?,duration_min=?,items_json=?,end_at=?,items_edited_at=?,version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?",
    ).bind(body.service_id, items[0].name, price, duration, JSON.stringify(items), start + duration * 60000, edited ? now : null, now, c.get("shopId"), b.id, body.version),
    audit(c, "booking", b.id, "ITEMS_UPDATED", `${summary}. ${body.reason}${overridden ? ` (overrode: ${reason})` : ""}`, true),
  ]);
  const fresh = await readBooking(c, b.id);
  if (fresh.version === b.version) fail(409, "record_changed");
  // Deposit reconciliation: re-priced below what the customer already paid → refund the difference now.
  let refunded_pence = 0;
  const depositPaid = b.deposit_status === "PAID" ? b.deposit_paid_pence ?? 0 : 0;
  if (depositPaid > price) {
    refunded_pence = depositPaid - price;
    try {
      // Card deposit through OLLO → partial refund on Stripe. Otherwise (preview mode / deposit taken
      // by hand) the money is owed back in the shop; the adjustment still charges the barber.
      const r = stripeLive() && b.stripe_payment_intent
        ? await refundIntent(b.stripe_payment_intent, undefined, `refund-${b.id}-${b.version}`, refunded_pence)
        : { id: "" };
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE bookings SET deposit_paid_pence=?, stripe_refund_id=?, updated_at=? WHERE shop_id=? AND id=?").bind(price, r.id, Date.now(), c.get("shopId"), b.id),
        c.env.DB.prepare("INSERT INTO booking_adjustments (id,shop_id,booking_id,staff_id,kind,pence,label,date,stripe_refund_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .bind(crypto.randomUUID(), c.get("shopId"), b.id, b.staff_id, "DEPOSIT_REFUND", -refunded_pence, `Deposit refund · ${b.customer_name} · ${b.date}`, b.date, r.id, c.get("actor"), Date.now()),
        audit(c, "booking", b.id, "DEPOSIT_REFUNDED", `£${(refunded_pence / 100).toFixed(2)} ${r.id ? "refunded to card" : "owed back to the customer (refund in the shop)"}: visit re-priced below the deposit. Recovered from ${data.staff.name}'s next pay run.`),
      ]);
    } catch (err) {
      await c.env.DB.batch([audit(c, "booking", b.id, "DEPOSIT_REFUND_FAILED", `Refund of £${(refunded_pence / 100).toFixed(2)} failed: ${err instanceof Error ? err.message : "error"}. Refund from the Stripe dashboard.`)]);
      refunded_pence = 0;
    }
  }
  return c.json({ booking: await readBooking(c, b.id), before, refunded_pence });
});
sandbox.post("/bookings/:id/status", async (c) => {
  const body = await input(c, statusSchema);
  const b = await readBooking(c, c.req.param("id"));
  const allowed: Record<string, string[]> = {
    CONFIRMED: ["CHECKED_IN", "IN_SERVICE", "COMPLETED", "CANCELLED", "NO_SHOW"],
    CHECKED_IN: ["IN_SERVICE", "COMPLETED", "CANCELLED"],
    IN_SERVICE: ["COMPLETED", "CANCELLED"],
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
  if (body.status === "NO_SHOW") {
    const count = await c.env.DB.prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE shop_id=? AND phone=? AND status='NO_SHOW'").bind(c.get("shopId"), b.phone).first<{ n: number }>();
    const st = await c.env.DB.prepare("SELECT name FROM staff WHERE shop_id=? AND id=?").bind(c.get("shopId"), b.staff_id).first<{ name: string }>();
    await alertOwners(c.env.DB, c.get("shopId"), "no_show", { ...b, status: "NO_SHOW" }, { staffName: st?.name, origin: new URL(c.req.url).origin, extra: { count: count?.n ?? 0 } }).catch(() => 0);
  }
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
  if (!["CONFIRMED", "IN_SERVICE", "COMPLETED", "CHECKED_IN"].includes(b.status)) fail(409, "This visit was cancelled or marked no-show");
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
  // Checkout is the only ceremony: no separate check-in / start-service steps.
  const advance = b.status === "CHECKED_IN" || b.status === "CONFIRMED";
  if (advance)
    statements.push(
      c.env.DB.prepare("UPDATE bookings SET status='IN_SERVICE',version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?").bind(now, c.get("shopId"), b.id, b.version),
    );
  let version = b.version + (advance ? 1 : 0);
  const ids: string[] = [];
  if (depositToPost > 0) {
    const pid = id();
    const policy = await platformPolicy(c.env.DB);
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO payments(id,shop_id,booking_id,staff_id,customer_id,date,method,service_pence,tip_pence,discount_pence,commission_pct,note,recorded_by,created_at,stripe_payment_intent,platform_fee_pence) VALUES(?,?,?,?,?,?,'ONLINE',?,0,0,?,'Deposit paid by card at booking',?,?,?,?)",
      ).bind(pid, c.get("shopId"), b.id, b.staff_id, b.customer_id, shopToday(shop.timezone, now), depositToPost, staff?.commission_pct ?? 50, "stripe", now, b.stripe_payment_intent || "", platformFee(depositToPost, policy)),
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
  // Already settled through a pay run: claw the shares back with reversals (never edit the run).
  let reversal: Awaited<ReturnType<typeof reverseForPayment>> | null = null;
  if (p.pay_run_id && stripeLive()) reversal = await reverseForPayment(c.env.DB, c.get("shopId"), p.id, p.service_pence + p.tip_pence, `void: ${body.reason}`, c.get("actor"));
  return c.json({ payment: { ...p, voided_at: Date.now(), void_reason: body.reason }, reversal });
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
  return payRunFiguresDb(c.env.DB, await readShop(c), staffId, from, to);
}
// Ctx-free so scheduled runs (sweep) use exactly the same maths as the owner's button.
export async function payRunFiguresDb(db: D1Database, shop: Shop, staffId: string, from: string, to: string) {
  const sid = shop.id;
  const [pay, hoursRows, offRows, overrideRows, staff] = await Promise.all([
    db.prepare(
      "SELECT COALESCE(SUM(service_pence),0) AS service, COALESCE(SUM(tip_pence),0) AS tips, COUNT(DISTINCT booking_id) AS visits FROM payments WHERE shop_id=? AND staff_id=? AND date BETWEEN ? AND ? AND voided_at IS NULL AND pay_run_id IS NULL",
    ).bind(sid, staffId, from, to).first<{ service: number; tips: number; visits: number }>(),
    db.prepare("SELECT * FROM staff_hours WHERE shop_id=? AND staff_id=?").bind(sid, staffId).all<Hours>(),
    db.prepare("SELECT date FROM staff_days_off WHERE shop_id=? AND staff_id=? AND date BETWEEN ? AND ?").bind(sid, staffId, from, to).all<{ date: string }>(),
    db.prepare("SELECT * FROM staff_schedule_overrides WHERE shop_id=? AND staff_id=? AND date BETWEEN ? AND ?").bind(sid, staffId, from, to).all<ScheduleOverride>(),
    db.prepare("SELECT * FROM staff WHERE shop_id=? AND id=?").bind(sid, staffId).first<Staff>(),
  ]);
  if (!staff) return fail(404, "Barber not found");
  const holidays = (await db.prepare("SELECT date FROM holidays WHERE shop_id=? AND date BETWEEN ? AND ?").bind(sid, from, to).all<{ date: string }>()).results.map((h) => h.date);
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
  // Deposit refunds caused by re-pricing a visit below the deposit: recovered from the barber here.
  const openAdj = (await db.prepare("SELECT * FROM booking_adjustments WHERE shop_id=? AND staff_id=? AND pay_run_id IS NULL AND date<=?").bind(sid, staffId, to).all<BookingAdjustment>()).results;
  return {
    staff,
    terms,
    input: { service_pence: pay?.service ?? 0, tips_pence: pay?.tips ?? 0, visits: pay?.visits ?? 0, hours_x100: Math.round((minutes / 60) * 100), periods },
    auto_adjustments: openAdj.map((a) => ({ label: a.label, pence: a.pence, adjustment_id: a.id })),
  };
}
// Merge operator adjustments with the automatic ones (deposit refunds) for a run.
function withAuto(manual: { label: string; pence: number }[], auto: { label: string; pence: number; adjustment_id: string }[]) {
  return [...auto.map(({ label, pence }) => ({ label, pence })), ...manual];
}
function claimAdjustments(db: D1Database, ids: string[], runId: string) {
  return ids.length ? [db.prepare(`UPDATE booking_adjustments SET pay_run_id=? WHERE id IN (${ids.map(() => "?").join(",")}) AND pay_run_id IS NULL`).bind(runId, ...ids)] : [];
}
// Used by the sweep: draft a run for a barber/period with the same figures + split as the owner's
// button, then approve it. Transfers are attempted by executeRun.
export async function draftAndApproveRun(db: D1Database, shop: Shop, staff: Staff, from: string, to: string): Promise<PayRun | null> {
  const { terms, input: figures, auto_adjustments } = await payRunFiguresDb(db, shop, staff.id, from, to);
  const r = calculatePayRun(terms, figures, withAuto([], auto_adjustments));
  const split = await splitFigures(db, shop.id, staff.id, from, to);
  if (!split.payment_ids.length) return null;
  const st = settlementFor(terms, r, split, { reserve_bps: shop.payrun_reserve_bps ?? 0, cashHeldBy: terms.pay_model === "CHAIR_RENT" ? "BARBER" : "SHOP" });
  const now = Date.now();
  const runId = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO pay_runs(id,shop_id,staff_id,period_from,period_to,pay_model,terms_json,service_pence,tips_pence,visits,hours_x100,commission_pence,base_pence,hourly_pence,tip_pence,rent_pence,adjustments_json,adjustments_pence,net_pence,status,note,created_by,created_at,updated_at,
           card_service_pence,card_tips_pence,cash_service_pence,cash_tips_pence,transfer_pence,shop_transfer_pence,reserve_pence,cash_residual_pence,transfer_group)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'APPROVED','Automatic pay run',?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(runId, shop.id, staff.id, from, to, terms.pay_model, JSON.stringify(terms), figures.service_pence, figures.tips_pence, figures.visits, figures.hours_x100, r.commission_pence, r.base_pence, r.hourly_pence, r.tip_pence, r.rent_pence, JSON.stringify(withAuto([], auto_adjustments)), r.adjustments_pence, r.net_pence, "system", now, now,
        split.card_service_pence, split.card_tips_pence, split.cash_service_pence, split.cash_tips_pence, st.transfer_pence, st.shop_transfer_pence, st.reserve_pence, st.cash_residual_pence, `payrun_${runId}`),
      ...claimAdjustments(db, auto_adjustments.map((a) => a.adjustment_id), runId),
      db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), shop.id, "pay_run", runId, "PAY_RUN_AUTO", "system", `${staff.name} ${from}..${to}: net ${r.net_pence}p · barber ${st.transfer_pence}p, shop ${st.shop_transfer_pence}p by Stripe · settle by hand ${st.cash_residual_pence}p`, now),
    ]);
  } catch {
    return null; // period already has a live run
  }
  return db.prepare("SELECT * FROM pay_runs WHERE id=?").bind(runId).first<PayRun>();
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
  const { terms, input, auto_adjustments } = await payRunFigures(c, q.data!.staff_id, q.data!.from, q.data!.to);
  const result = calculatePayRun(terms, input, withAuto([], auto_adjustments));
  const shop = await readShop(c);
  const split = await splitFigures(c.env.DB, c.get("shopId"), q.data!.staff_id, q.data!.from, q.data!.to);
  const settlement = settlementFor(terms, result, split, { reserve_bps: shop.payrun_reserve_bps ?? 0, cashHeldBy: terms.pay_model === "CHAIR_RENT" ? "BARBER" : "SHOP" });
  const barberAcct = await c.env.DB.prepare("SELECT payouts_enabled FROM connected_accounts WHERE shop_id=? AND owner_type='STAFF' AND owner_id=?").bind(c.get("shopId"), q.data!.staff_id).first<{ payouts_enabled: number }>();
  return c.json({ terms, input, result, split, settlement, auto_adjustments, payouts_ready: stripeLive() && !!barberAcct?.payouts_enabled });
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
  const { staff, terms, input: figures, auto_adjustments } = await payRunFigures(c, b.staff_id, b.period_from, b.period_to);
  const allAdjustments = withAuto(b.adjustments, auto_adjustments);
  const r = calculatePayRun(terms, figures, allAdjustments);
  const shopRow = await readShop(c);
  const split = await splitFigures(c.env.DB, c.get("shopId"), staff.id, b.period_from, b.period_to);
  const st = settlementFor(terms, r, split, { reserve_bps: shopRow.payrun_reserve_bps ?? 0, cashHeldBy: terms.pay_model === "CHAIR_RENT" ? "BARBER" : "SHOP" });
  const now = Date.now();
  const runId = id();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO pay_runs(id,shop_id,staff_id,period_from,period_to,pay_model,terms_json,service_pence,tips_pence,visits,hours_x100,commission_pence,base_pence,hourly_pence,tip_pence,rent_pence,adjustments_json,adjustments_pence,net_pence,status,note,created_by,created_at,updated_at,
           card_service_pence,card_tips_pence,cash_service_pence,cash_tips_pence,transfer_pence,shop_transfer_pence,reserve_pence,cash_residual_pence,transfer_group)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(runId, c.get("shopId"), staff.id, b.period_from, b.period_to, terms.pay_model, JSON.stringify(terms), figures.service_pence, figures.tips_pence, figures.visits, figures.hours_x100, r.commission_pence, r.base_pence, r.hourly_pence, r.tip_pence, r.rent_pence, JSON.stringify(allAdjustments), r.adjustments_pence, r.net_pence, b.note, c.get("actor"), now, now,
        split.card_service_pence, split.card_tips_pence, split.cash_service_pence, split.cash_tips_pence, st.transfer_pence, st.shop_transfer_pence, st.reserve_pence, st.cash_residual_pence, `payrun_${runId}`),
      ...claimAdjustments(c.env.DB, auto_adjustments.map((a) => a.adjustment_id), runId),
      audit(c, "pay_run", runId, "PAY_RUN_CREATED", `${staff.name} ${b.period_from}..${b.period_to} net ${r.net_pence}p · card ${split.card_service_pence + split.card_tips_pence}p → barber ${st.transfer_pence}p, shop ${st.shop_transfer_pence}p · settle by hand ${st.cash_residual_pence}p`),
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
  const order = ["DRAFT", "APPROVED", "TRANSFERRED", "PAID"];
  if (next !== "VOID" && order.indexOf(next) < order.indexOf(run.status)) fail(409, "Pay runs only move forward: draft → approved → paid");
  if (run.status === "PAID" && next !== "VOID") fail(409, "Paid runs are frozen; void it to redo");
  if (next === "VOID" && b.reason.length < 3) fail(400, "A reason of at least three characters is required to void");
  // A transferred run with no cash residual is fully settled by Stripe — no method needed.
  if (next === "PAID" && !(b.paid_method ?? run.paid_method) && !(run.status === "TRANSFERRED" && !run.cash_residual_pence)) fail(400, "Record how the remainder was settled (bank, cash or other)");
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
  let fresh = await c.env.DB.prepare("SELECT * FROM pay_runs WHERE shop_id=? AND id=?").bind(c.get("shopId"), run.id).first<PayRun>();
  // Approving moves the card money straight away when Stripe is live (STANDARD waits for settlement).
  let transfer: Awaited<ReturnType<typeof executeRun>> | null = null;
  if (next === "APPROVED" && fresh && stripeLive() && stripeConnect() && ((fresh.transfer_pence || 0) > 0 || (fresh.shop_transfer_pence || 0) > 0)) {
    const shop = await readShop(c);
    const staff = await c.env.DB.prepare("SELECT * FROM staff WHERE shop_id=? AND id=?").bind(shop.id, fresh.staff_id).first<Staff>();
    if (staff) transfer = await executeRun(c.env.DB, shop, fresh, staff, c.get("actor"));
    fresh = await c.env.DB.prepare("SELECT * FROM pay_runs WHERE shop_id=? AND id=?").bind(c.get("shopId"), run.id).first<PayRun>();
  }
  return c.json({ pay_run: fresh, transfer });
});
// Retry / trigger the Stripe transfers for an approved run (e.g. after settlement, or a barber
// finished onboarding). Idempotent.
sandbox.post("/pay-runs/:id/transfer", async (c) => {
  requireRole(c, ["OWNER", "MANAGER"]);
  await input(c, z.object({}).strict());
  const run = await c.env.DB.prepare("SELECT * FROM pay_runs WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first<PayRun>();
  if (!run) return fail(404, "Pay run not found");
  if (run.status !== "APPROVED") fail(409, run.status === "TRANSFERRED" ? "Already transferred" : "Approve the run first");
  const shop = await readShop(c);
  const staff = await c.env.DB.prepare("SELECT * FROM staff WHERE shop_id=? AND id=?").bind(shop.id, run.staff_id).first<Staff>();
  if (!staff) return fail(404, "Barber not found");
  const r = await executeRun(c.env.DB, shop, run, staff, c.get("actor"));
  if (!r.ok) fail(409, r.error || "Transfer failed");
  const fresh = await c.env.DB.prepare("SELECT * FROM pay_runs WHERE shop_id=? AND id=?").bind(c.get("shopId"), run.id).first<PayRun>();
  return c.json({ pay_run: fresh, transfer: r });
});
// Transfers behind a run (for the detail view).
sandbox.get("/pay-runs/:id/transfers", async (c) => {
  const run = await c.env.DB.prepare("SELECT staff_id FROM pay_runs WHERE shop_id=? AND id=?").bind(c.get("shopId"), c.req.param("id")).first<{ staff_id: string }>();
  if (!run) return fail(404, "Pay run not found");
  scopeStaff(c, run.staff_id);
  const rows = await c.env.DB.prepare("SELECT * FROM transfers WHERE shop_id=? AND pay_run_id=? ORDER BY created_at").bind(c.get("shopId"), c.req.param("id")).all();
  return c.json({ transfers: rows.results });
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
    data.blocks,
  );
  const moveInstant = localInstant(body.date, body.start_min, data.shop.timezone);
  const overridden = !!reason && body.force && overridable(reason) && moveInstant !== null && moveInstant >= Date.now();
  if (reason && !overridden) fail(409, reason === "Slot taken" ? "slot_taken" : reason);
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
    audit(c, "booking", b.id, "RESCHEDULED", overridden ? `${body.reason} (overrode: ${reason})` : body.reason, true),
    overridden ? [forceSlot(c)] : [],
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
      const reason = slotReason(data.shop, data.staff, data.hours, data.holidays, data.bookings, date, body.start_min, b.duration_min, Date.now(), b.id, data.daysOff, data.blocks);
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
