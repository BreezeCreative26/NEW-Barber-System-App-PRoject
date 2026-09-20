// AI receptionist: tool endpoints for an ElevenLabs Conversational AI agent, one agent per shop.
//
// Every shop is a separate entity: its own ElevenLabs agent, its own bearer secret (generated
// here), its own call log. The agent calls these tools with `Authorization: Bearer <secret>`;
// the secret identifies the shop, so nothing about another shop is reachable.
//
//   GET  /api/voice/:slug/info                      shop hours, services, barbers, policies
//   GET  /api/voice/:slug/availability?date&service&barber   open times for a day (spoken form)
//   POST /api/voice/:slug/book                      {name, phone, service, barber?, date, time, contact_pref?}
//   GET  /api/voice/:slug/bookings?phone=           the caller's upcoming visits
//   POST /api/voice/:slug/cancel                    {reference|booking_id, phone}
//   POST /api/voice/:slug/callback                  {name, phone, note}  → owner alert
//   POST /api/voice/:slug/post-call                 ElevenLabs post-call webhook (transcript + summary)
//   POST /api/voice/:slug/personalise               ElevenLabs conversation-initiation webhook
//
// Owner-side (session cookie, via /api/app): GET/PUT /shop/voice, POST /shop/voice/rotate, GET /shop/voice/calls.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { alertOwners } from "./alerts";
import { createBooking, fail } from "./sandbox";
import type { AppEnv } from "./accounts";
import { cancelByCustomer, customerView, limits, notifyBooking, rangeContext, shopBySlug, slotFor, throttle, type BrandedShop, type Ctx } from "./public";
import { dayStarts, dueAtBooking, ref, shopDay, shopToday, shopWeek, weekday, type Service, type Shop, type Staff, type StoredBooking } from "./domain";
import { enqueue, drain, msgShop } from "./messaging";

// webhook_secret = ElevenLabs' HMAC secret (wsec_…) for the post-call webhook; that webhook cannot
// send our bearer, so it is verified by signature instead.
export type VoiceSettings = { enabled: boolean; agent_id: string; secret: string; webhook_secret: string; greeting: string; notes: string; created_at?: number };
export function voiceOf(json: string | null | undefined): VoiceSettings {
  let v: Partial<VoiceSettings> = {};
  try { v = JSON.parse(json || "{}"); } catch { v = {}; }
  return { enabled: !!v.enabled, agent_id: v.agent_id || "", secret: v.secret || "", webhook_secret: v.webhook_secret || "", greeting: v.greeting || "", notes: v.notes || "", created_at: v.created_at };
}
// ElevenLabs-Signature: t=<unix>,v0=<hex hmac-sha256 of "<t>.<raw body>">. 30-minute tolerance.
async function elevenSignatureOk(header: string | undefined, raw: string, secret: string) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t), v0 = parts.v0 || "";
  if (!t || !v0 || Math.abs(Date.now() / 1000 - t) > 1800) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(sig, v0);
}
export const newSecret = () => "ollo_vk_" + Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

const voice = new Hono<AppEnv>();
// Server-to-server from ElevenLabs: no cookies, no same-origin check — the per-shop bearer secret is
// the whole of the authentication. Errors come back as spoken-friendly JSON so the agent can recover.
voice.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!c.env?.DB) return c.json({ ok: false, say: "The booking system is unavailable right now." }, 503);
  c.set("account", null);
  c.set("actor", "voice:receptionist");
  await next();
});
voice.onError((err, c) => {
  const e = err as Error;
  const status = err instanceof HTTPException ? err.status : 500;
  const message = status === 401 || status === 404 ? e.message : status === 429 ? "The diary is busy — try again in a moment." : "Something went wrong reaching the diary.";
  return c.json({ ok: false, say: message, error: e.message.slice(0, 200) }, status as 400);
});

