// Website editor: full-screen at /workspace/website. Click an element on the real page → inspector
// shows it → colour applies live → autosaves as a draft (public page unchanged) → Publish makes it
// live (public page now carries the element colour). Layout thumbnails switch section variants;
// sections can be hidden/re-added; undo works.
import { test, expect } from "@playwright/test";
import { openFixtureShop, section } from "./fixture";

const origin = "http://localhost:3000";

test("click-to-recolour, draft vs publish, layouts, sections, undo", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { slug } = await openFixtureShop(page);
  // Settings → Website is a launcher into the editor.
  await section(page, "Settings/page");
  await page.getByTestId("open-website-editor").click();
  const ed = page.getByTestId("website-editor");
  await expect(ed).toBeVisible();
  await expect(page).toHaveURL(/\/workspace\/website$/);
  await expect(page.getByTestId("wed-frame")).toBeVisible();

  // Select the hero Book button on the canvas.
  await page.locator('#sp-editor-scope [data-el="hero.button"]').first().click();
  await expect(page.getByTestId("wed-inspector")).toContainText("Book button");
  await page.getByTestId("wed-el-bg-text").fill("#c2410c");
  await expect(page.locator('#sp-editor-scope [data-el="hero.button"]').first()).toHaveCSS("background-color", "rgb(194, 65, 12)");
  // Readable-text suggestion.
  await page.getByRole("button", { name: /Use readable text/ }).click();
  await expect(page.getByTestId("wed-el-fg-text")).toHaveValue("#ffffff");
  // Draft autosaves; the public page is untouched until Publish.
  await expect(page.getByTestId("wed-save")).toContainText(/Draft saved/, { timeout: 5000 });
  let pub = await (await page.request.get(origin + `/api/public/shops/${slug}/page`)).json();
  expect(pub.page.element_styles["hero.button"]).toBeUndefined();

  // Layout thumbnail switches the hero variant.
  await page.getByTestId("wed-layout-hero-cover").click();
  await expect(page.locator("#sp-editor-scope .sp-hero.v-cover")).toBeAttached();
  // Undo reverts the layout.
  await page.getByTestId("wed-undo").click();
  await expect(page.locator("#sp-editor-scope .sp-hero.v-cover")).toHaveCount(0);

  // Hide + re-add a section.
  await page.getByTestId("wed-sec-gallery").hover();
  await page.getByRole("button", { name: "Hide Gallery" }).click();
  await expect(page.locator('#sp-editor-scope [data-sec="gallery"]')).toHaveCount(0);
  await page.getByTestId("wed-add-gallery").click();
  await expect(page.locator('#sp-editor-scope [data-sec="gallery"]')).toHaveCount(1);

  // Design: custom primary drives the page.
  await page.getByTestId("wed-panel-design").click();
  await page.getByTestId("wed-primary-hex-text").fill("#1f6feb");
  await expect(page.locator("#sp-editor-scope.custom-accent")).toBeAttached();
  await page.getByTestId("wed-device-phone").click();
  await expect(page.getByTestId("wed-frame")).toHaveClass(/phone/);

  // Publish → public page carries the element colour and primary.
  await page.getByTestId("wed-publish").click();
  await expect(page.getByTestId("wed-publish")).toHaveText("Published", { timeout: 10000 });
  pub = await (await page.request.get(origin + `/api/public/shops/${slug}/page`)).json();
  expect(pub.page.element_styles["hero.button"]).toEqual({ bg: "#c2410c", fg: "#ffffff" });
  expect(pub.page.primary_hex).toBe("#1f6feb");
  // Live page renders the override.
  const live = await page.context().newPage();
  await live.goto(origin + `/${slug}`);
  await expect(live.getByTestId("hero-book")).toHaveCSS("background-color", "rgb(194, 65, 12)");
  await live.close();

  // Close returns to the workspace.
  await page.getByTestId("wed-close").click();
  await expect(page).toHaveURL(/\/workspace$/);
  expect(errors).toEqual([]);
});

test("draft is resumed on reopen and can be discarded", async ({ page }) => {
  await openFixtureShop(page);
  await page.goto(origin + "/workspace/website");
  await expect(page.getByTestId("wed-frame")).toBeVisible();
  await page.getByTestId("wed-panel-content").click();
  await page.getByTestId("wed-strapline").fill("Draft strapline here");
  await expect(page.getByTestId("wed-save")).toContainText(/Draft saved/, { timeout: 5000 });
  await page.reload();
  await expect(page.getByTestId("wed-frame")).toBeVisible();
  await expect(page.locator("#sp-editor-scope .sp-strap")).toHaveText("Draft strapline here");
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("wed-discard").click();
  await expect(page.locator("#sp-editor-scope .sp-strap")).not.toHaveText("Draft strapline here");
});
