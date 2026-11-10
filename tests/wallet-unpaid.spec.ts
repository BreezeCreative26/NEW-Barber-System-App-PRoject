// The wallet keeps a running total of money not yet paid to the barber: it carries on across days
// and only drops once a pay run covering that money is settled.
import { test, expect, request } from "@playwright/test";
import { base, origin } from "./fixture";

test("wallet unpaid total runs until a pay run is settled", async () => {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  expect((await r.post(base + "/auth/demo", { data: { fixture: true } })).status()).toBe(201);
  const w = await (await r.get(base + "/workspace")).json();
  const jay = w.staff.find((s: any) => s.name === "Jay Carter");
  const svc = w.services.find((s: any) => s.price_pence > 0);
  let made: any = null;
  for (let i = 1; i < 14 && !made; i++) {
    const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); const date = d.toISOString().slice(0, 10);
    const a = await (await r.get(base + `/availability?date=${date}&staff_id=${jay.id}&service_id=${svc.id}`)).json();
    const slot = (a.slots || []).find((s: any) => !s.reason && !s.outside && !s.taken);
    if (!slot) continue;
    const res = await r.post(base + "/bookings", { data: { request_id: crypto.randomUUID(), staff_id: jay.id, service_id: svc.id, date, start_min: slot.start_min, customer_name: "Unpaid Run Client", phone: "07700900782", source: "TEST_BOOKING", quote: a.quote } });
    expect(res.status(), await res.text()).toBe(201);
    made = (await res.json()).booking;
  }
  const before = (await (await r.get(base + "/workspace")).json()).wallet_open;
  const paid = await r.post(base + `/bookings/${made.id}/checkout`, { data: { version: made.version, tenders: [{ method: "CASH", service_pence: made.price_pence, tip_pence: 200 }], complete: true } });
  expect(paid.status(), await paid.text()).toBe(201);

  // 1) It joins the running total (chip) and the drawer's Unpaid view.
  const mid = (await (await r.get(base + "/workspace")).json()).wallet_open;
  expect(mid.total).toBe(before.total + made.price_pence + 200);
  let unpaid = await (await r.get(base + "/wallet?unpaid=1")).json();
  expect(unpaid.unpaid).toBe(true);
  expect(unpaid.to).toBe(w.today);
  expect(unpaid.payments.some((p: any) => p.booking_id === made.id)).toBe(true);

  // 2) A pay run that is only approved has not paid anyone: still in the total.
  const run = (await (await r.post(base + "/pay-runs", { data: { staff_id: jay.id, period_from: w.today, period_to: w.today } })).json()).pay_run;
  expect(run, "pay run created").toBeTruthy();
  let up = await r.put(base + `/pay-runs/${run.id}`, { data: { version: run.version, status: "APPROVED" } });
  expect(up.status(), await up.text()).toBe(200);
  expect((await (await r.get(base + "/workspace")).json()).wallet_open.total).toBe(mid.total);

  // 3) Marked paid: Jay's money for the day drops out of the running total.
  const approved = (await up.json()).pay_run ?? (await (await r.get(base + "/pay-runs")).json()).pay_runs.find((x: any) => x.id === run.id);
  up = await r.put(base + `/pay-runs/${run.id}`, { data: { version: approved.version, status: "PAID", paid_method: "CASH" } });
  expect(up.status(), await up.text()).toBe(200);
  unpaid = await (await r.get(base + "/wallet?unpaid=1")).json();
  expect(unpaid.payments.some((p: any) => p.booking_id === made.id)).toBe(false);
  expect(unpaid.payments.some((p: any) => p.staff_id === jay.id && p.date === w.today)).toBe(false);
  const after = (await (await r.get(base + "/workspace")).json()).wallet_open;
  expect(after.total).toBeLessThanOrEqual(before.total);
  // The day's takings view is unchanged by paying the barber.
  const day = await (await r.get(base + `/wallet?from=${w.today}&to=${w.today}`)).json();
  expect(day.payments.some((p: any) => p.booking_id === made.id)).toBe(true);
  await r.dispose();
});
