import { test, expect, type Page } from "@playwright/test";
import { openFixtureShop, base, origin } from "./fixture";

// Phase 4: drag the bottom edge to change an appointment's length (15-min snap, live end-time
// label), one-step Undo beside the notice, deposit / returning-customer icons on cards.

type W = { today: string; staff: { id: string; name: string; active: number }[]; services: { id: string; name: string; duration_min: number }[] };

async function freeDay(page: Page, w: W, staffId: string, serviceId: string) {
  for (let i = 1; i < 12; i++) {
    const d = new Date(w.today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const avail = await (await page.request.get(base + `/availability?date=${date}&staff_id=${staffId}&service_id=${serviceId}`)).json();
    const free = avail.slots.filter((s: { reason?: string }) => !s.reason);
    if (free.length >= 8) return { date, free: free as { start_min: number }[], quote: avail.quote };
  }
  throw new Error("no free day");
}

test("browser: bottom-edge resize snaps to 15 min, saves via items, Undo restores; move offers Undo too", async ({ page }) => {
  test.setTimeout(120000);
  await openFixtureShop(page);
  const w = (await (await page.request.get(base + "/workspace")).json()) as W;
  const jay = w.staff.find((s) => s.name === "Jay Carter")!;
  const svc = w.services.find((s) => s.duration_min === 30) ?? w.services[0];
  const { date, free, quote } = await freeDay(page, w, jay.id, svc.id);
  const start = free[1].start_min;
  const r = await page.request.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: jay.id, service_id: svc.id, customer_name: "Stretch Client", phone: "07700 900333", notes: "", date, start_min: start, source: "TEST_BOOKING", quote } });
  expect(r.status(), await r.text()).toBe(201);
  const booking = (await r.json()).booking;
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  const card = page.getByRole("button", { name: /Stretch Client/ });
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  const handle = card.getByTestId("resize-handle");
  const hb = (await handle.boundingBox())!;
  // Pixels per 15-minute cell follow the user's density preset; read it off the board.
  const step = parseFloat(await page.locator(".calendar-board").evaluate((el) => getComputedStyle(el).getPropertyValue("--step")));
  const x = hb.x + hb.width / 2, y = hb.y + hb.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + step); // +15
  await expect(page.getByTestId("resize-label")).toBeVisible();
  await page.mouse.move(x, y + step * 2 + 3); // +30
  const target = booking.duration_min + 30;
  await expect(page.getByTestId("resize-label")).toContainText(`${target} min`);
  await page.mouse.up();
  await expect(page.getByRole("status").filter({ hasText: `is now ${target} min` })).toBeVisible();
  const grown = (await (await page.request.get(base + `/bookings/${booking.id}`)).json()).booking;
  expect(grown.duration_min).toBe(target);
  expect(grown.price_pence).toBe(booking.price_pence); // length only, price untouched
  // Undo puts the original length back.
  await page.getByTestId("undo").click();
  await expect(page.getByRole("status").filter({ hasText: /Undone/ })).toBeVisible();
  const restored = (await (await page.request.get(base + `/bookings/${booking.id}`)).json()).booking;
  expect(restored.duration_min).toBe(booking.duration_min);
  // Move (drag body) then Undo.
  const cb = (await card.boundingBox())!;
  const gx = cb.x + cb.width / 2, gy = cb.y + 8;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx, gy + 12);
  await page.mouse.move(gx, gy + step * 4 + 4);
  page.once("dialog", (d) => d.accept());
  await page.mouse.up();
  await expect(page.getByRole("status").filter({ hasText: /Moved to/ })).toBeVisible();
  const moved = (await (await page.request.get(base + `/bookings/${booking.id}`)).json()).booking;
  expect(moved.start_min).toBe(start + 60);
  await page.getByTestId("undo").click();
  await expect(page.getByRole("status").filter({ hasText: /Undone/ })).toBeVisible();
  const back = (await (await page.request.get(base + `/bookings/${booking.id}`)).json()).booking;
  expect(back.start_min).toBe(start);
  // Card icons: a second visit for the same customer marks both as returning.
  const again = await page.request.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: jay.id, service_id: svc.id, customer_name: "Stretch Client", phone: "07700 900333", notes: "", date, start_min: free[6].start_min, source: "TEST_BOOKING", quote, customer_id: back.customer_id } });
  expect(again.status(), await again.text()).toBe(201);
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  await expect(page.getByRole("button", { name: /Stretch Client/ }).first().locator(".block-icons")).toHaveAttribute("aria-label", /Returning customer/);
});
