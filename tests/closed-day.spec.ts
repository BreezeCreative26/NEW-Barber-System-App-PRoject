// Whole-shop closed day: a soft red wash with one "Shop closed" label, not the text in every slot.
import { test, expect } from "@playwright/test";
import { openFixtureShop, refreshView, base, origin } from "./fixture";

const plus = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

for (const vp of [{ name: "desktop", width: 1280, height: 860 }, { name: "phone", width: 390, height: 844 }])
  test(`closed shop day shows red wash and one label (${vp.name})`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openFixtureShop(page);
    const w = await (await page.request.get(base + "/workspace")).json();
    const date = plus(w.today, 30);
    const res = await page.request.post(base + "/holidays", { headers: { Origin: origin }, data: { date, label: "Staff training" } });
    expect(res.status(), await res.text()).toBeLessThan(300);
    await refreshView(page);
    await page.getByLabel("Appointment date", { exact: true }).fill(date);
    // Nobody rostered: one clear empty state.
    const empty = page.getByTestId("shop-closed-empty");
    if (await empty.isVisible().catch(() => false)) {
      await expect(empty).toContainText("Shop closed · Staff training");
      await page.screenshot({ path: `test-results/closed/${vp.name}-empty.png` });
      await page.getByTestId("team-picker").click();
      const dlg = page.getByRole("dialog", { name: "Scheduled team" });
      await dlg.getByLabel(new RegExp(w.staff[0].name)).check();
      await dlg.getByRole("button", { name: "Done" }).click();
      await expect(dlg).toHaveCount(0);
    }
    await expect(page.locator(".calendar-board.shop-closed-day")).toBeVisible();
    await expect(page.getByTestId("shop-closed-banner")).toContainText("Shop closed · Staff training");
    await expect(page.locator(".timetable-slot:enabled")).toHaveCount(0);
    // Still announced to screen readers, but no visible "Shop closed" text repeated in slots.
    expect(await page.getByRole("button", { name: /09:00,.*Shop closed/ }).count()).toBeGreaterThan(0);
    const slotTexts = await page.locator(".timetable-slot").allInnerTexts();
    expect(slotTexts.filter((t) => t.includes("Shop closed"))).toHaveLength(0);
    const bg = await page.locator(".calendar-board.shop-closed-day .calendar-timeline").evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(bg).toBe("rgb(253, 243, 243)");
    await page.screenshot({ path: `test-results/closed/${vp.name}-board.png` });
    // The single label stays in view while scrolling the day.
    await page.locator(".connected-scroll").evaluate((e) => e.scrollBy(0, 600));
    await expect(page.getByTestId("shop-closed-banner").locator("span")).toBeInViewport();
    await page.screenshot({ path: `test-results/closed/${vp.name}-scrolled.png` });
  });
