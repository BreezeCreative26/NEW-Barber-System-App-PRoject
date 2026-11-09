// Reviews per barber: the website shows each barber's own rating and "Read reviews" under their
// card (hidden ones left out); the Reviews drawer lists every barber and filters to theirs; each
// barber's page has a Reviews tab with only their reviews.
import { test, expect, request } from "@playwright/test";
import { base, origin, openFixtureShop, section } from "./fixture";

type Review = { id: string; staff_id: string | null; status: string; version: number; display_name: string; body: string };

test("API: shop page gives each barber only their own shown reviews; hiding one removes it from that barber", async () => {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const { slug } = (await res.json()) as { slug: string };
  const all = (await (await r.get(base + "/reviews")).json()).reviews as Review[];
  const shown = all.filter((x) => x.status === "PUBLISHED" && x.staff_id);
  expect(shown.length, "fixture has shown reviews").toBeGreaterThan(0);
  const page = await (await r.get(`${origin}/api/public/shops/${slug}/page`)).json();
  const per = page.staff_reviews as Record<string, { count: number; average: number; reviews: { id: string }[] }>;
  // Every barber's list is exactly their own shown reviews.
  for (const [sid, b] of Object.entries(per)) {
    const mine = shown.filter((x) => x.staff_id === sid);
    expect(b.count).toBe(mine.length);
    for (const x of b.reviews) expect(mine.some((m) => m.id === x.id)).toBe(true);
  }
  // A hidden review never appears under anyone.
  const hiddenIds = all.filter((x) => x.status === "HIDDEN").map((x) => x.id);
  for (const b of Object.values(per)) for (const x of b.reviews) expect(hiddenIds).not.toContain(x.id);
  // Hide one: it drops off that barber (count goes down), show it again: back.
  const target = shown[0];
  const before = per[target.staff_id!].count;
  expect((await r.post(base + `/reviews/${target.id}/status`, { data: { status: "HIDDEN", version: target.version } })).status()).toBe(200);
  let after = (await (await r.get(`${origin}/api/public/shops/${slug}/page`)).json()).staff_reviews;
  expect(after[target.staff_id!]?.count ?? 0).toBe(before - 1);
  expect((after[target.staff_id!]?.reviews ?? []).some((x: { id: string }) => x.id === target.id)).toBe(false);
  expect((await r.post(base + `/reviews/${target.id}/status`, { data: { status: "PUBLISHED", version: target.version + 1 } })).status()).toBe(200);
  after = (await (await r.get(`${origin}/api/public/shops/${slug}/page`)).json()).staff_reviews;
  expect(after[target.staff_id!].count).toBe(before);
  await r.dispose();
});

test("website: barber card shows their rating and Read reviews opens only their reviews", async ({ page }) => {
  const { slug } = await openFixtureShop(page);
  const data = await (await page.request.get(`${origin}/api/public/shops/${slug}/page`)).json();
  const sid = Object.keys(data.staff_reviews)[0];
  const barber = (data.staff as { id: string; name: string }[]).find((s) => s.id === sid)!;
  await page.context().clearCookies();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${slug}`);
  const card = page.locator(".sp-barber").filter({ hasText: barber.name });
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByTestId("barber-rating")).toContainText(`${data.staff_reviews[sid].count} review`);
  const btn = card.getByTestId("barber-read-reviews");
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  const list = card.getByTestId("barber-reviews");
  await expect(list.getByTestId("barber-review")).toHaveCount(Math.min(20, data.staff_reviews[sid].count));
  await page.screenshot({ path: "test-results/barber-reviews/website-card.png", fullPage: false });
  await btn.click();
  await expect(card.getByTestId("barber-reviews")).toHaveCount(0);
});

test("workspace: Reviews drawer lists every barber and filters; barber page has a Reviews tab with only theirs", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFixtureShop(page, "owner");
  const w = await (await page.request.get(base + "/workspace")).json();
  const all = (await (await page.request.get(base + "/reviews")).json()).reviews as Review[];
  const active = (w.staff as { id: string; name: string; active: number }[]).filter((s) => s.active);
  await page.getByTestId("reviews-chip").click();
  const panel = page.getByTestId("reviews-drawer").getByTestId("reviews-panel");
  // Every active barber has a button, even with no reviews.
  await expect(panel.getByTestId("review-person")).toHaveCount(active.length + new Set(all.filter((x) => x.staff_id && !active.some((a) => a.id === x.staff_id)).map((x) => x.staff_id)).size);
  const withReviews = active.find((s) => all.some((x) => x.staff_id === s.id))!;
  await panel.locator(`[data-testid="review-person"][data-staff="${withReviews.id}"]`).click();
  const rows = panel.getByTestId("review-row");
  await expect(rows).toHaveCount(all.filter((x) => x.staff_id === withReviews.id).length);
  for (const sid of await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-staff")))) expect(sid).toBe(withReviews.id);
  await page.screenshot({ path: "test-results/barber-reviews/drawer-filtered.png" });
  await panel.getByTestId("review-person-all").click();
  await expect(rows).toHaveCount(all.length);
  await page.getByRole("button", { name: "Close reviews" }).click();

  // Barber page → Reviews tab: only that barber's reviews, with hide available.
  await section(page, "Team");
  await page.getByTestId("team-card").filter({ hasText: withReviews.name }).click();
  await page.getByTestId("barber-tab-reviews").click();
  const tab = page.getByTestId("barber-editor").getByTestId("reviews-panel");
  await expect(tab.getByRole("heading", { name: `${withReviews.name.split(" ")[0]} reviews` })).toBeVisible();
  await expect(tab.getByTestId("review-row")).toHaveCount(all.filter((x) => x.staff_id === withReviews.id).length);
  await expect(tab.getByTestId("review-toggle").first()).toContainText(/Hide from website|Show on website/);
  await page.screenshot({ path: "test-results/barber-reviews/barber-tab.png" });
});
