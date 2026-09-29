// Wallets overview for owners/managers: one row per barber (and one for the shop) showing where
// their money is — earned this period, moved to their Stripe wallet, sitting in the wallet now,
// on its way to the bank, and reached the bank. Figures come from our own ledger (transfers,
// payouts, pay_runs) so the page always renders; live Stripe balances are layered on top when
// Stripe is reachable and marked as such, so the owner can tell a snapshot from a live number.
import type { Database as DB } from "../db/client";
import type { Staff } from "./domain";
import { accountBalance, stripeConnect, stripeLive, type OwnerType } from "./stripe";
import { accountState, type ConnectedAccount } from "./payouts";

export type WalletRow = {
  owner_type: OwnerType;
  owner_id: string;
  name: string;
  role: string;
  active: number;
  account: { id: string; email: string; payout_schedule: string; payouts_enabled: number } | null;
  state: ReturnType<typeof accountState>;
  /** Owed to them by approved/paid pay runs in the period (net of deductions). */
  earned_pence: number;
  /** Runs in the period still in DRAFT — money not yet released. */
  awaiting_approval_pence: number;
  /** Net moved to their wallet in the period (transfers minus reversals). */
  transferred_pence: number;
  /** Cash/bank residual the shop settled by hand in the period (mark-paid runs). */
  settled_by_hand_pence: number;
  /** Reached their bank (Stripe payouts, status paid) in the period. */
  paid_out_pence: number;
  /** Stripe payouts pending / in transit right now. */
  in_transit_pence: number;
  /** Live wallet balance from Stripe (null when unavailable). */
  balance: { available_pence: number; pending_pence: number; live: true } | { available_pence: number; pending_pence: number; live: false; note: string };
  last_transfer_at: number | null;
  last_payout: { amount_pence: number; status: string; arrival_date: string; created_at: number } | null;
};
export type WalletsSummary = {
  from: string;
  to: string;
  stripe: { live: boolean; connect: boolean };
  rows: WalletRow[];
  shop: WalletRow | null;
  totals: { earned_pence: number; awaiting_approval_pence: number; transferred_pence: number; settled_by_hand_pence: number; paid_out_pence: number; in_transit_pence: number; in_wallets_pence: number };
};

type Ledger = { earned: number; awaiting: number; transferred: number; by_hand: number; paid_out: number; in_transit: number; last_transfer_at: number | null; last_payout: WalletRow["last_payout"] };

/**
 * Pure aggregation: takes already-fetched rows and produces one WalletRow per owner. Kept free of
 * DB and Stripe so the maths is unit-testable and the same for the owner's page and any export.
 */
