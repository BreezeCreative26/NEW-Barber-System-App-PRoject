// A shop telling its own customers about its new booking page: shop-branded, no foliyo mark,
// strict channels, opt-outs honoured, texts billed only after the owner acknowledges the price.
import { test, expect } from "@playwright/test";
import { base, origin, newShop } from "./shop";
import * as cp from "node:child_process";

const psql = (q: string) => cp.execSync(`psql -h /tmp/pg -p 5433 -U postgres foliyo -Atc "${q}"`).toString().trim();

test("shop announcement: shop-branded email, mobiles only for texts, opt-out sticks, price acknowledged", async () => {
  const { r, shop_id } = await newShop("Northline Cuts");
  let w = await (await r.get(base + "/workspace")).json();
  const slug = `ann-${crypto.randomUUID().slice(0, 10)}`;
  expect((await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } })).status()).toBe(200);

  const csv = "Name,Phone,Email\nDan Smith,07700 900123,dan@cust.test\nSam Cole,07700 900789,sam@cust.test\nPat Lee,07700 900456,\nNo Details,,\n";
  const imp = await r.post(base + "/customers/import", { data: { csv, mapping: undefined } });
  expect(imp.status(), await imp.text()).toBe(201);

  const prev = await (await r.post(base + "/announcements/preview", { data: { channel: "BOTH" } })).json();
  expect(prev.email).toBe(2);
  expect(prev.sms).toBe(3);
  expect(prev.cost_pence).toBe(24);
  expect(prev.sms_text).toContain("Reply STOP");
  expect(prev.email_html).toContain("Northline Cuts");
  expect(prev.email_html.toLowerCase()).not.toContain("foliyo");
  expect(prev.email_html).toContain("/u/c/");
  expect(prev.email_html.toLowerCase()).toContain("stop these emails");

  expect((await r.post(base + "/announcements/send", { data: { channel: "BOTH" } })).status()).toBe(400);
  const noAck = await r.post(base + "/announcements/send", { data: { channel: "BOTH", confirm: true } });
  expect(noAck.status()).toBe(409);
  const sent = await r.post(base + "/announcements/send", { data: { channel: "EMAIL", confirm: true } });
  expect(sent.status(), await sent.text()).toBe(200);
  const rows = psql(`select channel||'|'||recipient||'|'||status from notifications where shop_id='${shop_id}' and template='shop_announcement' order by recipient`);
  expect(rows).toContain("EMAIL|dan@cust.test");
  expect(rows).not.toContain("SMS");
  const html = psql(`select body from notifications where shop_id='${shop_id}' and template='shop_announcement' and recipient='dan@cust.test'`);
  expect(html.toLowerCase()).not.toContain("foliyo");

  // Unsubscribe link works and removes that customer from the next send.
  const tok = psql(`select unsub_token from customers where shop_id='${shop_id}' and email='dan@cust.test'`);
  expect(tok.length).toBeGreaterThan(20);
  const shopOrigin = origin; const hostH = { Host: `${slug}.localhost:3000` };
  const page = await (await r.get(`${shopOrigin}/u/c/${tok}`, { headers: hostH })).text();
  expect(page).toContain("Unsubscribe me");
  expect(await (await r.post(`${shopOrigin}/u/c/${tok}`, { headers: hostH })).text()).toContain("You are unsubscribed");
  const after = await (await r.post(base + "/announcements/preview", { data: { channel: "EMAIL" } })).json();
  expect(after.email).toBe(1);

  const ack = await r.post(base + "/announcements/send", { data: { channel: "SMS", confirm: true, sms_ack: true } });
  expect(ack.status(), await ack.text()).toBe(200);
  const smsRows = psql(`select count(*) from notifications where shop_id='${shop_id}' and template='shop_announcement' and channel='SMS'`);
  expect(Number(smsRows)).toBe(2); // Dan opted out of everything from this shop
  const list = await (await r.get(base + "/announcements")).json();
  expect(list.campaigns.length).toBe(2);
});
