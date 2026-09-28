// Telnyx: one provider for texting (and, later, calls) so everything lives in one account.
//
// Env (platform-level, never per shop):
//   TELNYX_API_KEY               v2 API key (KEY…). Present = Telnyx is the SMS provider.
//   TELNYX_MESSAGING_PROFILE_ID  messaging profile the numbers sit on (scripts/telnyx-setup.mjs creates it)
//   TELNYX_FROM                  E.164 number on that profile (+44…). Optional when the profile picks
//                                the sender (number pool); a shop's alphanumeric sender is used when
//                                the destination country allows it (UK does).
//   TELNYX_PUBLIC_KEY            account public key (Mission Control → Keys & Credentials → Public key)
//                                used to verify webhook signatures. Unset = webhooks accepted unverified
//                                (only sensible in a dev preview).
//
// Webhook (one URL for the whole platform, set on the messaging profile by the setup script):
//   POST /api/telnyx/webhook  — message.finalized / message.sent / message.received. Delivery reports
//   mark outbox rows delivered or failed; inbound STOP-style replies opt the number out platform-wide
//   (same wa_optouts table WhatsApp uses, so a STOP is honoured on every channel).
import { verify as edVerify } from "node:crypto";
import type { Database as DB } from "../db/client";

type Env = Record<string, string | undefined>;
const env = (): Env => (typeof process !== "undefined" ? (process.env as Env) : {});

export const telnyxOn = (e: Env = env()) => !!e.TELNYX_API_KEY;
export const telnyxFrom = (e: Env = env()) => e.TELNYX_FROM || (e.TELNYX_MESSAGING_PROFILE_ID ? "Telnyx number pool" : "");

export type TelnyxDelivery = { ok: true; provider: "telnyx"; id: string } | { ok: false; provider: "telnyx"; error: string; permanent?: boolean };

// Telnyx error codes that mean "this number will never work" — don't burn retries on them.
// 40300 invalid destination, 40310 blocked/opted out, 40006 invalid to, 40008 unsupported destination.
const PERMANENT = new Set(["40006", "40008", "40300", "40310", "40311", "40312", "40313"]);

