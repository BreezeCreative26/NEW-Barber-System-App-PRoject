// Wallet money per barber: cash / card reader / card online split, earnings from the barber's own pay
// setup (same engine as pay runs), and who owes whom. API only, on a private fixture shop.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { base, origin } from "./fixture";

type Staff = Record<string, any> & { id: string; name: string; version: number };
async function ownerCtx() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  return r;
}
async function putTerms(r: APIRequestContext, id: string, patch: Record<string, unknown>) {
  const w = await (await r.get(base + "/workspace")).json();
  const s = (w.staff as Staff[]).find((x) => x.id === id)!;
  const body = {
    name: s.name, role: s.role || "Barber", title: s.title || "", bio: s.bio || "", colour: s.colour || "sage", photo_url: s.photo_url || "",
    online_visible: s.online_visible ?? 1, skills: JSON.parse(s.skills || "[]"), instagram: s.instagram || "", start_date: s.start_date || "",
    active: s.active ?? 1, sort_order: s.sort_order ?? 0, pay_model: s.pay_model, commission_pct: s.commission_pct,
    commission_tiers: JSON.parse(s.commission_tiers || "[]"), commission_threshold_pence: s.commission_threshold_pence ?? 0, base_pence: s.base_pence ?? 0,
    hourly_pence: s.hourly_pence ?? 0, rent_pence: s.rent_pence ?? 0, tip_share_pct: s.tip_share_pct ?? 100, product_commission_pct: s.product_commission_pct ?? 0,
    pay_period: s.pay_period || "WEEKLY", employment: s.employment || "SELF_EMPLOYED", deductions: JSON.parse(s.deductions_json || "[]"), version: s.version,
    ...patch,
  };
  const res = await r.put(base + `/staff/${id}`, { data: body });
  expect(res.status(), await res.text()).toBe(200);
}
const DAILY_RENT = { id: "d_day", label: "Chair rent", kind: "FIXED", amount_pence: 3500, pct_x100: 0, cadence: "DAILY", day_basis: "ROSTERED", proration: "FULL", waive_on_leave: 0, active: 1 };

