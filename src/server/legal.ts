// Legal documents and GDPR plumbing.
//
// The four documents are versioned in code so a change is a commit, and every acceptance records
// the exact version agreed. Roles under UK GDPR: the SHOP is the data controller for its customers;
// foliyo is the processor (the DPA governs that); foliyo is the controller for the shop owner's and
// staff's own account data (the Privacy Policy covers that).
//
// DRAFTS: written to UK GDPR / DPA 2018 / PECR shape. Have a solicitor review before relying on them.
import type { Context } from "hono";
import type { Database } from "../db/client";

export type LegalDoc = "terms" | "privacy" | "dpa" | "cookies";
export const LEGAL_DOCS: readonly LegalDoc[] = ["terms", "privacy", "dpa", "cookies"] as const;

// Bump when a document's substance changes. Owners are re-asked to accept on their next sign-in
// when the version they accepted differs (see /auth/legal/status).
export const LEGAL_VERSIONS: Record<LegalDoc, string> = {
  terms: "2026-09-27",
  privacy: "2026-09-27",
  dpa: "2026-09-27",
  cookies: "2026-09-27",
};

export const COMPANY = {
  name: "foliyo",
  legal: "foliyo Ltd", // TODO confirm registered name + company number
  address: "United Kingdom", // TODO registered office
  email: "privacy@foliyo.co.uk", // TODO confirm mailbox exists
  ico: "", // TODO ICO registration number once registered
};

// Sub-processors — every third party that touches personal data on foliyo's behalf.
export const SUB_PROCESSORS = [
  { name: "Supabase Inc.", purpose: "Database and file storage (Postgres, object storage)", location: "AWS eu-west-1 (Ireland)", data: "All application data" },
  { name: "Vercel Inc.", purpose: "Application hosting, edge network, scheduled jobs", location: "London (lhr1) region; global edge for static assets", data: "Request data in transit, server logs" },
  { name: "Stripe Payments UK Ltd", purpose: "Card payments, deposits, payouts to shops and staff (Stripe Connect)", location: "UK / EU / USA (Stripe DPA + SCCs)", data: "Payment card data (never stored by foliyo), payer name, email, amounts" },
  { name: "Resend Inc.", purpose: "Transactional email delivery", location: "USA (DPA + SCCs)", data: "Recipient email address, message content" },
  { name: "ClickSend Pty Ltd", purpose: "SMS delivery", location: "Australia / UK routes (DPA + SCCs)", data: "Recipient mobile number, message content" },
  { name: "Infobip Ltd", purpose: "WhatsApp Business messaging (where a shop enables it)", location: "EU / UK", data: "Recipient mobile number, message content" },
  { name: "ElevenLabs Inc.", purpose: "AI phone receptionist (where a shop enables it)", location: "USA (DPA + SCCs)", data: "Call audio, transcripts, caller number" },
  { name: "Sentry (Functional Software Inc.)", purpose: "Error monitoring (where enabled)", location: "EU region", data: "Error messages, stack traces, route — no request bodies or cookies" },
] as const;

type Section = { h: string; p: string[] };
type Document = { title: string; summary: string; sections: Section[] };

const S = COMPANY;

