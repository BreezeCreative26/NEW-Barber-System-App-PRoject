import { describe, expect, it } from "vitest";
import { extractContacts, normaliseUk, smsWindowOpen } from "../src/server/marketing";

describe("normaliseUk", () => {
  it("reads every common way of writing a UK mobile", () => {
    for (const raw of ["07700 900123", "07700900123", "+44 7700 900123", "0044 7700 900123", "447700900123", "(0)7700-900-123", "7700 900123", "07700.900.123"]) {
      expect(normaliseUk(raw), raw).toEqual({ kind: "mobile", e164: "+447700900123" });
    }
  });
  it("tells landlines and untextable numbers apart", () => {
    expect(normaliseUk("01622 123456")?.kind).toBe("landline");
    expect(normaliseUk("020 7946 0958")?.kind).toBe("landline");
    expect(normaliseUk("07012 345678")).toBeNull(); // personal number
    expect(normaliseUk("0800 123 4567")).toBeNull(); // freephone
    expect(normaliseUk("12345")).toBeNull();
  });
});

describe("extractContacts", () => {
  it("finds names, businesses, numbers and emails with headers", () => {
    const r = extractContacts("Business,Owner,Mobile,Email\nSharp Cuts,Dan Smith,07700 900123,dan@sharpcuts.co.uk\n");
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0]).toMatchObject({ business: "Sharp Cuts", name: "Dan Smith", first_name: "Dan", phone: "+447700900123", email: "dan@sharpcuts.co.uk" });
  });
  it("works with no headers, messy cells and several numbers in one cell", () => {
    const r = extractContacts('"The Barber Shop, Kings Hill",mike jones,"01622 123456 / 07700 900456",MIKE@EXAMPLE.COM\n');
    const c = r.contacts[0];
    expect(c.phone).toBe("+447700900456");
    expect(c.landline).toBe("+441622123456");
    expect(c.email).toBe("mike@example.com");
    expect(c.first_name).toBe("Mike");
  });
  it("merges duplicates by mobile or email and counts problems", () => {
    const r = extractContacts("name,phone,email\nAl,07700900111,\nAl B,+447700900111,al@x.com\nNoone,,\nBad,07700 90,bad@\nLand,01622 000000,\n");
    expect(r.stats.contacts).toBe(2);
    expect(r.stats.duplicates_merged).toBe(1);
    expect(r.stats.landline_only).toBe(1);
    expect(r.stats.no_contact_details).toBe(2); // "Noone" and "Bad"
    expect(r.contacts[0]).toMatchObject({ phone: "+447700900111", email: "al@x.com" });
  });
  it("handles semicolons, tabs, BOM and Windows line endings", () => {
    const r = extractContacts("\uFEFFname;mobile\r\nJo;07700900222\r\n");
    expect(r.contacts[0].phone).toBe("+447700900222");
  });
});

describe("smsWindowOpen", () => {
  it("allows texts 09:00 to 20:00 UK time, Monday to Saturday only", () => {
    expect(smsWindowOpen(Date.parse("2026-10-21T11:00:00Z"))).toBe(true); // Wednesday
    expect(smsWindowOpen(Date.parse("2026-10-21T21:30:00Z"))).toBe(false); // evening
    expect(smsWindowOpen(Date.parse("2026-10-21T07:00:00Z"))).toBe(false); // 08:00 BST
    expect(smsWindowOpen(Date.parse("2026-10-25T12:00:00Z"))).toBe(false); // Sunday
  });
});
