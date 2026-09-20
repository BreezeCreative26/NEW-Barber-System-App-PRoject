// Messaging: the outbox becomes a real delivery queue.
//
// enqueue()  — render a shop-branded message (SMS text + email subject/HTML) and write it QUEUED.
// drain()    — deliver due rows through the configured providers with retry/backoff; safe to run
//              concurrently (rows are claimed with an UPDATE … WHERE status='QUEUED').
// sweepReminders() — queue 24h (configurable) and 2h reminders for upcoming confirmed visits.
//
// Providers are platform-level and come from env: RESEND_API_KEY (+ MAIL_FROM); SMS via ClickSend
// (CLICKSEND_USERNAME + CLICKSEND_API_KEY, optional CLICKSEND_FROM) or Twilio (TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN, TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID). With no provider configured the
// row is delivered to the "dev mailbox" (status SENT, provider 'mailbox') so the whole flow can be
// exercised locally and in tests; the mailbox is readable under /api/app/dev/mailbox when
// DEMO_ENABLED=1.
//
// Rule 7 (DIRECTION.md): every message carries the shop's name, logo and accent. OLLO does not appear.
import type { Context } from "hono";
import type { Database } from "../db/client";
import type { AppEnv } from "./accounts";
import type { Shop, ShopBrand } from "./domain";
import { brandOf } from "./domain";
import { expireHolds } from "./stripe";
import { scheduledPayRuns } from "./payouts";
import { expireRequests } from "./chair";
import { sweepDailySummaries } from "./alerts";

type Ctx = Context<AppEnv>;
type DB = Database;
const uid = () => crypto.randomUUID();

export type MsgShop = Shop & {
  msg_sms?: number; msg_email?: number; msg_reminders?: number; msg_reminder_hours?: number; msg_reply_to?: string; msg_sms_sender?: string;
  notify_json?: string;
  logo_url?: string; accent?: string; theme_json?: string;
  email?: string; phone?: string; // from shop_pages when joined
};
export type Recipient = { name?: string; phone?: string; email?: string };

// ---- Template catalogue --------------------------------------------------------
export const MESSAGE_TEMPLATES = [
  "booking_confirmed", "booking_moved", "booking_cancelled", "booking_reminder", "booking_reminder_soon",
  "signin_code", "staff_invite", "waitlist_joined", "waitlist_offer", "waitlist_booked", "waitlist_released", "review_request", "test_message", "pay_link",
  "verify_contact", "password_reset", "owner_new_booking", "owner_cancelled", "owner_no_show", "owner_daily_summary",
] as const;
export type MessageTemplate = (typeof MESSAGE_TEMPLATES)[number];

export type MessageVars = Record<string, string | number | null | undefined>;

type Rendered = { sms: string; subject: string; heading: string; lines: string[]; cta?: { label: string; href: string }; footnote?: string };

