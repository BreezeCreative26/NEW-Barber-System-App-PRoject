// The review email sends account holders to <shop>/me?visit=<id>. That page must show the
// "How was it?" card on that visit, save the review, and the owner must see it in Reviews.
import { test, expect, request } from "@playwright/test";
import { base, origin } from "./fixture";

const PHONE = "07700901000"; // Ada Lovelace in the fixture shop, with completed visits

test("review email link: /me?visit opens the visit, the review saves, and the owner sees it", async ({ page }) => {
  test.skip(new Date().getUTCDay() === 0, "fixture has no completed visits for Ada on Sundays");
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const { slug } = (await res.json()) as { slug: string };
  const before = await (await r.get(base + "/reviews")).json();

  await page.goto(`/${slug}`);
  const ok = await page.evaluate(async ({ slug, phone }) => {
    const post = (p: string, b: unknown) => fetch(`/api/public/shops/${slug}/account/${p}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((x) => x.json().then((j) => ({ s: x.status, j })));
    const st = await post("start", { phone });
    const v = await post("verify", { phone, code: st.j.sandbox_code });
    // A code-only account finishes its profile first (real review recipients already have one).
    if (v.j.needs_profile) {
      const shop = await (await fetch(`/api/public/shops/${slug}`)).json();
      const done = await post("complete", { name: "Ada Lovelace", email: `ada-${Date.now()}@example.test`, password: "Fictional-test-pass-2026!", accept_terms_version: shop.shop?.terms?.version || 0 });
      if (done.s >= 300) return done.s;
    }
    return v.s;
  }, { slug, phone: PHONE });
  expect(ok).toBe(201);
  const me = await page.evaluate(async (s) => (await fetch(`/api/public/shops/${s}/account/me`, { credentials: "same-origin" })).json(), slug);
  const visit = (me.history as { id: string; can_review: boolean; service_name: string }[]).find((v) => v.can_review);
  expect(visit, "Ada has a completed visit she can review").toBeTruthy();

  // Open exactly the link the email sends.
  await page.goto(`/${slug}/me?visit=${visit!.id}`);
  const row = page.locator(`#visit-${visit!.id}`);
  await expect(row).toBeVisible();
  const card = row.getByTestId("review-card");
  await expect(card).toContainText("How was it?");
  await expect(card.getByTestId("review-submit")).toBeDisabled();
  await card.getByTestId("star-5").click();
  await card.getByTestId("review-body").fill("Great cut, sorted me out quickly.");
  await card.getByTestId("review-submit").click();
  // Saved: the card flips to "You gave 5 out of 5" and can't be sent twice.
  await expect(row.getByRole("img", { name: "You gave 5 out of 5" })).toBeVisible();
  await expect(row.getByTestId("review-submit")).toHaveCount(0);
  const again = await page.evaluate(async (s) => (await fetch(`/api/public/shops/${s}/account/me`, { credentials: "same-origin" })).json(), slug);
  expect(again.history.find((v: { id: string }) => v.id === visit!.id).can_review).toBe(false);

  // Owner side: it's in Reviews and counts towards the rating.
  const after = await (await r.get(base + "/reviews")).json();
  expect(after.summary.count).toBe(before.summary.count + 1);
  const mine = after.reviews.find((x: { booking_id: string }) => x.booking_id === visit!.id);
  expect(mine).toMatchObject({ rating: 5, status: "PUBLISHED", body: "Great cut, sorted me out quickly." });
  // And on the public shop data.
  const shopPage = await page.evaluate(async (s) => (await fetch(`/api/public/shops/${s}/page`)).json(), slug);
  expect(shopPage.reviews.some((x: { id: string }) => x.id === mine.id)).toBe(true);
  await r.dispose();
});

test("owner Reviews button opens the list with the new review, and reply + hide work", async ({ page }) => {
  const { openFixtureShop } = await import("./fixture");
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFixtureShop(page, "owner");
  const data = await (await page.request.get(base + "/reviews")).json();
  test.skip(!data.reviews.length, "fixture shop has no reviews to moderate");
  await page.locator(".reviews-chip").click();
  const drawer = page.getByTestId("reviews-drawer");
  await expect(drawer).toBeVisible();
  const panel = drawer.getByTestId("reviews-panel");
  await expect(panel.getByTestId("review-row").first()).toBeVisible();
  await expect(panel.getByTestId("review-row")).toHaveCount(Math.min(data.reviews.length, 200));
  await page.screenshot({ path: "test-results/reviews/owner-drawer.png" });
  // Reply.
  const row = panel.getByTestId("review-row").first();
  await row.getByTestId("review-reply").click();
  await panel.getByTestId("reply-text").fill("Thanks for coming in!");
  await panel.getByTestId("reply-save").click();
  await expect(panel.getByTestId("review-row").first()).toContainText("Thanks for coming in!");
  // Hide then show.
  await panel.getByTestId("review-row").first().getByTestId("review-toggle").click();
  await expect(panel.getByTestId("review-row").first()).toContainText("Hidden");
  await panel.getByTestId("review-row").first().getByTestId("review-toggle").click();
  await expect(panel.getByTestId("review-row").first()).not.toContainText("Hidden");
});
