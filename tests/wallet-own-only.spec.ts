// A barber's wallet is personal: the workspace payments list (wallet chip) and the wallet endpoint
// only ever carry their own takings, never another barber's or the shop total.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { base, origin } from "./fixture";

async function bookAndPay(r: APIRequestContext, w: any, staffId: string, pence: number) {
  const service = w.services.find((s: any) => s.price_pence > 0) || w.services[0];
  for (let i = 1; i < 14; i++) {
    const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const a = await (await r.get(base + `/availability?date=${date}&staff_id=${staffId}&service_id=${service.id}`)).json();
    const slot = (a.slots || []).find((s: any) => !s.reason && !s.outside && !s.taken);
    if (!slot) continue;
    const made = await r.post(base + "/bookings", { data: { request_id: crypto.randomUUID(), staff_id: staffId, service_id: service.id, date, start_min: slot.start_min, customer_name: "Own Wallet Client", phone: "07700900556", source: "TEST_BOOKING", quote: a.quote } });
    expect(made.status(), await made.text()).toBe(201);
    const b = (await made.json()).booking;
    const paid = await r.post(base + `/bookings/${b.id}/checkout`, { data: { version: b.version, tenders: [{ method: "CASH", service_pence: b.price_pence, tip_pence: pence }], complete: true } });
    expect(paid.status(), await paid.text()).toBe(201);
    return;
  }
  throw new Error("no free slot");
}

test("barber sees only their own money in the wallet chip and drawer", async () => {
  const owner = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const fx = await (await owner.post(base + "/auth/demo", { data: { fixture: true } })).json();
  const w = await (await owner.get(base + "/workspace")).json();
  const jay = w.staff.find((s: any) => s.name === "Jay Carter");
  const other = w.staff.find((s: any) => s.id !== jay.id && s.active);
  await bookAndPay(owner, w, jay.id, 100);
  await bookAndPay(owner, w, other.id, 500);
  const shopW = await (await owner.get(base + "/workspace")).json();
  expect(new Set(shopW.payments.filter((p: any) => p.date === w.today).map((p: any) => p.staff_id)).size).toBeGreaterThanOrEqual(2);

  const barber = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const login = await barber.post(base + "/auth/login", { data: { email: fx.email.replace("owner", "jay"), password: "Demo1234!" } });
  expect(login.status(), await login.text()).toBe(200);
  const bw = await (await barber.get(base + "/workspace")).json();
  expect(bw.account.staff_id).toBe(jay.id);
  expect(bw.payments.length).toBeGreaterThan(0);
  expect(bw.payments.every((p: any) => p.staff_id === jay.id)).toBe(true);

  const wallet = await (await barber.get(base + `/wallet?from=${w.today}&to=${w.today}`)).json();
  expect(wallet.by_staff.map((s: any) => s.staff_id)).toEqual([jay.id]);
  expect(wallet.payments.every((p: any) => p.staff_id === jay.id)).toBe(true);
  const mine = bw.payments.filter((p: any) => p.date === w.today && !p.voided_at).reduce((n: number, p: any) => n + p.service_pence + p.tip_pence, 0);
  expect(wallet.totals.service + wallet.totals.tips).toBe(mine);
  // The all-barbers wallets page stays owner-only.
  expect((await barber.get(base + `/wallets?from=${w.today}&to=${w.today}`)).status()).toBe(403);
  await owner.dispose(); await barber.dispose();
});