const first = (name?: string | null) => (name || "").trim().split(/\s+/)[0] || "there";
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Copy for each template. SMS is short and link-first; email gets a heading, lines and a button.
export function copyFor(template: MessageTemplate, v: MessageVars, shop: { name: string }): Rendered {
  const s = shop.name;
  const who = first(v.first as string);
  const when = [v.date, v.time].filter(Boolean).join(" at ");
  switch (template) {
    case "booking_confirmed":
      return {
        sms: `${s}: you're booked — ${v.service} with ${v.barber}, ${when}. Ref ${v.ref}. Move or cancel: ${v.link}`,
        subject: `You're booked at ${s} — ${v.date}`,
        heading: who !== "there" ? `See you ${v.date}, ${who}.` : `See you ${v.date}.`,
        lines: [`${v.service} with ${v.barber}`, `${when}`, v.address ? String(v.address) : "", v.price ? `${v.price} · ${v.deposit_note || "pay in the shop"}` : "", `Reference ${v.ref}`].filter(Boolean),
        cta: { label: "View, move or cancel", href: String(v.link) },
        footnote: v.cancel_hours ? `Plans change — move or cancel online up to ${v.cancel_hours} hours before.` : undefined,
      };
    case "booking_moved":
      return {
        sms: `${s}: your visit has moved — ${v.service} with ${v.barber} is now ${when}. Ref ${v.ref}. ${v.link}`,
        subject: `Your visit at ${s} has moved to ${v.date}`,
        heading: `New time: ${when}.`,
        lines: [`${v.service} with ${v.barber}`, `Reference ${v.ref}`],
        cta: { label: "View your visit", href: String(v.link) },
      };
    case "booking_cancelled":
      return {
        sms: `${s}: your ${v.service} on ${when} is cancelled. Ref ${v.ref}. Book again: ${v.book_link}`,
        subject: `Your visit at ${s} on ${v.date} is cancelled`,
        heading: `Cancelled: ${v.service}, ${when}.`,
        lines: [`Reference ${v.ref}`, "Nothing else to do. Whenever you're ready, book again below."],
        cta: { label: `Book again at ${s}`, href: String(v.book_link) },
      };
    case "booking_reminder":
      return {
        sms: `${s}: reminder — ${v.service} with ${v.barber} tomorrow, ${when}. Need to change it? ${v.link}`,
        subject: `Tomorrow at ${s}: ${v.service}, ${v.time}`,
        heading: `Tomorrow, ${v.time}.`,
        lines: [`${v.service} with ${v.barber}`, v.address ? String(v.address) : "", `Reference ${v.ref}`].filter(Boolean),
        cta: { label: "View, move or cancel", href: String(v.link) },
      };
    case "booking_reminder_soon":
      return {
        sms: `${s}: see you at ${v.time} today for your ${v.service} with ${v.barber}. ${v.address || ""}`.trim(),
        subject: `Today at ${v.time}: ${s}`,
        heading: `See you at ${v.time}.`,
        lines: [`${v.service} with ${v.barber}`, v.address ? String(v.address) : ""].filter(Boolean),
        cta: { label: "Directions", href: String(v.map_link || v.link) },
      };
    case "signin_code":
      return {
        sms: `${s}: your sign-in code is ${v.code}. It expires in 10 minutes.`,
        subject: `${v.code} is your ${s} sign-in code`,
        heading: `${v.code}`,
        lines: ["Enter this code to see your visits. It expires in 10 minutes.", "If you didn't ask for it, ignore this message."],
      };
    case "staff_invite":
      return {
        sms: `${s}: ${v.inviter} has invited you to join the team on the booking system. Accept: ${v.link}`,
        subject: `Join ${s} on its booking system`,
        heading: `${v.inviter} has invited you to ${s}.`,
        lines: [`Role: ${v.role}`, "Accept the invitation to see your calendar, customers and pay."],
        cta: { label: "Accept invitation", href: String(v.link) },
      };
    case "waitlist_joined":
      return {
        sms: `${s}: you're on the list for ${v.date} (${v.daypart}). We'll message you if a time opens up.`,
        subject: `You're on the list at ${s} for ${v.date}`,
        heading: `On the list for ${v.date}.`,
        lines: [`${v.service}${v.barber ? ` with ${v.barber}` : ""}, ${v.daypart}`, "We'll message you as soon as a time opens up."],
      };
    case "waitlist_offer":
      return {
        sms: `${s}: a ${v.service} with ${v.barber} has opened on ${when}. Held for you until ${v.expires}: ${v.link}`,
        subject: `A time has opened at ${s}: ${when}`,
        heading: `${when} is yours if you want it.`,
        lines: [`${v.service} with ${v.barber}`, `Held until ${v.expires}.`],
        cta: { label: "Take this time", href: String(v.link) },
      };
    case "waitlist_booked":
      return {
        sms: `${s}: you're booked — ${v.service} with ${v.barber}, ${when}. Ref ${v.ref}. Manage: ${v.link}`,
        subject: `You're booked at ${s} — ${v.date}`,
        heading: `Booked: ${when}.`,
        lines: [`${v.service} with ${v.barber}`, `Reference ${v.ref}`],
        cta: { label: "View, move or cancel", href: String(v.link) },
      };
    case "waitlist_released":
      return {
        sms: `${s}: no problem — you're back on the list for ${v.date}.`,
        subject: `Back on the list at ${s}`,
        heading: `Back on the list for ${v.date}.`,
        lines: ["We'll message you if another time opens up."],
      };
    case "review_request":
      return {
        sms: `Thanks for coming in, ${who}. How was your ${v.service} with ${v.barber} at ${s}? Leave a quick rating: ${v.link}`,
        subject: `How was your visit to ${s}?`,
        heading: `Thanks for coming in, ${who}.`,
        lines: [`How was your ${v.service} with ${v.barber}? A quick rating helps the team and other customers.`],
        cta: { label: "Leave a rating", href: String(v.link) },
      };
    case "pay_link":
      return {
        sms: `${s}: pay ${v.amount} for your ${v.service} by card here: ${v.link}`,
        subject: `Pay ${v.amount} to ${s}`,
        heading: `${v.amount} for your ${v.service}`,
        lines: ["Tap the button to pay by card. The link is valid for 30 minutes."],
        cta: { label: `Pay ${v.amount}`, href: v.link as string },
      };
    case "test_message":
      return {
        sms: `${s}: this is a test message from your booking system. Messages are working.`,
        subject: `Test message from ${s}`,
        heading: "Messages are working.",
        lines: ["This is a test from your booking system's Settings → Messages panel.", `Sent ${new Date().toLocaleString("en-GB")}.`],
      };
    // ---- Shop-side (owner/manager) messages. Same branding rule: the shop's name, never OLLO. ----
    case "verify_contact":
      return {
        sms: `${s}: ${v.code} is your verification code. It expires in 10 minutes.`,
        subject: `${v.code} is your ${s} verification code`,
        heading: `${v.code}`,
        lines: [`Enter this code to confirm this is ${s}'s ${v.kind === "PHONE" ? "mobile number" : "email address"}. It expires in 10 minutes.`, "If you didn't ask for it, ignore this message."],
      };
    case "password_reset":
      return {
        sms: `${s}: reset your booking system password here (30 min): ${v.link}`,
        subject: `Reset your ${s} password`,
        heading: "Reset your password.",
        lines: ["Someone asked to reset the password for this address. If it was you, use the button below within 30 minutes.", "If it wasn't you, ignore this message — your password has not changed."],
        cta: { label: "Choose a new password", href: String(v.link) },
      };
    case "owner_new_booking":
      return {
        sms: `${s}: new booking — ${v.customer}, ${v.service} with ${v.barber}, ${when}. Ref ${v.ref}.`,
        subject: `New booking: ${v.customer} · ${when}`,
        heading: `${v.customer} booked online.`,
        lines: [`${v.service} with ${v.barber}`, `${when} · ref ${v.ref}`, v.deposit ? `Deposit: ${v.deposit}` : ""].filter(Boolean),
        cta: v.link ? { label: "Open the calendar", href: String(v.link) } : undefined,
      };
    case "owner_cancelled":
      return {
        sms: `${s}: ${v.customer} cancelled ${v.service} with ${v.barber}, ${when}. Ref ${v.ref}.${v.deposit ? ` Deposit ${v.deposit}.` : ""}`,
        subject: `Cancelled: ${v.customer} · ${when}`,
        heading: `${v.customer} cancelled.`,
        lines: [`${v.service} with ${v.barber}`, `${when} · ref ${v.ref}`, v.deposit ? `Deposit: ${v.deposit}` : "", v.waitlist ? `${v.waitlist} on the waitlist for that day.` : ""].filter(Boolean),
        cta: v.link ? { label: "Open the calendar", href: String(v.link) } : undefined,
      };
    case "owner_no_show":
      return {
        sms: `${s}: no-show — ${v.customer}, ${v.service} with ${v.barber}, ${when}.`,
        subject: `No-show: ${v.customer} · ${when}`,
        heading: `${v.customer} didn't turn up.`,
        lines: [`${v.service} with ${v.barber}`, `${when} · ref ${v.ref}`, v.count ? `That's ${v.count} no-shows from this customer.` : ""].filter(Boolean),
      };
    case "owner_daily_summary":
      return {
        sms: `${s} today: ${v.count} booked, first at ${v.first_time}, ${v.online} online. ${v.gaps ? `${v.gaps} free slots.` : "Full day."}`,
        subject: `${s} — today, ${v.date}`,
        heading: `${v.count} visits today.`,
        lines: [`First at ${v.first_time}, last at ${v.last_time}.`, `${v.online} booked online, ${v.walkin} in the shop.`, `${v.gaps ? `${v.gaps} slots still free.` : "No gaps."}`, v.deposits ? `Deposits taken: ${v.deposits}.` : ""].filter(Boolean),
        cta: v.link ? { label: "Open today", href: String(v.link) } : undefined,
      };
  }
}

