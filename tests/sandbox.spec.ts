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
        data: shopPayload(shop, { deposit_pence: 800 }),
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
  ["PUT", "/shop"],
  ["PUT", "/shop/online"],
  ["PUT", "/shop/messaging"],
  ["PUT", "/shop/payments"],
  ["POST", "/shop/payments/connect"],
  ["POST", "/bookings/:id/deposit/refund"],
  ["POST", "/staff/:id/payments/connect"],
  ["POST", "/payments/accounts/:id/refresh"],
  ["POST", "/payments/accounts/:id/dashboard"],
  ["PUT", "/payments/accounts/:id/schedule"],
  ["POST", "/pay-runs/:id/transfer"],
  ["POST", "/bookings/:id/pay-link"],
  ["POST", "/bookings/:id/terminal"],
  ["POST", "/payment-requests/:id/send"],
  ["POST", "/payment-requests/:id/cancel"],
  ["POST", "/terminal/readers"],
  ["POST", "/terminal/readers/:id/refresh"],
  ["DELETE", "/terminal/readers/:id"],
  ["POST", "/terminal/connection-token"],
  ["POST", "/notifications/test"],
  ["POST", "/notifications/sweep"],
  ["POST", "/notifications/:id/resend"],
  ["PUT", "/shop/page"],
  ["POST", "/staff"],
  ["PUT", "/staff/:id"],
  ["PUT", "/staff/:id/hours"],
  ["POST", "/staff/:id/days-off"],
  ["DELETE", "/staff/:id/days-off/:leaveId"],
  ["POST", "/services"],
  ["POST", "/services/categories/rename"],
  ["PUT", "/services/:id"],
  ["POST", "/addons"],
  ["PUT", "/addons/:id"],
  ["PUT", "/staff/:id/services/:serviceId"],
  ["POST", "/staff/:id/overrides"],
  ["PUT", "/staff/:id/overrides/:overrideId"],
  ["DELETE", "/staff/:id/overrides/:overrideId"],
  ["POST", "/holidays"],
  ["DELETE", "/holidays/:id"],
  ["POST", "/bookings"],
  ["PATCH", "/bookings/:id/details"],
  ["POST", "/bookings/:id/status"],
  ["POST", "/bookings/:id/reschedule"],
  ["POST", "/bookings/:id/manage-link"],
  ["POST", "/waitlist/:id/status"],
  ["POST", "/waitlist/:id/offer"],
  ["PUT", "/shop/waitlist"],
  ["POST", "/reviews/:id/status"],
  ["POST", "/reviews/:id/reply"],
  ["POST", "/media"],
  ["DELETE", "/media/:id"],
  ["POST", "/series/preview"],
  ["POST", "/series"],
  ["POST", "/customers"],
  ["PUT", "/customers/:id"],
  ["POST", "/customers/:id/merge"],
  ["POST", "/customers/import/preview"],
  ["POST", "/customers/import"],
  ["POST", "/series/:id/cancel"],
  ["POST", "/series/:id/reschedule"],
  ["PUT", "/service-rules"],
  ["POST", "/bookings/:id/checkout"],
  ["POST", "/payments/:id/void"],
  ["POST", "/pay-runs"],
  ["PUT", "/pay-runs/:id"],
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
    const path = pattern.replace(/:[a-zA-Z]+/g, () => crypto.randomUUID());
    const foreign = await a.fetch(base + path, {
      method,
      headers: { Origin: "https://invalid.example" },
      ...(method !== "DELETE" ? { data: {} } : {}),
    });
    expect(foreign.status(), `${method} ${pattern} origin`).toBe(403);
    {
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

test("staff days off persist, isolate shops, reject bookings and moves, and release without history loss", async () => {
  const r = await owner();
  const other = await owner();
  const w = await workspace(r);
  const booked = await create(r, w);
  const second = await create(r, w, 900);
  const p = payload(w, 630);
  const staff = w.staff[0];
  const leave = { date: p.date, reason: "Fictional annual leave" };
  expect(
    (
      await other.post(base + `/staff/${staff.id}/days-off`, { data: leave })
    ).status(),
  ).toBe(404);
  const created = await r.post(base + `/staff/${staff.id}/days-off`, {
    data: leave,
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).id;
  expect(
    (
      await r.post(base + `/staff/${staff.id}/days-off`, { data: leave })
    ).status(),
  ).toBe(409);
  let after = await workspace(r);
  expect(after.days_off).toHaveLength(1);
  expect(after.issues.map((i) => i.booking_id)).toContain(booked.id);
  expect(after.issues[0].reason).toBe("Barber has a day off");
  expect(after.bookings).toHaveLength(2);
  const availability = await r.get(
    base +
      `/availability?date=${p.date}&staff_id=${staff.id}&service_id=${p.service_id}`,
  );
  expect(
    (await availability.json()).slots.every(
      (s: { reason: string }) => s.reason === "Barber has a day off",
    ),
  ).toBe(true);
  expect((await r.post(base + "/bookings", { data: p })).status()).toBe(409);
  expect(
    (
      await r.post(base + `/bookings/${second.id}/reschedule`, {
        data: {
          staff_id: staff.id,
          date: p.date,
          start_min: 630,
          version: 0,
          reason: "Test unavailable move",
        },
      })
    ).status(),
  ).toBe(409);
  expect(
    (await other.delete(base + `/staff/${staff.id}/days-off/${id}`)).status(),
  ).toBe(404);
  expect(
    (await r.delete(base + `/staff/${w.staff[1].id}/days-off/${id}`)).status(),
  ).toBe(404);
  expect(
    (
      await r.post(base + "/bookings", {
        data: {
          ...p,
          request_id: crypto.randomUUID(),
          staff_id: w.staff[1].id,
        },
      })
    ).status(),
  ).toBe(201);
  expect(
    (await r.delete(base + `/staff/${staff.id}/days-off/${id}`)).status(),
  ).toBe(200);
  expect((await r.post(base + "/bookings", { data: p })).status()).toBe(201);
  after = await workspace(r);
  expect(after.days_off).toHaveLength(0);
  expect(after.audit.filter((a) => a.action === "DAY_OFF_ADDED")).toHaveLength(
    1,
  );
  expect(
    after.audit.filter((a) => a.action === "DAY_OFF_REMOVED"),
  ).toHaveLength(1);
  expect(after.bookings.find((b) => b.id === second.id)?.start_min).toBe(900);
  await Promise.all([r.dispose(), other.dispose()]);
});

import { base, origin, newShop, shopPayload } from "./shop";
async function owner(name = "API test shop") {
  return (await newShop(name)).r;
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
      await anonymous.post(base + "/auth/signup", { data: { shop_name: "Rejected", name: "Nobody", email: "x@y.test", password: "Unique fictional test password 438!" } })
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
  // Nothing from shop A's forged writes landed in shop B's audit: only its own setup rows remain.
  expect(after.audit).toHaveLength(wb.audit.length);
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
      await r.put(base + `/staff/${s.id}/hours`, { data: { version: s.version, rows } })
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
      await r.put(base + `/staff/${s.id}/hours`, { data: { version: s.version, rows } })
    ).status(),
  ).toBe(409);
  expect(
    (await workspace(r)).hours
      .filter((h) => h.staff_id === s.id)
      .every((h) => h.enabled === 0),
  ).toBe(true);
  expect(
    (
      await r.put(base + `/staff/${s.id}/hours`, { data: { version: s.version + 1, rows } })
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
        data: { name: s.name, role: s.role, active: 0, version: s.version + 2 },
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
    // Per-day hours: Sunday closed, Saturday shorter, Thursday late.
    week: Array.from({ length: 7 }, (_, wd) => ({ enabled: wd === 0 ? 0 : 1, starts: 540, ends: wd === 6 ? 960 : wd === 4 ? 1200 : 1020 })),
    deposit_pence: 700,
    cancel_hours: 48,
    no_show_grace: 20,
    version: 0,
  };
  expect((await r.put(base + "/shop", { data: settings })).status()).toBe(200);
  const updated = (await workspace(r)).shop;
  expect(updated.name).toBe(settings.name);
  // Legacy envelope is derived: earliest open, latest close, closed weekdays.
  expect([updated.opens, updated.closes, JSON.parse(updated.closed_days)]).toEqual([540, 1200, [0]]);
  expect(JSON.parse(updated.week_json)[6]).toEqual({ enabled: 1, starts: 540, ends: 960 });
  // Availability honours the per-day hours: 16:30 is bookable on Thursday but not Saturday.
  const nextThu = (() => { const d = new Date(w.today + "T12:00:00Z"); do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== 4); return d.toISOString().slice(0, 10); })();
  const nextSat = (() => { const d = new Date(w.today + "T12:00:00Z"); do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== 6); return d.toISOString().slice(0, 10); })();
  const fresh = await workspace(r);
  const barber = fresh.staff.find((x) => x.active)!;
  // Barber rostered 09:00–20:00 every open day; the shop's own day hours are the tighter bound.
  const lateRows = fresh.hours.filter((h) => h.staff_id === barber.id).map((h) => ({ weekday: h.weekday, enabled: h.weekday === 0 ? 0 : 1, starts: 540, ends: 1200, break_start: 540, break_end: 540 }));
  expect((await r.put(base + `/staff/${barber.id}/hours`, { data: { version: barber.version, rows: lateRows } })).status()).toBe(200);
  const thu = await (await r.get(base + `/availability?date=${nextThu}&staff_id=${barber.id}&service_id=${w.services[0].id}`)).json();
  const sat = await (await r.get(base + `/availability?date=${nextSat}&staff_id=${barber.id}&service_id=${w.services[0].id}`)).json();
  expect(thu.slots.some((x: { start_min: number }) => x.start_min === 1110)).toBe(true);
  expect(sat.slots.some((x: { start_min: number }) => x.start_min === 1110)).toBe(false);
  await r.dispose();
});

