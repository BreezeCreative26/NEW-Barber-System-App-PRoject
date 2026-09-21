// OLLO ↔ shop billing: trial, seats, add-ons, estimate, entitlements on the workspace.
import { test, expect } from "@playwright/test";
import { base, origin, openFixtureShop, section } from "./fixture";

test("billing: trial with seats priced, add-on toggles the estimate, timeline records it, workspace carries entitlements", async ({ page }) => {
  await openFixtureShop(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  expect(w.entitlements).toBeTruthy();
  expect(w.entitlements.readOnly).toBe(false);
  expect(w.entitlements.subscription.status).toBe("TRIAL");
  const active = w.staff.filter((s: any) => s.active).length;
  expect(w.entitlements.seats.used).toBe(active);

  await section(page, "Settings/billing");
  const panel = page.getByTestId("billing-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("billing-status")).toHaveText("Trial");
  const expected = 2499 + Math.max(0, active - 1) * 799;
  await expect(page.getByTestId("billing-total")).toHaveText(`£${(expected / 100).toFixed(2)}`);
  await expect(panel).toContainText("No VAT is charged");

  await page.getByTestId("addon-ai_concierge").locator(".switch").click();
  await expect(page.getByTestId("billing-total")).toHaveText(`£${((expected + 4900) / 100).toFixed(2)}`);
  await expect(page.getByTestId("billing-timeline")).toContainText("AI Concierge switched on");
  await page.getByTestId("addon-ai_concierge").locator(".switch").click();
  await expect(page.getByTestId("billing-total")).toHaveText(`£${(expected / 100).toFixed(2)}`);

  // Server-side gate: a plan feature cannot be toggled as an add-on.
  const r = await page.request.post(base + "/billing/features/online_booking", { headers: { Origin: origin }, data: { enabled: false } });
  expect(r.status()).toBe(400);
});
