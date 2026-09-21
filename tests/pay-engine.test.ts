// Pay run engine v2: splits, chair/room rent with proration and leave waiver, % deductions, and the
// two totals every statement must reconcile to.
import { describe, expect, it } from "vitest";
import { calculatePayRun, type PayTerms, type Deduction } from "../src/server/domain";

const base: PayTerms = {
  pay_model: "COMMISSION", pay_period: "WEEKLY", commission_pct: 60, base_pence: 0, hourly_pence: 0, rent_pence: 0,
  commission_threshold_pence: 0, commission_tiers: [], tip_share_pct: 100, product_commission_pct: 0, employment: "SELF_EMPLOYED", pay_notes: "", deductions: [],
};
const ded = (d: Partial<Deduction>): Deduction => ({ id: "d1", label: "Chair rent", kind: "FIXED", amount_pence: 15000, pct_x100: 0, cadence: "WEEKLY", proration: "FULL", waive_on_leave: 0, active: 1, ...d });
const week = { service_pence: 124000, tips_pence: 8600, visits: 31, hours_x100: 0, periods: 1, days: 7 };

describe("pay engine v2", () => {
  it("60/40 split: staff share, owner share and both owed totals", () => {
    const r = calculatePayRun(base, week);
    expect(r.staff_share_pence).toBe(74400);
    expect(r.owner_share_pence).toBe(49600);
    expect(r.tip_pence).toBe(8600);
    expect(r.net_pence).toBe(83000);           // owed to staff
    expect(r.owed_to_business_pence).toBe(49600);
    // reconciliation: sales + tips = owed to staff + owed to business
    expect(r.net_pence + r.owed_to_business_pence).toBe(week.service_pence + week.tips_pence);
  });

  it("split + weekly chair rent + 5% supplies + manual lines: statement in the requested order", () => {
    const terms = { ...base, deductions: [ded({}), ded({ id: "d2", label: "Supplies", kind: "PERCENT_OF_TAKINGS", pct_x100: 500 })] };
    const r = calculatePayRun(terms, week, [{ label: "Late fee", pence: -2000 }, { label: "Product bonus", pence: 3500 }]);
    expect(r.deductions.map((d) => [d.label, d.pence])).toEqual([["Chair rent", 15000], ["Supplies", 6200]]);
    expect(r.deductions_pence).toBe(21200);
    expect(r.adjustments_pence).toBe(1500);
    expect(r.net_pence).toBe(74400 + 8600 - 21200 + 1500);        // 63,300 owed to Jay
    expect(r.owed_to_business_pence).toBe(49600 + 21200 - 1500);  // 69,300 owed to business
    expect(r.rent_pence).toBe(15000); // legacy field = fixed deductions only
  });

  it("chair-rent barber keeps 100% of takings; rent is a deduction; owner share is zero", () => {
    const terms: PayTerms = { ...base, pay_model: "CHAIR_RENT", deductions: [ded({})] };
    const r = calculatePayRun(terms, week);
    expect(r.staff_share_pence).toBe(124000);
    expect(r.owner_share_pence).toBe(0);
    expect(r.net_pence).toBe(124000 + 8600 - 15000);
    expect(r.owed_to_business_pence).toBe(15000);
  });

  it("weekly rent on a monthly run: FULL rounds to whole weeks, BY_DAYS prorates by calendar days", () => {
    const month = { ...week, periods: 1, days: 30 };
    const full = calculatePayRun({ ...base, pay_period: "MONTHLY", deductions: [ded({ proration: "FULL" })] }, month);
    expect(full.deductions[0].pence).toBe(15000 * 4); // 30/7 → 4 weeks
    const byDays = calculatePayRun({ ...base, pay_period: "MONTHLY", deductions: [ded({ proration: "BY_DAYS" })] }, month);
    expect(byDays.deductions[0].pence).toBe(Math.round((15000 * 30) / 7)); // 64,286
  });

  it("monthly room rent on a weekly run prorates by days", () => {
    const r = calculatePayRun({ ...base, deductions: [ded({ label: "Room rent", amount_pence: 60000, cadence: "MONTHLY", proration: "BY_DAYS" })] }, week);
    expect(r.deductions[0].pence).toBe(Math.round((60000 * 7) / (365 / 12))); // ≈ 13,808
  });

  it("rent waived for approved leave days when the deduction says so", () => {
    const withLeave = { ...week, leave_days: 2 };
    const waived = calculatePayRun({ ...base, deductions: [ded({ waive_on_leave: 1 })] }, withLeave);
    expect(waived.deductions[0].pence).toBe(15000 - Math.round((15000 * 2) / 7)); // 10,714
    expect(waived.deductions[0].detail).toContain("2 leave days waived");
    const notWaived = calculatePayRun({ ...base, deductions: [ded({ waive_on_leave: 0 })] }, withLeave);
    expect(notWaived.deductions[0].pence).toBe(15000);
  });

  it("% of staff share is taken from share + tips; inactive deductions are ignored; per-run is flat", () => {
    const terms = { ...base, deductions: [ded({ id: "a", label: "Marketing", kind: "PERCENT_OF_STAFF_SHARE", pct_x100: 1000 }), ded({ id: "b", active: 0 }), ded({ id: "c", label: "Towels", cadence: "PER_RUN", amount_pence: 800 })] };
    const r = calculatePayRun(terms, week);
    expect(r.deductions.map((d) => d.label)).toEqual(["Marketing", "Towels"]);
    expect(r.deductions[0].pence).toBe(Math.round(((74400 + 8600) * 1000) / 10000)); // 8,300
    expect(r.deductions[1].pence).toBe(800);
  });

  it("base + commission (HYBRID) and tiers still feed staff share; owner share never negative", () => {
    const terms: PayTerms = { ...base, pay_model: "HYBRID", base_pence: 30000, commission_threshold_pence: 50000, commission_pct: 30 };
    const r = calculatePayRun(terms, week);
    expect(r.base_pence).toBe(30000);
    expect(r.commission_pence).toBe(Math.round((124000 - 50000) * 0.3));
    expect(r.staff_share_pence).toBe(r.base_pence + r.commission_pence);
    expect(r.owner_share_pence).toBe(124000 - r.staff_share_pence);
    const salary = calculatePayRun({ ...base, pay_model: "SALARY", base_pence: 200000 }, week);
    expect(salary.owner_share_pence).toBe(0); // salary exceeds sales → owner share floors at 0
  });

  it("deductions can push owed-to-staff negative (barber owes the shop) — reported, not hidden", () => {
    const r = calculatePayRun({ ...base, deductions: [ded({ amount_pence: 100000 })] }, { ...week, service_pence: 20000, tips_pence: 0 });
    expect(r.net_pence).toBeLessThan(0);
    expect(r.owed_to_business_pence).toBe(8000 + 100000);
  });
});
