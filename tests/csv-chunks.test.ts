import { describe, expect, it } from "vitest";
import { planParts, sendParts } from "../src/client/csvChunks";
import { extractContacts } from "../src/server/marketing";
import { parseCsv } from "../src/server/csvParse";

const people = (n: number) => Array.from({ length: n }, (_, i) => `Shop ${i} Barbers,Owner ${i},07700 9${String(i).padStart(5, "0")},o${i}@shop${i}.test`);

describe("csv parts", () => {
  it("repeats the heading on every part and loses no rows", () => {
    const text = ["Business,Owner,Mobile,Email", ...people(1000)].join("\n");
    const plan = planParts(text, 250);
    expect(plan.hasHeader).toBe(true);
    expect(plan.parts).toHaveLength(4);
    for (const p of plan.parts) expect(p.text.startsWith("Business,Owner,Mobile,Email\n")).toBe(true);
    expect(plan.parts.flatMap((p) => parseCsv(p.text).slice(1))).toHaveLength(1000);
    expect(plan.parts.map((p) => p.rowsBefore)).toEqual([0, 250, 500, 750]);
  });

  it("the server finds the same people in the parts as in the whole file", () => {
    const text = ["Business,Owner,Mobile,Email", ...people(1200)].join("\r\n") + "\r\n";
    const whole = extractContacts(text);
    const parts = planParts(text, 250).parts.map((p) => extractContacts(p.text));
    expect(parts.reduce((n, r) => n + r.contacts.length, 0)).toBe(whole.contacts.length);
    expect(parts.reduce((n, r) => n + r.stats.with_mobile, 0)).toBe(whole.stats.with_mobile);
    expect(parts.reduce((n, r) => n + r.stats.with_email, 0)).toBe(whole.stats.with_email);
    const emails = new Set(parts.flatMap((r) => r.contacts.map((c) => c.email)));
    expect(emails.size).toBe(1200);
  });

  it("keeps quotes, commas and line breaks inside a cell intact", () => {
    const text = 'Business,Owner,Mobile,Email\n"Cuts, Kent ""Ltd""","Dan\nSmith",07700 900123,dan@cuts.test\n';
    const plan = planParts(text, 1);
    expect(parseCsv(plan.parts[0].text)[1]).toEqual(['Cuts, Kent "Ltd"', "Dan\nSmith", "07700 900123", "dan@cuts.test"]);
  });

  it("reads semicolon and tab files the way the server would", () => {
    const semi = "Business;Owner;Mobile;Email\nA Cuts;Al;07700 900111;a@a.test\nB Cuts;Bo;07700 900222;b@b.test\n";
    const plan = planParts(semi, 1);
    expect(plan.parts).toHaveLength(2);
    expect(plan.parts.flatMap((p) => extractContacts(p.text).contacts).map((c) => c.email)).toEqual(["a@a.test", "b@b.test"]);
  });

  it("splits by size as well as row count and never cuts a row", () => {
    const text = Array.from({ length: 10 }, (_, i) => `${"x".repeat(400)}${i},a${i}@b.test`).join("\n");
    const plan = planParts(text, 1000, 1000);
    expect(plan.hasHeader).toBe(false);
    expect(plan.parts.length).toBeGreaterThan(1);
    expect(plan.parts.flatMap((p) => p.text.split("\n"))).toHaveLength(10);
  });

  it("a file with only a heading still gives one part", () => {
    expect(planParts("Business,Owner,Mobile,Email\n").parts).toHaveLength(1);
    expect(planParts("").parts).toHaveLength(1);
  });

  it("every part of a 5 MB file stays far below the platform body limit", () => {
    const text = ["Business,Owner,Mobile,Email", ...people(40000)].join("\n");
    expect(text.length).toBeGreaterThan(2_000_000);
    const plan = planParts(text);
    expect(Math.max(...plan.parts.map((p) => p.text.length))).toBeLessThan(1_000_000);
    expect(plan.rows).toBe(40000);
  });

  it("sendParts stops at the first failure and says how far it got", async () => {
    const plan = planParts(["Business,Mobile", ...people(600).map((p) => p.split(",").slice(0, 3).join(","))].join("\n"), 250);
    const seen: number[] = [];
    const r = await sendParts(plan, async (_p, i) => { if (i === 1) throw new Error("boom"); seen.push(i); return i; });
    expect(r.results).toEqual([0]);
    expect(r.failed?.message).toBe("boom");
    expect(seen).toEqual([0]);
  });
});
