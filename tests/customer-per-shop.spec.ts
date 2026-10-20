// Customer accounts belong to ONE shop. The same person at two shops has two separate accounts:
// their own password, their own session, their own visits. Nothing a customer does at one shop
// can sign them in to, change, reveal or delete anything at another.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { base, newShop, origin } from "./shop";

const pub = origin + "/api/public";
const A = (slug: string) => `${pub}/shops/${slug}/account`;
const phoneFor = () => `07700${String(Math.floor(100000 + Math.random() * 899999))}`;
function futureDate(days = 8) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function twoShops() {
  const out = [];
  for (const name of ["Per Shop One", "Per Shop Two"]) {
    const { r } = await newShop(name);
    const w = await (await r.get(base + "/workspace")).json();
    const slug = `ps-${crypto.randomUUID().slice(0, 8)}`;
    expect((await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } })).status()).toBe(200);
    out.push({ r, w: await (await r.get(base + "/workspace")).json(), slug });
  }
  return out as [(typeof out)[number], (typeof out)[number]];
}
const customer = () => request.newContext({ extraHTTPHeaders: { Origin: origin } });
const who = () => ({ name: "Sam Shared", phone: phoneFor(), email: `shared-${crypto.randomUUID().slice(0, 8)}@example.test` });
async function register(c: APIRequestContext, slug: string, p: { name: string; phone: string; email: string }, password: string) {
  const res = await c.post(`${A(slug)}/register`, { data: { ...p, password } });
  expect(res.status(), await res.text()).toBe(201);
  return res;
}

test("the same mobile and email can register at two shops: two accounts, each with its own password", async () => {
  const [one, two] = await twoShops();
  const p = who();
  const c1 = await customer(), c2 = await customer();
  await register(c1, one.slug, p, "Shop-one-pass-1");
  // Before this change the second shop refused with "already an account" (accounts were global).
  await register(c2, two.slug, p, "Shop-two-pass-2");
  const m1 = await (await c1.get(`${A(one.slug)}/me`)).json();
  const m2 = await (await c2.get(`${A(two.slug)}/me`)).json();
  expect(m1.shop.slug).toBe(one.slug);
  expect(m2.shop.slug).toBe(two.slug);

  // Each password works only at its own shop.
  const fresh = await customer();
  expect((await fresh.post(`${A(two.slug)}/login`, { data: { email: p.email, password: "Shop-one-pass-1" } })).status()).toBe(401);
  expect((await fresh.post(`${A(one.slug)}/login`, { data: { email: p.email, password: "Shop-two-pass-2" } })).status()).toBe(401);
  expect((await fresh.post(`${A(one.slug)}/login`, { data: { email: p.email, password: "Shop-one-pass-1" } })).status()).toBe(201);
  expect((await fresh.post(`${A(two.slug)}/login`, { data: { email: p.email, password: "Shop-two-pass-2" } })).status()).toBe(201);
});

test("a session is private to its shop: signed in at one shop means signed out at the other, even in the same browser", async () => {
  const [one, two] = await twoShops();
  const p = who();
  const c = await customer();
  await register(c, one.slug, p, "Shop-one-pass-1");
  expect((await c.get(`${A(one.slug)}/me`)).status()).toBe(200);
  // Same browser (same cookie jar), other shop: not signed in, cannot read, cannot book.
  expect((await c.get(`${A(two.slug)}/me`)).status()).toBe(401);
  expect(((await (await c.get(`${A(two.slug)}/session`)).json()) as { profile: unknown }).profile).toBeNull();
  const staff = two.w.staff[0].id, service = two.w.services[0].id, date = futureDate();
  const avail = await (await c.get(`${pub}/shops/${two.slug}/availability?date=${date}&staff_id=${staff}&service_id=${service}`)).json();
  const book = await c.post(`${pub}/shops/${two.slug}/bookings`, { data: { request_id: crypto.randomUUID(), staff_id: staff, service_id: service, customer_name: p.name, phone: p.phone, email: p.email, date, start_min: 600, quote: avail.quote } });
  expect(book.status()).toBe(401);
});

