// Shop page phase 2: server-rendered SEO head, robots/sitemap, hidden pages, verified reviews
// (customer submit, owner moderation, public display) and R2 photo uploads. See docs/SHOP-PAGE-PLAN.md.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { base, origin, openFixtureShop, section } from "./fixture";

const pub = origin + "/api/public";
type Booking = { id: string; status: string; version: number; phone: string; customer_name: string; staff_id: string; date: string };

async function fixture() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { slug: string; shop_id: string };
  const w = await (await r.get(base + "/workspace")).json();
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  return { r, c, w, slug: body.slug, P: `${pub}/shops/${body.slug}` };
}
// A demo-seeded completed visit in the past (owner range read), plus a fresh manage link for it.
async function completedVisit(r: APIRequestContext, w: { today: string }) {
  const from = new Date(new Date(w.today + "T12:00:00Z").getTime() - 20 * 86400000).toISOString().slice(0, 10);
  const to = new Date(new Date(w.today + "T12:00:00Z").getTime() - 1 * 86400000).toISOString().slice(0, 10);
  const range = await (await r.get(base + `/bookings/range?from=${from}&to=${to}`)).json();
  const done = (range.bookings as Booking[]).filter((b) => b.status === "COMPLETED");
  expect(done.length).toBeGreaterThan(3);
  return done;
}
async function manageToken(r: APIRequestContext, id: string) {
  const res = await r.post(base + `/bookings/${id}/manage-link`, { data: {} });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).token as string;
}
// A 1×1 PNG and a 1×1 JPEG, plus a text file pretending to be a PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

test("shop page head is rendered on the server: title, description, canonical, Open Graph, JSON-LD HairSalon with hours, catalogue and rating", async () => {
  const { r, w, slug } = await fixture();
  // Give the fixture a page with reviews-worthy data: seed already has staff/services; add a cover.
  const page = (await (await r.get(base + "/shop/page")).json()).page;
  const put = await r.put(base + "/shop/page", {
    data: { strapline: "Sharp cuts, straight talk.", about: page.about || "", cover_url: "/static/demo/cover.jpg", gallery: ["/static/demo/gallery-1.jpg"], phone: "020 7946 0111", email: "", instagram: "", map_url: "", transport_note: "", policy_text: "", sections: JSON.parse(page.sections_json || "[]").length ? JSON.parse(page.sections_json) : undefined, accent: "ollo", published: 1, version: page.version },
  });
  expect(put.status(), await put.text()).toBe(200);
  const html = await (await r.get(`${origin}/${slug}`)).text();
  expect(html).toContain(`<title>${w.shop.name} · Barbers in London</title>`);
  expect(html).toContain('<meta name="robots" content="index,follow"/>');
  expect(html).toContain(`<link rel="canonical" href="${origin}/${slug}"/>`);
  expect(html).toContain('<meta property="og:type" content="business.business"/>');
  expect(html).toContain(`<meta property="og:image" content="${origin}/static/demo/cover.jpg"/>`);
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image"/>');
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]);
  expect(ld["@type"]).toBe("HairSalon");
  expect(ld.name).toBe(w.shop.name);
  expect(ld.telephone).toBe("020 7946 0111");
  expect(ld.address).toMatchObject({ "@type": "PostalAddress", streetAddress: "12 Market Row", addressLocality: "London", addressCountry: "GB" });
  expect(ld.openingHoursSpecification.length).toBeGreaterThanOrEqual(5);
  expect(ld.openingHoursSpecification[0]).toMatchObject({ "@type": "OpeningHoursSpecification", opens: expect.stringMatching(/^\d{2}:\d{2}$/) });
  expect(ld.hasOfferCatalog.itemListElement.length).toBe(w.services.filter((s: { active: number; online_bookable: number }) => s.active && s.online_bookable).length);
  expect(ld.priceRange).toMatch(/^£\d+–£\d+$/);
  expect(ld.aggregateRating).toMatchObject({ "@type": "AggregateRating", bestRating: 5 });
  expect(ld.aggregateRating.reviewCount).toBeGreaterThan(5);
  expect(ld.employee.length).toBe(3);
  // Private pages stay out of search.
  for (const path of [`/book/${slug}`, `/${slug}/me`, "/workspace"]) expect(await (await r.get(origin + path)).text()).toContain('content="noindex,nofollow"');
  // robots + sitemap
  const robots = await (await r.get(origin + "/robots.txt")).text();
  expect(robots).toContain("Disallow: /api/");
  expect(robots).toContain("Disallow: /manage/");
  expect(robots).toContain(`Sitemap: ${origin}/sitemap.xml`);
  const sitemap = await r.get(origin + "/sitemap.xml");
  expect(sitemap.headers()["content-type"]).toContain("application/xml");
  expect(await sitemap.text()).toContain(`<loc>${origin}/${slug}</loc>`);
});

