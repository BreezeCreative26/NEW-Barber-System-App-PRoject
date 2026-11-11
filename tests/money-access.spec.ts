// Who sees whose money, and that pay figures never count the same day twice.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { base, origin } from "./fixture";

async function ctx() { return request.newContext({ extraHTTPHeaders: { Origin: origin } }); }
async function paidVisit(r: APIRequestContext, w: any, staffId: string, name: string, cash = 0) {
  const svc = w.services.find((s: any) => s.price_pence > 0);
  for (let i = 1; i < 14; i++) {
    const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); const date = d.toISOString().slice(0, 10);
    const a = await (await r.get(base + `/availability?date=${date}&staff_id=${staffId}&service_id=${svc.id}`)).json();
    const slot = (a.slots || []).find((s: any) => !s.reason && !s.outside && !s.taken);
    if (!slot) continue;
    const made = await r.post(base + "/bookings", { data: { request_id: crypto.randomUUID(), staff_id: staffId, service_id: svc.id, date, start_min: slot.start_min, customer_name: name, phone: "07700900790", source: "TEST_BOOKING", quote: a.quote } });
    expect(made.status(), await made.text()).toBe(201);
    const b = (await made.json()).booking;
    const co = await r.post(base + `/bookings/${b.id}/checkout`, { data: { version: b.version, tenders: [{ method: cash ? "CASH" : "READER", service_pence: b.price_pence, tip_pence: 0 }], complete: true } });
    expect(co.status(), await co.text()).toBe(201);
    return b;
  }
  throw new Error("no slot");
}

