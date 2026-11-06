// Customer booking v5, service step: "Who's coming?" switch at the top, "Most booked here" first
// (Popular only on those), services under the shop's own section headings, real "From" prices
// (cheapest barber), "More" opens a long description, and two clear ways on in the bottom bar.
import { test, expect, request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { WorkspaceData } from "../src/server/domain";
import { base, origin } from "./shop";

async function fixture() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const { slug } = (await res.json()) as { slug: string };
  const w: WorkspaceData = await (await r.get(base + "/workspace")).json();
  return { r, slug, w };
}

test("shop API lists up to three most-booked services (ids only)", async () => {
  const { slug } = await fixture();
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const shop = await (await c.get(`${origin}/api/public/shops/${slug}`)).json();
  expect(Array.isArray(shop.top_services)).toBe(true);
  expect(shop.top_services.length).toBeLessThanOrEqual(3);
  for (const id of shop.top_services) expect(shop.services.some((s: { id: string }) => s.id === id)).toBe(true);
  await c.dispose();
});

test("service step: who's coming, most booked first, sections, From prices, More, two ways on", async ({ page }) => {
  const { slug } = await fixture();
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/book/${slug}`);
  const shop = await page.evaluate(async (s) => (await fetch(`/api/public/shops/${s}`)).json(), slug);

  // Who's coming? sits at the top with Just me chosen.
  const who = page.getByTestId("who-switch");
  await expect(who).toBeVisible();
  await expect(who.getByRole("button", { name: "Just me" })).toHaveAttribute("aria-pressed", "true");
  await expect(who.getByTestId("start-group")).toContainText("Me + someone else");

  // Most booked here: at most three, each tagged Popular; nobody else is tagged.
  const most = page.getByTestId("most-booked");
  await expect(most.getByRole("heading", { name: "Most booked here" })).toBeVisible();
  const mostCount = await most.locator(".service-item").count();
  expect(mostCount).toBeGreaterThan(0);
  expect(mostCount).toBeLessThanOrEqual(3);
  await expect(most.locator(".popular-pill")).toHaveCount(mostCount);
  await expect(page.locator(".popular-pill")).toHaveCount(mostCount);

  // The shop's own categories become headings; every service appears exactly once.
  const cats = [...new Set((shop.services as { category: string }[]).map((s) => s.category))];
  for (const c of cats) await expect(page.locator(".service-section-title", { hasText: c }).first()).toBeVisible();
  await expect(page.locator(".service-item")).toHaveCount(shop.services.length);

  // A service whose barbers charge different amounts shows "From" the cheapest.
  type Svc = { id: string; name: string; price_pence: number };
  type Rule = { staff_id: string; service_id: string; enabled: number; price_pence: number | null };
  const priced = (shop.services as Svc[]).map((s) => {
    const ps = (shop.service_rules as Rule[]).filter((r) => r.service_id === s.id && r.enabled).map((r) => r.price_pence ?? s.price_pence);
    return { s, lo: Math.min(...ps), hi: Math.max(...ps) };
  });
  const ranged = priced.find((p) => p.lo !== p.hi);
  if (ranged) {
    const card = page.locator(".service-item").filter({ hasText: ranged.s.name }).first();
    await expect(card.locator(".choice-end")).toContainText("From");
    await expect(card.locator(".choice-end")).toContainText(`£${(ranged.lo / 100).toFixed(ranged.lo % 100 ? 2 : 0)}`);
  }

  // "More" opens a long description and "Less" closes it.
  const more = page.locator(".service-more").first();
  if (await more.count()) {
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.click();
    await expect(page.locator(".service-more").first()).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".service-more").first()).toHaveText("Less");
  }

  // A service is chosen (the first is pre-selected on arrival): both ways on are enabled and the
  // total shows that service's price.
  const anyBtn = page.getByTestId("any-barber-skip");
  const pick = page.getByRole("button", { name: "Pick a barber", exact: true });
  await page.locator(".service-choice").first().click();
  await expect(page.locator(".service-choice").first()).toHaveAttribute("aria-pressed", "true");
  await expect(anyBtn).toBeEnabled();
  await expect(anyBtn).toContainText("See times · any barber");
  await expect(pick).toBeEnabled();
  await expect(page.locator(".booking-next-group")).toHaveAttribute("data-total", /£\d/);

  // Accessibility of the new step.
  const axe = await new AxeBuilder({ page }).include(".booking-flow").disableRules(["color-contrast"]).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);

  // Any barber goes straight to the times.
  await anyBtn.click();
  await expect(page.getByRole("heading", { name: "When suits you?" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("filtering by a category or searching drops the Most booked section", async ({ page }) => {
  const { slug } = await fixture();
  await page.goto(`/book/${slug}`);
  await expect(page.getByTestId("most-booked")).toBeVisible();
  const chips = page.getByRole("group", { name: "Service categories" }).getByRole("button");
  await chips.nth(1).click();
  await expect(page.getByTestId("most-booked")).toHaveCount(0);
  await chips.first().click();
  await expect(page.getByTestId("most-booked")).toBeVisible();
  // The search box only appears for shops with more than eight services.
  const search = page.getByLabel("Search services");
  if (await search.count()) {
    await search.fill("beard");
    await expect(page.getByTestId("most-booked")).toHaveCount(0);
    await expect(page.locator(".service-item").first()).toContainText(/beard/i);
  }
});
