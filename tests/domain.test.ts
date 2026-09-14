import { describe, expect, it } from "vitest";
import app from "../src/index";
import {
  calculateQuote,
  effectiveHours,
  addonSchema,
  overrideSchema,
  type Service,
  type StaffServiceRule,
  type ScheduleOverride,
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

describe("authoritative catalogue items and dated hours", () => {
  const service = {
    id: "service",
    shop_id: "shop",
    name: "Cut",
    price_pence: 2800,
    duration_min: 30,
    active: 1,
  } as Service;
  const rule = {
    shop_id: "shop",
    staff_id: "staff",
    service_id: "service",
    enabled: 1,
    price_pence: 0,
    duration_min: 25,
    version: 1,
  } as StaffServiceRule;
  const a = {
    id: "addon",
    shop_id: "shop",
    name: "Detail work",
    price_pence: 650,
    duration_min: 7,
    active: 1,
    version: 0,
  };
  const links = [{ shop_id: "shop", addon_id: a.id, service_id: service.id }];
  it("preserves zero override prices and exact non-grid duration sums", () => {
    const q = calculateQuote(service, rule, [a], links, [a.id]);
    expect(q.price_pence).toBe(650);
    expect(q.duration_min).toBe(32);
    expect(q.items).toHaveLength(2);
  });
  it("rejects duplicate, inactive and unlinked add-ons", () => {
    expect(() =>
      calculateQuote(service, null, [a], links, [a.id, a.id]),
    ).toThrow("addon_unavailable");
    expect(() =>
      calculateQuote(service, null, [{ ...a, active: 0 }], links, [a.id]),
    ).toThrow("addon_unavailable");
    expect(() => calculateQuote(service, null, [a], [], [a.id])).toThrow(
      "addon_unavailable",
    );
  });
  it("rejects disabled service eligibility and restores catalogue defaults with nulls", () => {
    expect(() =>
      calculateQuote(service, { ...rule, enabled: 0 }, [], [], []),
    ).toThrow("service_ineligible");
    expect(
      calculateQuote(
        service,
        { ...rule, price_pence: null, duration_min: null },
        [],
        [],
        [],
      ).price_pence,
    ).toBe(2800);
  });
  it("a dated shift replaces rather than intersects weekly shift and break", () => {
    const h = {
      starts: 540,
      ends: 1080,
      enabled: 0,
      break_start: 765,
      break_end: 810,
    } as Hours;
    const o = {
      date: "2026-10-12",
      starts: 600,
      ends: 1020,
      enabled: 1,
      break_start: 720,
      break_end: 750,
    } as ScheduleOverride;
    expect(effectiveHours(h, o)).toMatchObject({
      starts: 600,
      ends: 1020,
      enabled: 1,
      break_start: 720,
      break_end: 750,
      weekday: 1,
    });
    expect(effectiveHours(h, null)).toBe(h);
  });
  it("validates exact add-on bounds and dated shift ordering", () => {
    const input = {
      name: "Towel",
      price_pence: 0,
      duration_min: 0,
      active: 1,
      service_ids: [crypto.randomUUID()],
    };
    expect(addonSchema.safeParse(input).success).toBe(true);
    expect(addonSchema.safeParse({ ...input, service_ids: [] }).success).toBe(
      false,
    );
    expect(
      overrideSchema.safeParse({
        date: "2026-10-12",
        enabled: 1,
        starts: 600,
        ends: 660,
        break_start: 630,
        break_end: 700,
        reason: "Invalid break",
      }).success,
    ).toBe(false);
  });
});

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
it("dated leave is barber- and shop-scoped, not a closure for every barber", () => {
  const shop = {
    id: "shop",
    opens: 540,
    closes: 1080,
    closed_days: "[]",
    timezone: "Europe/London",
  } as Shop;
  const staff = { id: "barber", active: 1 } as Staff;
  const hours = {
    enabled: 1,
    starts: 540,
    ends: 1080,
    break_start: 540,
    break_end: 540,
  } as Hours;
  const leave = {
    id: "leave",
    shop_id: "shop",
    staff_id: "barber",
    date: "2026-10-12",
    reason: "Test leave",
    created_at: 0,
  };
  const check = (days: (typeof leave)[]) =>
    slotReason(
      shop,
      staff,
      hours,
      [],
      [],
      leave.date,
      540,
      30,
      0,
      undefined,
      days,
    );
  expect(check([leave])).toBe("Barber has a day off");
  expect(check([{ ...leave, staff_id: "other" }])).toBe("");
  expect(check([{ ...leave, shop_id: "other" }])).toBe("");
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
