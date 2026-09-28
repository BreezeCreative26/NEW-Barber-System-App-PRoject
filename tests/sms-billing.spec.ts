// Texts are billable: the owner must accept the per-text price once; the running bill itemises usage.
import { test, expect } from "@playwright/test";
import { base, origin, openFixtureShop, section } from "./fixture";

test("switching texts on requires accepting the per-text price once; sender field guides; running bill renders", async ({ page }) => {
  await openFixtureShop(page);
  const before = await (await page.request.get(base + "/notifications")).json();
  expect(before.sms_billing.unit_pence).toBe(8);
  const put = (body: Record<string, unknown>) => page.request.put(base + "/shop/messaging", { headers: { Origin: origin }, data: { msg_sms: 1, msg_email: 1, msg_wa: 1, msg_reminders: 1, msg_reminder_hours: 24, msg_reply_to: "", msg_sms_sender: "Northline", ...body } });
  if (!before.sms_billing.acknowledged_at) {
    // Without the acknowledgement, texts can't be switched on.
    const r1 = await put({});
    expect(r1.status()).toBe(409);
    // Texts off is always fine.
    expect((await put({ msg_sms: 0 })).ok()).toBeTruthy();
    // With it, saved and remembered.
    expect((await put({ sms_billing_ack: true })).ok()).toBeTruthy();
  }
  const after = await (await page.request.get(base + "/notifications")).json();
  expect(after.sms_billing.acknowledged_at).toBeTruthy();
  // Second save needs no ack.
  expect((await put({ msg_sms_sender: "Northline" })).ok()).toBeTruthy();

  await section(page, "Settings/messages");
  await expect(page.getByTestId("msg-sms-billing-ack-done")).toContainText("8p each");
  const field = page.getByTestId("msg-sms-sender");
  await field.fill("J&K!");
  await expect(field).toHaveValue("JK");
  await expect(page.getByTestId("msg-sms-sender-note")).toContainText("at least 3");
  await page.getByTestId("msg-sms-sender-suggest").first().click();
  await expect(page.getByTestId("msg-sms-sender-note")).toContainText("Looks good");

  await section(page, "Settings/billing");
  await expect(page.getByTestId("running-bill")).toBeVisible();
  await expect(page.getByTestId("billing-total")).toContainText("£");
  await expect(page.getByTestId("rbill-forecast-total")).toContainText("£");
  const stmt = await (await page.request.get(base + "/billing/statement")).json();
  expect(stmt.period).toMatch(/^\d{4}-\d{2}$/);
  expect(stmt.due_at).toBeGreaterThan(stmt.closes_at);
  expect(Array.isArray(stmt.daily)).toBe(true);
  const csv = await page.request.get(base + "/billing/statement.csv");
  expect(csv.ok()).toBeTruthy();
  expect(await csv.text()).toContain("Date,Time,Type");
});