test("hidden pages disappear from /<slug>, the public page API and the sitemap; /book keeps working; reserved slugs rejected", async () => {
  const { r, c, slug } = await fixture();
  const page = (await (await r.get(base + "/shop/page")).json()).page;
  const body = { strapline: page.strapline, about: page.about, cover_url: page.cover_url, gallery: JSON.parse(page.gallery_json), phone: page.phone, email: page.email, instagram: page.instagram, map_url: page.map_url, transport_note: page.transport_note, policy_text: page.policy_text, sections: JSON.parse(page.sections_json), accent: page.accent, published: 0, version: page.version };
  expect((await r.put(base + "/shop/page", { data: body })).status()).toBe(200);
  expect((await c.get(`${origin}/${slug}`)).status()).toBe(404);
  expect((await c.get(`${pub}/shops/${slug}/page`)).status()).toBe(404);
  expect(await (await c.get(origin + "/sitemap.xml")).text()).not.toContain(`/${slug}</loc>`);
  expect((await c.get(`${origin}/book/${slug}`)).status()).toBe(200);
  expect((await c.get(`${pub}/shops/${slug}`)).status()).toBe(200);
  // Back on.
  expect((await r.put(base + "/shop/page", { data: { ...body, published: 1, version: page.version + 1 } })).status()).toBe(200);
  expect((await c.get(`${origin}/${slug}`)).status()).toBe(200);
  // New reserved words cannot be claimed as addresses.
  const online = await r.get(base + "/workspace");
  const shop = (await online.json()).shop;
  for (const bad of ["media", "offer", "robots.txt"]) {
    const res = await r.put(base + "/shop/online", { data: { slug: bad, online_booking: 1, lead_time_min: shop.lead_time_min, booking_window_days: shop.booking_window_days, version: shop.version } });
    expect(res.status(), `${bad}: ${await res.text()}`).toBe(400);
  }
});

