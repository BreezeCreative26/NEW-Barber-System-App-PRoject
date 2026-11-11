// The wallet chip is the wallet, not a day: stepping through the calendar never changes it.
// It only moves when money is recorded or a pay run is marked paid.
import { test, expect } from "@playwright/test";
import { openFixtureShop, base } from "./fixture";

test("wallet chip stays the same when moving to other days in the calendar", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFixtureShop(page);
  const ws = await (await page.request.get(base + "/workspace")).json();
  const pence = (t: string) => Math.round(Number(t.replace(/[£,]/g, "")) * 100);
  const chip = page.getByTestId("wallet-chip");
  await expect.poll(async () => pence(await chip.locator("b").innerText())).toBe(ws.wallet_open.total);
  const before = (await chip.getAttribute("aria-label")) ?? "";
  expect(before).toContain("Owed");
  await expect(chip).toContainText("Owed");
  for (const dir of ["Next day", "Next day", "Previous day", "Previous day", "Previous day"]) {
    await page.getByRole("button", { name: dir }).first().click();
    await page.waitForTimeout(300);
    await expect(chip).toHaveAttribute("aria-label", before);
  }
  // The drawer opens on the wallet (Unpaid), whatever day the calendar is on.
  await chip.click();
  await expect(page.getByTestId("wallet-drawer").getByTestId("wallet-hero")).toContainText("Unpaid");
});
