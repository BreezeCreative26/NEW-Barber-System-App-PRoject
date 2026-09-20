// AI receptionist (ElevenLabs tool endpoints). Each shop is its own entity: its own bearer secret,
// its own call log; a secret never reaches another shop. Every test creates its own fictional shop.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import type { WorkspaceData } from "../src/server/domain";
import { base, origin, newShop } from "./shop";

function futureDate(days = 8) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function onlineShop(name = "Voice Test Barbers") {
  const { r, shop_id } = await newShop(name);
  let w: WorkspaceData = await (await r.get(base + "/workspace")).json();
  const slug = `voice-${crypto.randomUUID().slice(0, 12)}`;
  const res = await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } });
  expect(res.status(), await res.text()).toBe(200);
  w = await (await r.get(base + "/workspace")).json();
  return { r, w, slug, shop_id };
}
// ElevenLabs is a third party: no cookies, foreign origin, just the bearer.
const agent = (secret: string) => request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${secret}`, Origin: "https://api.elevenlabs.io" } });

test.skip(() => new Date().getUTCDay() === 0, "Fixture shop is closed Sundays");

test("owner enables the receptionist → secret minted once; tools answer with spoken text; book / find / cancel / callback round-trip", async () => {
  const { r, slug } = await onlineShop();
  let v = await (await r.get(base + "/shop/voice")).json();
  expect(v.settings.enabled).toBe(false);
  expect(v.settings.has_secret).toBe(false);
  expect(v.endpoints.book.url).toBe(`${origin}/api/voice/${slug}/book`);
  expect(v.prompt).toContain("Voice Test Barbers");

  // Not enabled yet: tools are invisible even with a guess.
  const stranger = await agent("ollo_vk_nope");
  expect((await stranger.get(`${origin}/api/voice/${slug}/info`)).status()).toBe(404);

  const on = await r.put(base + "/shop/voice", { data: { enabled: true, agent_id: "agent_test_123", greeting: "Hi, Voice Test Barbers, how can I help?", notes: "Cash only. Parking behind the shop." } });
  expect(on.status(), await on.text()).toBe(200);
  const { secret } = await on.json();
  expect(secret).toMatch(/^ollo_vk_[0-9a-f]{48}$/);
  // Second save does not re-issue the secret; GET only ever shows the tail.
  const again = await (await r.put(base + "/shop/voice", { data: { enabled: true, agent_id: "agent_test_123", greeting: "", notes: "" } })).json();
  expect(again.secret).toBeUndefined();
  v = await (await r.get(base + "/shop/voice")).json();
  expect(v.secret_hint).toBe(`…${secret.slice(-6)}`);

  expect((await stranger.get(`${origin}/api/voice/${slug}/info`)).status()).toBe(401);
  const el = await agent(secret);

  // info
  const info = await (await el.get(`${origin}/api/voice/${slug}/info`)).json();
  expect(info.shop.name).toBe("Voice Test Barbers");
  expect(info.services.map((s: { name: string }) => s.name).sort()).toEqual(["Cut & beard", "Signature cut", "Skin fade"]);
  expect(info.barbers.map((s: { name: string }) => s.name)).toEqual(["Jay Carter", "Marcus Reed"]);
  expect(info.hours.find((h: { day: string }) => h.day === "Sunday").open).toBe(false);
  expect(info.notes).toBe("");

  // availability, fuzzy service + barber + relative day
  const date = futureDate(8);
  const av = await (await el.get(`${origin}/api/voice/${slug}/availability?service=fade&date=${date}&barber=marcus&time=10am`)).json();
  expect(av.ok).toBe(true);
  expect(av.service).toBe("Skin fade");
  expect(av.barber).toBe("Marcus Reed");
  expect(av.near_requested.length).toBeGreaterThan(0);
  expect(av.say).toMatch(/Around 10 am/);
  const unknown = await (await el.get(`${origin}/api/voice/${slug}/availability?service=perm&date=${date}`)).json();
  expect(unknown.ok).toBe(false);
  expect(unknown.say).toMatch(/Which service/);

  // book — spoken time, "any" barber, WhatsApp preference
  const phone = "07700 900" + String(600 + Math.floor(Math.random() * 300));
  const booked = await el.post(`${origin}/api/voice/${slug}/book`, { data: { name: "Phone Caller", phone, service: "signature cut", barber: "whoever is free", date, time: "2pm", contact_pref: "WA", conversation_id: "conv_1" } });
  expect(booked.status(), await booked.text()).toBe(201);
  const bj = await booked.json();
  expect(bj.ok).toBe(true);
  expect(bj.reference).toMatch(/^[A-Z]{3}-\d{4}$/);
  expect(bj.say).toMatch(/Booked: Signature cut with (Jay|Marcus) on .* at 2 pm/);
  expect(bj.sent_to).toContain("WA");
  // The booking is a normal ONLINE booking in the diary, flagged as phone.
  const wb = await (await r.get(base + `/bookings/${bj.booking.id}`)).json();
  expect(wb.booking.notes).toMatch(/AI receptionist/);
  expect(wb.booking.channel).toBe("ONLINE");

  // Same slot again → spoken alternative, HTTP 200 (agents handle failure in-band).
  const clash = await el.post(`${origin}/api/voice/${slug}/book`, { data: { name: "Second Caller", phone: "07700 900999", service: "signature cut", barber: bj.booking.staff_name, date, time: "14:00" } });
  expect(clash.status()).toBe(200);
  const cj = await clash.json();
  expect(cj.ok).toBe(false);
  expect(cj.say).toMatch(/isn't free|just gone|I can do/);

  // find + cancel by phone
  const found = await (await el.get(`${origin}/api/voice/${slug}/bookings?phone=${encodeURIComponent(phone)}`)).json();
  expect(found.bookings).toHaveLength(1);
  expect(found.bookings[0].reference).toBe(bj.reference);
  const cancelled = await (await el.post(`${origin}/api/voice/${slug}/cancel`, { data: { phone, reference: bj.reference } })).json();
  expect(cancelled.ok).toBe(true);
  expect(cancelled.say).toMatch(/^Cancelled: Signature cut/);
  expect((await (await el.get(`${origin}/api/voice/${slug}/bookings?phone=${encodeURIComponent(phone)}`)).json()).bookings).toHaveLength(0);

  // callback → owner gets an email alert through the outbox
  const cb = await (await el.post(`${origin}/api/voice/${slug}/callback`, { data: { name: "Mrs Patel", phone: "07700 900123", note: "Wants a colour consultation for her son" } })).json();
  expect(cb.ok).toBe(true);
  const box = await (await r.get(base + "/notifications")).json();
  const alert = box.notifications.find((n: { template: string }) => n.template === "owner_callback");
  expect(alert, "owner_callback in outbox").toBeTruthy();
  expect(alert.body).toContain("colour consultation");

  // webhooks: personalise (known caller) and post-call transcript → call log
  const pers = await (await el.post(`${origin}/api/voice/${slug}/personalise`, { data: { caller_id: "+44" + phone.replace(/\s/g, "").slice(1), conversation_id: "conv_2", agent_id: "agent_test_123" } })).json();
  expect(pers.type).toBe("conversation_initiation_client_data");
  expect(pers.dynamic_variables.shop_name).toBe("Voice Test Barbers");
  expect(pers.dynamic_variables.caller_name).toBe("Phone Caller");
  expect(pers.conversation_config_override.agent.first_message).toMatch(/^Hi Phone, welcome back/);
  const post = await el.post(`${origin}/api/voice/${slug}/post-call`, { data: { type: "post_call_transcription", data: { conversation_id: "conv_2", status: "done", transcript: [{ role: "agent", message: "Hello" }, { role: "user", message: "Book me in" }], metadata: { start_time_unix_secs: Math.floor(Date.now() / 1000) - 90, call_duration_secs: 85, phone_call: { external_number: "+447700900123" } }, analysis: { transcript_summary: "Caller booked a cut.", call_successful: "success" } } } });
  expect(post.status()).toBe(200);
  v = await (await r.get(base + "/shop/voice")).json();
  const call = v.calls.find((x: { conversation_id: string }) => x.conversation_id === "conv_2");
  expect(call.outcome).toBe("handled");
  expect(call.summary).toBe("Caller booked a cut.");
  expect(call.duration_s).toBe(85);
  const full = await (await r.get(base + `/shop/voice/calls/${call.id}`)).json();
  expect(full.call.transcript).toContain("Caller: Book me in");

  // rotate: old secret dies immediately
  const rot = await (await r.post(base + "/shop/voice/rotate", { data: {} })).json();
  expect(rot.secret).not.toBe(secret);
  expect((await el.get(`${origin}/api/voice/${slug}/info`)).status()).toBe(401);
  expect((await (await agent(rot.secret)).get(`${origin}/api/voice/${slug}/info`)).status()).toBe(200);
});

test("secrets are per shop: shop A's secret cannot read or book shop B; barbers cannot manage the receptionist", async () => {
  const a = await onlineShop("Shop A Voice");
  const b = await onlineShop("Shop B Voice");
  const sa = (await (await a.r.put(base + "/shop/voice", { data: { enabled: true, agent_id: "", greeting: "", notes: "" } })).json()).secret;
  const sb = (await (await b.r.put(base + "/shop/voice", { data: { enabled: true, agent_id: "", greeting: "", notes: "" } })).json()).secret;
  expect(sa).not.toBe(sb);
  const ela = await agent(sa);
  expect((await ela.get(`${origin}/api/voice/${b.slug}/info`)).status()).toBe(401);
  expect((await ela.post(`${origin}/api/voice/${b.slug}/book`, { data: { name: "x", phone: "07700900000", service: "cut", date: futureDate(), time: "10" } })).status()).toBe(401);
  expect((await ela.get(`${origin}/api/voice/${a.slug}/info`)).status()).toBe(200);
  // Cannot enable without online booking.
  const { r } = await newShop("Offline Voice");
  const off = await r.put(base + "/shop/voice", { data: { enabled: true, agent_id: "", greeting: "", notes: "" } });
  expect(off.status()).toBe(409);
});
