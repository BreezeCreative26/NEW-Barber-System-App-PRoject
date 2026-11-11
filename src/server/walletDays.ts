// Wallet maths that is shared by the quick view (day by day + calendar), the full wallet screen and the
// pay-run engine's rota. Pure functions only: the routes in sandbox.ts fetch rows and call these.
//
// The rule the wallet follows (shop pays barbers by hand, Model A):
//   taken     everything recorded at checkout, by method (card reader, cash, transfer, other, £0 visits)
//   owed      what the shop has to hand over to the barber: money that landed in the shop's account
//             (card reader / online card) less what the barber pays (card reader fee, chair rent).
//             Cash, bank transfers and other hand payments are already with the barber, so they are
//             shown as "kept" and never added to what is owed.
import { calculatePayRun, effectiveHours, payTermsOf, periodsCovered, shopDay, weekday, type Hours, type Payment, type ScheduleOverride, type Shop, type Staff } from "./domain";
import { tenderKind } from "./payouts";

export type RotaDay = { working: number; leave: number; minutes: number };
// One day of a barber's rota: rostered (working) or a day off on a day they'd normally work (leave),
// and the rostered minutes. Closures and shop-shut days count as neither.
export function rotaDay(shop: Shop, hours: Hours[], overrides: ScheduleOverride[], off: Set<string>, holidays: string[], d: string): RotaDay {
  const day = shopDay(shop, weekday(d));
  if (holidays.includes(d) || !day.enabled) return { working: 0, leave: 0, minutes: 0 };
  const h = effectiveHours(hours.find((x) => x.weekday === weekday(d)) ?? null, overrides.find((o) => o.date === d) ?? null);
  if (!h?.enabled) return { working: 0, leave: 0, minutes: 0 };
  if (off.has(d)) return { working: 0, leave: 1, minutes: 0 };
  const breakMin = h.break_end > h.break_start ? h.break_end - h.break_start : 0;
  return { working: 1, leave: 0, minutes: Math.max(0, Math.max(0, Math.min(h.ends, day.ends) - Math.max(h.starts, day.starts)) - breakMin) };
}

type Row = Pick<Payment, "booking_id" | "method" | "service_pence" | "tip_pence" | "stripe_payment_intent">;
export type Tally = {
  service: number; tips: number; taken: number;
  /** Shop's own card machine (Revolut): lands in the shop's account. */
  reader: number;
  /** Card through foliyo/Stripe (online deposits, pay links). */
  online: number;
  /** Already with the barber. */
  cash: number; transfer: number; other: number;
  visits: number; zero_visits: number; payments: number;
};
// readerFeeBps: the card machine's fee, worked out per payment (that is how the machine charges it) and
// summed, the same way payRunFiguresDb does, so a period's fee always equals the sum of its days.
export const readerFeeOf = (amount: number, bps: number) => Math.round((amount * bps) / 10000);
export function tally(rows: Row[], readerFeeBps = 0): Tally & { reader_fee: number } {
  const t: Tally & { reader_fee: number } = { service: 0, tips: 0, taken: 0, reader: 0, online: 0, cash: 0, transfer: 0, other: 0, visits: 0, zero_visits: 0, payments: rows.length, reader_fee: 0 };
  const visits = new Set<string>(), paid = new Set<string>();
  for (const r of rows) {
    const amt = r.service_pence + r.tip_pence;
    t.service += r.service_pence; t.tips += r.tip_pence; t.taken += amt;
    const kind = tenderKind(r.method, r.stripe_payment_intent || "");
    if (kind === "READER") { t.reader += amt; t.reader_fee += readerFeeOf(amt, readerFeeBps); }
    else if (kind === "STRIPE") t.online += amt;
    else if (r.method === "CASH") t.cash += amt;
    else if (r.method === "TRANSFER") t.transfer += amt;
    else t.other += amt;
    visits.add(r.booking_id);
    if (amt > 0) paid.add(r.booking_id);
  }
  t.visits = visits.size;
  // A visit counts as £0 when nothing at all was taken for it (a free visit).
  t.zero_visits = [...visits].filter((b) => !paid.has(b)).length;
  return t;
}
/** Money the barber already holds (cash, transfer, voucher/other). */
export const kept = (t: Pick<Tally, "cash" | "transfer" | "other">) => t.cash + t.transfer + t.other;

