// Wallets (owner/manager): where every barber's money is for the selected pay period. One row per
// barber plus the shop's own wallet. Ledger figures always render; live Stripe balances are marked
// so the owner can tell a live number from a snapshot.
import { useEffect, useState } from "react";
import type { WalletRow, WalletsSummary } from "../server/wallets";
import { Button, Icon, Notice, StatusPill } from "./ui";
import { money } from "./fixtures";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const stateTone = (k: WalletRow["state"]["key"]) => (k === "active" ? "good" : k === "none" ? "note" : k === "onboarding" ? "next" : "warn");
const when = (ms: number) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(ms));
const onDate = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(d + "T12:00:00Z"));
const payoutWord: Record<string, string> = { paid: "reached bank", in_transit: "on its way", pending: "queued", failed: "failed", canceled: "cancelled" };

export function WalletsPanel({ api, from, to, onOpenBarber }: { api: Api; from: string; to: string; onOpenBarber?: (staffId: string) => void }) {
  const [s, setS] = useState<WalletsSummary | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = (fresh = false) => {
    setBusy(true); setErr("");
    return api<WalletsSummary>(`/wallets?from=${from}&to=${to}${fresh ? "&fresh=1" : ""}`).then(setS).catch((e) => setErr(e instanceof Error ? e.message : "Could not load wallets")).finally(() => setBusy(false));
  };
  useEffect(() => { setS(null); void load(); }, [from, to]);
  const rows = s?.rows ?? [];
  const liveCount = rows.filter((r) => r.balance.live).length + (s?.shop?.balance.live ? 1 : 0);
  const anyWallet = rows.some((r) => r.account) || !!s?.shop?.account;
  return (
    <section className="wallets" data-testid="wallets" aria-labelledby="wallets-heading">
      <div className="wallets-head">
        <div>
          <h3 id="wallets-heading"><Icon name="wallet" size={16} /> Wallets</h3>
          <p className="workspace-footnote">Where each barber's money is for {onDate(from)} – {onDate(to)}. Approving a pay run moves the card share into their wallet; Stripe pays it to their bank on their schedule.</p>
        </div>
        <div className="wallets-actions">
          {s && <small className="muted" data-testid="wallets-source">{!s.stripe.live ? "Stripe in test mode — balances from our records" : !s.stripe.connect ? "Barber payouts off — balances from our records" : liveCount ? `${liveCount} live balance${liveCount === 1 ? "" : "s"} from Stripe` : "Balances from our records"}</small>}
          <Button variant="ghost" className="icon-only" aria-label="Refresh wallets" disabled={busy} onClick={() => void load(true)}><Icon name="refresh" /></Button>
          <a className="button ghost" href={`/api/app/wallets.csv?from=${from}&to=${to}`} download data-testid="wallets-csv"><Icon name="download" size={14} /> CSV</a>
        </div>
      </div>
      {err && <Notice tone="warn">{err}</Notice>}
      {!s && !err ? <p className="workspace-footnote">Loading wallets…</p> : s && (
        <>
          <div className="kpi-grid wallets-kpis" data-testid="wallets-totals">
            <div className="kpi"><small><Icon name="wallet" size={12} /> In barber wallets now</small><b data-testid="wallets-in-wallets">{money(s.totals.in_wallets_pence)}</b><span className="kpi-delta muted">{s.totals.in_transit_pence ? `${money(s.totals.in_transit_pence)} on its way to banks` : "nothing in transit"}</span></div>
            <div className="kpi"><small><Icon name="send" size={12} /> Moved to wallets this period</small><b>{money(s.totals.transferred_pence)}</b><span className="kpi-delta muted">{s.totals.settled_by_hand_pence ? `${money(s.totals.settled_by_hand_pence)} settled by hand` : "all via Stripe"}</span></div>
            <div className="kpi"><small><Icon name="landmark" size={12} /> Reached their banks</small><b>{money(s.totals.paid_out_pence)}</b><span className="kpi-delta muted">Stripe payouts marked paid</span></div>
            <div className="kpi"><small><Icon name="hourglass" size={12} /> Awaiting your approval</small><b data-testid="wallets-awaiting">{money(s.totals.awaiting_approval_pence)}</b><span className="kpi-delta muted">draft pay runs in this period</span></div>
          </div>
          {!anyWallet && <Notice>No barber has a payout wallet yet. Connect them from Settings › Payments › Barber payouts; until then approved pay is settled by hand.</Notice>}
          {rows.length === 0 ? <Notice>No barbers yet.</Notice> : (
            <div className="pay-runs-table-wrap wallets-table-wrap"><table className="pay-runs-table wallets-table" data-testid="wallets-table">
              <thead><tr><th>Barber</th><th>Wallet</th><th className="num">Earned</th><th className="num">Moved to wallet</th><th className="num">In wallet</th><th className="num">In transit</th><th className="num">Reached bank</th><th>Last payout</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => <Row key={r.owner_id} r={r} onOpen={onOpenBarber ? () => onOpenBarber(r.owner_id) : undefined} />)}
                {s.shop && <Row r={s.shop} shop />}
              </tbody>
              <tfoot><tr><td colSpan={2}><strong>Barbers total</strong></td><td className="num">{money(s.totals.earned_pence)}</td><td className="num">{money(s.totals.transferred_pence)}</td><td className="num">{money(s.totals.in_wallets_pence)}</td><td className="num">{money(s.totals.in_transit_pence)}</td><td className="num">{money(s.totals.paid_out_pence)}</td><td colSpan={2} /></tr></tfoot>
            </table></div>
          )}
          <p className="workspace-footnote">"In wallet" is the Stripe balance a barber can pay out (available) plus card money still clearing (pending). Rows marked <em>records</em> use our ledger — what you've moved in, less what Stripe reported paid — because Stripe wasn't asked or didn't answer. Draft runs are shown as awaiting approval and aren't in anyone's wallet yet.</p>
        </>
      )}
    </section>
  );
}

