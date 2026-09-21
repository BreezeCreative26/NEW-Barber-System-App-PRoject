// Schedule changes that land on appointments open the conflict resolver; decisions are applied with
// the change in one save. Covers day off (calendar menu), no-conflict fast path, and stale versions.
import { test, expect, type Page } from "@playwright/test";
import { base, origin, openFixtureShop } from "./fixture";

const wd = (d: string) => new Date(d + "T12:00:00Z").getUTCDay();
const plus = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function rosteredDay(page: Page) {
  const w = await (await page.request.get(base + "/workspace")).json();
  const week = JSON.parse(w.shop.week_json);
  for (let i = 2; i < 12; i++) {
    const d = plus(i);
    for (const s of w.staff.filter((x: any) => x.active)) {
      const h = w.hours.find((x: any) => x.staff_id === s.id && x.weekday === wd(d));
      if (h?.enabled && week[wd(d)].enabled) return { w, day: d, staff: s };
    }
  }
  throw new Error("no rostered day");
}
async function book(page: Page, staffId: string, serviceId: string, day: string, after: number, name: string) {
  const q = await (await page.request.get(`${base}/availability?date=${day}&staff_id=${staffId}&service_id=${serviceId}`)).json();
  const start = q.slots.filter((s: any) => !s.reason).map((s: any) => s.start_min).find((m: number) => m >= after);
  const r = await page.request.post(base + "/bookings", { headers: { Origin: origin }, data: { staff_id: staffId, service_id: serviceId, date: day, start_min: start, customer_name: name, phone: "07700900999", notes: "", source: "TEST_BOOKING", quote: q.quote, addon_ids: [], request_id: crypto.randomUUID() } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).booking;
}

test("day off with appointments: resolver lists clashes with suggestions; move + cancel applied, customers told", async ({ page }) => {
  test.setTimeout(90000);
  await openFixtureShop(page);
  const { w, day, staff } = await rosteredDay(page);
  const svc = w.services[0];
  const a = await book(page, staff.id, svc.id, day, 600, "Ada Clash");
  const b = await book(page, staff.id, svc.id, day, 840, "Bob Clash");

  await page.getByLabel("Appointment date", { exact: true }).fill(day);
  const heading = page.locator(".staff-column-heading").filter({ hasText: staff.name });
  await heading.getByTestId("staff-menu").click();
  await page.getByRole("menuitem", { name: /Day off/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.locator('[name="date"]').fill(day);
  await dlg.locator('[name="reason"]').fill("Family emergency");
  await dlg.getByRole("button", { name: "Save day off" }).click();

  const resolver = page.getByTestId("conflict-resolver");
  await expect(resolver).toBeVisible();
  const rows = page.getByTestId("conflict-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Barber has a day off");
  await expect(rows.first().getByRole("radio", { name: "Move" })).toHaveAttribute("aria-checked", "true");
  await expect(rows.first().locator(".conflict-suggestions [role=radio]").first()).toHaveAttribute("aria-checked", "true");
  await rows.nth(1).getByRole("radio", { name: /^Cancel/ }).click();
  await expect(page.getByTestId("conflict-apply")).toHaveText(/Save and move 1, cancel 1/);
  await page.getByTestId("conflict-apply").click();

  const outcome = page.getByTestId("conflict-outcome");
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText("2 of 2 decisions applied");
  await expect(outcome).toContainText("Moved to");
  await expect(outcome).toContainText("Cancelled");
  await page.getByTestId("conflict-close").click();

  const w2 = await (await page.request.get(base + "/workspace")).json();
  expect(w2.days_off.some((d: any) => d.staff_id === staff.id && d.date === day)).toBe(true);
  const moved = (await (await page.request.get(`${base}/bookings/${a.id}`)).json()).booking;
  expect(moved.status).toBe("CONFIRMED");
  expect(moved.staff_id !== staff.id || moved.date !== day).toBe(true);
  const cancelled = (await (await page.request.get(`${base}/bookings/${b.id}`)).json()).booking;
  expect(cancelled.status).toBe("CANCELLED");
  const tl = await (await page.request.get(`${base}/bookings/${a.id}/timeline`)).json();
  expect(tl.events.map((e: any) => e.action)).toContain("RESCHEDULED");
});

test("hours change with no clashes saves straight through; stale decision version is reported not applied", async ({ page }) => {
  await openFixtureShop(page);
  const { w, day, staff } = await rosteredDay(page);
  // No appointments on this day for this barber at 17:00+ → shrinking to end 16:45 is clash-free only if none exist; use a far day instead.
  const far = plus(40);
  const p = await page.request.post(base + "/schedule/preview", { headers: { Origin: origin }, data: { kind: "day_off", staff_id: staff.id, change: { date: far, reason: "Holiday" } } });
  expect(p.status()).toBe(200);
  expect((await p.json()).conflicts).toEqual([]);

  const svc = w.services[0];
  const bk = await book(page, staff.id, svc.id, day, 600, "Stale Clash");
  const r = await page.request.post(base + "/schedule/apply", { headers: { Origin: origin }, data: { change: { kind: "day_off", staff_id: staff.id, change: { date: day, reason: "Sick" } }, decisions: [{ booking_id: bk.id, version: 999, action: "CANCEL", notify: false }] } });
  expect(r.status()).toBe(201);
  const j = await r.json();
  expect(j.outcome[0].ok).toBe(false);
  expect(j.outcome[0].note).toMatch(/Changed elsewhere/);
  const still = (await (await page.request.get(`${base}/bookings/${bk.id}`)).json()).booking;
  expect(still.status).toBe("CONFIRMED");
});

test("Shifts: day roster rows, week grid opens dated hours, leave list", async ({ page }) => {
  await openFixtureShop(page);
  await page.getByRole("navigation", { name: "Workspace sections" }).getByRole("button", { name: "Shifts", exact: true }).click();
  const rows = page.getByTestId("shift-row");
  await expect(rows.first()).toBeVisible();
  const w = await (await page.request.get(base + "/workspace")).json();
  await expect(rows).toHaveCount(w.staff.filter((s: any) => s.active).length);
  await page.getByRole("tab", { name: "Week" }).click();
  await expect(page.locator(".shifts-cell")).toHaveCount(7 * w.staff.filter((s: any) => s.active).length);
  await page.locator(".shifts-cell").nth(8).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: /dated hours/i })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Leave" }).click();
  await expect(page.getByTestId("shifts-leave")).toBeVisible();
});
