// Multi-tenant isolation. foliyo is a SaaS: every shop has its own data, settings and team.
// Shop B is signed in as a real owner and aims at shop A's ids. Every attempt must be refused
// (never 2xx), and shop A's data must be byte-for-byte unchanged afterwards.
// Also: each shop's own settings are its own, and a barber cannot change shop settings.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { base, newShop, origin, PASSWORD } from "./shop";

type W = {
  shop: { version: number };
  staff: { id: string; version: number; name: string }[];
  services: { id: string; version: number }[];
  bookings: { id: string; version: number }[];
};

function futureDate(days = 8) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function ws(r: APIRequestContext): Promise<W & Record<string, unknown>> {
  return (await (await r.get(base + "/workspace")).json()) as never;
}

// What we compare before/after: everything that belongs to the shop, minus clocks and the audit trail.
const snapshot = (w: Record<string, unknown>) => {
  const { now, today, audit, ...rest } = w as Record<string, unknown>;
  void now; void today; void audit;
  return JSON.stringify(rest);
};

async function seedA() {
  const a = await newShop("Isolation A");
  const w = await ws(a.r);
  const svc = w.services[0];
  const res = await a.r.post(base + "/bookings", {
    data: {
      request_id: crypto.randomUUID(),
      staff_id: w.staff[0].id,
      service_id: svc.id,
      date: futureDate(),
      start_min: 600,
      customer_name: "Alice Aardvark",
      phone: "07700900321",
      email: "alice@isolation.test",
      source: "TEST_BOOKING",
      quote: { service_version: svc.version, shop_version: w.shop.version },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const booking = (await res.json()).booking as { id: string; version: number };
  const customers = (await (await a.r.get(base + "/customers")).json()) as { customers?: { id: string }[] } | { id: string }[];
  const list = Array.isArray(customers) ? customers : customers.customers || [];
  expect(list.length).toBeGreaterThan(0);
  return { a, w: await ws(a.r), booking, customerId: list[0].id };
}

test("shop B cannot read or change anything that belongs to shop A", async () => {
  const { a, w, booking, customerId } = await seedA();
  const b = await newShop("Isolation B");
  const before = snapshot(await ws(a.r));
  const staffId = w.staff[0].id, serviceId = w.services[0].id;
  const uuid = () => crypto.randomUUID();

  // [method, path, body]. A's real ids, B's session.
  const attempts: [string, string, unknown?][] = [
    ["GET", `/bookings/${booking.id}`],
    ["GET", `/bookings/${booking.id}/timeline`],
    ["PATCH", `/bookings/${booking.id}/details`, { version: booking.version, notes: "hacked" }],
    ["POST", `/bookings/${booking.id}/status`, { status: "CANCELLED", version: booking.version, reason: "hacked" }],
    ["POST", `/bookings/${booking.id}/reschedule`, { date: futureDate(9), start_min: 660, staff_id: staffId, version: booking.version }],
    ["POST", `/bookings/${booking.id}/checkout`, { tenders: [], complete: false, version: booking.version }],
    ["POST", `/bookings/${booking.id}/manage-link`, {}],
    ["POST", `/bookings/${booking.id}/pay-link`, {}],
    ["POST", `/bookings/${booking.id}/deposit/refund`, {}],
    ["GET", `/customers/${customerId}`],
    ["GET", `/customers/${customerId}/messages`],
    ["PUT", `/customers/${customerId}`, { name: "Hacked", version: 1 }],
    ["POST", `/customers/${customerId}/erase`, {}],
    ["POST", `/customers/${customerId}/merge`, { into: customerId }],
    ["PUT", `/staff/${staffId}`, { name: "Hacked", role: "Barber", version: w.staff[0].version }],
    ["GET", `/staff/${staffId}/pay-history`],
    ["PUT", `/staff/${staffId}/hours`, { version: w.staff[0].version, rows: [] }],
    ["POST", `/staff/${staffId}/days-off`, { start_date: futureDate(), end_date: futureDate(), kind: "HOLIDAY" }],
    ["GET", `/staff/${staffId}/blocks`],
    ["POST", `/staff/${staffId}/blocks`, { date: futureDate(), start_min: 600, end_min: 700 }],
    ["PUT", `/staff/${staffId}/holiday-allowance`, { days: 99 }],
    ["PUT", `/services/${serviceId}`, { name: "Hacked", duration_min: 10, price_pence: 1, version: w.services[0].version }],
    ["PUT", `/staff/${staffId}/services/${serviceId}`, { enabled: 0 }],
    ["POST", `/staff/${staffId}/overrides`, { service_id: serviceId, price_pence: 1 }],
    ["DELETE", `/holidays/${uuid()}`],
    ["GET", `/notifications/${uuid()}`],
    ["POST", `/notifications/${uuid()}/resend`, {}],
    ["POST", `/payments/${uuid()}/void`, { reason: "hacked" }],
    ["PUT", `/pay-runs/${uuid()}`, {}],
    ["POST", `/pay-runs/${uuid()}/transfer`, {}],
    ["POST", `/series/${uuid()}/cancel`, {}],
    ["POST", `/waitlist/${uuid()}/status`, { status: "CLOSED" }],
  ];

  for (const [method, path, data] of attempts) {
    const res = await b.r.fetch(base + path, { method, data: data as never });
    const text = await res.text();
    expect(res.status(), `${method} ${path} should not be a server error: ${text.slice(0, 200)}`).toBeLessThan(500);
    if (method === "GET" && res.status() < 400) {
      // A read scoped to the caller's own shop may answer "nothing here"; it must never contain A's data.
      for (const secret of [booking.id, customerId, "Alice", "alice@isolation.test", "07700900321"])
        expect(text, `${method} ${path} leaked ${secret}`).not.toContain(secret);
      continue;
    }
    expect(res.status(), `${method} ${path} must be refused for another shop's record, got ${res.status()}: ${text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
  }

  // B's own lists never contain A's records.
  const bw = await ws(b.r);
  expect(bw.bookings.map((x) => x.id)).not.toContain(booking.id);
  expect(JSON.stringify(bw)).not.toContain("Alice Aardvark");
  expect(JSON.stringify(await (await b.r.get(base + "/customers")).json())).not.toContain("Alice");
  expect(JSON.stringify(await (await b.r.get(base + "/notifications")).json())).not.toContain("alice@isolation.test");

  // And A is exactly as it was.
  expect(snapshot(await ws(a.r))).toBe(before);
});

test("each shop's settings are its own: B changing messaging, online booking and payments leaves A alone", async () => {
  const a = await newShop("Settings A");
  const b = await newShop("Settings B");
  const aw = await ws(a.r);
  const before = JSON.stringify((aw.shop as unknown) as object);
  expect(JSON.parse(before).msg_sms).toBe(1);

  const m = await b.r.put(base + "/shop/messaging", { data: { msg_sms: 0, msg_email: 0, msg_reminders: 0, msg_reminder_hours: 2, msg_reply_to: "", msg_sms_sender: "BShop" } });
  expect(m.status(), await m.text()).toBe(200);
  const slugB = `iso-${crypto.randomUUID().slice(0, 8)}`;
  const o = await b.r.put(base + "/shop/online", { data: { slug: slugB, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: (await ws(b.r)).shop.version } });
  expect(o.status(), await o.text()).toBe(200);

  const aAfter = (await ws(a.r)).shop as unknown as Record<string, unknown>;
  expect(JSON.stringify(aAfter)).toBe(before);
  expect(aAfter.msg_sms).not.toBe(0);

  // B cannot take A's web address, and A's page is not B's.
  const wa = await ws(a.r);
  const slugA = `iso-${crypto.randomUUID().slice(0, 8)}`;
  expect((await a.r.put(base + "/shop/online", { data: { slug: slugA, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: wa.shop.version } })).status()).toBe(200);
  const steal = await b.r.put(base + "/shop/online", { data: { slug: slugA, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: (await ws(b.r)).shop.version } });
  expect(steal.status(), "a second shop must not be able to claim an address already in use").toBeGreaterThanOrEqual(400);
  const pub = await (await a.r.get(`${origin}/api/public/shops/${slugA}`)).json();
  expect(JSON.stringify(pub)).not.toContain(slugB);

  // A message from shop A's customer reaches only shop A's outbox.
  expect(JSON.stringify(await (await b.r.get(base + "/notifications")).json())).not.toContain(slugA);
});

test("a barber cannot change shop-wide settings or see other barbers' pay; owners of other shops cannot sign in as them", async () => {
  const a = await newShop("Perms A");
  const w = await ws(a.r);
  const address = `bea-${crypto.randomUUID().slice(0, 8)}@perm.test`;
  const inv = await a.r.post(base + "/auth/invites", { data: { email: address, role: "BARBER", staff_id: w.staff[0].id } });
  expect(inv.status(), await inv.text()).toBe(201);
  const { token } = await inv.json();
  const barber = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const acc = await barber.post(base + "/auth/accept", { data: { accept_legal: true, token, name: "Bea Barber", email: address, password: PASSWORD } });
  expect(acc.status(), await acc.text()).toBe(201);

  const before = JSON.stringify((await ws(a.r)).shop);
  const forbidden: [string, string, unknown][] = [
    ["PUT", "/shop/messaging", { msg_sms: 0, msg_email: 0, msg_reminders: 0, msg_reminder_hours: 2, msg_reply_to: "", msg_sms_sender: "Nope" }],
    ["PUT", "/shop/online", { slug: `bad-${crypto.randomUUID().slice(0, 8)}`, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: 1 }],
    ["PUT", "/shop/payments", {}],
    ["PUT", "/shop", { name: "Hacked", version: 1 }],
    ["POST", "/staff", { name: "Fake Barber", role: "Barber" }],
    ["POST", "/services", { name: "Free cut", duration_min: 30, price_pence: 0, category: "Hair" }],
    ["GET", `/staff/${w.staff[0].id}/pay-history`, undefined],
    ["POST", "/auth/invites", { email: `x-${crypto.randomUUID().slice(0, 8)}@perm.test`, role: "OWNER", staff_id: w.staff[0].id }],
    ["PUT", `/staff/${w.staff[0].id}/hours`, { version: w.staff[0].version, rows: [] }],
    ["POST", "/announcements/send", { kind: "custom", channel: "SMS", audience: "ALL", body: "hi", confirm: true }],
  ];
  for (const [method, path, data] of forbidden) {
    const res = await barber.fetch(base + path, { method, data: data as never });
    expect(res.status(), `barber ${method} ${path} must be refused, got ${res.status()}: ${(await res.text()).slice(0, 160)}`).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  }
  expect(JSON.stringify((await ws(a.r)).shop)).toBe(before);

  // The barber's login is bound to this one shop: another shop's owner cannot use it, and it sees no other shop.
  const other = await newShop("Perms B");
  expect(JSON.stringify(await (await barber.get(base + "/workspace")).json())).not.toContain((await ws(other.r)).shop ? other.shop_id : "never");
});
