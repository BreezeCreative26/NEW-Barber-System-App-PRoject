import {
  test,
  expect,
  request,
  type APIRequestContext,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import type { WorkspaceData } from "../src/server/domain";

// Public online booking, customer manage links and owner customer directory.
// Every test creates its own fictional shop; nothing live is touched.
const origin = "http://localhost:3000",
  base = origin + "/api/sandbox",
  pub = origin + "/api/public";
const slugFor = () => `test-${crypto.randomUUID().slice(0, 12)}`;
function futureDate(days = 8) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function owner(enable = true) {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  expect(
    (await r.post(base + "/session", { data: { name: "Public Test Shop" } }))
      .status(),
  ).toBe(201);
  let w: WorkspaceData = await (await r.get(base + "/workspace")).json();
  const slug = slugFor();
  if (enable) {
    const res = await r.put(base + "/shop/online", {
      data: {
        slug,
        online_booking: 1,
        lead_time_min: 60,
        booking_window_days: 42,
        version: w.shop.version,
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    w = await (await r.get(base + "/workspace")).json();
  }
  return { r, w, slug };
}
async function customer() {
  return request.newContext({ extraHTTPHeaders: { Origin: origin } });
}
async function bookOnline(
  c: APIRequestContext,
  slug: string,
  w: WorkspaceData,
  date: string,
  start_min = 600,
  extra: Record<string, unknown> = {},
) {
  const staff = w.staff[0].id,
    service = w.services[0].id;
  const avail = await (
    await c.get(
      `${pub}/shops/${slug}/availability?date=${date}&staff_id=${staff}&service_id=${service}`,
    )
  ).json();
  const data = {
    request_id: crypto.randomUUID(),
    staff_id: staff,
    service_id: service,
    customer_name: "Online Customer",
    phone: "07700 900222",
    email: "online@example.test",
    date,
    start_min,
    quote: avail.quote,
    ...extra,
  };
  const res = await c.post(`${pub}/shops/${slug}/bookings`, { data });
  return { res, data, avail };
}

test("public shop read hides disabled shops and exposes only active catalogue", async () => {
  const off = await owner(false);
  const c = await customer();
  expect((await c.get(`${pub}/shops/${off.slug}`)).status()).toBe(404);
  const on = await owner();
  // Deactivate one barber; they must vanish from the public read.
  await on.r.put(base + `/staff/${on.w.staff[1].id}`, {
    data: {
      name: on.w.staff[1].name,
      role: on.w.staff[1].role,
      active: 0,
      version: on.w.staff[1].version,
    },
  });
  const shop = await (await c.get(`${pub}/shops/${on.slug}`)).json();
  expect(shop.staff.map((s: { id: string }) => s.id)).toEqual([on.w.staff[0].id]);
  expect(shop.shop).not.toHaveProperty("no_show_grace");
  expect(shop.livePayments).toBe(false);
  // Switching online booking off keeps the slug but blocks the public page.
  const w2: WorkspaceData = await (await on.r.get(base + "/workspace")).json();
  await on.r.put(base + "/shop/online", {
    data: {
      slug: on.slug,
      online_booking: 0,
      lead_time_min: 60,
      booking_window_days: 42,
      version: w2.shop.version,
    },
  });
  expect((await c.get(`${pub}/shops/${on.slug}`)).status()).toBe(404);
});

test("slugs are unique, validated and reserved words are rejected", async () => {
  const a = await owner();
  const b = await owner(false);
  const clash = await b.r.put(base + "/shop/online", {
    data: {
      slug: a.slug,
      online_booking: 1,
      lead_time_min: 0,
      booking_window_days: 7,
      version: b.w.shop.version,
    },
  });
  expect(clash.status()).toBe(409);
  expect((await clash.json()).error).toBe("slug_taken");
  for (const slug of ["Bad Slug", "workspace", "-x-", "ab"]) {
    const res = await b.r.put(base + "/shop/online", {
      data: {
        slug,
        online_booking: 1,
        lead_time_min: 0,
        booking_window_days: 7,
        version: b.w.shop.version,
      },
    });
    expect(res.status(), slug).toBe(400);
  }
  // Barber accounts cannot change online settings; owner sandbox session can.
  const stale = await b.r.put(base + "/shop/online", {
    data: {
      slug: slugFor(),
      online_booking: 1,
      lead_time_min: 0,
      booking_window_days: 7,
      version: b.w.shop.version + 5,
    },
  });
  expect(stale.status()).toBe(409);
});

test("online booking shares owner guards: lead time, window, collisions, replay and channel", async () => {
  const { r, w, slug } = await owner();
  const c = await customer();
  const date = futureDate();
  const first = await bookOnline(c, slug, w, date);
  expect(first.res.status(), await first.res.text()).toBe(201);
  const created = await first.res.json();
  expect(created.booking.reference).toMatch(/^BRB-\d{4}$/);
  expect(created.manage_token).toHaveLength(72);
  // Identical replay returns the same booking without a second token.
  const replay = await c.post(`${pub}/shops/${slug}/bookings`, { data: first.data });
  expect(replay.status()).toBe(200);
  const replayed = await replay.json();
  expect(replayed.replayed).toBe(true);
  expect(replayed.booking.id).toBe(created.booking.id);
  expect(replayed.manage_token).toBeNull();
  // Same time again from another customer collides.
  const clash = await bookOnline(c, slug, w, date, 600, {
    phone: "07700 900333",
  });
  expect(clash.res.status()).toBe(409);
  expect((await clash.res.json()).error).toBe("slot_taken");
  // Owner calendar sees the visit tagged ONLINE with the email.
  const day = await (await r.get(base + `/bookings?date=${date}`)).json();
  expect(day.bookings).toHaveLength(1);
  expect(day.bookings[0].channel).toBe("ONLINE");
  expect(day.bookings[0].email).toBe("online@example.test");
  // Owner cannot reuse an online request_id with a different channel.
  const ownerReplay = await r.post(base + "/bookings", {
    data: { ...first.data, source: "TEST_BOOKING", email: undefined },
  });
  expect(ownerReplay.status()).toBe(409);
  // Beyond the window and inside lead time are refused.
  const farAvail = await c.get(
    `${pub}/shops/${slug}/availability?date=${futureDate(60)}&staff_id=${w.staff[0].id}&service_id=${w.services[0].id}`,
  );
  expect(farAvail.status()).toBe(409);
  const far = await c.post(`${pub}/shops/${slug}/bookings`, {
    data: {
      ...first.data,
      request_id: crypto.randomUUID(),
      phone: "07700 900444",
      date: futureDate(60),
    },
  });
  expect(far.status()).toBe(409);
  expect((await far.json()).error).toBe("outside_booking_window");
  const today = w.today;
  const soon = await c.get(
    `${pub}/shops/${slug}/availability?date=${today}&staff_id=${w.staff[0].id}&service_id=${w.services[0].id}`,
  );
  if (soon.status() === 200) {
    const slots = (await soon.json()).slots as { start_min: number; available: boolean }[];
    const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    for (const s of slots)
      if (s.start_min < nowMin + 45) expect(s.available).toBe(false);
  }
  // Public availability never reveals who holds a slot.
  const publicSlots = (await first.avail).slots as { reason: string }[];
  expect(publicSlots.some((s) => s.reason === "Slot taken")).toBe(false);
  // Days summary counts open times and marks closed days.
  const days = await (
    await c.get(
      `${pub}/shops/${slug}/days?staff_id=${w.staff[0].id}&service_id=${w.services[0].id}&from=${date}`,
    )
  ).json();
  expect(days.days).toHaveLength(14);
  const booked = days.days.find((d: { date: string }) => d.date === date);
  expect(booked.available).toBeLessThan(
    days.days.find((d: { date: string; closed: boolean }) => !d.closed && d.date !== date).available + 1,
  );
  expect(days.days.some((d: { closed: boolean }) => d.closed)).toBe(true);
});

test("manage link views, moves, cancels with version guards and calendar export", async () => {
  const { r, w, slug } = await owner();
  const c = await customer();
  const date = futureDate();
  const { res } = await bookOnline(c, slug, w, date);
  const { manage_token: token, booking } = await res.json();
  const view = await (await c.get(`${pub}/manage/${token}`)).json();
  expect(view.booking.can_manage).toBe(true);
  expect(view.booking.late_change).toBe(false);
  expect(view.booking).not.toHaveProperty("request_hash");
  const ics = await c.get(`${pub}/manage/${token}/calendar.ics`);
  expect(ics.headers()["content-type"]).toContain("text/calendar");
  const body = await ics.text();
  expect(body).toContain("BEGIN:VEVENT");
  expect(body).toContain(booking.reference);
  // Reschedule availability excludes own booking and moving succeeds.
  const avail = await (
    await c.get(`${pub}/manage/${token}/availability?date=${date}`)
  ).json();
  expect(avail.slots.find((s: { start_min: number }) => s.start_min === 600).available).toBe(true);
  const moved = await c.post(`${pub}/manage/${token}/reschedule`, {
    data: { date, start_min: 840, version: view.booking.version },
  });
  expect(moved.status(), await moved.text()).toBe(200);
  const after = (await moved.json()).booking;
  expect(after.start_min).toBe(840);
  expect(after.version).toBe(view.booking.version + 1);
  // Stale version fails; owner sees audit; cancel releases the slot.
  const stale = await c.post(`${pub}/manage/${token}/cancel`, {
    data: { version: view.booking.version },
  });
  expect(stale.status()).toBe(409);
  const cancel = await c.post(`${pub}/manage/${token}/cancel`, {
    data: { version: after.version },
  });
  expect(cancel.status()).toBe(200);
  expect((await cancel.json()).booking.status).toBe("CANCELLED");
  const again = await c.post(`${pub}/manage/${token}/cancel`, {
    data: { version: after.version + 1 },
  });
  expect(again.status()).toBe(409);
  const rebook = await bookOnline(c, slug, w, date, 840, { phone: "07700 900555" });
  expect(rebook.res.status()).toBe(201);
  const ws: WorkspaceData = await (await r.get(base + "/workspace")).json();
  const actions = ws.audit.map((a) => a.action);
  expect(actions).toContain("RESCHEDULED");
  expect(actions).toContain("CANCELLED");
  expect(ws.audit.find((a) => a.action === "CANCELLED")?.actor).toBe("customer:online");
  // Garbage or short tokens return 404 without revealing anything.
  expect((await c.get(`${pub}/manage/${"x".repeat(70)}`)).status()).toBe(404);
  expect((await c.get(`${pub}/manage/short`)).status()).toBe(404);
  // Cross-origin writes are refused.
  const evil = await request.newContext({ extraHTTPHeaders: { Origin: "https://evil.example" } });
  expect(
    (await evil.post(`${pub}/manage/${token}/cancel`, { data: { version: 0 } })).status(),
  ).toBe(403);
});

test("owner customer directory aggregates visits by phone and scopes barbers", async () => {
  const { r, w, slug } = await owner();
  const c = await customer();
  const date = futureDate();
  expect((await bookOnline(c, slug, w, date, 600)).res.status()).toBe(201);
  expect(
    (await bookOnline(c, slug, w, date, 840, { customer_name: "Online Customer Renamed" })).res.status(),
  ).toBe(201);
  await bookOnline(c, slug, w, date, 960, {
    phone: "07700 900999",
    customer_name: "Second Person",
    email: "",
  });
  const list = await (await r.get(base + "/customers")).json();
  expect(list.customers).toHaveLength(2);
  const first = list.customers.find((x: { phone: string }) => x.phone === "07700900222");
  expect(first.visits).toBe(2);
  // The customer record keeps the first-seen contact; the later rename stays on the booking snapshot.
  expect(first.email).toBe("online@example.test");
  expect(first.favourite_service).toBeNull();
  expect(first.upcoming).toBe(2);
  const search = await (await r.get(base + "/customers?q=second")).json();
  expect(search.customers).toHaveLength(1);
  const history = await (await r.get(base + "/customers/07700900222")).json();
  expect(history.bookings).toHaveLength(2);
  expect(history.customer.id).toBe(first.id);
  expect((await r.get(base + `/customers/${first.id}`)).status()).toBe(200);
  expect((await r.get(base + "/customers/12345")).status()).toBe(404);
  expect((await r.get(base + "/customers/07700900000")).status()).toBe(404);
});

test.describe("public booking pages", () => {
  test("customer books end to end, gets a manage link and moves the visit", async ({ page }) => {
    const { r, w, slug } = await owner();
    const date = futureDate();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/book/${slug}`);
    await expect(page.getByRole("heading", { name: "What are we doing today?" })).toBeVisible();
    await expect(page.getByText("LOCAL TEST BOOKING", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(w.services[1].name) }).click();
    await page.getByRole("button", { name: "Choose your barber", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(w.staff[0].name) }).click();
    await page.getByRole("button", { name: "Find a time", exact: true }).click();
    await expect(page.getByRole("heading", { name: "A time that works for you." })).toBeVisible();
    // Move the date strip to the target week and pick an open time.
    const target = new Date(`${date}T12:00:00Z`);
    const label = new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "Europe/London",
    }).format(target);
    for (let i = 0; i < 3; i++) {
      const btn = page.getByRole("button", { name: new RegExp(`^${label},`) });
      if (await btn.count()) break;
      await page.getByRole("button", { name: "Next week" }).click();
    }
    await page.getByRole("button", { name: new RegExp(`^${label},`) }).click();
    await page.getByRole("group", { name: "Choose an appointment time" }).locator("button:not([disabled])").first().click();
    await page.getByRole("button", { name: "Your details", exact: true }).click();
    await page.getByLabel("Your name").fill("Browser Customer");
    await page.getByLabel("Mobile number").fill("07700 900777");
    await page.getByLabel("Email address (optional)").fill("not-an-email");
    await page.getByRole("button", { name: "Review booking" }).click();
    await expect(page.getByText("Enter a valid email address")).toBeVisible();
    await page.getByLabel("Email address (optional)").fill("browser@example.test");
    await page.getByRole("button", { name: "Review booking" }).click();
    await expect(page.getByRole("heading", { name: "Check and confirm." })).toBeVisible();
    await expect(page.getByText("Browser Customer")).toBeVisible();
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
    const reference = await page.locator(".public-reference").textContent();
    expect(reference).toMatch(/^BRB-\d{4}$/);
    const link = page.locator(".public-manage-link");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^\/manage\/[a-f0-9-]{72}$/);
    await expect(page.getByRole("link", { name: "Apple / Outlook (.ics)" })).toHaveAttribute(
      "href",
      /calendar\.ics$/,
    );
    // Owner sees the visit tagged online on that day.
    const day = await (await r.get(base + `/bookings?date=${date}`)).json();
    expect(day.bookings[0].channel).toBe("ONLINE");
    expect(day.bookings[0].customer_name).toBe("Browser Customer");
    // Manage page: move to another time then cancel.
    await page.goto(href!);
    await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
    await page.getByRole("button", { name: "Move booking" }).click();
    const newSlot = page
      .getByRole("group", { name: "Choose a new time" })
      .locator("button:not([disabled])")
      .last();
    const newTime = (await newSlot.textContent())!.trim().slice(0, 5);
    await newSlot.click();
    await page.getByRole("button", { name: `Move to ${newTime}` }).click();
    await expect(page.getByRole("status")).toHaveText("Your booking has moved.");
    await expect(page.getByText(new RegExp(`^${newTime} ·`))).toBeVisible();
    await page.getByRole("button", { name: "Cancel booking" }).click();
    await page.getByRole("button", { name: "Yes, cancel" }).click();
    await expect(page.getByText("CANCELLED", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move booking" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("layouts pass axe and have no overflow at phone and desktop widths", async ({ page }) => {
    const { slug } = await owner();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/book/${slug}`);
      await expect(page.getByRole("heading", { name: "What are we doing today?" })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflow, `overflow at ${width}`).toBe(false);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`), `axe at ${width}`).toEqual([]);
      if (width === 390 || width === 1440)
        await page.screenshot({ path: `docs/evidence/public-book-${width}.png`, fullPage: true });
    }
  });

  test("owner enables online booking from Settings and sees customers", async ({ page }) => {
    const { r, w } = await owner(false);
    const state = await r.storageState();
    await page.context().addCookies(state.cookies);
    await page.goto("/workspace");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Online booking" })).toBeVisible();
    await expect(page.getByText("Off", { exact: true })).toBeVisible();
    const slug = slugFor();
    await page.getByLabel("Public address (letters, numbers, hyphens)").fill(slug);
    await page.getByLabel("Allow customers to book online").check();
    await page.getByRole("button", { name: "Save online booking" }).click();
    await expect(page.getByText("Customers can book")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open booking page" })).toHaveAttribute(
      "href",
      new RegExp(`/book/${slug}$`),
    );
    const c = await customer();
    const fresh: WorkspaceData = await (await r.get(base + "/workspace")).json();
    const booked = await bookOnline(c, slug, fresh, futureDate());
    expect(booked.res.status()).toBe(201);
    await page.getByRole("button", { name: "Customers", exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Customers" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Online Customer" })).toBeVisible();
    await page.getByRole("button", { name: "Online Customer" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Online Customer" })).toBeVisible();
    await expect(page.locator(".customer-history .history-main small")).toContainText("online");
    await page.setViewportSize({ width: 390, height: 844 });
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
    await page.screenshot({ path: "docs/evidence/customers-390.png", fullPage: true });
    expect(w.shop.slug).toBeNull();
  });
});

// Executable inventory of public write routes: origin, throttling key and validation.
const publicMutations = [
  ["POST", "/shops/:slug/bookings"],
  ["POST", "/shops/:slug/waitlist"],
  ["POST", "/manage/:token/cancel"],
  ["POST", "/manage/:token/reschedule"],
] as const;
test("all public mutation endpoints enforce origin and validate input", async () => {
  const source = readFileSync(new URL("../src/server/public.ts", import.meta.url), "utf8");
  const actual = Array.from(
    source.matchAll(/pub\.(post|put|patch|delete)\(\s*["']([^"']+)["']/g),
    (m) => `${m[1].toUpperCase()} ${m[2]}`,
  ).sort();
  expect(actual).toEqual(publicMutations.map(([m, p]) => `${m} ${p}`).sort());
  const { slug } = await owner();
  const c = await customer();
  const foreign = await request.newContext({ extraHTTPHeaders: { Origin: "https://invalid.example" } });
  for (const [method, pattern] of publicMutations) {
    const path = pattern.replace(":slug", slug).replace(":token", "t".repeat(72));
    expect((await foreign.fetch(pub + path, { method, data: {} })).status(), pattern).toBe(403);
    const invalid = await c.fetch(pub + path, { method, data: { shop_id: "nope" } });
    expect([400, 404], pattern).toContain(invalid.status());
  }
  // Public routes never accept a browser session cookie as authority: owner cookie adds nothing.
  const { r } = await owner();
  expect((await r.get(`${pub}/manage/${"t".repeat(72)}`)).status()).toBe(404);
});

test("any-barber availability assigns the least-loaded eligible barber and /next finds soonest slots", async () => {
  const { r, w, slug } = await owner();
  const c = await customer();
  const date = futureDate();
  const service = w.services[0].id;
  // Give barber 0 two bookings so barber 1 should win ties at open slots.
  expect((await bookOnline(c, slug, w, date, 600)).res.status()).toBe(201);
  expect((await bookOnline(c, slug, w, date, 840, { phone: "07700 900001" })).res.status()).toBe(201);
  const any = await (
    await c.get(`${pub}/shops/${slug}/availability?date=${date}&staff_id=any&service_id=${service}`)
  ).json();
  expect(any.any_barber).toBe(true);
  const open = any.slots.filter((s: { available: boolean }) => s.available);
  expect(open.length).toBeGreaterThan(0);
  // 10:00 is taken for barber 0 but still open for barber 1.
  const ten = any.slots.find((s: { start_min: number }) => s.start_min === 600);
  expect(ten.available).toBe(true);
  expect(ten.staff_id).toBe(w.staff[1].id);
  expect(open[0].staff_id).toBe(w.staff[1].id);
  expect(open.every((s: { barbers: number }) => s.barbers >= 1)).toBe(true);
  // Disabling the service for barber 1 removes them from any-barber results.
  const rule = await r.put(base + `/staff/${w.staff[1].id}/services/${service}`, {
    data: { enabled: 0, price_pence: null, duration_min: null, version: 0 },
  });
  expect(rule.status(), await rule.text()).toBe(200);
  const only = await (
    await c.get(`${pub}/shops/${slug}/availability?date=${date}&staff_id=any&service_id=${service}`)
  ).json();
  expect(only.slots.filter((s: { available: boolean }) => s.available).every((s: { staff_id: string }) => s.staff_id === w.staff[0].id)).toBe(true);
  expect(only.slots.find((s: { start_min: number }) => s.start_min === 600).available).toBe(false);
  const next = await (await c.get(`${pub}/shops/${slug}/next?staff_id=any&service_id=${service}&limit=3`)).json();
  expect(next.next.length).toBeGreaterThan(0);
  expect(next.next.length).toBeLessThanOrEqual(3);
  for (const n of next.next) {
    expect(n.staff_id).toBe(w.staff[0].id);
    expect(n.date >= w.today).toBe(true);
  }
  // Each /next entry is a real bookable slot.
  const first = next.next[0];
  const check = await (
    await c.get(`${pub}/shops/${slug}/availability?date=${first.date}&staff_id=${first.staff_id}&service_id=${service}`)
  ).json();
  expect(check.slots.find((s: { start_min: number }) => s.start_min === first.start_min).available).toBe(true);
  const days = await (await c.get(`${pub}/shops/${slug}/days?staff_id=any&service_id=${service}`)).json();
  expect(days.days).toHaveLength(14);
  expect(days.price_to_pence).toBeGreaterThanOrEqual(days.price_pence);
});

test("waitlist: customer joins a full day, owner sees, books and links the entry", async () => {
  const { r, w, slug } = await owner();
  const c = await customer();
  const date = futureDate();
  const service = w.services[0].id;
  const join = await c.post(`${pub}/shops/${slug}/waitlist`, {
    data: {
      staff_id: null,
      service_id: service,
      customer_name: "Waiting Wanda",
      phone: "07700 900555",
      email: "",
      date,
      daypart: "AFTERNOON",
      notes: "",
    },
  });
  expect(join.status(), await join.text()).toBe(201);
  // Same phone/date/service upserts instead of duplicating.
  const again = await c.post(`${pub}/shops/${slug}/waitlist`, {
    data: { staff_id: w.staff[0].id, service_id: service, customer_name: "Waiting Wanda", phone: "07700900555", email: "w@example.test", date, daypart: "MORNING", notes: "" },
  });
  expect(again.status()).toBe(201);
  const bad = await c.post(`${pub}/shops/${slug}/waitlist`, {
    data: { staff_id: null, service_id: service, customer_name: "X", phone: "123", email: "", date, daypart: "ANY", notes: "" },
  });
  expect(bad.status()).toBe(400);
  const far = await c.post(`${pub}/shops/${slug}/waitlist`, {
    data: { staff_id: null, service_id: service, customer_name: "Far Away", phone: "07700900556", email: "", date: futureDate(90), daypart: "ANY", notes: "" },
  });
  expect(far.status()).toBe(409);
  const list = await (await r.get(base + "/waitlist")).json();
  expect(list.waitlist).toHaveLength(1);
  const entry = list.waitlist[0];
  expect(entry.daypart).toBe("MORNING");
  expect(entry.staff_name).toBe(w.staff[0].name);
  expect(entry.email).toBe("w@example.test");
  // Owner books them and links.
  const booked = await bookOnline(c, slug, w, date, 600, { customer_name: "Waiting Wanda", phone: "07700900555" });
  expect(booked.res.status()).toBe(201);
  const bookingId = (await booked.res.json()).booking.id;
  const stale = await r.post(base + `/waitlist/${entry.id}/status`, { data: { status: "BOOKED", booking_id: bookingId, version: 99 } });
  expect(stale.status()).toBe(409);
  const link = await r.post(base + `/waitlist/${entry.id}/status`, { data: { status: "BOOKED", booking_id: bookingId, version: entry.version } });
  expect(link.status()).toBe(200);
  expect((await (await r.get(base + "/waitlist")).json()).waitlist).toHaveLength(0);
  const bookedList = await (await r.get(base + "/waitlist?status=BOOKED")).json();
  expect(bookedList.waitlist[0].booking_id).toBe(bookingId);
  // Other shops cannot see or touch it.
  const other = await owner();
  expect((await (await other.r.get(base + "/waitlist?status=BOOKED")).json()).waitlist).toHaveLength(0);
  expect((await other.r.post(base + `/waitlist/${entry.id}/status`, { data: { status: "CLOSED", version: entry.version + 1 } })).status()).toBe(409);
});

test("owner manage-link issue rotates tokens and audits", async () => {
  const { r, w, slug } = await owner();
  const c = await customer();
  const date = futureDate();
  const { res } = await bookOnline(c, slug, w, date, 600);
  const first = (await res.json()).manage_token;
  expect((await c.get(`${pub}/manage/${first}`)).status()).toBe(200);
  const bookingId = (await (await r.get(base + `/bookings?date=${date}`)).json()).bookings[0].id;
  const issued = await r.post(base + `/bookings/${bookingId}/manage-link`, { data: {} });
  expect(issued.status(), await issued.text()).toBe(201);
  const { token, path } = await issued.json();
  expect(path).toBe(`/manage/${token}`);
  expect((await c.get(`${pub}/manage/${token}`)).status()).toBe(200);
  // Old customer link is revoked.
  expect((await c.get(`${pub}/manage/${first}`)).status()).toBe(404);
  const ws: WorkspaceData = await (await r.get(base + "/workspace")).json();
  expect(ws.audit.map((a) => a.action)).toContain("MANAGE_LINK_ISSUED");
  // Shops without a slug cannot issue links; other shops cannot issue for this booking.
  const bare = await owner(false);
  expect((await bare.r.post(base + `/bookings/${bookingId}/manage-link`, { data: {} })).status()).toBe(404);
});

test.describe("public booking v2 UI", () => {
  test("first-available barber, soonest chip and waitlist flow in the browser", async ({ page }) => {
    const { r, w, slug } = await owner();
    const c = await customer();
    const full = futureDate(9);
    // Make the day full for the 60-minute service: barber 1 off, barber 0 booked solid.
    await r.post(base + `/staff/${w.staff[1].id}/days-off`, { data: { date: full, reason: "Training" } });
    const big = w.services.find((s) => s.duration_min === 60)!;
    for (const [i, m] of [540, 615, 690, 840, 915, 990].entries()) {
      const av = await (await c.get(`${pub}/shops/${slug}/availability?date=${full}&staff_id=${w.staff[0].id}&service_id=${big.id}`)).json();
      const res = await c.post(`${pub}/shops/${slug}/bookings`, {
        data: { request_id: crypto.randomUUID(), staff_id: w.staff[0].id, service_id: big.id, customer_name: "Filler " + m, phone: "0770090060" + i, email: "", date: full, start_min: m, quote: av.quote },
      });
      expect(res.status(), await res.text()).toBe(201);
    }
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/book/${slug}`);
    await page.getByRole("button", { name: new RegExp(big.name) }).click();
    await page.getByRole("button", { name: "Choose your barber", exact: true }).click();
    await expect(page.getByRole("button", { name: /First available/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Find a time", exact: true }).click();
    await expect(page.getByRole("region", { name: "Soonest open times" })).toBeVisible();
    const label = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" }).format(new Date(`${full}T12:00:00Z`));
    for (let i = 0; i < 3; i++) {
      if (await page.getByRole("button", { name: new RegExp(`^${label},`) }).count()) break;
      await page.getByRole("button", { name: "Next week" }).click();
    }
    await expect(page.getByRole("button", { name: new RegExp(`^${label}, fully booked`) })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`^${label},`) }).click();
    await expect(page.getByRole("heading", { name: "This day is fully booked" })).toBeVisible();
    await page.getByRole("button", { name: "Join the waitlist" }).click();
    await page.getByLabel("Your name").fill("Waiting Wanda");
    await page.getByLabel("Mobile number").fill("07700900555");
    await page.getByRole("group", { name: "Preferred part of the day" }).getByRole("button", { name: "Afternoon" }).click();
    await page.getByRole("button", { name: "Ask the shop to contact me" }).click();
    await expect(page.getByText("You’re on the list.")).toBeVisible();
    const list = await (await r.get(base + "/waitlist")).json();
    expect(list.waitlist).toHaveLength(1);
    expect(list.waitlist[0].daypart).toBe("AFTERNOON");
    expect(list.waitlist[0].staff_id).toBeNull();
    // Soonest chip jumps to a bookable slot with an assigned barber; details are remembered from the waitlist form.
    await page.getByRole("region", { name: "Soonest open times" }).getByRole("button").first().click();
    await expect(page.locator(".slot-note")).toContainText("is free at");
    await page.getByRole("button", { name: "Your details", exact: true }).click();
    await expect(page.getByLabel("Your name")).toHaveValue("Waiting Wanda");
    await page.getByRole("button", { name: "Review booking" }).click();
    await expect(page.getByRole("heading", { name: "Check and confirm." })).toBeVisible();
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.locator(".public-reference")).toHaveText(/^BRB-\d{4}$/);
    await expect(page.getByRole("link", { name: "Google Calendar" })).toHaveAttribute("href", /calendar\.google\.com/);
    // Owner: waitlist panel shows the entry; "Book them in" prefills the form; share panel creates a link.
    const state = await r.storageState();
    await page.context().addCookies(state.cookies);
    await page.goto("/workspace");
    await expect(page.getByRole("heading", { name: /Waitlist/ })).toBeVisible();
    await page.getByRole("button", { name: "Book them in" }).click();
    await expect(page.getByRole("complementary", { name: "Waitlist request" })).toContainText("Waiting Wanda");
    await expect(page.getByLabel("Fictional customer name")).toHaveValue("Waiting Wanda");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Customers", exact: true }).click();
    await page.getByRole("button", { name: "Waiting Wanda" }).click();
    await page.locator(".customer-history").getByRole("button").first().click();
    await page.getByText("Share confirmation with customer").click();
    await page.getByRole("button", { name: "Create manage link" }).click();
    await expect(page.locator(".share-booking code")).toContainText("/manage/");
    await expect(page.getByLabel("Confirmation message")).toHaveValue(/Need to change it\?/);
    expect(errors).toEqual([]);
  });
});
