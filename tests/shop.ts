// Shared bootstrap for API tests: sign up a fresh shop through the real front door, then
// seed the classic two-barber / three-service catalogue through the real API so existing
// assertions (names, counts) keep holding. The owner's own barber profile is deactivated so
// `staff` has exactly the two seeded barbers.
import { expect, request, type APIRequestContext } from "@playwright/test";

export const origin = "http://localhost:3000";
export const base = origin + "/api/app";
export const PASSWORD = "Unique fictional test password 438!";
export const email = () => `owner-${crypto.randomUUID().slice(0, 8)}@ollo.test`;


// Classic fixture hours: Mon–Sat 09:00–18:00 with a 12:45–13:30 break; Sunday off.
export const FIXTURE_HOURS = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  enabled: weekday === 0 ? 0 : 1,
  starts: 540,
  ends: 1080,
  break_start: 765,
  break_end: 810,
}));
async function setFixtureHours(r: APIRequestContext, headers?: Record<string, string>) {
  const w = await (await r.get(base + "/workspace")).json();
  for (const s of w.staff as { id: string; version: number }[]) {
    const res = await r.put(base + `/staff/${s.id}/hours`, { headers, data: { version: s.version, rows: FIXTURE_HOURS } });
    expect(res.status(), await res.text()).toBe(200);
  }
}

export type Seeded = { r: APIRequestContext; email: string; shop_id: string };

export async function signup(r: APIRequestContext, name = "API test shop", address = email()) {
  const res = await r.post(base + "/auth/signup", {
    data: { accept_legal: true, shop_name: name, name: "Zed Owner", email: address, password: PASSWORD },
  });
  expect(res.status(), await res.text()).toBe(201);
  return { email: address, shop_id: (await res.json()).shop_id as string };
}

export async function seedCatalogue(r: APIRequestContext) {
  const w = await (await r.get(base + "/workspace")).json();
  // Signup created one barber profile named after the owner; rename it to the classic first
  // barber and add the second, so `staff` is exactly [Jay Carter, Marcus Reed] (ordered by name).
  const own = (w.staff as { id: string; version: number }[])[0];
  const renamed = await r.put(base + `/staff/${own.id}`, {
    data: { name: "Jay Carter", role: "Senior barber", version: own.version },
  });
  expect(renamed.status(), await renamed.text()).toBe(200);
  const added = await r.post(base + "/staff", { data: { name: "Marcus Reed", role: "Barber" } });
  expect(added.status(), await added.text()).toBe(201);
  for (const s of [
    { name: "Signature cut", duration_min: 30, price_pence: 2800 },
    { name: "Skin fade", duration_min: 45, price_pence: 3200 },
    { name: "Cut & beard", duration_min: 60, price_pence: 4200 },
  ]) {
    const res = await r.post(base + "/services", { data: { ...s, category: "Hair" } });
    expect(res.status(), await res.text()).toBe(201);
  }
  await setFixtureHours(r);
}

// One call: new context (same-origin header), signup, seeded catalogue.
export async function newShop(name = "API test shop"): Promise<Seeded> {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const { email, shop_id } = await signup(r, name);
  await seedCatalogue(r);
  return { r, email, shop_id };
}

// Browser variant: sign up + seed through page.request so the session cookie lands in the page.
import type { Page } from "@playwright/test";
export async function enterNewShop(page: Page, name = "UI test shop") {
  const res = await page.request.post(base + "/auth/signup", {
    headers: { Origin: origin },
    data: { shop_name: name, name: "Zed Owner", email: email(), password: PASSWORD, accept_legal: true },
  });
  expect(res.status(), await res.text()).toBe(201);
  const r = page.request;
  const w = await (await r.get(base + "/workspace")).json();
  const own = w.staff[0];
  expect((await r.put(base + `/staff/${own.id}`, { headers: { Origin: origin }, data: { name: "Jay Carter", role: "Senior barber", version: own.version } })).status()).toBe(200);
  expect((await r.post(base + "/staff", { headers: { Origin: origin }, data: { name: "Marcus Reed", role: "Barber" } })).status()).toBe(201);
  for (const s of [
    { name: "Signature cut", duration_min: 30, price_pence: 2800 },
    { name: "Skin fade", duration_min: 45, price_pence: 3200 },
    { name: "Cut & beard", duration_min: 60, price_pence: 4200 },
  ])
    expect((await r.post(base + "/services", { headers: { Origin: origin }, data: { ...s, category: "Hair" } })).status()).toBe(201);
  await setFixtureHours(r, { Origin: origin });
  await page.goto("/workspace");
  await expect(page.getByRole("button", { name: "New booking", exact: true })).toBeVisible();
}