export function legalDocument(doc: LegalDoc): Document {
  switch (doc) {
    case "terms":
      return {
        title: "Terms of Service",
        summary: `These terms govern the use of ${S.name} by businesses ("shops") and the people who work in them. By creating a shop or accepting an invitation you agree to them.`,
        sections: [
          { h: "1. Who we are", p: [`${S.name} is operated by ${S.legal} (\"we\", \"us\"). Contact: ${S.email}.`] },
          { h: "2. The service", p: [
            `${S.name} is booking and business software for appointment-based businesses: online booking, a calendar, customer records, messaging (SMS, email, WhatsApp), payments via Stripe, staff pay and reporting.`,
            "We may change, add or withdraw features. Where a change materially reduces what your plan includes we will give at least 30 days' notice by email.",
          ] },
          { h: "3. Your account", p: [
            "You must be 18 or over and authorised to bind the business you sign up for. Keep your password secret; you are responsible for activity under your account. Tell us immediately if you suspect unauthorised access.",
            "You decide which of your team can access the workspace and what they can see. You are responsible for removing access when someone leaves.",
          ] },
          { h: "4. Trial, plans and payment", p: [
            "New shops get a free trial (currently 14 days) with no card required. When it ends, new bookings pause until a plan is active; your data stays.",
            "Plan prices are shown before you choose. Prices are what you pay — we are not VAT-registered; if that changes we will say so and prices will show VAT separately. Seats are billed pro-rata when staff are added or removed.",
            "Invoices are payable within 7 days. If an invoice is unpaid 7 days after its due date, new bookings pause until it is settled. Your team can still sign in and see everything. You can cancel at any time from Settings → Billing; access continues to the end of the paid period.",
          ] },
          { h: "5. Payments taken through the service", p: [
            `Card payments and deposits are processed by Stripe. ${S.name} is the merchant of record and Stripe Connect transfers each shop's and each staff member's share to their own Stripe account. Stripe's terms apply to those accounts. We are not a bank; balances are held by Stripe.`,
            "You are responsible for your refund, deposit and cancellation policies and for honouring them. Chargebacks and disputes on your bookings are charged back to your shop's share.",
          ] },
          { h: "6. Messages sent on your behalf", p: [
            "Confirmations, reminders and other messages are sent in your shop's name to your customers. You must have a lawful basis to contact them (a booking is one). Marketing messages need the customer's consent; the customer record has a marketing opt-in flag and it defaults to off.",
            "SMS, WhatsApp and AI receptionist minutes are metered and billed as shown on your plan.",
          ] },
          { h: "7. Your data and your customers' data", p: [
            "You own your shop's data. You are the data controller for your customers; we process it on your instructions under the Data Processing Agreement, which forms part of these terms.",
            "You can export your customers at any time (Customers → Export) and request a full export by emailing us. On termination we keep your data for 30 days so you can export it, then delete it, except where we must keep records (for example invoices for 6 years).",
          ] },
          { h: "8. Acceptable use", p: [
            "Do not use the service to send unsolicited marketing, to store data you have no right to hold, to harass anyone, or in breach of any law. Do not attempt to access other shops' data or to probe or disrupt the service.",
            "We may suspend a shop that breaches these terms. Where practical we will warn you first. A suspended shop can still sign in and read its data.",
          ] },
          { h: "9. Availability and support", p: [
            "We aim for the service to be available at all times but do not guarantee it. Planned maintenance is announced in the workspace. Support is by email and through the workspace; response times depend on plan.",
          ] },
          { h: "10. Liability", p: [
            "Nothing in these terms limits liability for death or personal injury caused by negligence, fraud, or anything else that cannot lawfully be limited.",
            "Otherwise, our total liability to you in any 12-month period is limited to the fees you paid us in that period. We are not liable for loss of profit, loss of business, or indirect or consequential loss. The service is provided on an \"as is\" basis; you are responsible for checking that it suits your business.",
          ] },
          { h: "11. Changes to these terms", p: ["We may update these terms. We will email owners at least 14 days before a material change takes effect and ask you to accept the new version at your next sign-in. If you do not agree, you may cancel before the change applies."] },
          { h: "12. Law", p: ["These terms are governed by the law of England and Wales and the courts of England and Wales have exclusive jurisdiction."] },
        ],
      };
    case "privacy":
      return {
        title: "Privacy Policy",
        summary: `How ${S.name} uses personal data. Two hats: for shop owners and staff, we are the controller of your account data. For a shop's customers, the shop is the controller and we are its processor — the shop's own privacy notice applies, and ours explains what we do underneath.`,
        sections: [
          { h: "1. Controller", p: [`${S.legal}, ${S.address}. Contact for privacy matters: ${S.email}.${S.ico ? ` ICO registration ${S.ico}.` : ""}`] },
          { h: "2. If you run or work in a shop (we are the controller)", p: [
            "What we collect: name, email, password (hashed), mobile number if you verify one, role, sign-in times, IP address and browser for security logs, billing contact and invoices, and what you do in the workspace (audit trail).",
            "Why: to provide the service (contract); to keep it secure and prevent abuse (legitimate interests); to bill you (contract and legal obligation); to send service emails such as trial ending, invoices and security notices (contract); to send product news only if you opt in (consent, withdrawable any time).",
            "How long: for as long as your shop is active plus 30 days; invoices and payment records 6 years (HMRC); security and audit logs 12 months.",
          ] },
          { h: "3. If you are a shop's customer (the shop is the controller)", p: [
            "A shop using our software collects your name, mobile number, email, booking details, notes it makes about your visits, payment status, reviews you leave and your marketing preference. It decides why and how long. Ask the shop for its privacy notice.",
            "What we do with it: store it, send the messages the shop asks us to (confirmations, reminders, offers you have signed up for), take payments via Stripe, and show it to the shop's team. We never use one shop's customer data for another shop, for our own marketing, or to build profiles.",
            "Your rights are exercised against the shop, but you can act directly too: from your account page on the shop's site you can export everything the shop holds about you and delete your account. A shop can erase your personal data from its records on request; the booking history survives without your name or contact details so their accounts still add up.",
          ] },
          { h: "4. Who we share data with", p: [
            "Our sub-processors, listed in the Data Processing Agreement and kept current there: hosting and database (Supabase, Vercel), payments (Stripe), email (Resend), SMS (ClickSend), WhatsApp (Infobip), AI receptionist (ElevenLabs), error monitoring (Sentry). Each is bound by a contract that meets UK GDPR Article 28.",
            "Where a provider is outside the UK we rely on the UK International Data Transfer Addendum or an adequacy decision. Card details go to Stripe directly and never touch our servers.",
            "We share data with authorities only where the law requires it.",
          ] },
          { h: "5. Cookies", p: ["We use strictly necessary cookies only: a session cookie when you sign in, and a customer session cookie when you sign in to a shop's site. No analytics or advertising cookies. See the Cookie Policy."] },
          { h: "6. Security", p: ["Data is encrypted in transit (TLS) and at rest. Passwords are hashed (PBKDF2). Sessions are hashed tokens with expiry. Access to production is restricted to named staff with audit logs. Card data is handled by Stripe (PCI DSS Level 1). If a breach is likely to affect your rights we will tell the affected shop within 72 hours of becoming aware, and the ICO where required."] },
          { h: "7. Your rights", p: [
            "Access, rectification, erasure, restriction, portability, objection and the right not to be subject to solely automated decisions with legal effect (we make none). To exercise them email us; we respond within one month. You can complain to the Information Commissioner's Office (ico.org.uk).",
            "Shop owners can do most of this themselves: Settings → Account for your details; Customers → Export for your data; and each customer's profile has an Erase action.",
          ] },
          { h: "8. Children", p: ["The service is for businesses and adults. A booking may be for a child (\"booked for Sam, age 8\") — the booker is the adult whose details we hold."] },
          { h: "9. Changes", p: ["We will post changes here with a new version date and email owners about material changes."] },
        ],
      };
    case "dpa":
      return {
        title: "Data Processing Agreement",
        summary: `This DPA is part of the Terms of Service. It sets out how ${S.name} (processor) handles personal data on behalf of each shop (controller) under UK GDPR Article 28.`,
        sections: [
          { h: "1. Parties and scope", p: [`The Controller is the shop that accepted the Terms. The Processor is ${S.legal}. This DPA covers all personal data the Controller enters into or collects through the service about its customers, prospective customers and staff.`] },
          { h: "2. Nature and purpose of processing", p: ["Storing, displaying, sending messages about, and taking payments for appointments; maintaining customer and staff records; producing reports and pay runs; and the ancillary processing needed to run the service (backups, logs, support)."] },
          { h: "3. Categories of data and data subjects", p: [
            "Data subjects: the Controller's customers and prospective customers, the people a booking is made for, and the Controller's staff.",
            "Data: identity and contact details (name, mobile, email), booking history, notes the Controller records, payment status and amounts (not card numbers), reviews, marketing preference, and for staff their schedule, pay terms and earnings.",
            "No special-category data is expected. Controllers must not record health or other special-category data in free-text notes; if they do, they are responsible for having a lawful basis.",
          ] },
          { h: "4. Processor obligations", p: [
            "We process only on the Controller's documented instructions (including this DPA and the Controller's use of the product's controls) unless the law requires otherwise, in which case we tell the Controller first where permitted.",
            "We ensure staff with access are bound by confidentiality; we implement the security measures in Schedule 2; we assist with data-subject requests and with Articles 32–36 (security, breach notice, DPIAs); we delete or return data at the end of the service per the Terms; we make available the information needed to demonstrate compliance and allow audits on reasonable notice, no more than once a year unless required by a regulator or following a breach.",
            "We notify the Controller without undue delay, and in any case within 72 hours, of a personal-data breach affecting its data.",
          ] },
          { h: "5. Sub-processors", p: [
            "The Controller authorises the sub-processors in Schedule 1. We will give at least 30 days' notice of additions or replacements by email to the shop owner; the Controller may object on reasonable data-protection grounds, in which case either party may terminate the affected service. We impose equivalent obligations on every sub-processor and remain liable for their performance.",
          ] },
          { h: "6. International transfers", p: ["Data is stored in the UK/EU (Supabase eu-west-1, Vercel London). Where a sub-processor processes outside the UK, transfers are made under the UK Addendum to the EU SCCs or an adequacy regulation."] },
          { h: "7. Controller obligations", p: ["The Controller warrants it has a lawful basis for the data it enters, provides its own privacy notice to its customers, obtains consent for marketing messages, and does not instruct processing that would breach the law."] },
          { h: "8. Term and deletion", p: ["This DPA lasts as long as we process data for the Controller. On termination, data is available for export for 30 days, then deleted from live systems within 30 days and from backups within 90 days, except records we must retain by law."] },
          { h: "Schedule 1 — Sub-processors", p: SUB_PROCESSORS.map((s) => `${s.name} — ${s.purpose}. Location: ${s.location}. Data: ${s.data}.`) },
          { h: "Schedule 2 — Technical and organisational measures", p: [
            "Encryption in transit (TLS 1.2+) and at rest; per-shop tenancy enforced in every query and by database constraints; hashed passwords (PBKDF2-SHA256, 100k iterations) and hashed session and reset tokens; role-based access within the workspace; same-origin enforcement and rate limiting on all endpoints; immutable audit trail of changes; automated daily database backups (Supabase); least-privilege production access limited to named staff; error reports exclude request bodies and cookies; secrets held in the hosting provider's encrypted store, never in code; and a documented breach-response procedure.",
          ] },
        ],
      };
    case "cookies":
      return {
        title: "Cookie Policy",
        summary: `${S.name} uses only the cookies it needs to keep you signed in. There is no advertising, no analytics tracking and nothing from third parties.`,
        sections: [
          { h: "Cookies we set", p: [
            "ollo_session — set when a shop owner or staff member signs in to the workspace. Identifies your session. HttpOnly, Secure, SameSite=Strict. Lasts 7 days or until you sign out.",
            "ollo_customer — set when a customer signs in to a shop's site to see their visits. Scoped to that shop. HttpOnly, Secure. Lasts 90 days or until you sign out.",
            "Stripe may set its own cookies on its hosted payment pages; those are covered by Stripe's cookie policy.",
          ] },
          { h: "Local storage", p: ["The workspace remembers small preferences on your device (for example calendar density and which barbers you last showed). These never leave your browser and hold no personal data beyond your own choices."] },
          { h: "Why no banner", p: ["Under PECR, strictly necessary cookies do not need consent. We set none that do. If we ever add analytics we will ask first."] },
          { h: "Managing cookies", p: ["You can clear cookies in your browser at any time; you will be signed out. Blocking cookies entirely prevents signing in."] },
        ],
      };
  }
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Server-rendered page: no JS, indexable, print-friendly. Same brand shell as the landing page.
export function legalPage(doc: LegalDoc, origin: string): string {
  const d = legalDocument(doc);
  const version = LEGAL_VERSIONS[doc];
  const nav = LEGAL_DOCS.map((k) => `<a href="/legal/${k}"${k === doc ? ' aria-current="page"' : ""}>${esc(legalDocument(k).title)}</a>`).join("");
  const body = d.sections.map((s) => `<section><h2>${esc(s.h)}</h2>${s.p.map((p) => `<p>${esc(p)}</p>`).join("")}</section>`).join("");
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(d.title)} · foliyo</title><meta name="description" content="${esc(d.summary)}"/><link rel="canonical" href="${esc(origin)}/legal/${doc}"/>
<link rel="icon" href="/favicon.svg"/>
<style>
:root{--ink:#14151a;--muted:#5b6178;--line:#e2e4ee;--accent:#3a7563;--canvas:#f5f6fb}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:16px/1.6 -apple-system,Segoe UI,Inter,Arial,sans-serif}
header{background:#0b1a17;padding:18px 24px}header img{height:28px;display:block}
main{max-width:760px;margin:0 auto;padding:32px 20px 80px}
nav.legal{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 28px}nav.legal a{padding:8px 14px;border-radius:999px;border:1px solid var(--line);background:#fff;color:var(--ink);text-decoration:none;font-size:14px}nav.legal a[aria-current]{background:var(--accent);border-color:var(--accent);color:#fff}
h1{font-size:34px;line-height:1.15;letter-spacing:-.02em;margin:0 0 6px}.meta{color:var(--muted);font-size:14px;margin:0 0 18px}.summary{font-size:18px;color:#3c3f48;margin:0 0 32px;padding:18px 20px;background:#fff;border-radius:14px;border:1px solid var(--line)}
h2{font-size:20px;margin:32px 0 8px}p{margin:0 0 12px}
.draft{background:#fff7e6;border:1px solid #f1d59b;color:#6b4e00;border-radius:10px;padding:10px 14px;font-size:14px;margin:0 0 24px}
footer{color:var(--muted);font-size:13px;margin-top:48px;border-top:1px solid var(--line);padding-top:16px}footer a{color:var(--muted)}
@media print{header,nav.legal,.draft{display:none}body{background:#fff}}
</style></head><body>
<header><a href="/" aria-label="foliyo home"><img src="/static/brand/foliyo-wordmark-white.svg" alt="foliyo"/></a></header>
<main>
<nav class="legal" aria-label="Legal documents">${nav}</nav>
<h1>${esc(d.title)}</h1>
<p class="meta">Version ${esc(version)} · ${esc(S.legal)}</p>
<p class="summary">${esc(d.summary)}</p>
${body}
<footer>Questions: <a href="mailto:${esc(S.email)}">${esc(S.email)}</a> · <a href="/legal/terms">Terms</a> · <a href="/legal/privacy">Privacy</a> · <a href="/legal/dpa">DPA</a> · <a href="/legal/cookies">Cookies</a></footer>
</main></body></html>`;
}

// ---- Acceptance --------------------------------------------------------------------------------
export async function ipHash(c: Context): Promise<string> {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "";
  if (!ip) return "";
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export type AcceptanceSubject = "OWNER" | "STAFF" | "CUSTOMER";

// One statement per document; call inside the same batch as the signup so nothing is half-done.
export function acceptanceStatements(
  db: Database,
  c: Context,
  who: { user_id?: string | null; shop_id?: string | null; customer_account_id?: string | null; subject: AcceptanceSubject },
  docs: LegalDoc[],
  meta: { ip_hash: string; now?: number },
) {
  const now = meta.now ?? Date.now();
  const ua = (c.req.header("user-agent") || "").slice(0, 200);
  return docs.map((doc) =>
    db
      .prepare("INSERT INTO legal_acceptances(id,user_id,shop_id,customer_account_id,subject,document,version,accepted_at,ip_hash,user_agent) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), who.user_id ?? null, who.shop_id ?? null, who.customer_account_id ?? null, who.subject, doc, LEGAL_VERSIONS[doc], now, meta.ip_hash, ua),
  );
}

// Which documents this user still needs to accept at the current version.
export async function outstandingFor(db: Database, userId: string, required: LegalDoc[]): Promise<LegalDoc[]> {
  const rows = (
    await db
      .prepare("SELECT document, version FROM legal_acceptances WHERE user_id=? AND (document, accepted_at) IN (SELECT document, MAX(accepted_at) FROM legal_acceptances WHERE user_id=? GROUP BY document)")
      .bind(userId, userId)
      .all<{ document: LegalDoc; version: string }>()
  ).results;
  const have = new Map(rows.map((r) => [r.document, r.version]));
  return required.filter((d) => have.get(d) !== LEGAL_VERSIONS[d]);
}

export const OWNER_DOCS: LegalDoc[] = ["terms", "privacy", "dpa"];
export const STAFF_DOCS: LegalDoc[] = ["terms", "privacy"];
