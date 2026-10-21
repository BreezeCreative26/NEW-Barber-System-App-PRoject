// Round 2: payment wording follows the shop's choice, holiday allowance + tracker, daily chair rent,
// pay-change history, and the "saved" notice clearing itself.
import { expect, test } from "@playwright/test";
import { base, origin, enterNewShop } from "./shop";


const H = { headers: { Origin: origin } };
const plus = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const nextMonday = (today: string) => {
  const dow = new Date(today + "T12:00:00Z").getUTCDay();
  return plus(today, ((8 - dow) % 7) || 7);
};

test("customers are told 'pay in the shop' when card payments aren't on, everywhere", async ({ page }) => {
  // The demo shop has deposits chosen but no card account connected.
  const w = { shop: { slug: "demo" } };
  const pub = await (await page.request.get(origin + `/api/public/shops/${w.shop.slug}`)).json();
  expect(pub.shop.payment.mode).toBe("IN_STORE");
  expect(pub.shop.payment.line).toBe("Pay in the shop on the day. No payment is taken online.");
  await page.goto(`/${w.shop.slug}`);
  await expect(page.getByTestId("payment-policy")).toHaveText(/Pay in the shop on the day/);
  await expect(page.getByText(/Deposit policy/)).toHaveCount(0);
});

test("holiday: allowance, a week off books only rostered days, tracker counts it, warns when over", async ({ page }) => {
  await enterNewShop(page, "Holiday shop");
  const w = await (await page.request.get(base + "/workspace")).json();
  const jay = w.staff.find((s: { name: string }) => s.name === "Jay Carter");
  expect((await page.request.put(base + `/staff/${jay.id}/holiday-allowance`, { ...H, data: { allowance_days: 3, carry_days: 0.5 } })).status()).toBe(200);
  const mon = nextMonday(w.today);
  // A Monday-to-Sunday holiday: the fixture rota has Sunday off, so 6 days are booked, not 7.
  const res = await page.request.post(base + `/staff/${jay.id}/days-off`, { ...H, data: { date: mon, to: plus(mon, 6), reason: "Spain", kind: "HOLIDAY" } });
  expect(res.status(), await res.text()).toBe(201);
  const w2 = await (await page.request.get(base + "/workspace")).json();
  const mine = w2.days_off.filter((d: { staff_id: string }) => d.staff_id === jay.id);
  expect(mine.length).toBeGreaterThanOrEqual(5);
  expect(mine.length).toBeLessThan(7);
  expect(mine.every((d: { kind: string }) => d.kind === "HOLIDAY")).toBe(true);
  // A sick day doesn't use the allowance.
  expect((await page.request.post(base + `/staff/${jay.id}/days-off`, { ...H, data: { date: plus(mon, 14), reason: "Flu", kind: "SICK" } })).status()).toBe(201);
  // The tracker on the barber's Schedule tab shows allowance, booked days and the overage.
  await page.reload();
  await page.getByRole("button", { name: "Team", exact: true }).first().click();
  await page.getByTestId("team-card").filter({ hasText: "Jay Carter" }).click();
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  const tracker = page.getByTestId("holiday-tracker");
  await expect(tracker).toBeVisible();
  await expect(tracker.getByTestId("holiday-booked")).toHaveText(`${mine.length} days`);
  await expect(tracker.getByTestId("holiday-over")).toBeVisible();
  await expect(tracker).toContainText("1 day sick");
  // Shop-wide table on the Shifts page.
  await page.goto("/workspace");
  await page.getByRole("navigation", { name: "Workspace sections" }).getByRole("button", { name: "Shifts", exact: true }).click();
  await page.getByRole("tab", { name: "Leave" }).click();
  await expect(page.getByTestId("holiday-table")).toContainText("Jay Carter");
  // Leave year can be moved to April.
  expect((await page.request.put(base + "/shop/leave-year", { ...H, data: { leave_year_start: "04-06" } })).status()).toBe(200);
  expect((await (await page.request.get(base + "/workspace")).json()).shop.leave_year_start).toBe("04-06");
});

test("daily chair rent charges rostered days, and pay changes are logged before and after", async ({ page }) => {
  await enterNewShop(page, "Day rent shop");
  const w = await (await page.request.get(base + "/workspace")).json();
  const jay = w.staff.find((s: { name: string }) => s.name === "Jay Carter");
  const rent = { id: "d_day", label: "Day rent", kind: "FIXED", amount_pence: 2500, pct_x100: 0, cadence: "DAILY", day_basis: "ROSTERED", proration: "FULL", waive_on_leave: 0, active: 1 };
  const put = await page.request.put(base + `/staff/${jay.id}`, { ...H, data: { name: jay.name, role: jay.role, version: jay.version, pay_model: "CHAIR_RENT", deductions: [rent] } });
  expect(put.status(), await put.text()).toBe(200);
  const mon = nextMonday(w.today);
  const p = await (await page.request.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${mon}&to=${plus(mon, 6)}`)).json();
  expect(p.input.working_days).toBe(6);
  expect(p.result.deductions[0].pence).toBe(6 * 2500);
  expect(p.result.deductions[0].detail).toBe("6 rostered days at £25.00");
  // Booked days: none yet.
  const fresh = (await (await page.request.get(base + "/workspace")).json()).staff.find((s: { id: string }) => s.id === jay.id);
  await page.request.put(base + `/staff/${jay.id}`, { ...H, data: { name: jay.name, role: jay.role, version: fresh.version, pay_model: "CHAIR_RENT", deductions: [{ ...rent, day_basis: "BOOKED" }] } });
  const p2 = await (await page.request.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${mon}&to=${plus(mon, 6)}`)).json();
  expect(p2.result.deductions[0].pence).toBe(0);
  const hist = await (await page.request.get(base + `/staff/${jay.id}/pay-history`)).json();
  expect(hist.items.length).toBe(2);
  expect(hist.items[1].reason).toMatch(/^Before: 50% commission.*After: keeps all takings.*Day rent £25 a day \(days on the rota\)\.$/);
  // The Pay tab shows the short sections and the change log.
  await page.reload();
  await page.getByRole("button", { name: "Team", exact: true }).first().click();
  await page.getByTestId("team-card").filter({ hasText: "Jay Carter" }).click();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page.getByTestId("pay-section-rent")).toContainText("Day rent");
  await expect(page.getByTestId("pay-history-log")).toContainText("Was");
  await expect(page.getByTestId("day-basis")).toHaveValue("BOOKED");
});

test("the 'saved' notice clears itself", async ({ page }) => {
  await enterNewShop(page, "Notice shop");
  await page.getByRole("button", { name: "Team", exact: true }).first().click();
  await page.getByTestId("team-card").filter({ hasText: "Marcus Reed" }).click();
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await page.getByRole("button", { name: /^Days off/ }).click();
  const w = await (await page.request.get(base + "/workspace")).json();
  await page.getByLabel("Day off date").fill(plus(nextMonday(w.today), 1));
  await page.getByLabel("Day off reason").fill("Dentist");
  await page.getByRole("button", { name: "Save day off" }).click();
  const notice = page.getByTestId("workspace-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toBeHidden({ timeout: 10000 });
});
