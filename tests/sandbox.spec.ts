import {
  test,
  expect,
  request,
  type APIRequestContext,
} from "@playwright/test";
import type { WorkspaceData, StoredBooking } from "../src/server/domain";
test("reviewed quote must match current service and shop versions; details are versioned and tenant scoped", async () => {
  const r = await owner();
  const other = await owner();
  const w = await workspace(r);
  const p = payload(w);
  const s = w.services.find((s) => s.id === p.service_id)!;
  expect(
    (
      await r.put(base + "/services/" + s.id, {
        data: {
          name: s.name,
          category: s.category,
          duration_min: s.duration_min,
          price_pence: 3500,
          active: 1,
          version: s.version,
        },
      })
    ).status(),
  ).toBe(200);
  const rejected = await r.post(base + "/bookings", { data: p });
  expect(rejected.status()).toBe(409);
  expect((await rejected.json()).error).toBe("quote_changed");
  expect((await workspace(r)).bookings).toHaveLength(0);
  const current = await workspace(r);
  const b = await create(r, current);
  const update = {
    customer_name: "Corrected Fictional Client",
    phone: "+44 7700 900123",
    notes: "New test preference",
    reason: "Corrected test details",
    version: 0,
  };
  expect(
    (
      await other.patch(base + `/bookings/${b.id}/details`, { data: update })
    ).status(),
  ).toBe(404);
  expect(
    (
      await r.patch(base + `/bookings/${b.id}/details`, {
        data: { ...update, price_pence: 1 },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await r.patch(base + `/bookings/${b.id}/details`, { data: update })
    ).status(),
  ).toBe(200);
  expect(
    (
      await r.patch(base + `/bookings/${b.id}/details`, { data: update })
    ).status(),
  ).toBe(409);
  const after = await workspace(r);
  const edited = after.bookings[0];
  expect(edited.customer_name).toBe(update.customer_name);
  expect(edited.phone).toBe("+447700900123");
  expect(edited.price_pence).toBe(3500);
  expect(edited.id).toBe(b.id);
  expect(edited.status).toBe("CONFIRMED");
  expect(
    after.audit.filter((a) => a.action === "DETAILS_UPDATED"),
  ).toHaveLength(1);
  const shop = after.shop;
  expect(
    (
      await r.put(base + "/shop", {
        data: {
          name: shop.name,
          address: shop.address,
          timezone: shop.timezone,
          opens: shop.opens,
          closes: shop.closes,
          closed_days: JSON.parse(shop.closed_days),
          deposit_pence: 800,
          cancel_hours: shop.cancel_hours,
          no_show_grace: shop.no_show_grace,
          version: shop.version,
        },
      })
    ).status(),
  ).toBe(200);
  expect(
    (await r.post(base + "/bookings", { data: payload(after, 900) })).status(),
  ).toBe(409);
  await Promise.all([r.dispose(), other.dispose()]);
});
import { readFileSync } from "node:fs";

// Keep an executable inventory of ALL write routes, including PATCH and DELETE.
// A new write route without a security test fails this source-derived coverage gate.
const mutationContracts = [
  ["POST", "/session"],
  ["PUT", "/shop"],
  ["POST", "/staff"],
  ["PUT", "/staff/:id"],
  ["PUT", "/staff/:id/hours"],
  ["POST", "/services"],
  ["PUT", "/services/:id"],
  ["POST", "/holidays"],
  ["DELETE", "/holidays/:id"],
  ["POST", "/bookings"],
  ["PATCH", "/bookings/:id/details"],
  ["POST", "/bookings/:id/status"],
  ["POST", "/bookings/:id/reschedule"],
] as const;
test("all registered mutation endpoints enforce origin and session boundaries", async () => {
  const source = readFileSync(
    new URL("../src/server/sandbox.ts", import.meta.url),
    "utf8",
  );
  const actual = Array.from(
    source.matchAll(/sandbox\.(post|put|patch|delete)\(\s*["']([^"']+)["']/g),
    (m) => `${m[1].toUpperCase()} ${m[2]}`,
  ).sort();
  expect(actual).toEqual(
    mutationContracts.map(([method, path]) => `${method} ${path}`).sort(),
  );
  const a = await owner("Mutation coverage shop");
  const anon = await request.newContext({
    extraHTTPHeaders: { Origin: origin },
  });
  const w = await workspace(a);
  const before = w.audit.length;
  for (const [method, pattern] of mutationContracts) {
    const path = pattern.replace(":id", crypto.randomUUID());
    const foreign = await a.fetch(base + path, {
      method,
      headers: { Origin: "https://invalid.example" },
      ...(method !== "DELETE" ? { data: {} } : {}),
    });
    expect(foreign.status(), `${method} ${pattern} origin`).toBe(403);
    if (pattern !== "/session") {
      const unauth = await anon.fetch(base + path, {
        method,
        ...(method !== "DELETE" ? { data: {} } : {}),
      });
      expect(unauth.status(), `${method} ${pattern} session`).toBe(401);
      const invalid = await a.fetch(base + path, {
        method,
        ...(method !== "DELETE"
          ? { data: { shop_id: "client-must-not-supply-tenant" } }
          : {}),
      });
      expect(invalid.status(), `${method} ${pattern} validation`).toBe(
        method === "DELETE" ? 404 : 400,
      );
    }
  }
  expect((await workspace(a)).audit.length).toBe(before);
  await Promise.all([a.dispose(), anon.dispose()]);
});

const origin = "http://localhost:3000";
const base = origin + "/api/sandbox";
async function owner(name = "API test shop") {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  expect((await r.post(base + "/session", { data: { name } })).status()).toBe(
    201,
  );
  return r;
}
async function workspace(r: APIRequestContext): Promise<WorkspaceData> {
  const response = await r.get(base + "/workspace");
  expect(response.status()).toBe(200);
  return response.json();
}
function future() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 3);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function payload(w: WorkspaceData, start = 540) {
  return {
    request_id: crypto.randomUUID(),
    staff_id: w.staff[0].id,
    service_id: w.services.find((s) => s.duration_min === 30)!.id,
    customer_name: "Fictional Client",
    phone: "07700900123",
    notes: "Test only",
    date: future(),
    start_min: start,
    source: "TEST_BOOKING",
    quote: {
      service_version: w.services.find((s) => s.duration_min === 30)!.version,
      shop_version: w.shop.version,
    },
  };
}
async function create(
  r: APIRequestContext,
  w: WorkspaceData,
  start = 540,
): Promise<StoredBooking> {
  const res = await r.post(base + "/bookings", { data: payload(w, start) });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).booking;
}

test("session cookie, same-origin checks and isolation across entity endpoints", async () => {
  const a = await owner();
  const b = await owner();
  const wa = await workspace(a);
  const wb = await workspace(b);
  expect(wa.shop.id).not.toBe(wb.shop.id);
  const cookie = (await a.storageState()).cookies[0];
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe("Strict");
  const anonymous = await request.newContext();
  expect((await anonymous.get(base + "/workspace")).status()).toBe(401);
  expect(
    (
      await anonymous.post(base + "/session", { data: { name: "Rejected" } })
    ).status(),
  ).toBe(403);
  expect(
    (
      await a.post(base + "/services", {
        headers: { Origin: "https://other.example" },
        data: { name: "Forged" },
      })
    ).status(),
  ).toBe(403);
  const appointment = await create(a, wa);
  expect((await b.get(base + "/bookings/" + appointment.id)).status()).toBe(
    404,
  );
  expect(
    (
      await b.post(base + `/bookings/${appointment.id}/status`, {
        data: { status: "CHECKED_IN", version: 0 },
      })
    ).status(),
  ).toBe(404);
  expect(
    (
      await b.post(base + `/bookings/${appointment.id}/reschedule`, {
        data: {
          staff_id: wb.staff[0].id,
          date: future(),
          start_min: 900,
          version: 0,
          reason: "Cross tenant",
        },
      })
    ).status(),
  ).toBe(404);
  for (const [route, body] of [
    [
      `staff/${wa.staff[0].id}`,
      { name: "Forged Name", role: "Barber", active: 1, version: 0 },
    ],
    [
      `services/${wa.services[0].id}`,
      {
        name: "Forged Service",
        category: "Hair",
        duration_min: 30,
        price_pence: 1,
        active: 1,
        version: 0,
      },
    ],
  ] as const)
    expect((await b.put(base + "/" + route, { data: body })).status()).toBe(
      409,
    );
  const rows = wa.hours
    .filter((h) => h.staff_id === wa.staff[0].id)
    .map(({ weekday, enabled, starts, ends, break_start, break_end }) => ({
      weekday,
      enabled,
      starts,
      ends,
      break_start,
      break_end,
    }));
  expect(
    (
      await b.put(base + `/staff/${wa.staff[0].id}/hours`, {
        data: { version: 0, rows },
      })
    ).status(),
  ).toBe(409);
  const closure = await a.post(base + "/holidays", {
    data: { date: "2030-12-25", label: "Test closure" },
  });
  const closureId = (await closure.json()).id;
  expect((await b.delete(base + "/holidays/" + closureId)).status()).toBe(404);
  expect(
    (
      await b.get(
        base +
          `/availability?date=${future()}&staff_id=${wa.staff[0].id}&service_id=${wb.services[0].id}`,
      )
    ).status(),
  ).toBe(404);
  expect(
    (
      await b.post(base + "/bookings", {
        data: { ...payload(wb), staff_id: wa.staff[0].id },
      })
    ).status(),
  ).toBe(404);
  expect(
    (
      await a.post(base + "/bookings", {
        data: { ...payload(wa, 900), shop_id: wb.shop.id, price_pence: 1 },
      })
    ).status(),
  ).toBe(400);
  const after = await workspace(b);
  expect(after.bookings).toHaveLength(0);
  expect(after.audit).toHaveLength(1);
  expect((await workspace(a)).staff[0].name).toBe(wa.staff[0].name);
  await Promise.all([a.dispose(), b.dispose(), anonymous.dispose()]);
});

test("simultaneous overlapping booking requests admit one winner and preserve idempotency", async () => {
  const r = await owner();
  const w = await workspace(r);
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      r.post(base + "/bookings", { data: payload(w) }),
    ),
  );
  expect(results.filter((x) => x.status() === 201)).toHaveLength(1);
  expect(results.filter((x) => x.status() === 409)).toHaveLength(7);
  expect((await workspace(r)).bookings).toHaveLength(1);
  const p = payload(w, 900);
  const concurrent = await Promise.all([
    r.post(base + "/bookings", { data: p }),
    r.post(base + "/bookings", { data: p }),
  ]);
  expect(concurrent.map((x) => x.status()).sort()).toEqual([200, 201]);
  const x = await concurrent[0].json(),
    y = await concurrent[1].json();
  expect(x.booking.id).toBe(y.booking.id);
  const replay = await r.post(base + "/bookings", { data: p });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).replayed).toBe(true);
  expect(
    (
      await r.post(base + "/bookings", {
        data: { ...p, customer_name: "Changed payload" },
      })
    ).status(),
  ).toBe(409);
  expect(
    (await r.post(base + "/bookings", { data: payload(w, 570) })).status(),
  ).toBe(409);
  expect(
    (await r.post(base + "/bookings", { data: payload(w, 585) })).status(),
  ).toBe(201);
  const after = await workspace(r);
  expect(after.bookings).toHaveLength(3);
  expect(
    after.audit.filter((a) => a.action === "BOOKING_CREATED"),
  ).toHaveLength(3);
  expect(new Set(after.bookings.map((b) => b.sequence)).size).toBe(3);
  await r.dispose();
});