// Shop by slug + bearer secret. Voice is opt-in per shop; a wrong or missing secret is a 401 with a
// spoken-friendly message so the agent can say "I can't reach the diary right now".
async function voiceShop(c: Ctx): Promise<{ shop: BrandedShop; settings: VoiceSettings }> {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const settings = voiceOf((shop as Shop & { voice_json?: string }).voice_json);
  const auth = c.req.header("authorization") || "";
  const given = auth.replace(/^Bearer\s+/i, "").trim() || c.req.header("x-voice-secret") || "";
  if (!settings.enabled || !settings.secret) fail(404, "This shop has no AI receptionist");
  if (!given || !timingSafeEqual(given, settings.secret)) fail(401, "Receptionist secret is wrong or missing");
  await throttle(c, "voice", shop.id, 240);
  return { shop, settings };
}

const spokenTime = (min: number) => {
  const h = Math.floor(min / 60), m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
};
const spokenDate = (date: string) => new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const money = (pence: number, currency = "GBP") => new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: pence % 100 ? 2 : 0 }).format(pence / 100);
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Fuzzy match on what the caller said ("skin fade", "a fade", "Marcus").
function pick<T extends { id: string; name: string }>(items: T[], said: string | undefined): T | null {
  if (!said) return null;
  const s = said.trim().toLowerCase();
  if (!s) return null;
  const exact = items.find((i) => i.id === said || i.name.toLowerCase() === s);
  if (exact) return exact;
  const contains = items.filter((i) => i.name.toLowerCase().includes(s) || s.includes(i.name.toLowerCase()) || s.includes(i.name.toLowerCase().split(" ")[0]));
  if (contains.length === 1) return contains[0];
  const words = s.split(/\s+/);
  const scored = items.map((i) => ({ i, n: words.filter((w) => w.length > 2 && i.name.toLowerCase().includes(w)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  return scored.length && (scored.length === 1 || scored[0].n > scored[1].n) ? scored[0].i : null;
}
// "tomorrow", "next friday", "the 23rd", "2026-09-23" → YYYY-MM-DD in the shop's day.
function parseDate(said: string | undefined, shop: Shop): string | null {
  if (!said) return null;
  const s = said.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const today = shopToday(shop.timezone);
  const base = new Date(today + "T12:00:00Z");
  const plus = (n: number) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  if (s === "today") return today;
  if (s === "tomorrow") return plus(1);
  const wd = DAYS.findIndex((d) => s.includes(d.toLowerCase()));
  if (wd >= 0) {
    let n = (wd - base.getUTCDay() + 7) % 7;
    if (n === 0 && !s.includes("today")) n = 7;
    if (s.includes("next") && n < 7 && base.getUTCDay() !== wd) n += 0; // "next friday" = the coming friday
    return plus(n);
  }
  const dm = s.match(/(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:of\s+)?([a-z]+))?/);
  if (dm) {
    const day = +dm[1];
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    let month = dm[2] ? months.findIndex((m) => m.startsWith(dm[2].slice(0, 3))) : base.getUTCMonth();
    let year = base.getUTCFullYear();
    if (month < 0) month = base.getUTCMonth();
    const cand = new Date(Date.UTC(year, month, day, 12));
    if (cand < base) { if (dm[2]) year++; else cand.setUTCMonth(cand.getUTCMonth() + 1); }
    const d = dm[2] ? new Date(Date.UTC(year, month, day, 12)) : cand;
    return d.toISOString().slice(0, 10);
  }
  return null;
}
// "10", "10:30", "half ten", "2pm", "14:00" → minutes from midnight (15-min grid).
function parseTime(said: string | undefined): number | null {
  if (!said) return null;
  const s = said.trim().toLowerCase().replace(/\./g, ":");
  let m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m|p\.m)?$/);
  if (!m) { const h = s.match(/half\s+(?:past\s+)?(\d{1,2})/); if (h) m = [s, h[1], "30", undefined] as unknown as RegExpMatchArray; }
  if (!m) { const q = s.match(/quarter\s+past\s+(\d{1,2})/); if (q) m = [s, q[1], "15", undefined] as unknown as RegExpMatchArray; }
  if (!m) return null;
  let h = +m[1]; const min = +(m[2] || 0); const ap = m[3];
  if (ap?.startsWith("p") && h < 12) h += 12;
  if (ap?.startsWith("a") && h === 12) h = 0;
  if (!ap && h >= 1 && h <= 7) h += 12; // "at 2" in a barbershop means 2 pm
  const total = h * 60 + min;
  return total >= 0 && total < 1440 ? Math.round(total / 15) * 15 : null;
}
const ukPhone = (s: string) => {
  const d = s.replace(/[^\d+]/g, "");
  if (/^\+447\d{9}$/.test(d)) return "0" + d.slice(3);
  if (/^447\d{9}$/.test(d)) return "0" + d.slice(2);
  if (/^07\d{9}$/.test(d)) return d;
  return null;
};

async function catalogue(c: Ctx, shop: Shop) {
  const r = await c.env.DB.batch([
    c.env.DB.prepare("SELECT id,name,role,title FROM staff WHERE shop_id=? AND active=1 AND online_visible=1 ORDER BY sort_order,name").bind(shop.id),
    c.env.DB.prepare("SELECT id,name,category,duration_min,price_pence,description,version FROM services WHERE shop_id=? AND active=1 AND online_bookable=1 ORDER BY category,name").bind(shop.id),
  ]);
  return { staff: r[0].results as Pick<Staff, "id" | "name" | "role" | "title">[], services: r[1].results as Pick<Service, "id" | "name" | "category" | "duration_min" | "price_pence" | "description" | "version">[] };
}

// ---- Tools ---------------------------------------------------------------------------------------
voice.get("/:slug/info", async (c) => {
  const { shop, settings } = await voiceShop(c);
  const { staff, services } = await catalogue(c, shop);
  const week = shopWeek(shop);
  const hours = week.map((d, i) => ({ day: DAYS[i], open: !!d.enabled, hours: d.enabled ? `${spokenTime(d.starts)} to ${spokenTime(d.ends)}` : "closed" }));
  const today = shopToday(shop.timezone);
  return c.json({
    shop: { name: shop.name, address: shop.address, phone: (shop as { phone?: string }).phone || "", timezone: shop.timezone, today, today_is: spokenDate(today) },
    hours,
    services: services.map((s) => ({ id: s.id, name: s.name, category: s.category, duration: `${s.duration_min} minutes`, price: money(s.price_pence, shop.currency), description: s.description || "" })),
    barbers: staff.map((s) => ({ id: s.id, name: s.name, role: s.title || s.role })),
    policies: {
      cancellation: `${shop.cancel_hours} hours' notice to cancel or move`,
      deposit: shop.deposit_pence ? `${money(shop.deposit_pence, shop.currency)} deposit on some services, payable in the shop or online` : "no deposit",
      booking_window: `up to ${shop.booking_window_days} days ahead`,
      lead_time: `at least ${shop.lead_time_min} minutes before the appointment`,
    },
    notes: settings.notes,
    book_online: `${new URL(c.req.url).origin}/book/${shop.slug}`,
  });
});

voice.get("/:slug/availability", async (c) => {
  const { shop } = await voiceShop(c);
  const q = c.req.query();
  const { staff, services } = await catalogue(c, shop);
  const service = pick(services, q.service);
  if (!service) return c.json({ ok: false, say: `Which service would they like? We offer ${services.map((s) => s.name).join(", ")}.`, services: services.map((s) => s.name) }, 200);
  const date = parseDate(q.date, shop);
  if (!date) return c.json({ ok: false, say: "Which day would they like? For example tomorrow, Friday, or the 23rd." }, 200);
  const barber = q.barber ? pick(staff, q.barber) : null;
  if (q.barber && !barber && !/any|anyone|whoever|no preference|don'?t mind/i.test(q.barber)) return c.json({ ok: false, say: `I don't have a barber called ${q.barber}. Our team is ${staff.map((s) => s.name).join(", ")}. Anyone in particular, or whoever is free?` }, 200);
  const { today, minStart, maxDate } = limits(shop);
  if (date < today) return c.json({ ok: false, say: "That day has passed. Which day works?" }, 200);
  if (date > maxDate) return c.json({ ok: false, say: `We only take bookings up to ${shop.booking_window_days} days ahead — the latest is ${spokenDate(maxDate)}.` }, 200);
  if (!shopDay(shop, weekday(date)).enabled) return c.json({ ok: false, say: `We're closed on ${spokenDate(date)}.`, closed: true }, 200);
  const ctx = await rangeContext(c, shop, barber ? [barber.id] : null, service.id, date, date, []);
  const open = dayStarts(shop, date).flatMap((start_min) => {
    const free = ctx.staff.filter((s) => !slotFor(shop, ctx, s, date, start_min, minStart));
    return free.length ? [{ start_min, time: spokenTime(start_min), barbers: free.map((s) => s.name.split(" ")[0]) }] : [];
  });
  const wanted = parseTime(q.time);
  const near = wanted != null ? open.filter((o) => Math.abs(o.start_min - wanted) <= 90).sort((a, b) => Math.abs(a.start_min - wanted) - Math.abs(b.start_min - wanted)).slice(0, 4) : [];
  const q1 = ctx.quotes.get(ctx.staff[0]?.id ?? "");
  const summary = open.length === 0
    ? `Nothing free for a ${service.name}${barber ? ` with ${barber.name.split(" ")[0]}` : ""} on ${spokenDate(date)}.`
    : wanted != null && near.length
      ? `Around ${spokenTime(wanted)} on ${spokenDate(date)} we have ${near.map((o) => o.time).join(", ")}.`
      : `On ${spokenDate(date)} we have ${open.length} times${barber ? ` with ${barber.name.split(" ")[0]}` : ""}: ${[...new Set([open[0], open[Math.floor(open.length / 3)], open[Math.floor((2 * open.length) / 3)], open[open.length - 1]].map((o) => o.time))].join(", ")}.`;
  return c.json({
    ok: true, date, date_spoken: spokenDate(date), service: service.name, barber: barber?.name ?? "any",
    price: q1 ? money(q1.price_pence, shop.currency) : money(service.price_pence, shop.currency), duration: `${q1?.duration_min ?? service.duration_min} minutes`,
    quote: { service_version: service.version, shop_version: shop.version },
    slots: open, near_requested: near, say: summary,
  });
});

const bookBody = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(6).max(30),
  email: z.string().trim().email().max(120).optional().or(z.literal("")),
  service: z.string().trim().min(1),
  barber: z.string().trim().optional(),
  date: z.string().trim().min(1),
  time: z.string().trim().min(1),
  notes: z.string().trim().max(300).optional(),
  contact_pref: z.enum(["AUTO", "SMS", "WA", "EMAIL"]).optional(),
  conversation_id: z.string().optional(),
}).passthrough();
voice.post("/:slug/book", async (c) => {
  const { shop } = await voiceShop(c);
  const raw = await c.req.json().catch(() => ({}));
  const p = bookBody.safeParse(raw);
  if (!p.success) return c.json({ ok: false, say: "I need the caller's name, mobile number, the service, day and time.", errors: p.error.flatten().fieldErrors }, 200);
  const b = p.data;
  const phone = ukPhone(b.phone);
  if (!phone) return c.json({ ok: false, say: "Could you read the mobile number back to me? It should start with oh-seven." }, 200);
  const { staff, services } = await catalogue(c, shop);
  const service = pick(services, b.service);
  if (!service) return c.json({ ok: false, say: `Which service? We offer ${services.map((s) => s.name).join(", ")}.` }, 200);
  const date = parseDate(b.date, shop);
  const start_min = parseTime(b.time);
  if (!date || start_min == null) return c.json({ ok: false, say: "Which day and time would they like?" }, 200);
  const { minStart, maxDate } = limits(shop);
  let barber = b.barber && !/any|anyone|whoever|no preference|don'?t mind/i.test(b.barber) ? pick(staff, b.barber) : null;
  if (!barber) {
    // Any barber: least-booked free barber at that time.
    const ctx = await rangeContext(c, shop, null, service.id, date, date, []);
    const free = ctx.staff.filter((s) => !slotFor(shop, ctx, s, date, start_min, minStart));
    if (!free.length) {
      const alt = dayStarts(shop, date).filter((m) => ctx.staff.some((s) => !slotFor(shop, ctx, s, date, m, minStart))).sort((a, b2) => Math.abs(a - start_min) - Math.abs(b2 - start_min)).slice(0, 3);
      return c.json({ ok: false, say: alt.length ? `${spokenTime(start_min)} isn't free on ${spokenDate(date)}. I can do ${alt.map(spokenTime).join(", ")}.` : `Nothing free on ${spokenDate(date)} for that.`, alternatives: alt.map((m) => ({ start_min: m, time: spokenTime(m) })) }, 200);
    }
    const load = new Map(ctx.staff.map((s) => [s.id, ctx.bookings.filter((x) => x.staff_id === s.id).length]));
    barber = free.sort((x, y) => load.get(x.id)! - load.get(y.id)! || x.name.localeCompare(y.name))[0];
  }
  try {
    const result = await createBooking(
      c,
      { request_id: crypto.randomUUID(), staff_id: barber.id, service_id: service.id, customer_name: b.name, attendee_name: "", phone, email: b.email || "", notes: b.notes ? `Booked by phone (AI receptionist). ${b.notes}` : "Booked by phone (AI receptionist).", date, start_min, addon_ids: [], quote: { service_version: service.version, shop_version: shop.version }, source: "TEST_BOOKING", contact_pref: b.contact_pref || "AUTO" },
      "ONLINE",
      { minStart, maxDate },
    );
    const booking = result.booking;
    const sent = await notifyBooking(c, shop.id, booking, barber.name, "booking_confirmed");
    await alertOwners(c.env.DB, shop.id, "new_booking", booking, { staffName: barber.name, origin: new URL(c.req.url).origin }).catch(() => 0);
    if (b.conversation_id) await c.env.DB.prepare("UPDATE voice_calls SET booking_id=? WHERE shop_id=? AND conversation_id=?").bind(booking.id, shop.id, b.conversation_id).run().catch(() => null);
    const price = money(booking.price_pence, shop.currency);
    const deposit = dueAtBooking(shop, service as Service, booking.price_pence);
    return c.json({
      ok: true,
      booking: customerView(booking, shop, barber.name),
      reference: ref(booking),
      say: `Booked: ${service.name} with ${barber.name.split(" ")[0]} on ${spokenDate(date)} at ${spokenTime(start_min)}, ${price}${deposit ? ` with a ${money(deposit, shop.currency)} deposit payable in the shop` : ""}. Reference ${ref(booking)}.${sent.length ? ` A confirmation is on its way by ${sent.map((s) => (s === "WA" ? "WhatsApp" : s === "SMS" ? "text" : "email")).join(" and ")}.` : ""}`,
      sent_to: sent,
    }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const say = /slot_taken|Slot taken/.test(msg) ? `${spokenTime(start_min)} has just gone. Shall I check another time?` : /outside_booking_window|lead|past/i.test(msg) ? "That time is too soon or too far ahead for me to book." : /closed|hours/i.test(msg) ? `We're not open then on ${spokenDate(date)}.` : "I couldn't save that. Let me try a different time.";
    return c.json({ ok: false, say, error: msg.slice(0, 200) }, 200);
  }
});

voice.get("/:slug/bookings", async (c) => {
  const { shop } = await voiceShop(c);
  const phone = ukPhone(c.req.query("phone") || "");
  if (!phone) return c.json({ ok: false, say: "What mobile number was the booking made with?" }, 200);
  const rows = (await c.env.DB.prepare(
    "SELECT b.*, s.name AS staff_name FROM bookings b JOIN staff s ON s.id=b.staff_id WHERE b.shop_id=? AND b.phone=? AND b.status IN ('CONFIRMED','CHECKED_IN') AND b.start_at>? ORDER BY b.start_at LIMIT 5",
  ).bind(shop.id, phone, Date.now()).all<StoredBooking & { staff_name: string }>()).results;
  const list = rows.map((b) => ({ booking_id: b.id, reference: ref(b), version: b.version, service: b.service_name, barber: b.staff_name, date: b.date, time: spokenTime(b.start_min), when: `${spokenDate(b.date)} at ${spokenTime(b.start_min)}`, name: b.customer_name }));
  return c.json({ ok: true, bookings: list, say: list.length ? `I can see ${list.length === 1 ? "one booking" : `${list.length} bookings`}: ${list.map((b) => `${b.service} with ${b.barber.split(" ")[0]} on ${b.when}`).join("; ")}.` : "I can't find any upcoming bookings on that number." });
});

voice.post("/:slug/cancel", async (c) => {
  const { shop } = await voiceShop(c);
  const b = z.object({ booking_id: z.string().optional(), reference: z.string().optional(), phone: z.string(), conversation_id: z.string().optional() }).passthrough().safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ ok: false, say: "I need the mobile number the booking was made with." }, 200);
  const phone = ukPhone(b.data.phone);
  if (!phone) return c.json({ ok: false, say: "Could you read the mobile number back to me?" }, 200);
  const refDigits = (b.data.reference || "").replace(/\D/g, "");
  const rows = (await c.env.DB.prepare("SELECT b.*, s.name AS staff_name FROM bookings b JOIN staff s ON s.id=b.staff_id WHERE b.shop_id=? AND b.phone=? AND b.status='CONFIRMED' AND b.start_at>? ORDER BY b.start_at").bind(shop.id, phone, Date.now()).all<StoredBooking & { staff_name: string }>()).results;
  const target = rows.find((r) => r.id === b.data.booking_id) || (refDigits ? rows.find((r) => ref(r).replace(/\D/g, "") === refDigits) : null) || (rows.length === 1 ? rows[0] : null);
  if (!target) return c.json({ ok: false, say: rows.length > 1 ? `There are ${rows.length} bookings on that number — which one? ${rows.map((r) => `${r.service_name} on ${spokenDate(r.date)} at ${spokenTime(r.start_min)}`).join("; ")}.` : "I can't find a booking to cancel on that number.", bookings: rows.map((r) => ({ booking_id: r.id, when: `${spokenDate(r.date)} at ${spokenTime(r.start_min)}`, service: r.service_name })) }, 200);
  try {
    const out = await cancelByCustomer(c, shop, target, target.staff_name, { version: target.version });
    return c.json({ ok: true, ...out, say: `Cancelled: ${target.service_name} on ${spokenDate(target.date)} at ${spokenTime(target.start_min)}.${out.late ? ` That was inside our ${target.cancel_hours_snapshot}-hour policy${target.deposit_status === "PAID" ? ", so the deposit is kept" : ""}.` : ""} A confirmation is on its way.` });
  } catch (err) {
    return c.json({ ok: false, say: "I couldn't cancel that just now — the shop can do it when they open.", error: err instanceof Error ? err.message.slice(0, 200) : "error" }, 200);
  }
});

