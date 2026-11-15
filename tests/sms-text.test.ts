import { describe, expect, it } from "vitest";
import { fitSms, gsmSafe, previewSms, smsName, smsParts, trimToOnePart } from "../src/server/smsText";
import { copyFor, MESSAGE_TEMPLATES } from "../src/server/messaging";
import { DEFAULT_TEMPLATES, render } from "../src/server/waitlist";

// The longest real values seen on the live shop: a long shop name, a long service, a guest's
// one-time manage link (~100 characters), a long address.
const shop = { name: "The Doghouse Gentlemen's Barbers" };
const guest = `https://thedoghouse.foliyo.co.uk/manage/${"a1b2c3d4-e5f6-4789-abcd-ef0123456789".repeat(2)}`;
const vars = {
  first: "Alexandra", service: "Single Grade & Beard Trim", barber: "Samuel", date: "Wed 30 Sep", time: "17:45", ref: "BRB-0123",
  link: guest, book_link: "https://thedoghouse.foliyo.co.uk/book", address: "105B High Street, Needham Market, IP6 8DQ",
  refund_note: "Your £5.00 deposit has been refunded.", expires: "18:30 today", daypart: "afternoon", code: "482913",
  amount: "£28.00", rating: 5, inviter: "Joshua Perry", role: "Barber", email: "alexandra.long-name@example.co.uk",
  customer: "Alexandra Montgomery", number: "FOL-000123", total: "£49.00", due: "9 Oct", shop: shop.name, ends: "5 Oct",
  readonly_on: "16 Oct", count: 14, first_time: "09:00", online: 9, gaps: 3, was: "Tue 29 Sep at 10:00", deposit: "£5 refunded",
  comment: "Best fade I have had in years, really friendly and on time.", note: "Wants a Saturday slot for two kids.", phone: "07700 900456",
  subject: "New: gift cards are here for every shop", cta_url: "https://foliyo.co.uk/workspace?tab=settings&section=gift-cards",
  sms: "Hi Alexandra, The Doghouse now takes bookings online: https://thedoghouse.foliyo.co.uk/book Opt out: https://thedoghouse.foliyo.co.uk/u/c/0123456789abcdef0123456789abcdef0123",
};
const shorten = async (u: string) => `${new URL(u).origin}/s/Ab12Cd34`;

describe("sms text encoding", () => {
  it("replaces dashes and curly quotes with plain characters", () => {
    expect(gsmSafe("a \u2014 b \u2013 c \u2019 \u201Cq\u201D \u2026")).toBe("a - b - c ' \"q\" ...");
  });
  it("drops emoji, takes accents off and keeps £ and €, so a text never turns unicode", () => {
    expect(gsmSafe("Zoë 👋 café ★5 Łukasz £5 €3")).toBe("Zoe café *5 Lukasz £5 €3") // é is a plain GSM letter; ë is not;
    expect(smsParts(gsmSafe("Thanks 🙏 Zoë")).encoding).toBe("GSM-7");
  });
  it("counts the extended characters double and leaves emoji as unicode", () => {
    expect(smsParts("a{b}").characters).toBe(6);
    expect(smsParts("hi \uD83D\uDE00").encoding).toBe("UNICODE");
  });
});

describe("one part (one charge) per text", () => {
  it("shortens a long shop name to whole words", () => {
    expect(smsName("The Doghouse Gentlemen's Barbers")).toBe("The Doghouse");
    expect(smsName("Northline Barbers")).toBe("Northline Barbers");
  });
  it("every message the app sends fits 160 characters with the longest real values", async () => {
    for (const t of MESSAGE_TEMPLATES) {
      const raw = copyFor(t, vars, shop).sms;
      if (!raw) continue;
      const sent = await fitSms(raw, shorten);
      expect(smsParts(sent), `${t}: ${sent}`).toMatchObject({ encoding: "GSM-7", parts: 1 });
    }
  });
  it("waiting-list and review texts (shop-editable defaults) fit too", async () => {
    for (const [k, tpl] of Object.entries(DEFAULT_TEMPLATES)) {
      const body = render(tpl, { ...Object.fromEntries(Object.entries(vars).map(([a, b]) => [a, String(b)])), shop: smsName(shop.name), manage: guest, link: guest });
      const sent = await fitSms(body, shorten);
      expect(smsParts(sent).parts, `${k}: ${sent}`).toBe(1);
    }
  });
  it("never cuts a link: long links are swapped for a short one, words are trimmed instead", async () => {
    const sent = await fitSms(copyFor("booking_confirmed", vars, shop).sms, shorten);
    expect(sent).toMatch(/https:\/\/thedoghouse\.foliyo\.co\.uk\/s\/Ab12Cd34$/);
    expect(sent.startsWith("The Doghouse: you're booked")).toBe(true);
    const noShortener = await fitSms(copyFor("booking_confirmed", vars, shop).sms);
    expect(noShortener.endsWith(guest)).toBe(true); // full link kept even when it costs a second part
  });
  it("short texts are left exactly as written", async () => {
    const s = "Northline: see you at 10:00 today.";
    expect(await fitSms(s, shorten)).toBe(s);
    expect(trimToOnePart(s)).toBe(s);
  });
  it("a short link is only used when the text would otherwise run over", async () => {
    const s = `Northline: you're booked. ${"https://n.foliyo.co.uk/me?visit=1234567890abcdef"}`;
    expect(await fitSms(s, shorten)).toBe(s);
  });
  it("preview shows the shortened text and its real length", () => {
    const p = previewSms(`${"x".repeat(100)} https://thedoghouse.foliyo.co.uk/u/c/${"0".repeat(36)}`);
    expect(p.text).toContain("/s/xxxxxxxx");
    expect(p.parts).toBe(1);
  });
});
