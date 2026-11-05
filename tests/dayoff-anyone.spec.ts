// Customer booking: a barber's day off reads "Day off" (not "Closed"), and "Anyone" lists every
// barber's own times in a fair random order. Booking a time under a barber books that barber.
import { test, expect, type Page } from "@playwright/test";
import { openFixtureShop, base, origin } from "./fixture";
import { signInCustomer } from "./shop";

type Day = { date: string; available: number; closed: boolean; beyond: boolean; reason?: string };
const pub = (slug: string) => `${origin}/api/public/shops/${slug}`;

async function setup(page: Page) {
  const fx = await openFixtureShop(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  const svc = w.services[0];
  const days = async (staff: string): Promise<Day[]> =>
    (await (await page.request.get(`${pub(fx.slug)}/days?service_id=${svc.id}&staff_id=${staff}`)).json()).days;
  return { fx, w, svc, days };
}
const dayButton = (page: Page, label: RegExp) => page.locator(".booking-dates button").filter({ has: page.locator("small", { hasText: label }) });

test("a barber's day off says Day off, the shop's closed day says Closed, and offers who is working", async ({ page }) => {
  test.setTimeout(120000);
  const { fx, w, svc, days } = await setup(page);
  const dani = w.staff[0];
  // Give Dani a day off on an open day this week (skip today so lead time can't interfere).
  const any = await days("any");
  const mine = await days(dani.id);
  const target = any.slice(1, 7).find((d) => !d.closed && !d.beyond && mine.find((m) => m.date === d.date && !m.closed));
  expect(target, "an open day this week").toBeTruthy();
  const off = await page.request.post(`${base}/staff/${dani.id}/days-off`, { headers: { Origin: origin }, data: { date: target!.date, reason: "Fictional day off" } });
  expect(off.status(), await off.text()).toBe(201);
  const after = await days(dani.id);
  expect(after.find((d) => d.date === target!.date)).toMatchObject({ closed: true, reason: "off" });
  const shut = after.slice(0, 7).find((d) => d.closed && d.reason === "shop");

  await page.goto(`/book/${fx.slug}?service=${svc.id}&staff=${dani.id}&step=2`);
  await expect(page.getByRole("heading", { name: "When suits you?" })).toBeVisible();
  // Day off: dashed, tappable, labelled "Day off" — never "Closed".
  const offBtn = page.locator(".booking-dates button.dayoff");
  await expect(offBtn).toHaveCount(after.slice(0, 7).filter((d) => d.reason === "off").length);
  await expect(offBtn.first()).toContainText("Day off");
  await expect(offBtn.first()).toBeEnabled();
  if (shut) {
    const closedBtn = dayButton(page, /^Closed$/);
    await expect(closedBtn.first()).toBeDisabled();
  }
  await page.locator(".booking-dates button", { has: page.locator("small", { hasText: "Day off" }) }).first().click();
  const note = page.getByTestId("barber-day-off");
  await expect(note).toContainText(`${dani.name.split(" ")[0]} has a day off`);
  await expect(page.locator(".time-groups")).toBeHidden();
  // "See who's working" switches to Anyone on that day; Dani is listed with "Day off".
  await page.getByTestId("dayoff-see-team").click();
  const rows = page.getByTestId("barber-row");
  await expect(rows.first()).toBeVisible();
  const daniRow = page.locator(`[data-testid="barber-row"][data-staff="${dani.id}"]`);
  await expect(daniRow).toHaveClass(/off/);
  await expect(daniRow).toContainText("Day off");
  // Working barbers come first, the barber on a day off last.
  await expect(rows.last()).toHaveAttribute("data-staff", dani.id);
  await expect(daniRow.locator(".time-slots button")).toHaveCount(0);
});

test("Anyone lists every barber's times and booking under one barber books that barber", async ({ page }) => {
  test.setTimeout(150000);
  const { fx, w, svc, days } = await setup(page);
  const any = await days("any");
  const date = any.slice(1).find((d) => !d.closed && !d.beyond && d.available > 10)!.date;
  const av = await (await page.request.get(`${pub(fx.slug)}/availability?service_id=${svc.id}&date=${date}`)).json();
  const working = av.team.filter((t: { off: boolean }) => !t.off);
  expect(working.length).toBeGreaterThan(1);

  await signInCustomer(page, fx.slug, { name: "Anyone Tester" });
  await page.goto(`/book/${fx.slug}?service=${svc.id}&staff=any&date=${date}&step=2`);
  await expect(page.getByTestId("barber-rows")).toBeVisible();
  const rows = page.getByTestId("barber-row");
  await expect(rows).toHaveCount(av.team.length);
  // Every working barber has their own times (no single name stamped on every slot).
  for (const t of working) {
    const row = page.locator(`[data-testid="barber-row"][data-staff="${t.id}"]`);
    await expect(row.locator("header strong")).toHaveText(t.name);
    expect(await row.locator(".time-slots button").count()).toBeGreaterThan(0);
  }
  // Pick a time under a barber the server would NOT have auto-assigned.
  const firstOpen = av.slots.find((s: { available: boolean }) => s.available);
  const pick = working.find((t: { id: string }) => t.id !== firstOpen.staff_id) || working[working.length - 1];
  const row = page.locator(`[data-testid="barber-row"][data-staff="${pick.id}"]`);
  const btn = row.locator(".time-slots button").first();
  const label = (await btn.getAttribute("aria-label"))!;
  expect(label).toContain(`with ${pick.name}`);
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Continue · \d{2}:\d{2}/ }).click();
  await expect(page.getByRole("heading", { name: "Check and confirm." })).toBeVisible();
  await expect(page.getByText(pick.name).first()).toBeVisible();
  const termsTick = page.getByTestId("terms-tick");
  if (await termsTick.count()) await termsTick.check();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.locator(".public-reference")).toHaveText(/^BRB-\d{4}$/);
  const day = await (await page.request.get(`${base}/bookings?date=${date}`)).json();
  const mine = day.bookings.find((b: { customer_name: string }) => b.customer_name === "Anyone Tester");
  expect(mine, "booking saved").toBeTruthy();
  expect(mine.staff_id).toBe(pick.id);
});

test("Anyone shows the barbers in a fair random order", async ({ page }) => {
  test.setTimeout(150000);
  const { fx, svc, days } = await setup(page);
  const any = await days("any");
  const date = any.slice(1).find((d) => !d.closed && !d.beyond && d.available > 10)!.date;
  const orders = new Set<string>();
  for (let i = 0; i < 8 && orders.size < 2; i++) {
    await page.goto(`/book/${fx.slug}?service=${svc.id}&staff=any&date=${date}&step=2`);
    await expect(page.getByTestId("barber-rows")).toBeVisible();
    const ids = await page.getByTestId("barber-row").evaluateAll((els) => els.filter((e) => !e.classList.contains("off")).map((e) => e.getAttribute("data-staff")).join(","));
    orders.add(ids);
  }
  expect(orders.size, "order changes between visits").toBeGreaterThan(1);
});
