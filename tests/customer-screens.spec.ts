// Customer-facing screen tour. Not a behaviour test — it walks the public journey on a phone
// viewport and writes one screenshot per step to docs/evidence/customer/ so the screens a customer
// actually sees (shop page, booking steps, confirmation, manage link, account sign-in, account)
// can be reviewed together. Run alone: npx playwright test tests/customer-screens.spec.ts
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { base, newShop } from "./shop";
const slugFor = () => `fade-${crypto.randomUUID().slice(0, 8)}`;

const out = "docs/evidence/customer";
mkdirSync(out, { recursive: true });
const shot = (page: import("@playwright/test").Page, name: string) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });

function futureDate(days = 8) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("customer screen tour", async ({ page }) => {
  const { r } = await newShop("Fade & Co");
  let w = await (await r.get(base + "/workspace")).json();
  const slug = slugFor();
  expect((await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } })).status()).toBe(200);
  // Give the page a real brand so the tour reflects a set-up shop, not the blank default.
  const pg = await (await r.get(base + "/shop/page")).json();
  const pageRes = await r.put(base + "/shop/page", {
    data: {
      strapline: "Sharp cuts, no waiting around.",
      about: "Independent barbers in the heart of town. Walk-ins welcome when we're free — book ahead to be sure.",
      cover_url: "",
      logo_url: "",
      gallery: [],
      phone: "0161 496 0000",
      email: "hello@fadeandco.example",
      instagram: "fadeandco",
      map_url: "",
      google_review_url: "https://g.page/r/fade-and-co/review",
      transport_note: "",
      policy_text: "",
      sections: JSON.parse(pg.page.sections_json || "[]"),
      accent: "clay",
      theme: JSON.parse(pg.page.theme_json || "{}"),
      published: 1,
      version: pg.page.version,
    },
  });
  expect(pageRes.status(), await pageRes.text()).toBe(200);
  w = await (await r.get(base + "/workspace")).json();
  const date = futureDate();

  // 1. Shop page
  await page.goto(`/${slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await shot(page, "01-shop-page");

  // 2–6. Booking flow
  await page.goto(`/book/${slug}`);
  await expect(page.getByRole("heading", { name: "What are we doing today?" })).toBeVisible();
  await shot(page, "02-book-service");
  await page.getByRole("button", { name: new RegExp(w.services[1].name) }).click();
  await page.getByRole("button", { name: "Choose your barber", exact: true }).click();
  await shot(page, "03-book-barber");
  await page.getByRole("button", { name: new RegExp(w.staff[0].name) }).click();
  await page.getByRole("button", { name: "Find a time", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A time that works for you." })).toBeVisible();
  const target = new Date(`${date}T12:00:00Z`);
  const label = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" }).format(target);
  for (let i = 0; i < 3; i++) {
    if (await page.getByRole("button", { name: new RegExp(`^${label},`) }).count()) break;
    await page.getByRole("button", { name: "Next week" }).click();
  }
  await page.getByRole("button", { name: new RegExp(`^${label},`) }).click();
  await expect(page.getByRole("group", { name: "Choose an appointment time" }).locator("button:not([disabled])").first()).toBeVisible();
  await shot(page, "04-book-time");
  await page.getByRole("group", { name: "Choose an appointment time" }).locator("button:not([disabled])").first().click();
  await page.getByRole("button", { name: "Your details", exact: true }).click();
  await page.getByLabel("Your name").fill("Jordan Lee");
  await page.getByLabel("Mobile number").fill("07700 900123");
  await page.getByLabel("Email address (optional)").fill("jordan@example.test");
  await shot(page, "05-book-details");
  await page.getByRole("button", { name: "Review booking" }).click();
  await expect(page.getByRole("heading", { name: "Check and confirm." })).toBeVisible();
  await shot(page, "06-book-review");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
  await shot(page, "07-book-confirmed");

  // 8. Manage link (what the text/email link opens)
  const href = await page.getByTestId("open-manage").getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
  await shot(page, "08-manage-visit");
  await page.getByRole("button", { name: "Move booking" }).click();
  await expect(page.getByRole("group", { name: "Choose a new time" })).toBeVisible();
  // Guard: the move step must never widen the page on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(page, "09-manage-move");

  // 10–11. Customer account: branded sign-in, then the account
  await page.goto(`/${slug}/me`);
  await expect(page.getByTestId("customer-signin")).toBeVisible();
  await page.getByLabel(/mobile/i).fill("07700 900123");
  await shot(page, "10-account-signin");
  await page.getByRole("button", { name: /code|continue|send/i }).first().click();
  const code = await page.getByTestId("shown-code").textContent();
  await page.getByLabel(/code/i).fill(code!.trim());
  await page.getByRole("button", { name: /sign in|verify|continue/i }).first().click();
  await expect(page.getByTestId("customer-area")).toBeVisible();
  await shot(page, "11-account");
});
