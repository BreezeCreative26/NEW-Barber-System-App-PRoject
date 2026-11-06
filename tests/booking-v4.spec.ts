// Customer booking v3 layout (4 steps): progress bars, extras under the chosen service, compact
// barber list with each barber's next free time, tidy time screen, account created on the confirm
// step, and "Book your usual" for returning customers.
import { test, expect, request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { WorkspaceData } from "../src/server/domain";
import { base, origin } from "./shop";

const PHONE = "07700901000"; // Ada Lovelace in the fixture shop, with completed visits on weekdays
async function fixture() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const { slug } = (await res.json()) as { slug: string };
  const w: WorkspaceData = await (await r.get(base + "/workspace")).json();
  return { r, slug, w };
}

test("team-next API: next free time per barber, off-today flag, validated", async () => {
  const { slug, w } = await fixture();
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const svc = w.services[0];
  const res = await c.get(`${origin}/api/public/shops/${slug}/team-next?service_id=${svc.id}`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.team.length).toBeGreaterThan(0);
  for (const t of body.team) {
    expect(typeof t.off_today).toBe("boolean");
    expect(t.price_pence).toBeGreaterThan(0);
    if (t.next) {
      expect(t.next.date >= body.today).toBe(true);
      // The time it names is really bookable with that barber.
      const av = await (await c.get(`${origin}/api/public/shops/${slug}/availability?date=${t.next.date}&staff_id=${t.staff_id}&service_id=${svc.id}`)).json();
      expect(av.slots.find((s: { start_min: number }) => s.start_min === t.next.start_min)?.available).toBe(true);
    }
  }
  expect((await c.get(`${origin}/api/public/shops/${slug}/team-next?service_id=nope`)).status()).toBe(400);
  await c.dispose();
});

test("4-step flow: bars, extras under the service, compact barber list, Continue · time, account on confirm", async ({ page }) => {
  const { slug, w } = await fixture();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/book/${slug}`);
  const steps = page.getByTestId("booking-steps");
  await expect(steps.getByRole("button")).toHaveCount(4);
  await expect(steps.getByRole("button", { name: "Service (current step)" })).toBeVisible();
  // No old "STEP 01 OF 05" eyebrow or "Step 1 of 5" counter.
  await expect(page.getByText(/STEP 0\d OF 0\d|Step \d of \d/)).toHaveCount(0);

  // Pick a service that has extras: they appear under it, and only under it.
  const withExtras = await page.evaluate(async (s) => {
    const shop = await (await fetch(`/api/public/shops/${s}`)).json();
    const linked = new Set(shop.addon_links.map((l: { service_id: string }) => l.service_id));
    return shop.services.find((x: { id: string }) => linked.has(x.id))?.name as string | undefined;
  }, slug);
  expect(withExtras, "fixture has a service with extras").toBeTruthy();
  await page.getByRole("button", { name: new RegExp(withExtras!) }).first().click();
  // Extras sit inside the chosen service's card, and no other card shows any.
  const extras = page.getByTestId("service-extras");
  await expect(extras).toHaveCount(1);
  await expect(page.locator(".service-item.chosen").getByTestId("service-extras")).toHaveCount(1);
  const chip = extras.getByRole("button").first();
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");

  // Barber list: Anyone first, one compact row per barber with their next free time.
  await page.getByRole("button", { name: "Pick a barber", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Who’s cutting?" })).toBeVisible();
  await expect(page.getByTestId("step-summary")).toContainText(withExtras!);
  const list = page.getByTestId("barber-list");
  await expect(list.getByRole("button").first()).toHaveAttribute("data-testid", "barber-any");
  await expect(list.getByTestId("barber-option").first()).toContainText(/Next free|No free times/);
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  // Tapping a row moves straight on.
  await list.getByTestId("barber-option").first().click();
  await expect(page.getByRole("heading", { name: "When suits you?" })).toBeVisible();
  await expect(steps.getByRole("button", { name: "Time (current step)" })).toBeVisible();

  // Time screen: one date heading (no month + date + "N available" repeats).
  await expect(page.getByTestId("chosen-day")).toHaveCount(1);
  await expect(page.locator(".slot-heading")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pick a time" })).toBeDisabled();
  const dates = page.locator(".booking-dates button:not([disabled])");
  const slots = page.getByRole("group", { name: "Choose an appointment time" }).locator(".time-slots button:not(.time-more):not([disabled])");
  for (let i = 0; i < 6 && !(await slots.count()); i++) {
    await dates.nth(i + 1).click();
    await page.waitForTimeout(600);
  }
  const first = slots.first();
  const at = ((await first.textContent()) || "").match(/\d{2}:\d{2}/)![0];
  await first.click();
  await expect(page.getByTestId("hold-pill")).toContainText(`${at} is held for you`);
  await page.getByRole("button", { name: `Continue · ${at}` }).click();

  // Confirm: the account is created here, then the booking is made in one tap.
  await expect(page.getByRole("heading", { name: "Last step: your account" })).toBeVisible();
  await expect(steps.getByRole("button", { name: "Confirm (current step)" })).toBeVisible();
  await expect(page.getByTestId("review-facts")).toContainText(at);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await page.getByLabel("Your name").fill("Layout Tester");
  await page.getByLabel("Mobile number").fill(`07${String(Date.now()).slice(-9)}`);
  await page.getByLabel("Email address", { exact: true }).fill(`layout-${Date.now()}@example.test`);
  await page.getByTestId("booking-password").fill("Fictional-test-pass-2026!");
  const terms = page.getByTestId("booking-terms-tick");
  if (await terms.count()) await terms.check();
  await expect(page.getByTestId("auth-submit")).toHaveText(/Create account & book/);
  await page.getByTestId("auth-submit").click();
  await expect(page.locator(".public-reference")).toHaveText(/^BRB-\d{4}$/);
  expect(errors).toEqual([]);
});

test("returning customer: Book your usual opens the time step with service and barber set", async ({ page }) => {
  test.skip(new Date().getUTCDay() === 0, "fixture has no completed visits for Ada on Sundays");
  const { slug } = await fixture();
  await page.goto(`/${slug}`);
  // Sign Ada in with a one-time code (sandbox shows the code).
  const ok = await page.evaluate(async ({ slug, phone }) => {
    const post = (p: string, b: unknown) => fetch(`/api/public/shops/${slug}/account/${p}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json().then((j) => ({ s: r.status, j })));
    const st = await post("start", { phone });
    const v = await post("verify", { phone, code: st.j.sandbox_code });
    return v.s;
  }, { slug, phone: PHONE });
  expect(ok).toBe(201);
  // The session cookie belongs to the shop's own host, so read "your usual" from inside the page.
  const me = await page.evaluate(async (s) => (await fetch(`/api/public/shops/${s}/account/me`, { credentials: "same-origin" })).json(), slug);
  expect(me.usual, "Ada has a usual").toBeTruthy();
  await page.goto(`/book/${slug}`);
  const card = page.getByTestId("book-usual-card");
  await expect(card).toContainText(me.usual.service_name);
  await card.getByTestId("book-usual-again").click();
  await expect(page.getByRole("heading", { name: "When suits you?" })).toBeVisible();
  await expect(page.getByTestId("step-summary")).toContainText(me.usual.service_name);
  if (me.usual.staff_name) await expect(page.getByTestId("step-summary")).toContainText(me.usual.staff_name.split(" ")[0]);
});
