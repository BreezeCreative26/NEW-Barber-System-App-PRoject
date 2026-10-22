// Shops telling their own customers about their new online booking page (moving from another
// system to foliyo). Everything here is the shop's: the shop's name, logo and colours, the shop's
// reply-to address, no foliyo mark. Texts are billed to the shop at the normal per-text rate and
// emails are free. Every message carries a way out (STOP on texts, an unsubscribe link on emails),
// and texts only go out 09:00 to 20:00 UK time, Monday to Saturday.
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Database as DB } from "../db/client";
import { enqueue, msgShop, drain, type MsgShop } from "./messaging";
import { shopUrl } from "./hosts";
import { normaliseUk, smsWindowOpen } from "./marketing";

type Ctx = Context<any>;
type Helpers = { input: <T>(c: Ctx, s: z.ZodType<T>) => Promise<T>; requireRole: (c: Ctx, roles: string[]) => void; fail: (status: 400 | 403 | 404 | 409, message: string) => never };

export type Kind = "launch" | "offer" | "quiet" | "winback" | "hours" | "service" | "custom";
type Copy = { subject: string; heading: string; body: string; cta_label: string; sms_body: string };
// Starting points. Anything in [square brackets] must be replaced before it can be sent.
export const PRESETS: { kind: Kind; title: string; blurb: string; audience: "ALL" | "OPTED_IN" | "RECENT" | "LAPSED"; channel: "SMS" | "EMAIL" | "BOTH"; copy: Copy }[] = [
  { kind: "launch", title: "We take bookings online", blurb: "Tell customers about your new booking page.", audience: "ALL", channel: "EMAIL",
    copy: { subject: "Book online with {shop}", heading: "Book your next visit online", cta_label: "Book online",
      body: "{shop} now has online booking. You can book, change or cancel an appointment any time, and we will remind you before each visit.\n\nMake your free account in under a minute and your details will be ready for next time.",
      sms_body: "Hi {first}, {shop} now takes bookings online. Book and manage your appointments any time: {link}" } },
  { kind: "offer", title: "Special offer", blurb: "A deal or discount for your customers.", audience: "OPTED_IN", channel: "BOTH",
    copy: { subject: "An offer from {shop}", heading: "A little something from us", cta_label: "Book now",
      body: "We have an offer for our customers: [describe your offer].\n\nIt runs until [end date]. Book online and mention it when you arrive.",
      sms_body: "Hi {first}, {shop} has an offer: [describe your offer], until [end date]. Book here: {link}" } },
  { kind: "quiet", title: "Fill quiet days", blurb: "Free slots this week? Let people know.", audience: "RECENT", channel: "BOTH",
    copy: { subject: "A few free slots at {shop}", heading: "We have space this week", cta_label: "See free times",
      body: "We have a few free appointments coming up and would love to see you.\n\nPick a time that suits you and book in under a minute.",
      sms_body: "Hi {first}, {shop} has a few free slots this week. Grab one here: {link}" } },
  { kind: "winback", title: "We miss you", blurb: "Bring back people who have not visited in a while.", audience: "LAPSED", channel: "BOTH",
    copy: { subject: "We miss you at {shop}", heading: "It has been a while", cta_label: "Book your next visit",
      body: "It has been a couple of months since your last visit to {shop}, and we would love to see you again.\n\nBook your next appointment online in under a minute.",
      sms_body: "Hi {first}, it has been a while since your last visit to {shop}. Book your next one here: {link}" } },
  { kind: "hours", title: "Opening hours change", blurb: "Holidays, new hours or a temporary closure.", audience: "RECENT", channel: "EMAIL",
    copy: { subject: "Opening hours at {shop}", heading: "A change to our opening hours", cta_label: "Book online",
      body: "We are changing our opening hours: [describe the change and dates].\n\nYou can see free times and book online any time.",
      sms_body: "Hi {first}, a change at {shop}: [describe the change and dates]. Book online: {link}" } },
  { kind: "service", title: "New service", blurb: "Introduce something new on your menu.", audience: "ALL", channel: "EMAIL",
    copy: { subject: "New at {shop}: [service name]", heading: "Something new at {shop}", cta_label: "Book it now",
      body: "We now offer [service name] for [price]. [One line about what it is and who it is for.]\n\nBook it online at a time that suits you.",
      sms_body: "Hi {first}, new at {shop}: [service name] for [price]. Book here: {link}" } },
  { kind: "custom", title: "Write your own", blurb: "Start from a blank page.", audience: "ALL", channel: "EMAIL",
    copy: { subject: "", heading: "", body: "", cta_label: "Book online", sms_body: "" } },
];
export const SHOP_DEFAULTS = PRESETS[0].copy;
const PLACEHOLDER = /\[[^\]\n]{2,60}\]/;

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 24);
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(18))).map((b) => b.toString(16).padStart(2, "0")).join("");
const first = (name: string) => (name || "").trim().split(/\s+/)[0] || "";
const merge = (t: string, v: { first: string; shop: string; link: string }) =>
  t.replace(/\{first\}/g, v.first || "there").replace(/\{shop\}/g, v.shop).replace(/\{link\}/g, v.link).replace(/Hi there,?/g, "Hi,");

