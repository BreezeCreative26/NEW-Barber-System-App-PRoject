// Customer accounts: passwordless one-time-code sign-in, shop-scoped sessions, the /<slug>/me area
// (usual, upcoming move/cancel, history, profile, export/delete) and the admin "online account" badge.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { base, origin, openFixtureShop, section } from "./fixture";

// Demo customers i have phone 0770090(1000+i); i % 3 === 0 are Jay's regulars on the Signature cut.
// Accounts are global per phone, so each test signs in a different customer to stay independent in parallel.
const PHONE = "07700901000"; // Ada Lovelace (browser + admin tests)
// API tests pick a distinct regular from the fixture's own directory (customers exist only once they have visits).
async function regular(r: APIRequestContext, nth: number) {
  const dir = await (await r.get(base + "/customers?sort=visits&limit=20")).json();
  const c = dir.customers.filter((x: { phone: string; completed: number }) => x.phone !== PHONE && x.completed >= 2)[nth];
  expect(c, "fixture has enough regulars").toBeTruthy();
  return c as { phone: string; name: string };
}

async function fixture() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { slug: string; shop_id: string };
  return { r, slug: body.slug, A: `${origin}/api/public/shops/${body.slug}/account` };
}
async function signedIn(A: string, phone = PHONE) {
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const st = await (await c.post(`${A}/start`, { data: { phone } })).json();
  const v = await c.post(`${A}/verify`, { data: { phone, code: st.sandbox_code } });
  expect(v.status(), await v.text()).toBe(201);
  return c;
}

test("one-time code sign-in: wrong code rejected, attempts capped, code single-use, session scoped to the shop", async () => {
  const { A, slug, r } = await fixture();
  const other = await fixture();
  const who = await regular(r, 0);
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  expect((await c.post(`${A}/start`, { data: { phone: "12345" } })).status()).toBe(400);
  const P = who.phone;
  const start = await c.post(`${A}/start`, { data: { phone: P.replace(/^(\d{5})/, "$1 ") } });
  expect(start.status()).toBe(201);
  const st = await start.json();
  expect(st.sandbox_code).toMatch(/^\d{6}$/);
  expect(st.delivery).toBe("on_screen");
  // Signed out: session is null, /me is 401.
  expect((await (await c.get(`${A}/session`)).json()).profile).toBeNull();
  expect((await c.get(`${A}/me`)).status()).toBe(401);
  const wrong = "000000" === st.sandbox_code ? "111111" : "000000";
  for (let i = 0; i < 5; i++) expect((await c.post(`${A}/verify`, { data: { phone: P, code: wrong } })).status()).toBe(401);
  // Sixth wrong attempt locks the code even if it is right.
  expect((await c.post(`${A}/verify`, { data: { phone: P, code: st.sandbox_code } })).status()).toBe(429);
  // New code works, and is single-use.
  const st2 = await (await c.post(`${A}/start`, { data: { phone: P } })).json();
  const ok = await c.post(`${A}/verify`, { data: { phone: P, code: st2.sandbox_code } });
  expect(ok.status(), await ok.text()).toBe(201);
  const body = await ok.json();
  expect(body.profile.name).toBe(who.name); // seeded from the shop's customer record
  expect(body.profile.phone).toBe(P);
  expect((await c.post(`${A}/verify`, { data: { phone: P, code: st2.sandbox_code } })).status()).toBe(409);
  // Session works here…
  expect((await c.get(`${A}/me`)).status()).toBe(200);
  // …but not on another shop, even with the same cookie jar.
  expect((await c.get(`${other.A}/me`)).status()).toBe(401);
  expect((await (await c.get(`${other.A}/session`)).json()).profile).toBeNull();
  // Sign out clears it.
  expect((await c.post(`${A}/logout`, { data: {} })).status()).toBe(200);
  expect((await c.get(`${A}/me`)).status()).toBe(401);
  expect(slug).toBeTruthy();
});

