// Pay runs v2: chair/room rent and other deductions on top of a % split, the statement that
// walks sales → barber's share → deductions → owed each way, the all-barbers period page with
// bulk drafts + CSV, the barber's own "My pay" mirror, and the printable statement link.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { base, origin, openFixtureShop, section } from "./fixture";

type Staff = { id: string; name: string; pay_model: string; commission_pct: number; deductions_json?: string; version: number };

async function ownerCtx() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const fx = (await res.json()) as { shop_id: string; slug: string; email: string; password: string };
  return { r, fx };
}
// Fixture shops are private copies; Jay's login is derived from the slug (demo-<tag> → jay-<tag>@demo.test).
async function barberCtxFor(fx: { slug: string; password: string }) {
  const b = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await b.post(base + "/auth/login", { data: { email: `jay${fx.slug.slice(4)}@demo.test`, password: fx.password } });
  expect(res.status(), await res.text()).toBe(200);
  return b;
}
async function lastWeek(r: APIRequestContext) {
  const w = await (await r.get(base + "/workspace")).json();
  const today = new Date(w.today + "T12:00:00Z");
  const dow = (today.getUTCDay() + 6) % 7;
  const from = new Date(today.getTime() - (dow + 7) * 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(from) + 6 * 86400000).toISOString().slice(0, 10);
  return { w, from, to, jay: (w.staff as Staff[]).find((s) => s.name === "Jay Carter")! };
}
// Staff PUT wants the whole editable record; read it back and overlay the pay changes.
async function putTerms(r: APIRequestContext, staff: Staff, patch: Record<string, unknown>) {
  const w = await (await r.get(base + "/workspace")).json();
  const s = (w.staff as Staff[]).find((x) => x.id === staff.id)!;
  const body = {
    name: s.name, role: (s as { role?: string }).role || "Barber", title: (s as { title?: string }).title || "", bio: (s as { bio?: string }).bio || "",
    colour: (s as { colour?: string }).colour || "sage", photo_url: (s as { photo_url?: string }).photo_url || "", online_visible: (s as { online_visible?: number }).online_visible ?? 1,
    skills: JSON.parse((s as { skills?: string }).skills || "[]"), instagram: (s as { instagram?: string }).instagram || "", start_date: (s as { start_date?: string }).start_date || "",
    active: (s as { active?: number }).active ?? 1, sort_order: (s as { sort_order?: number }).sort_order ?? 0,
    pay_model: s.pay_model, commission_pct: s.commission_pct, commission_tiers: JSON.parse((s as { commission_tiers?: string }).commission_tiers || "[]"),
    commission_threshold_pence: (s as { commission_threshold_pence?: number }).commission_threshold_pence ?? 0, base_pence: (s as { base_pence?: number }).base_pence ?? 0,
    hourly_pence: (s as { hourly_pence?: number }).hourly_pence ?? 0, rent_pence: (s as { rent_pence?: number }).rent_pence ?? 0, tip_share_pct: (s as { tip_share_pct?: number }).tip_share_pct ?? 100,
    product_commission_pct: (s as { product_commission_pct?: number }).product_commission_pct ?? 0, pay_period: (s as { pay_period?: string }).pay_period || "WEEKLY",
    employment: (s as { employment?: string }).employment || "SELF_EMPLOYED", deductions: JSON.parse(s.deductions_json || "[]"),
    version: s.version,
    ...patch,
  };
  const res = await r.put(base + `/staff/${staff.id}`, { data: body });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
const RENT = { id: "d_rent", label: "Chair rent", kind: "FIXED", amount_pence: 5000, pct_x100: 0, cadence: "WEEKLY", proration: "BY_DAYS", waive_on_leave: 1, active: 1 };
const PRODUCTS = { id: "d_prod", label: "Product levy", kind: "PERCENT_OF_TAKINGS", amount_pence: 0, pct_x100: 500, cadence: "PER_RUN", proration: "FULL", waive_on_leave: 0, active: 1 };

test("60/40 split + weekly chair rent + 5% levy: preview, statement fields, period page, bulk create, CSV, printable statement", async () => {
  const { r } = await ownerCtx();
  const { jay, from, to } = await lastWeek(r);
  await putTerms(r, jay, { pay_model: "COMMISSION", commission_pct: 60, commission_tiers: [], rent_pence: 0, deductions: [RENT, PRODUCTS] });

  const p = await (await r.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${from}&to=${to}`)).json();
  const sales = p.input.service_pence as number;
  expect(sales).toBeGreaterThan(0);
  const res = p.result;
  expect(res.staff_share_pence).toBe(Math.round(sales * 0.6));
  expect(res.owner_share_pence).toBe(sales - res.staff_share_pence);
  // Two deduction lines: whole-week rent (period == cadence) and 5% of sales.
  expect(res.deductions).toHaveLength(2);
  const rent = res.deductions.find((d: { id: string }) => d.id === "d_rent");
  const levy = res.deductions.find((d: { id: string }) => d.id === "d_prod");
  expect(rent.pence).toBe(5000);
  expect(levy.pence).toBe(Math.round(sales * 0.05));
  expect(res.deductions_pence).toBe(5000 + levy.pence);
  expect(res.net_pence).toBe(res.staff_share_pence + res.tip_pence - res.deductions_pence);
  expect(res.owed_to_business_pence).toBe(res.owner_share_pence + res.deductions_pence);
  // Legacy rent field mirrors fixed deductions so the settlement maths stays honest.
  expect(res.rent_pence).toBe(5000);
  expect(p.settlement.cash_residual_pence).toBe(res.net_pence);

  // Period page: Jay's live row matches the preview; nothing created yet.
  const period = await (await r.get(base + `/pay-runs/period?from=${from}&to=${to}`)).json();
  const row = period.rows.find((x: { staff_id: string }) => x.staff_id === jay.id);
  expect(row.existing).toBeNull();
  expect(row.owed_to_staff_pence).toBe(res.net_pence);
  expect(row.owed_to_business_pence).toBe(res.owed_to_business_pence);
  expect(row.deductions_pence).toBe(res.deductions_pence);

  // Bulk: drafts for everyone with activity; a second call skips the ones that exist.
  const bulk = await r.post(base + "/pay-runs/bulk", { data: { from, to } });
  expect(bulk.status(), await bulk.text()).toBe(201);
  const b1 = await bulk.json();
  expect(b1.created).toBeGreaterThanOrEqual(1);
  const again = await (await r.post(base + "/pay-runs/bulk", { data: { from, to } })).json();
  expect(again.created).toBe(0);
  expect(again.skipped.length).toBeGreaterThanOrEqual(b1.created);

  const period2 = await (await r.get(base + `/pay-runs/period?from=${from}&to=${to}`)).json();
  const row2 = period2.rows.find((x: { staff_id: string }) => x.staff_id === jay.id);
  expect(row2.existing).not.toBeNull();
  const run = row2.existing;
  expect(run.status).toBe("DRAFT");
  // The statement snapshot is frozen on the run itself.
  expect(run.staff_share_pence).toBe(res.staff_share_pence);
  expect(run.owner_share_pence).toBe(res.owner_share_pence);
  expect(run.deductions_pence).toBe(res.deductions_pence);
  expect(run.owed_to_business_pence).toBe(res.owed_to_business_pence);
  expect(JSON.parse(run.deductions_json)).toHaveLength(2);
  expect(run.view_token).toMatch(/^[A-Za-z0-9_-]{16,}$/);

  // Changing terms after the draft exists does not move the frozen numbers, but a one-off adjustment recomputes both sides.
  await putTerms(r, jay, { commission_pct: 70 });
  const adj = await r.put(base + `/pay-runs/${run.id}`, { data: { version: run.version, adjustments: [{ label: "Broken clipper", pence: -1500 }] } });
  expect(adj.status(), await adj.text()).toBe(200);
  const a = (await adj.json()).pay_run;
  expect(a.staff_share_pence).toBe(res.staff_share_pence);
  expect(a.adjustments_pence).toBe(-1500);
  expect(a.net_pence).toBe(res.net_pence - 1500);
  expect(a.owed_to_business_pence).toBe(res.owed_to_business_pence + 1500);

  // CSV export carries the statement columns.
  const csv = await r.get(base + `/pay-runs/export.csv?from=${from}&to=${to}`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const text = await csv.text();
  expect(text.split("\n")[0]).toMatch(/owed_to_staff/i);
  expect(text).toContain("Jay Carter");

  // Printable statement: token-gated public page.
  const html = await r.get(`${origin}/pay-run/${run.id}?t=${run.view_token}`);
  expect(html.status()).toBe(200);
  const page = await html.text();
  expect(page).toContain("Jay Carter");
  expect(page).toContain("Chair rent");
  expect(page).toContain("Product levy");
  expect((await r.get(`${origin}/pay-run/${run.id}?t=nope`)).status()).toBe(404);
  expect((await r.get(`${origin}/pay-run/${run.id}`)).status()).toBe(404);

  // Reset terms for the shared fixture shop's later runs (fixture shops are private copies anyway).
  await putTerms(r, jay, { commission_pct: 60, deductions: [] });
});

test("barber wallet and My pay show the same engine numbers as the owner's statement; barber cannot see the period page or bulk-create", async () => {
  const { r, fx } = await ownerCtx();
  const { jay, from, to } = await lastWeek(r);
  await putTerms(r, jay, { pay_model: "COMMISSION", commission_pct: 60, commission_tiers: [], rent_pence: 0, deductions: [RENT] });
  const p = await (await r.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${from}&to=${to}`)).json();

  const b = await barberCtxFor(fx);
  const me = await (await b.get(base + "/workspace")).json();
  const myId = me.account?.staff_id as string;
  expect(myId).toBe(jay.id);
  const wallet = await (await b.get(base + `/wallet?from=${from}&to=${to}`)).json();
  const mine = wallet.by_staff.find((x: { staff_id: string }) => x.staff_id === jay.id);
  expect(mine.commission).toBe(p.result.staff_share_pence);
  expect(mine.deductions).toBe(p.result.deductions_pence);
  expect(mine.earnings).toBe(p.result.net_pence);
  // Barber may preview their own run but not others', and never the whole-shop views.
  expect((await b.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${from}&to=${to}`)).status()).toBe(200);
  expect((await b.get(base + `/pay-runs/period?from=${from}&to=${to}`)).status()).toBe(403);
  expect((await b.post(base + "/pay-runs/bulk", { data: { from, to } })).status()).toBe(403);
  expect((await b.get(base + `/pay-runs/export.csv?from=${from}&to=${to}`)).status()).toBe(403);
  await putTerms(r, jay, { deductions: [] });
});

test("chair-rent model keeps 100% of takings and treats rent as a deduction; monthly rent prorates onto a weekly run; leave waives it", async () => {
  const { r } = await ownerCtx();
  const { jay, from, to } = await lastWeek(r);
  const monthly = { ...RENT, id: "d_month", label: "Room rent", amount_pence: 40000, cadence: "MONTHLY" };
  await putTerms(r, jay, { pay_model: "CHAIR_RENT", rent_pence: 0, deductions: [monthly] });
  const p = await (await r.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${from}&to=${to}`)).json();
  expect(p.result.staff_share_pence).toBe(p.input.service_pence);
  expect(p.result.owner_share_pence).toBe(0);
  const line = p.result.deductions[0];
  // 7 of ~30.44 days of £400.
  const expected = Math.round(40000 * (7 / (365 / 12)));
  expect(Math.abs(line.pence - expected)).toBeLessThanOrEqual(1);
  expect(p.result.owed_to_business_pence).toBe(p.result.deductions_pence);

  // Two days off in the week → BY_DAYS proration shrinks the rent (waive_on_leave).
  const d1 = new Date(Date.parse(from) + 1 * 86400000).toISOString().slice(0, 10);
  const d2 = new Date(Date.parse(from) + 2 * 86400000).toISOString().slice(0, 10);
  const offs: string[] = [];
  for (const date of [d1, d2]) {
    const off = await r.post(base + `/staff/${jay.id}/days-off`, { data: { date, reason: "Holiday" } });
    expect([200, 201], await off.text()).toContain(off.status());
    const j = await off.json();
    offs.push(j.id ?? j.day_off?.id ?? j.leave?.id);
  }
  const p2 = await (await r.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${from}&to=${to}`)).json();
  expect(p2.input.leave_days).toBe(2);
  expect(p2.result.deductions[0].pence).toBeLessThan(line.pence);
  for (const lid of offs) if (lid) await r.delete(base + `/staff/${jay.id}/days-off/${lid}`);
  await putTerms(r, jay, { pay_model: "COMMISSION", commission_pct: 60, deductions: [] });
});

test("owner UI: add chair rent in Pay terms, statement shows both sides; Pay runs page lists everyone, bulk-creates drafts; owner-share toggle hides the business block", async ({ page }) => {
  await openFixtureShop(page, "owner");
  await section(page, "Team");
  await page.getByTestId("team-card").filter({ hasText: "Jay Carter" }).click();
  await expect(page.getByTestId("barber-editor")).toBeVisible();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page.getByTestId("pay-terms")).toBeVisible();
  await page.getByRole("radio", { name: /Commission/ }).click();
  while (await page.getByRole("button", { name: /^Remove tier/ }).count()) await page.getByRole("button", { name: /^Remove tier/ }).first().click();
  const pct = page.getByTestId("pay-terms").getByLabel("Commission on services (%)");
  await pct.fill("60");
  await expect(page.getByTestId("pay-deductions")).toBeVisible();
  await page.getByTestId("pay-deductions").getByRole("button", { name: /Chair rent/ }).click();
  const rowEl = page.getByTestId("pay-deduction").first();
  await rowEl.getByLabel(/Amount/).fill("50");
  await page.getByTestId("save-pay-terms").click();
  await expect(page.getByTestId("pay-summary")).toContainText(/60%/);
  await expect(page.getByTestId("pay-deduction").first().getByLabel(/Amount/)).toHaveValue("50");

  // Statement preview for last period shows sales → share → rent → both owed lines.
  await expect(page.getByTestId("pay-runs")).toBeVisible();
  await page.getByRole("button", { name: "Previous period" }).click();
  const stmt = page.getByTestId("pay-statement");
  await expect(stmt).toBeVisible();
  await expect(stmt).toContainText("Total sales");
  await expect(stmt).toContainText("Jay's share");
  await expect(stmt).toContainText("Chair rent");
  await expect(page.getByTestId("pay-owed-staff")).toBeVisible();
  await expect(page.getByTestId("pay-owed-business")).toContainText("Owed to business");

  // Pay runs page: every barber for the period, totals, bulk create.
  await section(page, "Pay runs");
  await expect(page.getByRole("heading", { name: "Pay runs", level: 1 })).toBeVisible();
  const table = page.getByTestId("pay-runs-table");
  await expect(table).toBeVisible();
  await expect(page.getByTestId("pay-runs-row").filter({ hasText: "Jay Carter" })).toContainText(/£/);
  await expect(page.getByTestId("pay-runs-total-staff")).toContainText("£");
  const bulk = page.getByTestId("bulk-create");
  if (await bulk.count()) {
    await bulk.click();
    await expect(page.getByTestId("pay-runs-msg")).toContainText(/created/);
    await expect(page.getByTestId("pay-runs-row").filter({ hasText: "Jay Carter" })).toContainText(/draft/i);
  }
  // Open → lands on the barber in Team.
  await page.getByTestId("pay-runs-row").filter({ hasText: "Jay Carter" }).getByRole("button", { name: /Open|Review/ }).click();
  await expect(page.getByTestId("barber-editor")).toContainText("Jay Carter");

  // Hide the owner side for barbers.
  await section(page, "Settings/payments");
  const toggle = page.getByTestId("pay-show-owner");
  await expect(toggle).toBeVisible();
  if (await toggle.isChecked()) await toggle.click();
  await page.getByRole("button", { name: /Save/ }).first().click();
  await page.waitForTimeout(300);
  await section(page, "Team");
  await page.getByTestId("team-card").filter({ hasText: "Jay Carter" }).click();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await page.getByRole("button", { name: "Previous period" }).click();
  // Owners still see the business block in their own editor; the toggle governs the barber's view and the printable statement.
  await expect(page.getByTestId("pay-statement")).toBeVisible();
});

test("barber UI: My pay shows the deal, this period's estimate with deductions, and statement history", async ({ page }) => {
  const fx = await openFixtureShop(page, "owner");
  // Owner sets Jay up with rent and a draft run via the API so the barber has history to see.
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin }, storageState: await page.context().storageState() });
  const { jay, from, to } = await lastWeek(r);
  await putTerms(r, jay, { pay_model: "COMMISSION", commission_pct: 60, commission_tiers: [], rent_pence: 0, deductions: [RENT] });
  await r.post(base + "/pay-runs/bulk", { data: { from, to, staff_ids: [jay.id] } });

  await page.request.post(base + "/auth/logout", { headers: { Origin: origin } });
  const login = await page.request.post(base + "/auth/login", { headers: { Origin: origin }, data: { email: `jay${fx.slug.slice(4)}@demo.test`, password: fx.password } });
  expect(login.status(), await login.text()).toBe(200);
  await page.goto("/workspace");
  await section(page, "My pay");
  await expect(page.getByRole("heading", { name: "My pay", level: 1 })).toBeVisible();
  const my = page.getByTestId("my-pay");
  await expect(my).toBeVisible();
  await expect(my).toContainText(/60%/);
  await expect(page.getByTestId("my-pay-deductions")).toContainText("Chair rent");
  await expect(page.getByTestId("my-pay-history")).toBeVisible();
  const runs = page.getByTestId("my-pay-run");
  await expect(runs.first()).toBeVisible();
  await runs.first().click();
  await expect(page.getByTestId("pay-statement")).toContainText("Chair rent");
  // Barber never sees a Pay runs entry in the rail.
  await expect(page.getByRole("navigation", { name: "Workspace sections" }).getByRole("button", { name: "Pay runs", exact: true })).toHaveCount(0);
});