// ---- Email shell (shop-branded, inline CSS, dark-safe) ---------------------------
const ACCENTS: Record<string, { bg: string; ink: string }> = {
  ollo: { bg: "#4a5fd9", ink: "#ffffff" }, ink: { bg: "#1d1f26", ink: "#ffffff" }, sage: { bg: "#3f7d5c", ink: "#ffffff" },
  clay: { bg: "#a8552f", ink: "#ffffff" }, plum: { bg: "#6e3b7a", ink: "#ffffff" }, slate: { bg: "#4a5568", ink: "#ffffff" },
};
export function emailHtml(shop: { name: string; address?: string; slug?: string | null }, brand: ShopBrand, origin: string, r: Rendered, footer: { phone?: string; email?: string; unsubscribe?: string }) {
  const a = ACCENTS[brand.accent] || ACCENTS.ollo;
  const logo = brand.logo_url ? `<img src="${esc(brand.logo_url.startsWith("http") ? brand.logo_url : origin + brand.logo_url)}" alt="${esc(shop.name)}" height="40" style="height:40px;max-width:180px;object-fit:contain;display:block" />` : `<div style="display:inline-block;width:40px;height:40px;border-radius:10px;background:${a.bg};color:${a.ink};font:700 16px/40px -apple-system,Segoe UI,Inter,Arial,sans-serif;text-align:center">${esc(shop.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase())}</div>`;
  const lines = r.lines.map((l) => `<p style="margin:0 0 8px;font:15px/1.5 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#3c3f48">${esc(l)}</p>`).join("");
  const cta = r.cta ? `<a href="${esc(r.cta.href)}" style="display:inline-block;margin:18px 0 6px;padding:13px 22px;border-radius:10px;background:${a.bg};color:${a.ink};font:600 15px -apple-system,Segoe UI,Inter,Arial,sans-serif;text-decoration:none">${esc(r.cta.label)}</a><p style="margin:6px 0 0;font:12px/1.5 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#8a8f9c;word-break:break-all">${esc(r.cta.href)}</p>` : "";
  const foot = [shop.name, shop.address, footer.phone, footer.email].filter(Boolean).map(esc).join(" · ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(r.subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f6fb">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6fb"><tr><td align="center" style="padding:28px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="padding:24px 28px 0">${logo}</td></tr>
<tr><td style="padding:20px 28px 0"><h1 style="margin:0 0 14px;font:700 24px/1.2 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#14151a;letter-spacing:-0.02em">${esc(r.heading)}</h1>${lines}${cta}${r.footnote ? `<p style="margin:16px 0 0;font:13px/1.5 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#6b6f7a">${esc(r.footnote)}</p>` : ""}</td></tr>
<tr><td style="padding:24px 28px 26px"><p style="margin:0;font:12px/1.6 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#8a8f9c">${foot}</p></td></tr>
</table>
<p style="margin:14px 0 0;font:11px -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#a4a6ae">Sent by ${esc(shop.name)}${footer.unsubscribe ? ` · <a href="${esc(footer.unsubscribe)}" style="color:#a4a6ae">Stop these emails</a>` : ""}</p>
</td></tr></table></body></html>`;
}

// ---- Enqueue -------------------------------------------------------------------
// `force`: shop-side messages (verification codes, password resets, owner alerts) ignore the shop's
// customer-facing SMS/email toggles — those switches are about what customers receive.
export type EnqueueOpts = { related: { type: string; id: string }; channel?: "SMS" | "EMAIL" | "AUTO"; origin: string; now?: number; force?: boolean };

// Channel choice: SMS when we have a mobile and the shop sends SMS; email when we have an address
// and the shop sends email; both when the shop wants both and we have both (confirmations).
export function channelsFor(shop: MsgShop, to: Recipient, prefer: "SMS" | "EMAIL" | "AUTO" = "AUTO", both = false, force = false): ("SMS" | "EMAIL")[] {
  const sms = !!to.phone && (force || (shop.msg_sms ?? 1) === 1);
  const email = !!to.email && (force || (shop.msg_email ?? 1) === 1);
  if (prefer === "SMS") return sms ? ["SMS"] : email ? ["EMAIL"] : [];
  if (prefer === "EMAIL") return email ? ["EMAIL"] : sms ? ["SMS"] : [];
  if (both && sms && email) return ["SMS", "EMAIL"];
  return sms ? ["SMS"] : email ? ["EMAIL"] : [];
}

// Returns prepared statements so callers can batch them with their own writes.
export function enqueue(db: DB, shop: MsgShop, to: Recipient, template: MessageTemplate, vars: MessageVars, opts: EnqueueOpts, both = template === "booking_confirmed") {
  const now = opts.now ?? Date.now();
  const brand = brandOf(shop);
  const r = copyFor(template, { first: to.name, ...vars }, shop);
  const html = emailHtml(shop, brand, opts.origin, r, { phone: shop.phone, email: shop.email });
  const out = [];
  for (const channel of channelsFor(shop, to, opts.channel || "AUTO", both, opts.force)) {
    out.push(
      db.prepare(
        "INSERT INTO notifications(id,shop_id,channel,recipient,template,body,subject,html,status,status_note,related_type,related_id,created_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,'QUEUED','',?,?,?,?) ON CONFLICT DO NOTHING",
      ).bind(uid(), shop.id, channel, channel === "SMS" ? to.phone! : to.email!, template, r.sms, channel === "EMAIL" ? r.subject : "", channel === "EMAIL" ? html : "", opts.related.type, opts.related.id, now, now),
    );
  }
  return out;
}

// ---- Providers -----------------------------------------------------------------
type Env = Record<string, string | undefined>;
const env = (): Env => (typeof process !== "undefined" ? (process.env as Env) : {});
export type ProviderStatus = { email: { provider: "resend" | "mailbox"; from: string }; sms: { provider: "twilio" | "clicksend" | "mailbox"; from: string } };
const clicksendOn = (e: Record<string, string | undefined>) => !!(e.CLICKSEND_USERNAME && e.CLICKSEND_API_KEY);
export function providerStatus(): ProviderStatus {
  const e = env();
  return {
    email: e.RESEND_API_KEY ? { provider: "resend", from: e.MAIL_FROM || "" } : { provider: "mailbox", from: "" },
    sms: clicksendOn(e)
      ? { provider: "clicksend", from: e.CLICKSEND_FROM || "" }
      : e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && (e.TWILIO_FROM || e.TWILIO_MESSAGING_SERVICE_SID) ? { provider: "twilio", from: e.TWILIO_FROM || e.TWILIO_MESSAGING_SERVICE_SID || "" } : { provider: "mailbox", from: "" },
  };
}

type Row = { id: string; shop_id: string; channel: "SMS" | "EMAIL"; recipient: string; template: string; body: string; subject: string; html: string; attempts: number; shop_name: string; msg_reply_to: string; msg_sms_sender: string };
type Delivery = { ok: true; provider: string; id: string } | { ok: false; provider: string; error: string; permanent?: boolean };

async function sendEmail(row: Row): Promise<Delivery> {
  const e = env();
  if (!e.RESEND_API_KEY) return { ok: true, provider: "mailbox", id: `mbx_${uid().slice(0, 8)}` };
  const fromAddr = e.MAIL_FROM || "bookings@ollo.app";
  const from = `${row.shop_name.replace(/["<>]/g, "")} <${fromAddr}>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [row.recipient], subject: row.subject, html: row.html, text: row.body, ...(row.msg_reply_to ? { reply_to: row.msg_reply_to } : {}) }),
  });
  const j = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (res.ok && j.id) return { ok: true, provider: "resend", id: j.id };
  return { ok: false, provider: "resend", error: `${res.status} ${j.message || j.name || "send failed"}`, permanent: res.status === 422 || res.status === 403 };
}

// E.164 for UK numbers written locally (07… → +447…). Other countries must already be +CC.
export function toE164(phone: string, defaultCountry = "GB"): string | null {
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return /^\+\d{8,15}$/.test(digits) ? digits : null;
  if (defaultCountry === "GB" && /^0\d{10}$/.test(digits)) return `+44${digits.slice(1)}`;
  if (/^44\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}
async function sendSms(row: Row): Promise<Delivery> {
  const e = env();
  if (clicksendOn(e)) return sendClickSend(row, e as Record<string, string>);
  if (!(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && (e.TWILIO_FROM || e.TWILIO_MESSAGING_SERVICE_SID))) return { ok: true, provider: "mailbox", id: `mbx_${uid().slice(0, 8)}` };
  const to = toE164(row.recipient);
  if (!to) return { ok: false, provider: "twilio", error: "Not a valid mobile number", permanent: true };
  const form = new URLSearchParams({ To: to, Body: row.body });
  if (e.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", e.TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", row.msg_sms_sender || e.TWILIO_FROM!);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${e.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${e.TWILIO_ACCOUNT_SID}:${e.TWILIO_AUTH_TOKEN}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const j = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (res.ok && j.sid) return { ok: true, provider: "twilio", id: j.sid };
  // 21211 invalid number, 21610 unsubscribed, 21614 not a mobile: don't retry.
  return { ok: false, provider: "twilio", error: `${res.status} ${j.message || "send failed"}`, permanent: [21211, 21610, 21614, 21408].includes(j.code || 0) };
}

// ClickSend REST v3: basic auth (username:api key), one message per call. The shop's alphanumeric
// sender (msg_sms_sender, max 11 chars) goes in `from`; ClickSend falls back to a shared number if
// unset. Response codes: 200/SUCCESS per message; INVALID_RECIPIENT is permanent.
async function sendClickSend(row: Row, e: Record<string, string>): Promise<Delivery> {
  const to = toE164(row.recipient);
  if (!to) return { ok: false, provider: "clicksend", error: "Not a valid mobile number", permanent: true };
  const from = (row.msg_sms_sender || e.CLICKSEND_FROM || "").replace(/[^A-Za-z0-9 ]/g, "").slice(0, 11).trim();
  const message: Record<string, string> = { source: "ollo", to, body: row.body.slice(0, 918) };
  if (from) message.from = from;
  const res = await fetch("https://rest.clicksend.com/v3/sms/send", {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${e.CLICKSEND_USERNAME}:${e.CLICKSEND_API_KEY}`)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [message] }),
  });
  const j = (await res.json().catch(() => ({}))) as { response_code?: string; response_msg?: string; data?: { messages?: { status?: string; message_id?: string }[] } };
  const m = j.data?.messages?.[0];
  if (res.ok && m?.status === "SUCCESS" && m.message_id) return { ok: true, provider: "clicksend", id: m.message_id };
  const status = m?.status || j.response_code || `${res.status}`;
  // Balance/auth problems are worth retrying after a top-up; bad numbers are not.
  return { ok: false, provider: "clicksend", error: `${status} ${j.response_msg || "send failed"}`.trim(), permanent: /INVALID_RECIPIENT|INVALID_SENDER|BODY_TOO_LONG/.test(status) };
}

// ---- Drain ---------------------------------------------------------------------
const BACKOFF_MIN = [1, 5, 30, 120, 720]; // minutes between attempts; after the last, FAILED.
// `related` narrows the drain to one record's messages: the in-request drain after a booking must
// send *that* customer's confirmation now, not the oldest rows of a backlog (which starved fresh
// confirmations whenever the sweep fell behind). The sweep drains everything oldest-first.
export async function drain(db: DB, limit = 25, now = Date.now(), related?: { type: string; id: string }) {
  // Claim due rows. Rows stuck in SENDING for >10 min (crashed worker) are reclaimed.
  const due = await db
    .prepare(
      `SELECT n.id,n.shop_id,n.channel,n.recipient,n.template,n.body,n.subject,n.html,n.attempts,s.name AS shop_name,s.msg_reply_to,s.msg_sms_sender
       FROM notifications n JOIN shops s ON s.id=n.shop_id
       WHERE ((n.status='QUEUED' AND (n.next_attempt_at IS NULL OR n.next_attempt_at<=?)) OR (n.status='SENDING' AND n.next_attempt_at<=?))
         AND (? IS NULL OR (n.related_type=? AND n.related_id=?))
       ORDER BY n.created_at LIMIT ?`,
    )
    .bind(now, now - 10 * 60000, related?.type ?? null, related?.type ?? null, related?.id ?? null, limit)
    .all<Row>();
  let sent = 0, failed = 0, retried = 0;
  for (const row of due.results) {
    const claim = await db.prepare("UPDATE notifications SET status='SENDING', next_attempt_at=?, attempts=attempts+1 WHERE id=? AND status IN ('QUEUED','SENDING')").bind(now, row.id).run();
    if (!claim.meta.changes) continue; // someone else took it
    const attempt = row.attempts + 1;
    let d: Delivery;
    try {
      d = row.channel === "EMAIL" ? await sendEmail(row) : await sendSms(row);
    } catch (e) {
      d = { ok: false, provider: row.channel === "EMAIL" ? "resend" : "twilio", error: e instanceof Error ? e.message : "network error" };
    }
    if (d.ok) {
      await db.prepare("UPDATE notifications SET status='SENT', sent_at=?, provider=?, provider_id=?, error='', status_note=? WHERE id=?").bind(now, d.provider, d.id, d.provider === "mailbox" ? "Delivered to the dev mailbox (no live provider configured)." : "", row.id).run();
      sent++;
    } else if (d.permanent || attempt > BACKOFF_MIN.length) {
      await db.prepare("UPDATE notifications SET status='FAILED', provider=?, error=?, status_note=? WHERE id=?").bind(d.provider, d.error.slice(0, 400), d.permanent ? "Provider rejected the recipient; will not retry." : `Gave up after ${attempt} attempts.`, row.id).run();
      failed++;
    } else {
      const next = now + BACKOFF_MIN[Math.min(attempt - 1, BACKOFF_MIN.length - 1)] * 60000;
      await db.prepare("UPDATE notifications SET status='QUEUED', next_attempt_at=?, provider=?, error=?, status_note=? WHERE id=?").bind(next, d.provider, d.error.slice(0, 400), `Attempt ${attempt} failed; retrying.`, row.id).run();
      retried++;
    }
  }
  return { claimed: due.results.length, sent, failed, retried };
}

// ---- Reminders -----------------------------------------------------------------
// Queue "tomorrow" reminders for confirmed visits starting within [h-1h, h] hours from now (h =
// shop's msg_reminder_hours), and "soon" reminders 2h before. Unique index makes this idempotent.
export async function sweepReminders(db: DB, origin: string, now = Date.now()) {
  const shops = await db
    .prepare("SELECT s.*, COALESCE(p.logo_url,'') AS logo_url, COALESCE(p.accent,'ollo') AS accent, COALESCE(p.theme_json,'{}') AS theme_json, COALESCE(p.phone,'') AS phone, COALESCE(p.email,'') AS email, COALESCE(p.map_url,'') AS map_url FROM shops s LEFT JOIN shop_pages p ON p.shop_id=s.id WHERE s.msg_reminders=1 AND s.slug IS NOT NULL")
    .all<MsgShop & { map_url: string }>();
  let queued = 0;
  for (const shop of shops.results) {
    const h = shop.msg_reminder_hours || 24;
    const windows: { template: MessageTemplate; from: number; to: number }[] = [
      { template: "booking_reminder", from: now + (h - 1) * 3600000, to: now + h * 3600000 },
      { template: "booking_reminder_soon", from: now + 90 * 60000, to: now + 120 * 60000 },
    ];
    for (const w of windows) {
      const rows = await db
        .prepare(
          `SELECT b.*, st.name AS staff_name, t.token_hash FROM bookings b LEFT JOIN staff st ON st.shop_id=b.shop_id AND st.id=b.staff_id LEFT JOIN booking_manage_tokens t ON t.booking_id=b.id
           WHERE b.shop_id=? AND b.status='CONFIRMED' AND b.start_at>? AND b.start_at<=? AND (b.phone<>'' OR b.email<>'')
           AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.shop_id=b.shop_id AND n.related_id=b.id AND n.template=?)`,
        )
        .bind(shop.id, w.from, w.to, w.template)
        .all<{ id: string; customer_name: string; attendee_name: string; phone: string; email: string; service_name: string; staff_name: string | null; date: string; start_min: number; token_hash: string | null; price_pence: number }>();
      for (const b of rows.results) {
        // The manage link needs the raw token, which we don't store. Reminders link to /<slug>/me
        // (one-time code sign-in) — always valid, and the customer sees every visit there.
        const link = `${origin}/${shop.slug}/me`;
        const stmts = enqueue(db, shop, { name: b.attendee_name || b.customer_name, phone: b.phone, email: b.email }, w.template, {
          service: b.service_name, barber: (b.staff_name || "us").split(" ")[0], date: fmtDate(b.date), time: fmtTime(b.start_min), ref: b.id.slice(0, 6).toUpperCase(),
          address: shop.address, link, map_link: shop.map_url || (shop.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(shop.address)}` : link),
        }, { related: { type: "booking", id: b.id }, origin, now }, false);
        if (stmts.length) { await db.batch(stmts); queued += stmts.length; }
      }
    }
  }
  return { shops: shops.results.length, queued };
}

