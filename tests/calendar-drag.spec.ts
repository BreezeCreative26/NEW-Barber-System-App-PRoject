import { test, expect, type Page } from "@playwright/test";
import { openFixtureShop, base, origin } from "./fixture";

// Phase 1 of the Fresha-grade calendar: pointer drag with 15-minute snap and a live time label,
// hover time, greyed-but-clickable cells, deliberate double-booking, overlap lanes.

type W = { today: string; staff: { id: string; name: string; active: number }[]; services: { id: string; name: string }[] };

async function freeSlot(page: Page, w: W, staffId: string, serviceId: string, fromDay = 1) {
  for (let i = fromDay; i < fromDay + 10; i++) {
    const d = new Date(w.today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const avail = await (await page.request.get(base + `/availability?date=${date}&staff_id=${staffId}&service_id=${serviceId}`)).json();
    const free = avail.slots.filter((s: { reason?: string }) => !s.reason);
    if (free.length >= 6) return { date, slots: avail.slots as { start_min: number; reason: string }[], free: free as { start_min: number }[], quote: avail.quote };
  }
  throw new Error("no free day");
}

async function book(page: Page, staffId: string, serviceId: string, date: string, start: number, quote: unknown, name: string, force = false) {
  const r = await page.request.post(base + "/bookings", {
    headers: { Origin: origin },
    data: { request_id: crypto.randomUUID(), staff_id: staffId, service_id: serviceId, customer_name: name, phone: "07700 900444", notes: "", date, start_min: start, source: "TEST_BOOKING", quote, ...(force ? { force: true } : {}) },
  });
  return { status: r.status(), body: await r.json() };
}

test("API: shop can double-book and book outside hours with force; customers cannot; past time never", async ({ page }) => {
  await openFixtureShop(page);
  const w = (await (await page.request.get(base + "/workspace")).json()) as W;
  const jay = w.staff.find((s) => s.name === "Jay Carter")!;
  const svc = w.services[0];
  const { date, slots, free, quote } = await freeSlot(page, w, jay.id, svc.id);
  const start = free[1].start_min;
  const a = await book(page, jay.id, svc.id, date, start, quote, "First In");
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  // Same slot again: refused without force, accepted with it.
  const clash = await book(page, jay.id, svc.id, date, start, quote, "Clash Client");
  expect(clash.status).toBe(409);
  expect(clash.body.error).toBe("slot_taken");
  const forced = await book(page, jay.id, svc.id, date, start, quote, "Clash Client", true);
  expect(forced.status, JSON.stringify(forced.body)).toBe(201);
  expect(forced.body.booking.start_min).toBe(start);
  // Outside hours with force is allowed too.
  const outside = slots.find((s) => s.reason === "Outside working hours");
  if (outside) {
    const o = await book(page, jay.id, svc.id, date, outside.start_min, quote, "Early Bird", true);
    expect(o.status, JSON.stringify(o.body)).toBe(201);
  }
  // Past time is never overridable.
  const past = await book(page, jay.id, svc.id, w.today, 0, quote, "Time Traveller", true);
  expect(past.status).toBe(409);
  // Reschedule onto the occupied slot: refused, then forced, and the audit says so.
  const b = forced.body.booking;
  const dur = b.duration_min as number;
  const later = free.find((s) => s.start_min >= start + dur + 30)!;
  const move = await page.request.post(base + `/bookings/${b.id}/reschedule`, { headers: { Origin: origin }, data: { date, start_min: later.start_min, staff_id: jay.id, reason: "Calendar test move", version: b.version } });
  expect(move.status(), await move.text()).toBe(200);
  const back = await page.request.post(base + `/bookings/${b.id}/reschedule`, { headers: { Origin: origin }, data: { date, start_min: start, staff_id: jay.id, reason: "Back onto the clash", version: (await move.json()).booking.version } });
  expect(back.status()).toBe(409);
  const backForced = await page.request.post(base + `/bookings/${b.id}/reschedule`, { headers: { Origin: origin }, data: { date, start_min: start, staff_id: jay.id, reason: "Back onto the clash", version: (await move.json()).booking.version, force: true } });
  expect(backForced.status(), await backForced.text()).toBe(200);
  const tl = await (await page.request.get(base + `/bookings/${b.id}/timeline`)).json();
  expect(JSON.stringify(tl)).toContain("overrode: Slot taken");
  // Public booking never gets to force.
  const pub = await page.request.post(origin + `/api/public/shops/${(await (await page.request.get(base + "/workspace")).json()).shop.slug}/bookings`, { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: jay.id, service_id: svc.id, customer_name: "Sneaky", phone: "07700 900555", email: "", date, start_min: start, quote, force: true } });
  expect([400, 404, 409]).toContain(pub.status());
});