test("/me returns only this shop's rows: usual, next free slot, upcoming, history; manage own visits; not others'", async () => {
  const { A, r } = await fixture();
  const P = (await regular(r, 1)).phone;
  const c = await signedIn(A, P);
  const me = await (await c.get(`${A}/me`)).json();
  expect(me.profile.phone).toBe(P);
  expect(me.usual).toMatchObject({ service_name: expect.any(String), staff_name: expect.any(String), count: expect.any(Number) });
  expect(me.usual.count).toBeGreaterThanOrEqual(1);
  expect(me.next_usual).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), start_min: expect.any(Number) });
  expect(me.upcoming.length).toBeGreaterThan(0);
  expect(me.history.length).toBeGreaterThan(0);
  for (const v of [...me.upcoming, ...me.history]) expect(v.phone).toBe(P);
  expect(me.stats.visits).toBeGreaterThan(0);
  // Move a manageable upcoming visit to another free time, then cancel it.
  const target = me.upcoming.find((v: { can_manage: boolean }) => v.can_manage);
  expect(target).toBeTruthy();
  const w = await (await r.get(base + "/workspace")).json();
  let moved = false;
  for (let d = 1; d <= 10 && !moved; d++) {
    const date = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
    const av = await (await c.get(`${A}/bookings/${target.id}/availability?date=${date}`)).json();
    const free = av.slots?.find((s: { available: boolean }) => s.available);
    if (!free) continue;
    const mv = await c.post(`${A}/bookings/${target.id}/reschedule`, { data: { date, start_min: free.start_min, version: target.version } });
    expect(mv.status(), await mv.text()).toBe(200);
    const after = (await mv.json()).booking;
    expect(after.date).toBe(date);
    expect(after.start_min).toBe(free.start_min);
    const cancel = await c.post(`${A}/bookings/${target.id}/cancel`, { data: { version: after.version } });
    expect(cancel.status(), await cancel.text()).toBe(200);
    expect((await cancel.json()).booking.status).toBe("CANCELLED");
    moved = true;
  }
  expect(moved).toBe(true);
  // Someone else's booking is invisible (404, not 403).
  const foreign = (await (await r.get(base + `/bookings/range?from=${new Date().toISOString().slice(0, 10)}&to=${new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)}`)).json()).bookings.find(
    (b: { phone: string }) => b.phone !== P,
  );
  expect(foreign).toBeTruthy();
  expect((await c.post(`${A}/bookings/${foreign.id}/cancel`, { data: { version: 0 } })).status()).toBe(404);
  expect((await c.get(`${A}/bookings/${foreign.id}/calendar.ics`)).status()).toBe(404);
  // Own calendar export works.
  const own = me.upcoming.find((v: { id: string }) => v.id !== target.id) ?? me.history[0];
  const ics = await c.get(`${A}/bookings/${own.id}/calendar.ics`);
  expect(ics.status()).toBe(200);
  expect(await ics.text()).toContain("BEGIN:VEVENT");
  // Owner's audit log attributes the cancellation to the customer account, never to the shop.
  const w2 = await (await r.get(base + "/workspace")).json();
  const events = (w2.audit ?? w2.events ?? []) as { actor: string; action: string }[];
  expect(events.some((e) => e.actor.startsWith("customer:") && e.action === "CANCELLED")).toBe(true);
});

