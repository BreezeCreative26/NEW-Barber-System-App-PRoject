// Every message template renders, in both channels, for a shop-branded sender and (where it
// applies) the foliyo platform sender. Checks the branding rules that matter commercially:
//  - customer / shop-side messages carry the shop's name and never say "foliyo" or "foliyo";
//  - platform messages (billing, lifecycle, welcome) carry the foliyo lockup and company footer;
//  - no unresolved placeholders ("undefined", "null", "{x}") leak into copy;
//  - every CTA points at an https/http link; HTML is escaped; the accent matches shop-theme.css.
// Also writes docs/evidence/emails/<template>.html so each one can be opened and eyeballed.
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { MESSAGE_TEMPLATES, copyFor, emailHtml, EMAIL_ACCENTS, platformSender, PLATFORM_LOGO, type MessageTemplate, type MsgShop } from "../src/server/messaging";
import { brandOf } from "../src/server/domain";

const origin = "https://app.foliyo.test";
const shop = {
  id: "shop_1", name: "Northline Barbers", slug: "northline", address: "12 Market Street, Leeds LS1 6DT", timezone: "Europe/London",
  logo_url: "/media/logo-northline", accent: "clay", theme_json: "{}", phone: "0113 496 0000", email: "hello@northline.example",
} as unknown as MsgShop;
const pb = { company_name: "foliyo", company_address: "foliyo Ltd, 1 Example Way, London EC1A 1AA", company_email: "hello@foliyo.co.uk" };

// Realistic vars per template — the same keys the call sites pass.
const link = `${origin}/manage/tok_abc123`;
const V: Record<MessageTemplate, Record<string, string | number>> = {
  booking_confirmed: { service: "Skin fade", barber: "Marcus", date: "Thu 2 Oct", time: "14:30", ref: "NB-4821", link, address: shop.address, price: "£28", deposit_note: "£5 deposit paid", cancel_hours: 24 },
  booking_moved: { service: "Skin fade", barber: "Marcus", date: "Fri 3 Oct", time: "10:00", ref: "NB-4821", link },
  booking_cancelled: { service: "Skin fade", date: "Thu 2 Oct", time: "14:30", ref: "NB-4821", book_link: `${origin}/book/northline` },
  booking_reminder: { service: "Skin fade", barber: "Marcus", date: "Thu 2 Oct", time: "14:30", ref: "NB-4821", link, address: shop.address },
  booking_reminder_soon: { service: "Skin fade", barber: "Marcus", time: "14:30", address: shop.address, map_link: "https://maps.google.com/?q=LS1+6DT", link },
  signin_code: { code: "482913" },
  staff_invite: { inviter: "Dana Owner", role: "Barber", link: `${origin}/workspace?invite=tok_inv` },
  waitlist_joined: { date: "Sat 4 Oct", daypart: "morning", service: "Beard trim", barber: "any barber" },
  waitlist_offer: { service: "Beard trim", barber: "Ada", date: "Sat 4 Oct", time: "09:15", expires: "18:00 today", link: `${origin}/offer/tok_off` },
  google_review: { rating: 5, service: "Skin fade", barber: "Jay", link: "https://g.page/r/abc/review" },
  waitlist_open: { service: "Beard trim", barber: "Ada", date: "Sat 4 Oct", time: "09:15", link: `${origin}/book/fade-lab?service=s1&staff=st1&date=2026-10-04&start=555&step=2&wl=e1` },
  waitlist_booked: { service: "Beard trim", barber: "Ada", date: "Sat 4 Oct", time: "09:15", ref: "NB-4830", link },
  waitlist_released: { date: "Sat 4 Oct" },
  review_request: { service: "Skin fade", barber: "Marcus", link: `${origin}/manage/tok_abc123#review` },
  test_message: {},
  pay_link: { amount: "£28.00", service: "Skin fade", link: `${origin}/pay/req_1` },
  verify_contact: { code: "551204", kind: "EMAIL" },
  password_reset: { link: `${origin}/reset?token=tok_reset` },
  owner_new_booking: { customer: "Sam Patel", service: "Skin fade", barber: "Marcus", date: "Thu 2 Oct", time: "14:30", ref: "NB-4821", deposit: "£5", link: `${origin}/workspace` },
  owner_cancelled: { customer: "Sam Patel", service: "Skin fade", barber: "Marcus", date: "Thu 2 Oct", time: "14:30", ref: "NB-4821", deposit: "£5 refunded", waitlist: 2, link: `${origin}/workspace` },
  owner_no_show: { customer: "Sam Patel", service: "Skin fade", barber: "Marcus", date: "Thu 2 Oct", time: "14:30", ref: "NB-4821", count: 2 },
  owner_daily_summary: { count: 14, first_time: "09:00", last_time: "17:30", online: 9, walkin: 5, gaps: 3, deposits: "£45", date: "Thu 2 Oct", link: `${origin}/workspace` },
  owner_callback: { customer: "Jo Lee", phone: "07700 900456", note: "Wants a Saturday slot for two kids.", link: `${origin}/workspace` },
  invoice: { number: "FOL-000123", total: "£49.00", due: "9 Oct", status: "OPEN", shop: shop.name, link: `${origin}/workspace?tab=billing`, bank: "" },
  credit_note: { number: "FOL-CN-000004", total: "£12.00", shop: shop.name, link: `${origin}/workspace?tab=billing` },
  owner_signin_link: { link: `${origin}/workspace?link=tok_once`, shop: shop.name },
  trial_ending: { shop: shop.name, days: 3, ends: "5 Oct", link: `${origin}/workspace?tab=billing` },
  trial_ended: { shop: shop.name, ends: "5 Oct", link: `${origin}/workspace?tab=billing` },
  payment_overdue: { number: "FOL-000123", amount: "£49.00", shop: shop.name, readonly_on: "16 Oct", link: `${origin}/workspace?tab=billing` },
  account_readonly: { number: "FOL-000123", amount: "£49.00", shop: shop.name, grace_days: 7, link: `${origin}/workspace?tab=billing` },
  broadcast: { subject: "New: gift cards", heading: "Gift cards are here", body: "Sell them online or in the shop.\n\nRedeem at checkout, split with cash.", cta_label: "Turn on gift cards", cta_url: `${origin}/workspace?tab=settings` },
  admin_alert_digest: { count: 2, items: "‼ Stripe webhook failing for 2 h\n! 3 shops with overdue invoices", link: `${origin}/admin/alerts` },
  owner_welcome: { link: `${origin}/verify?token=tok_verify`, shop: shop.name, trial_days: 14 },
  email_verify: { link: `${origin}/verify?token=tok_verify`, email: "dana@northline.example" },
};
// Which templates go out as the platform (foliyo) rather than the shop.
const PLATFORM = new Set<MessageTemplate>(["invoice", "credit_note", "owner_signin_link", "trial_ending", "trial_ended", "payment_overdue", "account_readonly", "broadcast", "admin_alert_digest", "owner_welcome"]);

