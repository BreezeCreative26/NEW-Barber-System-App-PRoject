// Customer-facing screen tour. Not a behaviour test — it walks the public journey on a phone
// viewport and writes one screenshot per step to docs/evidence/customer/ so the screens a customer
// actually sees (shop page, booking steps, confirmation, manage link, account sign-in, account)
// can be reviewed together. Run alone: npx playwright test tests/customer-screens.spec.ts
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { base, openFixtureShop } from "./fixture";

const out = "docs/evidence/customer";
mkdirSync(out, { recursive: true });
const shot = (page: import("@playwright/test").Page, name: string) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("customer screen tour", async ({ page }) => {
  // Northline Barbers: the built-in demo seed (real photos, bios, shop page, history), as a private copy.
  const fx = await openFixtureShop(page);
  const slug = fx.slug;
  const w = await (await page.request.get(base + "/workspace")).json();
  await page.context().clearCookies();

  // 1. Shop page
  await page.goto(`/${slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await shot(page, "01-shop-page");

  // 2–6. Booking flow
  await page.goto(`/book/${slug}`);
  await expect(page.getByRole("heading", { name: "What are we doing today?" })).toBeVisible();
  await shot(page, "02-book-service");
  await page.getByRole("button", { name: new RegExp(w.services[1].name) }).click();
  await page.getByRole("button", { name: "Choose your barber", exact: true }).click();
  await shot(page, "03-book-barber");
  await page.getByRole("button", { name: new RegExp(w.staff[0].name) }).click();
  await page.getByRole("button", { name: "Find a time", exact: true }).click();
  await expect(page.getByRole("heading", { name: "When suits you?" })).toBeVisible();
  // Pick the first open day next week (Northline is closed Sundays and Mondays).
  await page.getByRole("button", { name: "Next week" }).click();
  const dateStrip = page.getByRole("group", { name: "Choose a date" }).or(page.locator(".booking-dates")).first();
  const openDay = dateStrip.locator("button:not([disabled])").filter({ hasNotText: /Closed/ }).first();
  await expect(openDay).toHaveAttribute("aria-label", / times$/);
  const label = ((await openDay.getAttribute("aria-label")) || "").split(",")[0];
  await openDay.click();
  await expect(page.getByRole("group", { name: "Choose an appointment time" }).locator("button:not([disabled])").first()).toBeVisible();
  await shot(page, "04-book-time");
  await page.getByRole("group", { name: "Choose an appointment time" }).locator("button:not([disabled])").first().click();
  await page.getByRole("button", { name: "Sign in to book", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to book." })).toBeVisible();
  await page.getByLabel("Your name").fill("Jordan Lee");
  await page.getByLabel("Mobile number").fill(`07${String(Date.now()).slice(-9)}`);
  const jordanEmail = `jordan-${Date.now()}@example.test`;
  await page.getByLabel("Email address", { exact: true }).fill(jordanEmail);
  await page.getByTestId("booking-password").fill("jordan-pass-1");
  await shot(page, "05-book-account");
  await page.getByTestId("auth-submit").click();
  await expect(page.getByRole("heading", { name: "Check and confirm." })).toBeVisible();
  await shot(page, "06-book-review");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
  await shot(page, "07-book-confirmed");

  // 8. Manage link (what the text/email link opens)
  const href = await page.getByTestId("open-manage").getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
  await shot(page, "08-manage-visit");
  await page.getByRole("button", { name: "Move booking" }).click();
  await expect(page.getByRole("group", { name: "Choose a new time" })).toBeVisible();
  // Guard: the move step must never widen the page on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(page, "09-manage-move");

  // 10–11. Customer account: branded sign-in, then the account
  await page.context().clearCookies();
  await page.goto(`/${slug}/me`);
  await expect(page.getByTestId("customer-signin")).toBeVisible();
  await page.getByTestId("signin-email").fill(jordanEmail);
  await page.getByTestId("signin-password").fill("jordan-pass-1");
  await shot(page, "10-account-signin");
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("customer-area")).toBeVisible();
  await shot(page, "11-account");
});
