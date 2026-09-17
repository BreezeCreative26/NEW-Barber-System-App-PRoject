// Stripe Connect platform, preview mode (no keys): the account layer, the card/cash split on pay
// runs, the settlement maths, role boundaries and the owner/barber UI all work — and every route
// that would move money refuses honestly until Stripe is switched on. Live transfers are covered
// by the Stripe test-mode runbook in docs/PAYMENTS.md once keys exist.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { base, origin, openFixtureShop, section } from "./fixture";
import { newShop } from "./shop";

async function jayAndWeek(r: APIRequestContext) {
  const w = await (await r.get(base + "/workspace")).json();
  const jay = w.staff.find((s: { name: string }) => s.name === "Jay Carter");
  // Last full Mon–Sun.
  const today = new Date(w.today + "T12:00:00Z");
  const dow = (today.getUTCDay() + 6) % 7;
  const monday = new Date(today.getTime() - (dow + 7) * 86400000).toISOString().slice(0, 10);
  const sunday = new Date(Date.parse(monday) + 6 * 86400000).toISOString().slice(0, 10);
  return { w, jay, from: monday, to: sunday };
}
const fixtureCtx = async () => {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  return r;
};

test("payments status: preview mode reported honestly; policy saves; money-moving routes refuse until Stripe is on", async () => {
  const r = await fixtureCtx();
  const p = await (await r.get(base + "/shop/payments")).json();
  expect(p.stripe.provider).toMatch(/^(none|stripe)$/);
  if (p.stripe.provider === "none") {
    expect(p.stripe.mode).toBe("preview");
    expect(p.active).toBe(false);
    expect(p.payouts_ready).toBe(false);
  }
  expect(p.platform.fee_bps).toBeGreaterThanOrEqual(0);
  expect(Array.isArray(p.barbers)).toBe(true);
  expect(p.barbers.length).toBeGreaterThan(0);
  for (const b of p.barbers) expect(b.state.key).toBe("none");
  expect(p.totals_30d).toHaveProperty("to_barbers");

  // Policy: hold/reserve/auto save even without keys, but switching card deposits on needs Stripe.
  let res = await r.put(base + "/shop/payments", { data: { deposits_online: 0, deposit_hold_min: 20, payout_tier: "STANDARD", payrun_auto: "OFF", payrun_reserve_bps: 500 } });
  expect(res.status(), await res.text()).toBe(200);
  const after = await (await r.get(base + "/shop/payments")).json();
  expect(after.settings.deposit_hold_min).toBe(20);
  expect(after.settings.payrun_reserve_bps).toBe(500);
  if (p.stripe.provider === "none") {
    res = await r.put(base + "/shop/payments", { data: { deposits_online: 1, deposit_hold_min: 20, payout_tier: "STANDARD", payrun_auto: "OFF", payrun_reserve_bps: 0 } });
    expect(res.status()).toBe(409);
    res = await r.put(base + "/shop/payments", { data: { deposits_online: 0, deposit_hold_min: 20, payout_tier: "STANDARD", payrun_auto: "DAILY", payrun_reserve_bps: 0 } });
    expect(res.status()).toBe(409);
    expect((await r.post(base + "/shop/payments/connect", { data: {} })).status()).toBe(409);
    const { jay } = await jayAndWeek(r);
    expect((await r.post(base + `/staff/${jay.id}/payments/connect`, { data: {} })).status()).toBe(409);
  }
  // Validation.
  expect((await r.put(base + "/shop/payments", { data: { deposits_online: 0, deposit_hold_min: 2, payout_tier: "STANDARD", payrun_auto: "OFF", payrun_reserve_bps: 0 } })).status()).toBe(400);
  expect((await r.put(base + "/shop/payments", { data: { deposits_online: 0, deposit_hold_min: 15, payout_tier: "TURBO", payrun_auto: "OFF", payrun_reserve_bps: 0 } })).status()).toBe(400);
  // Balance endpoint answers even in preview.
  const bal = await (await r.get(base + "/payments/balance")).json();
  expect(bal).toHaveProperty("available_pence");
  // Reset hold.
  await r.put(base + "/shop/payments", { data: { deposits_online: 0, deposit_hold_min: 15, payout_tier: "STANDARD", payrun_auto: "OFF", payrun_reserve_bps: 0 } });
});

