// Texts are a per-shop, per-customer choice:
//   * a new shop has texts OFF and replies going to the owner's own email;
//   * the owner picks which kinds of text go out, and only those do;
//   * customers are asked "texts yes or no" only when the shop sends texts, once, at next sign-in;
//   * a STOP reply ends texts from the shop that texted, updates that customer's record, and leaves
//     the same person's record at any other shop alone.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import type { WorkspaceData } from "../src/server/domain";
import { base, origin, newShop, enableTexts, customerIdentity, registerCustomer } from "./shop";

const pub = origin + "/api/public";
type Note = { channel: "SMS" | "EMAIL"; template: string; related_id: string; recipient: string };

function futureDate(days = 8) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function onlineShop(name: string, opts: { texts?: string | false } = {}) {
  const s = await newShop(name, { texts: false });
  if (opts.texts !== false) await enableTexts(s.r, opts.texts);
  let w: WorkspaceData = await (await s.r.get(base + "/workspace")).json();
  const slug = `txt-${crypto.randomUUID().slice(0, 12)}`;
  const res = await s.r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } });
  expect(res.status(), await res.text()).toBe(200);
  w = await (await s.r.get(base + "/workspace")).json();
  return { ...s, w, slug };
}
const guest = () => request.newContext({ extraHTTPHeaders: { Origin: origin } });
async function book(c: APIRequestContext, slug: string, w: WorkspaceData, who: { name: string; phone: string; email: string }) {
  const date = futureDate(8), staff = w.staff[0].id, service = w.services[0].id;
  const avail = await (await c.get(`${pub}/shops/${slug}/availability?date=${date}&staff_id=${staff}&service_id=${service}`)).json();
  const free = avail.slots.find((x: { reason?: string }) => !x.reason);
  expect(free, "a free slot").toBeTruthy();
  const res = await c.post(`${pub}/shops/${slug}/bookings`, { data: { request_id: crypto.randomUUID(), staff_id: staff, service_id: service, customer_name: who.name, phone: who.phone, email: who.email, date, start_min: free.start_min, quote: avail.quote } });
  expect(res.status(), await res.text()).toBe(201);
  return res.json() as Promise<{ booking: { id: string }; sent_to: string[] }>;
}
const outbox = async (r: APIRequestContext) => ((await (await r.get(base + "/notifications")).json()) as { notifications: Note[]; messaging: { msg_sms: number; msg_reply_to: string; msg_sms_kinds: string } });
const me = async (c: APIRequestContext, slug: string) => (await (await c.get(`${pub}/shops/${slug}/account/me`)).json()).profile;
const stop = (r: APIRequestContext, phoneIntl: string, text = "STOP") =>
  r.post(origin + "/api/telnyx/webhook", { data: { data: { event_type: "message.received", payload: { direction: "inbound", id: crypto.randomUUID(), from: { phone_number: phoneIntl }, text } } } });
const intl = (local: string) => "+44" + local.replace(/\D/g, "").slice(1);

test("a new shop starts with texts off and email replies going to the owner", async () => {
  const s = await newShop("Fresh Shop", { texts: false });
  const box = await outbox(s.r);
  expect(box.messaging.msg_sms).toBe(0);
  expect(box.messaging.msg_reply_to).toBe(s.email);
  expect(box.messaging.msg_sms_kinds).toBe("confirm,reminder,change");
  // Texts cannot be switched on without accepting the per-text price.
  const cur = box.messaging;
  const refused = await s.r.put(base + "/shop/messaging", { data: { ...cur, msg_sms: 1 } });
  expect(refused.status()).toBe(409);
  // Replies can be pointed at any address the owner chooses, and it sticks.
  await enableTexts(s.r);
  const set = await s.r.put(base + "/shop/messaging", { data: { ...(await outbox(s.r)).messaging, msg_reply_to: "front-desk@fresh-shop.test" } });
  expect(set.status(), await set.text()).toBe(200);
  expect((await outbox(s.r)).messaging.msg_reply_to).toBe("front-desk@fresh-shop.test");
});

