// The staff / owner sign-in pages must scroll on a phone. Regression: the page was "pinned" for the
// calendar even while signed out, so on a short screen the form could not be reached or scrolled.
import { test, expect } from "@playwright/test";
const origin = "http://localhost:3000";

for (const path of ["/staff", "/signin", "/signup"]) {
  test(`phone: ${path} page scrolls`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 520 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto(origin + path);
    await expect(page.locator("form").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.classList.contains("calendar-pinned"))).toBe(false);
    const m = await page.evaluate(() => {
      window.scrollTo(0, 99999);
      return { scrollable: document.documentElement.scrollHeight > innerHeight, moved: window.scrollY, overflow: getComputedStyle(document.documentElement).overflowY };
    });
    expect(m.overflow).not.toBe("hidden");
    expect(m.scrollable).toBe(true);
    expect(m.moved).toBeGreaterThan(0);
    await ctx.close();
  });
}

test("phone: the calendar is still pinned once signed in (only the timetable scrolls)", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const res = await page.request.post(origin + "/api/app/auth/signup", { headers: { Origin: origin }, data: { shop_name: "Pinned Cuts", name: "Pin Owner", email: `pin-${Date.now()}@example.com`, password: "Passw0rd!passw0rd", accept_legal: true, kind: "BARBER" } });
  expect(res.status(), await res.text()).toBe(201);
  await page.goto(origin + "/workspace");
  await expect(page.locator("#workspace-main")).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("calendar-pinned"))).toBe(true);
  await ctx.close();
});
