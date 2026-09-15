// Pay terms + pay runs, and the top-bar search palette / account menu.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openFixtureShop, base, origin, section } from "./fixture";

test("pay terms: every model saves, summary reflects it, and the deal is snapshotted into pay runs", async ({ page }) => {
  test.setTimeout(120000);
  await openFixtureShop(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  const jay = w.staff.find((s: any) => s.name === "Jay Carter");
  await section(page, "Team");
  await page.getByTestId("team-card").filter({ hasText: "Jay Carter" }).click();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  const terms = page.getByTestId("pay-terms");
  await expect(terms).toBeVisible();
  // Demo seed: tiered commission 55% / 65% above £1,000.
  await expect(page.getByTestId("pay-summary")).toContainText("55% · 65% above £1,000");
  // Switch to chair rent and save.
  await terms.getByRole("radio", { name: /Chair rent/ }).click();
  await terms.getByLabel("Chair rent per period (£)").fill("150");
  await expect(page.getByTestId("pay-summary")).toContainText("£150 chair rent weekly");
  await page.getByTestId("save-pay-terms").click();
  await expect(page.getByText("Pay terms saved", { exact: false })).toBeVisible();
  let fresh = (await (await page.request.get(base + "/workspace")).json()).staff.find((s: any) => s.id === jay.id);
  expect(fresh.pay_model).toBe("CHAIR_RENT");
  expect(fresh.rent_pence).toBe(15000);
  // Pay run preview for last week reflects rent: barber pays shop (rent − tips collected).
  const runs = page.getByTestId("pay-runs");
  await expect(runs).toContainText("Chair rent owed to shop");
  // Create → approve → mark paid; then the run is frozen and the history shows it.
  await page.getByTestId("create-pay-run").click();
  await expect(page.getByTestId("approve-pay-run")).toBeVisible();
  await page.getByTestId("approve-pay-run").click();
  await page.getByLabel("Payment reference").fill("BACS 0912");
  await page.getByTestId("mark-paid").click();
  await expect(runs).toContainText("Paid by bank · BACS 0912 · frozen");
  const list = await (await page.request.get(base + "/pay-runs")).json();
  const run = list.pay_runs.find((r: any) => r.staff_id === jay.id && r.status === "PAID");
  expect(run).toBeTruthy();
  expect(JSON.parse(run.terms_json).pay_model).toBe("CHAIR_RENT");
  expect(run.rent_pence).toBe(15000);
  // Frozen: any further edit is refused; duplicate live run for the period is refused.
  let r = await page.request.put(base + `/pay-runs/${run.id}`, { headers: { Origin: origin }, data: { version: run.version, status: "APPROVED" } });
  expect(r.status()).toBe(409);
  r = await page.request.post(base + "/pay-runs", { headers: { Origin: origin }, data: { staff_id: jay.id, period_from: run.period_from, period_to: run.period_to } });
  expect(r.status()).toBe(409);
  // Changing terms afterwards does not touch the paid run.
  await terms.getByRole("radio", { name: /Hourly/ }).click();
  await terms.getByLabel("Hourly rate (£)").fill("14.50");
  await page.getByTestId("save-pay-terms").click();
  await expect(page.getByText("Pay terms saved", { exact: false })).toBeVisible();
  const after = (await (await page.request.get(base + "/pay-runs")).json()).pay_runs.find((x: any) => x.id === run.id);
  expect(after.rent_pence).toBe(15000);
  expect(after.pay_model).toBe("CHAIR_RENT");
  // Hourly preview uses rostered hours.
  await expect(runs).toContainText("Rostered hours");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
});

test("pay run maths: tiered commission is marginal, hybrid applies base + commission above threshold, adjustments move net", async ({ page }) => {
  await openFixtureShop(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  const jay = w.staff.find((s: any) => s.name === "Jay Carter");
  const dani = w.staff.find((s: any) => s.name === "Dani Okoro");
  // 60 days back covers seeded ledger rows; preview returns figures + result.
  const from = new Date(w.today + "T12:00:00Z");
  from.setUTCDate(from.getUTCDate() - 27);
  const f = from.toISOString().slice(0, 10);
  const p = await (await page.request.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${f}&to=${w.today}`)).json();
  const svc = p.input.service_pence;
  const expected = svc <= 100000 ? Math.round(svc * 0.55) : Math.round(100000 * 0.55) + Math.round((svc - 100000) * 0.65);
  expect(p.result.commission_pence).toBe(expected);
  expect(p.result.tip_pence).toBe(p.input.tips_pence);
  expect(p.result.net_pence).toBe(expected + p.input.tips_pence);
  const d = await (await page.request.get(base + `/pay-runs/preview?staff_id=${dani.id}&from=${f}&to=${w.today}`)).json();
  expect(d.terms.pay_model).toBe("HYBRID");
  expect(d.result.base_pence).toBe(120000 * d.input.periods);
  expect(d.result.commission_pence).toBe(Math.round(Math.max(0, d.input.service_pence - 200000) * 0.55));
  // Draft with adjustments; net = calc + adjustments.
  let r = await page.request.post(base + "/pay-runs", { headers: { Origin: origin }, data: { staff_id: jay.id, period_from: f, period_to: w.today, adjustments: [{ label: "Product bonus", pence: 2500 }, { label: "Late fee", pence: -1000 }] } });
  expect(r.status(), await r.text()).toBe(201);
  const run = (await r.json()).pay_run;
  expect(run.adjustments_pence).toBe(1500);
  expect(run.net_pence).toBe(p.result.net_pence + 1500);
  // Void needs a reason; then a new run for the same period is allowed.
  r = await page.request.put(base + `/pay-runs/${run.id}`, { headers: { Origin: origin }, data: { version: run.version, status: "VOID", reason: "" } });
  expect(r.status()).toBe(400);
  r = await page.request.put(base + `/pay-runs/${run.id}`, { headers: { Origin: origin }, data: { version: run.version, status: "VOID", reason: "Wrong period" } });
  expect(r.status()).toBe(200);
  r = await page.request.post(base + "/pay-runs", { headers: { Origin: origin }, data: { staff_id: jay.id, period_from: f, period_to: w.today } });
  expect(r.status()).toBe(201);
});

test("top bar: search palette opens in place and deep-links; account menu offers sections and sign out", async ({ page }) => {
  await openFixtureShop(page);
  // Search stays on the same screen and finds customers, appointments, services, barbers and sections.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const palette = page.getByTestId("search-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("option", { name: /Settings/ })).toBeVisible(); // sections listed before typing
  await palette.getByLabel("Search everything").fill("skin fade");
  await expect(palette.getByRole("option", { name: /Skin fade/ }).first()).toBeVisible();
  await palette.getByLabel("Search everything").fill("Ada Lovelace");
  await expect(palette.getByRole("option", { name: /Ada Lovelace/ }).first()).toBeVisible();
  await palette.getByRole("option", { name: /07700901000/ }).click();
  await expect(palette).toBeHidden();
  await expect(page.getByTestId("customer-profile").getByRole("heading", { level: 2 })).toHaveText("Ada Lovelace");
  // "/" shortcut opens it; a barber hit opens the Team editor on that barber.
  await page.keyboard.press("/");
  await expect(palette).toBeVisible();
  await palette.getByLabel("Search everything").fill("Dani");
  await palette.getByRole("option", { name: /Dani Okoro/ }).first().click();
  await expect(page.getByTestId("barber-editor").getByRole("heading", { level: 2 })).toHaveText("Dani Okoro");
  // Account pill opens a menu instead of navigating away.
  await page.getByTestId("account-pill").click();
  const menu = page.getByTestId("account-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("owner");
  await expect(page.getByTestId("barber-editor")).toBeVisible(); // still on Team
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await menu.getByRole("menuitem", { name: "Shop settings" }).click();
  await expect(page.getByRole("heading", { name: "Shop settings" })).toBeVisible();
  await page.getByTestId("account-pill").click();
  await page.getByTestId("sign-out").click();
  await expect(page.getByRole("heading", { name: "Open the demo shop" })).toBeVisible();
});

test("settings lists every customer page with live links and the plan is readable in-app", async ({ page }) => {
  await openFixtureShop(page);
  await section(page, "Settings");
  const panel = page.getByTestId("customer-pages");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("view-home-page")).toHaveAttribute("href", /\/demo[a-z0-9-]*$/);
  await expect(panel.getByTestId("view-booking-page")).toHaveAttribute("href", /\/book\/demo/);
  await panel.getByTestId("make-manage-link").click();
  const link = panel.getByTestId("view-manage-page");
  await expect(link).toHaveAttribute("href", /\/manage\//);
  const manage = await page.request.get((await link.getAttribute("href"))!);
  expect(manage.status()).toBe(200);
  await expect(panel).toContainText("Shop home page");
  await expect(panel).toContainText("Customer accounts");
  const plan = await page.request.get("/docs/customer-plan");
  expect(plan.status()).toBe(200);
  expect(await plan.text()).toContain("Customer accounts");
  // Account menu offers the customer view without leaving the admin.
  await page.getByTestId("account-pill").click();
  await expect(page.getByTestId("account-menu").getByRole("menuitem", { name: /View shop page as a customer/ })).toBeVisible();
});