test("wallet shows cash, card reader and owed per barber, following each barber's pay setup", async () => {
  const r = await ownerCtx();
  const w = await (await r.get(base + "/workspace")).json();
  const jay = (w.staff as Staff[]).find((s) => s.name === "Jay Carter")!;
  const service = w.services.find((s: any) => s.price_pence === 2800) || w.services[0];
  // A day Jay is rostered with a free slot.
  let date = "", start = -1, quote: unknown;
  for (let i = 1; i < 10 && start < 0; i++) {
    const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); date = d.toISOString().slice(0, 10);
    const a = await (await r.get(base + `/availability?date=${date}&staff_id=${jay.id}&service_id=${service.id}`)).json();
    const slot = a.slots.find((s: any) => !s.reason && !s.outside && !s.taken);
    if (slot) { start = slot.start_min; quote = a.quote; }
  }
  expect(start).toBeGreaterThanOrEqual(0);
  const made = await r.post(base + "/bookings", { data: { request_id: crypto.randomUUID(), staff_id: jay.id, service_id: service.id, date, start_min: start, customer_name: "Wallet Money Client", phone: "07700900555", source: "TEST_BOOKING", quote } });
  expect(made.status(), await made.text()).toBe(201);
  const booking = (await made.json()).booking;
  const price = booking.price_pence as number;
  // Paid £10 cash + the rest on the shop's own card machine (Revolut) with a £3 tip on the card.
  const paid = await r.post(base + `/bookings/${booking.id}/checkout`, { data: { version: booking.version, tenders: [{ method: "CASH", service_pence: 1000, tip_pence: 0 }, { method: "READER", service_pence: price - 1000, tip_pence: 300 }], complete: true } });
  expect(paid.status(), await paid.text()).toBe(201);

  // Payments are filed on the day they are taken (today), not the appointment day.
  const day = w.today as string;
  // The shop's card reader charges 1.5% (off by default; set in Settings → Payments).
  const ps = await (await r.get(base + "/shop/payments")).json();
  const save = (bps: number) => r.put(base + "/shop/payments", { data: { ...ps.settings, deposit_pence: undefined, card_reader_fee_bps: bps } });
  let put = await save(150);
  expect(put.status(), await put.text()).toBe(200);
  // 1) Chair renter, £35 a rostered day, keeps their own cash.
  await putTerms(r, jay.id, { pay_model: "CHAIR_RENT", deductions: [DAILY_RENT], tip_share_pct: 100 });
  let wallet = await (await r.get(base + `/wallet?from=${day}&to=${day}`)).json();
  let me = wallet.by_staff.find((s: any) => s.staff_id === jay.id);
  expect(wallet.by_method.READER.service + wallet.by_method.READER.tips).toBe(price - 1000 + 300);
  expect([me.cash, me.reader, me.card]).toEqual([1000, price - 1000 + 300, 0]);
  // Same engine and inputs as the pay run for the same days (rent is £35 × rostered days that day: 0 or 1).
  const p = await (await r.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${day}&to=${day}`)).json();
  const rent = p.input.working_days * 3500;
  // Card reader fee (1.5% by default) on the barber's own card-reader money, first, before chair rent.
  const readerMoney = price - 1000 + 300;
  const fee = Math.round((readerMoney * 150) / 10000);
  expect(me.deduction_lines[0]).toMatchObject({ label: "Card reader fee", pence: fee });
  expect(me.deductions).toBe(fee + rent);
  expect(me.earnings).toBe(price + 300 - fee - rent);
  expect(me.cash_held_by_barber).toBe(1000); // card-machine money is in the shop's account, not their pocket
  expect(me.owed).toBe(price + 300 - fee - rent - 1000);
  expect(me.earnings).toBe(p.result.net_pence);
  expect(me.owed).toBe(p.settlement.cash_residual_pence + p.settlement.barber_card_pence);

  // 2) Same money, now on 60% commission: the shop holds everything and owes the barber their share + tips.
  await putTerms(r, jay.id, { pay_model: "COMMISSION", commission_pct: 60, commission_tiers: [], deductions: [] });
  wallet = await (await r.get(base + `/wallet?from=${day}&to=${day}`)).json();
  me = wallet.by_staff.find((s: any) => s.staff_id === jay.id);
  expect(me.commission).toBe(Math.round(price * 0.6));
  expect(me.earnings).toBe(Math.round(price * 0.6) + 300 - fee); // the barber still pays the reader fee on their payments
  expect(me.cash_held_by_barber).toBe(0);
  expect(me.owed).toBe(me.earnings);

  // 2b) The rate is a shop setting: at 0% there is no fee line.
  put = await save(0);
  expect(put.status(), await put.text()).toBe(200);
  wallet = await (await r.get(base + `/wallet?from=${day}&to=${day}`)).json();
  me = wallet.by_staff.find((s: any) => s.staff_id === jay.id);
  expect(me.deduction_lines.find((d: any) => d.label === "Card reader fee")).toBeFalsy();
  expect(me.earnings).toBe(Math.round(price * 0.6) + 300);
  put = await save(150);
  expect(put.status(), await put.text()).toBe(200);

  // 3) A chair renter with no takings that day still shows what they owe in rent.
  const other = (w.staff as Staff[]).find((s) => s.id !== jay.id && s.active)!;
  await putTerms(r, other.id, { pay_model: "CHAIR_RENT", deductions: [DAILY_RENT] });
  wallet = await (await r.get(base + `/wallet?from=${day}&to=${day}`)).json();
  const idle = wallet.by_staff.find((s: any) => s.staff_id === other.id);
  expect(idle).toBeTruthy();
  const po = await (await r.get(base + `/pay-runs/preview?staff_id=${other.id}&from=${day}&to=${day}`)).json();
  expect(idle.earnings).toBe(po.result.net_pence);
  expect(idle.owed).toBe(idle.earnings);
  await r.dispose();
});

test("wallet drawer shows a money card per barber with cash, card reader and who owes whom", async ({ page }) => {
  const { openFixtureShop } = await import("./fixture");
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFixtureShop(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  const jay = (w.staff as Staff[]).find((s) => s.name === "Jay Carter")!;
  const service = w.services.find((s: any) => s.price_pence === 2800) || w.services[0];
  let date = "", start = -1, quote: unknown;
  for (let i = 1; i < 10 && start < 0; i++) {
    const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); date = d.toISOString().slice(0, 10);
    const a = await (await page.request.get(base + `/availability?date=${date}&staff_id=${jay.id}&service_id=${service.id}`)).json();
    const slot = a.slots.find((s: any) => !s.reason && !s.outside && !s.taken);
    if (slot) { start = slot.start_min; quote = a.quote; }
  }
  const made = await page.request.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: jay.id, service_id: service.id, date, start_min: start, customer_name: "Drawer Money Client", phone: "07700900556", source: "TEST_BOOKING", quote } });
  expect(made.status(), await made.text()).toBe(201);
  const b = (await made.json()).booking;
  const paid = await page.request.post(base + `/bookings/${b.id}/checkout`, { headers: { Origin: origin }, data: { version: b.version, tenders: [{ method: "CASH", service_pence: 1000, tip_pence: 0 }, { method: "READER", service_pence: b.price_pence - 1000, tip_pence: 200 }], complete: true } });
  expect(paid.status(), await paid.text()).toBe(201);
  await page.reload();
  await page.getByTestId("wallet-chip").click();
  const drawer = page.getByTestId("wallet-drawer");
  await expect(drawer).toBeVisible();
  // The drawer opens on the running unpaid total; this checks today's split, so switch to Today.
  await expect(drawer.getByTestId("wallet-hero")).toContainText("Unpaid");
  await drawer.getByRole("button", { name: "Today", exact: true }).click();
  await expect(drawer.getByTestId("wallet-hero")).toContainText("Taken today");
  const card = drawer.locator(`[data-testid="wallet-barber"][data-staff="${jay.id}"]`);
  await expect(card).toBeVisible();
  await expect(card.getByTestId("wb-cash")).toHaveText("£10");
  await expect(card.getByTestId("wb-reader")).toContainText("£");
  await expect(card.getByTestId("wb-owed")).not.toBeEmpty();
  // Jay's fixture deal is tiered (55%, 65% above £1,000): the card says so, not the flat fallback %.
  await expect(card).toContainText("55%, 65% above £1,000 commission");
  await page.screenshot({ path: "test-results/wallet/drawer.png", fullPage: false });
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: "test-results/wallet/barber-card.png" });
});
