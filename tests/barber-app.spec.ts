// Barber phone app: a barber signing in on a phone sees their own agenda (Today), a week strip of
// their days, one-tap status moves, and a bottom bar of Today / Week / Customers / My pay / Account.
// Week opens the shared calendar in week view filtered to them. Owners keep the full calendar.
import { test, expect } from "@playwright/test";
import { openFilters } from "./fixture";

const origin = "http://localhost:3000";
const base = origin + "/api/app";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("barber on a phone: Today agenda, own week strip, status moves, bottom tabs", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const res = await page.request.post(base + "/auth/demo", { data: { as: "barber" }, headers: { Origin: origin } });
  expect(res.status(), await res.text()).toBe(201);
  await page.goto(origin + "/workspace");
  const home = page.getByTestId("barber-home");
  await expect(home).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("barber-week")).toBeVisible();
  // Bottom bar is the barber set.
  const tabbar = page.getByTestId("tabbar");
  for (const label of ["Today", "Week", "Customers", "My pay", "Account"]) await expect(tabbar.getByRole("button", { name: label })).toBeVisible();
  await expect(tabbar.getByRole("button", { name: "Insights" })).toHaveCount(0);

  // Only my bookings on the agenda: every row belongs to me (server already scopes barbers).
  const ws = await (await page.request.get(base + "/workspace")).json();
  const me = ws.account.staff_id as string;
  expect(ws.bookings.every((b: { staff_id: string }) => b.staff_id === me)).toBe(true);

  // Find a day this week with a live booking and open it.
  const days = page.locator('[data-testid^="barber-day-"]');
  const n = await days.count();
  let found = false;
  for (let i = 0; i < n && !found; i++) {
    const count = await days.nth(i).locator(".barber-week-count").textContent();
    if (count && /^\d+$/.test(count.trim()) && Number(count) > 0) { await days.nth(i).click(); found = true; }
  }
  if (found) {
    await expect(page.getByTestId("barber-agenda")).toBeVisible();
    const rows = page.getByTestId("barber-row");
    expect(await rows.count()).toBeGreaterThan(0);
    // One-tap status move on the focus card when it is CONFIRMED → Arrived.
    const advance = page.getByTestId("barber-advance");
    if (await advance.count()) {
      const label = (await advance.textContent())!.trim();
      await advance.click();
      await expect(page.getByTestId("barber-focus")).toContainText(label === "Arrived" ? /Waiting for you|In the chair|Next up/ : /.+/);
    }
    // Tapping a row opens the appointment detail.
    await rows.first().locator(".barber-row-main").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  }

  // Week tab → shared week calendar filtered to me.
  await tabbar.getByRole("button", { name: "Week" }).click();
  await expect(page.getByLabel("Appointment calendar")).toBeVisible();
  await openFilters(page);
  await expect(page.getByLabel("Barber filter")).toHaveValue(me);
  await expect(page.locator('[aria-label="Calendar view"] button[aria-pressed="true"]')).toHaveAttribute("aria-label", "Week");
  // Back to Today.
  await tabbar.getByRole("button", { name: "Today" }).click();
  await expect(home).toBeVisible();
  await tabbar.getByRole("button", { name: "My pay" }).click();
  await expect(page.getByRole("heading", { name: /My pay/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("owner on a phone keeps the calendar and the wider bottom bar", async ({ page }) => {
  const res = await page.request.post(base + "/auth/demo", { data: {}, headers: { Origin: origin } });
  expect(res.status()).toBe(201);
  await page.goto(origin + "/workspace");
  await expect(page.getByLabel("Appointment calendar")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("barber-home")).toHaveCount(0);
  await expect(page.getByTestId("tabbar").getByRole("button", { name: "Insights" })).toBeVisible();
});