const outDir = new URL("../docs/evidence/emails/", import.meta.url);
mkdirSync(outDir, { recursive: true });

describe("message templates", () => {
  it("vars table covers every template", () => {
    for (const t of MESSAGE_TEMPLATES) expect(V[t], t).toBeDefined();
  });
  const index: string[] = [];
  for (const t of MESSAGE_TEMPLATES) {
    it(`${t}: renders both channels, branded correctly, no leaks`, () => {
      const sender = PLATFORM.has(t) ? platformSender(shop, pb) : shop;
      const r = copyFor(t, { first: "Sam Patel", ...V[t] }, sender);
      const html = emailHtml(sender, brandOf(sender), origin, r, { phone: sender.phone, email: sender.email });
      // 1) Nothing unresolved.
      for (const s of [r.sms, r.subject, r.heading, ...r.lines, r.footnote || "", r.cta?.label || "", r.cta?.href || ""]) {
        expect(s, `${t} text`).not.toMatch(/undefined|null|\{[a-z_]+\}|\[object/i);
      }
      expect(html).not.toMatch(/undefined|\[object/);
      // 2) SMS is one message-ish (≤ 320 chars = 2 segments) and starts with the sender's name
      //    so the recipient knows who it's from even with a numeric sender.
      expect(r.sms.length, `${t} sms length`).toBeLessThanOrEqual(320);
      expect(r.sms.startsWith(sender.name) || r.sms.includes(sender.name), `${t} sms names sender`).toBe(true);
      // 3) Subject present; heading present; CTA (if any) is an absolute URL.
      expect(r.subject.trim().length).toBeGreaterThan(3);
      expect(r.heading.trim().length).toBeGreaterThan(1);
      if (r.cta) expect(r.cta.href).toMatch(/^https?:\/\//);
      // 4) Branding.
      if (PLATFORM.has(t)) {
        expect(html, `${t} platform logo`).toContain(PLATFORM_LOGO);
        expect(html, `${t} platform footer`).toContain(pb.company_address);
        expect(html, `${t} platform accent`).toContain(EMAIL_ACCENTS.ollo.bg);
        expect(html, `${t} no shop logo on platform mail`).not.toContain("/media/logo-northline");
      } else {
        expect(html, `${t} shop logo`).toContain(origin + shop.logo_url);
        expect(html, `${t} shop footer`).toContain("Market Street");
        expect(html, `${t} shop accent`).toContain(EMAIL_ACCENTS.clay.bg);
        // Links may live on the platform domain; the *words* the customer reads may not name it.
        const noUrls = (s: string) => s.replace(/https?:\/\/\S+/g, "");
        expect(noUrls(`${r.sms} ${r.subject} ${r.heading} ${r.lines.join(" ")} ${r.footnote || ""} ${r.cta?.label || ""}`), `${t} never names the platform`).not.toMatch(/foliyo|\bOLLO\b/i);
        expect(noUrls(html.replace(/\s(href|src)="[^"]*"/g, "")), `${t} html never names the platform`).not.toMatch(/foliyo|\bOLLO\b/i);
      }
      // 5) Sent-by line always present.
      expect(html).toContain(`Sent by ${sender.name}`);
      writeFileSync(new URL(`${t}.html`, outDir), html);
      index.push(`<li><a href="${t}.html">${t}</a> — <code>${r.subject.replace(/</g, "&lt;")}</code><br><small>SMS: ${r.sms.replace(/</g, "&lt;")}</small></li>`);
    });
  }
  it("writes the preview index", () => {
    writeFileSync(new URL("index.html", outDir), `<!doctype html><meta charset="utf-8"><title>foliyo email templates</title><body style="font:14px system-ui;max-width:900px;margin:32px auto"><h1>${MESSAGE_TEMPLATES.length} message templates</h1><ul>${index.join("")}</ul>`);
    expect(index.length).toBe(MESSAGE_TEMPLATES.length);
  });
  it("HTML-escapes hostile input in every slot", () => {
    const evil = `<img src=x onerror=alert(1)>"&`;
    const r = copyFor("booking_confirmed", { first: evil, service: evil, barber: evil, date: evil, time: evil, ref: evil, link: `${origin}/manage/x?q=${encodeURIComponent(evil)}`, address: evil }, { ...shop, name: evil } as MsgShop);
    const html = emailHtml({ ...shop, name: evil }, brandOf(shop), origin, r, { phone: evil, email: evil });
    expect(html).not.toContain("<img src=x");
    // Every occurrence of the payload is entity-escaped.
    expect(html.match(/<img src=x/g)).toBeNull();
    expect((html.match(/&lt;img src=x onerror=alert\(1\)&gt;&quot;&amp;/g) || []).length).toBeGreaterThan(5);
  });
  it("email accents match the shop-theme stylesheet (light mode)", () => {
    const css = readFileSync(new URL("../public/static/shop-theme.css", import.meta.url), "utf8");
    for (const [k, v] of Object.entries(EMAIL_ACCENTS)) {
      const m = css.match(new RegExp(`\\.shop-page\\.accent-${k}\\s*\\{[^}]*--sp-accent:\\s*(#[0-9a-f]{3,6})`, "i"));
      expect(m, `accent-${k} in shop-theme.css`).toBeTruthy();
      expect(v.bg.toLowerCase()).toBe(m![1].toLowerCase());
    }
  });
  it("logo falls back to an initials tile in the accent colour", () => {
    const r = copyFor("booking_confirmed", V.booking_confirmed, { name: "Fade Society" });
    const html = emailHtml({ name: "Fade Society" }, brandOf({ accent: "plum" }), origin, r, {});
    expect(html).toContain(">FS<");
    expect(html).toContain(EMAIL_ACCENTS.plum.bg);
  });
});