test("versioned updates do not create false audit; catalogue snapshots survive; atomic move rollback", async () => {
  const r = await owner();
  const w = await workspace(r);
  const b = await create(r, w);
  await create(r, w, 900);
  const service = w.services.find((s) => s.id === b.service_id)!;
  const edited = {
    name: "Renamed service",
    category: service.category,
    duration_min: 45,
    price_pence: 4500,
    active: 1,
    version: service.version,
  };
  expect(
    (await r.put(base + "/services/" + service.id, { data: edited })).status(),
  ).toBe(200);
  const before = (await workspace(r)).audit.length;
  expect(
    (await r.put(base + "/services/" + service.id, { data: edited })).status(),
  ).toBe(409);
  expect((await workspace(r)).audit.length).toBe(before);
  let current = (await (await r.get(base + "/bookings/" + b.id)).json())
    .booking;
  expect(current.price_pence).toBe(2800);
  expect(current.service_name).toBe(service.name);
  expect(current.duration_min).toBe(30);
  expect(
    (
      await r.post(base + `/bookings/${b.id}/reschedule`, {
        data: {
          date: b.date,
          staff_id: b.staff_id,
          start_min: 900,
          reason: "Move collision",
          version: 0,
        },
      })
    ).status(),
  ).toBe(409);
  current = (await (await r.get(base + "/bookings/" + b.id)).json()).booking;
  expect(current.start_min).toBe(540);
  expect(current.version).toBe(0);
  const moved = await r.post(base + `/bookings/${b.id}/reschedule`, {
    data: {
      date: b.date,
      staff_id: b.staff_id,
      start_min: 630,
      reason: "Client test request",
      version: 0,
    },
  });
  expect(moved.status()).toBe(200);
  current = (await moved.json()).booking;
  expect(current.id).toBe(b.id);
  expect(current.price_pence).toBe(2800);
  expect(current.duration_min).toBe(30);
  expect(current.version).toBe(1);
  await r.dispose();
});