// ---- Week range read, insights aggregates and standing (series) bookings ----
function plusDays(date: string, n: number) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
test("bookings/range is bounded to 31 days, tenant scoped and carries series_id", async () => {
  const r = await owner("Range shop");
  const other = await owner("Other range shop");
  const w = await workspace(r);
  const first = await create(r, w, 540);
  const from = first.date;
  const bad = await r.get(base + `/bookings/range?from=${from}&to=${plusDays(from, 40)}`);
  expect(bad.status()).toBe(400);
  const reversed = await r.get(base + `/bookings/range?from=${plusDays(from, 3)}&to=${from}`);
  expect(reversed.status()).toBe(400);
  const ok = await r.get(base + `/bookings/range?from=${from}&to=${plusDays(from, 6)}`);
  expect(ok.status()).toBe(200);
  const rows = (await ok.json()).bookings as any[];
  expect(rows.map((b) => b.id)).toContain(first.id);
  const row = rows.find((b) => b.id === first.id);
  expect(row.series_id).toBeNull();
  expect(row).not.toHaveProperty("phone");
  // Another tenant reading the same window sees nothing from this shop.
  const foreign = await other.get(base + `/bookings/range?from=${from}&to=${plusDays(from, 6)}`);
  expect(((await foreign.json()).bookings as any[]).map((b) => b.id)).not.toContain(first.id);
  await Promise.all([r.dispose(), other.dispose()]);
});

