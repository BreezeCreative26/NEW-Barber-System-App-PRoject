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

test("campaign types: placeholders block sending, win-back picks lapsed customers, scheduled sends wait and can be stopped", async () => {
  const { r, shop_id } = await newShop("Kind Cuts");
  const w = await (await r.get(base + "/workspace")).json();
  const slug = `kind-${crypto.randomUUID().slice(0, 10)}`;
  expect((await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } })).status()).toBe(200);
  const csv = "Name,Phone,Email\nOld Customer,07700 900111,old@c.test\nRecent Customer,07700 900222,recent@c.test\nNever Came,07700 900333,never@c.test\n";
  expect((await r.post(base + "/customers/import", { data: { csv } })).status()).toBe(201);
  const day = 86400000;
  const w2 = await (await r.get(base + "/workspace")).json();
  const service = w2.services[0];
  const d0 = new Date(); d0.setUTCDate(d0.getUTCDate() + 8); if (d0.getUTCDay() === 0) d0.setUTCDate(d0.getUTCDate() + 1);
  let slot = 540;
  const mk = async (email: string, phone: string, daysAgo: number) => {
    const res = await r.post(base + "/bookings", { data: { request_id: crypto.randomUUID(), staff_id: w2.staff[0].id, service_id: service.id, date: d0.toISOString().slice(0, 10), start_min: (slot += 60), customer_name: "Test Person", phone, source: "TEST_BOOKING", quote: { service_version: service.version, shop_version: w2.shop.version } } });
    expect(res.status(), await res.text()).toBe(201);
    const id = (await res.json()).booking.id as string;
    const cid = psql(`select id from customers where shop_id='${shop_id}' and email='${email}'`);
    const start = Date.now() - daysAgo * day;
    psql(`set session_replication_role=replica; update bookings set customer_id='${cid}', status='COMPLETED', start_at=${start}, end_at=${start + 1800000}, date='${new Date(start).toISOString().slice(0, 10)}' where id='${id}'`);
  };
  await mk("old@c.test", "07700900111", 120);
  await mk("recent@c.test", "07700900222", 10);

  const presets = (await (await r.get(base + "/announcements")).json()).presets;
  expect(presets.map((p: { kind: string }) => p.kind)).toEqual(["launch", "offer", "quiet", "winback", "hours", "service", "custom"]);

  const lapsed = await (await r.post(base + "/announcements/preview", { data: { kind: "winback", channel: "EMAIL", audience: "LAPSED" } })).json();
  expect(lapsed.email).toBe(1);
  const recent = await (await r.post(base + "/announcements/preview", { data: { kind: "quiet", channel: "EMAIL", audience: "RECENT" } })).json();
  expect(recent.email).toBe(1);
  const all = await (await r.post(base + "/announcements/preview", { data: { kind: "launch", channel: "EMAIL", audience: "ALL" } })).json();
  expect(all.email).toBe(3);

  // The offer starter text still has [brackets]: it cannot be sent until they are filled in.
  const offer = presets.find((p: { kind: string }) => p.kind === "offer").copy;
  const pv = await (await r.post(base + "/announcements/preview", { data: { kind: "offer", channel: "EMAIL", audience: "ALL", ...offer } })).json();
  expect(pv.problems.join(" ")).toContain("[bracketed]");
  const blocked = await r.post(base + "/announcements/send", { data: { kind: "offer", channel: "EMAIL", audience: "ALL", ...offer, confirm: true } });
  expect(blocked.status()).toBe(400);
  // A custom campaign needs words of its own.
  const empty = await r.post(base + "/announcements/send", { data: { kind: "custom", channel: "EMAIL", audience: "ALL", confirm: true } });
  expect(empty.status()).toBe(400);

  // Scheduled: queued for later, not sent now, and can be stopped.
  const later = Date.now() + 2 * day;
  const sent = await r.post(base + "/announcements/send", { data: { kind: "custom", channel: "EMAIL", audience: "ALL", subject: "Hello", body: "A note from {shop}.", send_at: later, confirm: true } });
  expect(sent.status(), await sent.text()).toBe(200);
  const q = psql(`select count(*) from notifications where shop_id='${shop_id}' and template='shop_announcement' and status='QUEUED'`);
  expect(Number(q)).toBe(3);
  const camp = (await (await r.get(base + "/announcements")).json()).campaigns[0];
  expect(camp.kind).toBe("custom");
  expect(camp.scheduled_for).toBeGreaterThan(Date.now());
  const stop = await (await r.post(base + `/announcements/${camp.id}/cancel`)).json();
  expect(stop.stopped).toBe(3);
  expect(Number(psql(`select count(*) from notifications where shop_id='${shop_id}' and template='shop_announcement' and status='QUEUED'`))).toBe(0);
  const past = await r.post(base + "/announcements/send", { data: { kind: "custom", channel: "EMAIL", audience: "ALL", subject: "Hi", body: "Hi", send_at: Date.now() + 90 * day, confirm: true } });
  expect(past.status()).toBe(400);
});

test("campaign CSV: uploaded people join one campaign, duplicates and opted-out people are left out, their unsubscribe link works", async () => {
  const { r, shop_id } = await newShop("List Cuts");
  const w = await (await r.get(base + "/workspace")).json();
  const slug = `lst-${crypto.randomUUID().slice(0, 10)}`;
  expect((await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } })).status()).toBe(200);
  await r.post(base + "/customers/import", { data: { csv: "Name,Phone,Email\nDan Smith,07700 900123,dan@cust.test\n" } });

  const csv = "Name,Mobile,Email\nDan Smith,07700 900123,dan@cust.test\nNew Person,07700 900555,new@list.test\nMail Only,,mail@list.test\nNo Details,,\n";
  const up = await (await r.post(base + "/announcements/contacts", { data: { csv } })).json();
  expect(up.added).toBe(3);
  const again = await (await r.post(base + "/announcements/contacts", { data: { csv } })).json();
  expect(again.ids.sort()).toEqual(up.ids.sort());

  const only = await (await r.post(base + "/announcements/preview", { data: { channel: "BOTH", audience: "NONE", contact_ids: up.ids } })).json();
  expect(only.customers).toBe(3);
  expect(only.sms).toBe(2);
  expect(only.email).toBe(3);
  const mixed = await (await r.post(base + "/announcements/preview", { data: { channel: "BOTH", audience: "ALL", contact_ids: up.ids } })).json();
  expect(mixed.customers).toBe(3); // Dan is not counted twice
  const sent = await r.post(base + "/announcements/send", { data: { channel: "EMAIL", audience: "NONE", contact_ids: up.ids, confirm: true } });
  expect(sent.status(), await sent.text()).toBe(200);
  const tok = psql(`select unsub_token from shop_campaign_contacts where shop_id='${shop_id}' and email='mail@list.test'`);
  const hostH = { Host: `${slug}.localhost:3000` };
  expect(await (await r.get(`${origin}/u/c/${tok}`, { headers: hostH })).text()).toContain("Unsubscribe me");
  expect(await (await r.post(`${origin}/u/c/${tok}`, { headers: hostH })).text()).toContain("You are unsubscribed");
  const after = await (await r.post(base + "/announcements/preview", { data: { channel: "BOTH", audience: "NONE", contact_ids: up.ids } })).json();
  expect(after.customers).toBe(2);

});