test("profile: validated, versioned, reflected in the shop's customer record; export and delete", async () => {
  const { A, r } = await fixture();
  const P = (await regular(r, 2)).phone;
  const c = await signedIn(A, P);
  const me = await (await c.get(`${A}/me`)).json();
  const p = me.profile;
  const barber = me.staff[1];
  const bad = await c.put(`${A}/profile`, { data: { name: "A", email: "", birthday: "", preferred_staff_id: "", marketing_opt_in: 0, notes: "", version: p.version } });
  expect(bad.status()).toBe(400);
  const ok = await c.put(`${A}/profile`, {
    data: { name: "Kofi M.", email: "kofi@example.test", birthday: "1990-12-10", preferred_staff_id: barber.id, marketing_opt_in: 1, notes: "Number 2 on the sides", version: p.version },
  });
  expect(ok.status(), await ok.text()).toBe(200);
  const stale = await c.put(`${A}/profile`, { data: { name: "Stale", email: "", birthday: "", preferred_staff_id: "", marketing_opt_in: 0, notes: "", version: p.version } });
  expect(stale.status()).toBe(409);
  // Shop's customer directory shows the change and the account badge.
  const dir = await (await r.get(base + "/customers?q=" + P)).json();
  expect(dir.customers).toHaveLength(1);
  expect(dir.customers[0]).toMatchObject({ name: "Kofi M.", email: "kofi@example.test", preferred_staff_id: barber.id, marketing_opt_in: 1, notes: "Number 2 on the sides" });
  expect(dir.customers[0].account_last_seen_at).toBeGreaterThan(0);
  // Export bundles account, customer and bookings.
  const exp = await c.get(`${A}/export`);
  expect(exp.status()).toBe(200);
  expect(exp.headers()["content-disposition"]).toContain("attachment");
  const data = await exp.json();
  expect(data.customer.name).toBe("Kofi M.");
  expect(data.bookings.length).toBeGreaterThan(0);
  // Delete: needs the literal confirm; then signed out; shop history remains; badge gone.
  expect((await c.post(`${A}/delete`, { data: { confirm: "yes" } })).status()).toBe(400);
  expect((await c.post(`${A}/delete`, { data: { confirm: "DELETE" } })).status()).toBe(200);
  expect((await c.get(`${A}/me`)).status()).toBe(401);
  const after = await (await r.get(base + "/customers?q=" + P)).json();
  expect(after.customers[0].visits).toBeGreaterThan(0);
  expect(after.customers[0].account_last_seen_at).toBeNull();
});

