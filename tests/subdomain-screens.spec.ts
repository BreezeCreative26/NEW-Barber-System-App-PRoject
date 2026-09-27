// Screens for the sub-domain model on the Northline test shop (northline.localhost:3000).
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
const out = "docs/evidence/subdomain"; mkdirSync(out, { recursive: true });
const S = "http://northline.localhost:3000";
test.use({ viewport: { width: 1280, height: 800 } });
test("subdomain screen tour", async ({ page }) => {
  await page.goto(`${S}/`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Northline/);
  await page.screenshot({ path: `${out}/01-shop-home.png` });
  await page.goto(`${S}/signin`);
  await expect(page.getByTestId("auth-shop")).toBeVisible();
  await page.screenshot({ path: `${out}/02-team-signin.png` });
  await page.getByLabel("Email").fill("owner@northline.test");
  await page.getByLabel("Password").fill("Demo1234!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "New booking", exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/03-workspace.png` });
  await page.context().clearCookies();
  await page.goto("http://localhost:3000/signup");
  await page.getByLabel("Shop name").fill("Fade Society");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/04-signup-address.png` });
});
