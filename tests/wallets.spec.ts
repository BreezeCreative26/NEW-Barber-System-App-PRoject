// Wallets overview (owner/manager): the aggregate endpoint, its CSV twin, role gating, range
// validation, and the panel rendering under Pay runs with a row per barber plus the shop.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { base, origin, openFixtureShop, section } from "./fixture";

type Fx = { shop_id: string; slug: string; email: string; password: string };
async function ownerCtx() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  return { r, fx: (await res.json()) as Fx };
}
async function barberCtxFor(fx: Fx) {
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
  return { w, from, to };
}

test.describe("wallets API", () => {
  test("owner gets a row per active barber plus the shop, totals reconcile, and a draft shows as awaiting", async () => {
    const { r } = await ownerCtx();
    const { w, from, to } = await lastWeek(r);
    // Create drafts for the period so awaiting_approval has something to count.
    const bulk = await r.post(base + "/pay-runs/bulk", { data: { from, to } });
    expect(bulk.status(), await bulk.text()).toBe(201);
    const res = await r.get(base + `/wallets?from=${from}&to=${to}`);
    expect(res.status(), await res.text()).toBe(200);
    const s = await res.json();
    expect(s.from).toBe(from);
    expect(s.to).toBe(to);
    expect(s.shop.owner_type).toBe("SHOP");
    expect(s.shop.owner_id).toBe(w.shop.id);
    const staffIds = (w.staff as { id: string }[]).map((x) => x.id).sort();
    expect((s.rows as { owner_id: string }[]).map((x) => x.owner_id).sort()).toEqual(staffIds);
    const runs = (await (await r.get(base + "/pay-runs")).json()).pay_runs as { status: string; net_pence: number; period_from: string; period_to: string }[];
    const drafts = runs.filter((x) => x.status === "DRAFT" && x.period_to >= from && x.period_to <= to);
    expect(drafts.length).toBeGreaterThan(0);
    expect(s.totals.awaiting_approval_pence).toBe(drafts.reduce((a, x) => a + x.net_pence, 0));
    // Every row's balance says where it came from; nothing is live in test mode without Connect accounts.
    for (const row of [...s.rows, s.shop]) {
      expect(typeof row.balance.live).toBe("boolean");
      if (!row.balance.live) expect(row.balance.note).toBeTruthy();
      expect(row.balance.available_pence).toBeGreaterThanOrEqual(0);
    }
    expect(s.totals.in_wallets_pence).toBe((s.rows as { balance: { available_pence: number; pending_pence: number } }[]).reduce((a, x) => a + x.balance.available_pence + x.balance.pending_pence, 0));
  });

  test("defaults to the last 30 days, rejects bad ranges and unknown params", async () => {
    const { r } = await ownerCtx();
    const d = await (await r.get(base + "/wallets")).json();
    expect(Math.round((Date.parse(d.to) - Date.parse(d.from)) / 86400000)).toBe(30);
    expect((await r.get(base + "/wallets?from=2026-02-10&to=2026-02-01")).status()).toBe(400);
    expect((await r.get(base + "/wallets?from=2024-01-01&to=2026-01-01")).status()).toBe(400);
    expect((await r.get(base + "/wallets?from=nope&to=2026-01-01")).status()).toBe(400);
    expect((await r.get(base + "/wallets?from=2026-01-01&to=2026-01-31&extra=1")).status()).toBe(400);
  });

  test("csv download matches the JSON rows", async () => {
    const { r } = await ownerCtx();
    const { from, to } = await lastWeek(r);
    const res = await r.get(base + `/wallets.csv?from=${from}&to=${to}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toContain(`wallets-${from}-to-${to}.csv`);
    const lines = (await res.text()).split("\n");
    const s = await (await r.get(base + `/wallets?from=${from}&to=${to}`)).json();
    expect(lines).toHaveLength(1 + s.rows.length + 1);
    expect(lines[0]).toBe("name,role,wallet_status,earned,awaiting_approval,moved_to_wallet,settled_by_hand,in_wallet_available,in_wallet_pending,balance_source,in_transit,reached_bank,payout_schedule");
    expect(lines[lines.length - 1].split(",")[1]).toBe("Shop");
  });

  test("a barber cannot read other people's wallets", async () => {
    const { fx } = await ownerCtx();
    const b = await barberCtxFor(fx);
    expect((await b.get(base + "/wallets")).status()).toBe(403);
    expect((await b.get(base + "/wallets.csv")).status()).toBe(403);
    // Their own wallet view still works.
    expect((await b.get(base + "/wallet")).status()).toBe(200);
  });
});

test.describe("wallets panel", () => {
  test("renders under Pay runs with a barber row, the shop row, totals and a CSV link", async ({ page }) => {
    await openFixtureShop(page);
    await section(page, "Pay runs");
    const panel = page.getByTestId("wallets");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("wallets-totals")).toBeVisible();
    const table = page.getByTestId("wallets-table");
    await expect(table).toBeVisible();
    expect(await page.getByTestId("wallets-row").count()).toBeGreaterThan(0);
    await expect(page.getByTestId("wallets-shop-row")).toHaveCount(1);
    await expect(page.getByTestId("wallets-shop-row")).toContainText("Shop wallet");
    await expect(page.getByTestId("wallets-source")).toContainText(/records|live/);
    const csv = page.getByTestId("wallets-csv");
    await expect(csv).toHaveAttribute("href", /\/api\/app\/wallets\.csv\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    // Period switch re-queries with the new bounds.
    const before = await csv.getAttribute("href");
    await page.getByRole("tab", { name: "Monthly" }).click();
    await expect(csv).not.toHaveAttribute("href", before!);
    // Table stays inside its card at 1024 rather than widening the page.
    await page.setViewportSize({ width: 1024, height: 900 });
    const docW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(docW).toBeLessThanOrEqual(1024);
  });

  test("phone: cards, no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFixtureShop(page);
    await section(page, "Pay runs");
    await expect(page.getByTestId("wallets-table")).toBeVisible();
    await page.getByTestId("wallets").scrollIntoViewIfNeeded();
    const docW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(docW).toBeLessThanOrEqual(390);
  });
});