test("insights aggregates count only this shop's saved records and validate the period", async () => {
  const r = await owner("Insights shop");
  const other = await owner("Insights bystander");
  const w = await workspace(r);
  await create(r, w, 540);
  await create(r, w, 600);
  await create(other, await workspace(other), 540);
  expect((await r.get(base + "/insights?days=3")).status()).toBe(400);
  expect((await r.get(base + "/insights?days=400")).status()).toBe(400);
  // Bookings created by the test are in the future, so the trailing window excludes them...
  const trailing = await (await r.get(base + "/insights?days=30")).json();
  expect(trailing.days).toBe(30);
  expect(trailing.upcoming.n).toBe(2);
  expect(trailing.by_status.reduce((n: number, s: any) => n + s.n, 0)).toBe(0);
  // ...while the other tenant's upcoming count is its own.
  const bystander = await (await other.get(base + "/insights?days=30")).json();
  expect(bystander.upcoming.n).toBe(1);
  expect(Array.isArray(trailing.hours)).toBe(true);
  expect(Array.isArray(trailing.daily)).toBe(true);
  await Promise.all([r.dispose(), other.dispose()]);
});

test("series preview marks conflicts, requires explicit skips, and creation runs every occurrence through booking guards", async () => {
  const r = await owner("Series shop");
  const w = await workspace(r);
  const p = payload(w, 600);
  const seriesBody = {
    ...p,
    request_id: undefined,
    interval_weeks: 2,
    occurrences: 4,
    skip_dates: [] as string[],
  };
  delete (seriesBody as any).request_id;
  // Block the third occurrence with a day off so the preview must show a conflict.
  const blocked = plusDays(p.date, 28);
  expect(
    (
      await r.post(base + `/staff/${p.staff_id}/days-off`, {
        data: { date: blocked, reason: "Fictional leave" },
      })
    ).status(),
  ).toBe(201);
  const preview = await r.post(base + "/series/preview", { data: seriesBody });
  expect(preview.status(), await preview.text()).toBe(200);
  const pv = await preview.json();
  expect(pv.dates).toHaveLength(4);
  expect(pv.dates.map((d: any) => d.date)).toEqual([
    p.date,
    plusDays(p.date, 14),
    blocked,
    plusDays(p.date, 42),
  ]);
  expect(pv.dates[2].reason).toBeTruthy();
  expect(pv.bookable).toBe(3);
  // Saving with an unresolved conflict is refused; nothing is written.
  const refused = await r.post(base + "/series", { data: seriesBody });
  expect(refused.status()).toBe(409);
  expect((await workspace(r)).bookings).toHaveLength(0);
  // Skipping the conflict lets the rest save under one series id.
  const saved = await r.post(base + "/series", {
    data: { ...seriesBody, skip_dates: [blocked] },
  });
  expect(saved.status(), await saved.text()).toBe(201);
  const body = await saved.json();
  expect(body.created).toHaveLength(3);
  expect(body.failed).toEqual([]);
  expect(new Set(body.created.map((b: any) => b.series_id)).size).toBe(1);
  expect(body.created[0].series_id).toBe(body.series_id);
  // Fewer than two bookable dates is rejected up front.
  const tooFew = await r.post(base + "/series", {
    data: { ...seriesBody, occurrences: 2, skip_dates: [plusDays(p.date, 14)] },
  });
  expect(tooFew.status()).toBe(409);
  // Re-previewing the same series now reports every kept date as taken.
  const again = await (await r.post(base + "/series/preview", { data: seriesBody })).json();
  expect(again.dates.filter((d: any) => d.reason).length).toBe(4);
  // Shape validation: unknown keys and out-of-range cadence are rejected.
  expect(
    (await r.post(base + "/series", { data: { ...seriesBody, interval_weeks: 0 } })).status(),
  ).toBe(400);
  expect(
    (await r.post(base + "/series", { data: { ...seriesBody, occurrences: 27 } })).status(),
  ).toBe(400);
  expect(
    (await r.post(base + "/series", { data: { ...seriesBody, extra: 1 } })).status(),
  ).toBe(400);
  // Audit trail and range read agree.
  const after = await workspace(r);
  expect(after.audit.filter((a) => a.action === "SERIES_CREATED")).toHaveLength(1);
  expect(after.audit.filter((a) => a.action === "BOOKING_CREATED").length).toBeGreaterThanOrEqual(3);
  const range = await (
    await r.get(base + `/bookings/range?from=${p.date}&to=${plusDays(p.date, 30)}`)
  ).json();
  expect(range.bookings.filter((b: any) => b.series_id === body.series_id)).toHaveLength(2);
  await r.dispose();
});

