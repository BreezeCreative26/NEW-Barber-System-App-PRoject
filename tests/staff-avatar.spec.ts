// The top-right account button shows the signed-in person's own profile photo (their barber
// profile), on phones too. Logins without a photo keep the shop logo / initials.
import { test, expect } from "@playwright/test";
import type { WorkspaceData } from "../src/server/domain";
import { openFixtureShop, base } from "./fixture";

test("barber login on a phone sees their own photo top right", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureShop(page, "barber");
  const w: WorkspaceData = await (await page.request.get(base + "/workspace")).json();
  const me = w.staff.find((s) => s.id === w.account!.staff_id)!;
  expect(me.photo_url).toBeTruthy();
  const photo = page.getByTestId("account-pill").getByTestId("account-photo");
  await expect(photo).toBeVisible();
  await expect(photo).toHaveAttribute("src", me.photo_url);
  // Loaded, round and cropped (not squashed).
  expect(await photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(await photo.evaluate((img) => getComputedStyle(img).objectFit)).toBe("cover");
  const box = (await photo.boundingBox())!;
  expect(Math.abs(box.width - box.height)).toBeLessThan(1);
  // Still opens the account menu.
  await page.getByTestId("account-pill").click();
  await expect(page.getByRole("menu").or(page.locator(".account-menu")).first()).toBeVisible();
});

test("the owner login (no barber profile of its own) keeps the shop logo or initials", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureShop(page, "owner");
  const w: WorkspaceData = await (await page.request.get(base + "/workspace")).json();
  expect(w.account!.staff_id).toBeFalsy();
  const pill = page.getByTestId("account-pill");
  await expect(pill).toBeVisible();
  await expect(pill.getByTestId("account-photo")).toHaveCount(0);
  // Exactly one avatar shows. On a phone the shop logo lives in the side menu, so the top bar
  // shows the owner's initials instead of repeating the logo.
  await expect(pill.locator(".avatar-logo:visible, span.avatar-ink:visible")).toHaveCount(1);
  await expect(pill.locator(".avatar-logo")).toBeHidden();
  await expect(pill.locator("span.avatar-ink:visible")).toHaveText(/^[A-Z]{1,2}$/);
  // Desktop keeps the shop logo in the account button.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(pill.locator(".avatar-logo:visible, span.avatar-ink:visible")).toHaveCount(1);
  if (w.logo_url) await expect(pill.locator(".avatar-logo")).toBeVisible();
});

test("a barber whose profile has no photo sees their initials", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureShop(page, "barber");
  // Remove the photo from this barber's own profile in the page's copy of the workspace.
  await page.route("**/api/app/workspace", async (route) => {
    const res = await route.fetch();
    const w = await res.json();
    for (const s of w.staff) if (s.id === w.account?.staff_id) s.photo_url = "";
    w.logo_url = "";
    await route.fulfill({ response: res, json: w });
  });
  await page.reload();
  const pill = page.getByTestId("account-pill");
  await expect(pill).toBeVisible();
  await expect(pill.getByTestId("account-photo")).toHaveCount(0);
  await expect(pill.locator("span.avatar-ink")).toHaveText(/^[A-Z]{1,2}$/);
});