test("reviews: only completed visits, once per booking, via manage link; hidden by owner leaves the page and the rating; reply shows publicly; barbers read only their own", async () => {
  const { r, c, w, slug, P } = await fixture();
  const done = await completedVisit(r, w);
  const target = done[0];
  const token = await manageToken(r, target.id);
  const before = await (await c.get(`${P}/page`)).json();
  const view = await (await c.get(`${pub}/manage/${token}`)).json();
  // Demo seed may have reviewed this visit already; pick an unreviewed one.
  let visit = target,
    tok = token,
    v = view;
  for (const b of done) {
    if (v.can_review) break;
    visit = b;
    tok = await manageToken(r, b.id);
    v = await (await c.get(`${pub}/manage/${tok}`)).json();
  }
  expect(v.can_review, "an unreviewed completed visit exists").toBe(true);
  expect(v.review).toBeNull();
  // Validation.
  expect((await c.post(`${pub}/manage/${tok}/review`, { data: { rating: 0 } })).status()).toBe(400);
  expect((await c.post(`${pub}/manage/${tok}/review`, { data: { rating: 5, body: "x".repeat(601) } })).status()).toBe(400);
  const left = await c.post(`${pub}/manage/${tok}/review`, { data: { rating: 4, body: "Solid cut, friendly chat. <b>bold</b>" } });
  expect(left.status(), await left.text()).toBe(201);
  const review = (await left.json()).review;
  expect(review).toMatchObject({ rating: 4, status: "PUBLISHED", reply: "" });
  // Once only.
  expect((await c.post(`${pub}/manage/${tok}/review`, { data: { rating: 5 } })).status()).toBe(409);
  const again = await (await c.get(`${pub}/manage/${tok}`)).json();
  expect(again.can_review).toBe(false);
  expect(again.review.rating).toBe(4);
  // A confirmed (future) visit cannot be reviewed.
  const future = (await (await r.get(base + `/bookings?date=${w.today}`)).json()).bookings.find((b: Booking) => b.status === "CONFIRMED");
  if (future) {
    const ft = await manageToken(r, future.id);
    const fv = await (await c.get(`${pub}/manage/${ft}`)).json();
    expect(fv.can_review).toBe(false);
    expect(fv.review_blocked).toBe("not_completed");
    expect((await c.post(`${pub}/manage/${ft}/review`, { data: { rating: 5 } })).status()).toBe(409);
  }
  // Public page shows it (first name + initial, never the phone) and the rating moved.
  const after = await (await c.get(`${P}/page`)).json();
  expect(after.rating.count).toBe(before.rating.count + 1);
  const shown = after.reviews.find((x: { id: string }) => x.id === review.id);
  expect(shown).toBeTruthy();
  expect(shown.display_name).toMatch(/^\S+ [A-Z]\.$/);
  expect(JSON.stringify(after.reviews)).not.toMatch(/07700 ?90\d{4}/);
  expect(shown.body).toContain("<b>bold</b>"); // stored verbatim; React renders it as text
  // Owner list, hide, reply.
  const list = await (await r.get(base + "/reviews")).json();
  const mine = list.reviews.find((x: { id: string }) => x.id === review.id);
  expect(mine).toMatchObject({ rating: 4, status: "PUBLISHED", staff_name: expect.any(String), visit_date: visit.date });
  expect((await r.post(base + `/reviews/${review.id}/status`, { data: { status: "HIDDEN", version: 99 } })).status()).toBe(409);
  const hide = await r.post(base + `/reviews/${review.id}/status`, { data: { status: "HIDDEN", version: mine.version } });
  expect(hide.status(), await hide.text()).toBe(200);
  const hiddenPage = await (await c.get(`${P}/page`)).json();
  expect(hiddenPage.rating.count).toBe(before.rating.count);
  expect(hiddenPage.reviews.find((x: { id: string }) => x.id === review.id)).toBeUndefined();
  // Customer still sees their own review with the hidden note.
  expect((await (await c.get(`${pub}/manage/${tok}`)).json()).review.status).toBe("HIDDEN");
  const show = await r.post(base + `/reviews/${review.id}/status`, { data: { status: "PUBLISHED", version: mine.version + 1 } });
  expect(show.status()).toBe(200);
  const reply = await r.post(base + `/reviews/${review.id}/reply`, { data: { reply: "Cheers — see you next month.", version: mine.version + 2 } });
  expect(reply.status(), await reply.text()).toBe(200);
  const withReply = (await (await c.get(`${P}/page`)).json()).reviews.find((x: { id: string }) => x.id === review.id);
  expect(withReply.reply).toBe("Cheers — see you next month.");
  // Review request queued when a visit is completed by staff today.
  const today = (await (await r.get(base + `/bookings?date=${w.today}`)).json()).bookings as Booking[];
  const confirmed = today.find((b) => b.status === "CONFIRMED");
  if (confirmed) {
    let b = confirmed;
    for (const st of ["CHECKED_IN", "IN_SERVICE", "COMPLETED"]) {
      const res = await r.post(base + `/bookings/${b.id}/status`, { data: { status: st, reason: "", version: b.version } });
      expect(res.status(), await res.text()).toBe(200);
      b = (await res.json()).booking;
    }
    const outbox = await (await r.get(base + "/notifications")).json();
    const msg = outbox.notifications.find((n: { template: string; related_id: string }) => n.template === "review_request" && n.related_id === confirmed.id);
    expect(msg).toBeTruthy();
    expect(msg.body).toMatch(/How was your .* Leave a quick rating: http/);
    expect(msg.status).toBe("SKIPPED");
  }
  // Barber account sees only their own visits' reviews and cannot moderate.
  const barber = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const login = await barber.post(base + "/auth/login", { data: { email: `jay-${slug.replace("demo-", "")}@demo.test`, password: "Demo1234!" } });
  if ([200, 201].includes(login.status())) {
    const jay = w.staff.find((s: { name: string }) => s.name === "Jay Carter");
    const bl = await (await barber.get(base + "/reviews")).json();
    expect(bl.reviews.length).toBeGreaterThan(0);
    expect(bl.reviews.every((x: { staff_id: string }) => x.staff_id === jay.id)).toBe(true);
    expect((await barber.post(base + `/reviews/${review.id}/status`, { data: { status: "HIDDEN", version: 0 } })).status()).toBe(403);
    expect((await barber.post(base + `/reviews/${review.id}/reply`, { data: { reply: "no", version: 0 } })).status()).toBe(403);
  }
});

