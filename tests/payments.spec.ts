// Payments ledger (Model A): checkout records how a visit was paid; the wallet reads that ledger.
// No money moves; nothing here talks to a card reader. Each test uses its own fixture shop.
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { shopPayload } from "./shop";
import { refreshView } from "./fixture";
import { openFixtureShop, base, origin } from "./fixture";

async function bookToday(page: Page) {
  const w = await (await page.request.get(base + "/workspace")).json();
  // Jay is the barber the fixture's staff account is linked to (workspace lists staff by name).
  const staff = w.staff.find((s: any) => s.name === "Jay Carter") || w.staff[0];
  const service = w.services.find((s: any) => s.price_pence === 2800) || w.services[0];
  // Prefer today (so the wallet chip moves); otherwise the first day with a free slot for this barber.
  let date = w.today;
  let start: number | undefined;
  let quote: unknown;
  for (let i = 0; i < 8 && start === undefined; i++) {
    const d = new Date(w.today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    date = d.toISOString().slice(0, 10);
    const avail = await (await page.request.get(base + `/availability?date=${date}&staff_id=${staff.id}&service_id=${service.id}`)).json();
    const slot = avail.slots.find((s: any) => !s.reason);
    if (slot) {
      start = slot.start_min;
      quote = avail.quote;
    }
  }
  expect(start, "a free slot within a week").toBeDefined();
  const res = await page.request.post(base + "/bookings", {
    headers: { Origin: origin },
    data: {
      request_id: crypto.randomUUID(),
      staff_id: staff.id,
      service_id: service.id,
      date,
      start_min: start,
      customer_name: "Till Test Client",
      phone: "07700900777",
      source: "TEST_BOOKING",
      quote,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return { booking: (await res.json()).booking, w, staff, service };
}

test("checkout records service + tip by method, completes the visit, updates the wallet chip and drawer, and void reverses it", async ({ page }) => {
  test.setTimeout(90000);
  await openFixtureShop(page);
  const { booking, staff } = await bookToday(page);
  // Check in via API so the panel starts at CHECKED_IN.
  let r = await page.request.post(base + `/bookings/${booking.id}/status`, { headers: { Origin: origin }, data: { status: "CHECKED_IN", reason: "", version: booking.version } });
  expect(r.status()).toBe(200);
  const chipBefore = await page.getByTestId("wallet-chip").locator("b").innerText();

  await page.getByLabel("Appointment date", { exact: true }).fill(booking.date);
  await refreshView(page);
  await page.getByRole("button", { name: /Till Test Client/ }).first().click();
  const panel = page.getByTestId("appointment-panel");
  await panel.getByTestId("take-payment").click();
  const checkout = page.getByTestId("checkout");
  await expect(checkout.getByTestId("checkout-due")).toHaveText("£28");
  await checkout.getByRole("button", { name: "£3", exact: true }).click();
  await checkout.getByRole("button", { name: "Cash" }).click();
  await expect(checkout.getByTestId("record-payment")).toContainText("£31");
  await checkout.getByTestId("record-payment").click();
  // Visit is completed and the paid strip shows the tender.
  await expect(panel.getByText("Completed", { exact: true }).first()).toBeVisible();
  const strip = panel.getByRole("list", { name: "Payments recorded" });
  await expect(strip).toContainText("Cash · £28 + £3 tip");
  await expect(strip.getByText("Paid")).toBeVisible();
  // Ledger row exists with the barber's commission snapshot.
  const wallet = await (await page.request.get(base + "/wallet")).json();
  const row = wallet.payments.find((p: any) => p.booking_id === booking.id);
  expect(row).toMatchObject({ method: "CASH", service_pence: 2800, tip_pence: 300, commission_pct: staff.commission_pct });
  const mine = wallet.by_staff.find((s: any) => s.staff_id === staff.id);
  expect(mine.earnings).toBe(Math.round((mine.service * staff.commission_pct) / 100) + mine.tips);
  // Wallet chip moved by exactly the recorded amount (only when the visit was today).
  if (booking.date === wallet.today) {
    const pence = (t: string) => Math.round(Number(t.replace(/[£,]/g, "")) * 100);
    await expect.poll(async () => pence(await page.getByTestId("wallet-chip").locator("b").innerText())).toBe(pence(chipBefore) + 3100);
  }
  // Drawer: totals, method tiles and the recent row.
  await panel.getByRole("button", { name: /^Close/ }).first().click();
  await expect(panel).toBeHidden();
  await page.getByTestId("wallet-chip").click();
  const drawer = page.getByTestId("wallet-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId("wallet-hero")).toContainText("Taken today");
  if (booking.date === wallet.today) {
    await expect(drawer.getByText("Till Test Client")).toBeVisible();
  }
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  // Row opens the appointment; owner can void with a reason. Voided rows drop out of totals.
  await drawer.getByRole("button", { name: "This month" }).click();
  await drawer.getByRole("button", { name: /Till Test Client/ }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Void" }).click();
  await panel.getByLabel("Why is this payment being voided?").fill("Rang up twice");
  await panel.getByRole("button", { name: "Void payment" }).click();
  await expect(strip.getByText("Voided")).toBeVisible();
  const after = await (await page.request.get(base + `/wallet?from=${wallet.today}&to=${booking.date}`)).json();
  expect(after.payments.find((p: any) => p.booking_id === booking.id).voided_at).toBeTruthy();
  expect(after.totals.voided).toBeGreaterThanOrEqual(1);
  // Ledger is append-only: a second void and any other update are refused.
  r = await page.request.post(base + `/payments/${row.id}/void`, { headers: { Origin: origin }, data: { reason: "again" } });
  expect(r.status()).toBe(409);
});

test("server guards: payment needs a served visit, cannot exceed what is due, split completes only when fully covered", async ({ page }) => {
  await openFixtureShop(page);
  const { booking } = await bookToday(page);
  const post = (data: any, id = booking.id) => page.request.post(base + `/bookings/${id}/checkout`, { headers: { Origin: origin }, data });
  // CONFIRMED: not yet checked in.
  let r = await post({ version: booking.version, tenders: [{ method: "CARD", service_pence: 2800 }] });
  expect(r.status()).toBe(409);
  r = await page.request.post(base + `/bookings/${booking.id}/status`, { headers: { Origin: origin }, data: { status: "CHECKED_IN", reason: "", version: booking.version } });
  let b = (await r.json()).booking;
  // Over-payment refused.
  r = await post({ version: b.version, tenders: [{ method: "CARD", service_pence: 3000 }] });
  expect(r.status()).toBe(409);
  // Short payment with complete=true refused; complete=false records a part payment and moves to IN_SERVICE.
  r = await post({ version: b.version, tenders: [{ method: "CASH", service_pence: 1000 }] });
  expect(r.status()).toBe(409);
  r = await post({ version: b.version, tenders: [{ method: "CASH", service_pence: 1000 }], complete: false });
  expect(r.status(), await r.text()).toBe(201);
  b = (await r.json()).booking;
  expect(b.status).toBe("IN_SERVICE");
  // Remaining 18.00 by card with a discount that does not exceed the price completes it.
  r = await post({ version: b.version, discount_pence: 300, tenders: [{ method: "CARD", service_pence: 1500, tip_pence: 200 }] });
  expect(r.status(), await r.text()).toBe(201);
  const done = await r.json();
  expect(done.booking.status).toBe("COMPLETED");
  expect(done.payments).toHaveLength(2);
  // Stale version refused.
  r = await post({ version: b.version, tenders: [{ method: "CARD", service_pence: 100 }] });
  expect(r.status()).toBe(409);
  // Bad discount refused at validation.
  r = await post({ version: done.booking.version, discount_pence: 99999, tenders: [{ method: "CARD", service_pence: 100 }] });
  expect([400, 409]).toContain(r.status());
});

test("till access: barbers cannot take payment by default; owner setting opens it for their own visits only", async ({ browser }) => {
  test.setTimeout(90000);
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const fx = await openFixtureShop(owner);
  const { booking, w } = await bookToday(owner);
  await owner.request.post(base + `/bookings/${booking.id}/status`, { headers: { Origin: origin }, data: { status: "CHECKED_IN", reason: "", version: booking.version } });
  // Barber signs in to the same fixture shop.
  const barberCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const barber = await barberCtx.newPage();
  const login = await barber.request.post(base + "/auth/login", { headers: { Origin: origin }, data: { email: fx.email.replace("owner", "jay"), password: "Demo1234!" } });
  expect(login.status(), await login.text()).toBe(200);
  const freshRes = await barber.request.get(base + `/bookings/${booking.id}`);
  expect(freshRes.status(), await freshRes.text()).toBe(200);
  const fresh = (await freshRes.json()).booking;
  let r = await barber.request.post(base + `/bookings/${booking.id}/checkout`, { headers: { Origin: origin }, data: { version: fresh.version, tenders: [{ method: "CARD", service_pence: 2800 }] } });
  expect(r.status()).toBe(403);
  // Barber's phone view: panel shows the lock note, not a Take payment button; wallet is "My earnings".
  await barber.goto("/workspace");
  await barber.getByRole("button", { name: "New booking", exact: true }).waitFor();
  await barber.getByTestId("wallet-chip").click();
  await expect(barber.getByTestId("wallet-drawer")).toContainText("My earnings");
  await expect(barber.getByTestId("wallet-drawer")).toContainText("Commission");
  await barber.keyboard.press("Escape");
  // Owner opens the till to barbers.
  r = await owner.request.put(base + "/shop", {
    headers: { Origin: origin },
    data: shopPayload(w.shop, { till_access: "ALL" }),
  });
  expect(r.status(), await r.text()).toBe(200);
  r = await barber.request.post(base + `/bookings/${booking.id}/checkout`, { headers: { Origin: origin }, data: { version: fresh.version, tenders: [{ method: "CARD", service_pence: 2800, tip_pence: 500 }] } });
  expect(r.status(), await r.text()).toBe(201);
  // Another barber's visit is still refused; voiding is owner/manager only.
  const other = w.bookings.find((b: any) => b.staff_id !== fresh.staff_id && b.status === "COMPLETED");
  if (other) {
    r = await barber.request.post(base + `/bookings/${other.id}/checkout`, { headers: { Origin: origin }, data: { version: other.version, tenders: [{ method: "CARD", service_pence: 100 }] } });
    expect([403, 404]).toContain(r.status());
  }
  const mine = (await (await barber.request.get(base + "/wallet")).json()).payments.find((p: any) => p.booking_id === booking.id);
  r = await barber.request.post(base + `/payments/${mine.id}/void`, { headers: { Origin: origin }, data: { reason: "not allowed" } });
  expect(r.status()).toBe(403);
  await ownerCtx.close();
  await barberCtx.close();
});
