import { describe, expect, it } from "vitest";
import app from "../src/index";
import {
  bookingSchema,
  dateSchema,
  hoursSchema,
  localInstant,
  shopToday,
  slotReason,
  type Shop,
  type Staff,
  type Hours,
  type StoredBooking,
} from "../src/server/domain";

describe("local sandbox boundary", () => {
  it.each([
    "/api/sandbox/session",
    "/api/sandbox/workspace",
    "/api/sandbox/bookings",
  ])("fails closed without local flag: %s", async (path) => {
    const r = await app.request(path, {
      method: path.endsWith("workspace") ? "GET" : "POST",
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "sandbox_disabled" });
  });
  it("serves a no-store workspace shell without claiming identity", async () => {
    const r = await app.request("/workspace");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toContain("noindex,nofollow");
  });
});
describe("strict scheduling inputs and London time", () => {
  it("rejects impossible dates", () => {
    expect(dateSchema.safeParse("2026-02-30").success).toBe(false);
    expect(dateSchema.safeParse("2028-02-29").success).toBe(true);
  });
  it("rejects DST gap and repeated local hour", () => {
    expect(localInstant("2026-03-29", 90)).toBeNull();
    expect(localInstant("2026-10-25", 90)).toBeNull();
  });
  it("maps GMT and BST exactly", () => {
    expect(localInstant("2026-01-12", 540)).toBe(
      Date.parse("2026-01-12T09:00:00Z"),
    );
    expect(localInstant("2026-07-13", 540)).toBe(
      Date.parse("2026-07-13T08:00:00Z"),
    );
  });
  it("uses local date near midnight", () => {
    expect(shopToday("Europe/London", Date.parse("2026-07-13T23:30:00Z"))).toBe(
      "2026-07-14",
    );
  });
  const payload = {
    request_id: crypto.randomUUID(),
    staff_id: crypto.randomUUID(),
    service_id: crypto.randomUUID(),
    date: "2026-10-12",
    start_min: 540,
    customer_name: "Test Client",
    phone: "07700 900123",
    source: "TEST_BOOKING",
    quote: { service_version: 0, shop_version: 0 },
  };
  it("rejects supplied tenant and price values", () => {
    expect(
      bookingSchema.safeParse({ ...payload, shop_id: "other", price_pence: 1 })
        .success,
    ).toBe(false);
  });
  it("normalizes mobile and rejects non-grid starts", () => {
    expect(bookingSchema.parse(payload).phone).toBe("07700900123");
    expect(
      bookingSchema.safeParse({ ...payload, start_min: 541 }).success,
    ).toBe(false);
  });
  it("requires seven unique and internally valid schedules", () => {
    const rows = Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      enabled: 1,
      starts: 540,
      ends: 1080,
      break_start: 720,
      break_end: 750,
    }));
    expect(hoursSchema.safeParse({ version: 0, rows }).success).toBe(true);
    rows[6].weekday = 5;
    expect(hoursSchema.safeParse({ version: 0, rows }).success).toBe(false);
  });
});
describe("duration and buffer availability", () => {
  const shop = {
    opens: 540,
    closes: 1080,
    closed_days: "[0]",
    timezone: "Europe/London",
  } as Shop;
  const staff = { id: "one", active: 1 } as Staff;
  const hours = {
    enabled: 1,
    starts: 540,
    ends: 1080,
    break_start: 765,
    break_end: 810,
  } as Hours;
  const reason = (
    start: number,
    duration = 30,
    bookings: StoredBooking[] = [],
  ) =>
    slotReason(
      shop,
      staff,
      hours,
      [],
      bookings,
      "2026-10-12",
      start,
      duration,
      0,
    );
  it("blocks closing buffer and lunch", () => {
    expect(reason(1050)).toBe("Outside working hours");
    expect(reason(735)).toBe("Lunch break");
    expect(reason(810)).toBe("");
  });
  it("requires full gap but allows exact boundary", () => {
    const b = {
      id: "b",
      staff_id: "one",
      start_at: localInstant("2026-10-12", 600)!,
      end_at: localInstant("2026-10-12", 630)!,
      buffer_min: 10,
      status: "CONFIRMED",
    } as StoredBooking;
    expect(reason(630, 30, [b])).toBe("Slot taken");
    expect(reason(640, 30, [b])).toBe("");
    expect(reason(565, 30, [b])).toBe("Slot taken");
    expect(reason(560, 30, [b])).toBe("");
    expect(reason(600, 30, [{ ...b, status: "CANCELLED" }])).toBe("");
  });
});
