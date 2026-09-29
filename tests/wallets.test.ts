// Wallets overview: the pure aggregation every owner-facing figure comes from. Draft vs approved,
// reversals, by-hand settlement, ledger fallback when Stripe can't be asked, live balance precedence.
import { describe, expect, it } from "vitest";
import { buildWalletRows, walletTotals, walletsCsv, type WalletsSummary } from "../src/server/wallets";
import type { ConnectedAccount } from "../src/server/payouts";

const acct = (o: Partial<ConnectedAccount>): ConnectedAccount => ({
  id: "acct_1", shop_id: "shop", owner_type: "STAFF", owner_id: "s1", email: "a@b.c", details_submitted: 1, charges_enabled: 1, payouts_enabled: 1,
  requirements_json: "{}", payout_schedule: "weekly", disabled_reason: "", created_at: 0, updated_at: 0, ...o,
});
const staff = [
  { id: "s1", name: "Ali", role: "BARBER", active: 1 },
  { id: "s2", name: "Ben", role: "BARBER", active: 1 },
];
const shop = { id: "shop", name: "Northline" };
const base = { from: "2026-09-01", to: "2026-09-30", staff, shop, accounts: [] as ConnectedAccount[], runs: [], transfers: [], payouts: [], balances: {}, stripeReachable: false };
const t = (ms: number) => Date.parse("2026-09-10T00:00:00Z") + ms;

describe("buildWalletRows", () => {
  it("draft runs are awaiting approval, approved/transferred/paid runs are earned, void is ignored", () => {
    const { rows } = buildWalletRows({
      ...base,
      runs: [
        { staff_id: "s1", status: "DRAFT", net_pence: 10000, transfer_pence: null, cash_residual_pence: null, paid_method: null, period_to: "2026-09-07" },
        { staff_id: "s1", status: "APPROVED", net_pence: 20000, transfer_pence: 15000, cash_residual_pence: 5000, paid_method: null, period_to: "2026-09-14" },
        { staff_id: "s1", status: "VOID", net_pence: 99999, transfer_pence: null, cash_residual_pence: null, paid_method: null, period_to: "2026-09-21" },
        { staff_id: "s2", status: "TRANSFERRED", net_pence: 30000, transfer_pence: 30000, cash_residual_pence: 0, paid_method: null, period_to: "2026-09-14" },
      ],
    });
    const ali = rows.find((r) => r.owner_id === "s1")!;
    expect(ali.awaiting_approval_pence).toBe(10000);
    expect(ali.earned_pence).toBe(20000);
    expect(ali.settled_by_hand_pence).toBe(0); // not PAID yet
    expect(rows.find((r) => r.owner_id === "s2")!.earned_pence).toBe(30000);
  });

  it("marks cash residual settled by hand only once the run is PAID by a non-Stripe method", () => {
    const run = { staff_id: "s1", status: "PAID", net_pence: 20000, transfer_pence: 15000, cash_residual_pence: 5000, paid_method: "CASH", period_to: "2026-09-14" };
    expect(buildWalletRows({ ...base, runs: [run] }).rows[0].settled_by_hand_pence).toBe(5000);
    expect(buildWalletRows({ ...base, runs: [{ ...run, paid_method: "STRIPE" }] }).rows[0].settled_by_hand_pence).toBe(0);
    // Older runs without a stored residual fall back to net minus what was transferred.
    expect(buildWalletRows({ ...base, runs: [{ ...run, cash_residual_pence: null }] }).rows[0].settled_by_hand_pence).toBe(5000);
  });

  it("nets reversals off transfers and tracks the latest transfer time", () => {
    const { rows, shop: shopRow } = buildWalletRows({
      ...base,
      transfers: [
        { owner_type: "STAFF", owner_id: "s1", kind: "PAYOUT", amount_pence: 15000, created_at: t(0) },
        { owner_type: "STAFF", owner_id: "s1", kind: "REVERSAL", amount_pence: 2000, created_at: t(1000) },
        { owner_type: "SHOP", owner_id: "shop", kind: "PAYOUT", amount_pence: 40000, created_at: t(0) },
      ],
    });
    expect(rows[0].transferred_pence).toBe(13000);
    expect(rows[0].last_transfer_at).toBe(t(1000));
    expect(shopRow.transferred_pence).toBe(40000);
    expect(shopRow.owner_type).toBe("SHOP");
  });

  it("without a wallet the row says so and the balance is zero from records", () => {
    const { rows } = buildWalletRows(base);
    expect(rows[0].state.key).toBe("none");
    expect(rows[0].balance).toEqual({ available_pence: 0, pending_pence: 0, live: false, note: "No wallet yet" });
  });

  it("ledger fallback = moved in − reached bank − in transit, never negative, and explains why", () => {
    const a = acct({});
    const input = {
      ...base, accounts: [a],
      transfers: [{ owner_type: "STAFF" as const, owner_id: "s1", kind: "PAYOUT", amount_pence: 15000, created_at: t(0) }],
      payouts: [
        { account_id: "acct_1", amount_pence: 6000, status: "paid", arrival_date: "2026-09-12", created_at: t(2000) },
        { account_id: "acct_1", amount_pence: 4000, status: "in_transit", arrival_date: "2026-09-15", created_at: t(3000) },
        { account_id: "acct_1", amount_pence: 1000, status: "failed", arrival_date: "2026-09-15", created_at: t(500) },
      ],
    };
    const r = buildWalletRows({ ...input, stripeReachable: false }).rows[0];
    expect(r.paid_out_pence).toBe(6000);
    expect(r.in_transit_pence).toBe(4000);
    expect(r.balance).toEqual({ available_pence: 5000, pending_pence: 0, live: false, note: "From our records — Stripe not reachable" });
    expect(r.last_payout?.status).toBe("in_transit");
    expect(buildWalletRows({ ...input, stripeReachable: true }).rows[0].balance).toMatchObject({ live: false, note: "From our records" });
    // Over-paid-out (e.g. earlier periods) clamps at zero rather than showing a negative wallet.
    expect(buildWalletRows({ ...input, transfers: [] }).rows[0].balance.available_pence).toBe(0);
  });

  it("a live Stripe balance wins over the ledger and is flagged live", () => {
    const r = buildWalletRows({ ...base, accounts: [acct({})], balances: { acct_1: { available_pence: 12345, pending_pence: 678 } }, stripeReachable: true }).rows[0];
    expect(r.balance).toEqual({ available_pence: 12345, pending_pence: 678, live: true });
    expect(r.state.key).toBe("active");
    expect(r.account?.payout_schedule).toBe("weekly");
  });

  it("only counts payouts for the matching account", () => {
    const rows = buildWalletRows({
      ...base, accounts: [acct({}), acct({ id: "acct_2", owner_id: "s2" })],
      payouts: [{ account_id: "acct_2", amount_pence: 7000, status: "paid", arrival_date: "2026-09-12", created_at: t(0) }],
    }).rows;
    expect(rows[0].paid_out_pence).toBe(0);
    expect(rows[1].paid_out_pence).toBe(7000);
  });
});

