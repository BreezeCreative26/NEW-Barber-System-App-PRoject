import { test, expect } from "@playwright/test";
import { base, origin } from "./fixture";

// Front door: marketing page for visitors, straight to the workspace for owners; sign-up from the
// landing CTA reaches a working shop with the first-run checklist.

test("landing page: SEO head, CTAs → /signup, no horizontal overflow on a phone, signed-in users skip it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const res = await page.goto("/");
  expect(res!.status()).toBe(200);
  await expect(page).toHaveTitle(/OLLO/);
  expect(await page.locator('meta[name="description"]').getAttribute("content")).toMatch(/barbershop/i);
  expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBe(origin + "/");
  expect(await page.locator('script[type="application/ld+json"]').count()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("booked");
  expect(await page.locator('a[href="/signup"]').count()).toBeGreaterThanOrEqual(4);
  const img = page.locator(".l-hero-media img");
  await expect(img).toBeVisible();
  expect(await img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
  await page.getByTestId("landing-cta-hero").click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByLabel("Shop name")).toBeVisible();
  // Owner with a session never sees the marketing page.
  const s = await page.request.post(base + "/auth/demo", { headers: { Origin: origin }, data: { fixture: true, as: "owner" } });
  expect(s.status()).toBe(201);
  await page.goto("/");
  await expect(page).toHaveURL(/\/workspace/);
});

test("sign up from the landing page → workspace with the first-run checklist; steps complete as the shop is set up", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto("/");
  await page.getByTestId("landing-cta-header").click();
  const email = `landing-${crypto.randomUUID().slice(0, 8)}@example.test`;
  await page.getByLabel("Shop name").fill("Landing Test Barbers");
  await page.getByLabel("Your name").fill("Lee Landing");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("a-long-passphrase-123");
  await page.getByRole("button", { name: "Create shop", exact: true }).click();
  await page.waitForURL(/\/workspace/);
  const list = page.getByTestId("setup-checklist");
  await expect(list).toBeVisible();
  await expect(list).toContainText("Get Landing Test Barbers live");
  await expect(list.locator("li[data-done='false']")).toHaveCount(3);
  // Services step: add one service via the API and the step ticks.
  const w = await (await page.request.get(base + "/workspace")).json();
  const svc = await page.request.post(base + "/services", { headers: { Origin: origin }, data: { name: "Skin fade", category: "Hair", duration_min: 30, price_pence: 2500, active: 1, description: "", colour: "sage", online_bookable: 1, popular: 0, sort_order: 0, payment_mode: null } });
  expect(svc.status(), await svc.text()).toBe(201);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(list.locator("li[data-done='true']")).toHaveCount(1);
  await expect(list).toContainText("1 of 3 done");
  // Team step ticks when opened.
  await list.getByTestId("setup-team").click();
  await page.getByRole("navigation", { name: "Workspace sections" }).getByRole("button", { name: /Appointments|Today/ }).first().click();
  await expect(list.locator("li[data-done='true']")).toHaveCount(2);
  // Online step: switch the booking link on and the checklist disappears.
  const on = await page.request.put(base + "/shop/online", { headers: { Origin: origin }, data: { slug: `landing-${crypto.randomUUID().slice(0, 8)}`, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } });
  expect(on.status(), await on.text()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByTestId("setup-checklist")).toHaveCount(0);
});
