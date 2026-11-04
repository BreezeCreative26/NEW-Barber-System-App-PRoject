// Desktop: clicking anywhere on the timetable date chip opens the calendar (like a tap on a phone),
// and picking a date moves the timetable.
import { test, expect } from "@playwright/test";
import { openFixtureShop } from "./fixture";

test.use({ viewport: { width: 1440, height: 900 } });

test("desktop date chip opens the calendar on click and changes the day", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __pickers: string[] }).__pickers = [];
    HTMLInputElement.prototype.showPicker = function () {
      (window as unknown as { __pickers: string[] }).__pickers.push(this.getAttribute("aria-label") || this.type);
    };
  });
  await openFixtureShop(page);
  const chip = page.locator(".calendar-toolbar-row .toolbar-date");
  await expect(chip).toBeVisible();
  const opened = () => page.evaluate(() => (window as unknown as { __pickers: string[] }).__pickers.length);
  // Keyboard: Enter on the focused chip opens the calendar.
  await page.getByTestId("toolbar-date-input").focus();
  await page.keyboard.press("Enter");
  await expect.poll(opened).toBe(1);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  // Mouse: clicking the text (not the browser's tiny calendar icon) opens it too.
  const b = (await chip.boundingBox())!;
  await page.mouse.click(b.x + 20, b.y + b.height / 2);
  await expect.poll(opened).toBeGreaterThan(1);
  expect(await page.evaluate(() => (window as unknown as { __pickers: string[] }).__pickers)).toContain("Appointment date");
  await page.keyboard.press("Escape");
  // Choosing a date still moves the timetable.
  const w = await (await page.request.get("/api/app/workspace")).json();
  const d = new Date(w.today + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 3);
  const target = d.toISOString().slice(0, 10);
  await page.getByTestId("toolbar-date-input").fill(target);
  await expect(chip).toContainText(String(d.getUTCDate()));
});