export function buildWalletRows(input: {
  from: string;
  to: string;
  staff: Pick<Staff, "id" | "name" | "role" | "active">[];
  shop: { id: string; name: string };
  accounts: ConnectedAccount[];
  runs: { staff_id: string; status: string; net_pence: number; transfer_pence: number | null; cash_residual_pence: number | null; paid_method: string | null; period_to: string }[];
  transfers: { owner_type: OwnerType; owner_id: string; kind: string; amount_pence: number; created_at: number }[];
  payouts: { account_id: string; amount_pence: number; status: string; arrival_date: string; created_at: number }[];
  balances: Record<string, { available_pence: number; pending_pence: number } | undefined>;
  stripeReachable: boolean;
}): { rows: WalletRow[]; shop: WalletRow } {
  const acctOf = (t: OwnerType, id: string) => input.accounts.find((a) => a.owner_type === t && a.owner_id === id) ?? null;
  const ledgerFor = (t: OwnerType, id: string, acct: ConnectedAccount | null): Ledger => {
    const l: Ledger = { earned: 0, awaiting: 0, transferred: 0, by_hand: 0, paid_out: 0, in_transit: 0, last_transfer_at: null, last_payout: null };
    if (t === "STAFF") {
      for (const r of input.runs) {
        if (r.staff_id !== id || r.status === "VOID") continue;
        if (r.status === "DRAFT") l.awaiting += r.net_pence;
        else l.earned += r.net_pence;
        if (r.status === "PAID" && r.paid_method && r.paid_method !== "STRIPE") l.by_hand += Math.max(0, r.cash_residual_pence ?? 0) || Math.max(0, r.net_pence - (r.transfer_pence ?? 0));
      }
    }
    for (const tr of input.transfers) {
      if (tr.owner_type !== t || tr.owner_id !== id) continue;
      // PAYOUT rows are positive money in; REVERSAL rows are stored positive but take money back.
      l.transferred += tr.kind === "REVERSAL" ? -Math.abs(tr.amount_pence) : tr.amount_pence;
      if (!l.last_transfer_at || tr.created_at > l.last_transfer_at) l.last_transfer_at = tr.created_at;
    }
    if (acct) {
      for (const p of input.payouts) {
        if (p.account_id !== acct.id) continue;
        if (p.status === "paid") l.paid_out += p.amount_pence;
        else if (p.status === "pending" || p.status === "in_transit") l.in_transit += p.amount_pence;
        if (!l.last_payout || p.created_at > l.last_payout.created_at) l.last_payout = { amount_pence: p.amount_pence, status: p.status, arrival_date: p.arrival_date, created_at: p.created_at };
      }
    }
    return l;
  };
  const row = (t: OwnerType, id: string, name: string, role: string, active: number): WalletRow => {
    const acct = acctOf(t, id);
    const l = ledgerFor(t, id, acct);
    const live = acct ? input.balances[acct.id] : undefined;
    const balance: WalletRow["balance"] = live
      ? { ...live, live: true }
      : {
          // Ledger fallback: what we moved in, less what Stripe told us reached the bank / is in transit.
          available_pence: Math.max(0, l.transferred - l.paid_out - l.in_transit),
          pending_pence: 0,
          live: false,
          note: !acct ? "No wallet yet" : !input.stripeReachable ? "From our records — Stripe not reachable" : "From our records",
        };
    return {
      owner_type: t, owner_id: id, name, role, active,
      account: acct ? { id: acct.id, email: acct.email, payout_schedule: acct.payout_schedule, payouts_enabled: acct.payouts_enabled } : null,
      state: accountState(acct),
      earned_pence: l.earned, awaiting_approval_pence: l.awaiting, transferred_pence: l.transferred, settled_by_hand_pence: l.by_hand,
      paid_out_pence: l.paid_out, in_transit_pence: l.in_transit, balance, last_transfer_at: l.last_transfer_at, last_payout: l.last_payout,
    };
  };
  const rows = input.staff.map((s) => row("STAFF", s.id, s.name, s.role, s.active));
  const shop = row("SHOP", input.shop.id, input.shop.name, "Shop", 1);
  return { rows, shop };
}

export function walletTotals(rows: WalletRow[]): WalletsSummary["totals"] {
  const t = { earned_pence: 0, awaiting_approval_pence: 0, transferred_pence: 0, settled_by_hand_pence: 0, paid_out_pence: 0, in_transit_pence: 0, in_wallets_pence: 0 };
  for (const r of rows) {
    t.earned_pence += r.earned_pence; t.awaiting_approval_pence += r.awaiting_approval_pence; t.transferred_pence += r.transferred_pence;
    t.settled_by_hand_pence += r.settled_by_hand_pence; t.paid_out_pence += r.paid_out_pence; t.in_transit_pence += r.in_transit_pence;
    t.in_wallets_pence += r.balance.available_pence + r.balance.pending_pence;
  }
  return t;
}

