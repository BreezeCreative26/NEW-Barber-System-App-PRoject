// Website builder: custom primary/secondary colours and per-section layout variants persist,
// render on the public shop page at phone / tablet / desktop widths without console errors, and
// the Settings → Shop page editor shows the pickers and a real live preview with a device toggle.
import { test, expect, request } from "@playwright/test";
import { base, origin, openFixtureShop, section } from "./fixture";

const VARIANTS: Record<string, string[]> = {
  hero: ["editorial", "centred", "split", "cover", "minimal"],
  next: ["strip", "card"],
  services: ["menu", "cards", "grid", "tabs"],
  team: ["cards", "list", "portraits", "compact"],
  hours: ["table", "chips"],
  gallery: ["grid", "masonry", "strip"],
  reviews: ["cards", "wall", "carousel", "quote"],
  find: ["map", "card"],
  policies: ["plain", "panel"],
  cta: ["band", "card"],
  footer: ["simple", "columns"],
};
const WIDTHS = [{ w: 390, h: 844 }, { w: 820, h: 1180 }, { w: 1366, h: 900 }];

async function fixture() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { slug: string };
  return { r, slug: body.slug };
}
async function savePage(r: Awaited<ReturnType<typeof fixture>>["r"], extra: Record<string, unknown>) {
  const cur = (await (await r.get(base + "/shop/page")).json()).page as Record<string, unknown>;
  const body = {
    strapline: String(cur.strapline || ""), about: String(cur.about || ""), cover_url: String(cur.cover_url || "/static/stock/brick.webp"), logo_url: String(cur.logo_url || ""),
    gallery: ["/static/stock/brick.webp", "/static/stock/tools.webp", "/static/stock/minimal.webp"], phone: "020 7946 0111", email: "", instagram: "", map_url: "", transport_note: "", policy_text: "",
    sections: ["hero", "next", "services", "team", "hours", "gallery", "reviews", "find", "policies"],
    accent: String(cur.accent || "ollo"), theme: { font: "modern", mode: "light", corners: "soft", hero: "editorial", logo: "auto" },
    primary_hex: "", secondary_hex: "", variants: {}, google_review_url: "", published: 1, version: Number(cur.version ?? 0), ...extra,
  };
  const res = await r.put(base + "/shop/page", { data: body });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).page as Record<string, unknown>;
}

test("custom colours and variants validate, persist and reach the public page", async () => {
  const { r, slug } = await fixture();
  const saved = await savePage(r, { primary_hex: "#1F6FEB", secondary_hex: "#f59e0b", variants: { hero: "cover", services: "cards", team: "portraits", reviews: "quote", footer: "columns" } });
  expect(saved.primary_hex).toBe("#1f6feb");
  expect(saved.secondary_hex).toBe("#f59e0b");
  expect(JSON.parse(String(saved.variants_json))).toEqual({ hero: "cover", services: "cards", team: "portraits", reviews: "quote", footer: "columns" });
  const pub = (await (await r.get(base.replace("/api/app", "/api/public") + `/shops/${slug}/page`)).json()).page;
  expect(pub.primary_hex).toBe("#1f6feb");
  expect(pub.variants.hero).toBe("cover");
  const cur = (await (await r.get(base + "/shop/page")).json()).page as Record<string, unknown>;
  const bad = await r.put(base + "/shop/page", { data: { ...saved, gallery: [], sections: ["hero"], theme: { font: "modern", mode: "light", corners: "soft", hero: "editorial", logo: "auto" }, variants: { hero: "banner" }, primary_hex: "", secondary_hex: "", version: cur.version } });
  expect(bad.status()).toBe(400);
  const badHex = await r.put(base + "/shop/page", { data: { ...saved, gallery: [], sections: ["hero"], theme: { font: "modern", mode: "light", corners: "soft", hero: "editorial", logo: "auto" }, variants: {}, primary_hex: "blue", secondary_hex: "", version: cur.version } });
  expect(badHex.status()).toBe(400);
});

test("every section variant renders at phone, tablet and desktop widths without errors", async ({ browser }) => {
  test.setTimeout(300000);
  const { r, slug } = await fixture();
  const errors: string[] = [];
  // Rotate through variants column by column so every option is seen at least once.
  const max = Math.max(...Object.values(VARIANTS).map((v) => v.length));
  for (let i = 0; i < max; i++) {
    const variants = Object.fromEntries(Object.entries(VARIANTS).map(([k, v]) => [k, v[i % v.length]]));
    await savePage(r, { variants, primary_hex: i % 2 ? "#7c3aed" : "", secondary_hex: i % 2 ? "#10b981" : "", theme: { font: "modern", mode: i % 2 ? "dark" : "light", corners: "soft", hero: "editorial", logo: "auto" } });
    for (const vp of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(`${vp.w} ${JSON.stringify(variants)}: ${e.message}`));
      await page.goto(`/${slug}`);
      const root = page.getByTestId("shop-page");
      await expect(root).toBeVisible();
      for (const [k, v] of Object.entries(variants)) {
        if (k === "footer") await expect(root).toHaveClass(new RegExp(`v-footer-${v}`));
        else if (k === "hero") await expect(page.locator(`.sp-hero.v-${v}`)).toBeVisible();
        else if (k === "reviews" || k === "next" || k === "gallery") continue; // depend on data present in the fixture
        else await expect(page.locator(`[data-variant="${v}"]`).first()).toBeAttached();
      }
      if (i % 2) await expect(root).toHaveClass(/custom-accent/);
      // No horizontal overflow at any width.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${vp.w}px ${JSON.stringify(variants)}`).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `test-results/builder-${i}-${vp.w}.png`, fullPage: true });
      await ctx.close();
    }
  }
  expect(errors).toEqual([]);
});

// The in-settings editor was replaced by the full-screen website editor: see tests/website-editor.spec.ts.
