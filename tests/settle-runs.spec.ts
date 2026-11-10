// Pay runs → "To settle": every open run (including one-day automatic runs that don't match the
// weekly view) is listed with its balance, and can be marked paid one by one or all at once.
// Settling takes that money out of the wallet's running unpaid total.
import { test, expect, type APIRequestContext } from "@playwright/test";
import { openFixtureShop, section, base, origin } from "./fixture";

async function paidVisit(r: APIRequestContext, w: any, staffId: string, name: string) {
  const svc = w.services.find((s: any) => s.price_pence > 0);
  for (let i = 1; i < 14; i++) {
    const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); const date = d.toISOString().slice(0, 10);
    const a = await (await r.get(base + `/availability?date=${date}&staff_id=${staffId}&service_id=${svc.id}`)).json();
    const slot = (a.slots || []).find((s: any) => !s.reason && !s.outside && !s.taken);
    if (!slot) continue;
    const made = await r.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: staffId, service_id: svc.id, date, start_min: slot.start_min, customer_name: name, phone: "07700900783", source: "TEST_BOOKING", quote: a.quote } });
    expect(made.status(), await made.text()).toBe(201);
    const b = (await made.json()).booking;
    const co = await r.post(base + `/bookings/${b.id}/checkout`, { headers: { Origin: origin }, data: { version: b.version, tenders: [{ method: "CASH", service_pence: b.price_pence, tip_pence: 100 }], complete: true } });
    expect(co.status(), await co.text()).toBe(201);
    return b;
  }
  throw new Error("no slot");
}

test("To settle lists open one-day runs and 'Mark all paid' settles them", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFixtureShop(page);
  const r = page.request;
  const w = await (await r.get(base + "/workspace")).json();
  const barbers = w.staff.filter((s: any) => s.active).slice(0, 2);
  const runs: any[] = [];
  for (const st of barbers) {
    await paidVisit(r, w, st.id, `Settle ${st.name.split(" ")[0]}`);
    const made = await r.post(base + "/pay-runs", { headers: { Origin: origin }, data: { staff_id: st.id, period_from: w.today, period_to: w.today } });
    expect(made.status(), await made.text()).toBe(201);
    const run = (await made.json()).pay_run;
    const ok = await r.put(base + `/pay-runs/${run.id}`, { headers: { Origin: origin }, data: { version: run.version, status: "APPROVED" } });
    expect(ok.status(), await ok.text()).toBe(200);
    runs.push((await ok.json()).pay_run);
  }
  // A payment recorded after the run was made is not swept into it when it is marked paid.
  const late = await paidVisit(r, w, barbers[0].id, "Late Settle Client");
  const openBefore = (await (await r.get(base + "/workspace")).json()).wallet_open.total;

  await section(page, "Pay runs");
  const box = page.getByTestId("to-settle");
  await expect(box).toBeVisible();
  for (const run of runs) await expect(box.locator(`[data-run="${run.id}"]`)).toBeVisible();
  await expect(box.locator(`[data-run="${runs[0].id}"]`).getByTestId("to-settle-balance")).not.toBeEmpty();
  await page.screenshot({ path: "test-results/to-settle.png" });
  await box.getByTestId("settle-method").selectOption("CASH");
  await box.getByTestId("settle-all").click();
  await expect.poll(async () => {
    const all = (await (await r.get(base + "/pay-runs")).json()).pay_runs;
    return runs.map((x) => all.find((y: any) => y.id === x.id)?.status).join(",");
  }).toBe("PAID,PAID");
  const all = (await (await r.get(base + "/pay-runs")).json()).pay_runs;
  expect(all.find((y: any) => y.id === runs[0].id).paid_method).toBe("CASH");
  // Settled rows leave the list; the late payment stays in the unpaid total.
  for (const run of runs) await expect(box.locator(`[data-run="${run.id}"]`)).toHaveCount(0);
  const ws = await (await r.get(base + "/workspace")).json();
  expect(ws.wallet_open.total).toBeLessThan(openBefore);
  const unpaid = await (await r.get(base + "/wallet?unpaid=1")).json();
  expect(unpaid.payments.some((p: any) => p.booking_id === late.id)).toBe(true);
});
