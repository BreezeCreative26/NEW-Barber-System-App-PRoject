// Public shop home page at /<slug>: the customer's front door with booking embedded on it.
// Every test builds its own fixture shop; nothing live is touched.
import { test, expect, request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { base, origin, openFixtureShop, section } from "./fixture";

async function fixture() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { slug: string; shop_id: string };
  return { r, slug: body.slug };
}

test("shop page renders the seeded sections and every shortcut re-targets the embedded booking", async ({ page }) => {
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
  // Embedded flow starts on the service step with no header/hero/banner of its own.
  const flow = page.locator(".booking-app.embedded");
  await expect(flow.getByRole("heading", { name: "What are we doing today?" })).toBeVisible();
  await expect(flow.locator(".booking-hero")).toHaveCount(0);
  expect(await page.locator("#main-content").count()).toBeLessThanOrEqual(1);

  // Service card -> barber step with that service chosen.
  await page.getByTestId("service-book").nth(1).click();
  await expect(flow.getByRole("heading", { name: "Find your kind of barber." })).toBeVisible();
  await expect(flow.locator(".booking-summary, .summary-card").first()).toContainText("Skin fade");

  // Barber card -> back to service step, barber remembered.
  await page.getByTestId("barber-book").filter({ hasText: "Marcus" }).click();
  await expect(flow.getByRole("heading", { name: "What are we doing today?" })).toBeVisible();
  await flow.getByRole("button", { name: "Choose your barber", exact: true }).click();
  await expect(flow.getByRole("button", { name: /Marcus Reed/ })).toHaveAttribute("aria-pressed", "true");

  // Soonest chip -> time step, that slot pre-selected.
  const soonest = page.getByTestId("soonest").first();
  const chipTime = (await soonest.textContent())!.match(/\d{2}:\d{2}/)![0];
  await soonest.click();
  await expect(flow.getByRole("heading", { name: "A time that works for you." })).toBeVisible();
  await expect(flow.getByRole("group", { name: "Choose an appointment time" }).getByRole("button", { name: new RegExp(`^${chipTime},`) })).toHaveAttribute("aria-pressed", "true");

  // Same chip again after wandering off still re-targets (the preset is not deduplicated).
  await flow.getByRole("button", { name: "Service", exact: true }).click();
  await expect(flow.getByRole("heading", { name: "What are we doing today?" })).toBeVisible();
  await soonest.click();
  await expect(flow.getByRole("heading", { name: "A time that works for you." })).toBeVisible();

  // Complete the booking from the home page.
  await flow.getByRole("button", { name: "Your details", exact: true }).click();
  await flow.getByLabel("Your name").fill("Home Page Customer");
  await flow.getByLabel("Mobile number").fill("07700 900444");
  await flow.getByRole("button", { name: "Review booking" }).click();
  await expect(flow.getByRole("heading", { name: "Check and confirm." })).toBeVisible();
  await flow.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.locator(".public-reference")).toHaveText(/^BRB-\d{4}$/);
  await expect(page.locator(".public-manage-link")).toHaveAttribute("href", /^\/manage\//);
  // The rest of the shop page is still around the confirmation.
  await expect(page.getByRole("heading", { name: "Opening hours", exact: true })).toBeVisible();
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

test("owner edits the shop page in Settings and the public page reflects it", async ({ page }) => {
  const { slug } = await openFixtureShop(page);
  await section(page, "Settings/page");
  const panel = page.getByTestId("shop-page-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("view-shop-page")).toHaveAttribute("href", new RegExp(`/${slug}$`));
  await expect(panel.getByLabel("Strapline")).toHaveValue("Sharp cuts. Straight talk. No fuss.");
  await panel.getByLabel("Strapline").fill("Walk in a stranger, walk out a regular.");
  await panel.getByLabel("Phone").fill("020 7946 0999");
  await panel.getByRole("group", { name: "Sections shown" }).getByLabel("Team", { exact: true }).uncheck();
  await panel.getByRole("group", { name: "Accent colour" }).getByRole("button", { name: "sage" }).click();
  await panel.getByRole("button", { name: "Add by URL" }).click();
  await panel.getByLabel("Gallery image 1", { exact: true }).fill("not a url");
  await panel.getByTestId("save-shop-page").click();
  await expect(panel).toContainText(/https|valid|url/i);
  await panel.getByLabel("Gallery image 1", { exact: true }).fill("https://images.example.test/chair.jpg");
  await panel.getByTestId("save-shop-page").click();
  await expect(panel.getByText("Saved")).toBeVisible();

  const api = await (await page.request.get(`/api/public/shops/${slug}/page`)).json();
  expect(api.page.strapline).toBe("Walk in a stranger, walk out a regular.");
  expect(api.page.phone).toBe("020 7946 0999");
  expect(api.page.accent).toBe("sage");
  expect(api.page.sections).not.toContain("team");
  expect(api.page.gallery[0]).toBe("https://images.example.test/chair.jpg");

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