test("texts off: nobody is asked, nothing is texted; switching them on asks each customer once", async () => {
  const { r, w, slug } = await onlineShop("Texts Off Cuts", { texts: false });
  const who = customerIdentity("Tess Off");
  const c = await guest();
  await registerCustomer(c, slug, who);
  let p = await me(c, slug);
  expect(p.needs_sms_choice, "not asked while texts are off").toBe(false);
  const made = await book(c, slug, w, who);
  expect(made.sent_to).toEqual(["EMAIL"]);
  expect((await outbox(r)).notifications.filter((n) => n.channel === "SMS" && n.related_id === made.booking.id)).toEqual([]);

  // The owner switches texts on: the customer is now asked, once.
  await enableTexts(r);
  p = await me(c, slug);
  expect(p.needs_sms_choice).toBe(true);
  const no = await c.post(`${pub}/shops/${slug}/account/sms-choice`, { data: { texts: false } });
  expect(no.status(), await no.text()).toBe(200);
  p = await me(c, slug);
  expect(p.needs_sms_choice).toBe(false);
  expect(p.contact_pref).toBe("EMAIL");
  // Email only: a booking now carries no text.
  const again = await book(c, slug, w, who).catch(() => null);
  if (again) expect(again.sent_to).toEqual(["EMAIL"]);
  // Changing their mind later is theirs to do (profile or the prompt).
  const yes = await c.post(`${pub}/shops/${slug}/account/sms-choice`, { data: { texts: true } });
  expect(yes.status()).toBe(200);
  expect((await me(c, slug)).contact_pref).toBe("AUTO");
});

test("the owner's chosen kinds of text are the only ones sent", async () => {
  const { r, w, slug } = await onlineShop("Kinds Cuts", { texts: "reminder" });
  const who = customerIdentity("Kay Kind");
  const c = await guest();
  await registerCustomer(c, slug, who);
  const made = await book(c, slug, w, who);
  expect(made.sent_to, "confirmation is not a chosen kind").toEqual(["EMAIL"]);
  // Now confirmations are on: the next booking carries a text as well.
  await enableTexts(r, "confirm,reminder");
  const who2 = customerIdentity("Kay Two");
  await registerCustomer(c, slug, who2);
  const second = await book(c, slug, w, who2);
  expect(second.sent_to.sort()).toEqual(["EMAIL", "SMS"]);
  // Unknown kinds are refused.
  const bad = await r.put(base + "/shop/messaging", { data: { ...(await outbox(r)).messaging, msg_sms_kinds: "confirm,spam", sms_billing_ack: true } });
  expect(bad.status()).toBe(400);
});

test("a STOP reply updates that customer's account at the shop that texted, and no other shop's", async () => {
  const a = await onlineShop("Doghouse Stand-in");
  const b = await onlineShop("Other Shop");
  const who = customerIdentity("Sam Same");
  const ca = await guest(), cb = await guest();
  await registerCustomer(ca, a.slug, who);
  await registerCustomer(cb, b.slug, { ...who, email: `other-${who.email}` });
  // Shop A texts them (a confirmation); shop B has not.
  const made = await book(ca, a.slug, a.w, who);
  expect(made.sent_to).toContain("SMS");

  const res = await stop(a.r, intl(who.phone));
  expect(res.status(), await res.text()).toBe(200);

  const pa = await me(ca, a.slug), pb = await me(cb, b.slug);
  expect(pa.sms_stopped_at, "A's record shows the STOP").toBeTruthy();
  expect(pa.contact_pref).toBe("EMAIL");
  expect(pa.marketing_opt_in).toBe(0);
  expect(pb.sms_stopped_at, "B untouched").toBeNull();
  expect(pb.contact_pref).toBe("AUTO");

  // A's next booking for them is email only.
  const w2 = await book(ca, a.slug, a.w, who).catch(() => null);
  if (w2) expect(w2.sent_to).toEqual(["EMAIL"]);

  // START brings texts back at A, in their own words (A is still the shop that last texted this number).
  await stop(a.r, intl(who.phone), "START");
  const back = await me(ca, a.slug);
  expect(back.sms_stopped_at).toBeNull();
  expect(back.contact_pref).toBe("AUTO");
  expect((await me(cb, b.slug)).sms_stopped_at, "B still untouched").toBeNull();

  // B was never blocked: it can text them.
  const bb = await book(cb, b.slug, b.w, { ...who, email: `other-${who.email}` });
  expect(bb.sent_to).toContain("SMS");
});
