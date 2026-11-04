// What a customer sees when staff booked a different calendar length: the service's normal length,
// on the manage page / account (customerView) — never the shop's internal block.
import { describe, expect, it } from "vitest";
import { customerView } from "../src/server/public";

const base = {
  id: "b1", shop_id: "s1", sequence: 7, status: "CONFIRMED", date: "2026-11-19", start_min: 600,
  start_at: Date.parse("2026-11-19T10:00:00Z"), service_name: "Signature cut", items_json: "[]",
  price_pence: 2800, deposit_policy_pence: 0, cancel_hours_snapshot: 24,
} as never;

describe("customerView: the customer always sees the length they booked", () => {
  it("staff blocked 45 min for a 30 min cut: customer sees 10:00–10:30", () => {
    const v = customerView({ ...(base as object), duration_min: 45, end_at: Date.parse("2026-11-19T10:45:00Z"), customer_duration_min: 30 } as never, { name: "Shop" } as never, "Jay");
    expect(v.duration_min).toBe(30);
    expect(v.end_at).toBe(Date.parse("2026-11-19T10:30:00Z"));
  });
  it("staff blocked 15 min for a 30 min cut: customer still sees 30", () => {
    const v = customerView({ ...(base as object), duration_min: 15, end_at: Date.parse("2026-11-19T10:15:00Z"), customer_duration_min: 30 } as never, { name: "Shop" } as never, "Jay");
    expect(v.duration_min).toBe(30);
  });
  it("normal booking (no staff length) is unchanged", () => {
    const v = customerView({ ...(base as object), duration_min: 30, end_at: Date.parse("2026-11-19T10:30:00Z"), customer_duration_min: null } as never, { name: "Shop" } as never, "Jay");
    expect(v.duration_min).toBe(30);
    expect(v.end_at).toBe(Date.parse("2026-11-19T10:30:00Z"));
  });
});