export type DayMoney = Tally & {
  reader_fee: number;
  date: string;
  staff_id: string;
  pay_model: string;
  fee: number;
  rent: number;
  deductions: { label: string; pence: number; detail: string }[];
  /** Their share of sales (all of it for chair renters, commission otherwise) and of tips. */
  share: number; tip_share: number;
  /** What their pay setup gives them for the day (all methods, after fee and daily rent). */
  earned: number;
  /** Cash / transfer / other the barber kept (chair renters keep their own takings). */
  held: number;
  /** + the shop owes the barber for the day; − the barber owes the shop (e.g. rent on a cash day). */
  owed: number;
};
// One barber, one day, through the same pay engine as pay runs. Only daily rent and % charges are
// spread over days; weekly / monthly / per-run rent is charged on the pay run, not on a single day.
export function dayMoney(shop: Pick<Shop, "card_reader_fee_bps">, staff: Staff, date: string, rows: Row[], rota: RotaDay): DayMoney {
  const t = tally(rows, shop.card_reader_fee_bps ?? 0);
  const terms0 = payTermsOf(staff);
  const terms = { ...terms0, deductions: terms0.deductions.filter((d) => d.kind !== "FIXED" || d.cadence === "DAILY") };
  const calc = calculatePayRun(terms, {
    service_pence: t.service, tips_pence: t.tips, visits: t.visits, hours_x100: Math.round((rota.minutes / 60) * 100),
    periods: periodsCovered(terms.pay_period, 1), days: 1, leave_days: rota.leave, working_days: rota.working, booked_days: t.payments ? 1 : 0,
    reader_pence: t.reader, reader_fee_bps: shop.card_reader_fee_bps ?? 0, reader_fee_pence: t.reader_fee,
  });
  const fee = calc.deductions.find((d) => d.id === "card_reader_fee")?.pence ?? 0;
  const held = terms.pay_model === "CHAIR_RENT" ? kept(t) : 0;
  return { ...t, date, staff_id: staff.id, pay_model: terms.pay_model, fee, rent: calc.deductions_pence - fee, deductions: calc.deductions.filter((d) => d.pence), share: calc.staff_share_pence, tip_share: calc.tip_pence, earned: calc.net_pence, held, owed: calc.net_pence - held };
}

