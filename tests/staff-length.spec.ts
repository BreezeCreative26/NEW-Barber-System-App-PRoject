// Staff can book a different appointment length than the menu (15-minute steps, shorter or longer).
// The calendar blocks the chosen length; the customer is still shown and told the service's normal length.
// Plus the booking form: a clicked slot shows that time with one dropdown to change it, no slot grid.
import { test, expect } from "@playwright/test";
import { base, newShop } from "./shop";
import { openFixtureShop, origin } from "./fixture";

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
  const select = page.getByLabel("Available start time");
  await expect(select.locator("option").nth(1)).toBeAttached();
  // Starts at the first opening-hours time, not midnight; earlier times are grouped, with no reason text.
  const first = Number(await select.locator("option").nth(1).getAttribute("value"));
  expect(first).toBeGreaterThanOrEqual(8 * 60);
  const labels = await select.locator("option").allTextContents();
  expect(labels.slice(1).every((t) => /^\d\d:\d\d$/.test(t.trim()))).toBe(true);
});

test("booking form: a clicked out-of-hours slot is used the same way, with no label or warning", async ({ page }) => {
  await openFixtureShop(page);
  await futureWeekday(page);
  const cell = page.getByRole("button", { name: /^07:00, .+ — add booking$/ }).first();
  await cell.click();
  await expect(page.getByLabel("Available start time")).toHaveValue("420");
  await expect(page.getByTestId("booking-chosen-time")).toContainText("07:00");
  await expect(page.getByTestId("booking-chosen-time")).not.toContainText(/outside/i);
  await expect(page.getByTestId("override-notice")).toHaveCount(0);
  await expect(page.locator(".slot-grid")).toHaveCount(0);
});

test("time list starts at the clicked time and hides only times that overlap an appointment", async ({ page }) => {
  await openFixtureShop(page);
  const date = await futureWeekday(page);
  const w = (await (await page.request.get(base + "/workspace")).json()) as Omit<W, "staff"> & { staff: { id: string; name: string; active: number }[] };
  const barber = w.staff.find((s) => s.active)!;
  const svc = w.services.find((s) => s.duration_min === 30) || w.services[0];
  // Put an appointment at 12:00 for this barber.
  const a = await (await page.request.get(base + `/availability?date=${date}&staff_id=${barber.id}&service_id=${svc.id}`)).json();
  const made = await page.request.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: barber.id, service_id: svc.id, customer_name: "Busy Noon", phone: "07700 900611", notes: "", date, start_min: 720, source: "TEST_BOOKING", quote: a.quote, notify: false, force: true } });
  expect(made.status(), await made.text()).toBe(201);
  await page.reload();
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  await page.getByRole("button", { name: new RegExp(`^11:00, ${barber.name} — add booking$`) }).click();
  const select = page.getByLabel("Available start time");
  await expect(select).toHaveValue("660");
  const values = await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean).map(Number));
  // Starts at the clicked time (11:00); earlier times come after, in their own group.
  expect(values[0]).toBe(660);
  await expect(select.locator('optgroup[label="Earlier"]')).toHaveCount(1);
  // Times that would overlap the 12:00 appointment are gone; the rest of the day is there.
  for (const m of [720, 735]) expect(values).not.toContain(m);
  expect(values).toContain(780);
  // No reason text anywhere in the list.
  const labels = await select.locator("option").allTextContents();
  expect(labels.slice(1).every((t) => /^\d\d:\d\d$/.test(t.trim()))).toBe(true);
});
