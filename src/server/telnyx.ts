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
import { suppressPhone } from "./consent";

type Env = Record<string, string | undefined>;
const env = (): Env => (typeof process !== "undefined" ? (process.env as Env) : {});

export const telnyxOn = (e: Env = env()) => !!e.TELNYX_API_KEY;
export const telnyxFrom = (e: Env = env()) => e.TELNYX_FROM || (e.TELNYX_MESSAGING_PROFILE_ID ? "Telnyx number pool" : "");

export type TelnyxDelivery = { ok: true; provider: "telnyx"; id: string } | { ok: false; provider: "telnyx"; error: string; permanent?: boolean };

// Telnyx error codes that mean "this number will never work" — don't burn retries on them.
// 40300 invalid destination, 40310 blocked/opted out, 40006 invalid to, 40008 unsupported destination.
const PERMANENT = new Set(["40006", "40008", "40300", "40310", "40311", "40312", "40313"]);

/**
 * Send one text. Each shop sets its own alphanumeric sender under Settings → Messages
 * (msg_sms_sender, ≤11 chars, e.g. "Northline"); UK handsets show that instead of a number. If Telnyx
 * won't accept the alpha sender for this destination (profile not enabled for it, non-UK country,
 * customer needs to be able to reply), we retry once from the platform number so the message still
 * lands. Replies (STOP etc.) always come to TELNYX_FROM because alpha senders can't receive.
 */
