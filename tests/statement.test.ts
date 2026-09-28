import { describe, expect, it } from "vitest";
import { maskRecipient, usageLabel } from "../src/server/statement";
import { suggestSenders, checkSender } from "../src/client/smsSenderRules";

describe("statement helpers", () => {
  it("masks recipients but keeps them recognisable", () => {
    expect(maskRecipient("07405 427407")).toBe("07405 •••407");
    expect(maskRecipient("+447405427407")).toBe("+4474 •••407");
    expect(maskRecipient("sam@northline.co.uk")).toBe("sa•••@northline.co.uk");
  });
  it("labels templates in plain English", () => {
    expect(usageLabel("booking_confirmed")).toBe("Booking confirmation");
    expect(usageLabel("something_new")).toBe("Something new");
  });
});

describe("alpha tag suggestions", () => {
  it("offers whole-word names, drops filler and code-like tokens", () => {
    expect(suggestSenders("Northline Barbers 459c4a09")[0]).toBe("Northline");
    expect(suggestSenders("The Gentlemen's Quarter")[0]).toBe("Gentlemens");
    expect(suggestSenders("Fade Lab")).toContain("Fade Lab");
    expect(suggestSenders("Fade Lab")).toContain("FadeLab");
    for (const s of suggestSenders("Jay and Kay Cuts Manchester")) expect(s.length).toBeLessThanOrEqual(11);
  });
  it("checks carrier rules and readability", () => {
    expect(checkSender("Northline").level).toBe("good");
    expect(checkSender("J&K").ok).toBe(false);
    expect(checkSender("07405427407").ok).toBe(false);
    expect(checkSender("NORTHLINE").level).toBe("warn");
    expect(checkSender("northline").level).toBe("warn");
    expect(checkSender("TooLongAName123").ok).toBe(false);
  });
});
