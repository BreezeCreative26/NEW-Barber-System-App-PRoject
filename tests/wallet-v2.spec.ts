// Wallet v2: owed is card money only (less the card reader fee and rent); cash / transfer / £0 are shown
// but never owed. Mark paid settles everything up to a day, resets the wallet to £0 and files a paid
// window with what it covered. Day view totals match the payments. API + quick view + full wallet.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { base, origin, openFixtureShop } from "./fixture";

type Staff = Record<string, any> & { id: string; name: string; version: number };
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
async function book(r: APIRequestContext, w: any, staffId: string, name: string, phone: string, used: Set<string>) {
  const svc = w.services.find((s: any) => s.price_pence >= 2000) || w.services[0];
  for (let i = 1; i < 14; i++) {
    const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); const date = d.toISOString().slice(0, 10);
    const a = await (await r.get(base + `/availability?date=${date}&staff_id=${staffId}&service_id=${svc.id}`)).json();
    const slot = (a.slots || []).find((s: any) => !s.reason && !s.outside && !s.taken && !used.has(`${date}:${s.start_min}`));
    if (!slot) continue;
    used.add(`${date}:${slot.start_min}`);
    const res = await r.post(base + "/bookings", { data: { request_id: crypto.randomUUID(), staff_id: staffId, service_id: svc.id, date, start_min: slot.start_min, customer_name: name, phone, source: "TEST_BOOKING", quote: a.quote } });
    if (res.status() === 201) return (await res.json()).booking;
  }
  throw new Error("no slot");
}
const DAILY_RENT = { id: "d_day", label: "Chair rent", kind: "FIXED", amount_pence: 3500, pct_x100: 0, cadence: "DAILY", day_basis: "ROSTERED", proration: "FULL", waive_on_leave: 0, active: 1 };

test("owed is card only; Mark paid resets to £0 and files the paid window", async () => {
  test.setTimeout(120000);
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  expect((await r.post(base + "/auth/demo", { data: { fixture: true } })).status()).toBe(201);
  let w = await (await r.get(base + "/workspace")).json();
  const jay = (w.staff as Staff[]).find((s) => s.name === "Jay Carter")!;
  // Chair renter, £35 rent per rostered day, 1.5% card reader fee.
  const ps = await (await r.get(base + "/shop/payments")).json();
  expect((await r.put(base + "/shop/payments", { data: { ...ps.settings, deposit_pence: undefined, card_reader_fee_bps: 150 } })).status()).toBe(200);
  await putTerms(r, jay.id, { pay_model: "CHAIR_RENT", deductions: [DAILY_RENT], tip_share_pct: 100 });
  w = await (await r.get(base + "/workspace")).json();
  const day = w.today as string;
  const before = (await (await r.get(base + "/wallet/open")).json()).wallets.find((x: any) => x.staff_id === jay.id);

  const used = new Set<string>();
  const pay = async (name: string, phone: string, tenders: (b: any) => any[], free = false) => {
    let b = await book(r, w, jay.id, name, phone, used);
    if (free) {
      const ed = await r.patch(base + `/bookings/${b.id}/items`, { data: { service_id: b.service_id, addon_ids: [], service_price_pence: 0, addon_prices: {}, version: b.version } });
      expect(ed.status(), await ed.text()).toBe(200); b = (await ed.json()).booking;
    }
    const res = await r.post(base + `/bookings/${b.id}/checkout`, { data: { version: b.version, tenders: tenders(b), complete: true } });
    expect(res.status(), await res.text()).toBe(201);
    return b;
  };
  const card = await pay("Card Client", "07700900801", (b) => [{ method: "READER", service_pence: b.price_pence, tip_pence: 200 }]);
  const cash = await pay("Cash Client", "07700900802", (b) => [{ method: "CASH", service_pence: b.price_pence, tip_pence: 0 }]);
  const xfer = await pay("Transfer Client", "07700900803", (b) => [{ method: "TRANSFER", service_pence: b.price_pence, tip_pence: 0 }]);
  await pay("Free Client", "07700900804", () => [], true); // £0: no payment method

  const open = await (await r.get(base + "/wallet/open")).json();
  const me = open.wallets.find((x: any) => x.staff_id === jay.id);
  const p = me.period;
  const cardMoney = card.price_pence + 200;
  const kept = cash.price_pence + xfer.price_pence;
  // What was taken is all of it…
  expect(p.taken - before.period.taken).toBe(cardMoney + kept);
  expect(p.reader - before.period.reader).toBe(cardMoney);
  expect(p.cash + p.transfer - before.period.cash - before.period.transfer).toBe(kept);
  // …but owed is only the card money, less the 1.5% fee (per payment) and rent.
  const feeDelta = Math.round((cardMoney * 150) / 10000);
  expect(p.fee - before.period.fee).toBe(feeDelta);
  expect(p.owed).toBe(p.reader + p.online - p.fee - p.rent);
  // The days add up to the period, and today's row matches the payments.
  expect(me.days.reduce((n: number, d: any) => n + d.owed, 0)).toBe(p.owed);
  expect(me.days.reduce((n: number, d: any) => n + d.taken, 0)).toBe(p.taken);
  const days = await (await r.get(base + `/wallet/days?from=${day}&to=${day}&payments=1`)).json();
  const jd = days.days[0].barbers.find((b: any) => b.staff_id === jay.id);
  expect(jd.taken).toBe(jd.rows.reduce((n: number, x: any) => n + x.service_pence + x.tip_pence, 0));
  expect(jd.zero_visits).toBeGreaterThanOrEqual(1);
  expect(jd.owed).toBe(jd.reader + jd.online - jd.fee - jd.rent);
  // The wallet chip is what's owed to barbers, not what was taken.
  const ws = await (await r.get(base + "/workspace")).json();
  expect(ws.wallet_open.total).toBe(open.totals.owed);

  // A stale amount is refused (someone added a payment meanwhile).
  const stale = await r.post(base + "/wallet/settle", { data: { staff_id: jay.id, to: day, paid_method: "BANK", expected_owed: p.owed + 1 } });
  expect(stale.status()).toBe(409);
  // Mark paid up to today.
  const settled = await r.post(base + "/wallet/settle", { data: { staff_id: jay.id, to: day, paid_method: "BANK", paid_reference: "test ref", expected_owed: p.owed } });
  expect(settled.status(), await settled.text()).toBe(201);
  const after = (await (await r.get(base + "/wallet/open")).json()).wallets.find((x: any) => x.staff_id === jay.id);
  expect(after.empty).toBe(true);
  expect(after.period.owed).toBe(0);
  expect(after.last_paid.amount_pence).toBe(p.owed);
  expect(after.last_paid.paid_method).toBe("BANK");
  // The paid window lists exactly what it covered.
  const hist = await (await r.get(base + `/wallet/history?staff_id=${jay.id}`)).json();
  const win = hist.windows[0];
  expect(win.amount_pence).toBe(p.owed);
  expect(win.period_from).toBe(me.from); expect(win.period_to).toBe(day);
  expect(win.tally.taken).toBe(p.taken);
  expect(win.tally.reader).toBe(p.reader);
  expect(win.payments.length).toBe(me.payments.length);
  // The day still shows what was taken, now marked paid; nothing can be paid twice.
  const days2 = await (await r.get(base + `/wallet/days?from=${day}&to=${day}`)).json();
  const jd2 = days2.days[0].barbers.find((b: any) => b.staff_id === jay.id);
  expect(jd2.taken).toBe(jd.taken); expect(jd2.paid).toBe(true);
  const again = await r.post(base + "/wallet/settle", { data: { staff_id: jay.id, to: day, paid_method: "BANK", expected_owed: 0 } });
  expect(again.status()).toBe(409);
  // A barber can't mark anyone paid.
  await r.dispose();
});

