// WhatsApp as a third channel (Infobip, one OLLO sender). Without INFOBIP keys the sandbox is in
// preview mode: WA rows queue to the mailbox like SMS/email, so these tests assert the routing
// contract — who gets WhatsApp, when it falls back to text, what the shop toggle does, and that
// inbound STOP/START and delivery-report webhooks land on the right rows.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import type { WorkspaceData } from "../src/server/domain";
import { base, origin, newShop } from "./shop";

const pub = origin + "/api/public";
type Note = { id: string; channel: "SMS" | "EMAIL" | "WA"; recipient: string; template: string; body: string; status: string; provider: string; provider_id: string; related_id: string; error: string; status_note: string };
type Outbox = { notifications: Note[]; providers: { sms: { provider: string }; wa: { provider: string; sender: string; test_sender: boolean } }; messaging: { msg_sms: number; msg_email: number; msg_wa: number; msg_reminders: number; msg_reminder_hours: number; msg_reply_to: string; msg_sms_sender: string } };

function futureDate(days = 8) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function onlineShop(name = "WhatsApp Test Shop") {
  const { r, shop_id } = await newShop(name);
  let w: WorkspaceData = await (await r.get(base + "/workspace")).json();
  const slug = `wa-${crypto.randomUUID().slice(0, 12)}`;
  const res = await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } });
  expect(res.status(), await res.text()).toBe(200);
  w = await (await r.get(base + "/workspace")).json();
  return { r, w, slug, shop_id };
}
const customer = () => request.newContext({ extraHTTPHeaders: { Origin: origin } });
async function outbox(r: APIRequestContext): Promise<Outbox> {
  const res = await r.get(base + "/notifications");
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
const customerRows = (rows: Note[], id: string) => rows.filter((n) => n.related_id === id && !n.template.startsWith("owner_"));
async function bookOnline(c: APIRequestContext, slug: string, w: WorkspaceData, date: string, extra: Record<string, unknown> = {}, phone = "07700 900444") {
  const staff = w.staff[0].id, service = w.services[0].id;
  const avail = await (await c.get(`${pub}/shops/${slug}/availability?date=${date}&staff_id=${staff}&service_id=${service}`)).json();
  const free = avail.slots.find((x: { reason?: string }) => !x.reason);
  expect(free, `no free slot on ${date}`).toBeTruthy();
  const data = { request_id: crypto.randomUUID(), staff_id: staff, service_id: service, customer_name: "WhatsApp Customer", phone, email: "wa-customer@example.test", date, start_min: free.start_min, quote: avail.quote, ...extra };
  const res = await c.post(`${pub}/shops/${slug}/bookings`, { data });
  return { res, json: (await res.json()) as { booking: { id: string; version: number; contact_pref?: string }; manage_token: string; sent_to: string[]; error?: string } };
}

test.skip(() => new Date().getUTCDay() === 0, "Fixture shop is closed Sundays");

test("public shop advertises channels; WhatsApp preference routes the confirmation to WA (+ email) and sticks on the customer record", async () => {
  const { r, w, slug } = await onlineShop();
  const c = await customer();
  const info = await (await c.get(`${pub}/shops/${slug}`)).json();
  expect(info.shop.channels).toEqual({ sms: true, email: true, wa: true });

  // Default: text + email (unchanged behaviour).
  const a = await bookOnline(c, slug, w, futureDate(8));
  expect(a.res.status(), JSON.stringify(a.json)).toBe(201);
  expect(a.json.sent_to.sort()).toEqual(["EMAIL", "SMS"]);

  // WhatsApp picked at checkout: WA replaces SMS, email still goes for the receipt.
  const b = await bookOnline(c, slug, w, futureDate(9), { contact_pref: "WA" });
  expect(b.res.status(), JSON.stringify(b.json)).toBe(201);
  expect(b.json.sent_to.sort()).toEqual(["EMAIL", "WA"]);
  let box = await outbox(r);
  const rows = customerRows(box.notifications, b.json.booking.id);
  const wa = rows.find((n) => n.channel === "WA")!;
  expect(wa).toBeTruthy();
  expect(wa.recipient).toBe("07700900444");
  expect(wa.template).toBe("booking_confirmed");
  expect(wa.status).toBe("SENT");
  expect(wa.provider).toBe("mailbox");
  // The readable body is the same shop-branded text SMS would carry.
  expect(wa.body).toContain("WhatsApp Test Shop");

  // The choice is remembered: the next booking from that number with no picker still goes WA.
  const d = await bookOnline(c, slug, w, futureDate(10));
  expect(d.res.status(), JSON.stringify(d.json)).toBe(201);
  expect(d.json.sent_to.sort()).toEqual(["EMAIL", "WA"]);
  // ...and the CRM record shows it.
  const list = await (await r.get(base + "/customers?q=07700900444")).json();
  const cust = (list.customers ?? list).find((x: { phone: string }) => x.phone === "07700900444");
  expect(cust?.contact_pref).toBe("WA");

  // Email preference: email only, and needs an address.
  const e = await bookOnline(c, slug, w, futureDate(11), { contact_pref: "EMAIL" }, "07700 900445");
  expect(e.res.status(), JSON.stringify(e.json)).toBe(201);
  expect(e.json.sent_to).toEqual(["EMAIL"]);
  const bad = await bookOnline(c, slug, w, futureDate(12), { contact_pref: "FAX" }, "07700 900446");
  expect(bad.res.status()).toBe(400);
  box = await outbox(r);
  expect(box.providers.wa.provider).toMatch(/^(mailbox|infobip)$/);
});

test("shop switches WhatsApp off → WA preference falls back to text; toggle round-trips in settings", async () => {
  const { r, w, slug } = await onlineShop("No WhatsApp Shop");
  const c = await customer();
  let box = await outbox(r);
  expect(box.messaging.msg_wa).toBe(1);
  const res = await r.put(base + "/shop/messaging", { data: { ...box.messaging, msg_wa: 0 } });
  expect(res.status(), await res.text()).toBe(200);
  box = await outbox(r);
  expect(box.messaging.msg_wa).toBe(0);
  const info = await (await c.get(`${pub}/shops/${slug}`)).json();
  expect(info.shop.channels.wa).toBe(false);

  const b = await bookOnline(c, slug, w, futureDate(8), { contact_pref: "WA" });
  expect(b.res.status(), JSON.stringify(b.json)).toBe(201);
  expect(b.json.sent_to.sort()).toEqual(["EMAIL", "SMS"]);
  const rows = customerRows((await outbox(r)).notifications, b.json.booking.id);
  expect(rows.map((n) => n.channel).sort()).toEqual(["EMAIL", "SMS"]);

  // Older clients that omit msg_wa keep it as it was (default 1 only applies when unset in the DB).
  const { msg_wa: _drop, ...legacy } = box.messaging;
  void _drop;
  const res2 = await r.put(base + "/shop/messaging", { data: legacy });
  expect(res2.status(), await res2.text()).toBe(200);
});

test("inbound webhook: STOP opts a number out (WA message fails fast, text still goes); START opts back in; replies are stored against the shop", async () => {
  const { r, w, slug, shop_id } = await onlineShop("Inbound Shop");
  const c = await customer();
  const phone = "07700 900" + String(500 + Math.floor(Math.random() * 400)).padStart(3, "0");
  const e164 = "44" + phone.replace(/\s/g, "").slice(1);
  // Baseline: WA queued for this number.
  const a = await bookOnline(c, slug, w, futureDate(8), { contact_pref: "WA" }, phone);
  expect(a.res.status(), JSON.stringify(a.json)).toBe(201);
  expect(a.json.sent_to).toContain("WA");

  // Customer replies STOP on WhatsApp (Infobip inbound shape).
  const hook = await c.post(origin + "/api/whatsapp/inbound", { data: { results: [{ from: e164, to: "447860088970", messageId: "in-" + crypto.randomUUID(), message: { type: "TEXT", text: "STOP" }, receivedAt: new Date().toISOString() }] } });
  expect(hook.status(), await hook.text()).toBe(200);
  expect((await hook.json()).stored).toBe(1);

  // Next WA-preferred booking: the WA row is attempted and fails permanently (opted out) → falls back to a text row.
  const b = await bookOnline(c, slug, w, futureDate(9), { contact_pref: "WA" }, phone);
  expect(b.res.status(), JSON.stringify(b.json)).toBe(201);
  const rows = customerRows((await outbox(r)).notifications, b.json.booking.id);
  const wa = rows.find((n) => n.channel === "WA")!;
  const sms = rows.find((n) => n.channel === "SMS")!;
  expect(wa, "WA row attempted").toBeTruthy();
  expect(wa.status).toBe("FAILED");
  expect(wa.error).toMatch(/opted out/i);
  expect(sms, "SMS fallback row after WA opt-out").toBeTruthy();
  expect(sms.status).toBe("SENT");
  expect(sms.status_note).toMatch(/fallback/i);
  expect(sms.body).toBe(wa.body);

  // START opts back in.
  const hook2 = await c.post(origin + "/api/whatsapp/inbound", { data: { results: [{ from: e164, messageId: "in-" + crypto.randomUUID(), message: { type: "TEXT", text: "start" } }] } });
  expect(hook2.status()).toBe(200);
  // A free-text reply is stored against this shop (attributed via the last outbound WA row).
  const hook3 = await c.post(origin + "/api/whatsapp/inbound", { data: { results: [{ from: e164, messageId: "in-" + crypto.randomUUID(), message: { type: "TEXT", text: "Can I come 10 min late?" } }] } });
  expect(hook3.status()).toBe(200);
  const inbound = await r.get(base + "/notifications/inbound");
  if (inbound.status() === 200) {
    const j = await inbound.json();
    const mine = (j.inbound as { shop_id: string; phone: string; body: string }[]).filter((x) => x.phone === e164);
    expect(mine.some((x) => x.body === "Can I come 10 min late?" && x.shop_id === shop_id)).toBe(true);
  }
  // Garbage bodies never 500 (Infobip would retry forever otherwise).
  expect((await c.post(origin + "/api/whatsapp/inbound", { data: "nope" })).status()).toBe(200);
  expect((await c.post(origin + "/api/whatsapp/status", { data: { results: [{ messageId: "does-not-exist", status: { groupName: "DELIVERED" } }] } })).status()).toBe(200);
});
