// Customer accounts v2: email + password sign-in, registration, reset links, booking-creates-account,
// per-shop PWA manifest and icons, push subscription endpoints.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { base, newShop, origin } from "./shop";

const pub = origin + "/api/public";
const slugFor = () => `auth-${crypto.randomUUID().slice(0, 8)}`;
const phoneFor = () => `07700${String(Math.floor(100000 + Math.random() * 899999))}`;
const emailFor = () => `c-${crypto.randomUUID().slice(0, 8)}@example.test`;
function futureDate(days = 8) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function shop() {
  const { r } = await newShop("Auth Test Shop");
  const w = await (await r.get(base + "/workspace")).json();
  const slug = slugFor();
  expect((await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } })).status()).toBe(200);
  return { r, w: await (await r.get(base + "/workspace")).json(), slug };
}
const customer = () => request.newContext({ extraHTTPHeaders: { Origin: origin } });
const A = (slug: string) => `${pub}/shops/${slug}/account`;

test("register → session → /me; login with email+password; wrong password rejected; duplicate blocked", async () => {
  const { slug } = await shop();
  const c = await customer();
  const email = emailFor(), phone = phoneFor();
  // Weak password rejected
  expect((await c.post(`${A(slug)}/register`, { data: { name: "Ria Patel", phone, email, password: "password" } })).status()).toBe(400);
  const reg = await c.post(`${A(slug)}/register`, { data: { name: "Ria Patel", phone, email, password: "correct-horse-7" } });
  expect(reg.status(), await reg.text()).toBe(201);
  const me = await (await c.get(`${A(slug)}/me`)).json();
  expect(me.profile.name).toBe("Ria Patel");
  expect(me.profile.has_password).toBe(true);
  expect(me.profile.account_email).toBe(email);
  // Second registration on the same mobile is refused
  expect((await c.post(`${A(slug)}/register`, { data: { name: "Ria Again", phone, email: emailFor(), password: "another-pass-9" } })).status()).toBe(409);
  // Same email on a different mobile is refused
  expect((await c.post(`${A(slug)}/register`, { data: { name: "Someone", phone: phoneFor(), email, password: "another-pass-9" } })).status()).toBe(409);
  // Fresh browser: login
  const c2 = await customer();
  expect((await c2.get(`${A(slug)}/me`)).status()).toBe(401);
  expect((await c2.post(`${A(slug)}/login`, { data: { email, password: "wrong-wrong-1" } })).status()).toBe(401);
  expect((await c2.post(`${A(slug)}/login`, { data: { email: email.toUpperCase(), password: "correct-horse-7" } })).status()).toBe(201);
  expect((await (await c2.get(`${A(slug)}/me`)).json()).profile.name).toBe("Ria Patel");
  // Change password requires the current one
  expect((await c2.put(`${A(slug)}/password`, { data: { current: "nope-nope-1", password: "new-pass-word-8" } })).status()).toBe(401);
  expect((await c2.put(`${A(slug)}/password`, { data: { current: "correct-horse-7", password: "new-pass-word-8" } })).status()).toBe(200);
  const c3 = await customer();
  expect((await c3.post(`${A(slug)}/login`, { data: { email, password: "new-pass-word-8" } })).status()).toBe(201);
});

test("forgot → reset link (sandbox token) → new password signs in and signs other devices out; token single-use", async () => {
  const { slug } = await shop();
  const c = await customer();
  const email = emailFor(), phone = phoneFor();
  expect((await c.post(`${A(slug)}/register`, { data: { name: "Tom Reid", phone, email, password: "first-pass-word" } })).status()).toBe(201);
  // Unknown email: same shape, no token
  const unknown = await (await c.post(`${A(slug)}/forgot`, { data: { email: emailFor() } })).json();
  expect(unknown.ok).toBe(true);
  expect(unknown.sandbox_token).toBeUndefined();
  const f = await (await c.post(`${A(slug)}/forgot`, { data: { email } })).json();
  expect(f.sandbox_token).toBeTruthy();
  const c2 = await customer();
  const reset = await c2.post(`${A(slug)}/reset`, { data: { token: f.sandbox_token, password: "second-pass-word" } });
  expect(reset.status(), await reset.text()).toBe(201);
  expect((await (await c2.get(`${A(slug)}/me`)).json()).profile.name).toBe("Tom Reid");
  // Original session is gone
  expect((await c.get(`${A(slug)}/me`)).status()).toBe(401);
  // Token cannot be reused
  expect((await customer().then((x) => x.post(`${A(slug)}/reset`, { data: { token: f.sandbox_token, password: "third-pass-word" } }))).status()).toBe(409);
  // Old password no longer works, new one does
  const c3 = await customer();
  expect((await c3.post(`${A(slug)}/login`, { data: { email, password: "first-pass-word" } })).status()).toBe(401);
  expect((await c3.post(`${A(slug)}/login`, { data: { email, password: "second-pass-word" } })).status()).toBe(201);
});

