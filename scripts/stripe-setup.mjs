// One-off Stripe platform setup, idempotent. Run with STRIPE_SECRET_KEY in the environment:
//   STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup.mjs https://your-app.example
// - registers (or updates) the webhook endpoint for /api/stripe/webhook with the events the app
//   handles, listening to the platform account AND connected accounts (payouts arrive from those);
// - prints the signing secret ONCE on creation (Stripe never shows it again — put it in
//   STRIPE_WEBHOOK_SECRET straight away);
// - prints what the account still needs in the Dashboard (loss liability, Radar, business profile).
const key = process.env.STRIPE_SECRET_KEY;
const origin = (process.argv[2] || process.env.APP_ORIGIN || "").replace(/\/$/, "");
if (!key || !origin) {
  console.error("usage: STRIPE_SECRET_KEY=sk_… node scripts/stripe-setup.mjs https://app-origin");
  process.exit(1);
}
const api = async (path, body, method) => {
  const init = { method: method || (body ? "POST" : "GET"), headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" } };
  if (body) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = body;
  }
  const res = await fetch(`https://api.stripe.com/v1${path}`, init);
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error?.message || res.status}`);
  return json;
};

// Events the app handles (src/index.tsx + payouts.ts handleConnectEvent). Platform events and
// connected-account events are separate endpoints in Stripe; both point at the same URL.
const EVENTS = [
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.expired",
  "payment_intent.succeeded", "charge.refunded",
  "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed",
  "account.updated", "transfer.created", "transfer.updated", "transfer.reversed",
  "payout.created", "payout.updated", "payout.paid", "payout.failed", "payout.canceled",
];
const CONNECT_EVENTS = ["account.updated", "payout.created", "payout.updated", "payout.paid", "payout.failed", "payout.canceled"];
const url = `${origin}/api/stripe/webhook`;

const acct = await api("/account");
const mode = key.startsWith("sk_live") ? "LIVE" : "test";
console.log(`Account ${acct.id} (${acct.settings?.dashboard?.display_name || "?"}) · ${acct.country} ${acct.default_currency} · ${mode} mode`);

const existing = (await api("/webhook_endpoints?limit=100")).data.filter((w) => w.url === url);
const form = (events, connect) => {
  const f = new URLSearchParams({ url, description: connect ? "OLLO — connected accounts" : "OLLO — platform", "metadata[app]": "ollo" });
  events.forEach((e, i) => f.set(`enabled_events[${i}]`, e));
  if (connect) f.set("connect", "true");
  return f.toString();
};
for (const [events, connect] of [[EVENTS, false], [CONNECT_EVENTS, true]]) {
  const have = existing.find((w) => !!w.application === false && (w.metadata?.connect === "true") === connect) || existing.find((w) => (w.description || "").includes(connect ? "connected" : "platform"));
  if (have) {
    const f = new URLSearchParams({ description: connect ? "OLLO — connected accounts" : "OLLO — platform" });
    events.forEach((e, i) => f.set(`enabled_events[${i}]`, e));
    await api(`/webhook_endpoints/${have.id}`, f.toString());
    console.log(`Updated ${connect ? "connected-account" : "platform"} endpoint ${have.id} (${events.length} events). Secret unchanged.`);
  } else {
    const w = await api("/webhook_endpoints", form(events, connect));
    console.log(`Created ${connect ? "connected-account" : "platform"} endpoint ${w.id} (${events.length} events)`);
    console.log(`  STRIPE_WEBHOOK_SECRET${connect ? "_CONNECT" : ""}=${w.secret}`);
  }
}
// Apple Pay / Google Pay on Checkout: register the app's domain so the wallet buttons show on the
// pay-link page the customer opens from the QR (this is what makes "tap at the chair" work today).
const host = origin.replace(/^https?:\/\//, "");
const domains = (await api("/payment_method_domains?limit=100")).data;
let dom = domains.find((d) => d.domain_name === host);
if (!dom) { dom = await api("/payment_method_domains", new URLSearchParams({ domain_name: host }).toString()); console.log(`Registered payment-method domain ${host}`); }
else { dom = await api(`/payment_method_domains/${dom.id}/validate`, "").catch(() => dom); }
const st = (k) => dom[k]?.status || "?";
console.log(`Wallets on ${host}: apple_pay=${st("apple_pay")} google_pay=${st("google_pay")} link=${st("link")}${st("apple_pay") !== "active" ? ` (${dom.apple_pay?.status_details?.error_message || "Apple Pay needs the domain-association file — served at /.well-known/apple-developer-merchantid-domain-association by the app"})` : ""}`);

console.log(`
Two endpoints means two signing secrets. The app verifies against STRIPE_WEBHOOK_SECRET and, when
set, STRIPE_WEBHOOK_SECRET_CONNECT — set both.

Dashboard to-dos (no API for these):
  1. https://dashboard.stripe.com/settings/connect/platform-profile  → accept loss liability
  2. https://dashboard.stripe.com/settings/radar                     → Radar for Platforms on
  3. https://dashboard.stripe.com/settings/connect/branding           → OLLO logo + colour
  ${acct.details_submitted ? "" : "5. Complete the platform business profile before going live (charges_enabled is false)."}
`);
