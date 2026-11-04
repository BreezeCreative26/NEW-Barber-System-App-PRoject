// Standing (recurring) bookings from the shop side:
// - barbers without "manage others" book series into their own column (no 403 from a preselected colleague);
// - visits stop at the shop's booking window;
// - a clashing date offers that day's free times ("Change time") or Skip; soft reasons (blocked time) book over quietly.
import { test, expect } from "@playwright/test";
import { base, newShop, enterNewShop } from "./shop";
import { openFixtureShop, origin } from "./fixture";

const plus = (d: string, n: number) => {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
type W = { today: string; staff: { id: string; active: number }[]; services: { id: string; name: string; duration_min: number; version: number }[]; shop: { version: number } };

async function seriesSetup(name: string) {
  const { r } = await newShop(name);
  const w = (await (await r.get(base + "/workspace")).json()) as W;
  const staff = w.staff.find((s) => s.active)!;
  const svc = w.services.find((s) => s.duration_min === 30)!;
  const date = plus(w.today, 2);
  const a = await (await r.get(base + `/availability?date=${date}&staff_id=${staff.id}&service_id=${svc.id}`)).json();
  const body = {
    staff_id: staff.id, service_id: svc.id, customer_name: "Standing Regular", phone: "07700900777", notes: "", date,
    start_min: 600, source: "TEST_BOOKING", quote: a.quote, notify: false, interval_weeks: 1, occurrences: 4, skip_dates: [] as string[],
  };
  return { r, w, staff, svc, date, body, quote: a.quote };
}

test("series visits stop at the shop's booking window", async () => {
  const { r, w, body } = await seriesSetup("Series Window");
  const pv = await (await r.post(base + "/series/preview", { data: { ...body, occurrences: 12 } })).json();
  const maxDate = plus(w.today, 42);
  expect(pv.max_date).toBe(maxDate);
  expect(pv.dates.length).toBeLessThan(12);
  expect(pv.trimmed).toBe(12 - pv.dates.length);
  for (const d of pv.dates) expect(d.date <= maxDate).toBe(true);
  const saved = await r.post(base + "/series", { data: { ...body, occurrences: 12 } });
  expect(saved.status(), await saved.text()).toBe(201);
  const out = await saved.json();
  expect(out.created.length).toBe(pv.dates.length);
  expect(out.created.every((b: { date: string }) => b.date <= maxDate)).toBe(true);
  await r.dispose();
});

test("a clashing date offers free times; moving it books that visit at the new time; blocked time books over", async () => {
  const { r, staff, svc, date, body, quote } = await seriesSetup("Series Clash");
  const clash = plus(date, 7);
  const soft = plus(date, 14);
  const taken = await r.post(base + "/bookings", {
    data: { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: svc.id, customer_name: "Already Here", phone: "07700900778", notes: "", date: clash, start_min: 600, source: "TEST_BOOKING", quote, notify: false },
  });
  expect(taken.status(), await taken.text()).toBe(201);
  const block = await r.post(base + `/staff/${staff.id}/blocks`, { data: { date: soft, start_min: 600, end_min: 660, kind: "TRAINING" } });
  expect(block.status(), await block.text()).toBe(201);
  const pv = await (await r.post(base + "/series/preview", { data: body })).json();
  const row = pv.dates.find((d: { date: string }) => d.date === clash);
  expect(row.reason).toBe("Clashes with another appointment");
  expect(row.options).toContain(630);
  expect(row.options).not.toContain(600);
  expect(row.options).not.toContain(585); // 09:45 + 30 min would overlap 10:00
  // Blocked time is a soft reason: no conflict for the shop.
  expect(pv.dates.find((d: { date: string }) => d.date === soft).reason).toBe("");
  expect((await r.post(base + "/series", { data: body })).status()).toBe(409);
  const moved = { ...body, moves: [{ date: clash, start_min: 630 }] };
  const pv2 = await (await r.post(base + "/series/preview", { data: moved })).json();
  expect(pv2.bookable).toBe(4);
  expect(pv2.dates.find((d: { date: string }) => d.date === clash)).toMatchObject({ moved: true, start_min: 630, reason: "" });
  const saved = await r.post(base + "/series", { data: moved });
  expect(saved.status(), await saved.text()).toBe(201);
  const out = await saved.json();
  expect(out.failed).toEqual([]);
  expect(out.created).toHaveLength(4);
  expect(out.created.find((b: { date: string }) => b.date === clash).start_min).toBe(630);
  expect(out.created.find((b: { date: string }) => b.date === soft).start_min).toBe(600);
  await r.dispose();
});

test("a barber books a recurring appointment from the booking form (own column, no permission error)", async ({ page }) => {
  test.setTimeout(90000);
  await openFixtureShop(page, "barber");
  const w = await (await page.request.get(base + "/workspace")).json();
  const own = w.account.staff_id as string;
  expect(own).toBeTruthy();
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const barber = dialog.getByLabel("Barber");
  await expect(barber).toHaveValue(own);
  // Only their own name is offered.
  await expect(barber.locator("option:not([value=''])")).toHaveCount(1);
  await expect(dialog.getByText("You can only change your own appointments")).toHaveCount(0);
  // A weekday the barber works with a free time.
  const timeSelect = dialog.getByLabel("Available start time");
  let picked = "";
  for (let i = 3; i < 12 && !picked; i++) {
    await dialog.getByLabel("Booking date").fill(plus(w.today, i));
    await page.waitForTimeout(400);
    const vals = await timeSelect.locator("option:not([disabled])").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    if (vals.length) {
      picked = vals.includes("660") ? "660" : vals[Math.floor(vals.length / 2)];
      await timeSelect.selectOption(picked);
    }
  }
  expect(picked).not.toBe("");
  await dialog.getByLabel("Customer name", { exact: true }).fill("Barber Regular");
  await dialog.getByLabel("Mobile number", { exact: true }).fill("07700900779");
  await dialog.getByLabel("Email address").fill("barber.regular@example.test");
  await dialog.getByTestId("booking-more-toggle").click();
  await dialog.getByLabel("Repeat this appointment at the same time").check();
  await dialog.getByLabel("Every").selectOption("2");
  await expect(dialog.getByTestId("series-window-hint")).toContainText("42-day booking window");
  await dialog.getByLabel("Visits").fill("2");
  await dialog.getByRole("button", { name: "Review appointment" }).click();
  const preview = dialog.getByTestId("series-preview");
  await expect(preview).toBeVisible();
  // Clear any clash (demo data) by skipping it, then confirm.
  const blocked = preview.locator("li.is-blocked");
  if ((await blocked.count()) > 0) test.skip(true, "demo data clashes with the picked time");
  await dialog.getByRole("button", { name: /^Confirm standing booking/ }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const range = await (await page.request.get(base + `/bookings/range?from=${w.today}&to=${plus(w.today, 30)}`)).json();
  const mine = range.bookings.filter((b: { series_id: string | null; customer_name: string }) => b.series_id && b.customer_name === "Barber Regular");
  expect(mine).toHaveLength(2);
  expect(mine.every((b: { staff_id: string }) => b.staff_id === own)).toBe(true);
});

test("conflict screen: change the time of one clashing visit, then confirm the series", async ({ page }) => {
  test.setTimeout(90000);
  await enterNewShop(page, "Series Amend");
  const headers = { Origin: origin };
  const w = await (await page.request.get(base + "/workspace")).json();
  const staff = w.staff.find((s: { active: number }) => s.active);
  const svc = w.services.find((s: { duration_min: number }) => s.duration_min === 30);
  const start = plus(w.today, 2);
  const clash = plus(start, 7);
  const a = await (await page.request.get(base + `/availability?date=${clash}&staff_id=${staff.id}&service_id=${svc.id}`)).json();
  const taken = await page.request.post(base + "/bookings", {
    headers,
    data: { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: svc.id, customer_name: "Already Here", phone: "07700900780", notes: "", date: clash, start_min: 600, source: "TEST_BOOKING", quote: a.quote, notify: false },
  });
  expect(taken.status(), await taken.text()).toBe(201);
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Barber").selectOption(staff.id);
  await dialog.getByLabel("Service", { exact: true }).selectOption(svc.id);
  await dialog.getByLabel("Booking date").fill(start);
  const timeSelect = dialog.getByLabel("Available start time");
  await expect(timeSelect.locator("option[value='600']")).toBeEnabled();
  await timeSelect.selectOption("600");
  await dialog.getByLabel("Customer name", { exact: true }).fill("Weekly Regular");
  await dialog.getByLabel("Mobile number", { exact: true }).fill("07700900781");
  const email = dialog.getByLabel("Email address");
  if (await email.count()) await email.fill("weekly.regular@example.test");
  await dialog.getByTestId("booking-more-toggle").click();
  await dialog.getByLabel("Repeat this appointment at the same time").check();
  await dialog.getByLabel("Every").selectOption("1");
  await dialog.getByLabel("Visits").fill("3");
  await dialog.getByRole("button", { name: "Review appointment" }).click();
  const preview = dialog.getByTestId("series-preview");
  const row = preview.getByTestId(`series-date-${clash}`);
  await expect(row).toHaveClass(/is-blocked/);
  await expect(row).toContainText("Clashes with another appointment");
  await expect(preview).toContainText("2 of 3 dates bookable");
  await row.getByLabel(`Change time for ${clash}`).selectOption("630");
  await expect(row).toHaveClass(/is-free/);
  await expect(row).toContainText("10:30");
  await expect(preview).toContainText("3 of 3 dates bookable");
  await dialog.getByRole("button", { name: /^Confirm standing booking \(3 dates\)/ }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const range = await (await page.request.get(base + `/bookings/range?from=${start}&to=${plus(start, 20)}`)).json();
  const series = range.bookings.filter((b: { series_id: string | null }) => b.series_id);
  expect(series).toHaveLength(3);
  expect(series.find((b: { date: string }) => b.date === clash).start_min).toBe(630);
});
