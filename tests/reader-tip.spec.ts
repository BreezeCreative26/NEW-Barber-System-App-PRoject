// Checkout on the shop's own card reader (Revolut) asks whether a tip was added on the machine,
// and won't complete until it's answered. The tip is recorded against the barber on the READER row.
import { test, expect } from "@playwright/test";
import { openFixtureShop, base, origin } from "./fixture";

async function todayBooking(page: any, name: string) {
  const r = page.request;
  const w = await (await r.get(base + "/workspace")).json();
  const st = w.staff.find((s: any) => s.active);
  const svc = w.services.find((s: any) => s.price_pence > 0);
  let date = "", slot: any = null, quote: unknown, ahead = 0;
  for (let i = 0; i < 12 && !slot; i++) {
    const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); date = d.toISOString().slice(0, 10);
    const a = await (await r.get(base + `/availability?date=${date}&staff_id=${st.id}&service_id=${svc.id}`)).json();
    slot = (a.slots || []).find((s: any) => !s.reason && !s.outside && !s.taken); quote = a.quote; ahead = i;
  }
  const made = await r.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: st.id, service_id: svc.id, date, start_min: slot.start_min, customer_name: name, phone: "07700900781", source: "TEST_BOOKING", quote } });
  expect(made.status(), await made.text()).toBe(201);
  const b = (await made.json()).booking;
  await page.reload(); await page.waitForLoadState("networkidle");
  for (let i = 0; i < ahead; i++) { await page.getByRole("button", { name: "Next day" }).click(); await page.waitForTimeout(400); }
  await page.getByRole("button", { name: new RegExp("^" + name) }).first().click();
  await page.getByTestId("take-payment").click();
  return b;
}

test("card reader checkout asks about a tip; yes + amount records it on the reader payment", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureShop(page, "owner");
  const b = await todayBooking(page, "Reader Tip Yes");
  const co = page.getByTestId("checkout");
  await co.getByTestId("method-reader").click();
  await expect(co.getByTestId("reader-tip")).toContainText("Was a tip added on the card reader?");
  // The general tip chips are replaced by the question.
  await expect(co.locator(".checkout-tips")).toHaveCount(0);
  const btn = co.getByTestId("record-payment");
  await expect(btn).toBeDisabled();
  await expect(btn).toContainText("Answer the tip question first");
  await co.getByTestId("reader-tip-yes").click();
  await expect(btn).toBeDisabled();
  await co.getByTestId("reader-tip-amount").fill("3");
  await expect(btn).toBeEnabled();
  await expect(btn).toContainText(`£${((b.price_pence + 300) / 100).toFixed(2).replace(/\.00$/, "")}`);
  await page.screenshot({ path: "test-results/reader-tip.png" });
  await btn.click();
  await expect.poll(async () => (await (await page.request.get(base + `/bookings/${b.id}`)).json()).booking.status).toBe("COMPLETED");
  const pays = (await (await page.request.get(base + "/workspace")).json()).payments.filter((p: any) => p.booking_id === b.id && !p.voided_at);
  expect(pays).toHaveLength(1);
  expect(pays[0]).toMatchObject({ method: "READER", service_pence: b.price_pence, tip_pence: 300 });
});

test("card reader checkout: 'No tip' records the reader payment with no tip", async ({ page }) => {
  test.setTimeout(120000);
  await openFixtureShop(page, "owner");
  const b = await todayBooking(page, "Reader Tip No");
  const co = page.getByTestId("checkout");
  await co.getByTestId("method-reader").click();
  await co.getByTestId("reader-tip-no").click();
  await co.getByTestId("record-payment").click();
  await expect.poll(async () => (await (await page.request.get(base + `/bookings/${b.id}`)).json()).booking.status).toBe("COMPLETED");
  const pays = (await (await page.request.get(base + "/workspace")).json()).payments.filter((p: any) => p.booking_id === b.id && !p.voided_at);
  expect(pays[0]).toMatchObject({ method: "READER", tip_pence: 0 });
});