// Next moment texts are allowed (now if the window is open). Steps in 30 minute jumps, at most 8 days.
export function nextSmsWindow(now: number) {
  let t = now;
  for (let i = 0; i < 8 * 48 && !smsWindowOpen(t); i++) t += 30 * 60000;
  return t;
}

type Cust = { id: string; name: string; phone: string; email: string; contact_pref: string; unsub_token: string | null };
const fields = z.object({
  channel: z.enum(["SMS", "EMAIL", "BOTH"]),
  kind: z.enum(["launch", "offer", "quiet", "winback", "hours", "service", "custom"]).default("launch"),
  audience: z.enum(["ALL", "OPTED_IN", "RECENT", "LAPSED"]).default("ALL"),
  send_at: z.number().int().optional(),
  subject: z.string().trim().max(150).default(""),
  heading: z.string().trim().max(150).default(""),
  body: z.string().trim().max(3000).default(""),
  sms_body: z.string().trim().max(480).default(""),
  cta_label: z.string().trim().max(40).default(""),
}).strict();
type Fields = z.infer<typeof fields>;
const withDefaults = (f: Fields): Fields => {
  const d = (PRESETS.find((p) => p.kind === f.kind) ?? PRESETS[0]).copy;
  return { ...f, subject: f.subject || d.subject, heading: f.heading || d.heading, body: f.body || d.body, sms_body: f.sms_body || d.sms_body, cta_label: f.cta_label || d.cta_label || "Book online" };
};
// What is missing or unfinished for the channels chosen; empty means it can go.
function problems(f: Fields) {
  const out: string[] = [];
  if (f.channel !== "SMS" && (!f.subject.trim() || !f.body.trim())) out.push("Add a subject and a message for the email.");
  if (f.channel !== "EMAIL" && !f.sms_body.trim()) out.push("Add a message for the text.");
  const text = [f.channel !== "SMS" ? f.subject + f.heading + f.body : "", f.channel !== "EMAIL" ? f.sms_body : ""].join(" ");
  if (PLACEHOLDER.test(text)) out.push("Replace the [bracketed] parts with your own words first.");
  return out;
}