test("status lifecycle, no-show grace, cancellation release and independent payment state", async () => {
  const r = await owner();
  const w = await workspace(r);
  const b = await create(r, w);
  const path = base + `/bookings/${b.id}/status`;
  expect(
    (
      await r.post(path, {
        data: { status: "NO_SHOW", reason: "Not arrived", version: 0 },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await r.post(path, { data: { status: "CANCELLED", version: 0 } })
    ).status(),
  ).toBe(400);
  expect(
    (
      await r.post(path, { data: { status: "COMPLETED", version: 0 } })
    ).status(),
  ).toBe(409);
  for (const [version, status] of [
    "CHECKED_IN",
    "IN_SERVICE",
    "COMPLETED",
  ].entries())
    expect((await r.post(path, { data: { status, version } })).status()).toBe(
      200,
    );
  expect(
    (
      await r.post(path, {
        data: { status: "CANCELLED", reason: "Test cancel", version: 3 },
      })
    ).status(),
  ).toBe(409);
  const c = await create(r, w, 900);
  expect(
    (
      await r.post(base + `/bookings/${c.id}/status`, {
        data: { status: "CANCELLED", reason: "Test cancellation", version: 0 },
      })
    ).status(),
  ).toBe(200);
  expect(
    (await r.post(base + "/bookings", { data: payload(w, 900) })).status(),
  ).toBe(201);
  const after = await workspace(r);
  expect(after.bookings.find((x) => x.id === b.id)?.status).toBe("COMPLETED");
  expect(
    after.audit.filter((a) => a.entity_id === b.id).map((a) => a.action),
  ).toContain("COMPLETED");
  expect((await r.get(origin + "/api/health")).ok()).toBe(true);
  await r.dispose();
});

test("weekly hours, holidays, shop settings and deactivation flag affected bookings", async () => {
  const r = await owner();
  const w = await workspace(r);
  const b = await create(r, w);
  const s = w.staff[0];
  const rows = w.hours
    .filter((h) => h.staff_id === s.id)
    .map(({ weekday, enabled, starts, ends, break_start, break_end }) => ({
      weekday,
      enabled,
      starts,
      ends,
      break_start,
      break_end,
    }));
  rows.forEach((h) => (h.enabled = 0));
  expect(
    (
      await r.put(base + `/staff/${s.id}/hours`, { data: { version: 0, rows } })
    ).status(),
  ).toBe(200);
  let after = await workspace(r);
  expect(after.issues.find((i) => i.booking_id === b.id)?.reason).toBe(
    "Barber off duty",
  );
  expect(
    after.hours
      .filter((h) => h.staff_id === s.id)
      .every((h) => h.enabled === 0),
  ).toBe(true);
  rows.forEach((h) => (h.enabled = h.weekday === 0 ? 0 : 1));
  expect(
    (
      await r.put(base + `/staff/${s.id}/hours`, { data: { version: 0, rows } })
    ).status(),
  ).toBe(409);
  expect(
    (await workspace(r)).hours
      .filter((h) => h.staff_id === s.id)
      .every((h) => h.enabled === 0),
  ).toBe(true);
  expect(
    (
      await r.put(base + `/staff/${s.id}/hours`, { data: { version: 1, rows } })
    ).status(),
  ).toBe(200);
  const holiday = await r.post(base + "/holidays", {
    data: { date: b.date, label: "Staff training test" },
  });
  expect(holiday.status()).toBe(201);
  const hid = (await holiday.json()).id;
  expect((await workspace(r)).issues[0].reason).toBe("Shop closed");
  expect(
    (await r.post(base + "/bookings", { data: payload(w, 900) })).status(),
  ).toBe(409);
  expect((await r.delete(base + "/holidays/" + hid)).status()).toBe(200);
  expect(
    (
      await r.put(base + `/staff/${s.id}`, {
        data: { name: s.name, role: s.role, active: 0, version: 2 },
      })
    ).status(),
  ).toBe(200);
  after = await workspace(r);
  expect(after.issues[0].reason).toBe("Barber unavailable");
  expect(after.bookings).toHaveLength(1);
  const { id, ...rest } = w.shop;
  const settings = {
    name: "Updated test shop",
    address: "Test address",
    timezone: "Europe/London",
    opens: 540,
    closes: 1020,
    closed_days: [0],
    deposit_pence: 700,
    cancel_hours: 48,
    no_show_grace: 20,
    version: 0,
  };
  expect((await r.put(base + "/shop", { data: settings })).status()).toBe(200);
  expect((await workspace(r)).shop.name).toBe(settings.name);
  await r.dispose();
});
