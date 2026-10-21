import { test, expect } from "@playwright/test";
import { openFixtureShop } from "./fixture";
import { base, newShop } from "./shop";

test("calendar: every 15-minute row shows its full time; filters and walk-in are gone; the dots menu offers day actions", async ({ page }) => {
  await openFixtureShop(page);
  const labels = await page.locator(".time-gutter > span").allTextContents();
  expect(labels.length).toBeGreaterThan(8);
  for (const l of labels) expect(l).toMatch(/^\d\d:(00|15|30|45)$/);
  expect(new Set(labels.map((l) => l.slice(-2)))).toEqual(new Set(["00", "15", "30", "45"]));
  await expect(page.getByTestId("filters-toggle")).toHaveCount(0);
  await expect(page.getByTestId("walk-in")).toHaveCount(0);
  await page.getByTestId("day-menu-button").click();
  await expect(page.getByRole("menuitem", { name: /Edit today's hours/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Block time/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Day off/ })).toBeVisible();
});

test("payment is one shop-wide choice: services cannot carry their own payment mode", async () => {
  const { r } = await newShop("One Choice Shop");
  const w = await (await r.get(base + "/workspace")).json();
  const svc = w.services[0];
  const res = await r.put(`${base}/services/${svc.id}`, { data: { name: svc.name, category: svc.category, duration_min: svc.duration_min, price_pence: svc.price_pence, payment_mode: "PREPAY", version: svc.version } });
  expect(res.status()).toBe(200);
  const after = (await (await r.get(base + "/workspace")).json()).services.find((s: { id: string }) => s.id === svc.id);
  expect(after.payment_mode ?? null).toBeNull();
});
