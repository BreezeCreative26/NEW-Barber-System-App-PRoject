// Barber phone app: a barber signing in on a phone sees their own agenda (Today), a week strip of
// their days, one-tap status moves, and a bottom bar of Today / Week / Customers / My pay / Account.
// Week opens the shared calendar in week view filtered to them. Owners keep the full calendar.
import { test, expect } from "@playwright/test";

const origin = "http://localhost:3000";
const base = origin + "/api/app";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("barber on a phone gets the same calendar and menu as everyone", async ({ page }) => {
  expect((await page.request.post(base + "/auth/demo", { headers: { Origin: origin }, data: { as: "barber" } })).status()).toBe(201);
  await page.goto("/workspace");
  await expect(page.getByRole("button", { name: "New booking", exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("barber-home")).toHaveCount(0);
});

test("owner on a phone keeps the calendar and the wider bottom bar", async ({ page }) => {
  const res = await page.request.post(base + "/auth/demo", { data: {}, headers: { Origin: origin } });
  expect(res.status()).toBe(201);
  await page.goto(origin + "/workspace");
  await expect(page.getByLabel("Appointment calendar")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("barber-home")).toHaveCount(0);
  await expect(page.getByTestId("tabbar").getByRole("button", { name: "Insights" })).toBeVisible();
});
