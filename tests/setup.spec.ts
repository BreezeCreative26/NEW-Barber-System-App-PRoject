import { test, expect } from "@playwright/test";
const origin = "http://localhost:3000";
test("shop setup: signup → 7-step wizard → done; invite accepted by SMS+email link; forgot/reset password", async ({ page }) => {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 200)); });
  await page.goto(origin + "/signup");
  await page.getByTestId("signup-kind-HAIR").click();
  await page.fill('input[name="shop_name"]', "Wizard Test Shop");
  await page.fill('input[name="name"]', "Wanda Owner");
  const email = `wiz-${Date.now()}@example.com`;
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "Passw0rd!passw0rd");
  await page.getByRole("button", { name: "Create shop" }).click();
  await expect(page.getByTestId("setup-wizard")).toBeVisible({ timeout: 15000 });
  expect(page.url()).toContain("/workspace/setup");
  
  // Step 1
  await page.getByTestId("setup-shop-phone").fill("07700 900123");
  await page.getByTestId("setup-save-contact").click();
  await expect(page.getByTestId("verify-send-PHONE")).toBeVisible();
  await page.getByTestId("verify-send-PHONE").click();
  const code = await page.getByTestId("sandbox-code-PHONE").textContent();
  await page.getByTestId("verify-code-PHONE").fill(code!);
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("verified-PHONE")).toBeVisible();
  
  await page.getByTestId("setup-next").click();
  // Step 2 hours
  await expect(page.getByRole("heading", { name: "Opening hours" })).toBeVisible();
  
  await page.getByTestId("setup-next").click();
  // Step 3 services
  await expect(page.getByTestId("setup-starter-menu")).toBeVisible();
  
  await page.getByTestId("setup-next").click();
  // Step 4 team
  await expect(page.getByTestId("setup-team-list")).toBeVisible();
  await page.getByTestId("setup-add-name").fill("Marcus Reed");
  await page.getByTestId("setup-add-staff").click();
  await expect(page.getByText("Marcus Reed")).toBeVisible();
  const inviteBtn = page.locator('[data-testid^="invite-"]').filter({ hasText: "Invite" }).first();
  await inviteBtn.click();
  await page.getByTestId("invite-email").fill("marcus@example.com");
  await page.getByTestId("invite-phone").fill("07700 900456");
  await page.getByTestId("invite-channel").selectOption("BOTH");
  await page.getByTestId("invite-send").click();
  await expect(page.getByTestId("invite-link")).toBeVisible();
  
  const link = await page.getByTestId("invite-link").locator("input").inputValue();
  console.log("INVITE", link);
  await page.getByTestId("setup-next").click();
  // Step 5 messages
  await expect(page.getByTestId("setup-sms-sender")).toBeVisible();
  await page.getByTestId("setup-test-sms").click();
  await expect(page.getByTestId("setup-test-result")).toBeVisible();
  
  await page.getByTestId("setup-next").click();
  // Step 6 online
  await expect(page.getByTestId("setup-slug")).toBeVisible();
  await page.waitForTimeout(600);
  
  await page.getByTestId("setup-next").click();
  // Step 7 payments
  await expect(page.getByTestId("pay-mode-DEPOSIT")).toBeVisible();
  
  await page.getByTestId("setup-next").click();
  await expect(page.getByTestId("setup-done")).toBeVisible();
  
  await page.getByTestId("setup-open-calendar").click();
  await expect(page.getByTestId("setup-banner")).toHaveCount(0);
  // Invite accept in new context
  const ctx2 = await page.context().browser()!.newContext();
  const p2 = await ctx2.newPage();
  p2.on("pageerror", (e) => console.log("PAGEERROR2", e.message));
  await p2.goto(link);
  await expect(p2.getByTestId("invite-peek")).toBeVisible();
  
  await p2.fill('input[name="name"]', "Marcus Reed");
  await p2.fill('input[name="password"]', "Passw0rd!passw0rd");
  await p2.getByRole("button", { name: "Join the team" }).click();
  await expect(p2.locator("#workspace-main")).toBeVisible();
  await p2.waitForTimeout(1500);
  
  // Forgot password
  const ctx3 = await page.context().browser()!.newContext();
  const p3 = await ctx3.newPage();
  await p3.goto(origin + "/signin");
  await p3.getByTestId("forgot-link").click();
  await p3.fill('input[name="email"]', email);
  await p3.getByRole("button", { name: "Send reset link" }).click();
  await expect(p3.getByTestId("forgot-sent")).toBeVisible();
  
  const rl = p3.getByTestId("sandbox-reset-link");
  if (await rl.count()) {
    await rl.click();
    await expect(p3.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await p3.fill('input[name="password"]', "NewPassw0rd!newpass");
    await p3.getByRole("button", { name: "Set password and sign in" }).click();
    await expect(p3.locator("#workspace-main")).toBeVisible();
    await p3.waitForTimeout(1200);
    
  } else console.log("NO SANDBOX RESET LINK (DEMO_ENABLED off?)");
});
