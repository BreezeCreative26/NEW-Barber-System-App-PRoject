import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
import { z } from "zod";
import {
  bookingSchema,
  bookingDetailsSchema,
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
  weekday,
  type Shop,
  type Staff,
  type Service,
  type Hours,
  type StoredBooking,
  type Holiday,
  type AuditEvent,
} from "./domain";

type Env = {
  Bindings: { DB: D1Database; APP_MODE?: string };
  Variables: { shopId: string; actor: string };
};
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
const fail = (
  status: 400 | 401 | 403 | 404 | 409 | 413,
  message: string,
): never => {
  throw new HTTPException(status, { message });
};
async function input<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  const text = await c.req.text();
  if (text.length > 16384) fail(413, "Request is too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "Invalid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return fail(
      400,
      parsed.error.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("; "),
    );
  return parsed.data;
}
function audit(
  c: Ctx,
  entity: string,
  entityId: string,
  action: string,
  reason = "",
  conditional = false,
): D1PreparedStatement {
  return c.env.DB.prepare(
    `INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) SELECT ?,?,?,?,?,?,?,? ${conditional ? "WHERE changes() > 0" : ""}`,
  ).bind(
    id(),
    c.get("shopId"),
    entity,
    entityId,
    action,
    c.get("actor"),
    reason,
    Date.now(),
  );
}
async function readShop(c: Ctx) {
  const shop = await c.env.DB.prepare("SELECT * FROM shops WHERE id=?")
    .bind(c.get("shopId"))
    .first<Shop>();
  if (!shop) return fail(404, "Workspace not found");
  return shop;
}
async function readBooking(c: Ctx, bookingId: string) {
  const b = await c.env.DB.prepare(
    "SELECT * FROM bookings WHERE shop_id=? AND id=?",
  )
    .bind(c.get("shopId"), bookingId)
    .first<StoredBooking>();
  if (!b) return fail(404, "Booking not found");
  return b;
}
async function checkVersionUpdate(
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
    const origin = c.req.header("origin");
    if (!origin || origin !== new URL(c.req.url).origin)
      return c.json(
        {
          error: "origin_forbidden",
          message: "Same-origin requests are required.",
        },
        403,
      );
  }
  const token = getCookie(c, COOKIE);
  const session = token
    ? await c.env.DB.prepare(
        "SELECT shop_id,token_hash FROM sandbox_sessions WHERE token_hash=? AND expires_at>?",
      )
        .bind(await hash(token), Date.now())
        .first<{ shop_id: string; token_hash: string }>()
    : null;
  if (session) {
    c.set("shopId", session.shop_id);
    c.set("actor", `sandbox-owner:${session.token_hash.slice(0, 12)}`);
  }
  if (!session && !(c.req.path.endsWith("/session") && c.req.method === "POST"))
    return c.json(
      {
        error: "session_required",
        message: "Create a local test workspace in this browser.",
      },
      401,
    );
  await next();
});
sandbox.onError((err, c) => {
  if (err instanceof HTTPException)
    return c.json({ error: err.message, message: err.message }, err.status);
  const message = String(err);
  const known = [
    "quote_changed",
    "slot_taken",
    "barber_unavailable",
    "service_changed",
    "shop_closed",
    "outside_hours",
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
});

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

sandbox.get("/workspace", async (c) => {
  const sid = c.get("shopId");
  const shop = await readShop(c);
  const result = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM staff WHERE shop_id=? ORDER BY name").bind(
      sid,
    ),
    c.env.DB.prepare(
      "SELECT * FROM services WHERE shop_id=? ORDER BY name",
    ).bind(sid),
    c.env.DB.prepare(
      "SELECT * FROM staff_hours WHERE shop_id=? ORDER BY staff_id,weekday",
    ).bind(sid),
    c.env.DB.prepare(
      "SELECT * FROM holidays WHERE shop_id=? ORDER BY date",
    ).bind(sid),
    c.env.DB.prepare(
      "SELECT * FROM bookings WHERE shop_id=? ORDER BY start_at DESC LIMIT 500",
    ).bind(sid),
    c.env.DB.prepare(
      "SELECT * FROM audit_events WHERE shop_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200",
    ).bind(sid),
  ]);
  const staff = result[0].results as Staff[];
  const services = result[1].results as Service[];
  const hours = result[2].results as Hours[];
  const holidays = result[3].results as Holiday[];
  const bookings = result[4].results as StoredBooking[];
  const issues = bookings
    .filter(
      (b) =>
        b.start_at > Date.now() &&
        !["CANCELLED", "NO_SHOW", "COMPLETED"].includes(b.status),
    )
    .flatMap((b) => {
      const reason = slotReason(
        shop,
        staff.find((s) => s.id === b.staff_id) ?? null,
        hours.find(
          (h) => h.staff_id === b.staff_id && h.weekday === weekday(b.date),
        ) ?? null,
        holidays,
        [],
        b.date,
        b.start_min,
        b.duration_min,
      );
      return reason ? [{ booking_id: b.id, ref: ref(b), reason }] : [];
    });
  return c.json({
    shop,
    staff,
    services,
    hours,
    holidays,
    bookings,
    audit: result[5].results as AuditEvent[],
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
      "UPDATE shops SET name=?,address=?,timezone=?,opens=?,closes=?,closed_days=?,deposit_pence=?,cancel_hours=?,no_show_grace=?,version=version+1 WHERE id=? AND version=?",
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

sandbox.post("/staff", async (c) => {
  const b = await input(c, staffSchema);
  const sid = c.get("shopId");
  const staffId = id();
  const shop = await readShop(c);
  const writes = [
    c.env.DB.prepare(
      "INSERT INTO staff(id,shop_id,name,role,active) VALUES(?,?,?,?,?)",
    ).bind(staffId, sid, b.name, b.role, b.active),
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
      "UPDATE staff SET name=?,role=?,active=?,version=version+1 WHERE shop_id=? AND id=? AND version=?",
    ).bind(
      b.name,
      b.role,
      b.active,
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
sandbox.post("/services", async (c) => {
  const b = await input(c, serviceSchema);
  const serviceId = id();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO services(id,shop_id,name,category,duration_min,price_pence,active) VALUES(?,?,?,?,?,?,?)",
    ).bind(
      serviceId,
      c.get("shopId"),
      b.name,
      b.category,
      b.duration_min,
      b.price_pence,
      b.active,
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
      "UPDATE services SET name=?,category=?,duration_min=?,price_pence=?,active=?,version=version+1 WHERE shop_id=? AND id=? AND version=?",
    ).bind(
      b.name,
      b.category,
      b.duration_min,
      b.price_pence,
      b.active,
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

async function availabilityContext(
  c: Ctx,
  staffId: string,
  serviceId: string,
  date: string,
) {
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
  ]);
  const staff = result[0].results[0] as Staff | undefined;
  const service = result[1].results[0] as Service | undefined;
  if (!staff || !service)
    fail(404, "Staff or service not found in this workspace");
  return {
    shop,
    staff: staff!,
    service: service!,
    hours: (result[2].results[0] as Hours) ?? null,
    holidays: result[3].results as Holiday[],
    bookings: result[4].results as StoredBooking[],
  };
}
sandbox.get("/availability", async (c) => {
  const parsed = z
    .object({
      date: dateSchema,
      staff_id: z.string().uuid(),
      service_id: z.string().uuid(),
      booking_id: z.string().uuid().optional(),
    })
    .safeParse(c.req.query());
  if (!parsed.success)
    fail(400, "Supply a valid date, staff_id and service_id");
  const p = parsed.data!;
  const data = await availabilityContext(c, p.staff_id, p.service_id, p.date);
  const booking = p.booking_id ? await readBooking(c, p.booking_id) : null;
  if (booking && booking.service_id !== p.service_id)
    fail(400, "Rescheduling must use the original service");
  const duration = booking?.duration_min ?? data.service.duration_min;
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
            ),
    }));
  return c.json({
    slots,
    duration_min: duration,
    price_pence: booking?.price_pence ?? data.service.price_pence,
    service_name: booking?.service_name ?? data.service.name,
    deposit_policy_pence:
      booking?.deposit_policy_pence ??
      Math.min(data.shop.deposit_pence, data.service.price_pence),
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
sandbox.post("/bookings", async (c) => {
  const b = await input(c, bookingSchema);
  const requestHash = await hash(JSON.stringify(b));
  const sid = c.get("shopId");
  const replay = async () => {
    const existing = await c.env.DB.prepare(
      "SELECT * FROM bookings WHERE shop_id=? AND request_id=?",
    )
      .bind(sid, b.request_id)
      .first<StoredBooking>();
    if (existing && existing.request_hash !== requestHash)
      fail(409, "idempotency_payload_changed");
    return existing;
  };
  const existing = await replay();
  if (existing) return c.json({ booking: existing, replayed: true });
  const data = await availabilityContext(c, b.staff_id, b.service_id, b.date);
  if (!data.service.active) fail(409, "service_unavailable");
  if (
    b.quote.service_version !== data.service.version ||
    b.quote.shop_version !== data.shop.version
  )
    fail(409, "quote_changed");
  const reason = slotReason(
    data.shop,
    data.staff,
    data.hours,
    data.holidays,
    data.bookings,
    b.date,
    b.start_min,
    data.service.duration_min,
  );
  if (reason) fail(409, reason === "Slot taken" ? "slot_taken" : reason);
  const start = localInstant(b.date, b.start_min, data.shop.timezone)!;
  const now = Date.now();
  const bookingId = id();
  const statement = c.env.DB.prepare(
    `INSERT INTO bookings(id,shop_id,sequence,request_id,request_hash,staff_id,service_id,customer_name,phone,notes,date,start_min,start_at,end_at,duration_min,service_name,price_pence,deposit_policy_pence,cancel_hours_snapshot,source,created_at,updated_at,quoted_service_version,quoted_shop_version)
  SELECT ?,?,COALESCE(MAX(sequence),0)+1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM bookings WHERE shop_id=?`,
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
    start + data.service.duration_min * 60000,
    data.service.duration_min,
    data.service.name,
    data.service.price_pence,
    Math.min(data.shop.deposit_pence, data.service.price_pence),
    data.shop.cancel_hours,
    b.source,
    now,
    now,
    b.quote.service_version,
    b.quote.shop_version,
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
        "Test appointment saved. No deposit or payment collected.",
      ),
    ]);
  } catch (err) {
    const previous = await replay();
    if (previous) return c.json({ booking: previous, replayed: true });
    throw err;
  }
  return c.json(
    { booking: await readBooking(c, bookingId), replayed: false },
    201,
  );
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
export default sandbox;
