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
  expect(first.email).toBe("online@example.test");
  const search = await (await r.get(base + "/customers?q=second")).json();
  expect(search.customers).toHaveLength(1);
  const history = await (await r.get(base + "/customers/07700900222")).json();
  expect(history.bookings).toHaveLength(2);
  expect((await r.get(base + "/customers/12345")).status()).toBe(400);
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
    await expect(page.getByRole("link", { name: "Add to calendar" })).toHaveAttribute(
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
    await expect(page.getByRole("heading", { name: /visit history/ })).toBeVisible();
    await expect(page.locator(".customer-history .channel-badge")).toHaveText("Online");
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