test("browser: sign in on /<slug>/me, see usual and visits, rebook the usual with details prefilled, move a visit, edit profile", async ({ page }) => {
  const { slug } = await fixture();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`/${slug}/me`);
  await expect(page.getByTestId("customer-signin")).toBeVisible();
  await page.getByTestId("signin-phone").fill("07700 901000");
  await page.getByTestId("signin-send").click();
  const code = (await page.getByTestId("shown-code").textContent())!;
  expect(code).toMatch(/^\d{6}$/);
  await page.getByTestId("signin-code").fill(code);
  await page.getByTestId("signin-verify").click();
  const area = page.getByTestId("customer-area");
  await expect(area).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /Hello, Ada/ })).toBeVisible();
  await expect(page.getByTestId("your-usual")).toContainText("Signature cut with Jay");
  await expect(page.getByTestId("upcoming-list").locator("li").first()).toBeVisible();
  await expect(page.getByTestId("history-list").locator("li").first()).toBeVisible();
  let a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

  // Move the first manageable visit via the dialog.
  // The first row may be inside the lead time (no Move button); act on the first movable one.
  const firstRow = page.getByTestId("upcoming-list").locator("li").filter({ has: page.getByTestId("move-visit") }).first();
  const reference = (await firstRow.textContent())!.match(/BRB-\d{4}/)![0];
  const beforeWhen = await firstRow.locator(".ca-visit-when").textContent();
  await firstRow.getByTestId("move-visit").click();
  const dialog = page.getByRole("dialog", { name: "Move your visit" });
  await expect(dialog).toBeVisible();
  // Walk forward until a day has a free slot.
  const days = dialog.getByRole("group", { name: "Choose a day" }).getByRole("button");
  for (let i = 1; i < 14; i++) {
    await days.nth(i).click();
    await expect(dialog.getByRole("group", { name: "Choose a time" })).not.toHaveAttribute("aria-busy", "true");
    if (await dialog.getByTestId("move-slot").count()) break;
  }
  // Pick a slot that differs from the current time so the row visibly changes.
  const currentTime = beforeWhen!.match(/\d{2}:\d{2}/)![0];
  const slots = dialog.getByTestId("move-slot");
  const n = await slots.count();
  let picked = false;
  for (let i = 0; i < n; i++) {
    if ((await slots.nth(i).textContent()) !== currentTime) {
      await slots.nth(i).click();
      picked = true;
      break;
    }
  }
  expect(picked).toBe(true);
  await dialog.getByTestId("confirm-move").click();
  await expect(page.getByRole("status")).toContainText("Your visit has moved");
  const movedRow = page.getByTestId("upcoming-list").locator("li").filter({ hasText: reference });
  await expect(movedRow).toHaveCount(1);
  await expect(movedRow.locator(".ca-visit-when")).not.toHaveText(beforeWhen!);

  // Profile edit round-trips.
  await page.getByTestId("tab-profile").click();
  await page.getByTestId("profile-notes").fill("Scissors on top please");
  await page.getByTestId("save-profile").click();
  await expect(page.getByRole("status")).toContainText("Profile saved");
  a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

  // "Your usual" deep-links to the shop page with the flow on the time step, barber + service set, details prefilled.
  await page.getByTestId("tab-visits").click();
  await page.getByTestId("book-usual-next").click();
  await expect(page).toHaveURL(new RegExp(`/${slug}\\?.*service=.*#book`));
  await expect(page.getByTestId("shop-page")).toBeVisible();
  await expect(page.getByTestId("nav-me")).toContainText("Ada");
  const flow = page.locator(".booking-app.embedded");
  await expect(flow.getByRole("heading", { name: "A time that works for you." })).toBeVisible();
  await expect(flow.locator(".booking-summary")).toContainText("Signature cut");
  await expect(flow.locator(".booking-summary")).toContainText("Jay");
  await expect(flow.getByRole("group", { name: "Choose an appointment time" }).locator("button[aria-pressed='true']")).toHaveCount(1);
  await flow.getByRole("button", { name: "Your details", exact: true }).click();
  await expect(flow.getByTestId("signed-in-note")).toContainText("Ada");
  await expect(flow.getByLabel("Your name")).toHaveValue(/Ada/);
  await expect(flow.getByLabel("Mobile number")).toHaveValue(PHONE);
  await expect(flow.locator("textarea[name=notes]")).toHaveValue("Scissors on top please");
  await flow.getByRole("button", { name: "Review booking" }).click();
  await flow.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.locator(".public-reference")).toHaveText(/^BRB-\d{4}$/);
  expect(errors).toEqual([]);

  // Sign out from the area.
  await page.goto(`/${slug}/me`);
  await expect(page.getByTestId("customer-area")).toBeVisible();
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("customer-signin")).toBeVisible();
});

test("admin: Customer pages lists accounts as live; a customer who signed in carries the online-account badge", async ({ page }) => {
  const { slug } = await openFixtureShop(page);
  const A = `${origin}/api/public/shops/${slug}/account`;
  await signedIn(A);
  await section(page, "Settings");
  const panel = page.getByTestId("customer-pages");
  await expect(panel).toContainText("Customer accounts");
  await expect(panel.getByTestId("view-customer-area")).toHaveAttribute("href", new RegExp(`/${slug}/me$`));
  expect((await page.request.get(`/${slug}/me`)).status()).toBe(200);
  expect((await page.request.get(`/no-such-shop/me`)).status()).toBe(404);
  await section(page, "Customers");
  await page.getByPlaceholder("Search name, mobile, email or tag").fill(PHONE);
  const row = page.getByTestId("customer-list").locator("li").filter({ hasText: PHONE }).first();
  await expect(row).toContainText("online account");
  await row.click();
  await expect(page.getByTestId("has-account")).toBeVisible();
});
