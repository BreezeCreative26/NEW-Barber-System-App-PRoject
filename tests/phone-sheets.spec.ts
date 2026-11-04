// iPhone layout: the shell (top bar, tab bar) sits normally; sheets (appointment, booking form, dialogs)
// are bottom sheets whose action bars stay fully on screen, and the appointment sheet swipes down to close.
import { test, expect, type Page } from "@playwright/test";
import { openFixtureShop } from "./fixture";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

async function box(page: Page, sel: string) {
  const b = await page.locator(sel).first().boundingBox();
  expect(b, sel).not.toBeNull();
  return b!;
}

test("workspace shell: no viewport-fit=cover; top bar at the top, tab bar flush with the bottom", async ({ page }) => {
  await openFixtureShop(page);
  const vp = await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute("content"));
  expect(vp).not.toContain("viewport-fit=cover");
  const tab = await box(page, ".tabbar");
  expect(Math.round(tab.y + tab.height)).toBe(844);
  expect(tab.height).toBeLessThanOrEqual(90);
  await page.screenshot({ path: "test-results/phone/shell.png" });
});

test("appointment sheet: bottom sheet with its actions on screen; swipe down closes it", async ({ page }) => {
  await openFixtureShop(page);
  const ev = page.locator(".calendar-event").first();
  await expect(ev).toBeVisible();
  await ev.click();
  const panel = page.getByTestId("appointment-panel");
  await expect(panel).toBeVisible();
  await page.waitForTimeout(400);
  const p = await box(page, '[data-testid="appointment-panel"]');
  expect(Math.round(p.y + p.height)).toBe(844);
  expect(p.y).toBeGreaterThanOrEqual(20);
  const a = await box(page, ".appointment-panel .panel-actions");
  expect(a.y + a.height).toBeLessThanOrEqual(844.5);
  expect(a.y).toBeGreaterThan(p.y);
  // Every action button is fully inside the screen.
  for (const b of await panel.locator(".panel-actions > .button").all()) {
    const bb = (await b.boundingBox())!;
    expect(bb.y + bb.height).toBeLessThanOrEqual(844 - 10);
  }
  await page.screenshot({ path: "test-results/phone/appointment.png" });
  // A small drag snaps back…
  const h = await box(page, '[data-testid="panel-handle"]');
  const x = h.x + h.width / 2, y = h.y + h.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + 30, { steps: 4 }); await page.mouse.up();
  await expect(panel).toBeVisible();
  // …a long drag closes the sheet.
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + 320, { steps: 10 }); await page.mouse.up();
  await expect(panel).toHaveCount(0);
});

test("booking form: full-screen sheet, header at the top, confirm bar fully on screen", async ({ page }) => {
  await openFixtureShop(page);
  await page.locator(".tabbar .tab-fab").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(400);
  const d = (await dialog.boundingBox())!;
  expect(Math.round(d.y)).toBe(0);
  expect(Math.round(d.y + d.height)).toBe(844);
  const bar = await box(page, ".modal .workspace-save-actions");
  expect(bar.y + bar.height).toBeLessThanOrEqual(844.5);
  const btn = (await dialog.getByRole("button", { name: "Review appointment" }).boundingBox())!;
  expect(btn.y + btn.height).toBeLessThanOrEqual(844 - 12);
  await page.screenshot({ path: "test-results/phone/booking.png" });
});

test("small dialogs are bottom sheets with buttons clear of the bottom edge", async ({ page }) => {
  await openFixtureShop(page);
  await page.locator(".calendar-event").first().click();
  const panel = page.getByTestId("appointment-panel");
  await panel.locator(".panel-more summary").click();
  await panel.getByRole("button", { name: "Edit name and phone" }).click();
  const dialog = page.locator("dialog.modal[open]");
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(400);
  const d = (await dialog.boundingBox())!;
  expect(Math.round(d.y + d.height)).toBe(844);
  expect(Math.round(d.width)).toBe(390);
  const submit = dialog.locator(".workspace-save-actions button[type=submit]");
  const s = (await submit.boundingBox())!;
  expect(s.y + s.height).toBeLessThanOrEqual(844 - 12);
  await page.screenshot({ path: "test-results/phone/dialog.png" });
});
