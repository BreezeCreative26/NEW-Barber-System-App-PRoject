// OLLO invoicing without Stripe: period close, credits carried, amend, pay, credit notes, void,
// write-off, dunning; plus shop lifecycle (sign-in link, suspend) and the owner-visible record.
import { test, expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { base, origin, openFixtureShop } from "./fixture";

const H = { Origin: origin };
function psql(sqlText: string) {
  const url = readFileSync("/home/user/webapp/.env.local", "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="))!.slice("DATABASE_URL=".length);
  return execSync(`psql "${url}" -Atc "${sqlText.replace(/"/g, '\\"')}"`).toString().trim();
}
async function api(page: Page, method: string, path: string, data?: unknown) {
  const r = await page.request.fetch(origin + "/api/admin" + path, { method, headers: H, data });
  return { status: r.status(), body: (await r.json().catch(() => ({}))) as any };
}

test("invoicing: period close with credits, amend, pay, credit note, dunning, void, write-off", async ({ page }) => {
  const fx = await openFixtureShop(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  psql(`INSERT INTO platform_admins(user_id,role,created_by,created_at) VALUES('${w.account.user_id}','SUPER','test',${Date.now()}) ON CONFLICT(user_id) DO UPDATE SET role='SUPER'`);

  // Trials are not invoiced.
  let r = await api(page, "POST", `/shops/${fx.shop_id}/invoices`, { kind: "PERIOD", period: "2026-08", reason: "close on trial" });
  expect(r.status).toBe(409);

  // Activate offline, add a credit and a one-off charge, close August.
  await api(page, "POST", `/shops/${fx.shop_id}/subscription`, { action: "MARK_ACTIVE", reason: "Paying by bank transfer" });
  await api(page, "POST", `/shops/${fx.shop_id}/adjustments`, { kind: "CREDIT", amount_pence: 1000, reason: "Goodwill for downtime" });
  await api(page, "POST", `/shops/${fx.shop_id}/adjustments`, { kind: "CHARGE", amount_pence: 2500, reason: "Setup & data import" });
  r = await api(page, "POST", `/shops/${fx.shop_id}/invoices`, { kind: "PERIOD", period: "2026-08", reason: "August close" });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const inv = r.body.invoice;
  const active = w.staff.filter((s: any) => s.active).length;
  const expectedSub = 2499 + Math.max(0, active - 1) * 799 + 2500;
  expect(inv.subtotal_pence).toBe(expectedSub);
  expect(inv.credit_applied_pence).toBe(1000);
  expect(inv.total_pence).toBe(expectedSub - 1000);
  expect(inv.status).toBe("OPEN");
  expect(inv.number).toMatch(/^OLLO-\d+$/);
  // Idempotent per period.
  r = await api(page, "POST", `/shops/${fx.shop_id}/invoices`, { kind: "PERIOD", period: "2026-08", reason: "again" });
  expect(r.status).toBe(409);

  // Printable copy by token only.
  const html = await (await page.request.get(origin + `/invoice/${inv.id}?t=${inv.view_token}`)).text();
  expect(html).toContain(inv.number);
  expect(html).toContain("No VAT is charged");
  expect((await page.request.get(origin + `/invoice/${inv.id}?t=wrong`)).status()).toBe(404);

  // Amend an open invoice, part-pay then settle → status PAID, timeline updated.
  r = await api(page, "PUT", `/invoices/${inv.id}/lines`, { lines: [...JSON.parse(inv.lines_json), { label: "Extra training", amount_pence: 5000 }], reason: "Missed the training line" });
  expect(r.status).toBe(200);
  expect(r.body.invoice.total_pence).toBe(inv.total_pence + 5000);
  r = await api(page, "POST", `/invoices/${inv.id}/pay`, { amount_pence: 2000, via: "bank_transfer", ref: "FPS1", reason: "Part payment received" });
  expect(r.body.invoice.status).toBe("OPEN");
  expect(r.body.invoice.paid_pence).toBe(2000);
  r = await api(page, "POST", `/invoices/${inv.id}/pay`, { via: "bank_transfer", ref: "FPS2", reason: "Balance received" });
  expect(r.body.invoice.status).toBe("PAID");
  expect(r.body.invoice.paid_pence).toBe(r.body.invoice.total_pence);
  // Paid invoices cannot be voided; they get credit notes.
  expect((await api(page, "POST", `/invoices/${inv.id}/void`, { reason: "Trying anyway" })).status).toBe(409);
  r = await api(page, "POST", `/invoices/${inv.id}/credit-note`, { amount_pence: 1500, refund: { via: "bank_transfer", ref: "R1" }, reason: "Overcharged training" });
  expect(r.status).toBe(201);
  expect(r.body.credit_note.number).toMatch(/CN-/);
  r = await api(page, "POST", `/invoices/${inv.id}/credit-note`, { amount_pence: 500, reason: "Goodwill, kept as credit" });
  expect(r.status).toBe(201);
  // Owner's Billing tab reflects it.
  let bill = await (await page.request.get(base + "/billing")).json();
  expect(bill.credit_pence).toBe(500);
  expect(bill.invoices.length).toBe(3);

  // Manual invoice → overdue → dunning flips to PAST_DUE → paying clears it.
  r = await api(page, "POST", `/shops/${fx.shop_id}/invoices`, { kind: "MANUAL", lines: [{ label: "Chair hardware", amount_pence: 12000 }], due_days: 0, reason: "Hardware sold" });
  const man = r.body.invoice;
  expect(man.total_pence).toBe(12000);
  psql(`UPDATE invoices SET due_at=${Date.now() - 86400000} WHERE id='${man.id}'`);
  r = await api(page, "POST", `/invoices/dunning`, {});
  expect(r.body.flipped).toBeGreaterThanOrEqual(1);
  let sub = (await (await page.request.get(base + "/workspace")).json()).entitlements.subscription;
  expect(sub.status).toBe("PAST_DUE");
  await api(page, "POST", `/invoices/${man.id}/pay`, { via: "card", reason: "Paid over the phone" });
  sub = (await (await page.request.get(base + "/workspace")).json()).entitlements.subscription;
  expect(sub.status).toBe("ACTIVE");

  // Void and write-off.
  r = await api(page, "POST", `/shops/${fx.shop_id}/invoices`, { kind: "MANUAL", lines: [{ label: "Mistake", amount_pence: 100 }], reason: "Testing void" });
  expect((await api(page, "POST", `/invoices/${r.body.invoice.id}/void`, { reason: "Issued by mistake" })).body.invoice.status).toBe("VOID");
  r = await api(page, "POST", `/shops/${fx.shop_id}/invoices`, { kind: "MANUAL", lines: [{ label: "Bad debt", amount_pence: 300 }], reason: "Testing write-off" });
  expect((await api(page, "POST", `/invoices/${r.body.invoice.id}/write-off`, { reason: "Shop closed down" })).body.invoice.status).toBe("UNCOLLECTIBLE");

  // Admin UI: invoices page shows stats and rows; shop Billing tab lists them.
  await page.evaluate(() => sessionStorage.removeItem("admin.invoices.status"));
  await page.goto("/admin/invoices");
  await expect(page.getByTestId("admin-invoice-stats")).toBeVisible();
  await page.getByLabel("Search invoices").fill(inv.number);
  await expect(page.getByTestId("admin-invoice-row")).toHaveCount(1);
  await expect(page.getByTestId("admin-invoice-row")).toContainText("Paid");
  await page.goto(`/admin/shops/${fx.shop_id}`);
  await page.getByRole("tab", { name: "Billing" }).click();
  await expect(page.getByTestId("admin-invoice-row")).toHaveCount(6);
});

test("lifecycle: one-time sign-in link, suspension blocks writes and hides the public page, owner sees the record", async ({ page, browser }) => {
  const fx = await openFixtureShop(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  psql(`INSERT INTO platform_admins(user_id,role,created_by,created_at) VALUES('${w.account.user_id}','SUPER','test',${Date.now()}) ON CONFLICT(user_id) DO UPDATE SET role='SUPER'`);

  // Sign-in link works once, in a fresh browser.
  let r = await api(page, "POST", `/shops/${fx.shop_id}/signin-link`, { reason: "Owner locked out", reveal: true });
  expect(r.status).toBe(200);
  expect(r.body.link).toContain("/api/admin-public/signin?token=");
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.goto(r.body.link);
  await expect(p2.getByRole("button", { name: "New booking", exact: true })).toBeVisible();
  const reuse = await p2.request.get(r.body.link, { maxRedirects: 0 });
  expect(reuse.headers()["location"]).toContain("link=expired");
  await ctx.close();

  // Account edit without impersonating.
  r = await api(page, "PUT", `/shops/${fx.shop_id}/account`, { owner_name: "Sam O.", reason: "Name typo fix" });
  expect(r.status).toBe(200);

  // Owner sees the support record on their Billing tab.
  await page.goto("/workspace");
  await page.getByRole("navigation", { name: "Workspace sections" }).getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("settings-tab-billing").click();
  await expect(page.getByTestId("billing-support-access")).toContainText("Owner locked out");
  await expect(page.getByTestId("billing-support-access")).toContainText("Name typo fix");

  // Suspend: public page 404s, owner writes 403, reads still work. Lift restores.
  expect((await page.request.get(origin + `/api/public/shops/${fx.slug}`)).status()).toBe(200);
  // A fresh sign-in link minted before suspension lets us get an owner session afterwards
  // (suspension signs every existing session out, including the admin's own owner session here).
  const link = (await api(page, "POST", `/shops/${fx.shop_id}/signin-link`, { reason: "Pre-suspension check", reveal: true })).body.link as string;
  r = await api(page, "POST", `/shops/${fx.shop_id}/suspend`, { suspend: true, reason: "Chargeback investigation" });
  expect(r.status).toBe(200);
  expect((await page.request.get(origin + `/api/public/shops/${fx.slug}`)).status()).toBe(404);
  const ctx2 = await browser.newContext();
  const p3 = await ctx2.newPage();
  await p3.goto(link);
  await p3.waitForURL(/\/workspace/);
  expect((await p3.request.get(base + "/workspace")).status()).toBe(200); // reads OK
  const blocked = await p3.request.post(base + "/bookings", { headers: H, data: {} });
  expect(blocked.status()).toBe(403);
  expect((await blocked.json()).error).toBe("shop_suspended");
  await ctx2.close();
  psql(`UPDATE shops SET suspended_at=NULL, suspended_reason='' WHERE id='${fx.shop_id}'`);
  expect((await page.request.get(origin + `/api/public/shops/${fx.slug}`)).status()).toBe(200);
});
