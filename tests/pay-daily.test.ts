// Round 2 pay audit: daily chair rent (rota / booked / every day), whole months not being charged as
// 1.02 months, tiers that don't start at zero, and the before/after pay-change line.
import { describe, expect, it } from "vitest";
import { calculatePayRun, commissionFor, payTermsLine, type PayTerms, type Deduction } from "../src/server/domain";

const base: PayTerms = {
  pay_model: "CHAIR_RENT", pay_period: "WEEKLY", commission_pct: 60, base_pence: 0, hourly_pence: 0, rent_pence: 0,
  commission_threshold_pence: 0, commission_tiers: [], tip_share_pct: 100, product_commission_pct: 0, employment: "SELF_EMPLOYED", pay_notes: "", deductions: [],
};
const ded = (d: Partial<Deduction>): Deduction => ({ id: "d1", label: "Day rent", kind: "FIXED", amount_pence: 2500, pct_x100: 0, cadence: "DAILY", day_basis: "ROSTERED", proration: "FULL", waive_on_leave: 0, active: 1, ...d });
const week = { service_pence: 90000, tips_pence: 0, visits: 30, hours_x100: 0, periods: 1, days: 7, working_days: 4, booked_days: 3, leave_days: 1 };

describe("daily chair rent", () => {
  it("charges each day they're on the rota (days off already left out)", () => {
    const r = calculatePayRun({ ...base, deductions: [ded({})] }, week);
    expect(r.deductions[0].pence).toBe(10000);
    expect(r.deductions[0].detail).toBe("4 rostered days at £25.00");
  });
  it("charges only days with bookings", () => {
    const r = calculatePayRun({ ...base, deductions: [ded({ day_basis: "BOOKED" })] }, week);
    expect(r.deductions[0].pence).toBe(7500);
    expect(r.deductions[0].detail).toBe("3 booked days at £25.00");
  });
  it("charges every day, less leave when waived", () => {
    expect(calculatePayRun({ ...base, deductions: [ded({ day_basis: "EVERY_DAY" })] }, week).deductions[0].pence).toBe(17500);
    const w = calculatePayRun({ ...base, deductions: [ded({ day_basis: "EVERY_DAY", waive_on_leave: 1 })] }, week);
    expect(w.deductions[0].pence).toBe(15000);
    expect(w.deductions[0].detail).toContain("1 leave day not charged");
  });
  it("owed both ways still reconcile", () => {
    const r = calculatePayRun({ ...base, deductions: [ded({})] }, week);
    expect(r.net_pence).toBe(90000 - 10000);
    expect(r.owed_to_business_pence).toBe(10000);
  });
});

describe("pay audit fixes", () => {
  it("a calendar month of monthly rent is one month, not 31/30.4", () => {
    const monthly = { id: "m", label: "Room rent", kind: "FIXED" as const, amount_pence: 100000, pct_x100: 0, cadence: "MONTHLY" as const, proration: "BY_DAYS" as const, waive_on_leave: 0 as const, active: 1 as const };
    for (const days of [28, 30, 31]) {
      const r = calculatePayRun({ ...base, pay_period: "MONTHLY", deductions: [monthly] }, { service_pence: 0, tips_pence: 0, visits: 0, hours_x100: 0, periods: 1, days });
      expect(r.deductions[0].pence).toBe(100000);
    }
    // A single week still prorates.
    const w = calculatePayRun({ ...base, deductions: [monthly] }, { service_pence: 0, tips_pence: 0, visits: 0, hours_x100: 0, periods: 1, days: 7 });
    expect(w.deductions[0].pence).toBe(Math.round((100000 * 7) / (365 / 12)));
  });
  it("tiers that start above zero pay the flat rate below the first band", () => {
    const t: PayTerms = { ...base, pay_model: "COMMISSION", commission_pct: 40, commission_tiers: [{ from_pence: 100000, pct: 50 }] };
    expect(commissionFor(t, 150000)).toBe(40000 + 25000);
    expect(commissionFor(t, 80000)).toBe(32000);
  });
  it("tiers from zero are unchanged", () => {
    const t: PayTerms = { ...base, pay_model: "COMMISSION", commission_tiers: [{ from_pence: 0, pct: 55 }, { from_pence: 100000, pct: 65 }] };
    expect(commissionFor(t, 150000)).toBe(55000 + 32500);
  });
  it("pay-change line reads plainly", () => {
    expect(payTermsLine({ ...base, deductions: [ded({})] })).toBe("keeps all takings, paid weekly, tips 100%, less Day rent £25 a day (days on the rota)");
    expect(payTermsLine({ ...base, pay_model: "COMMISSION", commission_pct: 60 })).toBe("60% commission, paid weekly, tips 100%");
  });
});
