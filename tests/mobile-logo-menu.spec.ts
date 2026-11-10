// Phone: the shop logo lives in the slide-out menu, not the top bar, so the wallet chip has room
// for its amount and caption. Desktop keeps the brand in the top bar and no duplicate in the menu.
import { test, expect } from "@playwright/test";
import { openFixtureShop } from "./fixture";

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  test("logo is in the menu; wallet chip shows amount and caption", async ({ page }) => {
    await openFixtureShop(page);
    await expect(page.locator(".topbar [data-testid=brand-shop]")).toBeHidden();
    const chip = page.getByTestId("wallet-chip");
    await expect(chip).toBeVisible();
    await expect(chip.locator("small")).toBeVisible();
    const c = (await chip.boundingBox())!;
    expect(c.x + c.width).toBeLessThanOrEqual(390);
    // The amount is shown in full (never ellipsised) and the logo is not repeated in the top bar.
    const cut = await chip.locator("b").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(cut).toBe(false);
    await expect(page.locator(".topbar .account-pill .avatar-logo")).toBeHidden();
    // Nothing in the top bar spills off the right edge.
    const right = await page.locator(".topbar > *:visible").evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));
    expect(right).toBeLessThanOrEqual(390);
    await page.screenshot({ path: "test-results/phone/topbar-wallet.png", clip: { x: 0, y: 0, width: 390, height: 120 } });
    await page.locator(".topbar-menu").click();
    const shop = page.getByTestId("sidebar-shop");
    await expect(shop).toBeVisible();
    await expect(shop.locator("b")).not.toBeEmpty();
    await page.waitForTimeout(350);
    await page.screenshot({ path: "test-results/phone/menu-logo.png" });
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("brand stays in the top bar; menu has no duplicate", async ({ page }) => {
    await openFixtureShop(page);
    await expect(page.locator(".topbar [data-testid=brand-shop]")).toBeVisible();
    await expect(page.getByTestId("sidebar-shop")).toBeHidden();
  });
});
