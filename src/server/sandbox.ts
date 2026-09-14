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
    c.env.DB.prepare(
      "SELECT * FROM staff_days_off WHERE shop_id=? ORDER BY date,staff_id",
    ).bind(sid),
    c.env.DB.prepare("SELECT * FROM addons WHERE shop_id=? ORDER BY name").bind(
      sid,
    ),
    c.env.DB.prepare("SELECT * FROM addon_services WHERE shop_id=?").bind(sid),
    c.env.DB.prepare("SELECT * FROM staff_service_rules WHERE shop_id=?").bind(
      sid,
    ),
    c.env.DB.prepare(
      "SELECT * FROM staff_schedule_overrides WHERE shop_id=? ORDER BY date",
    ).bind(sid),
  ]);
  const staff = result[0].results as Staff[];
  const services = result[1].results as Service[];
  const hours = result[2].results as Hours[];
  const holidays = result[3].results as Holiday[];
  const bookings = result[4].results as StoredBooking[];
  const daysOff = result[6].results as StaffDayOff[];
  const rules = result[9].results as StaffServiceRule[];
  const overrides = result[10].results as ScheduleOverride[];
  const issues = bookings
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
  return c.json({
    shop,
    staff,
    services,
    hours,
    holidays,
    bookings,
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
sandbox.post("/bookings", async (c) => {
  const b = await input(c, bookingSchema);
  // Preserve request hashes for pre-add-on bookings with the same normalized payload.
  const { addon_ids, ...originalPayload } = b;
  const requestHash = await hash(
    JSON.stringify(
      addon_ids.length ? { ...originalPayload, addon_ids } : originalPayload,
    ),
  );
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
  const quote = calculateQuote(
    data.service,
    data.rule,
    data.addons,
    data.links,
    b.addon_ids,
  );
  const reason = slotReason(
    data.shop,
    data.staff,
    data.hours,
    data.holidays,
    data.bookings,
    b.date,
    b.start_min,
    quote.duration_min,
    Date.now(),
    undefined,
    data.daysOff,
  );
  if (reason) fail(409, reason === "Slot taken" ? "slot_taken" : reason);
  const start = localInstant(b.date, b.start_min, data.shop.timezone)!;
  const now = Date.now();
  const bookingId = id();
  const statement = c.env.DB.prepare(
    `INSERT INTO bookings(id,shop_id,sequence,request_id,request_hash,staff_id,service_id,customer_name,phone,notes,date,start_min,start_at,end_at,duration_min,service_name,price_pence,deposit_policy_pence,cancel_hours_snapshot,source,created_at,updated_at,quoted_service_version,quoted_shop_version,items_json)
  SELECT ?,?,COALESCE(MAX(sequence),0)+1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM bookings WHERE shop_id=?`,
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
export default sandbox;