test("a barber sees only their own wallet and cannot mark paid", async () => {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  expect((await r.post(base + "/auth/demo", { data: { fixture: true, as: "barber" } })).status()).toBe(201);
  const w = await (await r.get(base + "/workspace")).json();
  const open = await (await r.get(base + "/wallet/open")).json();
  expect(open.wallets.length).toBe(1);
  expect(open.wallets[0].staff_id).toBe(w.account.staff_id);
  const other = w.staff.find((s: any) => s.id !== w.account.staff_id);
  expect((await r.get(base + `/wallet/history?staff_id=${other.id}`)).status()).toBe(403);
  const res = await r.post(base + "/wallet/settle", { data: { staff_id: w.account.staff_id, to: w.today, paid_method: "BANK", expected_owed: open.wallets[0].period.owed } });
  expect(res.status()).toBe(403);
  await r.dispose();
});

test("tapping the wallet opens the same quick view; More detail opens the day picker, calendar and history", async ({ page }) => {
  test.setTimeout(90000);
  await openFixtureShop(page, "owner");
  await page.getByTestId("wallet-chip").click();
  const drawer = page.getByTestId("wallet-drawer");
  // Same quick view as before: ranges, hero, method tiles, per-barber cards.
  await expect(drawer.getByRole("button", { name: "Unpaid" })).toBeVisible();
  await expect(drawer.getByTestId("wallet-hero")).toContainText("owed to barbers");
  await expect(drawer.getByTestId("wallet-barbers")).toBeVisible();
  await expect(drawer.getByTestId("wallet-day")).toHaveCount(0);
  // Desktop: expand icon in the header.
  await expect(drawer.getByTestId("wallet-expand")).toBeVisible();
  await page.screenshot({ path: "test-results/wallet-quick-view.png" });
  await drawer.getByTestId("wallet-expand").click();
  const full = page.getByTestId("wallet-fullscreen");
  await expect(full).toBeVisible();
  await expect(full.getByTestId("wallet-day-totals")).toBeVisible();
  await full.getByRole("button", { name: "Previous day" }).click();
  await expect(full.getByTestId("wallet-day-label")).not.toContainText("Today");
  await full.getByTestId("wallet-day-label").click();
  await expect(full.getByTestId("wallet-calendar")).toBeVisible();
  await full.locator('[data-testid="wallet-cal-day"]:not([disabled])').first().click();
  await expect(full.getByTestId("wallet-calendar")).toBeHidden();
  await expect(full.getByTestId("wallet-open").first()).toBeVisible();
  await expect(full.getByTestId("wallet-history")).toBeVisible();
  await page.screenshot({ path: "test-results/wallet-full.png", fullPage: true });
  // Back returns to the quick view; Escape closes the full screen.
  await page.getByTestId("wallet-full-back").click();
  await expect(page.getByTestId("wallet-drawer")).toBeVisible();
  await page.getByTestId("wallet-drawer").getByTestId("wallet-open-full").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("wallet-fullscreen")).toHaveCount(0);
  // No separate Wallet menu item.
  await expect(page.getByRole("navigation", { name: "Workspace sections" }).getByRole("button", { name: "Wallet", exact: true })).toHaveCount(0);
});

