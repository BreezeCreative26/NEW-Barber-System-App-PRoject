// Booking from the timetable: the time clicked stays the time when the service (or extras/length)
// changes. Only if the new service can't fit there is it cleared, with a message naming the time.
import { test, expect } from "@playwright/test";
import { base } from "./shop";
import { openFixtureShop, origin } from "./fixture";

type W = { today: string; staff: { id: string; name: string; active: number }[]; services: { id: string; name: string; duration_min: number; active: number }[]; service_rules: unknown };
async function setup(page: import("@playwright/test").Page) {
  await openFixtureShop(page);
  const w = (await (await page.request.get(base + "/workspace")).json()) as W;
  const d = new Date(w.today + "T12:00:00Z");
  do d.setUTCDate(d.getUTCDate() + 1); while (![2, 3, 4, 5].includes(d.getUTCDay()));
  const date = d.toISOString().slice(0, 10);
  const barber = w.staff.find((s) => s.active)!;
  const offered = async (id: string) => (await (await page.request.get(base + `/availability?date=${date}&staff_id=${barber.id}&service_id=${id}`)).json()).slots?.length > 0;
  const svcs: W["services"] = [];
  for (const s of w.services.filter((x) => x.active)) if (await offered(s.id)) svcs.push(s);
  return { w, date, barber, svcs };
}

test("the clicked time stays when a different service is chosen", async ({ page }) => {
  const { date, barber, svcs } = await setup(page);
  await page.reload();
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  await page.getByRole("button", { name: new RegExp(`^11:00, ${barber.name} — add booking$`) }).click();
  const select = page.getByLabel("Available start time");
  await expect(select).toHaveValue("660");
  const service = page.getByLabel("Service", { exact: true });
  const current = await service.inputValue();
  // Switch through two other services: 11:00 stays every time.
  for (const s of svcs.filter((x) => x.id !== current).slice(0, 2)) {
    await service.selectOption(s.id);
    await expect(select).toHaveValue("660");
    await expect(page.getByTestId("booking-chosen-time")).toContainText("11:00");
  }
});

test("if the new service no longer fits at the clicked time, it says so and asks for another time", async ({ page }) => {
  const { date, barber, svcs } = await setup(page);
  const short = svcs.find((s) => s.duration_min <= 30)!;
  const long = svcs.find((s) => s.duration_min >= 45)!;
  expect(short && long, "fixture has a short and a long service").toBeTruthy();
  // Something already booked at 11:30 for this barber: 11:00 fits a 30-min service, not a 45+.
  const a = await (await page.request.get(base + `/availability?date=${date}&staff_id=${barber.id}&service_id=${short.id}`)).json();
  const made = await page.request.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: barber.id, service_id: short.id, customer_name: "Busy Half Eleven", phone: "07700 900612", notes: "", date, start_min: 690, source: "TEST_BOOKING", quote: a.quote, notify: false, force: true } });
  expect(made.status(), await made.text()).toBe(201);
  await page.reload();
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  await page.getByRole("button", { name: new RegExp(`^11:00, ${barber.name} — add booking$`) }).click();
  const service = page.getByLabel("Service", { exact: true });
  await service.selectOption(short.id);
  const select = page.getByLabel("Available start time");
  await expect(select).toHaveValue("660");
  await service.selectOption(long.id);
  await expect(page.getByText(/11:00 overlaps another appointment/)).toBeVisible();
  await expect(select).toHaveValue("");
  // Picking another time clears the message.
  const other = await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean)[0]);
  await select.selectOption(other);
  await expect(page.getByText(/11:00 overlaps another appointment/)).toHaveCount(0);
});
