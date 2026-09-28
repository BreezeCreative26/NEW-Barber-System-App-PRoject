// Commercial-grade auth audit: staff sign-in on the shop host, code sign-in gated on shop texts,
// code-only accounts complete their profile, and emails point account holders at their account.
import { test, expect, request } from "@playwright/test";
import type { WorkspaceData } from "../src/server/domain";
import { base, origin, newShop, PASSWORD } from "./shop";

const pub = origin + "/api/public";
const customer = () => request.newContext({ extraHTTPHeaders: { Origin: origin } });
async function onlineShop(sms: 0 | 1) {
  const { r, email } = await newShop("Auth Audit Shop");
  let w: WorkspaceData = await (await r.get(base + "/workspace")).json();
  const slug = `auth-${crypto.randomUUID().slice(0, 12)}`;
  expect((await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } })).status()).toBe(200);
  expect((await r.put(base + "/shop/messaging", { data: { msg_sms: sms, msg_email: 1, msg_reminders: 1, msg_reminder_hours: 24, msg_reply_to: "", msg_sms_sender: "" } })).status(), "messaging save").toBe(200);
  w = await (await r.get(base + "/workspace")).json();
  return { r, w, slug, ownerEmail: email };
}
const phone = () => `07700 ${String(100000 + Math.floor(Math.random() * 899999))}`;

test("code sign-in is refused (API) when the shop has texts off; offered when on", async () => {
  const off = await onlineShop(0);
  const c = await customer();
  const refused = await c.post(`${pub}/shops/${off.slug}/account/start`, { data: { phone: phone() } });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toBe("sms_off");
  // Public shop tells the client so the button never shows.
  expect((await (await c.get(`${pub}/shops/${off.slug}`)).json()).shop.channels.sms).toBe(false);
  const on = await onlineShop(1);
  const ok = await c.post(`${pub}/shops/${on.slug}/account/start`, { data: { phone: phone() } });
  expect(ok.status(), await ok.text()).toBe(201);
  await c.dispose();
});

test("code-only account must complete name/email/password; then signs in with the password", async () => {
  const { slug } = await onlineShop(1);
  const c = await customer();
  const P = phone();
  const st = await (await c.post(`${pub}/shops/${slug}/account/start`, { data: { phone: P } })).json();
  const v = await c.post(`${pub}/shops/${slug}/account/verify`, { data: { phone: P, code: st.sandbox_code } });
  expect(v.status()).toBe(201);
  const vj = await v.json();
  expect(vj.needs_profile).toBe(true);
  expect(vj.profile.complete).toBe(false);
  // Session probe also says incomplete.
  expect((await (await c.get(`${pub}/shops/${slug}/account/session`)).json()).profile.complete).toBe(false);
  // Complete it.
  const email = `code-${P.replace(/\D/g, "")}@example.test`;
  const bad = await c.post(`${pub}/shops/${slug}/account/complete`, { data: { name: "C", email, password: PASSWORD } });
  expect(bad.status()).toBe(400); // name too short
  const done = await c.post(`${pub}/shops/${slug}/account/complete`, { data: { name: "Code Customer", email, password: PASSWORD, marketing_opt_in: 1, contact_pref: "AUTO" } });
  expect(done.status(), await done.text()).toBe(200);
  const dj = await done.json();
  expect(dj.profile.complete).toBe(true);
  expect(dj.profile.marketing_opt_in).toBe(1);
  // Password sign-in now works from a fresh context.
  const c2 = await customer();
  const login = await c2.post(`${pub}/shops/${slug}/account/login`, { data: { email, password: PASSWORD } });
  expect(login.status(), await login.text()).toBe(201);
  await c.dispose(); await c2.dispose();
});

test("staff sign-in page is served at /staff and the customer sign-in links to it", async () => {
  const { slug } = await onlineShop(1);
  const c = await customer();
  const staff = await c.get(`${origin}/staff`);
  expect(staff.status()).toBe(200);
  expect(await staff.text()).toContain('name="foliyo-host"');
  // Customer sign-in on the shop host carries the staff link (host header = shop sub-domain).
  const me = await c.get(`${origin}/me`, { headers: { host: `${slug}.localhost:3000` }, maxRedirects: 0 });
  expect(me.status()).toBe(200);
  expect(await me.text()).toContain('name="foliyo-shop"');
  await c.dispose();
});

test("booking confirmation email links account holders to /me?visit=…, never a manage token", async () => {
  const { r, w, slug } = await onlineShop(1);
  const c = await customer();
  const P = phone();
  const email = `acct-${P.replace(/\D/g, "")}@example.test`;
  expect((await c.post(`${pub}/shops/${slug}/account/register`, { data: { name: "Account Holder", phone: P, email, password: PASSWORD } })).status()).toBe(201);
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 8); if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  const date = d.toISOString().slice(0, 10);
  const staff = w.staff[0].id, service = w.services[0].id;
  const avail = await (await c.get(`${pub}/shops/${slug}/availability?date=${date}&staff_id=${staff}&service_id=${service}`)).json();
  const free = avail.slots.find((x: { reason?: string }) => !x.reason);
  const b = await c.post(`${pub}/shops/${slug}/bookings`, { data: { request_id: crypto.randomUUID(), staff_id: staff, service_id: service, customer_name: "Account Holder", phone: P, email, date, start_min: free.start_min, quote: avail.quote } });
  expect(b.status(), await b.text()).toBe(201);
  const bj = await b.json();
  const ob = await (await r.get(base + "/notifications")).json();
  const rows = ob.notifications.filter((n: { template: string; related_id: string }) => n.template === "booking_confirmed" && n.related_id === bj.booking.id);
  expect(rows.length, "confirmation queued").toBeGreaterThan(0);
  // The SMS body carries the same link the email CTA uses.
  const sms = rows.find((n: { channel: string }) => n.channel === "SMS") || rows[0];
  expect(sms.body).toContain(`/me?visit=${bj.booking.id}`);
  for (const n of rows) expect(n.body).not.toContain("/manage/");
  await c.dispose();
});