export function datePlus(d: string, n: number) {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
export function eachDay(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to; d = datePlus(d, 1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Loading: one barber's open wallet (everything not yet paid to them) and any range of days.
// The figures here are the ones the wallet chip, the quick view, the full wallet, the pay runs page and
// "Mark paid" all show, so they can never disagree.
import type { Database as DB } from "../db/client";
import type { BookingAdjustment, PayRun, DeductionLine } from "./domain";
import { OPEN_PAYMENT_SQL, SETTLED_RUN_SQL } from "./payouts";

export type WalletPayment = Payment & { customer_name: string; service_name: string; start_min: number; visit_date: string };
export type PeriodMoney = Tally & {
  reader_fee: number; fee: number; rent: number;
  deductions: DeductionLine[]; adjustments: { label: string; pence: number }[];
  share: number; tip_share: number; earned: number; held: number; owed: number;
  working_days: number; leave_days: number; days: number; settled_days: number;
};
export type PaidRun = {
  id: string; period_from: string; period_to: string; status: string; paid_at: number; paid_method: string | null; paid_reference: string;
  /** What changed hands when it was settled: + shop paid the barber, − the barber paid the shop. */
  amount_pence: number; net_pence: number; service_pence: number; tips_pence: number; visits: number;
};
export type OpenWallet = {
  staff_id: string; name: string; pay_model: string; active: number;
  from: string; to: string; empty: boolean;
  last_paid: PaidRun | null;
  /** Older pay runs that were made but never marked paid: their money is still in this wallet. */
  unsettled_runs: { id: string; period_from: string; period_to: string; status: string; transfers: boolean }[];
  period: PeriodMoney;
  days: DayMoney[];
  payments: WalletPayment[];
  adjustment_ids: string[];
  /** Rota of the open days (internal: lets "Mark paid" recompute exactly what is shown). */
  rota?: RotaDay[];
};

const zeroPeriod = (): PeriodMoney => ({ ...tally([]), reader_fee: 0, fee: 0, rent: 0, deductions: [], adjustments: [], share: 0, tip_share: 0, earned: 0, held: 0, owed: 0, working_days: 0, leave_days: 0, days: 0, settled_days: 0 });
export function paidRunOf(r: PayRun): PaidRun {
  const amount = (r.cash_residual_pence ?? 0) + (r.transferred_at ? (r.transfer_pence ?? 0) : 0);
  return { id: r.id, period_from: r.period_from, period_to: r.period_to, status: r.status, paid_at: r.updated_at, paid_method: r.paid_method, paid_reference: r.paid_reference, amount_pence: amount, net_pence: r.net_pence, service_pence: r.service_pence, tips_pence: r.tips_pence, visits: r.visits };
}

type Rota = { hours: Hours[]; overrides: ScheduleOverride[]; off: { staff_id: string; date: string }[]; holidays: string[] };
async function rotaRows(db: DB, shopId: string, staffIds: string[], from: string, to: string): Promise<Rota> {
  if (!staffIds.length) return { hours: [], overrides: [], off: [], holidays: [] };
  const inList = staffIds.map(() => "?").join(",");
  const [hours, overrides, off, holidays] = await Promise.all([
    db.prepare(`SELECT * FROM staff_hours WHERE shop_id=? AND staff_id IN (${inList})`).bind(shopId, ...staffIds).all<Hours>(),
    db.prepare(`SELECT * FROM staff_schedule_overrides WHERE shop_id=? AND staff_id IN (${inList}) AND date BETWEEN ? AND ?`).bind(shopId, ...staffIds, from, to).all<ScheduleOverride>(),
    db.prepare(`SELECT staff_id, date FROM staff_days_off WHERE shop_id=? AND staff_id IN (${inList}) AND date BETWEEN ? AND ?`).bind(shopId, ...staffIds, from, to).all<{ staff_id: string; date: string }>(),
    db.prepare("SELECT date FROM holidays WHERE shop_id=? AND date BETWEEN ? AND ?").bind(shopId, from, to).all<{ date: string }>(),
  ]);
  return { hours: hours.results, overrides: overrides.results, off: off.results, holidays: holidays.results.map((h) => h.date) };
}
const rotaFor = (shop: Shop, rota: Rota, staffId: string, d: string) =>
  rotaDay(shop, rota.hours.filter((h) => h.staff_id === staffId), rota.overrides.filter((o) => o.staff_id === staffId), new Set(rota.off.filter((o) => o.staff_id === staffId).map((o) => o.date)), rota.holidays, d);

// The whole period through the pay engine (same inputs as payRunFiguresDb with openOnly), so commission
// tiers and weekly/monthly rent are worked out on the period, not added up day by day.
export function periodCalc(shop: Shop, staff: Staff, rows: WalletPayment[], rota: RotaDay[], adjustments: { label: string; pence: number }[]) {
  const t = tally(rows, shop.card_reader_fee_bps ?? 0);
  const working = rota.reduce((n, r) => n + r.working, 0), leave = rota.reduce((n, r) => n + r.leave, 0), minutes = rota.reduce((n, r) => n + r.minutes, 0);
  const days = rota.length;
  const terms = payTermsOf(staff);
  const input = {
    service_pence: t.service, tips_pence: t.tips, visits: t.visits, hours_x100: Math.round((minutes / 60) * 100),
    periods: periodsCovered(terms.pay_period, Math.max(1, days)), days: Math.max(1, days), leave_days: leave, working_days: working,
    booked_days: new Set(rows.map((r) => r.date)).size, reader_pence: t.reader, reader_fee_bps: shop.card_reader_fee_bps ?? 0, reader_fee_pence: t.reader_fee,
  };
  return { t, terms, input, calc: calculatePayRun(terms, input, adjustments), working, leave, days };
}
export function periodMoney(shop: Shop, staff: Staff, rows: WalletPayment[], rota: RotaDay[], settledDays: number, adjustments: { label: string; pence: number }[]): PeriodMoney {
  if (!rota.length && !rows.length && !adjustments.length) return { ...zeroPeriod(), settled_days: settledDays };
  const { t, terms, calc, working, leave, days } = periodCalc(shop, staff, rows, rota, adjustments);
  const fee = calc.deductions.find((d) => d.id === "card_reader_fee")?.pence ?? 0;
  const held = terms.pay_model === "CHAIR_RENT" ? kept(t) : 0;
  return { ...t, fee, rent: calc.deductions_pence - fee, deductions: calc.deductions.filter((d) => d.pence), adjustments, share: calc.staff_share_pence, tip_share: calc.tip_pence, earned: calc.net_pence, held, owed: calc.net_pence - held, working_days: working, leave_days: leave, days, settled_days: settledDays };
}

/**
 * Open wallets: for each barber, everything not yet paid to them, from the day after their last paid
 * pay run (or their oldest unpaid payment, whichever is earlier) up to `to`.
 * staffIds: null = every active barber plus anyone with unpaid money; a list = just those.
 */
export async function loadOpenWallets(db: DB, shop: Shop, opts: { staffIds: string[] | null; to: string }): Promise<OpenWallet[]> {
  const sid = shop.id, to = opts.to;
  const scope = opts.staffIds;
  const scoped = (col: string) => (scope ? ` AND ${col} IN (${scope.map(() => "?").join(",") || "NULL"})` : "");
  const sargs = scope ?? [];
  const [staffRows, settled, unsettled, payments, adjustments] = await Promise.all([
    db.prepare(`SELECT * FROM staff WHERE shop_id=?${scoped("id")} ORDER BY sort_order, name`).bind(sid, ...sargs).all<Staff>(),
    db.prepare(`SELECT * FROM pay_runs r WHERE r.shop_id=?${scoped("r.staff_id")} AND ${SETTLED_RUN_SQL} ORDER BY r.period_to DESC, r.updated_at DESC`).bind(sid, ...sargs).all<PayRun>(),
    db.prepare(`SELECT * FROM pay_runs r WHERE r.shop_id=?${scoped("r.staff_id")} AND r.status<>'VOID' AND NOT ${SETTLED_RUN_SQL} ORDER BY r.period_from`).bind(sid, ...sargs).all<PayRun>(),
    db.prepare(`SELECT p.*, b.customer_name, b.service_name, b.start_min, b.date AS visit_date FROM payments p JOIN bookings b ON b.shop_id=p.shop_id AND b.id=p.booking_id WHERE p.shop_id=?${scoped("p.staff_id")} AND p.voided_at IS NULL AND p.date<=? AND ${OPEN_PAYMENT_SQL("p")} ORDER BY p.created_at DESC`).bind(sid, ...sargs, to).all<WalletPayment>(),
    // Deposit-refund lines not yet recovered: unclaimed, or claimed by a run that was never paid.
    db.prepare(`SELECT * FROM booking_adjustments a WHERE a.shop_id=?${scoped("a.staff_id")} AND a.date<=? AND (a.pay_run_id IS NULL OR NOT EXISTS (SELECT 1 FROM pay_runs r WHERE r.id=a.pay_run_id AND ${SETTLED_RUN_SQL}))`).bind(sid, ...sargs, to).all<BookingAdjustment>(),
  ]);
  const withMoney = new Set(payments.results.map((p) => p.staff_id));
  const staff = staffRows.results.filter((s) => s.active || withMoney.has(s.id) || (scope && scope.includes(s.id)));
  const startOf = (s: Staff) => {
    const lastTo = settled.results.find((r) => r.staff_id === s.id)?.period_to;
    const oldest = payments.results.filter((p) => p.staff_id === s.id).reduce<string | null>((m, p) => (!m || p.date < m ? p.date : m), null);
    const afterPaid = lastTo ? datePlus(lastTo, 1) : null;
    const cands = [oldest, afterPaid].filter((x): x is string => !!x);
    return cands.length ? cands.sort()[0] : to;
  };
  const starts = new Map(staff.map((s) => [s.id, startOf(s)] as const));
  const minFrom = [...starts.values()].sort()[0] ?? to;
  const rota = await rotaRows(db, sid, staff.map((s) => s.id), minFrom <= to ? minFrom : to, to);
  return staff.map((s) => {
    const start = starts.get(s.id)!;
    const empty = start > to;
    const from = empty ? to : start;
    const runs = settled.results.filter((r) => r.staff_id === s.id);
    const settledDay = (d: string) => runs.some((r) => r.period_from <= d && r.period_to >= d);
    const rows = payments.results.filter((p) => p.staff_id === s.id);
    const adj = adjustments.results.filter((a) => a.staff_id === s.id);
    const days: DayMoney[] = [];
    const rotaDays: RotaDay[] = [];
    let settledDays = 0;
    if (!empty) {
      for (const d of eachDay(from, to)) {
        const settledHere = settledDay(d);
        const r = settledHere ? { working: 0, leave: 0, minutes: 0 } : rotaFor(shop, rota, s.id, d);
        if (settledHere) settledDays += 1; else rotaDays.push(r);
        const dayRows = rows.filter((p) => p.date === d);
        if (!dayRows.length && !r.working) continue;
        const dm = dayMoney(shop, s, d, dayRows, r);
        if (dayRows.length || dm.rent) days.push(dm);
      }
    }
    const period = empty && !rows.length ? zeroPeriod() : periodMoney(shop, s, rows, rotaDays, settledDays, adj.map((a) => ({ label: a.label, pence: a.pence })));
    return {
      staff_id: s.id, name: s.name, pay_model: s.pay_model, active: s.active,
      from, to, empty: empty && !rows.length,
      last_paid: runs[0] ? paidRunOf(runs[0]) : null,
      unsettled_runs: unsettled.results.filter((r) => r.staff_id === s.id).map((r) => ({ id: r.id, period_from: r.period_from, period_to: r.period_to, status: r.status, transfers: (r.transfer_pence ?? 0) > 0 || (r.shop_transfer_pence ?? 0) > 0 })),
      period, days: days.reverse(), payments: rows, adjustment_ids: adj.map((a) => a.id), rota: rotaDays,
    };
  });
}
/** Wallet chip: owed to barbers (sum of what the shop owes each one; a barber who owes the shop is not netted off). */
export const owedTotal = (ws: OpenWallet[]) => ws.reduce((n, w) => n + Math.max(0, w.period.owed), 0);

export type DayBarber = DayMoney & { name: string; paid: boolean; rows?: WalletPayment[] };
export type WalletDay = { date: string; barbers: DayBarber[]; taken: number; reader: number; kept: number; owed_to_barbers: number; owed_to_shop: number; visits: number; zero_visits: number };
/** Every day in a range, every barber who worked or took money: what was taken and what that day adds to the wallet. */
export async function loadWalletDays(db: DB, shop: Shop, opts: { staffIds: string[] | null; from: string; to: string; withPayments: boolean }): Promise<{ staff: { id: string; name: string }[]; days: WalletDay[] }> {
  const sid = shop.id, { from, to } = opts;
  const scope = opts.staffIds;
  const scoped = (col: string) => (scope ? ` AND ${col} IN (${scope.map(() => "?").join(",") || "NULL"})` : "");
  const sargs = scope ?? [];
  const [staffRows, payments, settled] = await Promise.all([
    db.prepare(`SELECT * FROM staff WHERE shop_id=?${scoped("id")} ORDER BY sort_order, name`).bind(sid, ...sargs).all<Staff>(),
    db.prepare(`SELECT p.*, b.customer_name, b.service_name, b.start_min, b.date AS visit_date FROM payments p JOIN bookings b ON b.shop_id=p.shop_id AND b.id=p.booking_id WHERE p.shop_id=?${scoped("p.staff_id")} AND p.voided_at IS NULL AND p.date BETWEEN ? AND ? ORDER BY p.created_at`).bind(sid, ...sargs, from, to).all<WalletPayment>(),
    db.prepare(`SELECT staff_id, period_from, period_to FROM pay_runs r WHERE r.shop_id=?${scoped("r.staff_id")} AND r.period_to>=? AND r.period_from<=? AND ${SETTLED_RUN_SQL}`).bind(sid, ...sargs, from, to).all<{ staff_id: string; period_from: string; period_to: string }>(),
  ]);
  const withMoney = new Set(payments.results.map((p) => p.staff_id));
  const staff = staffRows.results.filter((s) => s.active || withMoney.has(s.id));
  const rota = await rotaRows(db, sid, staff.map((s) => s.id), from, to);
  const days: WalletDay[] = eachDay(from, to).map((d) => {
    const barbers: DayBarber[] = [];
    for (const s of staff) {
      const rows = payments.results.filter((p) => p.staff_id === s.id && p.date === d);
      const r = rotaFor(shop, rota, s.id, d);
      if (!rows.length && !r.working) continue;
      const dm = dayMoney(shop, s, d, rows, r);
      if (!rows.length && !dm.rent) continue;
      barbers.push({ ...dm, name: s.name, paid: settled.results.some((x) => x.staff_id === s.id && x.period_from <= d && x.period_to >= d), ...(opts.withPayments ? { rows } : {}) });
    }
    return {
      date: d, barbers,
      taken: barbers.reduce((n, b) => n + b.taken, 0), reader: barbers.reduce((n, b) => n + b.reader + b.online, 0), kept: barbers.reduce((n, b) => n + kept(b), 0),
      owed_to_barbers: barbers.reduce((n, b) => n + Math.max(0, b.owed), 0), owed_to_shop: barbers.reduce((n, b) => n + Math.max(0, -b.owed), 0),
      visits: barbers.reduce((n, b) => n + b.visits, 0), zero_visits: barbers.reduce((n, b) => n + b.zero_visits, 0),
    };
  });
  return { staff: staff.map((s) => ({ id: s.id, name: s.name })), days };
}

export type PaidWindow = PaidRun & { pay_model: string; deductions: DeductionLine[]; adjustments: { label: string; pence: number }[]; tally: Tally & { reader_fee: number }; days: (Tally & { date: string })[]; payments: WalletPayment[] };
/** Every pay window a barber has been paid for, newest first, with the payments it covered. */
export async function loadPaidWindows(db: DB, shop: Shop, staffId: string, limit = 60): Promise<PaidWindow[]> {
  const runs = (await db.prepare(`SELECT * FROM pay_runs r WHERE r.shop_id=? AND r.staff_id=? AND ${SETTLED_RUN_SQL} ORDER BY r.period_to DESC, r.updated_at DESC LIMIT ?`).bind(shop.id, staffId, limit).all<PayRun>()).results;
  if (!runs.length) return [];
  const pays = (await db.prepare(`SELECT p.*, b.customer_name, b.service_name, b.start_min, b.date AS visit_date FROM payments p JOIN bookings b ON b.shop_id=p.shop_id AND b.id=p.booking_id WHERE p.shop_id=? AND p.voided_at IS NULL AND p.pay_run_id IN (${runs.map(() => "?").join(",")}) ORDER BY p.date, p.created_at`).bind(shop.id, ...runs.map((r) => r.id)).all<WalletPayment>()).results;
  const parse = <T,>(s: string | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };
  return runs.map((r) => {
    const rows = pays.filter((p) => p.pay_run_id === r.id);
    const dates = [...new Set(rows.map((p) => p.date))];
    return {
      ...paidRunOf(r), pay_model: r.pay_model,
      deductions: parse<DeductionLine[]>(r.deductions_json, []).filter((d) => d.pence), adjustments: parse<{ label: string; pence: number }[]>(r.adjustments_json, []),
      tally: tally(rows, shop.card_reader_fee_bps ?? 0),
      days: dates.map((d) => ({ date: d, ...tally(rows.filter((p) => p.date === d)) })),
      payments: rows,
    };
  });
}