describe("walletTotals / walletsCsv", () => {
  const built = buildWalletRows({
    ...base, accounts: [acct({})],
    runs: [{ staff_id: "s1", status: "DRAFT", net_pence: 1000, transfer_pence: null, cash_residual_pence: null, paid_method: null, period_to: "2026-09-07" }],
    balances: { acct_1: { available_pence: 500, pending_pence: 250 } }, stripeReachable: true,
  });
  const summary: WalletsSummary = { from: base.from, to: base.to, stripe: { live: true, connect: true }, rows: built.rows, shop: built.shop, totals: walletTotals(built.rows) };

  it("totals sum barbers only (the shop row is shown separately)", () => {
    expect(summary.totals.in_wallets_pence).toBe(750);
    expect(summary.totals.awaiting_approval_pence).toBe(1000);
  });

  it("csv has one line per barber plus the shop, pounds with two decimals, and a balance source column", () => {
    const lines = walletsCsv(summary).split("\n");
    expect(lines).toHaveLength(1 + 2 + 1);
    expect(lines[0].split(",")).toContain("balance_source");
    const ali = lines[1].split(",");
    expect(ali[0]).toBe("Ali");
    expect(ali[7]).toBe("5.00");
    expect(ali[8]).toBe("2.50");
    expect(ali[9]).toBe("stripe");
    expect(lines[3].startsWith("Northline,Shop,")).toBe(true);
  });

  it("escapes names containing commas or quotes", () => {
    const b = buildWalletRows({ ...base, staff: [{ id: "s9", name: 'Smith, "Jay"', role: "BARBER", active: 1 }] });
    const csv = walletsCsv({ ...summary, rows: b.rows, shop: null });
    expect(csv.split("\n")[1].startsWith('"Smith, ""Jay""",BARBER,')).toBe(true);
  });
});