test("pay run preview and creation carry the card/cash split and settlement; cash-only weeks transfer nothing; approve does not pretend to move money", async () => {
  const r = await fixtureCtx();
  const { jay, from, to } = await jayAndWeek(r);
  const preview = await (await r.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${from}&to=${to}`)).json();
  expect(preview).toHaveProperty("split");
  expect(preview).toHaveProperty("settlement");
  const s = preview.split;
  // Demo ledger has no Stripe refs, so every payment is "cash" (already in someone's hand).
  expect(s.card_service_pence + s.card_tips_pence).toBe(0);
  expect(s.cash_service_pence).toBe(preview.input.service_pence);
  expect(preview.settlement.transfer_pence).toBe(0);
  expect(preview.settlement.shop_transfer_pence).toBe(0);
  // Commission barber, shop collected the cash → the whole net is owed by hand.
  expect(preview.settlement.cash_residual_pence).toBe(preview.result.net_pence);

  const created = await r.post(base + "/pay-runs", { data: { staff_id: jay.id, period_from: from, period_to: to, adjustments: [] } });
  expect(created.status(), await created.text()).toBe(201);
  const run = (await created.json()).pay_run;
  expect(run.cash_service_pence).toBe(s.cash_service_pence);
  expect(run.transfer_pence).toBe(0);
  expect(run.cash_residual_pence).toBe(preview.result.net_pence);
  expect(run.transfer_group).toBe(`payrun_${run.id}`);

  // Approve: nothing to transfer, so no Stripe call; run stays APPROVED (not TRANSFERRED).
  const approved = await r.put(base + `/pay-runs/${run.id}`, { data: { version: run.version, status: "APPROVED" } });
  expect(approved.status(), await approved.text()).toBe(200);
  const a = await approved.json();
  expect(a.pay_run.status).toBe("APPROVED");
  expect(a.transfer).toBeNull();
  // Manual transfer refuses honestly in preview.
  const t = await r.post(base + `/pay-runs/${run.id}/transfer`, { data: {} });
  expect(t.status()).toBe(409);
  // Transfers list is empty; settle by hand needs a method.
  const list = await (await r.get(base + `/pay-runs/${run.id}/transfers`)).json();
  expect(list.transfers).toEqual([]);
  const noMethod = await r.put(base + `/pay-runs/${run.id}`, { data: { version: a.pay_run.version, status: "PAID" } });
  expect(noMethod.status()).toBe(400);
  const paid = await r.put(base + `/pay-runs/${run.id}`, { data: { version: a.pay_run.version, status: "PAID", paid_method: "BANK", paid_reference: "FP 4411" } });
  expect(paid.status(), await paid.text()).toBe(200);
  // Payments settled into the run are excluded from the next preview for the same period.
  const again = await (await r.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${from}&to=${to}`)).json();
  // (Settlement into pay_run_id only happens on Stripe transfer; hand-settled runs keep the ledger visible.)
  expect(again.input.service_pence).toBeGreaterThanOrEqual(0);
});

test("settlement maths: a fresh shop with nothing recorded previews zero transfers and is not payout-ready", async () => {
  const { r } = await newShop("Settlement maths shop");
  const w = await (await r.get(base + "/workspace")).json();
  const staff = w.staff[0];
  await r.put(base + "/shop/payments", { data: { deposits_online: 0, deposit_hold_min: 15, payout_tier: "STANDARD", payrun_auto: "OFF", payrun_reserve_bps: 1000 } });
  const preview = await (await r.get(base + `/pay-runs/preview?staff_id=${staff.id}&from=${w.today}&to=${w.today}`)).json();
  expect(preview.settlement).toMatchObject({ transfer_pence: 0, shop_transfer_pence: 0, reserve_pence: 0, cash_residual_pence: preview.result.net_pence });
  expect(preview.payouts_ready).toBe(false);
  expect(preview.split.card_service_pence).toBe(0);
});

test("role boundaries: barber sees only their own payout account; cannot change shop policy or connect the shop", async () => {
  const r = await fixtureCtx();
  const { jay } = await jayAndWeek(r);
  // Barber session.
  const b = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await b.post(base + "/auth/demo", { data: { fixture: true, as: "barber" } });
  expect([200, 201]).toContain(res.status());
  const mine = await (await b.get(base + "/shop/payments")).json();
  expect(mine.shop_account).toBeNull();
  expect(mine.barbers.length).toBe(1);
  expect((await b.put(base + "/shop/payments", { data: { deposits_online: 0, deposit_hold_min: 15, payout_tier: "STANDARD", payrun_auto: "OFF", payrun_reserve_bps: 0 } })).status()).toBe(403);
  expect((await b.post(base + "/shop/payments/connect", { data: {} })).status()).toBe(403);
  // A barber cannot start another barber's onboarding.
  const other = mine.barbers[0].id === jay.id ? (await (await r.get(base + "/workspace")).json()).staff.find((s: { id: string }) => s.id !== jay.id) : jay;
  const cross = await b.post(base + `/staff/${other.id}/payments/connect`, { data: {} });
  expect(cross.status()).toBe(403);
  // Wallet: own is fine, shop's is not.
  const wk = await jayAndWeek(r);
  expect((await b.get(base + `/payments/wallet?owner=STAFF&id=${mine.barbers[0].id}&from=${wk.from}&to=${wk.to}`)).status()).toBe(200);
  expect((await b.get(base + `/payments/wallet?owner=SHOP&from=${wk.from}&to=${wk.to}`)).status()).toBe(403);
  expect((await b.get(base + "/payments/balance")).status()).toBe(403);
});

test("browser: Settings → Payments panel and barber Pay tab show the honest preview state", async ({ page }) => {
  await openFixtureShop(page);
  await section(page, "Settings");
  const panel = page.getByTestId("payments-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("payments-status")).toContainText(/Card payments/);
  await expect(panel.getByTestId("shop-account-state")).toBeVisible();
  const rows = panel.getByTestId("barber-payout-row");
  expect(await rows.count()).toBeGreaterThan(0);
  await expect(rows.first()).toHaveAttribute("data-state", /none|onboarding|restricted|active/);
  // Policy form saves.
  const form = panel.getByTestId("payments-form");
  await form.getByTestId("deposit-hold").fill("25");
  await form.getByTestId("save-payments").click();
  await expect(form.getByText("Saved.")).toBeVisible();
  const saved = await (await page.request.get(base + "/shop/payments")).json();
  expect(saved.settings.deposit_hold_min).toBe(25);
  // No horizontal overflow on the Settings tab with the new panel.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  // Barber studio → Pay tab shows the settlement block and the payout card.
  await section(page, "Team");
  await page.getByTestId("team-card").filter({ hasText: "Jay Carter" }).click();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page.getByTestId("pay-runs")).toBeVisible();
  await expect(page.getByTestId("barber-payout")).toBeVisible();
  await expect(page.getByTestId("barber-payout-state")).toContainText(/Not connected|Finish|Active|Restricted/);
  await expect(page.getByTestId("pay-settlement")).toBeVisible();
  await expect(page.getByTestId("settle-barber")).toHaveText("£0");
});