async function audience(db: DB, shopId: string, f: Fields, shop: MsgShop) {
  const DAY = 86400000, now = Date.now();
  const visit = "SELECT 1 FROM bookings b WHERE b.shop_id=c.shop_id AND b.customer_id=c.id AND b.status IN ('COMPLETED','CHECKED_IN')";
  const rows = (await db.prepare(`SELECT c.id,c.name,c.phone,c.email,c.contact_pref,c.unsub_token FROM customers c WHERE c.shop_id=? AND c.merged_into IS NULL AND c.announce_unsub_at IS NULL AND c.contact_pref<>'NONE'
      AND (?='ALL' OR (?='OPTED_IN' AND c.marketing_opt_in=1)
        OR (?='RECENT' AND EXISTS (${visit} AND b.start_at>?))
        OR (?='LAPSED' AND EXISTS (${visit}) AND NOT EXISTS (${visit} AND b.start_at>?)))
      ORDER BY c.created_at`).bind(shopId, f.audience, f.audience, f.audience, now - 90 * DAY, f.audience, now - 60 * DAY).all<Cust>()).results;
  const optedOut = new Set((await db.prepare("SELECT phone FROM wa_optouts").all<{ phone: string }>()).results.map((r) => r.phone));
  const wantSms = f.channel !== "EMAIL" && (shop.msg_sms ?? 1) === 1;
  const wantEmail = f.channel !== "SMS" && (shop.msg_email ?? 1) === 1;
  const sms: (Cust & { e164: string })[] = [], email: Cust[] = [];
  let landline = 0, noContact = 0;
  for (const r of rows) {
    const n = r.phone ? normaliseUk(r.phone) : null;
    let any = false;
    if (wantSms && n?.kind === "mobile" && !optedOut.has(n.e164.replace(/\D/g, ""))) { sms.push({ ...r, e164: n.e164 }); any = true; }
    else if (wantSms && n?.kind === "landline") landline++;
    if (wantEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email || "")) { email.push(r); any = true; }
    if (!any) noContact++;
  }
  return { total: rows.length, sms, email, landline, noContact };
}

