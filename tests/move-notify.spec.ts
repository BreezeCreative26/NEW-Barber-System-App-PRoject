import { test, expect, type Page } from "@playwright/test";
import { openFixtureShop, base, origin } from "./fixture";

// Customer notifications when the shop moves an appointment (drag, move mode, Reschedule form).
// The message is held for 30s so Undo or a second move can replace it; the customer only hears
// about the final time, with the time they last knew.

type W = { today: string; staff: { id: string; name: string }[]; services: { id: string; name: string }[] };
type N = { id: string; template: string; status: string; status_note: string; body: string; channel: string; related_id: string };

async function setup(page: Page) {
  await openFixtureShop(page);
  const w = (await (await page.request.get(base + "/workspace")).json()) as W;
  const jay = w.staff.find((s) => s.name === "Jay Carter")!;
  const svc = w.services[0];
  for (let i = 2; i < 14; i++) {
    const d = new Date(w.today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const avail = await (await page.request.get(base + `/availability?date=${date}&staff_id=${jay.id}&service_id=${svc.id}`)).json();
    const free = (avail.slots as { start_min: number; reason?: string }[]).filter((s) => !s.reason);
    if (free.length < 12) continue;
    const r = await page.request.post(base + "/bookings", {
      headers: { Origin: origin },
      data: { request_id: crypto.randomUUID(), staff_id: jay.id, service_id: svc.id, customer_name: "Nina Notify", phone: "07700 900555", notes: "", date, start_min: free[0].start_min, source: "TEST_BOOKING", quote: avail.quote },
    });
    expect(r.status(), await r.text()).toBe(201);
    return { jay, date, free, booking: (await r.json()).booking as { id: string; version: number; start_min: number } };
  }
  throw new Error("no free day");
}
const moves = async (page: Page, id: string) =>
  ((await (await page.request.get(base + "/notifications?limit=200")).json()).notifications as N[]).filter((n) => n.related_id === id && n.template === "booking_moved");
async function move(page: Page, id: string, date: string, start: number, staff: string, notify: boolean) {
  const cur = (await (await page.request.get(base + `/bookings/${id}`)).json()).booking;
  const r = await page.request.post(base + `/bookings/${id}/reschedule`, { headers: { Origin: origin }, data: { date, start_min: start, staff_id: staff, reason: "Notify test move", version: cur.version, notify } });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as { notify: { channels: string[]; send_at: number } | null };
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

test("API: move notice is held, replaced by a later move, dropped when moved back, and off unless asked", async ({ page }) => {
  const { jay, date, free, booking } = await setup(page);
  const a = booking.start_min, b = free[4].start_min, c = free[8].start_min;
  // notify:false (the default for API callers) queues nothing.
  const quiet = await move(page, booking.id, date, b, jay.id, false);
  expect(quiet.notify).toBeNull();
  expect(await moves(page, booking.id)).toHaveLength(0);
  // Back to A quietly, then a real notified move A → B: one held text, noting the old time.
  await move(page, booking.id, date, a, jay.id, false);
  const first = await move(page, booking.id, date, b, jay.id, true);
  expect(first.notify?.channels).toContain("SMS");
  expect(first.notify!.send_at).toBeGreaterThan(Date.now() + 20_000);
  let rows = await moves(page, booking.id);
  expect(rows.filter((r) => r.status === "QUEUED")).toHaveLength(1);
  expect(rows[0].status_note).toContain(`was`);
  expect(rows[0].status_note).toContain(hhmm(a));
  expect(rows[0].body).toContain(hhmm(b));
  // Flushing during the hold sends nothing.
  const early = await (await page.request.post(base + `/bookings/${booking.id}/notify-flush`, { headers: { Origin: origin }, data: {} })).json();
  expect(early.sent).toBe(0);
  // A second move inside the hold replaces it; the customer still hears "was A".
  await move(page, booking.id, date, c, jay.id, true);
  rows = await moves(page, booking.id);
  expect(rows.filter((r) => r.status === "SKIPPED")).toHaveLength(1);
  const live = rows.filter((r) => r.status === "QUEUED");
  expect(live).toHaveLength(1);
  expect(live[0].body).toContain(hhmm(c));
  expect(live[0].status_note).toContain(hhmm(a));
  // Moving straight back to A: the pending message is dropped and nothing new is queued.
  const back = await move(page, booking.id, date, a, jay.id, true);
  expect(back.notify).toBeNull();
  rows = await moves(page, booking.id);
  expect(rows.filter((r) => r.status === "QUEUED")).toHaveLength(0);
  expect(rows.filter((r) => r.status === "SKIPPED")).toHaveLength(2);
});

test("API: a held move notice is delivered once the hold ends", async ({ page }) => {
  test.slow();
  const { jay, date, free, booking } = await setup(page);
  await move(page, booking.id, date, free[5].start_min, jay.id, true);
  await page.waitForTimeout(31_000);
  const r = await (await page.request.post(base + `/bookings/${booking.id}/notify-flush`, { headers: { Origin: origin }, data: {} })).json();
  expect(r.sent).toBeGreaterThanOrEqual(1);
  const rows = await moves(page, booking.id);
  expect(rows.some((x) => x.status === "SENT" && x.channel === "SMS")).toBe(true);
});

test("calendar: moving offers to text the customer, remembers the choice, and Undo inside the hold cancels it", async ({ page }) => {
  const { date, booking } = await setup(page);
  await page.getByLabel("Appointment date").fill(date);
  const step = parseFloat(await page.locator(".calendar-board").evaluate((el) => getComputedStyle(el).getPropertyValue("--step")));
  const card = page.locator(".calendar-event", { hasText: "Nina Notify" }).first();
  await card.scrollIntoViewIfNeeded();
  const bb = (await card.boundingBox())!;
  await page.mouse.move(bb.x + bb.width / 2, bb.y + 8);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + 20);
  await page.mouse.move(bb.x + bb.width / 2, bb.y + 8 + step * 4 + 4, { steps: 10 });
  await page.mouse.up();
  const check = page.getByTestId("confirm-check");
  await expect(check).toContainText("Text Nina the new time");
  await expect(check.locator("input")).toBeChecked();
  await page.getByTestId("confirm-accept").click();
  await expect(page.getByRole("status").filter({ hasText: /Nina gets a text in 30 seconds/ })).toBeVisible();
  expect((await moves(page, booking.id)).filter((r) => r.status === "QUEUED")).toHaveLength(1);
  await page.getByTestId("undo").click();
  await expect(page.getByRole("status").filter({ hasText: /Undone/ })).toBeVisible();
  const rows = await moves(page, booking.id);
  expect(rows.filter((r) => r.status === "QUEUED")).toHaveLength(0);
  expect(rows.filter((r) => r.status === "SKIPPED")).toHaveLength(1);
  // Untick: the choice sticks for next time and nothing is queued.
  const card2 = page.locator(".calendar-event", { hasText: "Nina Notify" }).first();
  const b2 = (await card2.boundingBox())!;
  await page.mouse.move(b2.x + b2.width / 2, b2.y + 8);
  await page.mouse.down();
  await page.mouse.move(b2.x + b2.width / 2, b2.y + 20);
  await page.mouse.move(b2.x + b2.width / 2, b2.y + 8 + step * 4 + 4, { steps: 10 });
  await page.mouse.up();
  await page.getByTestId("confirm-check").locator("input").uncheck();
  await page.getByTestId("confirm-accept").click();
  await expect(page.getByRole("status").filter({ hasText: /Moved to/ })).toBeVisible();
  expect((await moves(page, booking.id)).filter((r) => r.status === "QUEUED")).toHaveLength(0);
  expect(await page.evaluate(() => localStorage.getItem("foliyo.notifyMoves"))).toBe("0");
});
