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
    data: { shop_name: name, name: "Zed Owner", email: address, password: PASSWORD },
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
    data: { shop_name: name, name: "Zed Owner", email: email(), password: PASSWORD },
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
