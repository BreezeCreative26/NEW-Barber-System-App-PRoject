// One-off Telnyx platform setup, idempotent. Run with TELNYX_API_KEY in the environment:
//   TELNYX_API_KEY=KEY… node scripts/telnyx-setup.mjs https://foliyo.co.uk [--buy-uk-number]
// - creates (or reuses) the "foliyo" messaging profile with the webhook pointing at
//   /api/telnyx/webhook (delivery reports + inbound replies, incl. STOP);
// - lists the account's numbers and attaches any messaging-capable ones to that profile;
// - with --buy-uk-number, searches for and orders one UK mobile number (SMS-capable) and attaches it;
// - prints the env values to paste into Vercel: TELNYX_MESSAGING_PROFILE_ID, TELNYX_FROM, and where
//   to find TELNYX_PUBLIC_KEY (Mission Control → Account → Keys & Credentials → Public Key).
// The API key itself never leaves your environment; this script only reads it from process.env.
const key = process.env.TELNYX_API_KEY;
const origin = (process.argv[2] || process.env.APP_ORIGIN || "").replace(/\/$/, "");
const buy = process.argv.includes("--buy-uk-number");
if (!key || !origin) {
  console.error("usage: TELNYX_API_KEY=KEY… node scripts/telnyx-setup.mjs https://app-origin [--buy-uk-number]");
  process.exit(1);
}
const api = async (path, body, method) => {
  const init = { method: method || (body ? "POST" : "GET"), headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } };
  if (body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await fetch(`https://api.telnyx.com/v2${path}`, init);
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* html error page */ }
  if (!res.ok) {
    const e = json.errors?.[0];
    const hint = res.status === 403 && !e ? " (Cloudflare blocked this request — run the script from your own machine or Vercel, not a shared sandbox)" : "";
    throw new Error(`${path}: ${res.status} ${e ? `${e.code} ${e.title}${e.detail ? ` — ${e.detail}` : ""}` : text.slice(0, 120)}${hint}`);
  }
  return json;
};

const webhook = `${origin}/api/telnyx/webhook`;
const PROFILE_NAME = "foliyo";

// 1. Who am I / balance.
const bal = await api("/balance").catch(() => null);
if (bal?.data) console.log(`Balance ${bal.data.balance} ${bal.data.currency}${bal.data.credit_limit ? ` (credit limit ${bal.data.credit_limit})` : ""}`);

// 2. Messaging profile (reuse by name).
const profiles = await api("/messaging_profiles?page[size]=50");
let profile = (profiles.data || []).find((p) => p.name === PROFILE_NAME);
const want = {
  name: PROFILE_NAME,
  enabled: true,
  webhook_url: webhook,
  webhook_api_version: "2",
  // UK alphanumeric senders + number-pool are profile features; both default off until numbers exist.
  alpha_sender: null,
};
if (!profile) {
  profile = (await api("/messaging_profiles", want)).data;
  console.log(`Created messaging profile ${profile.id}`);
} else if (profile.webhook_url !== webhook || !profile.enabled) {
  profile = (await api(`/messaging_profiles/${profile.id}`, { webhook_url: webhook, webhook_api_version: "2", enabled: true }, "PATCH")).data;
  console.log(`Updated messaging profile ${profile.id} → ${webhook}`);
} else console.log(`Messaging profile ${profile.id} already points at ${webhook}`);

// 3. Numbers: attach every SMS-capable number to the profile.
const nums = await api("/phone_numbers?page[size]=100");
let smsNumbers = [];
for (const n of nums.data || []) {
  const pn = n.phone_number;
  const m = await api(`/phone_numbers/${n.id}/messaging`).catch(() => null);
  const features = m?.data?.features?.sms;
  if (!features) { console.log(`  ${pn}: not messaging-capable, skipped`); continue; }
  if (m.data.messaging_profile_id !== profile.id) {
    await api(`/phone_numbers/${n.id}/messaging`, { messaging_profile_id: profile.id }, "PATCH");
    console.log(`  ${pn}: attached to ${PROFILE_NAME}`);
  } else console.log(`  ${pn}: already on ${PROFILE_NAME}`);
  smsNumbers.push(pn);
}

// 4. Optionally buy a UK mobile number for two-way texting.
if (buy && smsNumbers.length === 0) {
  const search = await api("/available_phone_numbers?filter[country_code]=GB&filter[phone_number_type]=mobile&filter[features][]=sms&filter[limit]=5");
  const pick = search.data?.[0]?.phone_number;
  if (!pick) console.log("No UK mobile SMS numbers available right now — buy one in Mission Control → Numbers.");
  else {
    const order = await api("/number_orders", { phone_numbers: [{ phone_number: pick }], messaging_profile_id: profile.id });
    console.log(`Ordered ${pick} (order ${order.data.id}, status ${order.data.status}) and attached it to ${PROFILE_NAME}`);
    smsNumbers.push(pick);
  }
}

// 5. Print env.
console.log("\nAdd to Vercel (Production + Preview):");
console.log(`  TELNYX_API_KEY=<the key you ran this with>`);
console.log(`  TELNYX_MESSAGING_PROFILE_ID=${profile.id}`);
if (smsNumbers[0]) console.log(`  TELNYX_FROM=${smsNumbers[0]}`);
else console.log("  TELNYX_FROM=<buy a number: re-run with --buy-uk-number, or Mission Control → Numbers>");
console.log("  TELNYX_PUBLIC_KEY=<Mission Control → Account settings → Keys & Credentials → Public Key>");
console.log(`\nWebhook: ${webhook}`);
if (!smsNumbers.length) console.log("\nNote: texts need a number on the profile; until then the outbox falls back to the dev mailbox.");
