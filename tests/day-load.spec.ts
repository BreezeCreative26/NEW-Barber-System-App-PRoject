// Changing day on the timetable reads only that day's appointments, not the whole workspace, and a
// day already seen (or the neighbour that was pre-loaded) shows straight away while it re-checks.
import { test, expect } from "@playwright/test";
import { openFixtureShop } from "./fixture";

test("next / previous day reads only the day, never the whole workspace", async ({ page }) => {
  await openFixtureShop(page);
  const hits: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/app/")) hits.push(u.pathname + (u.pathname.endsWith("/bookings") ? `?date=${u.searchParams.get("date")}` : ""));
  });
  const dateInput = page.getByLabel("Appointment date", { exact: true });
  const start = await dateInput.inputValue();

  await page.getByRole("button", { name: "Next day", exact: true }).click();
  await expect(dateInput).not.toHaveValue(start);
  const next = await dateInput.inputValue();
  await expect.poll(() => hits.some((h) => h === `/api/app/bookings?date=${next}`)).toBe(true);
  expect(hits.filter((h) => h === "/api/app/workspace"), "no full workspace read on a day change").toEqual([]);

  // Back to the first day: it was read before, so the calendar is ready immediately (no loading state).
  hits.length = 0;
  await page.getByRole("button", { name: "Previous day", exact: true }).click();
  await expect(dateInput).toHaveValue(start);
  await expect(page.locator('[aria-busy="true"]').filter({ hasText: /Loading/i })).toHaveCount(0);
  expect(hits.filter((h) => h === "/api/app/workspace")).toEqual([]);
});
