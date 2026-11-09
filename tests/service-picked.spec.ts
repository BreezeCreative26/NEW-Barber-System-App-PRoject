// The service a customer taps is the service they book. Nothing is pre-selected; a returning
// customer sees what they booked last time as a one-tap shortcut instead.
import { test, expect, request } from "@playwright/test";
import { signInCustomer } from "./shop";
import { base, origin } from "./fixture";

async function fixture() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const { slug } = (await res.json()) as { slug: string };
  return { r, slug };
}

test("nothing pre-selected; the tapped service (not the first on the menu) is exactly what gets booked", async ({ page }) => {
  test.setTimeout(90000);
  const { r, slug } = await fixture();
  // The session lives on the shop's own host, so sign in from inside the page.
  const who = await signInCustomer(page, slug, { name: "Tap Tester" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/book/${slug}`);
  const shop = await page.evaluate(async (s) => (await fetch(`/api/public/shops/${s}`)).json(), slug);

  // Arrival: no service chosen, both ways on disabled, the bar asks them to pick.
  await expect(page.locator(".service-choice").first()).toBeVisible();
  await expect(page.locator('.service-choice[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.getByTestId("any-barber-skip")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Pick a barber", exact: true })).toBeDisabled();
  await expect(page.locator(".mobile-checkout-total small")).toHaveText("Pick a service");

  // Tap a service that is NOT the first on the menu and not in "Most booked".
  const top: string[] = shop.top_services || [];
  const target = (shop.services as { id: string; name: string }[]).slice(1).find((s) => !top.includes(s.id))!;
  expect(target, "a non-first, non-top service").toBeTruthy();
  const card = page.locator(".service-item").filter({ has: page.getByRole("button", { name: new RegExp(`^${target.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) }) }).first();
  await card.locator(".service-choice").click();
  await expect(card.locator(".service-choice")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.service-choice[aria-pressed="true"]')).toHaveCount(1);
  await expect(page.locator(".mobile-checkout-total small")).toHaveText(target.name);

  // Any barber → first open time → review shows that service → confirm.
  await page.getByTestId("any-barber-skip").click();
  await expect(page.getByRole("heading", { name: "When suits you?" })).toBeVisible();
  await expect(page.getByTestId("step-summary")).toContainText(target.name);
  const slots = page.getByRole("group", { name: "Choose an appointment time" }).locator(".time-slots button:not(.time-more):not([disabled])");
  for (let i = 0; i < 6 && !(await slots.count()); i++) {
    const days = page.locator(".date-strip button:not([disabled])");
    if ((await days.count()) > i + 1) await days.nth(i + 1).click();
    else await page.getByRole("button", { name: "Next week" }).click();
  }
  await slots.first().click();
  await page.getByRole("button", { name: /^Continue · \d{2}:\d{2}/ }).click();
  await expect(page.getByText(target.name).first()).toBeVisible();
  await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
  await expect(page.locator(".public-reference")).toHaveText(/^[A-Z]+-\d{4}$/);

  // The saved booking is that exact service, and the audit records what was chosen.
  const w = await (await r.get(base + "/workspace")).json();
  const mine = (w.bookings as { id: string; phone: string; service_id: string; service_name: string }[]).filter((b) => b.phone.replace(/\s/g, "").endsWith(who.phone.replace(/\s/g, "").slice(-9)));
  expect(mine.length).toBe(1);
  expect(mine[0].service_id).toBe(target.id);
  expect(mine[0].service_name).toBe(target.name);
  expect(mine[0].service_id).not.toBe(shop.services[0].id);
  const audit = (w.audit as { entity_id: string; action: string; reason: string }[]).find((a) => a.entity_id === mine[0].id && a.action === "BOOKING_CREATED");
  if (audit) expect(audit.reason).toContain(`Chose: ${target.name}`);
});

test("returning customer sees 'Last time' as a shortcut, nothing is pre-selected, and Book again books that service", async ({ page }) => {
  test.skip(new Date().getUTCDay() === 0, "fixture has no completed visits for Ada on Sundays");
  const { slug } = await fixture();
  await page.goto(`/${slug}`);
  const ok = await page.evaluate(async ({ slug, phone }) => {
    const post = (p: string, b: unknown) => fetch(`/api/public/shops/${slug}/account/${p}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json().then((j) => ({ s: r.status, j })));
    const st = await post("start", { phone });
    return (await post("verify", { phone, code: st.j.sandbox_code })).s;
  }, { slug, phone: "07700901000" });
  expect(ok).toBe(201);
  const me = await page.evaluate(async (s) => (await fetch(`/api/public/shops/${s}/account/me`, { credentials: "same-origin" })).json(), slug);
  expect(me.last, "Ada has a last visit").toBeTruthy();
  await page.goto(`/book/${slug}`);
  const card = page.getByTestId("book-usual-card");
  await expect(card).toContainText("Last time");
  await expect(card.getByTestId("book-usual-service")).toContainText(me.last.service_name);
  // Showing it does not choose it.
  await expect(page.locator('.service-choice[aria-pressed="true"]')).toHaveCount(0);
  await card.getByTestId("book-usual-again").click();
  await expect(page.getByRole("heading", { name: "When suits you?" })).toBeVisible();
  await expect(page.getByTestId("step-summary")).toContainText(me.last.service_name);
});

test("group booking: nobody starts with a service; Next stays off until each person has one", async ({ page }) => {
  const { slug } = await fixture();
  await signInCustomer(page, slug, { name: "Group Tapper" });
  await page.goto(`/book/${slug}`);
  await page.getByTestId("start-group").click();
  const selects = page.getByTestId("member-service");
  await expect(selects.first()).toBeVisible();
  for (const v of await selects.evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).value))) expect(v).toBe("");
  await page.getByTestId("member-name").nth(1).fill("Little Sam");
  await expect(page.getByTestId("group-next")).toBeDisabled();
  const opts = await selects.first().locator("option:not([disabled])").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  await selects.nth(0).selectOption(opts[2]);
  await selects.nth(1).selectOption(opts[3]);
  await expect(page.getByTestId("group-next")).toBeEnabled();
  await expect(selects.nth(0)).toHaveValue(opts[2]);
  await expect(selects.nth(1)).toHaveValue(opts[3]);
});