// Live balances, best effort, in parallel, with a short cache so a page refresh doesn't hammer Stripe.
const balanceCache = new Map<string, { at: number; v: { available_pence: number; pending_pence: number } }>();
const BALANCE_TTL_MS = 60_000;
export async function liveBalances(accounts: ConnectedAccount[], opts: { fresh?: boolean } = {}): Promise<{ balances: Record<string, { available_pence: number; pending_pence: number } | undefined>; reachable: boolean }> {
  const balances: Record<string, { available_pence: number; pending_pence: number } | undefined> = {};
  if (!stripeLive() || !stripeConnect()) return { balances, reachable: false };
  let reachable = true;
  const now = Date.now();
  await Promise.all(
    accounts.filter((a) => a.details_submitted).map(async (a) => {
      const hit = balanceCache.get(a.id);
      if (!opts.fresh && hit && now - hit.at < BALANCE_TTL_MS) { balances[a.id] = hit.v; return; }
      try {
        const v = await accountBalance(a.id);
        balanceCache.set(a.id, { at: now, v });
        balances[a.id] = v;
      } catch {
        // Stripe down or account gone: fall back to the ledger for this row, but a stale cached
        // value is still better than nothing.
        reachable = false;
        if (hit) balances[a.id] = hit.v;
      }
    }),
  );
  return { balances, reachable };
}

export async function walletsSummary(db: DB, shop: { id: string; name: string }, from: string, to: string, opts: { fresh?: boolean } = {}): Promise<WalletsSummary> {
  const fromMs = Date.parse(from + "T00:00:00Z");
  const toMs = Date.parse(to + "T00:00:00Z") + 86400000;
  const [staff, accounts, runs, transfers] = await Promise.all([
    db.prepare("SELECT id,name,role,active FROM staff WHERE shop_id=? ORDER BY active DESC, sort_order, name").bind(shop.id).all<Pick<Staff, "id" | "name" | "role" | "active">>(),
    db.prepare("SELECT * FROM connected_accounts WHERE shop_id=?").bind(shop.id).all<ConnectedAccount>(),
    db.prepare("SELECT staff_id,status,net_pence,transfer_pence,cash_residual_pence,paid_method,period_to FROM pay_runs WHERE shop_id=? AND period_to BETWEEN ? AND ?").bind(shop.id, from, to).all<{ staff_id: string; status: string; net_pence: number; transfer_pence: number | null; cash_residual_pence: number | null; paid_method: string | null; period_to: string }>(),
    db.prepare("SELECT owner_type,owner_id,kind,amount_pence,created_at FROM transfers WHERE shop_id=? AND created_at BETWEEN ? AND ?").bind(shop.id, fromMs, toMs).all<{ owner_type: OwnerType; owner_id: string; kind: string; amount_pence: number; created_at: number }>(),
  ]);
  const acctIds = accounts.results.map((a) => a.id);
  const payouts = acctIds.length
    ? (await db.prepare(`SELECT account_id,amount_pence,status,arrival_date,created_at FROM payouts WHERE account_id IN (${acctIds.map(() => "?").join(",")}) AND created_at BETWEEN ? AND ?`).bind(...acctIds, fromMs, toMs).all<{ account_id: string; amount_pence: number; status: string; arrival_date: string; created_at: number }>()).results
    : [];
  const { balances, reachable } = await liveBalances(accounts.results, opts);
  const built = buildWalletRows({ from, to, staff: staff.results, shop, accounts: accounts.results, runs: runs.results, transfers: transfers.results, payouts, balances, stripeReachable: reachable });
  return { from, to, stripe: { live: stripeLive(), connect: stripeConnect() }, rows: built.rows, shop: built.shop, totals: walletTotals(built.rows) };
}

export function walletsCsv(s: WalletsSummary): string {
  const p = (n: number) => (n / 100).toFixed(2);
  const esc = (v: unknown) => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const lines = ["name,role,wallet_status,earned,awaiting_approval,moved_to_wallet,settled_by_hand,in_wallet_available,in_wallet_pending,balance_source,in_transit,reached_bank,payout_schedule"];
  for (const r of [...s.rows, ...(s.shop ? [s.shop] : [])]) {
    lines.push([r.name, r.role, r.state.label, p(r.earned_pence), p(r.awaiting_approval_pence), p(r.transferred_pence), p(r.settled_by_hand_pence), p(r.balance.available_pence), p(r.balance.pending_pence), r.balance.live ? "stripe" : "ledger", p(r.in_transit_pence), p(r.paid_out_pence), r.account?.payout_schedule ?? ""].map(esc).join(","));
  }
  return lines.join("\n");
}
