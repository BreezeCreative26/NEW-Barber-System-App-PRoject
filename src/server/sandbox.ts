import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
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
const COOKIE = "barbershop_test_session";
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
  if (c.env?.APP_MODE !== "sandbox" || !c.env.DB)
    return c.json(
      {
        error: "sandbox_disabled",
        message:
          "Functional test endpoints are disabled outside the local sandbox.",
      },
      404,
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
  const token = getCookie(c, COOKIE);
  const session =
    !accountToken && token
      ? await c.env.DB.prepare(
          "SELECT shop_id,token_hash FROM sandbox_sessions WHERE token_hash=? AND expires_at>? AND NOT EXISTS (SELECT 1 FROM shop_owners o WHERE o.shop_id=sandbox_sessions.shop_id)",
        )
          .bind(await hash(token), Date.now())
          .first<{ shop_id: string; token_hash: string }>()
      : null;
  if (account) {
    c.set("shopId", account.shop_id);
    c.set("actor", `user:${account.user_id}`);
  } else if (session) {
    c.set("shopId", session.shop_id);
    c.set("actor", `sandbox-owner:${session.token_hash.slice(0, 12)}`);
  }
  const path = c.req.path.replace(/^\/api\/sandbox/, ""),
    method = c.req.method;
  const publicAuth =
    method === "POST" &&
    ["/auth/login", "/auth/accept", "/auth/logout", "/auth/demo"].includes(path);
  const bootstrap = path === "/session" && method === "POST" && !accountToken;
  if (!account && !session && !publicAuth && !bootstrap)
    return c.json(
      {
        error: "session_required",
        message: "Sign in or create a local test workspace.",
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
      (method === "GET" && path === "/waitlist") ||
      (method === "GET" && ["/bookings/range", "/insights", "/wallet", "/pay-runs", "/shop/page"].includes(path)) ||
      (method === "GET" && path === "/pay-runs/preview") ||
      (method === "POST" && /^\/bookings\/[^/]+\/checkout$/.test(path)) ||
      (method === "POST" && /^\/payments\/[^/]+\/void$/.test(path)) ||
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
      (method === "PUT" && ["/shop", "/shop/online", "/shop/page"].includes(path)) ||
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
  if (message.includes("UNIQUE constraint"))
    return c.json(
      {
        error: "duplicate_record",
        message:
          "This record already exists or changed. Refresh and try again.",
      },
      409,
    );
  // Never log customer bodies or session credentials.
  console.error(
    "Sandbox database operation failed",
    err instanceof Error ? err.name : "UnknownError",
  );
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

sandbox.post("/session", async (c) => {
  if (c.get("shopId"))
    return c.json({ shop_id: c.get("shopId"), mode: "sandbox" });
  const body = await input(
    c,
    z.object({ name: z.string().trim().min(2).max(100) }).strict(),
  );
  const shopId = id();
  const raw = crypto.randomUUID() + crypto.randomUUID();
  const digest = await hash(raw);
  const now = Date.now();
  const staffIds = [id(), id()];
  const serviceIds = [id(), id(), id()];
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      "INSERT INTO shops(id,name,created_at) VALUES(?,?,?)",
    ).bind(shopId, body.name, now),
    c.env.DB.prepare(
      "INSERT INTO sandbox_sessions(token_hash,shop_id,expires_at,created_at) VALUES(?,?,?,?)",
    ).bind(digest, shopId, now + 7 * 86400000, now),
  ];
  for (const [i, name] of ["Jay Carter", "Marcus Reed"].entries()) {
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO staff(id,shop_id,name,role) VALUES(?,?,?,?)",
      ).bind(staffIds[i], shopId, name, i === 0 ? "Senior barber" : "Barber"),
    );
    for (let day = 0; day < 7; day++)
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO staff_hours(shop_id,staff_id,weekday,enabled,starts,ends,break_start,break_end) VALUES(?,?,?,?,540,1080,765,810)",
        ).bind(shopId, staffIds[i], day, day === 0 ? 0 : 1),
      );
  }
  for (const [i, s] of [
    { name: "Signature cut", duration: 30, price: 2800 },
    { name: "Skin fade", duration: 45, price: 3200 },
    { name: "Cut & beard", duration: 60, price: 4200 },
  ].entries())
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO services(id,shop_id,name,duration_min,price_pence) VALUES(?,?,?,?,?)",
      ).bind(serviceIds[i], shopId, s.name, s.duration, s.price),
    );
  statements.push(
    c.env.DB.prepare(
      "INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(
      id(),
      shopId,
      "shop",
      shopId,
      "WORKSPACE_CREATED",
      "sandbox-owner:" + digest.slice(0, 12),
      "Local test workspace with editable example catalogue; no bookings or payments seeded.",
      now,
    ),
  );
  await c.env.DB.batch(statements);
  setCookie(c, COOKIE, raw, {
    httpOnly: true,
    sameSite: "Strict",
    // Secure cookies also work on the browser's trusted localhost origin.
    // Wrangler's HTTP origin can sit behind an HTTPS development proxy.
    secure: true,
    path: "/",
    maxAge: 7 * 86400,
  });
  return c.json({ shop_id: shopId, mode: "sandbox" }, 201);
});

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
      `SELECT b.staff_id, s.name, COUNT(*) AS n, SUM(b.duration_min) AS minutes, SUM(CASE WHEN b.status='COMPLETED' THEN b.price_pence ELSE 0 END) AS completed_value, SUM(CASE WHEN b.status='NO_SHOW' THEN 1 ELSE 0 END) AS no_shows FROM bookings b JOIN staff s ON s.shop_id=b.shop_id AND s.id=b.staff_id WHERE b.shop_id=? AND b.date BETWEEN ? AND ? AND b.status NOT IN ('CANCELLED') AND (? IS NULL OR b.staff_id=?) GROUP BY b.staff_id ORDER BY n DESC`,
    ).bind(sid, from, today, assigned, assigned),
    c.env.DB.prepare(
      `SELECT (start_min/60) AS hour, COUNT(*) AS n FROM bookings WHERE shop_id=? AND date BETWEEN ? AND ? AND status NOT IN ('CANCELLED','NO_SHOW') AND (? IS NULL OR staff_id=?) GROUP BY hour ORDER BY hour`,
    ).bind(sid, from, today, assigned, assigned),
    c.env.DB.prepare(
      `SELECT CAST(strftime('%w',date) AS INTEGER) AS weekday, COUNT(*) AS n FROM bookings WHERE shop_id=? AND date BETWEEN ? AND ? AND status NOT IN ('CANCELLED','NO_SHOW') AND (? IS NULL OR staff_id=?) GROUP BY weekday`,
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
      "SELECT * FROM audit_events WHERE shop_id=? AND ?=1 ORDER BY created_at DESC,rowid DESC LIMIT 200",
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
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE shops SET name=?,address=?,timezone=?,opens=?,closes=?,closed_days=?,deposit_pence=?,cancel_hours=?,no_show_grace=?,till_access=?,version=version+1 WHERE id=? AND version=?",
    ).bind(
      b.name,
      b.address,
      b.timezone,
      b.opens,
      b.closes,
      JSON.stringify([...new Set(b.closed_days)]),
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
        "UPDATE shop_pages SET strapline=?,about=?,cover_url=?,gallery_json=?,phone=?,email=?,instagram=?,map_url=?,transport_note=?,policy_text=?,sections_json=?,accent=?,published=?,version=version+1,updated_at=? WHERE shop_id=? AND version=?",
      ).bind(b.strapline, b.about, b.cover_url, JSON.stringify(b.gallery), b.phone, b.email, b.instagram.replace(/^@/, ""), b.map_url, b.transport_note, b.policy_text, sections, b.accent, b.published, now, sid, b.version)
    : c.env.DB.prepare(
        "INSERT INTO shop_pages(shop_id,strapline,about,cover_url,gallery_json,phone,email,instagram,map_url,transport_note,policy_text,sections_json,accent,published,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)",
      ).bind(sid, b.strapline, b.about, b.cover_url, JSON.stringify(b.gallery), b.phone, b.email, b.instagram.replace(/^@/, ""), b.map_url, b.transport_note, b.policy_text, sections, b.accent, b.published, now);
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
  SUM(CASE WHEN b.start_at>? AND b.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE') THEN 1 ELSE 0 END) AS upcoming`;
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
  const having = {
    all: "1",
    new: "first_visit_at >= ?",
    regulars: "completed >= 4",
    lapsed: "completed >= 1 AND last_visit_at < ? AND upcoming = 0",
    no_shows: "no_shows >= 2",
    upcoming: "upcoming >= 1",
  }[filter];
  const order = {
    recent: "COALESCE(last_visit_at, c.created_at) DESC",
    spend: "completed_value_pence DESC, visits DESC",
    visits: "visits DESC, completed_value_pence DESC",
    name: "c.name COLLATE NOCASE ASC",
    next: "CASE WHEN next_visit_at IS NULL THEN 1 ELSE 0 END, next_visit_at ASC",
  }[sort];
  const binds: unknown[] = [now, now, assigned, assigned, c.get("shopId"), q, q, q, q, q];
  if (filter === "new") binds.push(now - 30 * 86400000);
  if (filter === "lapsed") binds.push(now - 60 * 86400000);
  binds.push(limit);
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.phone, c.email, c.tags, c.notes, c.preferred_staff_id, c.birthday, c.marketing_opt_in, c.version, c.created_at, ${customerStats},
      (SELECT b2.staff_id FROM bookings b2 WHERE b2.shop_id=c.shop_id AND b2.customer_id=c.id AND b2.status='COMPLETED' GROUP BY b2.staff_id ORDER BY COUNT(*) DESC, MAX(b2.start_at) DESC LIMIT 1) AS favourite_staff_id,
      (SELECT b3.service_name FROM bookings b3 WHERE b3.shop_id=c.shop_id AND b3.customer_id=c.id AND b3.status='COMPLETED' GROUP BY b3.service_name ORDER BY COUNT(*) DESC, MAX(b3.start_at) DESC LIMIT 1) AS favourite_service
     FROM customers c
     LEFT JOIN bookings b ON b.shop_id=c.shop_id AND b.customer_id=c.id AND (? IS NULL OR b.staff_id=?)
     WHERE c.shop_id=? AND c.merged_into IS NULL
     AND (?='' OR c.name LIKE '%'||?||'%' COLLATE NOCASE OR c.phone LIKE '%'||?||'%' OR c.email LIKE '%'||?||'%' COLLATE NOCASE OR c.tags LIKE '%'||?||'%' COLLATE NOCASE)
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
      "SELECT b.staff_id, s.name, COUNT(*) AS n, MAX(b.start_at) AS last_at FROM bookings b JOIN staff s ON s.shop_id=b.shop_id AND s.id=b.staff_id WHERE b.shop_id=? AND b.customer_id=? AND b.status='COMPLETED' GROUP BY b.staff_id ORDER BY n DESC, last_at DESC",
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
      "UPDATE customers SET email=CASE WHEN email='' THEN ? ELSE email END, notes=CASE WHEN ?<>'' AND notes NOT LIKE '%'||?||'%' THEN TRIM(notes||CHAR(10)||?) ELSE notes END, version=version+1, updated_at=? WHERE shop_id=? AND id=?",
    ).bind(loser.email, loser.notes, loser.notes, loser.notes, Date.now(), c.get("shopId"), winner.id),
    audit(c, "customer", winner.id, "CUSTOMER_MERGED", `Merged ${loser.name} (${loser.phone}) into this record; ${moved?.n ?? 0} visits moved.`),
    audit(c, "customer", loser.id, "CUSTOMER_MERGED_AWAY", `Merged into ${winner.name} (${winner.phone}).`),
  ]);
  return c.json({ customer: await readCustomer(c, winner.id), moved: moved?.n ?? 0 });
});
// Waitlist: open requests for full days, scoped like bookings.
sandbox.get("/waitlist", async (c) => {
  const p = z
    .object({
      status: z.enum(["OPEN", "BOOKED", "CLOSED"]).default("OPEN"),
      from: dateSchema.optional(),
    })
    .safeParse(c.req.query());
  if (!p.success) fail(400, "Invalid waitlist query");
  const a = c.get("account");
  const assigned = a?.role === "BARBER" ? a.staff_id : null;
  const rows = await c.env.DB.prepare(
    "SELECT w.*, s.name AS service_name, st.name AS staff_name FROM waitlist_entries w JOIN services s ON s.shop_id=w.shop_id AND s.id=w.service_id LEFT JOIN staff st ON st.shop_id=w.shop_id AND st.id=w.staff_id WHERE w.shop_id=? AND w.status=? AND (? IS NULL OR w.staff_id=? OR w.staff_id IS NULL) AND (? IS NULL OR w.date>=?) ORDER BY w.date, w.created_at LIMIT 200",
  )
    .bind(c.get("shopId"), p.data!.status, assigned, assigned, p.data!.from ?? null, p.data!.from ?? null)
    .all();
  return c.json({ waitlist: rows.results });
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
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE waitlist_entries SET status=?,booking_id=COALESCE(?,booking_id),version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?",
    ).bind(b.status, b.booking_id ?? null, Date.now(), c.get("shopId"), c.req.param("id"), b.version),
    audit(c, "waitlist", c.req.param("id"), `WAITLIST_${b.status}`, b.booking_id ? `Linked to booking ${b.booking_id}.` : "", true),
  );
  return c.json({ ok: true });
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
    audit(c, "booking", b.id, "MANAGE_LINK_ISSUED", "Owner generated a customer manage link; previous link revoked. No message sent."),
  ]);
  return c.json({ token: raw, path: `/manage/${raw}` }, 201);
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
        JSON.parse(shop.closed_days).includes(day) ? 0 : 1,
        shop.opens,
        shop.closes,
        shop.opens,
        shop.opens,
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
            "INSERT INTO staff_service_rules(shop_id,staff_id,service_id,enabled,price_pence,duration_min) VALUES(?,?,?,?,?,?) ON CONFLICT(shop_id,staff_id,service_id) DO UPDATE SET enabled=excluded.enabled,price_pence=excluded.price_pence,duration_min=excluded.duration_min,version=version+1",
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
  const slots = Array.from({ length: 96 }, (_, i) => i * 15)
    .filter((n) => n >= data.shop.opens && n < data.shop.closes)
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
              Date.now(),
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
  b: z.infer<typeof publicBookingSchema> & {
    source: "TEST_BOOKING" | "WALK_IN";
  },
  channel: "OWNER" | "ONLINE",
  options: { minStart?: number; maxDate?: string; seriesId?: string | null } = {},
) {
  // Preserve request hashes for pre-add-on bookings with the same normalized payload.
  const { addon_ids, email, customer_id, ...originalPayload } = b as typeof b & { customer_id?: string };
  const requestHash = await hash(
    JSON.stringify({
      ...originalPayload,
      ...(addon_ids.length ? { addon_ids } : {}),
      ...(email ? { email } : {}),
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
    `INSERT INTO bookings(id,shop_id,sequence,request_id,request_hash,staff_id,service_id,customer_name,phone,notes,date,start_min,start_at,end_at,duration_min,service_name,price_pence,deposit_policy_pence,cancel_hours_snapshot,source,created_at,updated_at,quoted_service_version,quoted_shop_version,items_json,channel,email,series_id,customer_id)
  SELECT ?,?,COALESCE(MAX(sequence),0)+1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM bookings WHERE shop_id=?`,
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
    sid,
  );
  try {
    await c.env.DB.batch([
      statement,
      audit(
        c,
        "booking",
        bookingId,
        "BOOKING_CREATED",
        channel === "ONLINE"
          ? "Customer booked online. No deposit or payment collected; no message sent."
          : "Test appointment saved. No deposit or payment collected.",
      ),
    ]);
  } catch (err) {
    const previous = await replay();
    if (previous) return { booking: previous, replayed: true };
    throw err;
  }
  return { booking: await readBooking(c, bookingId), replayed: false };
}
sandbox.post("/bookings", async (c) => {
  const b = await input(c, bookingSchema);
  const result = await createBooking(c, { ...b, email: "" }, "OWNER");
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
      body.reason || "Sandbox service status only; no payment recorded.",
      true,
    ),
  );
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
  const already = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(service_pence),0) AS paid FROM payments WHERE shop_id=? AND booking_id=? AND voided_at IS NULL",
  )
    .bind(c.get("shopId"), b.id)
    .first<{ paid: number }>();
  const due = Math.max(0, b.price_pence - body.discount_pence - (already?.paid ?? 0));
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
  if (!ids.length) fail(400, "Nothing to record");
  if (body.complete && b.status !== "COMPLETED") {
    statements.push(
      c.env.DB.prepare("UPDATE bookings SET status='COMPLETED',version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?").bind(now, c.get("shopId"), b.id, version),
    );
    statements.push(audit(c, "booking", b.id, "COMPLETED", "Checked out; payment recorded in the ledger.", true));
  }
  await c.env.DB.batch(statements);
  const booking = await readBooking(c, b.id);
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
  const closed = new Set<number>(JSON.parse(shop.closed_days));
  // Rostered minutes across the period (weekly hours + dated overrides, less leave/closures/breaks).
  let minutes = 0;
  for (let d = from; d <= to; d = datePlusServer(d, 1)) {
    if (off.has(d) || holidays.includes(d) || closed.has(weekday(d))) continue;
    const h = effectiveHours(hoursRows.results.find((x) => x.weekday === weekday(d)) ?? null, overrideRows.results.find((o) => o.date === d) ?? null);
    if (!h?.enabled) continue;
    minutes += Math.max(0, Math.min(h.ends, shop.closes) - Math.max(h.starts, shop.opens)) - Math.max(0, h.break_end - h.break_start);
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
