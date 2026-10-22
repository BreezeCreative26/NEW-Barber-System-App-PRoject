// Platform marketing: turn any CSV into a clean prospect list, then text and email it about foliyo.
// Everything here is for foliyo itself (not for shops): super admins only.
//
// Rules built in, because these are unsolicited-style messages in the UK (PECR / UK GDPR):
//  - every email carries the company identity and a one-click unsubscribe; every text says "Reply STOP to opt out"
//  - an unsubscribed contact (or a STOP reply) is never contacted again, whatever list they are in
//  - texts only go out 09:00 to 20:00 UK time, Monday to Saturday
//  - a campaign cannot start until an admin confirms the contacts may lawfully be contacted
import { Hono } from "hono";
import type { Context } from "hono";
import type { Database as DB } from "../db/client";
import { parseCsv } from "./import";
import { platformBilling } from "./billing";
import { deliverDirect, msgShop, renderPlatformEmail } from "./messaging";

const uid = () => crypto.randomUUID();
const token = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");

// ---- The extraction engine ---------------------------------------------------------------------
export type Extracted = { name: string; first_name: string; business: string; phone: string; landline: string; email: string; rows: number[]; notes: string[] };
export type ExtractResult = {
  rows_read: number;
  contacts: Extracted[];
  stats: { contacts: number; with_mobile: number; with_email: number; with_both: number; landline_only: number; email_only: number; no_contact_details: number; duplicates_merged: number; bad_numbers: number; bad_emails: number };
  problems: { row: number; text: string; why: string }[];
  headers: string[] | null;
};

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE_RE = /(?:\+|00)?\(?\d[\d\s().\-–]{6,}\d/g;
const BUSINESS_WORDS = /\b(barber|barbers|barbershop|barber shop|salon|hair|hairdress\w*|cuts?|studio|lounge|grooming|ltd|limited|llp|&|and sons|co\.?|company|the)\b/i;
const HEADER_WORDS = /^(name|full name|first name|last name|surname|forename|contact|owner|business|business name|company|shop|salon|trading name|phone|mobile|tel|telephone|cell|email|e-mail|email address|address|postcode|town|city|website|notes?)$/i;
const BAD_FIRST = new Set(["the", "mr", "mrs", "ms", "miss", "dr", "sir", "info", "hello", "contact", "admin", "enquiries", "sales", "shop", "salon", "barber", "barbers"]);

export type Normalised = { kind: "mobile" | "landline" | "other"; e164: string } | null;
// UK numbers in any common spelling: 07xxx xxxxxx, +44 7xxx, 0044 7xxx, 447xxx, (0)7xxx, 7xxx xxxxxx.
export function normaliseUk(raw: string): Normalised {
  let d = raw.replace(/\(0\)/g, "").replace(/[^\d+]/g, "");
  if (d.startsWith("00")) d = "+" + d.slice(2);
  if (d.startsWith("+")) {
    if (!d.startsWith("+44")) return /^\+\d{8,15}$/.test(d) ? { kind: "other", e164: d } : null;
    d = "0" + d.slice(3);
  } else if (/^44\d{10}$/.test(d)) d = "0" + d.slice(2);
  else if (/^7\d{9}$/.test(d)) d = "0" + d; // dropped leading zero (common in spreadsheets)
  else if (/^[1-3]\d{9}$/.test(d)) d = "0" + d;
  if (!/^0\d{9,10}$/.test(d)) return null;
  const national = d.slice(1);
  if (/^7[1-9]\d{8}$/.test(national) && !/^70/.test(national) && !/^76/.test(national)) return { kind: "mobile", e164: `+44${national}` };
  if (/^[123]\d{8,9}$/.test(national)) return { kind: "landline", e164: `+44${national}` };
  return null; // 070 personal numbers, 076 pagers, 08xx / 09xx service numbers: not textable
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_m, a, b) => a + b.toUpperCase());
const cleanName = (s: string) => titleCase(s.replace(/[^A-Za-z\u00C0-\u024F'’\- .]/g, " ").replace(/\s+/g, " ").trim());

export function extractContacts(csvText: string): ExtractResult {
  const table = parseCsv(csvText);
  const first = table[0] ?? [];
  const hasHeader = first.length > 0 && first.filter((c) => HEADER_WORDS.test(c.trim())).length >= Math.min(2, first.length) && !first.some((c) => EMAIL_RE.test(c) || /\d{7,}/.test(c.replace(/\D/g, "")));
  EMAIL_RE.lastIndex = 0;
  const headers = hasHeader ? first.map((h) => h.trim()) : null;
  const body = hasHeader ? table.slice(1) : table;
  const col = (re: RegExp) => (headers ? headers.findIndex((h) => re.test(h)) : -1);
  const iFirst = col(/^(first name|forename|first)$/i), iLast = col(/^(last name|surname|last)$/i);
  const iName = col(/^(name|full name|contact|contact name|owner)$/i);
  const iBiz = col(/^(business|business name|company|shop|salon|trading name|shop name)$/i);

  const problems: ExtractResult["problems"] = [];
  const found: Extracted[] = [];
  let badNumbers = 0, badEmails = 0, noDetails = 0;
  body.forEach((cells, idx) => {
    const rowNo = idx + (hasHeader ? 2 : 1);
    const text = cells.join(" · ").slice(0, 120);
    const emails = new Set<string>();
    let mobile = "", landline = "";
    const notes: string[] = [];
    for (const raw of cells) {
      const cell = raw.trim();
      if (!cell) continue;
      for (const m of cell.match(EMAIL_RE) ?? []) emails.add(m.toLowerCase().replace(/[.,;]+$/, ""));
      const without = cell.replace(EMAIL_RE, " ");
      // A cell that is only digits and separators is one number; otherwise look for numbers inside the text.
      const bits = /^[\d\s+().\-–/]+$/.test(without) ? [without] : without.match(PHONE_RE) ?? [];
      for (const b of bits) {
        // Cells holding two numbers ("07700 900123 / 01622 123456") split on slashes, "or", "&".
        for (const part of b.split(/\s*(?:\/|&|\bor\b|;|,)\s*/i)) {
          if (part.replace(/\D/g, "").length < 9) continue;
          const n = normaliseUk(part);
          if (!n) { badNumbers++; problems.push({ row: rowNo, text, why: `"${part.trim()}" is not a valid UK number` }); continue; }
          if (n.kind === "mobile") mobile = mobile || n.e164;
          else if (n.kind === "landline") landline = landline || n.e164;
          else { mobile = mobile || ""; notes.push(`International number ${n.e164} skipped`); }
        }
      }
    }
    for (const e of Array.from(emails)) {
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e) || /\.(png|jpg|gif|svg)$/i.test(e)) { emails.delete(e); badEmails++; problems.push({ row: rowNo, text, why: `"${e}" does not look like an email address` }); }
    }
    const email = Array.from(emails)[0] ?? "";
    if (!mobile && !landline && !email) { noDetails++; if (cells.some((c) => c.trim())) problems.push({ row: rowNo, text, why: "No phone number or email found" }); return; }

    // Names: mapped columns win; otherwise the first plain-words cell that is not a business, phone or email.
    let business = iBiz >= 0 ? (cells[iBiz] ?? "").trim() : "";
    let name = "";
    if (iFirst >= 0 || iLast >= 0) name = `${cells[iFirst] ?? ""} ${cells[iLast] ?? ""}`.trim();
    else if (iName >= 0) name = (cells[iName] ?? "").trim();
    if (!name || !business) {
      for (const raw of cells) {
        const c = raw.trim();
        if (!c || c.includes("@") || /\d{4,}/.test(c)) continue;
        if (/^[A-Za-z\u00C0-\u024F'’\-. &]+$/.test(c) && c.split(/\s+/).length <= 6) {
          if (BUSINESS_WORDS.test(c) && c.split(/\s+/).length > 1 && !business) business = c;
          else if (!name && !BUSINESS_WORDS.test(c) && c.split(/\s+/).length <= 4) name = c;
          else if (!business && BUSINESS_WORDS.test(c)) business = c;
        }
      }
    }
    if (!business && name && BUSINESS_WORDS.test(name) && name.split(/\s+/).length > 2) { business = name; name = ""; }
    name = cleanName(name);
    const firstName = name.split(" ")[0] && !BAD_FIRST.has(name.split(" ")[0].toLowerCase()) ? name.split(" ")[0] : "";
    if (!email && !mobile && landline) notes.push("Landline only: cannot be texted");
    found.push({ name, first_name: firstName, business: business.replace(/\s+/g, " ").trim(), phone: mobile, landline, email, rows: [rowNo], notes });
  });

  // Merge duplicates: same mobile or same email (also keeps the fullest details).
  const byPhone = new Map<string, Extracted>(), byEmail = new Map<string, Extracted>();
  const out: Extracted[] = [];
  let merged = 0;
  for (const c of found) {
    const hit = (c.phone && byPhone.get(c.phone)) || (c.email && byEmail.get(c.email)) || null;
    if (hit) {
      merged++;
      hit.rows.push(...c.rows);
      for (const k of ["name", "first_name", "business", "phone", "landline", "email"] as const) if (!hit[k] && c[k]) hit[k] = c[k];
      if (hit.phone) byPhone.set(hit.phone, hit);
      if (hit.email) byEmail.set(hit.email, hit);
      continue;
    }
    out.push(c);
    if (c.phone) byPhone.set(c.phone, c);
    if (c.email) byEmail.set(c.email, c);
  }
  const withMobile = out.filter((c) => c.phone).length, withEmail = out.filter((c) => c.email).length;
  return {
    rows_read: body.length,
    contacts: out,
    stats: {
      contacts: out.length, with_mobile: withMobile, with_email: withEmail,
      with_both: out.filter((c) => c.phone && c.email).length,
      landline_only: out.filter((c) => !c.phone && !c.email && c.landline).length,
      email_only: out.filter((c) => !c.phone && c.email).length,
      no_contact_details: noDetails, duplicates_merged: merged, bad_numbers: badNumbers, bad_emails: badEmails,
    },
    problems: problems.slice(0, 60),
    headers,
  };
}

// ---- Merge fields and rendering ----------------------------------------------------------------
export const DEFAULT_COPY = {
  subject: "Run your barber shop on foliyo",
  heading: "Your own booking app, ready in minutes.",
  body: "Hi {first},\n\nfoliyo is new booking software for barber shops. Your customers book on your own page with your logo, you get one shared calendar for the whole team, and texts and reminders are built in.\n\nIt takes a few minutes to set up and there is a free trial.",
  sms_body: "Hi {first}, it's foliyo. New booking software for barbers: your own booking page, calendar and reminders. Free trial: {link}",
  cta_label: "Start your free trial",
  why: "You are receiving this because we think foliyo is relevant to {business}, a business we found publicly listed as a barber or hair business.",
};
type Contact = { id: string; name: string; first_name: string; business: string; phone: string; email: string; unsub_token: string };
type Campaign = { id: string; name: string; channel: "SMS" | "EMAIL" | "BOTH"; list_name: string; subject: string; heading: string; body: string; sms_body: string; cta_label: string; cta_url: string; why: string; status: string };
const merge = (t: string, ct: Contact, link: string) => t.replace(/\{first\}/g, ct.first_name || "there").replace(/\{name\}/g, ct.name || "there").replace(/\{business\}/g, ct.business || "your shop").replace(/\{link\}/g, link);
const cleanFirst = (t: string) => t.replace(/Hi there,?/g, "Hi,");
export const linkFor = (c: Campaign, origin: string) => c.cta_url || `${origin}/signup`;

export function renderSms(c: Campaign, ct: Contact, origin: string) {
  let s = cleanFirst(merge(c.sms_body, ct, linkFor(c, origin))).trim();
  if (!/\bSTOP\b/i.test(s)) s += " Reply STOP to opt out.";
  return s;
}
export async function renderEmail(db: DB, c: Campaign, ct: Contact, origin: string) {
  const pb = await platformBilling(db);
  const anyShop = await db.prepare("SELECT id FROM shops ORDER BY created_at LIMIT 1").first<{ id: string }>();
  if (!anyShop) throw new Error("No shop exists yet to borrow the email layout from");
  const shell = await msgShop({ env: { DB: db } }, anyShop.id);
  const link = linkFor(c, origin);
  const unsub = `${origin}/u/${ct.unsub_token}`;
  const lines = cleanFirst(merge(c.body, ct, link)).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const html = renderPlatformEmail(shell, pb, origin, {
    subject: merge(c.subject, ct, link), heading: merge(c.heading || c.subject, ct, link), lines,
    cta: { label: c.cta_label || "Start free", href: link },
    footnote: `${merge(c.why || DEFAULT_COPY.why, ct, link)} To stop hearing from us, use the unsubscribe link below.`,
  }, unsub);
  return { subject: merge(c.subject, ct, link), html, text: `${lines.join("\n\n")}\n\n${c.cta_label}: ${link}\n\nUnsubscribe: ${unsub}`, from: pb.company_name || "foliyo", replyTo: pb.company_email || "" };
}

// ---- Sending ------------------------------------------------------------------------------------
// Texts: 09:00 to 20:00 UK time, Monday to Saturday.
export function smsWindowOpen(now = Date.now()) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", hour12: false }).formatToParts(new Date(now));
  const hour = Number(p.find((x) => x.type === "hour")?.value ?? 0) % 24;
  const wd = p.find((x) => x.type === "weekday")?.value;
  return wd !== "Sun" && hour >= 9 && hour < 20;
}

async function optedOutPhone(db: DB, phone: string) {
  return !!(await db.prepare("SELECT 1 AS x FROM wa_optouts WHERE phone=?").bind(phone.replace(/\D/g, "")).first());
}

export async function audience(db: DB, c: Campaign) {
  const rows = (await db.prepare("SELECT id, phone, email FROM marketing_contacts WHERE unsubscribed_at IS NULL AND (?='' OR list_name=?)").bind(c.list_name, c.list_name).all<{ id: string; phone: string; email: string }>()).results;
  const opted = new Set((await db.prepare("SELECT phone FROM wa_optouts").all<{ phone: string }>()).results.map((r) => r.phone));
  const sms = c.channel !== "EMAIL" ? rows.filter((r) => r.phone && !opted.has(r.phone.replace(/\D/g, ""))) : [];
  const email = c.channel !== "SMS" ? rows.filter((r) => r.email) : [];
  return { sms, email, contacts: new Set([...sms, ...email].map((r) => r.id)).size };
}

export async function startCampaign(db: DB, id: string, by: string) {
  const c = await db.prepare("SELECT * FROM marketing_campaigns WHERE id=?").bind(id).first<Campaign>();
  if (!c) throw new Error("Campaign not found");
  if (c.status === "DONE") throw new Error("This campaign has already been sent");
  const a = await audience(db, c);
  const now = Date.now();
  for (const r of a.sms) await db.prepare("INSERT INTO marketing_sends(id,campaign_id,contact_id,channel,recipient,created_at) VALUES(?,?,?,'SMS',?,?) ON CONFLICT DO NOTHING").bind(uid(), id, r.id, r.phone, now).run();
  for (const r of a.email) await db.prepare("INSERT INTO marketing_sends(id,campaign_id,contact_id,channel,recipient,created_at) VALUES(?,?,?,'EMAIL',?,?) ON CONFLICT DO NOTHING").bind(uid(), id, r.id, r.email, now).run();
  await db.prepare("UPDATE marketing_campaigns SET status='SENDING', recipients=?, started_at=COALESCE(started_at,?), consent_confirmed_by=?, consent_confirmed_at=? WHERE id=?").bind(a.contacts, now, by, now, id).run();
  return a;
}

// Sends the next batch of queued messages. Called straight after "send" and then by the 5-minute sweep.
export async function drainMarketing(db: DB, origin: string, opts: { sms?: number; email?: number; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const running = (await db.prepare("SELECT * FROM marketing_campaigns WHERE status='SENDING' ORDER BY started_at").all<Campaign>()).results;
  let sent = 0, failed = 0, waiting = 0;
  for (const c of running) {
    for (const [channel, limit] of [["EMAIL", opts.email ?? 60], ["SMS", opts.sms ?? 30]] as const) {
      if (channel === "SMS" && !smsWindowOpen(now)) { waiting += (await db.prepare("SELECT COUNT(*)::int AS n FROM marketing_sends WHERE campaign_id=? AND channel='SMS' AND status='QUEUED'").bind(c.id).first<{ n: number }>())?.n ?? 0; continue; }
      const batch = (await db.prepare("SELECT s.id AS send_id, s.recipient, ct.* FROM marketing_sends s JOIN marketing_contacts ct ON ct.id=s.contact_id WHERE s.campaign_id=? AND s.channel=? AND s.status='QUEUED' ORDER BY s.created_at LIMIT ?").bind(c.id, channel, limit).all<Contact & { send_id: string; recipient: string; unsubscribed_at: number | null }>()).results;
      for (const r of batch) {
        const skip = async (why: string) => { await db.prepare("UPDATE marketing_sends SET status='SKIPPED', error=? WHERE id=?").bind(why, r.send_id).run(); };
        if (r.unsubscribed_at) { await skip("Unsubscribed"); continue; }
        if (channel === "SMS" && (await optedOutPhone(db, r.recipient))) { await db.prepare("UPDATE marketing_contacts SET unsubscribed_at=?, unsub_reason='Replied STOP' WHERE id=? AND unsubscribed_at IS NULL").bind(now, r.id).run(); await skip("Replied STOP"); continue; }
        let d;
        if (channel === "EMAIL") {
          let em; try { em = await renderEmail(db, c, r, origin); } catch (e) { await db.prepare("UPDATE marketing_sends SET status='FAILED', error=? WHERE id=?").bind(e instanceof Error ? e.message : "render failed", r.send_id).run(); failed++; continue; }
          d = await deliverDirect(db, { channel: "EMAIL", to: r.recipient, subject: em.subject, body: em.text, html: em.html, fromName: em.from, replyTo: em.replyTo });
        } else d = await deliverDirect(db, { channel: "SMS", to: r.recipient, body: renderSms(c, r, origin), fromName: "foliyo" });
        if (d.ok) { await db.prepare("UPDATE marketing_sends SET status='SENT', provider=?, sent_at=?, attempts=attempts+1 WHERE id=?").bind(d.provider, now, r.send_id).run(); sent++; }
        else {
          failed++;
          await db.prepare("UPDATE marketing_sends SET status='FAILED', provider=?, error=?, attempts=attempts+1 WHERE id=?").bind(d.provider, d.error.slice(0, 300), r.send_id).run();
          if (/opted out/i.test(d.error)) await db.prepare("UPDATE marketing_contacts SET unsubscribed_at=?, unsub_reason='Replied STOP' WHERE id=? AND unsubscribed_at IS NULL").bind(now, r.id).run();
        }
      }
    }
    const left = (await db.prepare("SELECT COUNT(*)::int AS n FROM marketing_sends WHERE campaign_id=? AND status='QUEUED'").bind(c.id).first<{ n: number }>())?.n ?? 0;
    if (left === 0) await db.prepare("UPDATE marketing_campaigns SET status='DONE', finished_at=? WHERE id=? AND status='SENDING'").bind(now, c.id).run();
  }
  return { sent, failed, waiting };
}

// ---- Admin routes (mounted by admin.ts, super admins only) ---------------------------------------
type H = { need: (c: any, roles: any[]) => void; audit: (c: any, shop: string | null, action: string, before: unknown, after: unknown, reason: string) => Promise<void>; fail: (s: 400 | 404 | 409, m: string) => never };
const originOf = (c: Context<any>) => new URL(c.req.url).origin;
const campaignFields = ["name", "channel", "list_name", "subject", "heading", "body", "sms_body", "cta_label", "cta_url", "why"] as const;

export function mountMarketing(admin: Hono<any>, h: H) {
  const guard = (c: any) => h.need(c, ["SUPER"]);
  const input = async (c: any) => (await c.req.json().catch(() => ({}))) as Record<string, any>;

  admin.get("/marketing/overview", async (c) => {
    guard(c);
    const db = c.env.DB as DB;
    const [tot, lists, campaigns] = await Promise.all([
      db.prepare("SELECT COUNT(*)::int AS contacts, COUNT(*) FILTER (WHERE phone<>'' AND unsubscribed_at IS NULL)::int AS mobiles, COUNT(*) FILTER (WHERE email<>'' AND unsubscribed_at IS NULL)::int AS emails, COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed FROM marketing_contacts").first(),
      db.prepare("SELECT list_name AS name, COUNT(*)::int AS contacts FROM marketing_contacts GROUP BY list_name ORDER BY MAX(created_at) DESC").all(),
      db.prepare("SELECT c.*, (SELECT COUNT(*)::int FROM marketing_sends s WHERE s.campaign_id=c.id AND s.status='SENT') AS sent, (SELECT COUNT(*)::int FROM marketing_sends s WHERE s.campaign_id=c.id AND s.status='FAILED') AS failed, (SELECT COUNT(*)::int FROM marketing_sends s WHERE s.campaign_id=c.id AND s.status='QUEUED') AS queued FROM marketing_campaigns c ORDER BY c.created_at DESC LIMIT 30").all(),
    ]);
    return c.json({ totals: tot, lists: lists.results, campaigns: campaigns.results, defaults: DEFAULT_COPY, sms_window_open: smsWindowOpen() });
  });

  // Reads a CSV and shows exactly what the engine found, without saving anything.
  admin.post("/marketing/preview", async (c) => {
    guard(c);
    const b = await input(c);
    const text = String(b.csv || "");
    if (!text.trim()) h.fail(400, "Choose a CSV file first");
    if (text.length > 6_000_000) h.fail(400, "That file is too big. Split it into files under 6 MB.");
    const r = extractContacts(text);
    const db = c.env.DB as DB;
    let existing = 0, suppressed = 0;
    for (const ct of r.contacts.slice(0, 5000)) {
      const hit = await db.prepare("SELECT unsubscribed_at FROM marketing_contacts WHERE (?<>'' AND phone=?) OR (?<>'' AND LOWER(email)=?) LIMIT 1").bind(ct.phone, ct.phone, ct.email, ct.email).first<{ unsubscribed_at: number | null }>();
      if (hit) { existing++; if (hit.unsubscribed_at) suppressed++; }
    }
    return c.json({ ...r, contacts: r.contacts.slice(0, 50), contacts_total: r.contacts.length, already_in_system: existing, unsubscribed: suppressed });
  });

  admin.post("/marketing/import", async (c) => {
    guard(c);
    const b = await input(c);
    const list = String(b.list_name || "").trim().slice(0, 80);
    const basis = String(b.basis || "").trim().slice(0, 200);
    if (!list) h.fail(400, "Give this list a name");
    if (!b.confirm) h.fail(400, "Confirm you may contact these people before importing");
    const r = extractContacts(String(b.csv || ""));
    const db = c.env.DB as DB;
    const now = Date.now();
    let created = 0, updated = 0, skipped = 0;
    for (const ct of r.contacts) {
      if (!ct.phone && !ct.email) { skipped++; continue; }
      const hit = await db.prepare("SELECT id FROM marketing_contacts WHERE (?<>'' AND phone=?) OR (?<>'' AND LOWER(email)=?) LIMIT 1").bind(ct.phone, ct.phone, ct.email, ct.email).first<{ id: string }>();
      if (hit) {
        // Fill gaps only; never un-unsubscribe, never overwrite what we already hold.
        await db.prepare("UPDATE marketing_contacts SET name=CASE WHEN name='' THEN ? ELSE name END, first_name=CASE WHEN first_name='' THEN ? ELSE first_name END, business=CASE WHEN business='' THEN ? ELSE business END, landline=CASE WHEN landline='' THEN ? ELSE landline END, updated_at=? WHERE id=?").bind(ct.name, ct.first_name, ct.business, ct.landline, now, hit.id).run();
        updated++;
        continue;
      }
      try {
        await db.prepare("INSERT INTO marketing_contacts(id,list_name,name,first_name,business,phone,email,landline,basis,unsub_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(uid(), list, ct.name, ct.first_name, ct.business, ct.phone, ct.email, ct.landline, basis, token(), now, now).run();
        created++;
      } catch { skipped++; }
    }
    await h.audit(c, null, "MARKETING_IMPORT", {}, { list, created, updated, skipped }, basis);
    return c.json({ ok: true, created, updated, skipped, stats: r.stats });
  });

  admin.get("/marketing/contacts", async (c) => {
    guard(c);
    const q = `%${(c.req.query("q") || "").toLowerCase()}%`;
    const list = c.req.query("list") || "";
    const rows = (await (c.env.DB as DB).prepare("SELECT id,list_name,name,business,phone,email,landline,unsubscribed_at,unsub_reason,created_at FROM marketing_contacts WHERE (?='' OR list_name=?) AND (LOWER(name||' '||business||' '||phone||' '||email) LIKE ?) ORDER BY created_at DESC LIMIT 100").bind(list, list, q).all()).results;
    return c.json({ contacts: rows });
  });
  admin.post("/marketing/contacts/:id/unsubscribe", async (c) => {
    guard(c);
    await (c.env.DB as DB).prepare("UPDATE marketing_contacts SET unsubscribed_at=COALESCE(unsubscribed_at,?), unsub_reason=CASE WHEN unsubscribed_at IS NULL THEN 'Removed by admin' ELSE unsub_reason END WHERE id=?").bind(Date.now(), c.req.param("id")).run();
    return c.json({ ok: true });
  });
  admin.delete("/marketing/lists/:name", async (c) => {
    guard(c);
    // Unsubscribed people are kept so they can never be re-added by a later import.
    const r = await (c.env.DB as DB).prepare("DELETE FROM marketing_contacts WHERE list_name=? AND unsubscribed_at IS NULL").bind(decodeURIComponent(c.req.param("name"))).run();
    await h.audit(c, null, "MARKETING_LIST_DELETED", {}, { list: c.req.param("name"), removed: r.meta.changes }, "");
    return c.json({ ok: true, removed: r.meta.changes });
  });

  admin.post("/marketing/campaigns", async (c) => {
    guard(c);
    const b = await input(c);
    const id = uid();
    const v = (k: (typeof campaignFields)[number]) => String(b[k] ?? (DEFAULT_COPY as Record<string, string>)[k] ?? "").slice(0, k === "body" ? 4000 : 600);
    const channel = ["SMS", "EMAIL", "BOTH"].includes(b.channel) ? b.channel : "BOTH";
    if (!String(b.name || "").trim()) h.fail(400, "Give the campaign a name");
    await (c.env.DB as DB).prepare("INSERT INTO marketing_campaigns(id,name,channel,list_name,subject,heading,body,sms_body,cta_label,cta_url,why,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id, v("name"), channel, v("list_name"), v("subject"), v("heading"), v("body"), v("sms_body"), v("cta_label"), v("cta_url"), v("why"), c.get("admin").email, Date.now()).run();
    return c.json({ id });
  });
  admin.put("/marketing/campaigns/:id", async (c) => {
    guard(c);
    const b = await input(c);
    const cur = await (c.env.DB as DB).prepare("SELECT status FROM marketing_campaigns WHERE id=?").bind(c.req.param("id")).first<{ status: string }>();
    if (!cur) h.fail(404, "Campaign not found");
    if (cur!.status !== "DRAFT") h.fail(409, "Only drafts can be edited");
    const sets: string[] = [], vals: unknown[] = [];
    for (const k of campaignFields) if (k in b) { sets.push(`${k}=?`); vals.push(k === "channel" ? (["SMS", "EMAIL", "BOTH"].includes(b[k]) ? b[k] : "BOTH") : String(b[k]).slice(0, k === "body" ? 4000 : 600)); }
    if (sets.length) await (c.env.DB as DB).prepare(`UPDATE marketing_campaigns SET ${sets.join(",")} WHERE id=?`).bind(...vals, c.req.param("id")).run();
    return c.json({ ok: true });
  });
  admin.delete("/marketing/campaigns/:id", async (c) => {
    guard(c);
    await (c.env.DB as DB).prepare("DELETE FROM marketing_campaigns WHERE id=? AND status='DRAFT'").bind(c.req.param("id")).run();
    return c.json({ ok: true });
  });
  // Who would get it, and a rendered preview, before anything is sent.
  admin.get("/marketing/campaigns/:id/audience", async (c) => {
    guard(c);
    const db = c.env.DB as DB;
    const camp = await db.prepare("SELECT * FROM marketing_campaigns WHERE id=?").bind(c.req.param("id")).first<Campaign>();
    if (!camp) h.fail(404, "Campaign not found");
    const a = await audience(db, camp!);
    const sample = { id: "x", name: "Sam Jones", first_name: "Sam", business: "Sam's Barbers", phone: "", email: "", unsub_token: "preview" } as Contact;
    const em = camp!.channel === "SMS" ? null : await renderEmail(db, camp!, sample, originOf(c)).catch(() => null);
    return c.json({ sms: a.sms.length, email: a.email.length, contacts: a.contacts, sms_text: renderSms(camp!, sample, originOf(c)), sms_length: renderSms(camp!, sample, originOf(c)).length, email_html: em?.html ?? null, email_subject: em?.subject ?? null, sms_window_open: smsWindowOpen() });
  });
  admin.post("/marketing/campaigns/:id/test", async (c) => {
    guard(c);
    const b = await input(c);
    const db = c.env.DB as DB;
    const camp = await db.prepare("SELECT * FROM marketing_campaigns WHERE id=?").bind(c.req.param("id")).first<Campaign>();
    if (!camp) h.fail(404, "Campaign not found");
    const me = { id: "test", name: c.get("admin").name, first_name: String(c.get("admin").name).split(" ")[0], business: "Your shop", phone: "", email: "", unsub_token: "test" } as Contact;
    const out: Record<string, string> = {};
    if (b.email) {
      const em = await renderEmail(db, camp!, me, originOf(c));
      const d = await deliverDirect(db, { channel: "EMAIL", to: String(b.email), subject: `[Test] ${em.subject}`, body: em.text, html: em.html, fromName: em.from, replyTo: em.replyTo });
      out.email = d.ok ? `Sent via ${d.provider}` : `Failed: ${d.error}`;
    }
    if (b.phone) {
      const n = normaliseUk(String(b.phone));
      if (!n || n.kind !== "mobile") h.fail(400, "That is not a UK mobile number");
      const d = await deliverDirect(db, { channel: "SMS", to: n!.e164, body: renderSms(camp!, me, originOf(c)), fromName: "foliyo" });
      out.sms = d.ok ? `Sent via ${d.provider}` : `Failed: ${d.error}`;
    }
    return c.json(out);
  });
  admin.post("/marketing/campaigns/:id/send", async (c) => {
    guard(c);
    const b = await input(c);
    if (!b.confirm) h.fail(400, "Confirm the contacts can lawfully be contacted before sending");
    const db = c.env.DB as DB;
    const cur = await db.prepare("SELECT status, name FROM marketing_campaigns WHERE id=?").bind(c.req.param("id")).first<{ status: string; name: string }>();
    if (!cur) h.fail(404, "Campaign not found");
    if (cur!.status === "SENDING") h.fail(409, "This campaign is already sending");
    let a;
    try { a = await startCampaign(db, c.req.param("id"), c.get("admin").email); } catch (e) { h.fail(409, e instanceof Error ? e.message : "Could not start"); }
    await h.audit(c, null, "MARKETING_SEND", {}, { campaign: cur!.name, sms: a!.sms.length, email: a!.email.length }, "");
    const first = await drainMarketing(db, originOf(c));
    return c.json({ ok: true, queued: { sms: a!.sms.length, email: a!.email.length }, first_batch: first });
  });
  admin.post("/marketing/campaigns/:id/pause", async (c) => {
    guard(c);
    await (c.env.DB as DB).prepare("UPDATE marketing_campaigns SET status='PAUSED' WHERE id=? AND status='SENDING'").bind(c.req.param("id")).run();
    return c.json({ ok: true });
  });
  admin.post("/marketing/campaigns/:id/resume", async (c) => {
    guard(c);
    await (c.env.DB as DB).prepare("UPDATE marketing_campaigns SET status='SENDING' WHERE id=? AND status='PAUSED'").bind(c.req.param("id")).run();
    return c.json({ ok: true, ...(await drainMarketing(c.env.DB as DB, originOf(c))) });
  });
  admin.post("/marketing/process", async (c) => {
    guard(c);
    return c.json(await drainMarketing(c.env.DB as DB, originOf(c)));
  });
  admin.get("/marketing/campaigns/:id/sends", async (c) => {
    guard(c);
    const rows = (await (c.env.DB as DB).prepare("SELECT s.channel, s.status, s.error, s.sent_at, ct.name, ct.business, s.recipient FROM marketing_sends s JOIN marketing_contacts ct ON ct.id=s.contact_id WHERE s.campaign_id=? ORDER BY s.created_at DESC LIMIT 200").bind(c.req.param("id")).all()).results;
    return c.json({ sends: rows });
  });
}

// ---- Public unsubscribe page (no sign-in): /u/:token -------------------------------------------
export const marketingPublic = new Hono<{ Bindings: { DB: DB } }>();
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{margin:0;font:16px/1.5 -apple-system,Segoe UI,Inter,Arial,sans-serif;background:#f6f6f4;color:#0b0b0c;display:grid;min-height:100vh;place-items:center;padding:20px}main{background:#fff;border-radius:20px;padding:32px;max-width:420px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,.06)}h1{font-size:22px;margin:0 0 8px}p{color:#444}button{font:inherit;font-weight:600;background:#00e8b0;color:#0b0b0c;border:0;border-radius:12px;padding:14px 20px;width:100%;cursor:pointer;min-height:48px}</style></head><body><main>${body}</main></body></html>`;
// Customers of a shop unsubscribing from that shop's announcements.
marketingPublic.get("/c/:token", async (c) => {
  c.header("Cache-Control", "no-store");
  const t = c.req.param("token");
  const ct = t === "preview" ? { announce_unsub_at: null, name: "" } : (await c.env.DB.prepare("SELECT announce_unsub_at FROM customers WHERE unsub_token=?").bind(t).first<{ announce_unsub_at: number | null }>()) ?? (await c.env.DB.prepare("SELECT unsub_at AS announce_unsub_at FROM shop_campaign_contacts WHERE unsub_token=?").bind(t).first<{ announce_unsub_at: number | null }>());
  if (!ct) return c.html(page("Unsubscribe", "<h1>Link not recognised</h1><p>This unsubscribe link is not valid. You can also reply STOP to any text from us.</p>"), 404);
  if (ct.announce_unsub_at) return c.html(page("Unsubscribed", "<h1>You are unsubscribed</h1><p>You will not get any more announcements from this shop. Booking reminders for your appointments are not affected.</p>"));
  return c.html(page("Unsubscribe", `<h1>Stop these messages?</h1><p>Confirm and this shop will not send you any more announcements. Reminders for your own appointments will carry on.</p><form method="post"><button type="submit">Unsubscribe me</button></form>`));
});
marketingPublic.post("/c/:token", async (c) => {
  if (c.req.param("token") !== "preview") {
    await c.env.DB.prepare("UPDATE customers SET announce_unsub_at=COALESCE(announce_unsub_at,?) WHERE unsub_token=?").bind(Date.now(), c.req.param("token")).run();
    await c.env.DB.prepare("UPDATE shop_campaign_contacts SET unsub_at=COALESCE(unsub_at,?) WHERE unsub_token=?").bind(Date.now(), c.req.param("token")).run();
  }
  c.header("Cache-Control", "no-store");
  return c.html(page("Unsubscribed", "<h1>You are unsubscribed</h1><p>You will not get any more announcements from this shop. Reminders for your own appointments are not affected.</p>"));
});
marketingPublic.get("/:token", async (c) => {
  const ct = await c.env.DB.prepare("SELECT unsubscribed_at FROM marketing_contacts WHERE unsub_token=?").bind(c.req.param("token")).first<{ unsubscribed_at: number | null }>();
  c.header("Cache-Control", "no-store");
  if (!ct) return c.html(page("Unsubscribe", "<h1>Link not recognised</h1><p>This unsubscribe link is not valid. If you keep getting messages from us, reply STOP to any text or email us and we will remove you.</p>"), 404);
  if (ct.unsubscribed_at) return c.html(page("Unsubscribed", "<h1>You are unsubscribed</h1><p>We will not send you any more marketing messages.</p>"));
  return c.html(page("Unsubscribe", `<h1>Stop hearing from us?</h1><p>Confirm and we will not send you any more marketing messages.</p><form method="post"><button type="submit">Unsubscribe me</button></form>`));
});
marketingPublic.post("/:token", async (c) => {
  await c.env.DB.prepare("UPDATE marketing_contacts SET unsubscribed_at=COALESCE(unsubscribed_at,?), unsub_reason=CASE WHEN unsubscribed_at IS NULL THEN 'Unsubscribed by link' ELSE unsub_reason END WHERE unsub_token=?").bind(Date.now(), c.req.param("token")).run();
  c.header("Cache-Control", "no-store");
  return c.html(page("Unsubscribed", "<h1>You are unsubscribed</h1><p>We will not send you any more marketing messages. Sorry to have bothered you.</p>"));
});
// One-click unsubscribe for mail clients (RFC 8058) uses the same POST.
