// Visual baselines for the reference screens (docs/DESIGN.md). A change to these fails until the
// baseline is deliberately refreshed with `npm run test:visual -- --update-snapshots`.
// Data comes from a fresh isolated demo fixture so the content is deterministic; the date strip and
// live clock are masked because they move with the calendar day.
import { test, expect } from "@playwright/test";
import { openFixtureShop } from "./fixture";

const shots = [
  { name: "owner-calendar", width: 1440, height: 900 },
  { name: "owner-calendar-phone", width: 390, height: 844 },
  { name: "owner-calendar-tablet", width: 768, height: 1024 },
];

for (const shot of shots)
  test(`visual: ${shot.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: shot.width, height: shot.height }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await openFixtureShop(page);
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot(`${shot.name}.png`, {
      fullPage: false,
      maxDiffPixelRatio: 0.02,
      mask: [
        page.locator(".workspace-heading p").last(),
        page.getByLabel("Appointment date", { exact: true }),
        page.locator(".calendar-now, .now-marker, [data-testid='now-line']"),
        page.locator("time"),
      ],
    });
    await context.close();
  });

test("visual: entry hub", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/workspace");
  await page.getByRole("heading", { name: "Open the demo shop" }).waitFor();
  await expect(page).toHaveScreenshot("entry-hub.png", { fullPage: false, maxDiffPixelRatio: 0.02 });
  await context.close();
});

test("visual: public booking", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const fx = await openFixtureShop(page);
  await page.goto(`/book/${fx.slug}`);
  await page.getByRole("heading", { name: /What are we doing today/ }).waitFor();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("public-booking.png", {
    fullPage: false,
    maxDiffPixelRatio: 0.02,
    mask: [page.locator(".shop-brand, .hero-seal, .booking-hero .hero-copy .eyebrow")],
  });
  await context.close();
});