export async function telnyxSend(to: string, body: string, opts: { alphaSender?: string; e?: Env } = {}): Promise<TelnyxDelivery> {
  const e = opts.e ?? env();
  const alpha = (opts.alphaSender || "").replace(/[^A-Za-z0-9 ]/g, "").slice(0, 11).trim();
  const useAlpha = !!alpha && /[A-Za-z]/.test(alpha) && !!e.TELNYX_MESSAGING_PROFILE_ID;
  if (!useAlpha && !e.TELNYX_FROM && !e.TELNYX_MESSAGING_PROFILE_ID) return { ok: false, provider: "telnyx", error: "TELNYX_FROM or TELNYX_MESSAGING_PROFILE_ID required", permanent: true };
  const attempt = async (from: string | undefined) => {
    const payload: Record<string, unknown> = { to, text: body.slice(0, 1530), type: "SMS", auto_detect: false };
    if (e.TELNYX_MESSAGING_PROFILE_ID) payload.messaging_profile_id = e.TELNYX_MESSAGING_PROFILE_ID;
    if (from) payload.from = from;
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${e.TELNYX_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    type ApiErr = { code?: string; title?: string; detail?: string };
    const j = (await res.json().catch(() => ({}))) as { data?: { id?: string; errors?: ApiErr[] }; errors?: ApiErr[] };
    if (res.ok && j.data?.id) return { ok: true as const, id: j.data.id };
    const err = j.errors?.[0] ?? j.data?.errors?.[0];
    return { ok: false as const, status: res.status, code: String(err?.code ?? res.status), text: `${err?.detail || err?.title || "send failed"}` };
  };
  let r = await attempt(useAlpha ? alpha : e.TELNYX_FROM || undefined);
  // Alpha sender refused (invalid/unsupported "from" for this route) → once more from the number.
  if (!r.ok && useAlpha && e.TELNYX_FROM && (ALPHA_REFUSED.has(r.code) || /from|sender/i.test(r.text))) r = await attempt(e.TELNYX_FROM);
  if (r.ok) return { ok: true, provider: "telnyx", id: r.id };
  return { ok: false, provider: "telnyx", error: `${r.code} ${r.text}`.slice(0, 400), permanent: PERMANENT.has(r.code) || r.status === 422 };
}
// 40301/40302 invalid or unsupported "from"; 40303 alphanumeric not permitted for this destination.
const ALPHA_REFUSED = new Set(["40301", "40302", "40303", "40305"]);

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
    if (STOP.test(text)) {
      await db.prepare("INSERT INTO wa_optouts(phone,reason,created_at) VALUES(?,?,?) ON CONFLICT(phone) DO NOTHING").bind(phone, text.slice(0, 40), now).run();
      // STOP also ends marketing for that number everywhere. START only lets texts through again:
      // it never turns marketing back on (only the customer's own tick in the app does).
      await suppressPhone(db, phone, now);
    } else if (START.test(text)) await db.prepare("DELETE FROM wa_optouts WHERE phone=?").bind(phone).run();
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

// ---- One-off account setup (run from the deployed app, where Telnyx's edge accepts us) -------------
// Mirrors scripts/telnyx-setup.mjs: create/refresh the "foliyo" messaging profile with the webhook,
// attach messaging-capable numbers, optionally order one UK mobile number, and read the account
// public key. Returns the env values to set. Gated by the caller (see /api/telnyx/setup).
export type TelnyxSetupResult = {
  balance?: string;
  profile_id: string;
  webhook: string;
  numbers: string[];
  ordered?: string;
  public_key?: string;
  notes: string[];
};
export async function telnyxSetup(origin: string, opts: { buyUkNumber?: boolean; e?: Env } = {}): Promise<TelnyxSetupResult> {
  const e = opts.e ?? env();
  if (!e.TELNYX_API_KEY) throw new Error("TELNYX_API_KEY not set");
  const api = async <T = Record<string, unknown>>(path: string, body?: unknown, method?: string): Promise<T> => {
    const init: RequestInit = { method: method || (body ? "POST" : "GET"), headers: { Authorization: `Bearer ${e.TELNYX_API_KEY}`, Accept: "application/json" } };
    if (body) { (init.headers as Record<string, string>)["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    const res = await fetch(`https://api.telnyx.com/v2${path}`, init);
    const text = await res.text();
    let json: { errors?: { code?: string; title?: string; detail?: string; source?: { pointer?: string; parameter?: string } }[] } = {};
    try { json = JSON.parse(text); } catch { /* html */ }
    if (!res.ok) {
      const err = json.errors?.[0];
      throw new Error(`${path}: ${res.status} ${err ? `${err.code} ${err.title}${err.detail ? ` — ${err.detail}` : ""}${err.source?.pointer || err.source?.parameter ? ` [${err.source.pointer || err.source.parameter}]` : ""}` : text.slice(0, 120)}`);
    }
    return json as T;
  };
  const notes: string[] = [];
  const webhook = `${origin.replace(/\/$/, "")}/api/telnyx/webhook`;
  const bal = await api<{ data?: { balance?: string; currency?: string } }>("/balance").catch(() => null);
  const balance = bal?.data ? `${bal.data.balance} ${bal.data.currency}` : undefined;

  type Profile = { id: string; name: string; webhook_url?: string; enabled?: boolean };
  const profiles = await api<{ data?: Profile[] }>("/messaging_profiles?page[size]=50");
  let profile = (profiles.data || []).find((p) => p.name === "foliyo");
  if (!profile) {
    // Telnyx requires an explicit destination allow-list; foliyo texts UK (and Irish) mobiles.
    profile = (await api<{ data: Profile }>("/messaging_profiles", { name: "foliyo", enabled: true, webhook_url: webhook, webhook_api_version: "2", whitelisted_destinations: ["GB", "IE"] })).data;
    notes.push(`Created messaging profile ${profile.id}`);
  } else if (profile.webhook_url !== webhook || !profile.enabled) {
    profile = (await api<{ data: Profile }>(`/messaging_profiles/${profile.id}`, { webhook_url: webhook, webhook_api_version: "2", enabled: true }, "PATCH")).data;
    notes.push(`Updated messaging profile ${profile.id} webhook`);
  } else notes.push(`Messaging profile ${profile.id} already configured`);

  for (const pr of profiles.data || []) notes.push(`profile ${pr.id} "${pr.name}" enabled=${pr.enabled ?? "?"}`);
  const rgs = await api<{ data?: { id: string; status?: string; country_code?: string; phone_number_type?: string }[] }>("/requirement_groups?page[size]=20").catch(() => null);
  for (const g of rgs?.data || []) notes.push(`requirement group ${g.id}: ${g.country_code ?? "?"} ${g.phone_number_type ?? "?"} status=${g.status ?? "?"}`);
  type Num = { id: string; phone_number: string; status?: string; phone_number_type?: string };
  const nums = await api<{ data?: Num[] }>("/phone_numbers?page[size]=100");
  for (const n of nums.data || []) notes.push(`${n.phone_number}: status=${n.status ?? "?"} type=${n.phone_number_type ?? "?"}`);
  const ords = await api<{ data?: { id: string; status?: string; requirements_met?: boolean; phone_numbers_count?: number; sub_number_orders_ids?: string[] }[] }>("/number_orders?page[size]=10").catch(() => null);
  for (const o of ords?.data || []) notes.push(`order ${o.id.slice(0, 8)}: status=${o.status ?? "?"} requirements_met=${o.requirements_met ?? "?"}`);
  const subs = await api<{ data?: { id: string; status?: string; phone_number_type?: string; country_code?: string; requirements_met?: boolean; phone_numbers?: { phone_number?: string; status?: string; requirements_met?: boolean; regulatory_requirements?: { status?: string; field_type?: string; requirement_id?: string }[] }[] }[] }>("/sub_number_orders?page[size]=10").catch(() => null);
  for (const o of subs?.data || []) for (const pn of o.phone_numbers || []) notes.push(`sub-order ${pn.phone_number}: status=${pn.status ?? o.status ?? "?"} requirements_met=${pn.requirements_met ?? o.requirements_met ?? "?"}${pn.regulatory_requirements?.length ? ` open=${pn.regulatory_requirements.filter((r) => r.status && r.status !== "approved").map((r) => r.field_type || r.requirement_id).join(",").slice(0, 200)}` : ""}`);
  const numbers: string[] = [];
  for (const n of nums.data || []) {
    const m = await api<{ data?: { messaging_profile_id?: string; features?: { sms?: unknown } } }>(`/phone_numbers/${n.id}/messaging`).catch(() => null);
    if (!m?.data?.features?.sms) {
      // A number that was never attached to a messaging profile can report no SMS feature yet. Try the
      // attach anyway and report what Telnyx says: that is the real test of whether it can text.
      try {
        const r = await api<{ data?: { messaging_profile_id?: string; features?: { sms?: unknown } } }>(`/phone_numbers/${n.id}/messaging`, { messaging_profile_id: profile.id }, "PATCH");
        const back = await api<{ data?: { type?: string; features?: { sms?: unknown } } }>(`/phone_numbers/${n.id}/messaging`).catch(() => null);
        const sms = back?.data?.features?.sms ?? r.data?.features?.sms;
        notes.push(`${n.phone_number}: attach attempted, type=${back?.data?.type ?? "?"}, sms=${sms ? JSON.stringify(sms) : "none"}`);
        if (sms) numbers.push(n.phone_number);
      } catch (err) {
        notes.push(`${n.phone_number}: cannot enable messaging (${err instanceof Error ? err.message : "error"})`);
      }
      continue;
    }
    if (m.data.messaging_profile_id !== profile.id) {
      await api(`/phone_numbers/${n.id}/messaging`, { messaging_profile_id: profile.id }, "PATCH");
      notes.push(`${n.phone_number}: attached to foliyo`);
    }
    numbers.push(n.phone_number);
  }
  let ordered: string | undefined;
  if (opts.buyUkNumber && numbers.length === 0) {
    // Search a few ways (mobile first, then any SMS-capable UK number), keeping what Telnyx says about each.
    type Avail = { phone_number: string; record_type?: string; phone_number_type?: string; best_effort?: boolean; reservable?: boolean; quickship?: boolean };
    const mask = (n: string) => n.replace(/\d(?=\d{3})/g, "x");
    const seen = new Map<string, Avail>();
    for (const q of ["filter[phone_number_type]=mobile&", "filter[phone_number_type]=national&", ""]) {
      const r = await api<{ data?: Avail[] }>(`/available_phone_numbers?filter[country_code]=GB&${q}filter[features][]=sms&filter[limit]=10`).catch((err) => { notes.push(`Search failed: ${err instanceof Error ? err.message : "error"}`); return null; });
      for (const x of r?.data || []) if (x.phone_number && !seen.has(x.phone_number)) seen.set(x.phone_number, x);
    }
    const candidates = [...seen.values()];
    const sample = candidates[0] as Record<string, unknown> | undefined;
    if (sample) notes.push(`Sample search result fields: ${Object.keys(sample).join(",")}`);
    const reqs = await api<{ data?: { requirements_types?: { name?: string }[]; action?: string; phone_number_type?: string }[] }>("/requirements?filter[country_code]=GB&filter[phone_number_type]=mobile&filter[action]=ordering").catch((err) => { notes.push(`Requirements lookup failed: ${err instanceof Error ? err.message : "error"}`); return null; });
    if (reqs?.data) notes.push(`GB mobile ordering requirements: ${reqs.data.length ? JSON.stringify(reqs.data).slice(0, 400) : "none"}`);
    if (!candidates.length) notes.push("No UK SMS numbers available to order right now - buy one in Mission Control > Numbers");
    else notes.push(`Search found ${candidates.length} UK numbers (${[...new Set(candidates.map((x) => x.phone_number_type || "?"))].join("/")}; best_effort=${candidates.filter((x) => x.best_effort).length}; reservable=${candidates.filter((x) => x.reservable).length})`);
    // Telnyx refuses a number it did not just see reserved, so reserve first, then order that same number.
    // Prefer numbers that are not "best effort" (those are not guaranteed to still be there).
    const ranked = [...candidates].sort((a, b) => Number(!!a.best_effort) - Number(!!b.best_effort));
    const errs: string[] = [];
    for (const cand of ranked.slice(0, 3)) {
      const pick = cand.phone_number;
      try {
        await api("/number_reservations", { phone_numbers: [{ phone_number: pick }] }).catch((err) => { errs.push(`reserve ${mask(pick)}: ${err instanceof Error ? err.message : "error"}`); });
        const order = await api<{ data: { id: string; status: string } }>("/number_orders", { phone_numbers: [{ phone_number: pick }], messaging_profile_id: profile.id });
        ordered = pick;
        numbers.push(pick);
        notes.push(`Ordered ${pick} (order ${order.data.id}, ${order.data.status})`);
        break;
      } catch (err) {
        errs.push(`order ${mask(pick)}: ${err instanceof Error ? err.message : "order failed"}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!ordered && candidates.length) notes.push(`Could not order a UK number automatically. ${errs.slice(0, 4).join(" | ").slice(0, 700)}. Buy one in Mission Control > Numbers > Buy numbers (United Kingdom, SMS), attach it to the "foliyo" messaging profile, then set TELNYX_FROM.`);
  }
  // Account public key for webhook verification. Telnyx exposes it under /public_key on some
  // accounts; if absent, copy it from Mission Control → Account → Keys & Credentials → Public Key.
  const pk = await api<{ data?: { public_key?: string } }>("/public_key").catch(() => null);
  if (!pk?.data?.public_key) notes.push("Public key not readable via API — copy it from Mission Control → Keys & Credentials → Public Key into TELNYX_PUBLIC_KEY");
  // Number orders complete asynchronously; report where each one is.
  for (const n of ordered ? [ordered] : []) {
    const st = await api<{ data?: { id: string; status: string; phone_number: string }[] }>(`/phone_numbers?filter[phone_number]=${encodeURIComponent(n)}`).catch(() => null);
    const row = st?.data?.[0];
    notes.push(row ? `${n}: ${row.status}` : `${n}: order still pending`);
  }
  return { balance, profile_id: profile.id, webhook, numbers, ordered, public_key: pk?.data?.public_key, notes };
}

// Read-only look at everything on the account that could be a sender (numbers, profile pools, short
// codes, toll-free, hosted/ported numbers, recent message records). GETs only; each answer is trimmed.
export async function telnyxInspect(opts: { e?: Env } = {}) {
  const e = opts.e ?? env();
  if (!e.TELNYX_API_KEY) throw new Error("TELNYX_API_KEY not set");
  const get = async (path: string) => {
    try {
      const res = await fetch(`https://api.telnyx.com/v2${path}`, { headers: { Authorization: `Bearer ${e.TELNYX_API_KEY}`, Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
      const text = await res.text();
      let body: unknown = text.slice(0, 200);
      try { body = JSON.parse(text); } catch { /* not json */ }
      return { path, status: res.status, body };
    } catch (err) {
      return { path, status: 0, body: err instanceof Error ? err.message : "error" };
    }
  };
  const out: { path: string; status: number; body: unknown }[] = [];
  const profiles = await get("/messaging_profiles?page[size]=50");
  out.push(profiles);
  const pids = ((profiles.body as { data?: { id: string }[] })?.data || []).map((p) => p.id);
  for (const path of [
    "/phone_numbers?page[size]=50",
    "/phone_numbers/messaging?page[size]=50",
    "/short_codes?page[size]=20",
    "/messaging_hosted_numbers?page[size]=20",
    "/messaging_tollfree/verification/requests?page[size]=20",
    "/porting_orders?page[size]=20",
    "/number_orders?page[size]=20",
    "/detail_records?filter[record_type]=messaging&filter[date_range]=this_month&page[size]=10",
    "/detail_records?filter[record_type]=messaging&filter[date_range]=last_month&page[size]=10",
    ...pids.flatMap((id) => [`/messaging_profiles/${id}/phone_numbers?page[size]=50`, `/messaging_profiles/${id}/short_codes?page[size]=20`]),
  ]) out.push(await get(path));
  return out;
}
