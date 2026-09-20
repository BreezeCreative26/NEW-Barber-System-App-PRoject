// WhatsApp via Infobip — one OLLO sender shared by every shop. The shop's name is the first
// placeholder in every template, so "Fade Society: you're booked…" arrives from OLLO's number.
//
// Meta's rules shape everything here:
//   - a business may only *start* a conversation with an approved template (fixed wording, {{n}}
//     slots). Free text is allowed only inside the 24 h after the customer last messaged us.
//   - a customer must have opted in (they choose WhatsApp at booking / in their account).
//   - STOP-style replies opt the number out platform-wide (wa_optouts).
// Env: INFOBIP_API_KEY, INFOBIP_BASE_URL (default api.infobip.com), INFOBIP_WA_SENDER (E.164 digits).
// With no key the channel is "preview": rows are recorded with provider 'mailbox' like SMS/email.
import type { Database as DB } from "../db/client";
import type { MessageTemplate } from "./messaging";

type Env = { INFOBIP_API_KEY?: string; INFOBIP_BASE_URL?: string; INFOBIP_WA_SENDER?: string; INFOBIP_WEBHOOK_KEY?: string };
const env = (): Env => (typeof process !== "undefined" ? (process.env as Env) : {});
export const waLive = () => !!(env().INFOBIP_API_KEY && env().INFOBIP_WA_SENDER);
export const waSender = () => (env().INFOBIP_WA_SENDER || "").replace(/\D/g, "");
// Webhook guard: when INFOBIP_WEBHOOK_KEY is set, Infobip must send it as `?key=` or X-Ollo-Webhook.
export function waWebhookOk(queryKey?: string, headerKey?: string) {
  const want = env().INFOBIP_WEBHOOK_KEY;
  if (!want) return true;
  return queryKey === want || headerKey === want;
}
// Infobip's shared test sender: only reaches phones that texted the keyword first; stock templates only.
export const waIsTestSender = () => waSender() === "447860088970";
export function waStatus() {
  return { provider: waLive() ? ("infobip" as const) : ("mailbox" as const), sender: waSender() ? `+${waSender()}` : "", test_sender: waIsTestSender(), keyword: waIsTestSender() ? "OLLOSOFTWAREIO" : "" };
}
const base = () => `https://${(env().INFOBIP_BASE_URL || "api.infobip.com").replace(/^https?:\/\//, "")}`;
async function infobip<T>(path: string, body?: unknown, method = body ? "POST" : "GET"): Promise<{ ok: boolean; status: number; json: T }> {
  const res = await fetch(`${base()}${path}`, { method, headers: { Authorization: `App ${env().INFOBIP_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, json };
}

// ---- OLLO's template set -----------------------------------------------------------------------
// Names as registered on the OLLO sender (scripts/whatsapp-templates.mjs submits these). Body text
// must match what Meta approved, so the copy lives here, not in messaging.ts. {{1}} is always the
// shop name; the manage/book link is a URL button with a dynamic suffix where allowed.
export type WaTemplate = { name: string; category: "UTILITY" | "AUTHENTICATION" | "MARKETING"; body: string; footer?: string; button?: { text: string; urlBase: string }; placeholders: string[] };
export const WA_TEMPLATES: Record<string, WaTemplate> = {
  booking_confirmed: { name: "ollo_booking_confirmed", category: "UTILITY", body: "{{1}}: you're booked — {{2}} with {{3}}, {{4}}. Ref {{5}}. Reply to this message if you need anything.", footer: "Move or cancel from the link below.", button: { text: "Manage booking", urlBase: "{{origin}}/manage/" }, placeholders: ["shop", "service", "barber", "when", "ref"] },
  booking_moved: { name: "ollo_booking_moved", category: "UTILITY", body: "{{1}}: your appointment has moved to {{2}} — {{3}} with {{4}}. Ref {{5}}.", button: { text: "Manage booking", urlBase: "{{origin}}/manage/" }, placeholders: ["shop", "when", "service", "barber", "ref"] },
  booking_cancelled: { name: "ollo_booking_cancelled", category: "UTILITY", body: "{{1}}: your appointment on {{2}} has been cancelled. {{3}}", button: { text: "Book again", urlBase: "{{origin}}/book/" }, placeholders: ["shop", "when", "note"] },
  booking_reminder: { name: "ollo_booking_reminder", category: "UTILITY", body: "{{1}}: reminder — {{2}} with {{3}} tomorrow at {{4}}. Ref {{5}}.", button: { text: "Manage booking", urlBase: "{{origin}}/manage/" }, placeholders: ["shop", "service", "barber", "time", "ref"] },
  booking_reminder_soon: { name: "ollo_booking_reminder_soon", category: "UTILITY", body: "{{1}}: see you at {{2}} today — {{3}} with {{4}}.", placeholders: ["shop", "time", "service", "barber"] },
  signin_code: { name: "ollo_code", category: "AUTHENTICATION", body: "{{1}} is your {{2}} code. It expires in 10 minutes.", placeholders: ["code", "shop"] },
  verify_contact: { name: "ollo_code", category: "AUTHENTICATION", body: "{{1}} is your {{2}} code. It expires in 10 minutes.", placeholders: ["code", "shop"] },
  waitlist_offer: { name: "ollo_waitlist_offer", category: "UTILITY", body: "{{1}}: a time has opened up — {{2}} with {{3}}. It's yours for {{4}} minutes.", button: { text: "Take it", urlBase: "{{origin}}/offer/" }, placeholders: ["shop", "when", "barber", "hold"] },
  pay_link: { name: "ollo_pay_link", category: "UTILITY", body: "{{1}}: pay {{2}} for today's visit securely by card. The link is valid for 30 minutes.", button: { text: "Pay now", urlBase: "{{origin}}/pay/" }, placeholders: ["shop", "amount"] },
  staff_invite: { name: "ollo_team_invite", category: "UTILITY", body: "{{1}}: {{2}} has invited you to join the team on the booking system.", button: { text: "Accept invitation", urlBase: "{{origin}}/workspace?invite=" }, placeholders: ["shop", "inviter"] },
  password_reset: { name: "ollo_password_reset", category: "AUTHENTICATION", body: "{{1}}: reset your booking system password with the button below. It works for 30 minutes.", button: { text: "Reset password", urlBase: "{{origin}}/reset?token=" }, placeholders: ["shop"] },
};
// Infobip's stock templates, usable on the shared test sender before OLLO's own are approved.
const STOCK: Partial<Record<string, { name: string; map: (v: Record<string, string>) => string[] }>> = {
  booking_reminder: { name: "appointment_reminder", map: (v) => [v.first || "there", v.date || v.when || "", v.time || ""] },
  booking_reminder_soon: { name: "appointment_reminder", map: (v) => [v.first || "there", "today", v.time || ""] },
  booking_confirmed: { name: "appointment_reminder", map: (v) => [v.first || "there", v.date || v.when || "", v.time || ""] },
  booking_moved: { name: "appointment_reminder", map: (v) => [v.first || "there", v.date || v.when || "", v.time || ""] },
  signin_code: { name: "authentication", map: (v) => [v.code || ""] },
  verify_contact: { name: "authentication", map: (v) => [v.code || ""] },
};

export type WaPayload = { template: string; placeholders: string[]; buttonSuffix?: string; language?: string; stock?: boolean; fallback: string };
// Build what to send for an OLLO message. `vars` are the same vars messaging.ts renders SMS from;
// `fallback` is the SMS text, used for free-text replies inside the 24 h window.
export function waPayload(template: MessageTemplate, vars: Record<string, unknown>, shopName: string, smsText: string): WaPayload | null {
  const v = Object.fromEntries(Object.entries(vars).map(([k, x]) => [k, x == null ? "" : String(x)]));
  const when = [v.date, v.time].filter(Boolean).join(" at ");
  if (waIsTestSender()) {
    const s = STOCK[template];
    if (!s) return null;
    return { template: s.name, placeholders: s.map({ ...v, when }), language: template.includes("code") || template === "verify_contact" ? "en_GB" : "en", stock: true, fallback: smsText };
  }
  const t = WA_TEMPLATES[template];
  if (!t) return null;
  const link = (v.link || v.book_link || "").toString();
  const suffix = link ? link.replace(/^https?:\/\/[^/]+\/(manage|book|offer|pay)\//, "").replace(/^https?:\/\/[^/]+\/workspace\?invite=/, "").replace(/^https?:\/\/[^/]+\/reset\?token=/, "") : "";
  const map: Record<string, string> = { shop: shopName, service: v.service, barber: v.barber, when, time: v.time, ref: v.ref, note: v.note || "", code: v.code, hold: v.hold_min || v.hold || "120", amount: v.amount || v.price || "", inviter: v.inviter || "" };
  return { template: t.name, placeholders: t.placeholders.map((p) => map[p] ?? ""), buttonSuffix: t.button ? suffix : undefined, language: "en_GB", fallback: smsText };
}

// ---- Sending -------------------------------------------------------------------------------------
export type WaDelivery = { ok: true; provider: string; id: string } | { ok: false; provider: string; error: string; permanent?: boolean };
export async function sendWhatsApp(db: DB, to: string, payload: WaPayload): Promise<WaDelivery> {
  const phone = to.replace(/\D/g, "");
  // A STOP is honoured in every mode — the preview mailbox included — so the text fallback path is the same everywhere.
  const opted = await db.prepare("SELECT 1 AS x FROM wa_optouts WHERE phone=?").bind(phone).first();
  if (opted) return { ok: false, provider: waLive() ? "infobip" : "mailbox", error: "Customer opted out of WhatsApp (replied STOP)", permanent: true };
  if (!waLive()) return { ok: true, provider: "mailbox", id: `mbx_${crypto.randomUUID().slice(0, 8)}` };
  // Inside the customer-service window (they messaged us < 24 h ago) plain text is allowed and
  // reads better than a template.
  const recent = await db.prepare("SELECT 1 AS x FROM wa_inbound WHERE phone=? AND received_at>?").bind(phone, Date.now() - 23.5 * 3600000).first();
  const from = waSender();
  if (recent) {
    const r = await infobip<{ messages?: { messageId: string; status: { groupName: string; description: string } }[]; requestError?: { serviceException?: { text?: string } } }>("/whatsapp/1/message/text", { from, to: phone, content: { text: payload.fallback } });
    return result(r);
  }
  const body: Record<string, unknown> = {
    messages: [{
      from, to: phone,
      content: { templateName: payload.template, templateData: { body: { placeholders: payload.placeholders }, ...(payload.buttonSuffix !== undefined ? { buttons: [{ type: "URL", parameter: payload.buttonSuffix }] } : {}) }, language: payload.language || "en_GB" },
    }],
  };
  const r = await infobip<{ messages?: { messageId: string; status: { groupName: string; description: string } }[]; requestError?: { serviceException?: { text?: string } } }>("/whatsapp/1/message/template", body);
  return result(r);
}
function result(r: { ok: boolean; status: number; json: { messages?: { messageId: string; status: { groupName: string; description: string } }[]; requestError?: { serviceException?: { text?: string } } } }): WaDelivery {
  const m = r.json.messages?.[0];
  if (r.ok && m && m.status.groupName !== "REJECTED") return { ok: true, provider: "infobip", id: m.messageId };
  const text = m?.status.description || r.json.requestError?.serviceException?.text || `Infobip ${r.status}`;
  // Not on WhatsApp / not opted in to the test sender / bad number: don't retry.
  return { ok: false, provider: "infobip", error: text, permanent: r.status === 400 || /not.*whatsapp|invalid.*destination|unknown.*number|opted|template.*not/i.test(text) };
}

// ---- Webhooks --------------------------------------------------------------------------------------
// Delivery reports: POST /api/whatsapp/status  ({results:[{messageId,status:{groupName,...},error}]})
export async function applyDeliveryReports(db: DB, body: unknown) {
  const results = ((body as { results?: unknown[] })?.results ?? []) as { messageId: string; to?: string; status?: { groupName?: string; name?: string; description?: string }; error?: { name?: string; description?: string; permanent?: boolean } }[];
  let n = 0;
  for (const r of results) {
    const g = r.status?.groupName || "";
    if (g === "DELIVERED") await db.prepare("UPDATE notifications SET status_note=? WHERE provider_id=? AND channel='WA'").bind(`Delivered${r.status?.description ? ` · ${r.status.description}` : ""}`, r.messageId).run();
    else if (g === "REJECTED" || g === "UNDELIVERABLE" || g === "EXPIRED") await db.prepare("UPDATE notifications SET status='FAILED', error=?, status_note=? WHERE provider_id=? AND channel='WA'").bind((r.error?.description || r.status?.description || g).slice(0, 400), "WhatsApp could not deliver", r.messageId).run();
    else continue;
    n++;
  }
  return n;
}
// Inbound: POST /api/whatsapp/inbound ({results:[{from,to,messageId,message:{type,text},receivedAt}]})
const STOP = /^\s*(stop|unsubscribe|opt ?out|cancel all|no more)\b/i;
const START = /^\s*(start|unstop|subscribe|yes)\b/i;
export async function applyInbound(db: DB, body: unknown) {
  const results = ((body as { results?: unknown[] })?.results ?? []) as { from: string; to?: string; messageId?: string; message?: { type?: string; text?: string; caption?: string }; receivedAt?: string; contact?: { name?: string } }[];
  let n = 0;
  for (const r of results) {
    const phone = (r.from || "").replace(/\D/g, "");
    if (!phone) continue;
    const text = (r.message?.text || r.message?.caption || `[${r.message?.type || "message"}]`).slice(0, 2000);
    const now = r.receivedAt ? Date.parse(r.receivedAt) || Date.now() : Date.now();
    // Attribute to the shop that last messaged this number.
    // Recipients are stored as typed (07700… or +447700…); Infobip reports E.164 digits (447700…).
    const national = phone.startsWith("44") ? "0" + phone.slice(2) : phone;
    const last = await db.prepare("SELECT shop_id FROM notifications WHERE channel='WA' AND regexp_replace(recipient,'\\D','','g') IN (?,?) ORDER BY created_at DESC LIMIT 1").bind(phone, national).first<{ shop_id: string }>();
    await db.prepare("INSERT INTO wa_inbound(id,shop_id,phone,body,provider_id,received_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING").bind(r.messageId || crypto.randomUUID(), last?.shop_id ?? null, phone, text, r.messageId || "", now).run();
    if (STOP.test(text)) await db.prepare("INSERT INTO wa_optouts(phone,reason,created_at) VALUES(?,?,?) ON CONFLICT(phone) DO NOTHING").bind(phone, text.slice(0, 40), now).run();
    else if (START.test(text)) await db.prepare("DELETE FROM wa_optouts WHERE phone=?").bind(phone).run();
    n++;
  }
  return n;
}

// ---- Templates admin (used by scripts/whatsapp-templates.mjs and Settings status) ------------------
export async function listSenderTemplates() {
  if (!waLive()) return [];
  const r = await infobip<{ templates?: { name: string; language: string; status: string; category: string }[] }>(`/whatsapp/2/senders/${waSender()}/templates`);
  return r.json.templates ?? [];
}
export async function templateStatus() {
  const have = await listSenderTemplates();
  const mine = new Set(Object.values(WA_TEMPLATES).map((t) => t.name));
  return Object.values(WA_TEMPLATES).filter((t, i, a) => a.findIndex((x) => x.name === t.name) === i).map((t) => ({ name: t.name, status: have.find((h) => h.name === t.name)?.status || (waIsTestSender() ? "TEST_SENDER" : "NOT_SUBMITTED") })).filter((x) => mine.has(x.name));
}