test("money is personal: barbers see their own, pay access sees everyone, nobody else sees any", async () => {
  const owner = await ctx();
  const fx = await (await owner.post(base + "/auth/demo", { data: { fixture: true } })).json();
  const w = await (await owner.get(base + "/workspace")).json();
  const jay = w.staff.find((s: any) => s.name === "Jay Carter");
  const other = w.staff.find((s: any) => s.id !== jay.id && s.active);
  await paidVisit(owner, w, jay.id, "Access Jay");
  await paidVisit(owner, w, other.id, "Access Other");
  const ownerWallet = await (await owner.get(base + "/wallet?unpaid=1")).json();
  expect(new Set(ownerWallet.by_staff.map((s: any) => s.staff_id)).size).toBeGreaterThanOrEqual(2);

  // Barber (no pay access): own money only, everywhere.
  const jayCtx = await ctx();
  expect((await jayCtx.post(base + "/auth/login", { data: { email: fx.email.replace("owner", "jay"), password: "Demo1234!" } })).status()).toBe(200);
  const jw = await (await jayCtx.get(base + "/wallet?unpaid=1")).json();
  expect(jw.by_staff.map((s: any) => s.staff_id)).toEqual([jay.id]);
  expect(jw.payments.every((p: any) => p.staff_id === jay.id)).toBe(true);
  const jws = await (await jayCtx.get(base + "/workspace")).json();
  const jayOpen = (await (await owner.get(base + "/wallet?unpaid=1")).json()).by_staff.find((s: any) => s.staff_id === jay.id);
  void jayOpen;
  const ownerOpen = (await (await owner.get(base + "/wallet/open")).json()).wallets.find((x: any) => x.staff_id === jay.id);
  expect(jws.wallet_open.total).toBe(Math.max(0, ownerOpen.period.owed));
  const jayOwn = await (await jayCtx.get(base + "/wallet/open")).json();
  expect(jayOwn.wallets.map((x: any) => x.staff_id)).toEqual([jay.id]);
  expect((await jayCtx.get(base + `/pay-runs/preview?staff_id=${other.id}&from=${w.today}&to=${w.today}`)).status()).toBe(403);
  expect((await jayCtx.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${w.today}&to=${w.today}`)).status()).toBe(200);
  expect((await jayCtx.get(base + `/pay-runs/period?from=${w.today}&to=${w.today}`)).status()).toBe(403);
  expect((await jayCtx.get(base + `/wallets?from=${w.today}&to=${w.today}`)).status()).toBe(403);
  expect((await jayCtx.post(base + "/pay-runs", { data: { staff_id: jay.id, period_from: w.today, period_to: w.today } })).status()).toBe(403);
  const jr = await (await jayCtx.get(base + "/pay-runs")).json();
  expect(jr.pay_runs.every((r: any) => r.staff_id === jay.id)).toBe(true);

  // A barber can't approve or settle a run, even their own.
  const run = (await (await owner.post(base + "/pay-runs", { data: { staff_id: jay.id, period_from: w.today, period_to: w.today } })).json()).pay_run;
  expect((await jayCtx.put(base + `/pay-runs/${run.id}`, { data: { version: run.version, status: "APPROVED" } })).status()).toBe(403);

  // Owner gives Jay "See pay runs and wallets": now he sees everyone's, but still can't change runs.
  const access = await (await owner.get(base + "/auth/access")).json();
  const member = access.members.find((m: any) => m.role === "BARBER");
  expect((await owner.put(base + `/auth/members/${member.id}/permissions`, { data: { pay: true } })).status()).toBe(200);
  const jay2 = await ctx();
  expect((await jay2.post(base + "/auth/login", { data: { email: fx.email.replace("owner", "jay"), password: "Demo1234!" } })).status()).toBe(200);
  const jw2 = await (await jay2.get(base + "/wallet?unpaid=1")).json();
  expect(new Set(jw2.by_staff.map((s: any) => s.staff_id)).size).toBeGreaterThanOrEqual(2);
  expect((await jay2.get(base + `/pay-runs/period?from=${w.today}&to=${w.today}`)).status()).toBe(200);
  expect((await jay2.put(base + `/pay-runs/${run.id}`, { data: { version: run.version, status: "APPROVED" } })).status()).toBe(403);
  await owner.dispose(); await jayCtx.dispose(); await jay2.dispose();
});

test("pay figures never count a day twice: a week run leaves out a day an earlier run covers", async () => {
  const owner = await ctx();
  await owner.post(base + "/auth/demo", { data: { fixture: true } });
  const w = await (await owner.get(base + "/workspace")).json();
  const jay = w.staff.find((s: any) => s.name === "Jay Carter");
  await paidVisit(owner, w, jay.id, "Twice Client", 1);
  const today = w.today as string;
  const weekFrom = new Date(today + "T12:00:00Z"); weekFrom.setUTCDate(weekFrom.getUTCDate() - 3);
  const from = weekFrom.toISOString().slice(0, 10);
  const weekTo = new Date(today + "T12:00:00Z"); weekTo.setUTCDate(weekTo.getUTCDate() + 3);
  const to = weekTo.toISOString().slice(0, 10);
  const before = await (await owner.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${from}&to=${to}`)).json();
  const day = await (await owner.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${today}&to=${today}`)).json();
  expect(day.input.service_pence).toBeGreaterThan(0);
  // A one-day run for today exists: the week preview leaves today's takings out.
  const r1 = await owner.post(base + "/pay-runs", { data: { staff_id: jay.id, period_from: today, period_to: today } });
  expect(r1.status(), await r1.text()).toBe(201);
  const after = await (await owner.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${from}&to=${to}`)).json();
  expect(after.input.service_pence).toBe(before.input.service_pence - day.input.service_pence);
  expect(after.input.days).toBe(before.input.days - 1);
  // The week run can be created (not refused) and its figures match the preview.
  const r2 = await owner.post(base + "/pay-runs", { data: { staff_id: jay.id, period_from: from, period_to: to } });
  expect(r2.status(), await r2.text()).toBe(201);
  const week = (await r2.json()).pay_run;
  expect(week.service_pence).toBe(after.input.service_pence);
  // The earlier run can't be voided while the week run relies on it; voiding the week run first works.
  const one = (await r1.json()).pay_run;
  expect((await owner.put(base + `/pay-runs/${one.id}`, { data: { version: one.version, status: "VOID", reason: "redo as a week" } })).status()).toBe(409);
  expect((await owner.put(base + `/pay-runs/${week.id}`, { data: { version: week.version, status: "VOID", reason: "test" } })).status()).toBe(200);
  expect((await owner.put(base + `/pay-runs/${one.id}`, { data: { version: one.version, status: "VOID", reason: "redo as a week" } })).status()).toBe(200);
  await owner.dispose();
});
