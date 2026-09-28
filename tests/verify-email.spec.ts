import { test, expect, request } from "@playwright/test";
const origin = "http://localhost:3000";

test("signup → welcome email in outbox (as foliyo) → nudge → confirm on /verify → nudge gone; used/bad tokens refused; resend rate-limited", async ({ page }) => {
  const email = `verify-${Date.now()}@example.com`;
  await page.goto(origin + "/signup");
  await page.fill('input[name="shop_name"]', "Verify Test Shop");
  await page.fill('input[name="name"]', "Vera Owner");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "Passw0rd!passw0rd");
  await page.getByTestId("accept-legal").locator("input").check();
  await page.getByRole("button", { name: "Create shop" }).click();
  await expect(page.getByTestId("setup-wizard")).toBeVisible({ timeout: 15000 });

  // Outbox has the welcome, sent as the platform (foliyo), with a /verify link.
  const api = await request.newContext({ baseURL: origin, storageState: await page.context().storageState(), extraHTTPHeaders: { Origin: origin } });
  const outbox = await (await api.get("/api/app/notifications")).json();
  const welcome = outbox.notifications.find((n: { template: string }) => n.template === "owner_welcome");
  expect(welcome, "owner_welcome queued").toBeTruthy();
  expect(welcome.channel).toBe("EMAIL");
  expect(welcome.recipient).toBe(email);
  expect(welcome.subject).toMatch(/^Welcome to foliyo/);
  expect(welcome.body).toContain("/verify?token=");
  const token = welcome.body.match(/\/verify\?token=([A-Za-z0-9-]+)/)![1];

  // Nudge shows on the calendar (setup left for later).
  await page.goto(origin + "/workspace");
  await expect(page.getByTestId("verify-nudge")).toBeVisible({ timeout: 15000 });

  // Resend straight after signup is rate-limited (the welcome went out < 1 min ago); the
  // original token stays live.
  const r1 = await api.post("/api/app/auth/verify-email/resend", { data: {} });
  expect(r1.status()).toBe(429);
  expect((await api.get(`/api/app/auth/verify-email/peek?token=${token}`)).status()).toBe(200);
  const token2 = token;

  // Confirm in a fresh, signed-out browser (as if from a phone mail app).
  const other = await page.context().browser()!.newContext();
  const p2 = await other.newPage();
  await p2.goto(`${origin}/verify?token=${token2}`);
  await expect(p2.getByTestId("verify-page")).toBeVisible();
  await expect(p2.getByText(email)).toBeVisible();
  await p2.getByTestId("verify-confirm").click();
  await expect(p2.getByTestId("verify-done")).toBeVisible();
  await expect(p2.getByTestId("verify-continue")).toHaveText("Sign in");
  // Second use is refused.
  const again = await api.post("/api/app/auth/verify-email", { data: { token: token2 } });
  expect(again.status()).toBe(409);
  const bad = await api.post("/api/app/auth/verify-email", { data: { token: "x".repeat(70) } });
  expect(bad.status()).toBe(409);
  await other.close();

  // Nudge gone; account reports verified; audit has EMAIL_VERIFIED.
  await page.reload();
  await expect(page.getByTestId("getting-started").or(page.getByTestId("calendar"))).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("verify-nudge")).toHaveCount(0);
  const me = await (await api.get("/api/app/auth/me")).json();
  expect(me.account.email_verified_at).toBeTruthy();
  const w = await (await api.get("/api/app/workspace")).json();
  expect(w.audit.some((a: { action: string }) => a.action === "EMAIL_VERIFIED")).toBe(true);
  const already = await api.post("/api/app/auth/verify-email/resend", { data: {} });
  expect((await already.json()).already).toBe(true);
});