test("customers: booking creates/links records, CRUD is versioned, filters/sorts work, merge moves visits, barbers scoped", async () => {
  const r = await owner("Customer records shop");
  const w = await workspace(r);
  const first = await create(r, w, 540);
  expect(first.customer_id).toBeTruthy();
  // Same phone again reuses the record; a different phone makes a second record.
  const second = await create(r, w, 660);
  expect(second.customer_id).toBe(first.customer_id);
  const other = await r.post(base + "/bookings", { data: { ...payload(w, 840), phone: "07700900777", customer_name: "Second Person" } });
  expect(other.status(), await other.text()).toBe(201);
  const list = await (await r.get(base + "/customers")).json();
  expect(list.customers).toHaveLength(2);
  const me = list.customers.find((c: any) => c.id === first.customer_id);
  expect(me.upcoming).toBe(2);
  expect(me.visits).toBe(2);
  // Create via API with tags; duplicate phone refused.
  const created = await r.post(base + "/customers", { data: { name: "Walk In", phone: "07700 900 888", email: "", tags: ["VIP"] } });
  expect(created.status(), await created.text()).toBe(201);
  const cust = (await created.json()).customer;
  expect(cust.phone).toBe("07700900888");
  expect((await r.post(base + "/customers", { data: { name: "Dup", phone: "07700900888" } })).status()).toBe(409);
  expect((await r.post(base + "/customers", { data: { name: "Bad", phone: "12345" } })).status()).toBe(400);
  // Update is versioned and audited.
  const upd = await r.put(base + `/customers/${cust.id}`, {
    data: { name: "Walk In", phone: "07700900888", email: "w@example.test", notes: "Likes it short", tags: ["VIP", "Regular"], birthday: "", preferred_staff_id: w.staff[1].id, marketing_opt_in: 1, version: 0 },
  });
  expect(upd.status(), await upd.text()).toBe(200);
  expect((await upd.json()).customer.version).toBe(1);
  expect((await r.put(base + `/customers/${cust.id}`, { data: { name: "Walk In", phone: "07700900888", version: 0 } })).status()).toBe(409);
  // Booking against a chosen customer_id links it even with a different typed phone.
  const linked = await r.post(base + "/bookings", { data: { ...payload(w, 900), phone: "07700900111", customer_name: "Typed Differently", customer_id: cust.id } });
  expect(linked.status(), await linked.text()).toBe(201);
  expect((await linked.json()).booking.customer_id).toBe(cust.id);
  // Profile aggregates.
  const profile = await (await r.get(base + `/customers/${cust.id}`)).json();
  expect(profile.customer.upcoming).toBe(1);
  expect(profile.bookings).toHaveLength(1);
  expect(JSON.parse(profile.customer.tags)).toEqual(["VIP", "Regular"]);
  // Filters and sorts.
  expect((await (await r.get(base + "/customers?filter=upcoming")).json()).customers.length).toBe(3);
  expect((await (await r.get(base + "/customers?filter=regulars")).json()).customers.length).toBe(0);
  expect((await (await r.get(base + "/customers?q=VIP")).json()).customers.map((c: any) => c.id)).toEqual([cust.id]);
  expect((await r.get(base + "/customers?filter=bogus")).status()).toBe(400);
  const byName = (await (await r.get(base + "/customers?sort=name")).json()).customers.map((c: any) => c.name);
  expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b)));
  // Merge the second person into the first; visits move, loser resolves to winner.
  const loser = list.customers.find((c: any) => c.phone === "07700900777");
  const merged = await r.post(base + `/customers/${loser.id}/merge`, { data: { into: first.customer_id, version: loser.version } });
  expect(merged.status(), await merged.text()).toBe(200);
  expect((await merged.json()).moved).toBe(1);
  const after = await (await r.get(base + `/customers/${first.customer_id}`)).json();
  expect(after.bookings).toHaveLength(3);
  expect((await (await r.get(base + `/customers/${loser.id}`)).json()).customer.id).toBe(first.customer_id);
  expect((await (await r.get(base + "/customers")).json()).customers).toHaveLength(2);
  expect((await r.post(base + `/customers/${loser.id}/merge`, { data: { into: first.customer_id, version: 1 } })).status()).toBe(409);
  const audit = (await workspace(r)).audit.map((a) => a.action);
  for (const action of ["CUSTOMER_CREATED", "CUSTOMER_UPDATED", "CUSTOMER_MERGED", "CUSTOMER_MERGED_AWAY"]) expect(audit).toContain(action);
  // Another tenant cannot read or book against this customer.
  const stranger = await owner("Other customers shop");
  expect((await stranger.get(base + `/customers/${cust.id}`)).status()).toBe(404);
  const sw = await workspace(stranger);
  expect((await stranger.post(base + "/bookings", { data: { ...payload(sw, 540), customer_id: cust.id } })).status()).toBe(404);
  await Promise.all([r.dispose(), stranger.dispose()]);
});