test("the sign-in cookie is host-only and named for its shop; the old shared cookie is never trusted", async () => {
  const [one, two] = await twoShops();
  const c = await customer();
  const res = await register(c, one.slug, who(), "Shop-one-pass-1");
  const setCookie = res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
  const mine = setCookie.find((v) => v.startsWith("__Host-fc-"));
  expect(mine, setCookie.join(" | ")).toBeTruthy();
  expect(mine).not.toMatch(/domain=/i); // never shared across foliyo.co.uk
  expect(mine).toMatch(/HttpOnly/i);
  expect(mine).toMatch(/Secure/i);
  // Two shops, two different cookie names.
  const c2 = await customer();
  const res2 = await register(c2, two.slug, who(), "Shop-two-pass-2");
  const name = (h: string) => h.split("=")[0];
  const mine2 = res2.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value).find((v) => v.startsWith("__Host-fc-"))!;
  expect(name(mine2)).not.toBe(name(mine!));
  // A valid session token presented under the OLD shared cookie name does nothing.
  const token = (await c.storageState()).cookies.find((k) => k.name.startsWith("__Host-fc-"))!.value;
  const legacy = await request.newContext({ extraHTTPHeaders: { Origin: origin, Cookie: `ollo_customer=${token}` } });
  expect((await legacy.get(`${A(one.slug)}/me`)).status()).toBe(401);
  // And presenting shop one's token under shop two's cookie name does nothing either.
  const cross = await request.newContext({ extraHTTPHeaders: { Origin: origin, Cookie: `${name(mine2)}=${token}` } });
  expect((await cross.get(`${A(two.slug)}/me`)).status()).toBe(401);
});

test("a password reset link only works at the shop that sent it", async () => {
  const [one, two] = await twoShops();
  const p = who();
  await register(await customer(), one.slug, p, "Shop-one-pass-1");
  await register(await customer(), two.slug, p, "Shop-two-pass-2");
  const c = await customer();
  const forgot = await (await c.post(`${A(one.slug)}/forgot`, { data: { email: p.email } })).json();
  test.skip(!forgot.sandbox_token, "live email provider: the reset token is not returned");
  // Shop two refuses shop one's link.
  expect((await c.post(`${A(two.slug)}/reset`, { data: { token: forgot.sandbox_token, password: "Hijack-pass-99" } })).status()).toBe(409);
  const check = await customer();
  expect((await check.post(`${A(two.slug)}/login`, { data: { email: p.email, password: "Hijack-pass-99" } })).status()).toBe(401);
  expect((await check.post(`${A(two.slug)}/login`, { data: { email: p.email, password: "Shop-two-pass-2" } })).status()).toBe(201);
  // Shop one accepts it.
  expect((await c.post(`${A(one.slug)}/reset`, { data: { token: forgot.sandbox_token, password: "Shop-one-pass-NEW" } })).status()).toBe(201);
});

test("changing a password or deleting the account at one shop leaves the other shop's account alone", async () => {
  const [one, two] = await twoShops();
  const p = who();
  const c1 = await customer(), c2 = await customer();
  await register(c1, one.slug, p, "Shop-one-pass-1");
  await register(c2, two.slug, p, "Shop-two-pass-2");
  expect((await c1.put(`${A(one.slug)}/password`, { data: { current: "Shop-one-pass-1", password: "Shop-one-pass-NEW" } })).status()).toBe(200);
  expect((await (await customer()).post(`${A(two.slug)}/login`, { data: { email: p.email, password: "Shop-two-pass-2" } })).status()).toBe(201);
  // Delete at shop one.
  expect((await c1.post(`${A(one.slug)}/delete`, { data: { confirm: "DELETE" } })).status()).toBe(200);
  expect((await c1.get(`${A(one.slug)}/me`)).status()).toBe(401);
  expect((await (await customer()).post(`${A(one.slug)}/login`, { data: { email: p.email, password: "Shop-one-pass-NEW" } })).status()).toBe(401);
  // Shop two still has the account, still signed in, still works.
  expect((await c2.get(`${A(two.slug)}/me`)).status()).toBe(200);
  expect((await (await customer()).post(`${A(two.slug)}/login`, { data: { email: p.email, password: "Shop-two-pass-2" } })).status()).toBe(201);
});

test("sign out only ends this shop's session", async () => {
  const [one, two] = await twoShops();
  const p = who();
  const c = await customer();
  await register(c, one.slug, p, "Shop-one-pass-1");
  await register(c, two.slug, p, "Shop-two-pass-2"); // same browser holds both shops' sessions
  expect((await c.get(`${A(one.slug)}/me`)).status()).toBe(200);
  expect((await c.get(`${A(two.slug)}/me`)).status()).toBe(200);
  expect((await c.post(`${A(one.slug)}/logout`, { data: {} })).status()).toBe(200);
  expect((await c.get(`${A(one.slug)}/me`)).status()).toBe(401);
  expect((await c.get(`${A(two.slug)}/me`)).status()).toBe(200);
});

test("the shop's own customer list only shows its own online accounts", async () => {
  const [one, two] = await twoShops();
  const p = who();
  await register(await customer(), one.slug, p, "Shop-one-pass-1");
  const dir1 = await (await one.r.get(base + `/customers?q=${p.phone.replace(/\D/g, "")}`)).json();
  const dir2 = await (await two.r.get(base + `/customers?q=${p.phone.replace(/\D/g, "")}`)).json();
  expect(dir1.customers.length).toBe(1);
  expect(dir2.customers.length).toBe(0); // shop two has never heard of this person
});
