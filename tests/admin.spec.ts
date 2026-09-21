// OLLO master admin: hidden from non-admins, full control for SUPER admins.
import { test, expect, type Page } from "@playwright/test";
import { base, origin, openFixtureShop } from "./fixture";

async function promoteToSuper(page: Page) {
  const w = await (await page.request.get(base + "/workspace")).json();
  const pg = await import("node:child_process");
  const url = (await import("node:fs")).readFileSync("/home/user/webapp/.env.local", "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="))!.slice("DATABASE_URL=".length);
  pg.execSync(`psql "${url}" -Atc "INSERT INTO platform_admins(user_id,role,created_by,created_at) VALUES('${w.account.user_id}','SUPER','test',${Date.now()}) ON CONFLICT(user_id) DO UPDATE SET role='SUPER'"`);
  return w;
}

test("admin: non-admins get 404, super admin can extend trials, grant features, discount and impersonate", async ({ page }) => {
  const fx = await openFixtureShop(page);

  // 1. A plain shop owner sees nothing — API and page both 404.
  expect((await page.request.get(origin + "/api/admin/me")).status()).toBe(404);
  await page.goto("/admin");
  await expect(page.getByText("Not found")).toBeVisible();

  // 2. Promote and open the console.
  const w = await promoteToSuper(page);
  await page.goto("/admin");
  await expect(page.getByTestId("admin-overview")).toBeVisible();
  await expect(page.locator(".admin-tile")).toHaveCount(8);
  await expect(page.getByTestId("admin")).toContainText("not charging VAT");

  // 3. Shop detail → extend trial by 30 days (reason required, audited).
  await page.goto(`/admin/shops/${fx.shop_id}`);
  await expect(page.getByTestId("admin-shop")).toBeVisible();
  await expect(page.getByTestId("admin-shop")).toContainText(w.shop.name);
  await page.getByRole("tab", { name: "Billing" }).click();
  await page.getByRole("button", { name: "Extend trial" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.locator('[name="days"]').fill("30");
  await dlg.getByRole("button", { name: "Extend" }).click();
  await expect(dlg).toBeVisible(); // empty reason → browser validation keeps it open
  const short = await page.request.post(origin + `/api/admin/shops/${fx.shop_id}/subscription`, { headers: { Origin: origin }, data: { action: "EXTEND_TRIAL", days: 30, reason: "ok" } });
  expect(short.status()).toBe(400); // server enforces the reason too
  await dlg.locator('[name="reason"]').fill("Owner asked for more time");
  await dlg.getByRole("button", { name: "Extend" }).click();
  await expect(dlg).toBeHidden();
  const before = w.entitlements.subscription.trial_ends_at as number;
  const after = (await (await page.request.get(base + "/workspace")).json()).entitlements.subscription.trial_ends_at as number;
  expect(after - before).toBeGreaterThanOrEqual(29 * 86400_000);

  // 4. Grant AI Concierge free → shop's estimate shows it complimentary.
  await page.getByRole("tab", { name: "Features" }).click();
  const row = page.getByTestId("admin-features").locator("tr").filter({ hasText: "AI Concierge" });
  await row.getByRole("button", { name: "Grant" }).click();
  await dlg.locator('[name="reason"]').fill("Launch partner — free for 3 months");
  await dlg.getByRole("button", { name: "Grant free" }).click();
  await expect(row.locator("code").first()).toHaveText("ADMIN_GRANT");
  const bill = await (await page.request.get(base + "/billing")).json();
  const line = bill.lines.find((l: any) => l.label === "AI Concierge");
  expect(line?.amount_pence).toBe(0);
  expect(line?.detail).toContain("complimentary");
  expect((await (await page.request.get(base + "/workspace")).json()).entitlements.features.ai_concierge?.enabled).toBe(true);

  // 5. Support note + audit trail.
  await page.getByRole("tab", { name: "Support" }).click();
  await page.getByLabel("New note").fill("Called owner, walked through Shifts.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.locator(".admin-notes li")).toHaveCount(1);
  // Admin actions are audited alongside the notes on the Support tab.
  await expect(page.getByTestId("admin-shop")).toContainText("Owner asked for more time");
  await expect(page.getByTestId("admin-shop")).toContainText("Launch partner");
  await page.getByRole("tab", { name: "Audit" }).click();
  await expect(page.getByTestId("admin-shop").locator(".billing-timeline")).toBeVisible();

  // 6. Discount code: create in the catalogue, apply to this shop, estimate drops.
  const code = "T" + fx.shop_id.replace(/-/g, "").slice(0, 8).toUpperCase();
  const mk = await page.request.post(origin + "/api/admin/catalogue/discounts", { headers: { Origin: origin }, data: { code, name: "Test offer", kind: "PERCENT", value: 50, reason: "Automated test" } });
  expect(mk.status(), await mk.text()).toBeLessThan(300);
  const ap = await page.request.post(origin + `/api/admin/shops/${fx.shop_id}/discounts`, { headers: { Origin: origin }, data: { code, reason: "Launch partner shop" } });
  expect(ap.status(), await ap.text()).toBe(200);
  const est = (await ap.json()).estimate;
  expect(est.discount_pence).toBeGreaterThan(0);
  expect(est.total_pence).toBe(est.subtotal_pence - est.discount_pence);

  // 7. Impersonate → owner workspace with the red support bar.
  await page.goto(`/admin/shops/${fx.shop_id}`);
  await page.getByRole("button", { name: "Open as owner" }).click();
  await dlg.locator('[name="reason"]').fill("Reproducing a calendar issue");
  await dlg.getByRole("button", { name: /Open workspace/ }).click();
  await page.waitForURL(/\/workspace/);
  await expect(page.getByTestId("impersonation-bar")).toContainText("OLLO support session");

  // 8. The other admin pages render.
  for (const [path, tid] of [["/admin/invoices", "admin-invoices"], ["/admin/ops", "admin-ops"], ["/admin/team", "admin-team"]] as const) {
    await page.goto(path);
    await expect(page.getByTestId(tid)).toBeVisible();
  }
});
