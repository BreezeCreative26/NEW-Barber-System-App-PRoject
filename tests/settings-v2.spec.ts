// Settings reorganisation: grouped sections all reachable; split shop forms still save the full
// record; Google review link + follow-up; personal workspace accent persists.
import { test, expect, request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { base, origin, openFixtureShop, section } from "./fixture";

const SECTIONS = ["general", "hours", "calendar", "booking", "page", "reviews", "waitlist", "messages", "alerts", "ai", "payments", "billing"];

test("every settings section opens, is grouped, and passes axe", async ({ page }) => {
  await openFixtureShop(page);
  await section(page, "Settings");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  for (const g of ["Business", "Bookings", "Website", "Customers", "Team", "Account"]) await expect(nav.getByText(g, { exact: true })).toBeVisible();
  for (const key of SECTIONS) {
    await page.getByTestId(`settings-tab-${key}`).click();
    await expect(page.getByTestId(`settings-tab-${key}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".settings-head h2")).toBeVisible();
    expect(page.url()).toContain(`#settings/${key}`);
  }
  await page.getByTestId("settings-tab-general").click();
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("split shop forms: saving one section keeps every other setting intact", async ({ page }) => {
  await openFixtureShop(page);
  const before = (await (await page.request.get(base + "/workspace")).json()).shop;
  await section(page, "Settings/calendar");
  await page.getByLabel("Cancellation policy hours").fill("36");
  await page.getByRole("button", { name: "Save policies", exact: true }).click();
  await expect(page.getByRole("status").first()).toContainText(/Saved/);
  const after = (await (await page.request.get(base + "/workspace")).json()).shop;
  expect(after.cancel_hours).toBe(36);
  expect(after.name).toBe(before.name);
  expect(after.week_json).toBe(before.week_json);
  expect(after.calendar_density).toBe(before.calendar_density);
  expect(after.deposit_pence).toBe(before.deposit_pence);
  // Hours section saves the week only.
  await section(page, "Settings/hours");
  await page.getByRole("button", { name: "Save hours", exact: true }).click();
  await expect(page.getByRole("status").first()).toContainText(/Saved/);
  const after2 = (await (await page.request.get(base + "/workspace")).json()).shop;
  expect(after2.cancel_hours).toBe(36);
  expect(after2.name).toBe(before.name);
});

test("Google reviews: link saves to the page, shows in the footer and after a 4–5★ rating; follow-up text needs the link and sends once", async ({ page }) => {
  const { slug } = await openFixtureShop(page);
  const r = page.request;
  await section(page, "Settings/reviews");
  const panel = page.getByTestId("google-reviews");
  await expect(panel).toContainText("No Google link yet");
  // Follow-up can't be turned on without a link.
  await expect(panel.getByTestId("google-review-nudge")).toBeDisabled();
  const w0 = (await (await r.get(base + "/workspace")).json()).shop;
  const denied = await r.put(base + "/shop/reviews", { headers: { Origin: origin }, data: { google_review_nudge: 1, version: w0.version } });
  expect(denied.status()).toBe(409);
  // Wrong host rejected; Google link accepted.
  await panel.getByTestId("google-review-url").fill("https://example.com/review");
  await panel.getByTestId("save-google-review").click();
  await expect(panel.getByRole("alert")).toContainText(/Google review link/);
  await panel.getByTestId("google-review-url").fill("https://g.page/r/CaBcD123/review");
  await panel.getByTestId("save-google-review").click();
  await expect(panel.getByRole("status")).toContainText("Google link saved");
  await expect(panel).toContainText("Link set · follow-up off");
  // Controlled checkbox: it flips only after the server round-trip, so click and wait on the pill.
  await panel.getByTestId("google-review-nudge").click();
  await expect(panel).toContainText("Link set · follow-up on");
  await expect(panel.getByTestId("google-review-nudge")).toBeChecked();
  // Footer link on the public page.
  const cust = await page.context().browser()!.newContext();
  const cp = await cust.newPage();
  await cp.goto(`/${slug}`);
  await expect(cp.getByTestId("footer-google-review")).toHaveAttribute("href", "https://g.page/r/CaBcD123/review");
  // A completed visit rated 5★ through the manage link → Google CTA shown + one follow-up queued.
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const w = await (await r.get(base + "/workspace")).json();
  const today = w.shop.today || new Date().toISOString().slice(0, 10);
  // Pick a completed visit that has not been reviewed yet (the fixture seeds reviews on some).
  const reviewed = new Set(((await (await r.get(base + "/reviews")).json()).reviews as { booking_id: string }[]).map((x) => x.booking_id));
  const done = (w.bookings as { id: string; status: string; date: string; phone: string }[]).find((b) => b.status === "COMPLETED" && b.date <= today && !reviewed.has(b.id));
  test.skip(!done, "fixture has no unreviewed completed visit");
  const issued = await r.post(base + `/bookings/${done!.id}/manage-link`, { headers: { Origin: origin }, data: {} });
  expect([200, 201]).toContain(issued.status());
  const token = (await issued.json()).token as string;
  const posted = await c.post(`${origin}/api/public/manage/${token}/review`, { data: { rating: 5, body: "Top job" } });
  expect(posted.status(), await posted.text()).toBe(201);
  const body = await posted.json();
  expect(body.google_review_url).toBe("https://g.page/r/CaBcD123/review");
  await cp.goto(`/manage/${token}`);
  await expect(cp.getByTestId("review-google")).toBeVisible();
  await expect(cp.getByTestId("review-google").getByRole("link", { name: /Review on Google/ })).toHaveAttribute("href", "https://g.page/r/CaBcD123/review");
  const outbox = (await (await r.get(base + "/notifications?limit=50")).json()).notifications as { template: string; body: string; related_id: string }[];
  const nudges = outbox.filter((n) => n.template === "google_review" && n.related_id === done!.id);
  expect(nudges).toHaveLength(1);
  expect(nudges[0].body).toContain("https://g.page/r/CaBcD123/review");
  expect(nudges[0].body).toMatch(/5★/);
  await cust.close();
  await c.dispose();
});

test("workspace accent is personal and persists across reloads", async ({ page }) => {
  await openFixtureShop(page);
  await section(page, "Settings/calendar");
  const look = page.getByTestId("workspace-look");
  await look.getByTestId("ws-accent-ocean").click();
  await expect(page.locator("html")).toHaveClass(/ws-accent-ocean/);
  await expect(look.getByRole("status")).toContainText(/Saved/);
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  expect(accent).toBe("#2f6fa8");
  await page.reload();
  await expect(page.getByTestId("workspace-look")).toBeVisible();
  expect(page.url()).toContain("#settings/calendar");
  await expect(page.locator("html")).toHaveClass(/ws-accent-ocean/);
  const prefs = JSON.parse((await (await page.request.get(base + "/workspace")).json()).account.prefs_json);
  expect(prefs.workspace_theme).toEqual({ accent: "ocean", mode: "light" });
  // Customer pages are untouched by the admin accent.
  const slug = (await (await page.request.get(base + "/workspace")).json()).shop.slug as string;
  await page.goto(`/${slug}`);
  await expect(page.locator("html")).not.toHaveClass(/ws-accent-ocean/);
});
