import { test, expect } from "@playwright/test";
const HOST = "demo-a98c90f1.localhost:3000";
test("customer sign-in keeps focus while typing and exposes autofill hints", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-host": HOST } });
  const p = await ctx.newPage();
  await p.goto("http://localhost:3000/me");
  const email = p.getByTestId("signin-email");
  const pw = p.getByTestId("signin-password");
  await email.click();
  await p.keyboard.type("jamie@example.com");
  await expect(email).toHaveValue("jamie@example.com");
  await expect(email).toHaveAttribute("autocomplete", "username");
  await pw.click();
  await p.keyboard.type("Secret123!");
  await expect(pw).toHaveValue("Secret123!");
  await expect(pw).toHaveAttribute("autocomplete", "current-password");
  await ctx.close();
});
