import { describe, expect, it } from "vitest";
import { gsmSafe, smsParts } from "../src/server/smsText";
import { copyFor } from "../src/server/messaging";

const shop = { name: "The Doghouse Gentlemen's Barbers" };
const vars = { first: "Leon", service: "Skin Fade", barber: "Joshua", date: "Thu 12 Nov", time: "17:00", ref: "BRB-0001", link: "https://thedoghouse.foliyo.co.uk/me?visit=3635d5ed-1c95-4a37-892f-8b96631c01a0", book_link: "https://thedoghouse.foliyo.co.uk/book" };

describe("sms text encoding", () => {
  it("replaces dashes and curly quotes with plain characters", () => {
    expect(gsmSafe("a \u2014 b \u2013 c \u2019 \u201Cq\u201D \u2026")).toBe("a - b - c ' \"q\" ...");
  });
  it("the booking confirmation was 4 unicode parts; now it is 2 plain parts", () => {
    const raw = copyFor("booking_confirmed", vars, shop).sms;
    expect(raw).toContain("\u2014");
    expect(smsParts(raw)).toMatchObject({ encoding: "UNICODE", parts: 4 });
    const fixed = gsmSafe(raw);
    expect(smsParts(fixed)).toMatchObject({ encoding: "GSM-7", parts: 2 });
  });
  it("every customer text template is GSM-7 after cleaning", () => {
    for (const t of ["booking_confirmed", "booking_moved", "booking_cancelled", "booking_reminder", "booking_reminder_soon"] as const) {
      expect(smsParts(gsmSafe(copyFor(t, vars, shop).sms)).encoding).toBe("GSM-7");
    }
  });
  it("counts the extended characters double and leaves emoji as unicode", () => {
    expect(smsParts("a{b}").characters).toBe(6);
    expect(smsParts("hi \uD83D\uDE00").encoding).toBe("UNICODE");
  });
});