test("media: upload sniffs real image bytes, serves at /media/<id> with immutable caching, is accepted by page and staff fields, and delete scrubs references", async () => {
  const { r, c, w } = await fixture();
  // Wrong bytes with an image name are refused; text kind refused; oversize refused by declared size.
  const fake = await r.post(base + "/media", { multipart: { kind: "gallery", file: { name: "not.png", mimeType: "image/png", buffer: Buffer.from("hello world, definitely not a png") } } });
  expect(fake.status(), await fake.text()).toBe(400);
  expect((await r.post(base + "/media", { multipart: { kind: "poster", file: { name: "a.png", mimeType: "image/png", buffer: PNG } } })).status()).toBe(400);
  const up = await r.post(base + "/media", { multipart: { kind: "gallery", alt: "Chair one", file: { name: "chair.png", mimeType: "image/png", buffer: PNG } } });
  expect(up.status(), await up.text()).toBe(201);
  const media = (await up.json()).media;
  expect(media).toMatchObject({ kind: "gallery", content_type: "image/png", width: 1, height: 1, alt: "Chair one" });
  expect(media.url).toMatch(/^\/media\/[a-f0-9-]{36}$/);
  const served = await c.get(origin + media.url);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("image/png");
  expect(served.headers()["cache-control"]).toContain("immutable");
  expect((await served.body()).equals(PNG)).toBe(true);
  expect((await c.get(origin + "/media/00000000-0000-0000-0000-000000000000")).status()).toBe(404);
  // JPEG is sniffed too and lands in the library list.
  const jpg = await r.post(base + "/media", { multipart: { kind: "staff", file: { name: "me.bin", mimeType: "application/octet-stream", buffer: JPEG } } });
  expect(jpg.status(), await jpg.text()).toBe(201);
  expect((await jpg.json()).media.content_type).toBe("image/jpeg");
  const lib = await (await r.get(base + "/media")).json();
  expect(lib.media.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining([media.id, (await jpg.json()).media.id]));
  // Page and staff fields accept the /media path; a foreign http:// path is rejected.
  const page = (await (await r.get(base + "/shop/page")).json()).page;
  const body = { strapline: page.strapline, about: page.about, cover_url: media.url, gallery: [media.url, "/static/demo/gallery-2.jpg"], phone: page.phone, email: page.email, instagram: page.instagram, map_url: page.map_url, transport_note: page.transport_note, policy_text: page.policy_text, sections: JSON.parse(page.sections_json), accent: page.accent, published: 1, version: page.version };
  expect((await r.put(base + "/shop/page", { data: { ...body, cover_url: "http://evil.example/x.jpg" } })).status()).toBe(400);
  expect((await r.put(base + "/shop/page", { data: body })).status()).toBe(200);
  void w;
  // Delete scrubs cover + gallery references and removes the object.
  const del = await r.delete(base + `/media/${media.id}`);
  expect(del.status(), await del.text()).toBe(200);
  expect((await c.get(origin + media.url)).status()).toBe(404);
  const afterPage = (await (await r.get(base + "/shop/page")).json()).page;
  expect(afterPage.cover_url).toBe("");
  expect(JSON.parse(afterPage.gallery_json)).toEqual(["/static/demo/gallery-2.jpg"]);
  // Barber accounts cannot upload.
  const barber = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const login = await barber.post(base + "/auth/login", { data: { email: `jay-${(await (await r.get(base + "/workspace")).json()).shop.slug.replace("demo-", "")}@demo.test`, password: "Demo1234!" } });
  if ([200, 201].includes(login.status())) expect((await barber.post(base + "/media", { multipart: { kind: "gallery", file: { name: "a.png", mimeType: "image/png", buffer: PNG } } })).status()).toBe(403);
});

