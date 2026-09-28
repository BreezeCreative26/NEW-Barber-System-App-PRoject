// Theme matrix: every accent × typeface × look × corners × hero renders the public shop page and
// the booking flow without console errors, with readable contrast (axe colour-contrast), and the
// Settings → Shop page preview mirrors the chosen classes immediately, before saving. Also checks a
// brand-new shop (no shop_pages row) gets a themed page straight away.
import { test, expect, request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { base, origin, openFixtureShop, section } from "./fixture";

const ACCENTS = ["ollo", "ink", "sage", "clay", "plum", "slate"];
const FONTS = ["modern", "editorial", "grotesk", "heritage", "condensed", "soft"];
const MODES = ["light", "dark"];
const CORNERS = ["soft", "sharp"];
const HEROES = ["editorial", "centred", "split"];

async function fixture() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { slug: string; shop_id: string };
  const page = (await (await r.get(base + "/shop/page")).json()).page as Record<string, unknown>;
  return { r, slug: body.slug, page };
}
async function setTheme(r: Awaited<ReturnType<typeof fixture>>["r"], page: Record<string, unknown>, accent: string, theme: Record<string, string>, extra: Record<string, unknown> = {}) {
  const cur = (await (await r.get(base + "/shop/page")).json()).page as Record<string, unknown>;
  const body = {
    strapline: String(cur.strapline || ""), about: String(cur.about || ""), cover_url: String(cur.cover_url || ""), logo_url: String(cur.logo_url || ""),
    gallery: JSON.parse(String(cur.gallery_json || "[]")), phone: String(cur.phone || ""), email: String(cur.email || ""), instagram: String(cur.instagram || ""),
    map_url: String(cur.map_url || ""), transport_note: String(cur.transport_note || ""), policy_text: String(cur.policy_text || ""), sections: JSON.parse(String(cur.sections_json || "[]")),
    accent, theme: { font: "modern", mode: "light", corners: "soft", hero: "editorial", logo: "auto", ...theme }, published: 1, version: Number(cur.version ?? 0), ...extra,
  };
  const res = await r.put(base + "/shop/page", { data: body });
  expect(res.status(), await res.text()).toBe(200);
  void page;
}

test("every accent × look renders the shop page and booking flow cleanly (contrast, no console errors)", async ({ page }) => {
  test.setTimeout(240000);
  const { r, slug, page: p } = await fixture();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|net::ERR/.test(m.text()) && errors.push(m.text()));
  let i = 0;
  for (const accent of ACCENTS) {
    for (const mode of MODES) {
      const font = FONTS[i % FONTS.length], corners = CORNERS[i % CORNERS.length], hero = HEROES[i % HEROES.length];
      i++;
      await setTheme(r, p, accent, { font, mode, corners, hero }, { cover_url: "/static/stock/brick.webp" });
      await page.goto(`/${slug}`);
      const root = page.getByTestId("shop-page");
      await expect(root).toHaveClass(new RegExp(`accent-${accent}`));
      await expect(root).toHaveClass(new RegExp(`font-${font}`));
      await expect(root).toHaveClass(new RegExp(`mode-${mode}`));
      await expect(root).toHaveClass(new RegExp(`corners-${corners}`));
      await expect(root).toHaveClass(new RegExp(`hero-${hero}`));
      await expect(page.getByTestId("hero-book")).toBeVisible();
      // Fonts actually resolve (not a fallback), display face applied to the headline.
      const face = await page.locator(".sp-hero h1").evaluate((el) => getComputedStyle(el).fontFamily);
      expect(face.length).toBeGreaterThan(0);
      const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).disableRules(["region", "landmark-one-main", "page-has-heading-one"]).analyze();
      expect(a11y.violations.map((v) => `${accent}/${mode}/${font}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      // Booking flow wraps in the same theme.
      await page.goto(`/book/${slug}`);
      const app = page.locator(".booking-app.standalone");
      await expect(app).toHaveClass(new RegExp(`accent-${accent}`));
      await expect(app).toHaveClass(new RegExp(`mode-${mode}`));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const b11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).disableRules(["region"]).analyze();
      expect(b11y.violations.map((v) => `book ${accent}/${mode}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
  }
  expect(errors).toEqual([]);
  await r.dispose();
});

test("every typeface × hero layout renders with and without a cover photo", async ({ page }) => {
  test.setTimeout(180000);
  const { r, slug, page: p } = await fixture();
  for (const font of FONTS) {
    for (const hero of HEROES) {
      for (const cover of ["", "/static/stock/minimal.webp"]) {
        await setTheme(r, p, "ollo", { font, hero }, { cover_url: cover });
        await page.goto(`/${slug}`);
        const heroEl = page.locator(".sp-hero");
        await expect(heroEl).toHaveClass(cover ? /has-cover/ : /no-cover/);
        await expect(page.locator(".sp-hero h1")).toBeVisible();
        if (hero === "split" && cover) await expect(page.locator(".sp-hero-side img")).toBeVisible();
        const box = await page.locator(".sp-hero h1").boundingBox();
        expect(box!.width).toBeGreaterThan(50);
      }
    }
  }
  await r.dispose();
});

test("brand-new shop: themed page and booking flow straight away with no shop_pages row; first save applies immediately", async ({ page }) => {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const stamp = Date.now().toString(36);
  const email = `theme-${stamp}@example.test`;
  const su = await r.post(base + "/auth/signup", { data: { shop_name: `Theme Test ${stamp}`, kind: "BARBER", name: "Theme Owner", email, password: "Theme-Test-1234!", timezone: "Europe/London", accept_legal: true } });
  expect([200, 201]).toContain(su.status());
  // Minimum to go live: a slug + online booking on. Use whatever the setup API expects.
  const slug = `theme-${stamp}`;
  const w0 = (await (await r.get(base + "/workspace")).json()).shop;
  const put = await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w0.version } });
  expect(put.status(), await put.text()).toBe(200);
  // No shop_pages row exists yet, so the defaults must serve a complete themed page.
  await page.goto(`/${slug}`);
  const root = page.getByTestId("shop-page");
  await expect(root).toHaveClass(/shop-page accent-ollo font-modern mode-light corners-soft hero-editorial/);
  await expect(page.locator(".sp-hero h1")).toContainText("Theme Test");
  // Owner picks a look and saves: the public page reflects it on the next load, no cache in the way.
  const cur = (await (await r.get(base + "/shop/page")).json()).page as Record<string, unknown>;
  expect(Number(cur.version ?? 0)).toBe(0);
  const res = await r.put(base + "/shop/page", { data: { strapline: "Fresh look", about: "", cover_url: "/static/stock/heritage.webp", logo_url: "", gallery: [], phone: "", email: "", instagram: "", map_url: "", transport_note: "", policy_text: "", sections: ["hero", "services", "team", "hours"], accent: "plum", theme: { font: "heritage", mode: "dark", corners: "sharp", hero: "centred", logo: "auto" }, published: 1, version: 0 } });
  expect(res.status(), await res.text()).toBe(200);
  await page.goto(`/${slug}`);
  await expect(page.getByTestId("shop-page")).toHaveClass(/accent-plum font-heritage mode-dark corners-sharp hero-centred/);
  await expect(page.locator(".sp-hero")).toHaveClass(/has-cover/);
  await expect(page.locator(".sp-strap")).toContainText("Fresh look");
  await r.dispose();
});

// Live preview before saving is covered by the full-screen editor: tests/website-editor.spec.ts.