/** Send one text. `from` is the shop's alphanumeric sender when set (UK delivers these fine). */
export async function telnyxSend(to: string, body: string, opts: { alphaSender?: string; e?: Env } = {}): Promise<TelnyxDelivery> {
  const e = opts.e ?? env();
  const alpha = (opts.alphaSender || "").replace(/[^A-Za-z0-9 ]/g, "").slice(0, 11).trim();
  const payload: Record<string, unknown> = { to, text: body.slice(0, 1530), type: "SMS", auto_detect: false };
  if (e.TELNYX_MESSAGING_PROFILE_ID) payload.messaging_profile_id = e.TELNYX_MESSAGING_PROFILE_ID;
  // Alphanumeric sender only works with a messaging profile behind it; otherwise the number.
  if (alpha && /[A-Za-z]/.test(alpha) && e.TELNYX_MESSAGING_PROFILE_ID) payload.from = alpha;
  else if (e.TELNYX_FROM) payload.from = e.TELNYX_FROM;
  else if (!e.TELNYX_MESSAGING_PROFILE_ID) return { ok: false, provider: "telnyx", error: "TELNYX_FROM or TELNYX_MESSAGING_PROFILE_ID required", permanent: true };
  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${e.TELNYX_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  type ApiErr = { code?: string; title?: string; detail?: string };
  const j = (await res.json().catch(() => ({}))) as { data?: { id?: string; errors?: ApiErr[] }; errors?: ApiErr[] };
  if (res.ok && j.data?.id) return { ok: true, provider: "telnyx", id: j.data.id };
  const err = j.errors?.[0] ?? j.data?.errors?.[0];
  const code = String(err?.code ?? res.status);
  return { ok: false, provider: "telnyx", error: `${code} ${err?.detail || err?.title || "send failed"}`.slice(0, 400), permanent: PERMANENT.has(code) || res.status === 422 };
}

// ---- Webhooks -----------------------------------------------------------------------------------
// Telnyx signs `${timestamp}|${rawBody}` with Ed25519; headers telnyx-signature-ed25519 (base64) and
// telnyx-timestamp. Tolerance 5 minutes against replay.
export function telnyxWebhookOk(raw: string, signature?: string, timestamp?: string, e: Env = env(), now = Date.now()): boolean {
  const pub = e.TELNYX_PUBLIC_KEY;
  if (!pub) return true; // dev preview: nothing to verify against
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  try {
    // Telnyx public key is raw 32-byte Ed25519, base64. Wrap it in SPKI DER for node:crypto.
    const rawKey = Buffer.from(pub, "base64");
    if (rawKey.length !== 32) return false;
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]);
    return edVerify(null, Buffer.from(`${timestamp}|${raw}`), { key: spki, format: "der", type: "spki" }, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

type TelnyxEvent = {
  data?: {
    event_type?: string;
    payload?: {
      id?: string;
      direction?: "inbound" | "outbound";
      text?: string;
      from?: { phone_number?: string };
      to?: { phone_number?: string; status?: string }[];
      errors?: { code?: string; title?: string; detail?: string }[];
    };
  };
};
const STOP = /^\s*(stop|unsubscribe|opt ?out|cancel all|no more)\b/i;
const START = /^\s*(start|unstop|subscribe|resume)\b/i;

/** Apply one webhook event. Returns what happened, for logging/tests. */
export async function applyTelnyxEvent(db: DB, body: unknown, now = Date.now()): Promise<"delivered" | "failed" | "inbound" | "ignored"> {
  const ev = body as TelnyxEvent;
  const type = ev?.data?.event_type || "";
  const p = ev?.data?.payload;
  if (!p) return "ignored";
  if (type === "message.received" && p.direction === "inbound") {
    const phone = (p.from?.phone_number || "").replace(/\D/g, "");
    const text = (p.text || "").trim();
    if (!phone) return "ignored";
    if (STOP.test(text)) await db.prepare("INSERT INTO wa_optouts(phone,reason,created_at) VALUES(?,?,?) ON CONFLICT(phone) DO NOTHING").bind(phone, text.slice(0, 40), now).run();
    else if (START.test(text)) await db.prepare("DELETE FROM wa_optouts WHERE phone=?").bind(phone).run();
    // Store the reply against the shop that last texted this number (same as WhatsApp inbound).
    const national = phone.startsWith("44") ? `0${phone.slice(2)}` : phone;
    const last = await db
      .prepare("SELECT shop_id FROM notifications WHERE channel IN ('SMS','WA') AND regexp_replace(recipient,'\\D','','g') IN (?,?) ORDER BY created_at DESC LIMIT 1")
      .bind(phone, national)
      .first<{ shop_id: string }>();
    await db.prepare("INSERT INTO wa_inbound(id,shop_id,phone,body,provider_id,received_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING").bind(p.id || crypto.randomUUID(), last?.shop_id ?? null, phone, text, p.id || "", now).run();
    return "inbound";
  }
  if ((type === "message.finalized" || type === "message.sent") && p.id) {
    const status = p.to?.[0]?.status || "";
    if (status === "delivered") {
      await db.prepare("UPDATE notifications SET status_note='Delivered' WHERE provider_id=? AND channel='SMS' AND provider='telnyx'").bind(p.id).run();
      return "delivered";
    }
    if (["delivery_failed", "sending_failed", "undelivered", "expired"].includes(status)) {
      const err = p.errors?.[0];
      const msg = `${err?.code ? `${err.code} ` : ""}${err?.detail || err?.title || status}`.slice(0, 400);
      await db.prepare("UPDATE notifications SET status='FAILED', error=?, status_note='Carrier could not deliver' WHERE provider_id=? AND channel='SMS' AND provider='telnyx'").bind(msg, p.id).run();
      return "failed";
    }
  }
  return "ignored";
}
