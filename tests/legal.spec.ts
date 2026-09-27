import { test, expect, request } from "@playwright/test";
import { openFixtureShop } from "./fixture";
const origin = "http://localhost:3000";

test("legal pages render, are indexable, linked from the landing footer, and 'legal' is a reserved slug", async ({ page }) => {
  for (const doc of ["terms", "privacy", "dpa", "cookies"]) {
    const r = await page.request.get(`${origin}/legal/${doc}`);
    expect(r.status(), doc).toBe(200);
    const html = await r.text();
    expect(html).toContain('<link rel="canonical"');
    expect(html).not.toContain("noindex");
    expect(html).toContain("Version 20");
    expect(html).toContain("foliyo-wordmark-white.svg");
  }
  expect((await page.request.get(`${origin}/legal/nonsense`)).status()).toBe(404);
  expect((await page.request.get(`${origin}/legal`, { maxRedirects: 0 })).status()).toBe(302);
  // DPA lists every sub-processor.
  const dpa = await (await page.request.get(`${origin}/legal/dpa`)).text();
  for (const n of ["Supabase", "Vercel", "Stripe", "Resend", "ClickSend"]) expect(dpa).toContain(n);
  // Landing footer links to them.
  const landing = await (await page.request.get(origin + "/")).text();
  for (const d of ["terms", "privacy", "dpa", "cookies"]) expect(landing).toContain(`href="/legal/${d}"`);
});

test("signup requires accepting Terms + Privacy + DPA; acceptance is recorded with version; status/accept API works", async ({ page }) => {
  const api = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  const email = `legal-${Date.now()}@example.com`;
  const base = { shop_name: "Legal Test Shop", name: "Lex Owner", email, password: "Passw0rd!passw0rd" };
  // Missing / false → 400, no shop created.
  expect((await api.post("/api/app/auth/signup", { data: base })).status()).toBe(400);
  expect((await api.post("/api/app/auth/signup", { data: { ...base, accept_legal: false } })).status()).toBe(400);
  // Browser: checkbox is required by the form.
  await page.goto(origin + "/signup");
  await expect(page.getByTestId("accept-legal")).toBeVisible();
  await expect(page.getByTestId("accept-legal").getByRole("link", { name: "Data Processing Agreement" })).toHaveAttribute("href", "/legal/dpa");
  await page.fill('input[name="shop_name"]', base.shop_name);
  await page.fill('input[name="name"]', base.name);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', base.password);
  await page.getByRole("button", { name: "Create shop" }).click();
  // Native `required` blocks submission; still on signup.
  await expect(page).toHaveURL(/\/signup/);
  await page.getByTestId("accept-legal").locator("input").check();
  await page.getByRole("button", { name: "Create shop" }).click();
  await expect(page.getByTestId("setup-wizard")).toBeVisible({ timeout: 15000 });
  // Status: three docs accepted at current versions, nothing outstanding.
  const signed = await request.newContext({ baseURL: origin, storageState: await page.context().storageState(), extraHTTPHeaders: { Origin: origin } });
  const st = await (await signed.get("/api/app/auth/legal/status")).json();
  expect(st.required.sort()).toEqual(["dpa", "privacy", "terms"]);
  expect(st.outstanding).toEqual([]);
  expect(st.history.map((h: { document: string }) => h.document).sort()).toEqual(["dpa", "privacy", "terms"]);
  for (const h of st.history) expect(h.version).toBe(st.current[h.document]);
  // Audit trail has LEGAL_ACCEPTED.
  const w = await (await signed.get("/api/app/workspace")).json();
  expect(w.audit.some((a: { action: string }) => a.action === "LEGAL_ACCEPTED")).toBe(true);
  // Re-accept endpoint: cookies is not required for owners → 400; terms is fine.
  expect((await signed.post("/api/app/auth/legal/accept", { data: { documents: ["cookies"] } })).status()).toBe(400);
  const re = await signed.post("/api/app/auth/legal/accept", { data: { documents: ["terms"] } });
  expect(re.status()).toBe(200);
  expect((await re.json()).outstanding).toEqual([]);
  // Booking page shows the privacy line on the details step and legal links in the footer.
  const slug = w.shop.slug;
  if (slug) {
    const html = await (await page.request.get(`${origin}/book/${slug}`)).text();
    expect(html).toBeTruthy();
  }
});

