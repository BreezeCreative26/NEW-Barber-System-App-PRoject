import { test, expect } from "@playwright/test";
import { base, origin } from "./fixture";

// Front door: marketing page for visitors, straight to the workspace for owners; sign-up from the
// landing CTA reaches a working shop with the first-run checklist.

test("landing page: SEO head, CTAs → /signup, no horizontal overflow on a phone, signed-in users skip it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const res = await page.goto("/");
  expect(res!.status()).toBe(200);
  await expect(page).toHaveTitle(/foliyo/);
  expect(await page.locator('meta[name="description"]').getAttribute("content")).toMatch(/appointment/i);
  expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBe(origin + "/");
  expect(await page.locator('script[type="application/ld+json"]').count()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("run on appointments");
  expect(await page.locator('a[href="/signup"]').count()).toBeGreaterThanOrEqual(4);
  // The page follows the brand mockup: dark hero with the barber photo + confirmation phone, the
  // six-feature grid, four numbered steps, the two-card price comparison, four testimonials.
  await expect(page.locator(".l-hero-photo")).toBeVisible();
  await expect(page.locator(".l-phone-hero")).toContainText("Appointment Confirmed!");
  await expect(page.locator(".l-grid6 li")).toHaveCount(6);
  await expect(page.locator(".l-steps li")).toHaveCount(4);
  await expect(page.locator(".l-compare-card")).toHaveCount(2);
  await expect(page.locator(".l-quotes li")).toHaveCount(4);
  await expect(page.locator(".l-header img[alt='foliyo']")).toBeVisible();
  for (const id of ["features", "pricing", "about", "industries", "testimonials", "faq"]) await expect(page.locator(`#${id}`)).toHaveCount(1);
  // Industry grid links through to the barber vertical.
  await expect(page.locator(".l-industries-grid li")).toHaveCount(6);
  await expect(page.locator('.l-industries-grid a[href="/barbers"]')).toBeVisible();
  // Strict CSP: no inline styles or scripts anywhere on the page.
  expect(await page.locator("[style]").count()).toBe(0);
  expect(await page.locator("script:not([type='application/ld+json'])").count()).toBe(0);
  await page.getByTestId("landing-cta-hero").click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByLabel("Shop name")).toBeVisible();
  // Owner with a session never sees the marketing page.
  const s = await page.request.post(base + "/auth/demo", { headers: { Origin: origin }, data: { fixture: true, as: "owner" } });
  expect(s.status()).toBe(201);
  await page.goto("/");
  await expect(page).toHaveURL(/\/workspace/);
});

test("barber vertical at /barbers: same layout, barber copy, links back to the universal page, signed-in users skip it", async ({ page }) => {
  const res = await page.goto("/barbers");
  expect(res!.status()).toBe(200);
  await expect(page).toHaveTitle(/barbers/i);
  expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBe(origin + "/barbers");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Built by barbers");
  await expect(page.locator(".l-hero-photo")).toHaveAttribute("src", /hero-barber/);
  await expect(page.locator(".l-grid6 li")).toHaveCount(6);
  await expect(page.locator(".l-quotes li")).toHaveCount(4);
  await expect(page.locator("#industries")).toHaveCount(0);
  await expect(page.locator('.l-hero-vertical[href="/"]')).toBeVisible();
  expect(await page.locator("[style]").count()).toBe(0);
  expect(await page.locator("script:not([type='application/ld+json'])").count()).toBe(0);
  const s = await page.request.post(base + "/auth/demo", { headers: { Origin: origin }, data: { fixture: true, as: "owner" } });
  expect(s.status()).toBe(201);
  await page.goto("/barbers");
  await expect(page).toHaveURL(/\/workspace/);
});

test("sign up from the landing page → guided setup opens; leaving it shows the continue banner; dismissing hides it", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto("/");
  await page.getByTestId("landing-cta-header").click();
  const email = `landing-${crypto.randomUUID().slice(0, 8)}@example.test`;
  await page.getByLabel("Shop name").fill("Landing Test Barbers");
  await page.getByLabel("Your name").fill("Lee Landing");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("a-long-passphrase-123");
  await page.getByRole("button", { name: "Create shop", exact: true }).click();
  await page.waitForURL(/\/workspace\/setup/);
  const wiz = page.getByTestId("setup-wizard");
  await expect(wiz).toBeVisible();
  await expect(wiz).toContainText("Step 1 of 7");
  // Finish later → calendar with the banner offering the way back.
  await page.getByTestId("setup-exit").click();
  await page.waitForURL(/\/workspace$/);
  const banner = page.getByTestId("setup-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Get Landing Test Barbers live");
  await banner.getByTestId("setup-continue").click();
  await expect(page.getByTestId("setup-wizard")).toBeVisible();
  await page.getByTestId("setup-exit").click();
  // Hide persists server-side (survives a reload).
  await banner.getByRole("button", { name: "Hide" }).click();
  await expect(page.getByTestId("setup-banner")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#workspace-main")).toBeVisible();
  await expect(page.getByTestId("setup-banner")).toHaveCount(0);
});
