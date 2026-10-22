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

export const SHOP_DEFAULTS = {
  subject: "Book online with {shop}",
  heading: "Book your next visit online",
  body: "{shop} now has online booking. You can book, change or cancel an appointment any time, and we will remind you before each visit.\n\nMake your free account in under a minute and your details will be ready for next time.",
  cta_label: "Book online",
  sms_body: "Hi {first}, {shop} now takes bookings online. Book and manage your appointments any time: {link}",
};

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
  audience: z.enum(["ALL", "OPTED_IN"]).default("ALL"),
  subject: z.string().trim().max(150).default(""),
  heading: z.string().trim().max(150).default(""),
  body: z.string().trim().max(3000).default(""),
  sms_body: z.string().trim().max(480).default(""),
  cta_label: z.string().trim().max(40).default(""),
}).strict();
type Fields = z.infer<typeof fields>;
const withDefaults = (f: Fields): Fields => ({ ...f, subject: f.subject || SHOP_DEFAULTS.subject, heading: f.heading || SHOP_DEFAULTS.heading, body: f.body || SHOP_DEFAULTS.body, sms_body: f.sms_body || SHOP_DEFAULTS.sms_body, cta_label: f.cta_label || SHOP_DEFAULTS.cta_label });

async function audience(db: DB, shopId: string, f: Fields, shop: MsgShop) {
  const rows = (await db.prepare("SELECT id,name,phone,email,contact_pref,unsub_token FROM customers WHERE shop_id=? AND merged_into IS NULL AND announce_unsub_at IS NULL AND contact_pref<>'NONE' AND (?='ALL' OR marketing_opt_in=1) ORDER BY created_at").bind(shopId, f.audience).all<Cust>()).results;
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
  const sendAt = nextSmsWindow(now);
  await db.prepare("INSERT INTO shop_campaigns(id,shop_id,name,channel,audience,subject,heading,body,sms_body,cta_label,sms_count,email_count,sent_by,created_at,send_after) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, shop.id, f.subject.slice(0, 80), f.channel, f.audience, f.subject, f.heading, f.body, f.sms_body, f.cta_label, a.sms.length, a.email.length, by, now, sendAt).run();
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
    stmts.push(...enqueue(db, shop, { name: first(c.name), phone: c.e164 }, "shop_announcement", { sms: text, subject: "", heading: "", body: "" }, { related: { type: "announce", id: `${id}:${c.id}` }, origin, channel: "SMS", now, sendAt, force: false, note: sendAt > now ? "Held until texts can go out (09:00 to 20:00, Monday to Saturday)" : "" }));
    if (stmts.length >= 200) await flush();
  }
  for (const c of a.email) {
    const v = { first: first(c.name), shop: shop.name, link };
    const unsub = shopUrl(shop.slug!, `/u/c/${await tokenOf(c)}`, origin);
    stmts.push(...enqueue(db, shop, { name: first(c.name), email: c.email }, "shop_announcement", { sms: merge(f.sms_body, v), subject: merge(f.subject, v), heading: merge(f.heading, v), body: merge(f.body, v), cta_label: f.cta_label, cta_url: link }, { related: { type: "announce", id: `${id}:${c.id}` }, origin, channel: "EMAIL", now, force: false, shopOnly: true, unsubscribe: unsub }));
    if (stmts.length >= 200) await flush();
  }
  await flush();
  // Emails start at once; the usual sweep carries on with the rest.
  await drain(db, 40, now).catch(() => {});
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
      campaigns: rows, defaults: SHOP_DEFAULTS, link: shop.slug ? shopUrl(shop.slug, "/book", origin(c)) : "",
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

  app.post("/announcements/send", async (c) => {
    gate(c);
    const b = await h.input(c, fields.extend({ confirm: z.boolean(), sms_ack: z.boolean().optional() }).strict());
    const { confirm: _c, sms_ack: _a, ...rest } = b;
    const f = withDefaults(rest as Fields);
    if (!b.confirm) h.fail(400, "Please confirm these are your own customers.");
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
