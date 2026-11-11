// Wallet (v2). One rule everywhere: "owed" is only what landed in the shop's account (card reader /
// online card) less the card reader fee and chair rent. Cash, bank transfers and other hand payments are
// already with the barber, so they are shown as "kept" and never added to what is owed.
//   WalletPage      the full wallet: every barber, what is owed now, and every pay window they were paid for
//   BarberWallet    one barber's open wallet with Mark paid (also used on Pay runs and My pay)
//   PaidHistory     one barber's paid windows, each with its tally, days and payments
import { useEffect, useState } from "react";
import type { WorkspaceData } from "../server/domain";
import type { DayMoney, OpenWallet, PaidWindow, PeriodMoney, Tally, WalletPayment } from "../server/walletDays";
import { Button, Icon, StatusPill } from "./ui";
import { METHODS } from "./Checkout";
import { currencySymbol, money, time } from "./fixtures";
import { WalletDays } from "./WalletDays";

export type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export type OpenResp = {
  today: string; to: string; card_reader_fee_bps: number;
  totals: { owed: number; owed_to_shop: number; taken: number; card: number; kept: number; visits: number };
  wallets: OpenWallet[];
};

const fmt = (opts: Intl.DateTimeFormatOptions) => (d: string) => new Intl.DateTimeFormat("en-GB", opts).format(new Date(d + "T12:00:00Z"));
export const longDay = fmt({ weekday: "short", day: "numeric", month: "short" });
export const shortDay = fmt({ day: "numeric", month: "short" });
export const rangeText = (from: string, to: string) => (from === to ? longDay(from) : `${shortDay(from)} – ${shortDay(to)}`);
export const stampDay = (ms: number) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date(ms));
export const compact = (p: number) => `${p < 0 ? "−" : ""}${currencySymbol()}${Math.round(Math.abs(p) / 100)}`;
const firstName = (n: string) => n.split(" ")[0];
export const keptOf = (t: Pick<Tally, "cash" | "transfer" | "other">) => t.cash + t.transfer + t.other;
const PAID_BY: Record<string, string> = { BANK: "bank transfer", CASH: "cash", OTHER: "other", STRIPE: "Stripe" };
export const methodOf = (p: Pick<WalletPayment, "method" | "service_pence" | "tip_pence">) =>
  p.service_pence === 0 && p.tip_pence === 0 ? "£0 visit" : METHODS.find((m) => m.key === p.method)?.label ?? p.method;

export function owedText(owed: number, name: string, self?: boolean) {
  if (owed > 0) return self ? `The shop owes you ${money(owed)}` : `Shop owes ${firstName(name)} ${money(owed)}`;
  if (owed < 0) return self ? `You owe the shop ${money(-owed)}` : `${firstName(name)} owes the shop ${money(-owed)}`;
  return "Nothing owed either way";
}

// What was taken, by how it was paid. Kept = already with the barber.
export function TakenSplit({ t }: { t: Tally }) {
  return (
    <dl className="wallet-split" data-testid="wallet-split">
      <div className="total"><dt>Taken</dt><dd data-testid="ws-taken">{money(t.taken)}</dd></div>
      <div><dt><Icon name="card" size={13} /> Card reader</dt><dd data-testid="ws-reader">{money(t.reader)}</dd></div>
      {t.online > 0 && <div><dt><Icon name="globe" size={13} /> Card online</dt><dd data-testid="ws-online">{money(t.online)}</dd></div>}
      <div className="kept"><dt><Icon name="banknote" size={13} /> Cash <small>kept</small></dt><dd data-testid="ws-cash">{money(t.cash)}</dd></div>
      <div className="kept"><dt><Icon name="landmark" size={13} /> Transfer <small>kept</small></dt><dd data-testid="ws-transfer">{money(t.transfer)}</dd></div>
      {t.other > 0 && <div className="kept"><dt><Icon name="receipt" size={13} /> Other <small>kept</small></dt><dd>{money(t.other)}</dd></div>}
      <div className="muted-row"><dt>Visits</dt><dd data-testid="ws-visits">{t.visits}{t.zero_visits ? ` · ${t.zero_visits} at £0` : ""}</dd></div>
    </dl>
  );
}