// Something the agent can't do (colour consultation, group of 6, complaint): leave a message for the shop.
voice.post("/:slug/callback", async (c) => {
  const { shop } = await voiceShop(c);
  const b = z.object({ name: z.string().trim().max(80).default(""), phone: z.string().trim().max(30).default(""), note: z.string().trim().min(1).max(600), conversation_id: z.string().optional() }).passthrough().safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ ok: false, say: "What should I tell the shop?" }, 200);
  const now = Date.now();
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO voice_calls(id,shop_id,conversation_id,caller,outcome,summary,transcript,started_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(id, shop.id, b.data.conversation_id || "", ukPhone(b.data.phone) || b.data.phone, "callback", `${b.data.name || "Caller"} asked for a call back: ${b.data.note}`, "", now, now).run();
  const ms = await msgShop(c, shop.id);
  const owner = await c.env.DB.prepare("SELECT u.email FROM shop_owners o JOIN app_users u ON u.id=o.user_id WHERE o.shop_id=?").bind(shop.id).first<{ email: string }>();
  const sh = shop as Shop & { phone?: string; phone_verified_at?: number | null };
  const to = { name: "there", email: owner?.email || "", phone: sh.phone_verified_at ? sh.phone : "" };
  const stmts = enqueue(c.env.DB, ms, to, "owner_callback", { customer: b.data.name || "A caller", phone: ukPhone(b.data.phone) || b.data.phone, note: b.data.note, link: `${new URL(c.req.url).origin}/workspace` }, { related: { type: "voice_call", id }, origin: new URL(c.req.url).origin, force: true }, true);
  if (stmts.length) { await c.env.DB.batch(stmts); await drain(c.env.DB, stmts.length, now, { type: "voice_call", id }).catch(() => 0); }
  return c.json({ ok: true, say: `I've passed that to the team at ${shop.name}; they'll call ${b.data.name || "you"} back${b.data.phone ? ` on ${b.data.phone}` : ""}.` });
});