// Lazy sweep: run at most once per interval, triggered from any request (Vercel Cron also calls it).
export async function maybeSweep(db: DB, origin: string, intervalMs = 5 * 60000, now = Date.now()) {
  const row = await db.prepare("SELECT value FROM platform_kv WHERE key='last_sweep'").first<{ value: string }>();
  const last = Number(row?.value || 0);
  if (now - last < intervalMs) return null;
  const claim = await db.prepare("INSERT INTO platform_kv(key,value,updated_at) VALUES('last_sweep',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at WHERE platform_kv.value=?").bind(String(now), now, String(last)).run();
  if (!claim.meta.changes) return null;
  // Deposit holds run on a much shorter clock than reminders; expire them first so the slots free.
  const holds = await expireHolds(db, now).catch(() => []);
  const reminders = await sweepReminders(db, origin, now);
  const drained = await drain(db, 50, now);
  const runs = await scheduledPayRuns(db, now).catch(() => 0);
  await expireRequests(db, now).catch(() => 0);
  const summaries = await sweepDailySummaries(db, origin, now).catch(() => 0);
  // Retention: delivered/skipped/failed rows older than 180 days go; the outbox shows 30 days and the
  // audit trail keeps the fact a message was sent. Anything still QUEUED is never touched.
  await db.prepare("DELETE FROM notifications WHERE status IN ('SENT','SKIPPED','FAILED') AND created_at < ?").bind(now - 180 * 86400000).run().catch(() => null);
  return { reminders, drained, holds_released: holds.length, pay_runs: runs, summaries };
}

export const fmtDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
export const fmtTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// Load a shop with everything messaging needs (brand + contact details from the page).
export async function msgShop(c: Ctx | { env: { DB: DB } }, shopId: string): Promise<MsgShop> {
  const row = await c.env.DB.prepare(
    "SELECT s.*, COALESCE(p.logo_url,'') AS logo_url, COALESCE(p.accent,'ollo') AS accent, COALESCE(p.theme_json,'{}') AS theme_json, COALESCE(p.phone,'') AS phone, COALESCE(p.email,'') AS email FROM shops s LEFT JOIN shop_pages p ON p.shop_id=s.id WHERE s.id=?",
  ).bind(shopId).first<MsgShop>();
  return row!;
}
