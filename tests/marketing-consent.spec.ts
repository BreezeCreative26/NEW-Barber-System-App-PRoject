// Strict marketing consent. A shop can tell its customers about its move to the new system, but:
//   * only people who have not opted out are ever included;
//   * a customer with an app account decides for themselves, in the app, at any time;
//   * "no" (app untick, unsubscribe link, STOP reply, staff untick) sticks: staff ticks and CSV re-imports
//     can never turn it back on, and a queued message is dropped at send time;
//   * every change is logged.
import { test, expect, request } from "@playwright/test";
import { execSync } from "node:child_process";
import { base, origin, newShop, customerIdentity } from "./shop";

const psql = (q: string) => execSync(`psql -h /tmp/pg -p 5433 -U postgres foliyo -Atc "${q}"`).toString().trim();

async function shopWithPage(name: string) {
  const s = await newShop(name);
  const w = await (await s.r.get(base + "/workspace")).json();
  const slug = `cns-${crypto.randomUUID().slice(0, 10)}`;
  expect((await s.r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } })).status()).toBe(200);
  return { ...s, slug };
}
const audience = async (r: Awaited<ReturnType<typeof newShop>>["r"]) =>
  (await (await r.post(base + "/announcements/preview", { data: { channel: "EMAIL", audience: "ALL" } })).json()) as { email: number; held_back: number };

test("app customer opts in and out at any time; the shop's announcement follows it", async () => {
  const { r, shop_id, slug } = await shopWithPage("Consent Cuts");
  const me = customerIdentity("Olly Old");
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const reg = await c.post(`${origin}/api/public/shops/${slug}/account/register`, { data: { ...me, password: "Fictional-test-pass-2026!", marketing_opt_in: 1 } });
  expect(reg.status(), await reg.text()).toBe(201);
  expect((await audience(r)).email).toBe(1);

  const prof = async () => (await (await c.get(`${origin}/api/public/shops/${slug}/account/me`)).json()).profile;
  let p = await prof();
  expect(p.marketing_opt_in).toBe(1);
  const put = (opt: 0 | 1) => c.put(`${origin}/api/public/shops/${slug}/account/profile`, { data: { name: p.name, email: p.email, birthday: "", preferred_staff_id: "", marketing_opt_in: opt, notes: "", version: p.version } });

  // Opt out in the app: out of every audience straight away.
  expect((await put(0)).status()).toBe(200);
  p = await prof();
  expect(p.marketing_opt_in).toBe(0);
  const out = await audience(r);
  expect(out.email).toBe(0);
  expect(out.held_back).toBe(1);

  // Staff cannot tick them back in, and a CSV re-import cannot either.
  const cust = psql(`select id from customers where shop_id='${shop_id}'`);
  const list = await (await r.get(base + "/customers")).json();
  const row = list.customers.find((x: { id: string }) => x.id === cust);
  expect(row.marketing_opt_in).toBe(0);
  const tick = await r.put(base + `/customers/${cust}`, { data: { name: row.name, phone: row.phone, email: row.email, notes: "", tags: [], birthday: "", preferred_staff_id: "", marketing_opt_in: 1, version: row.version } });
  expect(tick.status()).toBe(409);
  await r.post(base + "/customers/import", { data: { csv: `Name,Phone,Email,Marketing\nOlly Old,${me.phone},${me.email},yes\n` } });
  expect((await audience(r)).email).toBe(0);

  // Opt back in themselves: included again.
  p = await prof();
  expect((await put(1)).status()).toBe(200);
  expect((await audience(r)).email).toBe(1);

  // Proof trail: IN (sign-up), OUT, IN.
  expect(psql(`select string_agg(choice||':'||source, ',' order by at, id) from marketing_consent_log where shop_id='${shop_id}'`)).toBe("IN:app_signup,OUT:app_profile,IN:app_profile");
});

test("an unsubscribe link or STOP reply is final; a queued announcement is dropped at send time", async () => {
  const { r, shop_id, slug } = await shopWithPage("Final Cuts");
  const csv = "Name,Phone,Email\nDan Smith,07700 900123,dan@cust.test\nSam Cole,07700 900789,sam@cust.test\n";
  expect((await r.post(base + "/customers/import", { data: { csv } })).status()).toBe(201);
  expect((await audience(r)).email).toBe(2);

  // Queue a scheduled announcement for both, then Dan uses his unsubscribe link before it goes out.
  const sent = await r.post(base + "/announcements/send", { data: { kind: "custom", channel: "EMAIL", audience: "ALL", subject: "We are moving", body: "Hello from {shop}. We have a new system.", send_at: Date.now() + 3600000, confirm: true } });
  expect(sent.status(), await sent.text()).toBe(200);
  const tok = psql(`select unsub_token from customers where shop_id='${shop_id}' and email='dan@cust.test'`);
  const post = await r.post(`${origin}/u/c/${tok}`, { headers: { Host: `${slug}.localhost:3000` } });
  expect(await post.text()).toContain("You are unsubscribed");
  // Sam texts STOP to the shop's number: that ends marketing on every channel, not just texts.
  const stop = await r.post(origin + "/api/telnyx/webhook", { data: { data: { event_type: "message.received", payload: { direction: "inbound", id: crypto.randomUUID(), from: { phone_number: "+447700900789" }, text: "STOP" } } } });
  expect(stop.status(), await stop.text()).toBe(200);
  expect((await audience(r)).email).toBe(0);
  // Texting START later lets booking texts through again, but never turns marketing back on.
  await r.post(origin + "/api/telnyx/webhook", { data: { data: { event_type: "message.received", payload: { direction: "inbound", id: crypto.randomUUID(), from: { phone_number: "+447700900789" }, text: "START" } } } });
  expect((await audience(r)).email).toBe(0);

  // A CSV re-import marked "yes" does not bring Dan or Sam back.
  await r.post(base + "/customers/import", { data: { csv: "Name,Phone,Email,Marketing\nDan Smith,07700 900123,dan@cust.test,yes\n" } });
  const dan = psql(`select id from customers where shop_id='${shop_id}' and email='dan@cust.test'`);
  expect((await audience(r)).email).toBe(0);

  // Release the queued messages and drain: Dan's is skipped, not sent.
  psql(`update notifications set next_attempt_at=1 where shop_id='${shop_id}' and template='shop_announcement' and status='QUEUED'`);
  await r.get(origin + "/api/cron/messages", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  const rows = psql(`select recipient||'|'||status from notifications where shop_id='${shop_id}' and template='shop_announcement' order by recipient`);
  expect(rows).toContain("dan@cust.test|SKIPPED");
  expect(rows).toContain("sam@cust.test|SKIPPED");
  expect(psql(`select status_note from notifications where shop_id='${shop_id}' and recipient='dan@cust.test' and template='shop_announcement'`)).toContain("opted out of marketing");
  expect(psql(`select choice||':'||source from marketing_consent_log where shop_id='${shop_id}' and customer_id='${dan}'`)).toBe("OUT:email_link");
});
