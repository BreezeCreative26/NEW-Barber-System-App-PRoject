// A price can be set to £0 with no reason, and a £0 visit checks out with nothing taken.
import { test, expect } from "@playwright/test";
import { openFixtureShop, base, origin } from "./fixture";
test("price to £0 with no reason, then check out with nothing taken", async ({ page }) => {
  test.setTimeout(120000);
  await openFixtureShop(page, "owner");
  const r = page.request;
  const w = await (await r.get(base + "/workspace")).json();
  const st = w.staff.find((s: any) => s.active);
  const svc = w.services.find((s: any) => s.price_pence > 0);
  let date = "", start = -1, quote: unknown;
  for (let i = 1; i < 12 && start < 0; i++) {
    const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); date = d.toISOString().slice(0, 10);
    const a = await (await r.get(base + `/availability?date=${date}&staff_id=${st.id}&service_id=${svc.id}`)).json();
    const slot = (a.slots || []).find((s: any) => !s.reason && !s.outside && !s.taken);
    if (slot) { start = slot.start_min; quote = a.quote; }
  }
  const made = await r.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: st.id, service_id: svc.id, date, start_min: start, customer_name: "Free Cut Client", phone: "07700900777", source: "TEST_BOOKING", quote } });
  expect(made.status(), await made.text()).toBe(201);
  let b = (await made.json()).booking;
  // 1) Price → £0, no reason given.
  const ed = await r.patch(base + `/bookings/${b.id}/items`, { headers: { Origin: origin }, data: { service_id: svc.id, addon_ids: [], service_price_pence: 0, addon_prices: {}, version: b.version } });
  expect(ed.status(), await ed.text()).toBe(200);
  b = (await ed.json()).booking;
  expect(b.price_pence).toBe(0);
  // 2) Check out with nothing taken.
  const co = await r.post(base + `/bookings/${b.id}/checkout`, { headers: { Origin: origin }, data: { version: b.version, tenders: [], complete: true } });
  expect(co.status(), await co.text()).toBe(201);
  const out = await co.json();
  expect(out.booking.status).toBe("COMPLETED");
  // Logged as a £0 payment so the visit shows as paid and counts in the wallet.
  expect(out.payments.length).toBe(1);
  expect(out.payments[0]).toMatchObject({ method: "OTHER", service_pence: 0, tip_pence: 0 });
  const wallet = await (await r.get(base + `/wallet?from=${w.today}&to=${w.today}`)).json();
  expect(wallet.payments.some((p: any) => p.booking_id === b.id && p.service_pence === 0)).toBe(true);
  expect(wallet.totals.visits).toBeGreaterThanOrEqual(1);
  // Checking out again does not add a second £0 row.
  await r.post(base + `/bookings/${b.id}/checkout`, { headers: { Origin: origin }, data: { version: out.booking.version, tenders: [], complete: true } });
  const rows = (await (await r.get(base + "/workspace")).json()).payments.filter((p: any) => p.booking_id === b.id && !p.voided_at);
  expect(rows.length).toBe(1);
  // 3) A visit that still owes money can't be completed with nothing taken.
  const made2 = await r.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: st.id, service_id: svc.id, date, start_min: start + 120, customer_name: "Owes Money", phone: "07700900778", source: "TEST_BOOKING", quote } });
  if (made2.status() === 201) {
    const b2 = (await made2.json()).booking;
    const bad = await r.post(base + `/bookings/${b2.id}/checkout`, { headers: { Origin: origin }, data: { version: b2.version, tenders: [], complete: true } });
    expect(bad.status()).toBeGreaterThanOrEqual(400); expect(await bad.text()).toMatch(/short|Nothing to record/i);
  }
  console.log("FREE-OK", b.id.slice(0, 8));
});
test("checkout screen shows 'Complete · £0' for a free visit", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureShop(page, "owner");
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
  const made = await r.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: st.id, service_id: svc.id, date, start_min: slot.start_min, customer_name: "Zero Pound", phone: "07700900779", source: "TEST_BOOKING", quote } });
  const b = (await made.json()).booking;
  await r.patch(base + `/bookings/${b.id}/items`, { headers: { Origin: origin }, data: { service_id: svc.id, addon_ids: [], service_price_pence: 0, addon_prices: {}, version: b.version } });
  await page.reload(); await page.waitForLoadState("networkidle");
  for (let i = 0; i < ahead; i++) { await page.getByRole("button", { name: "Next day" }).click(); await page.waitForTimeout(400); }
  await page.getByRole("button", { name: /^Zero Pound/ }).first().click();
  // A £0 visit completes straight from the appointment: no checkout screen, no payment method.
  const btn = page.getByTestId("complete-free");
  await expect(btn).toContainText("Complete · £0");
  await expect(page.getByTestId("take-payment")).toHaveCount(0);
  await page.screenshot({ path: "test-results/free-checkout.png" });
  await btn.click();
  await expect.poll(async () => {
    const ws = await (await r.get(base + "/workspace")).json();
    return ws.bookings.find((x: any) => x.id === b.id)?.status;
  }).toBe("COMPLETED");
  // The appointment now shows the £0 as paid.
  await expect(page.locator(".paid-strip")).toContainText("Free visit · £0");
  console.log("UI-FREE-OK");
});