test("phone: quick view has a More detail button (no header icon)", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureShop(page, "owner");
  await page.getByTestId("wallet-chip").click();
  const drawer = page.getByTestId("wallet-drawer");
  await expect(drawer.getByTestId("wallet-expand")).toBeHidden();
  await drawer.getByTestId("wallet-open-full").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/wallet-quick-phone.png" });
  await drawer.getByTestId("wallet-open-full").click();
  await expect(page.getByTestId("wallet-fullscreen")).toBeVisible();
  await expect(page.getByTestId("wallet-day-totals")).toBeVisible();
  await page.screenshot({ path: "test-results/wallet-full-phone.png" });
});

test("barber sees only their own wallet in the quick view and full screen, with no Mark paid", async ({ page }) => {
  test.setTimeout(90000);
  await openFixtureShop(page, "barber");
  const w = await (await page.request.get(base + "/workspace")).json();
  await page.getByTestId("wallet-chip").click();
  const drawer = page.getByTestId("wallet-drawer");
  await expect(drawer).toContainText("My earnings");
  await expect(drawer.getByTestId("wallet-barbers")).toHaveCount(0);
  await drawer.getByTestId("wallet-expand").click();
  const full = page.getByTestId("wallet-fullscreen");
  await expect(full).toContainText("My wallet");
  await expect(full.getByTestId("wallet-barber-list")).toHaveCount(0);
  await expect(full.getByTestId("wallet-mark-paid")).toHaveCount(0);
  await expect(full.getByTestId("wallet-open")).toHaveAttribute("data-staff", w.account.staff_id);
  for (const el of await full.getByTestId("wallet-day-barber").all()) await expect(el).toHaveAttribute("data-staff", w.account.staff_id);
  await expect(full.getByTestId("wallet-history")).toBeVisible();
});

test("£0 visit completes without choosing a payment method", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureShop(page, "owner");
  const r = page.request;
  const w = await (await r.get(base + "/workspace")).json();
  const st = w.staff.find((s: any) => s.active);
  const svc = w.services.find((s: any) => s.price_pence > 0);
  let date = "", slot: any = null, quote: unknown, ahead = 0;
  for (let i = 1; i < 12 && !slot; i++) {
    const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); date = d.toISOString().slice(0, 10);
    const a = await (await r.get(base + `/availability?date=${date}&staff_id=${st.id}&service_id=${svc.id}`)).json();
    slot = (a.slots || []).find((s: any) => !s.reason && !s.outside && !s.taken); quote = a.quote; ahead = i;
  }
  const made = await r.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: st.id, service_id: svc.id, date, start_min: slot.start_min, customer_name: "Nil Method", phone: "07700900809", source: "TEST_BOOKING", quote } });
  expect(made.status(), await made.text()).toBe(201);
  const b = (await made.json()).booking;
  await r.patch(base + `/bookings/${b.id}/items`, { headers: { Origin: origin }, data: { service_id: svc.id, addon_ids: [], service_price_pence: 0, addon_prices: {}, version: b.version } });
  await page.reload(); await page.waitForLoadState("networkidle");
  for (let i = 0; i < ahead; i++) { await page.getByRole("button", { name: "Next day" }).click(); await page.waitForTimeout(400); }
  await page.getByRole("button", { name: /^Nil Method/ }).first().click();
  // No checkout screen, no payment-method tiles: one button completes it.
  const btn = page.getByTestId("complete-free");
  await expect(btn).toContainText("Complete · £0");
  await expect(page.getByTestId("method-cash")).toHaveCount(0);
  await page.screenshot({ path: "test-results/free-no-method.png" });
  await btn.click();
  await expect.poll(async () => (await (await r.get(base + "/workspace")).json()).bookings.find((x: any) => x.id === b.id)?.status).toBe("COMPLETED");
  const rows = (await (await r.get(base + "/workspace")).json()).payments.filter((p: any) => p.booking_id === b.id && !p.voided_at);
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ service_pence: 0, tip_pence: 0 });
});