// Payload for PUT /shop mirroring a workspace's current shop (per-day week derived from legacy fields).
export function shopPayload(shop: { name: string; address: string; timezone: string; opens: number; closes: number; closed_days: string; week_json?: string; deposit_pence: number; cancel_hours: number; no_show_grace: number; till_access?: string; version: number }, overrides: Record<string, unknown> = {}) {
  let week: { enabled: 0 | 1; starts: number; ends: number }[] | null = null;
  try {
    const parsed = shop.week_json ? JSON.parse(shop.week_json) : null;
    if (Array.isArray(parsed) && parsed.length === 7) week = parsed;
  } catch {
    /* legacy */
  }
  if (!week) {
    const closed = new Set<number>(JSON.parse(shop.closed_days || "[]"));
    week = Array.from({ length: 7 }, (_, i) => ({ enabled: closed.has(i) ? 0 : 1, starts: shop.opens, ends: shop.closes }));
  }
  return {
    name: shop.name,
    address: shop.address,
    currency: (shop as { currency?: string }).currency || "GBP",
    timezone: shop.timezone,
    week,
    deposit_pence: shop.deposit_pence,
    cancel_hours: shop.cancel_hours,
    no_show_grace: shop.no_show_grace,
    till_access: shop.till_access ?? "OWNER",
    version: shop.version,
    ...overrides,
  };
}

// Customer accounts: booking online needs a signed-in member of the shop. `registerCustomer` creates
// one on an API context (cookie jar keeps the session); `signInCustomer` does the same for a browser page.
export const CUSTOMER_PASSWORD = "Fictional-test-pass-2026!";
let customerSeq = 0;
export function customerIdentity(name = "Test Customer") {
  const n = `${Date.now()}${customerSeq++}`.slice(-9);
  return { name, phone: `07${n}`, email: `cust-${n}@example.test`, password: CUSTOMER_PASSWORD };
}
export async function registerCustomer(ctx: APIRequestContext, slug: string, who: Partial<{ name: string; phone: string; email: string; password: string }> = {}) {
  // Fixed phones/emails from a caller may already exist from an earlier run (accounts are global by
  // phone): try to log in with our password; if that fails, fall back to a fresh unique identity.
  let id = { ...customerIdentity(), ...who };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await ctx.post(`${origin}/api/public/shops/${slug}/account/register`, { headers: { Origin: origin }, data: id });
    if (r.status() === 201) return id;
    if (r.status() === 409) {
      const l = await ctx.post(`${origin}/api/public/shops/${slug}/account/login`, { headers: { Origin: origin }, data: { email: id.email, password: id.password } });
      if (l.status() === 201) return id;
    }
    if (attempt === 1) expect(r.status(), await r.text()).toBe(201);
    id = { ...customerIdentity(who.name), password: who.password || CUSTOMER_PASSWORD };
  }
  return id;
}
// Browser sign-in: the page must be on the shop's host first (locally that is <slug>.localhost after
// the 301 from /<slug>), because the session cookie belongs to that host. Registers via fetch from the page.
export async function signInCustomer(page: Page, slug: string, who: Partial<{ name: string; phone: string; email: string; password: string }> = {}) {
  const id = { ...customerIdentity(who.name), ...who, password: who.password || CUSTOMER_PASSWORD };
  if (!/\/(book\/)?[a-z0-9-]/.test(new URL(page.url() === "about:blank" ? origin + "/" : page.url()).pathname) || !page.url().includes(slug)) await page.goto(`/${slug}`, { waitUntil: "load" });
  const status = await page.evaluate(async ({ slug, id }) => {
    const post = (path: string, body: unknown) => fetch(`/api/public/shops/${slug}/account/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) }).then((r) => r.status);
    const r = await post("register", id);
    if (r === 201) return 201;
    if (r === 409) return post("login", { email: id.email, password: id.password });
    return r;
  }, { slug, id });
  expect(status).toBe(201);
  return id;
}
