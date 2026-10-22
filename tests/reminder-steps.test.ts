import { describe, it, expect } from "vitest";
import { reminderSteps, quietUntil } from "../src/server/messaging";

describe("reminder schedule", () => {
  it("defaults to the classic pair", () => {
    expect(reminderSteps({ msg_reminder_hours: 24, msg_reminder_steps: "" })).toEqual([24, 2]);
    expect(reminderSteps({ msg_reminder_hours: 48 })).toEqual([48, 2]);
  });
  it("sorts, dedupes, caps at three and drops nonsense", () => {
    expect(reminderSteps({ msg_reminder_steps: "2,48,24,12,48,0,99" })).toEqual([48, 24, 12]);
  });
});

describe("quiet hours", () => {
  const shop = { msg_quiet_on: 1, msg_quiet_start: 1260, msg_quiet_end: 480, timezone: "Europe/London" };
  const at = (iso: string) => Date.parse(iso);
  it("sends straight away in the daytime", () => {
    const t = at("2026-06-10T11:00:00Z"); // 12:00 BST
    expect(quietUntil(shop, t)).toBe(t);
  });
  it("holds a 22:30 reminder until 08:00 local", () => {
    const t = at("2026-06-10T21:30:00Z"); // 22:30 BST
    expect(quietUntil(shop, t)).toBe(at("2026-06-11T07:00:00Z"));
  });
  it("holds a 03:00 reminder until 08:00 local", () => {
    const t = at("2026-01-15T03:00:00Z");
    expect(quietUntil(shop, t)).toBe(at("2026-01-15T08:00:00Z"));
  });
  it("does nothing when switched off", () => {
    const t = at("2026-01-15T03:00:00Z");
    expect(quietUntil({ ...shop, msg_quiet_on: 0 }, t)).toBe(t);
  });
});
