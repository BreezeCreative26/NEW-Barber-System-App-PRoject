// Staff can book a different appointment length than the menu (15-minute steps, shorter or longer).
// The calendar blocks the chosen length; the customer is still shown and told the service's normal length.
// Plus the booking form: a clicked slot shows that time with one dropdown to change it, no slot grid.
import { test, expect } from "@playwright/test";
import { base, newShop } from "./shop";
import { openFixtureShop } from "./fixture";

type W = { today: string; staff: { id: string; active: number }[]; services: { id: string; name: string; duration_min: number }[] };

async function setup(name: string) {
  const { r } = await newShop(name);
  const w = (await (await r.get(base + "/workspace")).json()) as W;
  const staff = w.staff.find((s) => s.active)!;
  const svc = w.services.find((s) => s.name === "Signature cut")!; // 30 min on the menu
  for (let i = 1; i < 21; i++) {
    const d = new Date(w.today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const a = await (await r.get(base + `/availability?date=${date}&staff_id=${staff.id}&service_id=${svc.id}&duration_min=60`)).json();
    const slot = a.slots.find((s: { reason?: string; outside?: boolean }) => !s.reason && !s.outside);
    if (slot) return { r, staff, svc, date, slot, a };
  }
  throw new Error("no free day");
}

test("staff book longer than the menu: calendar blocks it, customer keeps the normal length", async () => {
  const { r, staff, svc, date, slot, a } = await setup("Length Longer");
  expect(a.duration_min).toBe(60);
  expect(a.customer_duration_min).toBe(30);
  const res = await r.post(base + "/bookings", {
    data: { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: svc.id, customer_name: "Long Cut", phone: "07700 900511", notes: "", date, start_min: slot.start_min, source: "TEST_BOOKING", quote: a.quote, notify: false, duration_min: 60 },
  });
  expect(res.status(), await res.text()).toBe(201);
  const b = (await res.json()).booking;
  expect(b.duration_min).toBe(60);
  expect(b.end_at - b.start_at).toBe(60 * 60000);
  expect(b.customer_duration_min).toBe(30);
  expect(JSON.parse(b.items_json)[0].duration_min).toBe(30); // the menu snapshot stays honest
  // The next 60 minutes are really taken for this barber.
  const after = await (await r.get(base + `/availability?date=${date}&staff_id=${staff.id}&service_id=${svc.id}`)).json();
  expect(after.slots.find((s: { start_min: number }) => s.start_min === slot.start_min + 45).reason).toBeTruthy();
});

test("staff book shorter than the menu; lengths must be 15-minute steps", async () => {
  const { r, staff, svc, date, slot, a } = await setup("Length Shorter");
  const bad = await r.post(base + "/bookings", {
    data: { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: svc.id, customer_name: "Odd Length", phone: "07700 900512", notes: "", date, start_min: slot.start_min, source: "TEST_BOOKING", quote: a.quote, notify: false, duration_min: 20 },
  });
  expect(bad.status()).toBe(400);
  const res = await r.post(base + "/bookings", {
    data: { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: svc.id, customer_name: "Quick Trim", phone: "07700 900513", notes: "", date, start_min: slot.start_min, source: "TEST_BOOKING", quote: a.quote, notify: false, duration_min: 15 },
  });
  expect(res.status(), await res.text()).toBe(201);
  const b = (await res.json()).booking;
  expect(b.duration_min).toBe(15);
  expect(b.customer_duration_min).toBe(30);
});

test("the normal length stores nothing extra", async () => {
  const { r, staff, svc, date, slot, a } = await setup("Length Normal");
  const res = await r.post(base + "/bookings", {
    data: { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: svc.id, customer_name: "Normal Cut", phone: "07700 900514", notes: "", date, start_min: slot.start_min, source: "TEST_BOOKING", quote: a.quote, notify: false },
  });
  expect(res.status(), await res.text()).toBe(201);
  const b = (await res.json()).booking;
  expect(b.duration_min).toBe(30);
  expect(b.customer_duration_min).toBeNull();
});

// A future Tuesday–Friday, so the fixture shop is open and the times haven't passed.
async function futureWeekday(page: import("@playwright/test").Page) {
  const w = (await (await page.request.get(base + "/workspace")).json()) as W;
  const d = new Date(w.today + "T12:00:00Z");
  do d.setUTCDate(d.getUTCDate() + 1); while (![2, 3, 4, 5].includes(d.getUTCDay()));
  const date = d.toISOString().slice(0, 10);
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  return date;
}

test("booking form: a clicked slot shows that time and one dropdown, with a staff-only length", async ({ page }) => {
  await openFixtureShop(page);
  await futureWeekday(page);
  const cell = page.getByRole("button", { name: /^11:00, .+ — add booking$/ }).first();
  await cell.click();
  await expect(page.getByLabel("Available start time")).toHaveValue("660");
  await expect(page.getByTestId("booking-chosen-time")).toContainText("11:00");
  await expect(page.getByTestId("booking-chosen-time")).toBeVisible();
  await expect(page.locator(".slot-grid")).toHaveCount(0); // no wall of time buttons
  await expect(page.locator(".booking-day-strip")).toHaveCount(0); // the date came from the calendar
  await expect(page.getByLabel("Available start time")).not.toHaveValue("");
  const length = page.getByTestId("booking-length").getByRole("combobox");
  await expect(length).toBeVisible();
  await expect(length.locator("option").first()).toContainText("(normal)");
  const values = await length.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean).map(Number));
  expect(values.every((v) => v % 15 === 0)).toBe(true);
  // Picking a longer length keeps the chosen time (re-checked) and says the customer isn't affected.
  const before = await page.getByLabel("Available start time").inputValue();
  await length.selectOption({ index: 2 });
  await expect(page.getByTestId("booking-length")).toContainText("customer is still told");
  await expect(page.getByLabel("Available start time")).toHaveValue(before);
});

test("booking form opened without a slot: one dropdown, out-of-hours grouped at the bottom", async ({ page }) => {
  await openFixtureShop(page);
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  await expect(page.getByLabel("Available start time")).toBeVisible();
  await expect(page.locator(".slot-grid")).toHaveCount(0);
  await expect(page.locator('optgroup[label="Opening hours"]')).toHaveCount(1);
});

test("booking form: a clicked out-of-hours slot is used the same way, labelled outside normal hours", async ({ page }) => {
  await openFixtureShop(page);
  await futureWeekday(page);
  const cell = page.getByRole("button", { name: /^07:00, .+ — add booking$/ }).first();
  await cell.click();
  await expect(page.getByLabel("Available start time")).toHaveValue("420");
  await expect(page.getByTestId("booking-chosen-time")).toContainText("07:00");
  await expect(page.getByTestId("booking-chosen-time")).toContainText("Outside normal hours");
  await expect(page.locator(".slot-grid")).toHaveCount(0);
});