test("appointment timeline and standing-series cancel/reschedule operate through the same guards", async () => {
  const r = await owner("Series ops shop");
  const w = await workspace(r);
  const p = payload(w, 600);
  const { request_id, ...rest } = p;
  const saved = await r.post(base + "/series", { data: { ...rest, interval_weeks: 1, occurrences: 4, skip_dates: [] } });
  expect(saved.status(), await saved.text()).toBe(201);
  const body = await saved.json();
  const [v1, v2, v3, v4] = body.created as StoredBooking[];
  const tl = await (await r.get(base + `/bookings/${v2.id}/timeline`)).json();
  expect(tl.booking.id).toBe(v2.id);
  expect(tl.events.map((e: any) => e.action)).toContain("BOOKING_CREATED");
  expect(tl.customer.visits).toBe(4);
  expect(tl.series).toHaveLength(4);
  // Move v3 onward to 11:00 with the other barber; v1/v2 untouched.
  const moved = await r.post(base + `/series/${body.series_id}/reschedule`, {
    data: { staff_id: w.staff[1].id, start_min: 660, reason: "Barber swap", from_booking_id: v3.id },
  });
  expect(moved.status(), await moved.text()).toBe(200);
  const mv = await moved.json();
  expect(mv.moved.map((b: any) => b.id).sort()).toEqual([v3.id, v4.id].sort());
  expect(mv.failed).toEqual([]);
  expect(mv.moved.every((b: any) => b.start_min === 660 && b.staff_id === w.staff[1].id)).toBe(true);
  expect((await (await r.get(base + `/bookings/${v1.id}`)).json()).booking.start_min).toBe(600);
  // Cancel from v2 onward; v1 stays confirmed.
  const cancelled = await r.post(base + `/series/${body.series_id}/cancel`, { data: { reason: "Customer moving away", from_booking_id: v2.id } });
  expect(cancelled.status(), await cancelled.text()).toBe(200);
  expect((await cancelled.json()).cancelled).toBe(3);
  expect((await (await r.get(base + `/bookings/${v1.id}`)).json()).booking.status).toBe("CONFIRMED");
  expect((await (await r.get(base + `/bookings/${v4.id}`)).json()).booking.status).toBe("CANCELLED");
  // Nothing left to cancel after the last visit is cancelled too.
  expect((await r.post(base + `/series/${body.series_id}/cancel`, { data: { reason: "All" } })).status()).toBe(200);
  expect((await r.post(base + `/series/${body.series_id}/cancel`, { data: { reason: "Again" } })).status()).toBe(404);
  expect((await r.post(base + `/series/${body.series_id}/cancel`, { data: { reason: "x" } })).status()).toBe(400);
  const audit = (await workspace(r)).audit.map((a) => a.action);
  expect(audit).toContain("SERIES_RESCHEDULED");
  expect(audit).toContain("SERIES_CANCELLED");
  await r.dispose();
});