export async function sendAnnouncement(db: DB, shop: MsgShop, f: Fields, origin: string, by: string, now = Date.now()) {
  const a = await audience(db, shop.id, f, shop);
  const id = uid();
  const link = shopUrl(shop.slug!, "/book", origin);
  const startAt = Math.max(now, f.send_at ?? 0);
  const sendAt = nextSmsWindow(startAt);
  await db.prepare("INSERT INTO shop_campaigns(id,shop_id,name,channel,audience,subject,heading,body,sms_body,cta_label,sms_count,email_count,sent_by,created_at,send_after,kind,scheduled_for) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, shop.id, f.subject.slice(0, 80), f.channel, f.audience, f.subject, f.heading, f.body, f.sms_body, f.cta_label, a.sms.length, a.email.length, by, now, sendAt, f.kind, startAt > now + 60000 ? startAt : 0).run();
  const tokenOf = async (c: Cust) => {
    if (c.unsub_token) return c.unsub_token;
    const t = token();
    await db.prepare("UPDATE customers SET unsub_token=? WHERE id=? AND unsub_token IS NULL").bind(t, c.id).run();
    return (await db.prepare("SELECT unsub_token FROM customers WHERE id=?").bind(c.id).first<{ unsub_token: string }>())!.unsub_token;
  };
  const stmts: ReturnType<typeof enqueue> = [];
  const flush = async () => { if (stmts.length) { await db.batch(stmts.splice(0)); } };
  for (const c of a.sms) {
    const v = { first: first(c.name), shop: shop.name, link };
    let text = merge(f.sms_body, v).trim();
    if (!/\bSTOP\b/i.test(text)) text += " Reply STOP to opt out.";
    stmts.push(...enqueue(db, shop, { name: first(c.name), phone: c.e164 }, "shop_announcement", { sms: text, subject: "", heading: "", body: "" }, { related: { type: "announce", id: `${id}:${c.id}` }, origin, channel: "SMS", now, sendAt, force: false, note: startAt > now + 60000 ? "Scheduled" : sendAt > now ? "Held until texts can go out (09:00 to 20:00, Monday to Saturday)" : "" }));
    if (stmts.length >= 200) await flush();
  }
  for (const c of a.email) {
    const v = { first: first(c.name), shop: shop.name, link };
    const unsub = shopUrl(shop.slug!, `/u/c/${await tokenOf(c)}`, origin);
    stmts.push(...enqueue(db, shop, { name: first(c.name), email: c.email }, "shop_announcement", { sms: merge(f.sms_body, v), subject: merge(f.subject, v), heading: merge(f.heading, v), body: merge(f.body, v), cta_label: f.cta_label, cta_url: link }, { related: { type: "announce", id: `${id}:${c.id}` }, origin, channel: "EMAIL", now, sendAt: startAt > now ? startAt : undefined, force: false, shopOnly: true, unsubscribe: unsub }));
    if (stmts.length >= 200) await flush();
  }
  await flush();
  // Emails start at once; the usual sweep carries on with the rest.
  if (startAt <= now + 60000) await drain(db, 40, now).catch(() => {});
  return { id, sms: a.sms.length, email: a.email.length };
}

export function mountShopCampaigns(app: Hono<any>, h: Helpers) {
  const gate = (c: Ctx) => h.requireRole(c, ["OWNER", "MANAGER"]);
  const origin = (c: Ctx) => new URL(c.req.url).origin;

  const shopInfo = async (c: Ctx) => {
    const shop = await msgShop(c, c.get("shopId"));
    const ack = await c.env.DB.prepare("SELECT msg_sms_billing_ack_at AS a FROM shops WHERE id=?").bind(shop.id).first() as { a: number | null } | null;
    return { shop, acked: !!ack?.a };
  };
  const draft = async (c: Ctx) => withDefaults(await h.input(c, fields));

  app.get("/announcements", async (c) => {
    gate(c);
    const { shop, acked } = await shopInfo(c);
    const rows = (await c.env.DB.prepare(
      `SELECT k.*, (SELECT COUNT(*)::int FROM notifications n WHERE n.shop_id=k.shop_id AND n.related_type='announce' AND n.related_id LIKE k.id||':%' AND n.status='SENT') AS sent,
              (SELECT COUNT(*)::int FROM notifications n WHERE n.shop_id=k.shop_id AND n.related_type='announce' AND n.related_id LIKE k.id||':%' AND n.status='FAILED') AS failed,
              (SELECT COUNT(*)::int FROM notifications n WHERE n.shop_id=k.shop_id AND n.related_type='announce' AND n.related_id LIKE k.id||':%' AND n.status IN ('QUEUED','SENDING')) AS waiting
         FROM shop_campaigns k WHERE k.shop_id=? ORDER BY k.created_at DESC LIMIT 30`).bind(shop.id).all()).results;
    return c.json({
      campaigns: rows, defaults: SHOP_DEFAULTS, presets: PRESETS, link: shop.slug ? shopUrl(shop.slug, "/book", origin(c)) : "",
      sms_on: (shop.msg_sms ?? 1) === 1, email_on: (shop.msg_email ?? 1) === 1, sms_acked: acked, sms_pence: 8, sms_window_open: smsWindowOpen(), has_page: !!shop.slug,
    });
  });

  app.post("/announcements/preview", async (c) => {
    gate(c);
    const f = await draft(c);
    const { shop } = await shopInfo(c);
    if (!shop.slug) h.fail(409, "Set your shop address first so customers have a page to book on.");
    const a = await audience(c.env.DB, shop.id, f, shop);
    const link = shopUrl(shop.slug, "/book", origin(c));
    const sample = a.sms[0] ?? a.email[0] ?? { name: "Alex Morgan" };
    const v = { first: first(sample.name) || "Alex", shop: shop.name, link };
    let smsText = merge(f.sms_body, v).trim(); if (!/\bSTOP\b/i.test(smsText)) smsText += " Reply STOP to opt out.";
    const { copyFor, emailHtml } = await import("./messaging");
    const { brandOf } = await import("./domain");
    const r = copyFor("shop_announcement", { sms: smsText, subject: merge(f.subject, v), heading: merge(f.heading, v), body: merge(f.body, v), cta_label: f.cta_label, cta_url: link }, shop);
    const html = emailHtml(shop, brandOf(shop), origin(c), r, { phone: shop.phone, email: shop.email, unsubscribe: shopUrl(shop.slug, "/u/c/preview", origin(c)) }, true);
    return c.json({
      problems: problems(f),
      customers: a.total, sms: a.sms.length, email: a.email.length, landline: a.landline, no_contact: a.noContact,
      sms_text: smsText, sms_length: smsText.length, email_subject: r.subject, email_html: f.channel === "SMS" ? null : html,
      cost_pence: a.sms.length * 8, sms_window_open: smsWindowOpen(),
    });
  });

  app.post("/announcements/test", async (c) => {
    gate(c);
    const f = await draft(c);
    const { shop } = await shopInfo(c);
    if (!shop.slug) h.fail(409, "Set your shop address first.");
    const to = c.get("account")?.email as string | undefined;
    if (!to) h.fail(400, "Your account has no email address.");
    const link = shopUrl(shop.slug, "/book", origin(c));
    const v = { first: "there", shop: shop.name, link };
    const rel = { type: "announce_test", id: `${shop.id}:${Date.now()}` };
    const stmts = enqueue(c.env.DB, shop, { email: to, name: "there" }, "shop_announcement", { sms: "", subject: `[Test] ${merge(f.subject, v)}`, heading: merge(f.heading, v), body: merge(f.body, v), cta_label: f.cta_label, cta_url: link }, { related: rel, origin: origin(c), channel: "EMAIL", force: true, shopOnly: true, unsubscribe: shopUrl(shop.slug, "/u/c/preview", origin(c)) });
    if (stmts.length) { await c.env.DB.batch(stmts); await drain(c.env.DB, 5, Date.now(), rel).catch(() => {}); }
    return c.json({ ok: true, sent_to: to });
  });

  app.post("/announcements/:id/cancel", async (c) => {
    gate(c);
    const sid = c.get("shopId") as string, id = c.req.param("id");
    const own = await c.env.DB.prepare("SELECT id FROM shop_campaigns WHERE id=? AND shop_id=?").bind(id, sid).first();
    if (!own) h.fail(404, "Campaign not found.");
    const r = await c.env.DB.prepare("UPDATE notifications SET status='SKIPPED', status_note='Campaign cancelled' WHERE shop_id=? AND related_type='announce' AND related_id LIKE ? AND status='QUEUED'").bind(sid, id + ":%").run();
    return c.json({ ok: true, stopped: r.meta.changes });
  });

  app.post("/announcements/send", async (c) => {
    gate(c);
    const b = await h.input(c, fields.extend({ confirm: z.boolean(), sms_ack: z.boolean().optional() }).strict());
    const { confirm: _c, sms_ack: _a, ...rest } = b;
    const f = withDefaults(rest as Fields);
    if (!b.confirm) h.fail(400, "Please confirm these are your own customers.");
    const pr = problems(f); if (pr.length) h.fail(400, pr[0]);
    if (f.send_at && (f.send_at < Date.now() - 60000 || f.send_at > Date.now() + 60 * 86400000)) h.fail(400, "Pick a time within the next 60 days.");
    const { shop, acked } = await shopInfo(c);
    if (!shop.slug) h.fail(409, "Set your shop address first so customers have a page to book on.");
    if (f.channel !== "EMAIL" && (shop.msg_sms ?? 1) !== 1) h.fail(409, "Texts are switched off for your shop (Settings, Messages).");
    const a = await audience(c.env.DB, shop.id, f, shop);
    if (!a.sms.length && !a.email.length) h.fail(409, "There is nobody to send to. Import your customers first.");
    if (a.sms.length && !acked) {
      if (!b.sms_ack) h.fail(409, "Please confirm you understand texts are billed at 8p each.");
      await c.env.DB.prepare("UPDATE shops SET msg_sms_billing_ack_at=? WHERE id=? AND msg_sms_billing_ack_at IS NULL").bind(Date.now(), shop.id).run();
    }
    const r = await sendAnnouncement(c.env.DB, shop, f, origin(c), String(c.get("actor") || ""));
    return c.json({ ok: true, ...r });
  });
}