test("browser: overlapping appointments share the column; pointer drag snaps to 15 min with a live time label; hover shows the time; greyed cells are clickable", async ({ page }) => {
  test.setTimeout(120000);
  await openFixtureShop(page);
  const w = (await (await page.request.get(base + "/workspace")).json()) as W;
  const jay = w.staff.find((s) => s.name === "Jay Carter")!;
  const svc = w.services[0];
  const { date, free, quote } = await freeSlot(page, w, jay.id, svc.id);
  const start = free[1].start_min;
  const a = await book(page, jay.id, svc.id, date, start, quote, "Lane One");
  const b = await book(page, jay.id, svc.id, date, start, quote, "Lane Two", true);
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);

  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  const one = page.getByRole("button", { name: /Lane One/ });
  const two = page.getByRole("button", { name: /Lane Two/ });
  await expect(one).toBeVisible();
  await expect(two).toBeVisible();
  // Overlap lanes: both carry data-lanes=2 and don't share the same left edge.
  await expect(one).toHaveAttribute("data-lanes", "2");
  await expect(two).toHaveAttribute("data-lanes", "2");
  const [r1, r2] = [await one.boundingBox(), await two.boundingBox()];
  expect(Math.abs(r1!.x - r2!.x)).toBeGreaterThan(20);
  expect(r1!.width).toBeLessThan(r2!.width * 1.5 + 1);

  // Hover time label follows the pointer in the column.
  const column = page.locator(".barber-column").nth(w.staff.filter((s) => s.active).findIndex((s) => s.id === jay.id));
  const cb = (await column.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + 44 * 3 + 10);
  await expect(page.getByTestId("slot-hover")).toBeVisible();
  await expect(page.getByTestId("slot-hover")).toContainText(/\d\d:\d\d/);

  // Drag Lane One down three slots. Steps in between produce the ghost with its snapped time.
  const step = 44;
  const box = (await one.boundingBox())!;
  const grabX = box.x + box.width / 2, grabY = box.y + 8;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX, grabY + 12); // arm
  await page.mouse.move(grabX, grabY + step * 1.5);
  const ghost = page.getByTestId("drop-ghost");
  await expect(ghost).toBeVisible();
  const target = start + 45;
  const hh = String(Math.floor(target / 60)).padStart(2, "0"), mm = String(target % 60).padStart(2, "0");
  await page.mouse.move(grabX, grabY + step * 3 + 4);
  await expect(ghost.locator(".ghost-time")).toHaveText(`${hh}:${mm}`);
  page.once("dialog", (d) => d.accept());
  await page.mouse.up();
  await expect(page.getByRole("button", { name: /Lane One/ })).toContainText(`${hh}:${mm}`);
  const fresh = await (await page.request.get(base + `/bookings/${a.body.booking.id}`)).json();
  expect(fresh.booking.start_min).toBe(target);

  // Greyed-but-clickable: an outside-hours cell opens the booking form flagged as an override.
  const soft = page.locator(".timetable-slot.blocked.soft").first();
  if (await soft.count()) {
    await soft.scrollIntoViewIfNeeded();
    await soft.click({ force: true });
    await expect(page.getByTestId("override-notice")).toBeVisible();
    await expect(page.getByTestId("override-notice")).toContainText(/Outside working hours|Lunch break|Barber off duty|Double-booking/);
  }
});