type Calc = Pick<PeriodMoney, "reader" | "online" | "share" | "tip_share" | "owed"> & { pay_model: string; deductions: { label: string; pence: number; detail: string }[]; adjustments?: { label: string; pence: number }[] };
// How the owed figure is reached, line by line.
export function OwedCalc({ m, name, self, final = "owed" }: { m: Calc; name: string; self?: boolean; final?: "owed" | "paid" }) {
  const card = m.reader + m.online;
  const ded = m.deductions.reduce((n, d) => n + d.pence, 0);
  const adj = (m.adjustments ?? []).reduce((n, a) => n + a.pence, 0);
  const rent = m.pay_model === "CHAIR_RENT";
  const delta = rent ? m.owed - (card - ded + adj) : 0;
  const who = self ? "you" : firstName(name);
  return (
    <dl className="wallet-calc" data-testid="wallet-calc">
      {rent ? (
        <div><dt>Card · in the shop's account</dt><dd>{money(card)}</dd></div>
      ) : (
        <>
          <div><dt>{m.pay_model === "COMMISSION" || m.pay_model === "HYBRID" ? "Commission" : "Pay"}</dt><dd>{money(m.share)}</dd></div>
          {m.tip_share > 0 && <div><dt>Tips</dt><dd>+ {money(m.tip_share)}</dd></div>}
        </>
      )}
      {m.deductions.map((d, i) => <div key={i}><dt>{d.label}<small> · {d.detail}</small></dt><dd>− {money(d.pence)}</dd></div>)}
      {(m.adjustments ?? []).filter((a) => a.pence).map((a, i) => <div key={"a" + i}><dt>{a.label}</dt><dd>{a.pence < 0 ? "−" : "+"} {money(Math.abs(a.pence))}</dd></div>)}
      {delta !== 0 && <div><dt>Tips share</dt><dd>{delta < 0 ? "−" : "+"} {money(Math.abs(delta))}</dd></div>}
      <div className={`strong ${m.owed < 0 ? "neg" : ""}`}>
        <dt>{final === "paid" ? (m.owed < 0 ? `${self ? "You" : firstName(name)} paid the shop` : `Paid to ${who}`) : m.owed < 0 ? `${self ? "You owe" : `${firstName(name)} owes`} the shop` : `Owed to ${who}`}</dt>
        <dd data-testid="wc-owed">{money(Math.abs(m.owed))}</dd>
      </div>
    </dl>
  );
}

