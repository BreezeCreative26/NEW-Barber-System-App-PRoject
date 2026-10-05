import { describe, expect, it } from "vitest";
import app from "../src/index";
import { chairMinutes, dayState } from "../src/client/Shifts";
import { calendarFootprintReason } from "../src/client/Calendar";
import { slotReason, type WorkspaceData } from "../src/server/domain";
import { dateLabel, datePlus, money, time } from "../src/client/fixtures";

describe("app route boundaries", () => {
  it("serves the marketing landing page at the root (signed-out visitors)", async () => {
    const r = await app.request("/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("/signup");
  });
  it("serves the workspace shell with noindex and no-store", async () => {
    const r = await app.request("/workspace");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.text();
    expect(body).toContain("noindex,nofollow");
    expect(body).toMatch(/src="\/static\/app(?:-[A-Za-z0-9_-]+)?\.js"/);
    expect(body).toContain('lang="en"');
  });
  it("has no fixture preview surfaces and rejects unknown business API routes", async () => {
    for (const p of ["/preview/admin", "/preview/book", "/preview/barber"])
      expect((await app.request(p)).status).toBe(404);
    expect((await app.request("/api/bookings", { method: "POST" })).status).toBe(404);
  });
  it("declares that payments and persistence are absent without bindings", async () => {
    const r = await app.request("/api/health");
    expect(await r.json()).toMatchObject({ status: "ok", livePayments: false, persistence: false });
  });
});

describe("formatting helpers", () => {
  it("formats money without silently dropping pence", () => {
    expect(money(2800)).toBe("£28");
    expect(money(2850)).toBe("£28.50");
  });
  it("moves dates consistently using UTC dates", () => {
    expect(datePlus("2026-09-14", 1)).toBe("2026-09-15");
    expect(datePlus("2026-09-30", 1)).toBe("2026-10-01");
    expect(dateLabel("2026-09-14")).toBe("Monday 14 September");
  });
  it("formats minutes", () => {
    expect(time(630)).toBe("10:30");
    expect(time(540)).toBe("09:00");
  });
});


describe("roster capacity and calendar footprints", () => {
  const date = "2030-01-07", now = Date.parse(date + "T08:00:00Z");
  const fixture = () => ({ shop: { id: "shop", timezone: "Europe/London", buffer_min: 0, opens: 540, closes: 1080, closed_days: "[]", week_json: JSON.stringify(Array.from({ length: 7 }, () => ({ enabled: 1, starts: 540, ends: 1080 }))) }, staff: [{ id: "staff", active: 1 }], hours: [{ shop_id: "shop", staff_id: "staff", weekday: 1, enabled: 1, starts: 480, ends: 1140, break_start: 780, break_end: 810 }], schedule_overrides: [], days_off: [], holidays: [], blocks: [], service_rules: [], bookings: [{ id: "booking", staff_id: "staff", service_id: "cut", date, start_min: 600, duration_min: 30, buffer_min: 10, status: "CONFIRMED" }] } as unknown as WorkspaceData);
  it("clamps shifts to opening hours and subtracts overlapping unavailability once", () => {
    const w = fixture(), state = dayState(w, w.staff[0], date);
    expect(state).toMatchObject({ starts: 540, ends: 1080 });
    expect(chairMinutes(state, [{ start_min: 750, end_min: 795 }, { start_min: 780, end_min: 840 }, { start_min: 300, end_min: 540 }, { start_min: 1080, end_min: 1200 }])).toBe(450);
    expect(chairMinutes(state, [{ start_min: 0, end_min: 1440 }])).toBe(0);
  });
  it("prioritises leave and closures over dated shifts", () => {
    const w = fixture();
    w.days_off = [{ staff_id: "staff", date, reason: "Holiday" }] as any;
    expect(dayState(w, w.staff[0], date).kind).toBe("leave");
    w.holidays = [{ date, label: "Closed" }] as any;
    expect(dayState(w, w.staff[0], date).kind).toBe("closed");
  });
  it("includes the saved buffer in closing-time, break, block and collision checks", () => {
    const w = fixture();
    const check = (start: number) => calendarFootprintReason(w,date,"staff",start,30,"booking",now);
    expect(check(750)).toBe("Break");
    expect(check(1050)).toBe("Outside hours");
    expect(check(1410)).toBe("Outside day");
    w.blocks = [{ date, staff_id: "staff", start_min: 900, end_min: 930 }] as any;
    expect(check(870)).toBe("Blocked");
    w.bookings.push({ ...w.bookings[0], id: "other", start_min: 720 });
    expect(check(690)).toBe("Occupied");
    expect(check(660)).toBe("");
  });
  it("rejects unavailable services and respects dated days off and past time", () => {
    const w = fixture();
    w.service_rules = [{ staff_id: "staff", service_id: "cut", enabled: 0 }] as any;
    expect(calendarFootprintReason(w,date,"staff",660,30,"booking",now)).toBe("Service unavailable");
    w.service_rules = [];
    w.schedule_overrides = [{ staff_id: "staff", date, enabled: 0 }] as any;
    expect(calendarFootprintReason(w,date,"staff",660,30,"booking",now)).toBe("Off duty");
    expect(calendarFootprintReason(w,"2030-01-06","staff",660,30,"booking",now)).toBe("Past time");
  });
  it("server availability can preserve a booking's buffer after shop settings change", () => {
    const w = fixture(), h = { ...w.hours[0], ends: 1080 };
    expect(slotReason(w.shop,w.staff[0],h,[],[],date,1050,30,now,undefined,[],[],0)).toBe("");
    expect(slotReason(w.shop,w.staff[0],h,[],[],date,1050,30,now,undefined,[],[],10)).toBe("Outside working hours");
  });
});