test("booking requires email; creates the account, signs the browser in, and sends a welcome link when no password was chosen", async () => {
  const { r, w, slug } = await shop();
  const c = await customer();
  const date = futureDate();
  const staff = w.staff[0].id, service = w.services[0].id;
  const avail = await (await c.get(`${pub}/shops/${slug}/availability?date=${date}&staff_id=${staff}&service_id=${service}`)).json();
  const phone = phoneFor(), email = emailFor();
  const body = { request_id: crypto.randomUUID(), staff_id: staff, service_id: service, customer_name: "Noor Ali", phone, date, start_min: 600, quote: avail.quote };
  // No email → 400
  expect((await c.post(`${pub}/shops/${slug}/bookings`, { data: { ...body, email: "" } })).status()).toBe(400);
  // With email, no password → booking + account + welcome
  const res = await c.post(`${pub}/shops/${slug}/bookings`, { data: { ...body, email } });
  expect(res.status(), await res.text()).toBe(201);
  const j = await res.json();
  expect(j.account).toMatchObject({ created: true, has_password: false, email });
  // Browser is signed in for this shop
  const me = await (await c.get(`${A(slug)}/me`)).json();
  expect(me.profile.name).toBe("Noor Ali");
  expect(me.profile.has_password).toBe(false);
  expect(me.upcoming).toHaveLength(1);
  // Welcome message queued for the account (email channel)
  const msgs = await (await r.get(base + "/notifications?limit=50")).json();
  const welcome = (msgs.notifications ?? msgs.results ?? []).find((m: { template: string; recipient: string }) => m.template === "account_welcome" && m.recipient === email);
  expect(welcome, JSON.stringify(msgs).slice(0, 300)).toBeTruthy();
  // The signed-in customer can set a password without a current one
  expect((await c.put(`${A(slug)}/password`, { data: { current: "", password: "chosen-later-9" } })).status()).toBe(200);
  const c2 = await customer();
  expect((await c2.post(`${A(slug)}/login`, { data: { email, password: "chosen-later-9" } })).status()).toBe(201);
});

test("booking with a password in the same step creates a ready account", async () => {
  const { w, slug } = await shop();
  const c = await customer();
  const date = futureDate(9);
  const staff = w.staff[0].id, service = w.services[0].id;
  const avail = await (await c.get(`${pub}/shops/${slug}/availability?date=${date}&staff_id=${staff}&service_id=${service}`)).json();
  const phone = phoneFor(), email = emailFor();
  const res = await c.post(`${pub}/shops/${slug}/bookings`, { data: { request_id: crypto.randomUUID(), staff_id: staff, service_id: service, customer_name: "Jess Kim", phone, email, date, start_min: 660, quote: avail.quote, password: "my-shop-pass-1" } });
  expect(res.status(), await res.text()).toBe(201);
  expect((await res.json()).account).toMatchObject({ created: true, has_password: true });
  const c2 = await customer();
  expect((await c2.post(`${A(slug)}/login`, { data: { email, password: "my-shop-pass-1" } })).status()).toBe(201);
  // Weak password in the booking step is rejected before the booking is made
  const bad = await c.post(`${pub}/shops/${slug}/bookings`, { data: { request_id: crypto.randomUUID(), staff_id: staff, service_id: service, customer_name: "Weak", phone: phoneFor(), email: emailFor(), date, start_min: 720, quote: avail.quote, password: "short" } });
  expect(bad.status()).toBe(400);
});

