// Slim staff booking form: customer first, Walk-in button, extras folded into "More options".
import { test, expect } from "@playwright/test";
import { openFixtureShop } from "./fixture";

test("walk-in button books with no customer and no messages; More options shows what's set", async ({ page }) => {
  test.setTimeout(90000);
  await openFixtureShop(page);
  const w = await (await page.request.get("/api/app/workspace")).json();
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  const dialog = page.getByRole("dialog");
  // Customer comes first, and the clutter is gone.
  const headings = await dialog.locator(".booking-slim h3").allInnerTexts();
  expect(headings[0].toLowerCase()).toContain("customer");
  await expect(dialog.getByLabel("Booking source")).toHaveCount(0);
  await expect(dialog.getByText("Times are Europe/London")).toHaveCount(0);
  // Extras are folded away until asked for.
  await expect(dialog.getByLabel("Notes", { exact: true })).toBeHidden();
  await dialog.getByTestId("booking-more-toggle").click();
  await dialog.getByLabel("Notes", { exact: true }).fill("Likes it short");
  await expect(dialog.getByTestId("booking-more-toggle")).toContainText("Note");
  // Walk-in: no name or number asked for.
  await dialog.getByTestId("booking-walkin").click();
  await expect(dialog.getByTestId("booking-walkin-note")).toBeVisible();
  await expect(dialog.getByLabel("Customer name", { exact: true })).toHaveCount(0);
  let picked = "";
  for (let i = 1; i < 10 && !picked; i++) {
    const d = new Date(w.today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    await dialog.getByLabel("Booking date").fill(d.toISOString().slice(0, 10));
    await page.waitForTimeout(400);
    const vals = await dialog.getByLabel("Available start time").locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    if (vals.length) { picked = vals[0]; await dialog.getByLabel("Available start time").selectOption(picked); }
  }
  expect(picked).not.toBe("");
  await dialog.getByRole("button", { name: "Review appointment" }).click();
  await dialog.getByRole("button", { name: "Confirm booking" }).click();
  await expect(dialog).toBeHidden();
  const after = await (await page.request.get(`/api/app/bookings/range?from=${w.today}&to=${(() => { const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 12); return d.toISOString().slice(0, 10); })()}`)).json();
  const mine = after.bookings.find((b: { customer_name: string; start_min: number }) => b.customer_name === "Walk-in" && String(b.start_min) === picked);
  expect(mine).toBeTruthy();
});