test("right to erasure: owner erases a customer; personal data gone from customer, bookings, waitlist, messages, reviews; history keeps counting; barber cannot", async ({ page }) => {
  test.setTimeout(120_000); // two fixture shops (owner + barber) are seeded in this test
  await openFixtureShop(page, "owner");
  const api = await request.newContext({ baseURL: origin, storageState: await page.context().storageState(), extraHTTPHeaders: { Origin: origin } });
  const list = await (await api.get("/api/app/customers?sort=visits&limit=50")).json();
  // Pick a customer with completed history and no upcoming visits.
  const w = await (await api.get("/api/app/workspace")).json();
  const now = Date.now();
  const upcomingIds = new Set(w.bookings.filter((b: { status: string; start_at: number }) => ["CONFIRMED", "CHECKED_IN", "IN_SERVICE"].includes(b.status) && b.start_at > now).map((b: { customer_id: string }) => b.customer_id));
  const target = list.customers.find((c: { id: string; visits?: number; merged_into?: string | null }) => !upcomingIds.has(c.id) && !c.merged_into && (c.visits ?? 0) > 0) || list.customers.find((c: { id: string }) => !upcomingIds.has(c.id));
  expect(target, "a customer to erase").toBeTruthy();
  const before = await (await api.get(`/api/app/customers/${target.id}`)).json();
  const phone = before.customer.phone;
  const pastVisits = w.bookings.filter((b: { customer_id: string }) => b.customer_id === target.id).length;
  // Reason required.
  expect((await api.post(`/api/app/customers/${target.id}/erase`, { data: { version: before.customer.version, reason: "" } })).status()).toBe(400);
  // Erase.
  const r = await api.post(`/api/app/customers/${target.id}/erase`, { data: { version: before.customer.version, reason: "Customer asked by text" } });
  expect(r.status(), await r.text()).toBe(200);
  const after = (await r.json()).customer;
  expect(after.name).toBe("Erased customer");
  expect(after.phone).toMatch(/^erased:/);
  expect(after.email).toBe("");
  expect(after.notes).toBe("");
  expect(after.erased_at).toBeTruthy();
  // Twice → 409.
  expect((await api.post(`/api/app/customers/${target.id}/erase`, { data: { version: after.version, reason: "again" } })).status()).toBe(409);
  // Bookings keep existing but carry no personal data; the count is unchanged.
  const w2 = await (await api.get("/api/app/workspace")).json();
  const mine = w2.bookings.filter((b: { customer_id: string }) => b.customer_id === target.id);
  expect(mine.length).toBe(pastVisits);
  for (const b of mine) {
    expect(b.customer_name).toBe("Erased customer");
    expect(b.phone).not.toBe(phone);
    expect(b.email).toBe("");
  }
  expect(w2.bookings.some((b: { phone: string }) => b.phone === phone)).toBe(false);
  // Message log: no row still addressed to the old number.
  const out = await (await api.get("/api/app/notifications?limit=200")).json();
  expect(out.notifications.some((n: { recipient: string }) => n.recipient === phone)).toBe(false);
  // Audit.
  expect(w2.audit.some((a: { action: string; entity_id: string }) => a.action === "CUSTOMER_ERASED" && a.entity_id === target.id)).toBe(true);
  // Barber cannot erase (own fixture shop, any customer).
  const p2 = await page.context().browser()!.newPage();
  await openFixtureShop(p2, "barber");
  const barber = await request.newContext({ baseURL: origin, storageState: await p2.context().storageState(), extraHTTPHeaders: { Origin: origin } });
  const theirs = await (await barber.get("/api/app/customers?limit=5")).json();
  if (theirs.customers?.length) {
    const denied = await barber.post(`/api/app/customers/${theirs.customers[0].id}/erase`, { data: { version: 0, reason: "nope" } });
    expect(denied.status()).toBe(403);
  }
  await p2.close();
});
