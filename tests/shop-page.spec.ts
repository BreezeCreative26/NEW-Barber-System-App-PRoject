// Public shop home page at /<slug>: the customer's front door. Booking lives on /book; every card deep-links into it.
// Every test builds its own fixture shop; nothing live is touched.
import { test, expect, request } from "@playwright/test";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { base, origin, openFixtureShop, section } from "./fixture";

async function fixture() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { slug: string; shop_id: string };
  return { r, slug: body.slug };
}

test("shop page renders the seeded sections and every shortcut deep-links into the booking page", async ({ page }) => {
  const { slug } = await fixture();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`/${slug}`);
  const root = page.getByTestId("shop-page");
  await expect(root).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Northline Barbers" })).toBeVisible();
  await expect(root).toContainText("Sharp cuts. Straight talk. No fuss.");
  await expect(page.getByTestId("open-now")).toBeVisible();
  for (const h of ["Next available", "Services", "The team", "Book a visit", "Opening hours", "Find us", "Good to know"]) {
    await expect(page.getByRole("heading", { name: h, exact: true })).toBeVisible();
  }
  // Gallery is off in the seed, so its heading must not render.
  await expect(page.getByRole("heading", { name: "Gallery" })).toHaveCount(0);
  await expect(page.locator("#find").getByRole("link", { name: "020 7946 0111" })).toHaveAttribute("href", /^tel:/);
  // The booking flow is its own page; the shop page carries one call to action.
  await expect(page.locator(".booking-app")).toHaveCount(0);
  // On the shop's own host the flow is /book; on the root host it is /book/<slug>.
  const bookHref = new RegExp(`^/book(/${slug})?$`);
  await expect(page.getByTestId("nav-book")).toHaveAttribute("href", bookHref);
  await expect(page.getByTestId("section-book")).toHaveAttribute("href", bookHref);

  // Service card -> booking page on the barber step with that service chosen.
  await page.getByTestId("service-book").nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/book(/${slug})?\\?.*service=.*step=1`));
  const flow = page.locator(".booking-app.standalone");
  await expect(flow.getByRole("heading", { name: "Who’s cutting?" })).toBeVisible();
  await expect(flow.locator(".booking-summary")).toContainText("Skin fade");
  await expect(flow.getByTestId("booking-back")).toHaveAttribute("href", new RegExp(`^/(${slug})?$`));

  // Barber card -> booking page on the service step, barber remembered.
  await page.goto(`/${slug}`);
  await page.getByTestId("barber-book").filter({ hasText: "Marcus" }).click();
  await expect(flow.getByRole("heading", { name: "What are we doing today?" })).toBeVisible();
  await flow.getByRole("button", { name: "Choose your barber", exact: true }).click();
  await expect(flow.getByRole("button", { name: /Marcus Reed/ })).toHaveAttribute("aria-pressed", "true");

  // Soonest chip -> time step, that slot pre-selected.
  await page.goto(`/${slug}`);
  const soonest = page.getByTestId("soonest").first();
  const chipTime = (await soonest.textContent())!.match(/\d{2}:\d{2}/)![0];
  await soonest.click();
  await expect(flow.getByRole("heading", { name: "When suits you?" })).toBeVisible();
  await expect(flow.getByRole("group", { name: "Choose an appointment time" }).getByRole("button", { name: new RegExp(`^${chipTime},`) })).toHaveAttribute("aria-pressed", "true");

  // Old-style deep links (/<slug>?service=…#book) are forwarded to the flow.
  await page.goto(`/${slug}?step=1#book`);
  await expect(page).toHaveURL(new RegExp(`/book(/${slug})?\\?step=1`));
  await expect(flow.getByRole("heading", { name: "Who’s cutting?" })).toBeVisible();
  await page.goto(`/${slug}`);
  await soonest.click();
  await expect(flow.getByRole("heading", { name: "When suits you?" })).toBeVisible();

  // Complete the booking.
  await flow.getByRole("button", { name: "Sign in to book", exact: true }).click();
  await flow.getByLabel("Your name").fill("Home Page Customer");
  await flow.getByLabel("Mobile number").fill(`07${String(Date.now()).slice(-9)}`);
  await flow.getByLabel("Email address").fill(`homepage-${Date.now()}@example.test`);
  await flow.getByTestId("booking-password").fill("Fictional-test-pass-2026!");
  await flow.getByTestId("auth-submit").click();
  await expect(flow.getByRole("heading", { name: "Check and confirm." })).toBeVisible();
  await flow.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.locator(".public-reference")).toHaveText(/^BRB-\d{4}$/);
  await expect(page.getByTestId("open-manage")).toHaveAttribute("href", /^\/manage\//);
  // The confirmation keeps a way back to the shop.
  await expect(page.getByTestId("booking-back")).toHaveAttribute("href", new RegExp(`^/(${slug})?$`));
  expect(errors).toEqual([]);

  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("unknown, reserved and offline slugs do not get a shop page", async ({ page }) => {
  const { r, slug } = await fixture();
  expect((await page.request.get(`/${slug}`)).status()).toBe(200);
  expect((await page.request.get("/no-such-shop-here")).status()).toBe(404);
  expect((await page.request.get(`/api/public/shops/no-such-shop-here/page`)).status()).toBe(404);
  // Reserved first segments still belong to the app, never to a shop.
  expect((await page.request.get("/workspace")).status()).toBe(200);
  expect((await page.request.get("/docs/customer-plan")).status()).toBe(200);
  // Switching online booking off takes the home page down with it.
  const w = await (await r.get(base + "/workspace")).json();
  const off = await r.put(base + "/shop/online", {
    data: { slug, online_booking: 0, lead_time_min: w.shop.lead_time_min, booking_window_days: w.shop.booking_window_days, version: w.shop.version },
  });
  expect(off.status(), await off.text()).toBe(200);
  expect((await page.request.get(`/${slug}`)).status()).toBe(404);
});

test("owner edits the shop page in the website editor and the public page reflects it", async ({ page }) => {
  const { slug } = await openFixtureShop(page);
  await section(page, "Settings/page");
  await page.getByTestId("open-website-editor").click();
  const ed = page.getByTestId("website-editor");
  await expect(ed).toBeVisible();
  await page.getByTestId("wed-panel-content").click();
  await expect(page.getByTestId("wed-strapline")).toHaveValue("Sharp cuts. Straight talk. No fuss.");
  await page.getByTestId("wed-strapline").fill("Walk in a stranger, walk out a regular.");
  await page.getByTestId("wed-phone").fill("020 7946 0999");
  await page.getByTestId("wed-panel-sections").click();
  await page.getByTestId("wed-sec-team").hover();
  await page.getByRole("button", { name: "Hide Team" }).click();
  await page.getByTestId("wed-panel-design").click();
  await page.getByTestId("wed-accent-sage").click();
  await page.getByTestId("wed-publish").click();
  await expect(page.getByTestId("wed-publish")).toHaveText("Published", { timeout: 10000 });

  const api = await (await page.request.get(`/api/public/shops/${slug}/page`)).json();
  expect(api.page.strapline).toBe("Walk in a stranger, walk out a regular.");
  expect(api.page.phone).toBe("020 7946 0999");
  expect(api.page.accent).toBe("sage");
  expect(api.page.sections).not.toContain("team");

  await page.goto(`/${slug}`);
  const root = page.getByTestId("shop-page");
  await expect(root).toHaveClass(/accent-sage/);
  await expect(root).toContainText("Walk in a stranger, walk out a regular.");
  await expect(page.getByRole("heading", { name: "The team", exact: true })).toHaveCount(0);
  await expect(page.locator("#find").getByRole("link", { name: "020 7946 0999" })).toBeVisible();
});

test("shop page API validates and guards versions", async () => {
  const { r } = await fixture();
  const row = (await (await r.get(base + "/shop/page")).json()).page;
  const body = {
    strapline: row.strapline,
    about: row.about,
    cover_url: row.cover_url,
    gallery: JSON.parse(row.gallery_json || "[]"),
    phone: row.phone,
    email: row.email,
    instagram: row.instagram,
    map_url: row.map_url,
    transport_note: row.transport_note,
    policy_text: row.policy_text,
    sections: JSON.parse(row.sections_json || "[]"),
    accent: row.accent,
    published: row.published,
    version: row.version,
  };
  const bad = await r.put(base + "/shop/page", { data: { ...body, accent: "neon" } });
  expect(bad.status()).toBe(400);
  const http = await r.put(base + "/shop/page", { data: { ...body, cover_url: "http://insecure.example.test/x.jpg" } });
  expect(http.status()).toBe(400);
  const ok = await r.put(base + "/shop/page", { data: { ...body, strapline: "v1", instagram: "@handle.one" } });
  expect(ok.status(), await ok.text()).toBe(200);
  expect((await ok.json()).page.instagram).toBe("handle.one");
  const stale = await r.put(base + "/shop/page", { data: { ...body, strapline: "v2" } });
  expect(stale.status()).toBe(409);
  const after = (await (await r.get(base + "/shop/page")).json()).page;
  expect(after.strapline).toBe("v1");
  expect(after.version).toBe(body.version + 1);
});

test("every photo kind uploads, including the logo (regression: logo was refused by a check constraint)", async ({ page }) => {
  await openFixtureShop(page);
  const png = readFileSync("public/static/demo/northline/logo-light.png");
  for (const kind of ["logo", "cover", "gallery", "staff"] as const) {
    const res = await page.request.post(base + "/media", { headers: { Origin: origin }, multipart: { kind, alt: `${kind} test`, file: { name: `${kind}.png`, mimeType: "image/png", buffer: png } } });
    expect(res.status(), `${kind}: ${await res.text()}`).toBe(201);
    const j = await res.json();
    expect(j.media.kind).toBe(kind);
    expect(j.media.url).toMatch(/^\/media\/[a-f0-9-]{36}$/);
  }
});