test("catalogue profiles: barber/service presentation fields validate, persist, and the rule matrix upserts/deletes atomically across shops", async () => {
  const r = await owner("Studio API shop");
  const other = await owner("Studio API other shop");
  const w = await workspace(r);
  const jay = w.staff[0];
  // Barber profile: https-only photo, handle regex, skills cap.
  const bad = await r.put(base + `/staff/${jay.id}`, {
    data: { name: jay.name, role: jay.role, active: 1, version: jay.version, photo_url: "http://insecure.example/p.jpg" },
  });
  expect(bad.status()).toBe(400);
  expect(
    (
      await r.put(base + `/staff/${jay.id}`, {
        data: { name: jay.name, role: jay.role, active: 1, version: jay.version, instagram: "not a handle!" },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await r.put(base + `/staff/${jay.id}`, {
        data: { name: jay.name, role: jay.role, active: 1, version: jay.version, colour: "neon" },
      })
    ).status(),
  ).toBe(400);
  const profile = await r.put(base + `/staff/${jay.id}`, {
    data: {
      name: jay.name,
      role: jay.role,
      active: 1,
      version: jay.version,
      title: "Senior barber",
      bio: "Fades and beards.",
      colour: "plum",
      photo_url: "https://images.example/jay.jpg",
      online_visible: 0,
      skills: ["Skin fades", "Beards"],
      instagram: "@jay.cuts",
      start_date: "2021-03-01",
      sort_order: 2,
    },
  });
  expect(profile.status(), await profile.text()).toBe(200);
  let latest = await workspace(r);
  const saved = latest.staff.find((s) => s.id === jay.id)!;
  expect(saved).toMatchObject({ title: "Senior barber", colour: "plum", online_visible: 0, instagram: "jay.cuts", sort_order: 2 });
  expect(JSON.parse(saved.skills)).toEqual(["Skin fades", "Beards"]);
  // Service presentation fields.
  const created = await r.post(base + "/services", {
    data: {
      name: "Studio API service",
      category: "Hair",
      duration_min: 40,
      price_pence: 3100,
      active: 1,
      description: "Consultation, cut, finish.",
      colour: "slate",
      online_bookable: 0,
      popular: 1,
      sort_order: 5,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const serviceId = (await created.json()).id;
  latest = await workspace(r);
  expect(latest.services.find((s) => s.id === serviceId)).toMatchObject({ description: "Consultation, cut, finish.", colour: "slate", online_bookable: 0, popular: 1, sort_order: 5 });
  // Matrix: upsert two rows, default row deletes any prior override, foreign ids rejected.
  const [svcA, svcB] = latest.services;
  const matrix = await r.put(base + "/service-rules", {
    data: {
      rules: [
        { staff_id: jay.id, service_id: svcA.id, enabled: 1, price_pence: 3300, duration_min: null },
        { staff_id: jay.id, service_id: svcB.id, enabled: 0, price_pence: null, duration_min: null },
      ],
    },
  });
  expect(matrix.status(), await matrix.text()).toBe(200);
  latest = await workspace(r);
  expect(latest.service_rules.find((x) => x.staff_id === jay.id && x.service_id === svcA.id)).toMatchObject({ enabled: 1, price_pence: 3300, duration_min: null });
  expect(latest.service_rules.find((x) => x.staff_id === jay.id && x.service_id === svcB.id)).toMatchObject({ enabled: 0 });
  const reset = await r.put(base + "/service-rules", {
    data: { rules: [{ staff_id: jay.id, service_id: svcA.id, enabled: 1, price_pence: null, duration_min: null }] },
  });
  expect(reset.status()).toBe(200);
  latest = await workspace(r);
  expect(latest.service_rules.some((x) => x.staff_id === jay.id && x.service_id === svcA.id)).toBe(false);
  expect(latest.service_rules.some((x) => x.staff_id === jay.id && x.service_id === svcB.id)).toBe(true);
  expect(latest.audit.some((a) => a.action === "SERVICE_RULES_UPDATED")).toBe(true);
  // Cross-tenant: another shop cannot address this shop's barber or service.
  const foreign = await other.put(base + "/service-rules", {
    data: { rules: [{ staff_id: jay.id, service_id: svcA.id, enabled: 0, price_pence: null, duration_min: null }] },
  });
  expect(foreign.status()).toBe(404);
  expect((await other.get(base + "/workspace").then((x) => x.json())).service_rules).toHaveLength(0);
  // Validation: empty list, bad price, duplicate pairs.
  expect((await r.put(base + "/service-rules", { data: { rules: [] } })).status()).toBe(400);
  expect(
    (
      await r.put(base + "/service-rules", {
        data: { rules: [{ staff_id: jay.id, service_id: svcA.id, enabled: 1, price_pence: -5, duration_min: null }] },
      })
    ).status(),
  ).toBe(400);
  await Promise.all([r.dispose(), other.dispose()]);
});
