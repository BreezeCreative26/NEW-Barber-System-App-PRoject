import { describe, expect, it } from "vitest";
import { SMS_KINDS, SMS_KIND_GROUPS, normaliseSmsKinds } from "../src/server/smsKinds";
import { smsKindAllowed } from "../src/server/messaging";

describe("per-text SMS switches", () => {
  it("old group saves switch on every text they covered", () => {
    expect(normaliseSmsKinds("confirm,reminder,change,waitlist,review")).toEqual([...SMS_KINDS]);
    expect(normaliseSmsKinds("confirm,reminder,change")).toEqual(["confirm", "reminder_day", "reminder_soon", "moved", "cancelled"]);
    expect(normaliseSmsKinds(null)).toEqual([...SMS_KINDS]);
    expect(normaliseSmsKinds("")).toEqual([]);
  });
  it("each text is controlled on its own", () => {
    const shop = { msg_sms_kinds: "confirm,reminder_day,cancelled" };
    expect(smsKindAllowed(shop, "booking_reminder")).toBe(true);
    expect(smsKindAllowed(shop, "booking_reminder_soon")).toBe(false);
    expect(smsKindAllowed(shop, "booking_cancelled")).toBe(true);
    expect(smsKindAllowed(shop, "booking_moved")).toBe(false);
    expect(smsKindAllowed(shop, "review_request")).toBe(false);
    expect(smsKindAllowed(shop, "signin_code")).toBe(true); // always sends
  });
  it("the picker shows every switch exactly once", () => {
    expect(SMS_KIND_GROUPS.flatMap((g) => g.kinds.map((k) => k.id)).sort()).toEqual([...SMS_KINDS].sort());
  });
});