function Row({ r, shop, onOpen }: { r: WalletRow; shop?: boolean; onOpen?: () => void }) {
  const b = r.balance;
  return (
    <tr className={`${r.active ? "" : "quiet"} ${shop ? "wallets-shop-row" : ""}`} data-testid={shop ? "wallets-shop-row" : "wallets-row"} data-owner={r.owner_id}>
      <td><strong>{r.name}</strong><br /><small className="muted">{shop ? "Shop wallet" : r.role.toLowerCase()}{!r.active ? " · inactive" : ""}</small></td>
      <td><StatusPill tone={stateTone(r.state.key)}>{r.state.label}</StatusPill>{r.account && <><br /><small className="muted">{r.account.payout_schedule} payouts</small></>}</td>
      <td className="num">{shop ? "—" : money(r.earned_pence)}{!shop && r.awaiting_approval_pence > 0 && <><br /><small className="muted">+ {money(r.awaiting_approval_pence)} awaiting</small></>}</td>
      <td className="num">{money(r.transferred_pence)}{r.settled_by_hand_pence > 0 && <><br /><small className="muted">{money(r.settled_by_hand_pence)} by hand</small></>}</td>
      <td className="num">
        <span data-testid="wallets-balance">{money(b.available_pence + b.pending_pence)}</span>
        <br /><small className={b.live ? "wallets-live" : "muted"} title={b.live ? "Live from Stripe" : b.note}>{b.live ? (b.pending_pence ? `${money(b.pending_pence)} clearing · live` : "live") : "records"}</small>
      </td>
      <td className="num">{r.in_transit_pence ? money(r.in_transit_pence) : "—"}</td>
      <td className="num">{r.paid_out_pence ? money(r.paid_out_pence) : "—"}</td>
      <td>{r.last_payout ? <>{money(r.last_payout.amount_pence)}<br /><small className="muted">{payoutWord[r.last_payout.status] ?? r.last_payout.status}{r.last_payout.arrival_date ? ` · ${onDate(r.last_payout.arrival_date)}` : ""}</small></> : r.last_transfer_at ? <small className="muted">moved {when(r.last_transfer_at)} · no payout yet</small> : <small className="muted">—</small>}</td>
      <td>{onOpen && <Button variant="secondary" onClick={onOpen}>Open</Button>}</td>
    </tr>
  );
}
