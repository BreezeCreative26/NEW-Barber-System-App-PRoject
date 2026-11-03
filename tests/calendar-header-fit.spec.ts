// Barber column headings sit inside their fixed-height box at laptop widths: the hours chip goes
// under the name and nothing hangs below the header (it used to wrap to a third line at <=1280px).
import { test, expect } from "@playwright/test";
import { enterNewShop, base, origin } from "./shop";

const SIZES: [number, number][] = [[1024, 640], [1280, 650], [1366, 768], [1920, 1080]];
for (const density of ["COMPACT", "STANDARD", "LARGE"]) {
  test(`calendar barber header fits its box (${density})`, async ({ page }) => {
    test.setTimeout(120000);
    await enterNewShop(page, "Header fit");
    for (const n of ["Owen Holland", "Roan Tucker"])
      await page.request.post(base + "/staff", { headers: { Origin: origin }, data: { name: n, role: "Barber" } });
    await page.goto("/workspace");
    await page.evaluate((d) => localStorage.setItem("foliyo.prefs", JSON.stringify({ calendar_density: d })), density);
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      await page.reload();
      await expect(page.locator(".staff-column-heading").first()).toBeVisible();
      // Between 768px and 1180px the hours chip is hidden on purpose (hours stay in the ⋯ menu).
      if (w > 1180) await expect(page.locator(".staff-hours-chip").first()).toBeVisible();
      const m = await page.evaluate(() => {
        const hd = document.querySelector(".calendar-staff-header") as HTMLElement;
        const hb = hd.getBoundingClientRect();
        let worst = 0;
        hd.querySelectorAll(".staff-column-heading").forEach((c) => {
          const cb = c.getBoundingClientRect();
          c.querySelectorAll("*").forEach((k) => {
            const b = k.getBoundingClientRect();
            if (!b.width) return;
            worst = Math.max(worst, b.bottom - hb.bottom, hb.top - b.top, b.right - cb.right, cb.left - b.left);
          });
        });
        return { worst, content: hd.scrollHeight, box: hd.clientHeight };
      });
      expect(m.worst, `${density} ${w}x${h}: something hangs outside the header`).toBeLessThanOrEqual(1);
      expect(m.content, `${density} ${w}x${h}: header content taller than its box`).toBeLessThanOrEqual(m.box + 1);
    }
  });
}