test("browser: shop page shows photos, hero rating and reviews (axe clean); owner uploads a cover, moderates a review in Settings; customer leaves a review from the manage page", async ({ page }) => {
  const { slug } = await openFixtureShop(page);
  // Same session as the page, but with an Origin header so mutations pass the same-origin guard.
  const state = await page.context().storageState();
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin }, storageState: state });
  const w = await (await r.get(base + "/workspace")).json();
  // Owner: Settings → Shop page → upload cover via the file input.
  await section(page, "Settings");
  const panel = page.getByTestId("shop-page-panel");
  await expect(panel).toBeVisible();
  await panel.getByTestId("upload-cover-input").setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: PNG });
  await expect(panel.locator(".photo-field .photo-preview img").first()).toHaveAttribute("src", /^\/media\//);
  await panel.getByTestId("save-shop-page").click();
  await expect(panel.getByText("Saved")).toBeVisible();
  // Reviews panel: hide the first shown review, reply to it.
  const reviews = page.getByTestId("reviews-panel");
  await reviews.scrollIntoViewIfNeeded();
  await expect(reviews.getByTestId("review-row").first()).toBeVisible();
  const summaryBefore = await reviews.getByTestId("reviews-summary").textContent();
  const first = reviews.getByTestId("review-row").first();
  const firstName = await first.locator("header strong").textContent();
  await first.getByTestId("review-toggle").click();
  await expect(reviews.getByTestId("review-row").filter({ hasText: firstName! }).getByText("Hidden")).toBeVisible();
  await expect(reviews.getByTestId("reviews-summary")).not.toHaveText(summaryBefore!);
  const row = reviews.getByTestId("review-row").filter({ hasText: firstName! });
  await row.getByTestId("review-toggle").click(); // show again
  await expect(row.getByText("Hidden")).toHaveCount(0);
  await expect(reviews.getByTestId("reviews-summary")).toHaveText(summaryBefore!);
  await row.getByTestId("review-reply").click();
  await expect(row.getByTestId("reply-text")).toBeVisible();
  await row.getByTestId("reply-text").fill("Thanks for coming in.");
  await row.getByTestId("reply-save").click();
  await expect(row.getByText("Thanks for coming in.")).toBeVisible();
  let a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  // Public page reflects: cover, rating, reviews section with the reply.
  const visitor = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 } });
  const vp = await visitor.newPage();
  await vp.goto(`/${slug}`);
  await expect(vp.getByTestId("hero-rating")).toBeVisible();
  await expect(vp.locator(".sp-hero.has-cover")).toBeVisible();
  await vp.getByTestId("reviews-section").scrollIntoViewIfNeeded();
  await expect(vp.getByTestId("public-review").filter({ hasText: "Thanks for coming in." })).toBeVisible();
  await expect(vp.locator(".sp-gallery img").first()).toBeVisible();
  a11y = await new AxeBuilder({ page: vp }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  // Customer leaves a review from a completed visit's manage page.
  const done = await completedVisit(r, w);
  let token = "";
  for (const b of done) {
    const t = await manageToken(r, b.id);
    const v = await (await r.get(`${pub}/manage/${t}`)).json();
    if (v.can_review) {
      token = t;
      break;
    }
  }
  expect(token).not.toBe("");
  await vp.goto(`/manage/${token}`);
  const card = vp.getByTestId("review-card");
  await expect(card.getByRole("heading", { name: "How was it?" })).toBeVisible();
  await expect(card.getByTestId("review-submit")).toBeDisabled();
  await card.getByTestId("star-5").click();
  await card.getByTestId("review-body").fill("Brilliant, as always.");
  await card.getByTestId("review-submit").click();
  await expect(card.getByRole("img", { name: /You gave 5 out of 5/ })).toBeVisible();
  await expect(card.getByText("Brilliant, as always.")).toBeVisible();
  await vp.reload();
  await expect(vp.getByTestId("review-card").getByText("Brilliant, as always.")).toBeVisible();
  await expect(vp.getByTestId("review-card").getByTestId("review-submit")).toHaveCount(0);
  // ...and it is on the shop page.
  await vp.goto(`/${slug}#reviews`);
  await expect(vp.getByTestId("public-review").filter({ hasText: "Brilliant, as always." })).toBeVisible();
});