test("per-shop web app: manifest carries the shop's name/colours/start_url; icons render; sw.js served", async () => {
  const { r, slug } = await shop();
  const pg = await (await r.get(base + "/shop/page")).json();
  await r.put(base + "/shop/page", { data: { strapline: "", about: "", cover_url: "", logo_url: "", gallery: [], phone: "", email: "", instagram: "", map_url: "", google_review_url: "", transport_note: "", policy_text: "", sections: JSON.parse(pg.page.sections_json || "[]"), accent: "plum", theme: { ...JSON.parse(pg.page.theme_json || "{}"), mode: "dark" }, published: 1, version: pg.page.version } });
  const c = await customer();
  const m = await c.get(`${origin}/${slug}/manifest.webmanifest`);
  expect(m.status()).toBe(200);
  expect(m.headers()["content-type"]).toContain("manifest+json");
  const man = await m.json();
  expect(man.name).toBe("Auth Test Shop");
  expect(man.start_url).toBe(`/${slug}/me?source=pwa`);
  expect(man.scope).toBe(`/${slug}/`);
  expect(man.display).toBe("standalone");
  expect(man.theme_color).toBe("#0b0b0c");
  expect(man.icons.map((i: { sizes: string }) => i.sizes)).toEqual(["192x192", "512x512"]);
  for (const size of [192, 512]) {
    const icon = await c.get(`${origin}/${slug}/icon-${size}.png`);
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toBe("image/png");
    const bytes = await icon.body();
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  const sw = await c.get(`${origin}/sw.js`);
  expect(sw.status()).toBe(200);
  expect(await sw.text()).toContain("notificationclick");
  // Shop surfaces link the shop manifest, not the platform one
  const html = await (await c.get(`${origin}/${slug}/me`)).text();
  expect(html).toContain(`/${slug}/manifest.webmanifest`);
  expect(html).not.toContain("/site.webmanifest");
  // Unknown shop → 404
  expect((await c.get(`${origin}/no-such-shop-xyz/manifest.webmanifest`)).status()).toBe(404);
});

test("push: status reports keys; subscribe/unsubscribe need a session and are scoped to the shop", async () => {
  const { slug } = await shop();
  const c = await customer();
  const st = await (await c.get(`${A(slug)}/push`)).json();
  expect(typeof st.enabled).toBe("boolean");
  const sub = { endpoint: "https://push.example.test/sub/" + crypto.randomUUID(), keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } };
  expect((await c.post(`${A(slug)}/push`, { data: sub })).status()).toBe(401);
  expect((await c.post(`${A(slug)}/register`, { data: { name: "Push Person", phone: phoneFor(), email: emailFor(), password: "push-pass-word-1" } })).status()).toBe(201);
  expect((await c.post(`${A(slug)}/push`, { data: sub })).status()).toBe(201);
  expect((await (await c.get(`${A(slug)}/push?endpoint=${encodeURIComponent(sub.endpoint)}`)).json()).subscribed).toBe(true);
  expect((await c.delete(`${A(slug)}/push`, { data: { endpoint: sub.endpoint } })).status()).toBe(200);
  expect((await (await c.get(`${A(slug)}/push?endpoint=${encodeURIComponent(sub.endpoint)}`)).json()).subscribed).toBe(false);
});

test("browser: create account on /me, sign out, sign in with email + password, set new password from profile", async ({ page }) => {
  const { slug } = await shop();
  const email = emailFor(), phone = phoneFor();
  await page.goto(`/${slug}/me`);
  await expect(page.getByTestId("login-form")).toBeVisible();
  await page.getByTestId("signin-register").click();
  await page.getByTestId("register-name").fill("Browser Person");
  await page.getByTestId("register-phone").fill(phone);
  await page.getByTestId("register-email").fill(email);
  await page.getByTestId("signin-password").fill("browser-pass-1");
  await page.getByTestId("signin-password2").fill("browser-pass-1");
  await page.getByTestId("register-submit").click();
  await expect(page.getByTestId("customer-area")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Hello, Browser/ })).toBeVisible();
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("login-form")).toBeVisible();
  await page.getByTestId("signin-email").fill(email);
  await page.getByTestId("signin-password").fill("wrong-pass-1");
  await page.getByTestId("signin-submit").click();
  await expect(page.getByRole("alert")).toContainText("not right");
  await page.getByTestId("signin-password").fill("browser-pass-1");
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("customer-area")).toBeVisible();
  // Profile → change password
  await page.getByTestId("tab-profile").click();
  await page.getByTestId("pw-current").fill("browser-pass-1");
  await page.getByTestId("pw-new").fill("browser-pass-2");
  await page.getByTestId("pw-new2").fill("browser-pass-2");
  await page.getByTestId("pw-save").click();
  await expect(page.getByRole("status")).toContainText("Password changed");
  // Text-code fallback still works
  await page.getByTestId("sign-out").click();
  await page.getByTestId("signin-use-code").click();
  await page.getByTestId("signin-phone").fill(phone);
  await page.getByTestId("signin-send").click();
  const code = await page.getByTestId("shown-code").textContent();
  await page.getByTestId("signin-code").fill(code!.trim());
  await page.getByTestId("signin-verify").click();
  await expect(page.getByTestId("customer-area")).toBeVisible();
});