// ---- ElevenLabs webhooks -----------------------------------------------------------------------------
// Conversation initiation (personalisation): ElevenLabs calls this when a call starts and we return
// dynamic variables + a first message. Auth: same bearer secret (set on the webhook in ElevenLabs).
voice.post("/:slug/personalise", async (c) => {
  const { shop, settings } = await voiceShop(c);
  const body = (await c.req.json().catch(() => ({}))) as { caller_id?: string; conversation_id?: string; agent_id?: string };
  const caller = body.caller_id ? ukPhone(body.caller_id) || body.caller_id : "";
  const { staff, services } = await catalogue(c, shop);
  const today = shopToday(shop.timezone);
  const week = shopWeek(shop);
  const day = week[new Date(today + "T12:00:00Z").getUTCDay()];
  let known = "";
  let upcoming = "";
  if (caller) {
    const cu = await c.env.DB.prepare("SELECT name FROM customers WHERE shop_id=? AND phone=? AND merged_into IS NULL").bind(shop.id, caller).first<{ name: string }>();
    if (cu) known = cu.name;
    const nb = await c.env.DB.prepare("SELECT b.service_name,b.date,b.start_min,s.name AS staff_name FROM bookings b JOIN staff s ON s.id=b.staff_id WHERE b.shop_id=? AND b.phone=? AND b.status='CONFIRMED' AND b.start_at>? ORDER BY b.start_at LIMIT 1").bind(shop.id, caller, Date.now()).first<{ service_name: string; date: string; start_min: number; staff_name: string }>();
    if (nb) upcoming = `${nb.service_name} with ${nb.staff_name.split(" ")[0]} on ${spokenDate(nb.date)} at ${spokenTime(nb.start_min)}`;
  }
  if (body.conversation_id) {
    const now = Date.now();
    await c.env.DB.prepare("INSERT INTO voice_calls(id,shop_id,conversation_id,caller,outcome,started_at,created_at) VALUES(?,?,?,?,'in_progress',?,?) ON CONFLICT(id) DO NOTHING").bind(`${shop.id}:${body.conversation_id}`, shop.id, body.conversation_id, caller, now, now).run().catch(() => null);
  }
  const first = known ? `Hi ${known.split(" ")[0]}, welcome back to ${shop.name}. How can I help?` : settings.greeting || `Hello, you're through to ${shop.name}. How can I help today?`;
  return c.json({
    type: "conversation_initiation_client_data",
    dynamic_variables: {
      shop_name: shop.name, shop_address: shop.address, shop_slug: shop.slug,
      today: spokenDate(today), today_hours: day.enabled ? `${spokenTime(day.starts)} to ${spokenTime(day.ends)}` : "closed today",
      services: services.map((s) => `${s.name} (${s.duration_min} min, ${money(s.price_pence, shop.currency)})`).join("; "),
      barbers: staff.map((s) => s.name).join(", "),
      cancel_hours: String(shop.cancel_hours), caller_phone: caller, caller_name: known, caller_upcoming: upcoming, shop_notes: settings.notes,
    },
    conversation_config_override: { agent: { first_message: first } },
  });
});
// Post-call: transcript + summary → call log, owner can read it in the workspace.
voice.post("/:slug/post-call", async (c) => {
  // Bearer (manual setups) or ElevenLabs HMAC signature (workspace webhook).
  const raw = await c.req.text();
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const settings = voiceOf((shop as Shop & { voice_json?: string }).voice_json);
  if (!settings.enabled || !settings.secret) fail(404, "This shop has no AI receptionist");
  const given = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const bearerOk = !!given && timingSafeEqual(given, settings.secret);
  if (!bearerOk && !(await elevenSignatureOk(c.req.header("elevenlabs-signature"), raw, settings.webhook_secret))) fail(401, "Webhook signature is wrong or missing");
  let body: { type?: string; data?: { conversation_id?: string; agent_id?: string; status?: string; transcript?: { role: string; message: string | null; time_in_call_secs?: number }[]; metadata?: { start_time_unix_secs?: number; call_duration_secs?: number; phone_call?: { external_number?: string } }; analysis?: { transcript_summary?: string; call_successful?: string } } } = {};
  try { body = JSON.parse(raw); } catch { body = {}; }
  const d = body.data;
  if (!d?.conversation_id) return c.json({ ok: true, ignored: true });
  // Row id is shop-scoped: ElevenLabs conversation ids are unique per account, but every shop is its own tenant here.
  const transcript = (d.transcript || []).filter((t) => t.message).map((t) => `${t.role === "agent" ? "Receptionist" : "Caller"}: ${t.message}`).join("\n").slice(0, 20000);
  const caller = d.metadata?.phone_call?.external_number ? ukPhone(d.metadata.phone_call.external_number) || d.metadata.phone_call.external_number : "";
  const started = d.metadata?.start_time_unix_secs ? d.metadata.start_time_unix_secs * 1000 : Date.now();
  const outcome = d.analysis?.call_successful === "success" ? "handled" : d.analysis?.call_successful === "failure" ? "unresolved" : "ended";
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO voice_calls(id,shop_id,conversation_id,caller,outcome,summary,transcript,duration_s,started_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET caller=CASE WHEN voice_calls.caller='' THEN EXCLUDED.caller ELSE voice_calls.caller END, outcome=EXCLUDED.outcome, summary=EXCLUDED.summary, transcript=EXCLUDED.transcript, duration_s=EXCLUDED.duration_s`,
  ).bind(`${shop.id}:${d.conversation_id}`, shop.id, d.conversation_id, caller, outcome, (d.analysis?.transcript_summary || "").slice(0, 2000), transcript, d.metadata?.call_duration_secs || 0, started, now).run();
  return c.json({ ok: true });
});

export default voice;

// ---- Owner settings (mounted under /api/app by sandbox.ts) --------------------------------------
export const voiceSettingsSchema = z.object({
  enabled: z.boolean(),
  agent_id: z.string().trim().max(120).default(""),
  greeting: z.string().trim().max(300).default(""),
  notes: z.string().trim().max(1500).default(""),
  // ElevenLabs post-call webhook secret (wsec_…). Optional; omit to leave unchanged.
  webhook_secret: z.string().trim().max(200).optional(),
}).strict();

export function voiceEndpoints(origin: string, slug: string) {
  const b = `${origin}/api/voice/${slug}`;
  return {
    info: { method: "GET", url: `${b}/info` },
    availability: { method: "GET", url: `${b}/availability`, query: ["service", "date", "barber?", "time?"] },
    book: { method: "POST", url: `${b}/book`, body: ["name", "phone", "service", "date", "time", "barber?", "email?", "notes?", "contact_pref?"] },
    bookings: { method: "GET", url: `${b}/bookings`, query: ["phone"] },
    cancel: { method: "POST", url: `${b}/cancel`, body: ["phone", "reference?", "booking_id?"] },
    callback: { method: "POST", url: `${b}/callback`, body: ["name", "phone", "note"] },
    personalise_webhook: { method: "POST", url: `${b}/personalise` },
    post_call_webhook: { method: "POST", url: `${b}/post-call` },
  };
}

// System prompt the owner pastes into the ElevenLabs agent (dynamic variables filled by /personalise).
export function agentPrompt(shopName: string) {
  return `You are the friendly receptionist for ${shopName}, a barbershop. Speak naturally and briefly, like a real front-desk person. Never invent availability, prices or policies — always use the tools.

Context for this call: today is {{today}}; we are open {{today_hours}}. Services: {{services}}. Barbers: {{barbers}}. Cancellation policy: {{cancel_hours}} hours' notice. Caller's number: {{caller_phone}}. Known customer: {{caller_name}}. Their next booking: {{caller_upcoming}}. Shop notes: {{shop_notes}}.

To book: find out the service, the day, roughly what time, and whether they want a particular barber. Call check_availability, offer two or three times, then collect their name and confirm the mobile number (use {{caller_phone}} if they say "this number"). Ask whether they'd like the confirmation by text or WhatsApp. Read the details back once, then call book_appointment and tell them the reference.
To cancel or check a booking: ask for the mobile number, call find_bookings, confirm which one, then cancel_booking. Mention the cancellation policy if it applies.
If you cannot help (walk-in questions you can't answer, complaints, group bookings over four, anything about payments), call request_callback with a short note and reassure them the team will ring back.
Keep answers to one or two sentences. Confirm dates as day and date. Use 12-hour times.`;
}