export function DaysTable({ days }: { days: (Pick<DayMoney, "date" | "taken" | "reader" | "online" | "cash" | "transfer" | "other" | "visits" | "zero_visits"> & { fee?: number; rent?: number; owed?: number })[] }) {
  const owedCol = days.some((d) => d.owed != null);
  return (
    <div className="wallet-table-wrap"><table className="wallet-days" data-testid="wallet-days-table">
      <thead><tr><th>Day</th><th className="num">Taken</th><th className="num">Card</th><th className="num">Kept</th>{owedCol && <><th className="num">Fee</th><th className="num">Rent</th><th className="num">Owed</th></>}</tr></thead>
      <tbody>
        {days.map((d) => (
          <tr key={d.date}>
            <td>{longDay(d.date)}<small>{d.visits} visit{d.visits === 1 ? "" : "s"}{d.zero_visits ? ` · ${d.zero_visits} £0` : ""}</small></td>
            <td className="num">{money(d.taken)}</td>
            <td className="num">{money(d.reader + d.online)}</td>
            <td className="num">{money(keptOf(d))}</td>
            {owedCol && <><td className="num">{d.fee ? `− ${money(d.fee)}` : "—"}</td><td className="num">{d.rent ? `− ${money(d.rent)}` : "—"}</td><td className={`num strong ${(d.owed ?? 0) < 0 ? "neg" : ""}`}>{money(d.owed ?? 0)}</td></>}
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

export function PaymentRows({ rows, onOpenBooking, showDate }: { rows: WalletPayment[]; onOpenBooking?: (id: string) => void; showDate?: boolean }) {
  return (
    <ul className="wallet-payments" data-testid="wallet-payments">
      {rows.map((p) => {
        const kept = !["READER", "ONLINE"].includes(p.method) && !(p.method === "CARD");
        const inner = (
          <>
            <span className="wp-when">{showDate ? `${shortDay(p.date)} · ` : ""}{time(p.start_min)}</span>
            <span className="wp-who"><b>{p.customer_name}</b><small>{p.service_name}{p.visit_date !== p.date ? ` · visit ${shortDay(p.visit_date)}` : ""}</small></span>
            <span className={`wp-method ${kept && p.service_pence + p.tip_pence > 0 ? "kept" : ""}`}>{methodOf(p)}</span>
            <span className="wp-amount">{money(p.service_pence)}{p.tip_pence > 0 && <small>+{money(p.tip_pence)} tip</small>}</span>
          </>
        );
        return <li key={p.id}>{onOpenBooking ? <button type="button" onClick={() => onOpenBooking(p.booking_id)}>{inner}</button> : <div>{inner}</div>}</li>;
      })}
    </ul>
  );
}

// ---- One barber's open wallet, with Mark paid --------------------------------------------------------
export function BarberWallet({ wallet, api, today, canSettle, self, onPaid, onOpenBooking }: { wallet: OpenWallet; api: Api; today: string; canSettle: boolean; self?: boolean; onPaid?: () => void; onOpenBooking?: (id: string) => void }) {
  const [view, setView] = useState(wallet);
  const [to, setTo] = useState(wallet.to);
  const [method, setMethod] = useState<"BANK" | "CASH" | "OTHER">("BANK");
  const [reference, setReference] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setView(wallet); setTo(wallet.to); setConfirming(false); setErr(""); }, [wallet]);
  async function changeTo(d: string) {
    if (!d || d < wallet.from || d > today) return;
    setTo(d); setConfirming(false); setErr("");
    try {
      const r = await api<OpenResp>(`/wallet/open?to=${d}`);
      const x = r.wallets.find((y) => y.staff_id === wallet.staff_id);
      if (x) setView(x);
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not load that day"); }
  }
  async function settle() {
    setBusy(true); setErr("");
    try {
      await api("/wallet/settle", "POST", { staff_id: view.staff_id, to, paid_method: method, paid_reference: reference.trim(), expected_owed: view.period.owed });
      setConfirming(false); setReference("");
      onPaid?.();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not mark paid"); }
    finally { setBusy(false); }
  }
  const p = view.period;
  const who = self ? "you" : firstName(view.name);
  const nothing = view.empty || (!view.payments.length && !p.rent && !(p.adjustments ?? []).length);
  return (
    <section className="wallet-open" data-testid="wallet-open" data-staff={view.staff_id}>
      <header className="wallet-open-head">
        <div>
          <small>Not paid yet</small>
          <strong data-testid="wallet-open-range">{nothing ? "Nothing waiting" : rangeText(view.from, view.to)}</strong>
        </div>
        <b className={`wallet-open-amount ${p.owed < 0 ? "neg" : ""}`} data-testid="wallet-open-owed">{money(Math.abs(p.owed))}</b>
      </header>
      <p className={`wallet-owed-line ${p.owed < 0 ? "owes-shop" : p.owed > 0 ? "owed" : ""}`} data-testid="wb-owed">{nothing ? (self ? "You're paid up." : `${firstName(view.name)} is paid up.`) : owedText(p.owed, view.name, self)}</p>
      <p className="wallet-last-paid" data-testid="wallet-last-paid">
        {view.last_paid
          ? <>Last paid {stampDay(view.last_paid.paid_at)}: <b>{money(Math.abs(view.last_paid.amount_pence))}</b> for {rangeText(view.last_paid.period_from, view.last_paid.period_to)}{view.last_paid.paid_method ? ` · ${PAID_BY[view.last_paid.paid_method] ?? view.last_paid.paid_method.toLowerCase()}` : ""}</>
          : "Not paid through the wallet yet."}
      </p>
      {!nothing && (
        <>
          <TakenSplit t={p} />
          <OwedCalc m={{ ...p, pay_model: view.pay_model }} name={view.name} self={self} />
          {view.unsettled_runs.length > 0 && (
            <p className="wallet-note" data-testid="wallet-unsettled">
              <Icon name="info" size={13} /> {view.unsettled_runs.length} older pay run{view.unsettled_runs.length === 1 ? " was" : "s were"} made but never marked paid ({view.unsettled_runs.map((r) => rangeText(r.period_from, r.period_to)).join(", ")}). That money is included here{canSettle ? "; marking paid replaces " + (view.unsettled_runs.length === 1 ? "it" : "them") : ""}.
            </p>
          )}
          {canSettle && (
            <div className="wallet-settle" data-testid="wallet-settle">
              <div className="wallet-settle-row">
                <label><span>Paid up to</span><input type="date" value={to} min={wallet.from} max={today} onChange={(e) => void changeTo(e.target.value)} data-testid="settle-to" /></label>
                <label><span>How</span>
                  <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} data-testid="settle-how">
                    <option value="BANK">Bank transfer</option><option value="CASH">Cash</option><option value="OTHER">Other</option>
                  </select>
                </label>
                <label className="grow"><span>Reference (optional)</span><input value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} placeholder="e.g. Revolut ref" /></label>
              </div>
              {!confirming ? (
                <Button disabled={busy} onClick={() => setConfirming(true)} data-testid="wallet-mark-paid">
                  <Icon name="paid" size={16} /> {p.owed < 0 ? `Mark settled · ${firstName(view.name)} paid ${money(-p.owed)}` : `Mark paid · ${money(p.owed)}`}
                </Button>
              ) : (
                <div className="wallet-confirm" role="alertdialog" aria-label="Confirm payment" data-testid="wallet-confirm">
                  <p>{p.owed < 0 ? `${firstName(view.name)} paid the shop ${money(-p.owed)}` : `Pay ${who} ${money(p.owed)}`} for {rangeText(view.from, to)} by {PAID_BY[method]}? {self ? "Your" : `${firstName(view.name)}'s`} wallet goes back to £0 and this goes into the paid history.</p>
                  <div className="wallet-confirm-acts">
                    <Button disabled={busy} onClick={() => void settle()} data-testid="wallet-confirm-paid">{busy ? "Saving…" : "Yes, mark paid"}</Button>
                    <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {err && <p className="workspace-error" role="alert">{err}</p>}
          {view.days.length > 0 && (
            <details className="wallet-more" open={view.days.length <= 7}>
              <summary>Day by day · {view.days.length} day{view.days.length === 1 ? "" : "s"}</summary>
              <DaysTable days={view.days} />
            </details>
          )}
          {view.payments.length > 0 && (
            <details className="wallet-more">
              <summary>Every payment · {view.payments.length}</summary>
              <PaymentRows rows={view.payments} onOpenBooking={onOpenBooking} showDate={view.from !== view.to} />
            </details>
          )}
        </>
      )}
    </section>
  );
}

// ---- Paid windows ---------------------------------------------------------------------------------------
export function PaidHistory({ staffId, name, api, reloadKey, self, onOpenBooking }: { staffId: string; name: string; api: Api; reloadKey?: unknown; self?: boolean; onOpenBooking?: (id: string) => void }) {
  const [windows, setWindows] = useState<PaidWindow[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let off = false;
    setWindows(null); setErr("");
    api<{ windows: PaidWindow[] }>(`/wallet/history?staff_id=${staffId}`).then((r) => !off && setWindows(r.windows)).catch((e) => !off && setErr(e instanceof Error ? e.message : "Could not load"));
    return () => { off = true; };
  }, [staffId, reloadKey]);
  const total = (windows ?? []).reduce((n, x) => n + x.amount_pence, 0);
  return (
    <section className="wallet-history" data-testid="wallet-history">
      <h3>Paid <small className="muted">{windows ? `· ${windows.length} pay window${windows.length === 1 ? "" : "s"}${windows.length ? ` · ${money(total)} in total` : ""}` : ""}</small></h3>
      {err && <p className="workspace-error">{err}</p>}
      {!windows && !err && <p className="workspace-footnote">Loading…</p>}
      {windows && windows.length === 0 && <p className="muted">{self ? "You haven't" : `${firstName(name)} hasn't`} been marked paid yet. Each payment will be listed here with what it covered.</p>}
      {windows?.map((x) => (
        <details key={x.id} className="wallet-window" data-testid="wallet-window">
          <summary>
            <span className="ww-range"><b>{rangeText(x.period_from, x.period_to)}</b><small>Paid {stampDay(x.paid_at)}{x.paid_method ? ` · ${PAID_BY[x.paid_method] ?? x.paid_method.toLowerCase()}` : ""}{x.paid_reference ? ` · ${x.paid_reference}` : ""}</small></span>
            <span className="ww-taken"><small>Taken</small>{money(x.tally.taken)}</span>
            <span className={`ww-paid ${x.amount_pence < 0 ? "neg" : ""}`}><small>{x.amount_pence < 0 ? "Paid shop" : "Paid"}</small><b data-testid="ww-paid">{money(Math.abs(x.amount_pence))}</b></span>
          </summary>
          <TakenSplit t={x.tally} />
          <OwedCalc m={{ pay_model: x.pay_model, reader: x.tally.reader, online: x.tally.online, share: x.pay_model === "CHAIR_RENT" ? x.tally.service : x.net_pence, tip_share: 0, owed: x.amount_pence, deductions: x.deductions, adjustments: x.adjustments }} name={name} self={self} final="paid" />
          {x.days.length > 0 && <DaysTable days={x.days} />}
          {x.payments.length > 0 && <PaymentRows rows={x.payments} onOpenBooking={onOpenBooking} showDate />}
        </details>
      ))}
    </section>
  );
}

// ---- Full wallet screen -------------------------------------------------------------------------------
export function WalletPage({ w, api, canSettle, initialStaff, onPaid, onOpenBooking, embedded }: { w: WorkspaceData; api: Api; canSettle: boolean; initialStaff?: string | null; onPaid?: () => void; onOpenBooking?: (id: string) => void; embedded?: boolean }) {
  const [data, setData] = useState<OpenResp | null>(null);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string | null>(initialStaff ?? null);
  const [paidKey, setPaidKey] = useState(0);
  const [notice, setNotice] = useState("");
  const load = () => api<OpenResp>("/wallet/open").then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e instanceof Error ? e.message : "Could not load the wallet"));
  useEffect(() => { void load(); }, [w.payments.length]);
  useEffect(() => { if (initialStaff) setSel(initialStaff); }, [initialStaff]);
  const wallets = data?.wallets ?? [];
  const self = !!w.account && w.account.role !== "OWNER" && !(w.account.perms as Record<string, boolean> | undefined)?.pay;
  const current = wallets.find((x) => x.staff_id === sel) ?? wallets.find((x) => !x.empty) ?? wallets[0] ?? null;
  return (
    <section className={`wallet-page ${embedded ? "embedded" : ""}`} data-testid="wallet-page">
      {!embedded && (
        <header className="wallet-page-head">
          <div>
            <p className="muted">Owed is only card money that went into the shop's account, less the card reader fee and chair rent. Cash and transfers stay with the barber.</p>
          </div>
          {data && (
            <div className="wallet-page-total" data-testid="wallet-page-total">
              <small>{self ? "Owed to you" : "Owed to barbers"}</small><b>{money(data.totals.owed)}</b>
              <span>{money(data.totals.taken)} taken · {money(data.totals.card)} card · {money(data.totals.kept)} kept{data.totals.owed_to_shop ? ` · ${money(data.totals.owed_to_shop)} owed to the shop` : ""}</span>
            </div>
          )}
        </header>
      )}
      {err && <p className="workspace-error" role="alert">{err}</p>}
      {notice && <p className="workspace-footnote" role="status" data-testid="wallet-notice">{notice}</p>}
      {!data && !err && <p className="workspace-footnote">Loading…</p>}
      {!embedded && (
        <section className="wallet-open wallet-day-section" data-testid="wallet-day-section">
          <h3>Day by day <small className="muted">· what was taken and what it added to {self ? "your" : "each barber's"} wallet</small></h3>
          <WalletDays w={w} api={api} self={self} onOpenBooking={onOpenBooking} />
        </section>
      )}
      {data && wallets.length === 0 && <p className="muted">No barbers to show.</p>}
      {data && current && (
        <div className="wallet-page-grid">
          {wallets.length > 1 && (
            <nav className="wallet-barber-list" aria-label="Barbers" data-testid="wallet-barber-list">
              {wallets.map((x) => (
                <button key={x.staff_id} type="button" aria-pressed={x.staff_id === current.staff_id} onClick={() => setSel(x.staff_id)} data-testid="wallet-barber-pick" data-staff={x.staff_id}>
                  <span><b>{x.name}</b><small>{x.empty ? "Paid up" : `Since ${shortDay(x.from)} · ${money(x.period.taken)} taken`}</small></span>
                  <span className={`wbl-owed ${x.period.owed < 0 ? "neg" : ""}`}>{x.period.owed < 0 ? `owes ${money(-x.period.owed)}` : money(x.period.owed)}</span>
                </button>
              ))}
            </nav>
          )}
          <div className="wallet-page-detail">
            <BarberWallet
              wallet={current}
              api={api}
              today={data.today}
              canSettle={canSettle}
              self={self}
              onOpenBooking={onOpenBooking}
              onPaid={() => { setNotice(`${firstName(current.name)} marked paid. The wallet is back to £0 and the payment is in the paid history.`); setPaidKey((k) => k + 1); void load(); onPaid?.(); }}
            />
            <PaidHistory staffId={current.staff_id} name={current.name} api={api} reloadKey={paidKey} self={self} onOpenBooking={onOpenBooking} />
          </div>
        </div>
      )}
    </section>
  );
}
