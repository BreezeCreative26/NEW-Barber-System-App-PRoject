// Checkout: record how a visit was paid at the chair. The wallet is a ledger, not a balance —
// nothing here moves money. Flow: amount (price − discount) → tip → method → record.
import { useEffect, useRef, useState } from "react";
import type { Payment, StoredBooking, WorkspaceData } from "../server/domain";
import { Button, Icon, StatusPill } from "./ui";
import { money, currencySymbol } from "./fixtures";

export type Tender = { method: Payment["method"]; service_pence: number; tip_pence: number };
export const METHODS: { key: Payment["method"]; label: string; icon: string; till?: boolean }[] = [
  { key: "CARD", label: "Card", icon: "card", till: true },
  { key: "CASH", label: "Cash", icon: "banknote", till: true },
  { key: "TRANSFER", label: "Transfer", icon: "landmark", till: true },
  { key: "VOUCHER", label: "Voucher", icon: "gift", till: true },
  // Deposits paid by card online at booking; posted to the ledger automatically, never tendered by hand.
  { key: "ONLINE", label: "Online deposit", icon: "globe" },
];
export const TILL_METHODS = METHODS.filter((m) => m.till);
const TIPS = [0, 200, 300, 500];

export function paidFor(payments: Payment[], bookingId: string) {
  const live = payments.filter((p) => p.booking_id === bookingId && !p.voided_at);
  return {
    service: live.reduce((n, p) => n + p.service_pence, 0),
    tips: live.reduce((n, p) => n + p.tip_pence, 0),
    discount: live.reduce((n, p) => n + p.discount_pence, 0),
    rows: live,
  };
}

export function Checkout({
  booking,
  w,
  payments,
  busy,
  onRecord,
  onCancel,
  api,
  onPaid,
  cardLive,
}: {
  booking: StoredBooking;
  w: WorkspaceData;
  payments: Payment[];
  busy: boolean;
  onRecord: (body: { version: number; discount_pence: number; note: string; tenders: Tender[]; complete: boolean }) => Promise<void>;
  onCancel: () => void;
  api?: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  onPaid?: () => Promise<void> | void;
  cardLive?: boolean;
}) {
  const paid = paidFor(payments, booking.id);
  // A card deposit paid at booking is posted to the ledger on first checkout; until then it shows
  // here as already paid so the amount due is right.
  const depositPosted = payments.some((p) => p.booking_id === booking.id && p.method === "ONLINE" && !p.voided_at);
  const depositCredit = booking.deposit_status === "PAID" && !depositPosted ? Math.min(booking.deposit_paid_pence ?? 0, booking.price_pence) : 0;
  const [discount, setDiscount] = useState(0);
  const [tip, setTip] = useState(0);
  const [customTip, setCustomTip] = useState("");
  const [method, setMethod] = useState<Payment["method"]>("CARD");
  const [split, setSplit] = useState<Tender[]>([]);
  const [note, setNote] = useState("");
  const [card, setCard] = useState(false);
  const due = Math.max(0, booking.price_pence - discount - paid.service - depositCredit);
  const splitPaid = split.reduce((n, t) => n + t.service_pence, 0);
  const remaining = due - splitPaid;
  const tipPence = customTip !== "" ? Math.max(0, Math.round(Number(customTip) * 100) || 0) : tip;
  const barber = w.staff.find((s) => s.id === booking.staff_id);
  const canRecord = !busy && remaining >= 0 && (remaining > 0 || tipPence > 0 || split.length > 0 || depositCredit > 0);

  async function record(all: boolean) {
    const tenders: Tender[] = [...split];
    if (remaining > 0 || tipPence > 0) tenders.push({ method, service_pence: all ? remaining : 0, tip_pence: tipPence });
    if (!tenders.length && !depositCredit) return;
    await onRecord({ version: booking.version, discount_pence: discount, note: note.trim(), tenders, complete: all });
  }

  return (
    <section className="panel-card checkout" aria-label="Checkout" data-testid="checkout">
      <header className="checkout-head">
        <strong>
          <Icon name="wallet" size={16} /> Checkout
        </strong>
        <StatusPill tone="note">Completes the visit</StatusPill>
      </header>
      <dl className="checkout-lines">
        <div>
          <dt>{booking.service_name}</dt>
          <dd>{money(booking.price_pence)}</dd>
        </div>
        {depositCredit > 0 && (
          <div data-testid="checkout-deposit">
            <dt>{depositCredit >= booking.price_pence ? "Paid in full by card at booking" : "Deposit paid by card at booking"}</dt>
            <dd>− {money(depositCredit)}</dd>
          </div>
        )}
        {paid.service > 0 && (
          <div>
            <dt>Already recorded</dt>
            <dd>− {money(paid.service)}</dd>
          </div>
        )}
        <div className="checkout-discount">
          <dt>
            <label htmlFor="checkout-discount">Discount</label>
          </dt>
          <dd>
            <span className="checkout-money-input">
              <span aria-hidden="true">{currencySymbol()}</span>
              <input
                id="checkout-discount"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.5"
                max={booking.price_pence / 100}
                value={discount ? (discount / 100).toString() : ""}
                placeholder="0"
                onChange={(e) => setDiscount(Math.min(booking.price_pence, Math.max(0, Math.round(Number(e.target.value) * 100) || 0)))}
              />
            </span>
          </dd>
        </div>
        <div className="checkout-due">
          <dt>Due now</dt>
          <dd data-testid="checkout-due">{money(remaining)}</dd>
        </div>
      </dl>

      <fieldset className="checkout-tips">
        <legend>Tip for {barber?.name.split(" ")[0] || "the barber"}</legend>
        <div className="checkout-chips">
          {TIPS.map((t) => (
            <button
              key={t}
              type="button"
              className="chip"
              aria-pressed={customTip === "" && tip === t}
              onClick={() => {
                setTip(t);
                setCustomTip("");
              }}
            >
              {t === 0 ? "No tip" : money(t)}
            </button>
          ))}
          <span className="checkout-money-input chip-input">
            <span aria-hidden="true">{currencySymbol()}</span>
            <input aria-label="Custom tip" type="number" inputMode="decimal" min={0} step="0.5" placeholder="Other" value={customTip} onChange={(e) => setCustomTip(e.target.value)} />
          </span>
        </div>
        <small>Tips are recorded against the barber, 100%.</small>
      </fieldset>

      <fieldset className="checkout-methods">
        <legend>How are they paying?</legend>
        <div className="method-grid">
          {TILL_METHODS.map((m) => (
            <button key={m.key} type="button" className="method-tile" aria-pressed={method === m.key} data-testid={`method-${m.key.toLowerCase()}`} onClick={() => { setMethod(m.key); setCard(false); }}>
              <Icon name={m.icon} size={18} />
              <b>{m.label}</b>
              {m.key === "CARD" && <small>{cardLive ? "Tap on their phone or reader" : "Recorded by hand"}</small>}
            </button>
          ))}
        </div>
      </fieldset>

      {split.length > 0 && (
        <ul className="checkout-split" aria-label="Split payment so far">
          {split.map((t, i) => (
            <li key={i}>
              <span>
                {METHODS.find((m) => m.key === t.method)?.label} · {money(t.service_pence)}
                {t.tip_pence ? ` + ${money(t.tip_pence)} tip` : ""}
              </span>
              <button type="button" className="panel-inline" onClick={() => setSplit(split.filter((_, j) => j !== i))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="panel-reason">
        <span>Note (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. paid for his son too" />
      </label>

      {api && card && (
        <CardAtChair api={api} booking={booking} amount={{ service_pence: remaining, tip_pence: tipPence, discount_pence: discount, complete: true, note: note.trim() }} live={!!cardLive} onPaid={async () => { await onPaid?.(); }} onClose={() => setCard(false)} />
      )}
      <div className="panel-actions-row checkout-actions">
        {method === "CARD" && cardLive && api ? (
          !card && (
            <Button disabled={remaining + tipPence <= 0 || busy} onClick={() => setCard(true)} data-testid="take-card">
              <Icon name="card" size={16} /> Charge {money(remaining + tipPence)} by card
            </Button>
          )
        ) : (
          <Button disabled={!canRecord} onClick={() => record(true)} data-testid="record-payment">
            <Icon name="checks" size={16} />
            {busy ? "Recording…" : `${method === "CARD" ? "Card taken" : method === "CASH" ? "Cash taken" : "Paid"} · ${money(remaining + tipPence)} · complete`}
          </Button>
        )}
        {method === "CARD" && cardLive && !card && (
          <Button variant="ghost" disabled={!canRecord} onClick={() => record(true)} data-testid="record-payment" title="Card taken on a machine that isn't connected to foliyo">
            Record card taken elsewhere
          </Button>
        )}
        {remaining > 0 && (
          <details className="checkout-more">
            <summary>Split</summary>
            <div className="checkout-split-add">
              <SplitAmount max={remaining} onAdd={(pence) => { setSplit([...split, { method, service_pence: pence, tip_pence: tipPence }]); setTip(0); setCustomTip(""); }} />
            </div>
          </details>
        )}
        <Button variant="ghost" onClick={onCancel}>
          Back
        </Button>
      </div>
      <p className="drawer-note left">{cardLive ? "Card goes through the reader or a pay link and reaches the barber's payout automatically. Cash, transfer and voucher are recorded here." : "Completes the visit and writes the ledger your wallet and pay runs read from."}</p>
    </section>
  );
}

// Card at the chair: a pay link / QR the customer scans, or a Terminal reader. Polls until paid.
type PayRequest = { id: string; kind: "LINK" | "TERMINAL"; status: "OPEN" | "PAID" | "EXPIRED" | "CANCELLED"; url: string; service_pence: number; tip_pence: number; expires_at: number; sent_to: string };
export function CardAtChair({ api, booking, amount, live, onPaid, onClose }: { api: <T>(path: string, method?: string, body?: unknown) => Promise<T>; booking: StoredBooking; amount: { service_pence: number; tip_pence: number; discount_pence: number; complete: boolean; note: string }; live: boolean; onPaid: () => Promise<void>; onClose: () => void }) {
  const [mode, setMode] = useState<"pick" | "link" | "reader">("pick");
  const [readers, setReaders] = useState<{ id: string; label: string; status: string }[]>([]);
  const [req, setReq] = useState<PayRequest | null>(null);
  const [qr, setQr] = useState("");
  const [shortUrl, setShortUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState("");
  const timer = useRef<number | null>(null);
  useEffect(() => {
    api<{ readers: { id: string; label: string; status: string }[] }>("/terminal/readers").then((r) => setReaders(r.readers)).catch(() => null);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, []);
  useEffect(() => {
    if (!req || req.status !== "OPEN") return;
    timer.current = window.setInterval(async () => {
      try {
        const r = await api<{ request: PayRequest }>(`/payment-requests/${req.id}`);
        setReq(r.request);
        if (r.request.status === "PAID") { if (timer.current) window.clearInterval(timer.current); await onPaid(); }
        if (r.request.status !== "OPEN" && timer.current) window.clearInterval(timer.current);
      } catch { /* keep polling */ }
    }, 3000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [req?.id, req?.status]);
  async function startLink() {
    setBusy(true); setError("");
    try {
      const r = await api<{ request: PayRequest; qr: string; short_url?: string }>(`/bookings/${booking.id}/pay-link`, "POST", { version: booking.version, ...amount });
      setReq(r.request); setQr(r.qr); setShortUrl(r.short_url || r.request.url); setMode("link");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create the link."); } finally { setBusy(false); }
  }
  async function startReader(readerId: string) {
    setBusy(true); setError("");
    try {
      const r = await api<{ request: PayRequest }>(`/bookings/${booking.id}/terminal`, "POST", { version: booking.version, ...amount, reader_id: readerId });
      setReq(r.request); setMode("reader");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not reach the reader."); } finally { setBusy(false); }
  }
  async function cancel() {
    if (req && req.status === "OPEN") await api(`/payment-requests/${req.id}/cancel`, "POST", {}).catch(() => null);
    onClose();
  }
  async function send(channel: "SMS" | "EMAIL") {
    if (!req) return;
    try { const r = await api<{ sent_to: string }>(`/payment-requests/${req.id}/send`, "POST", { channel }); setSent(r.sent_to); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not send."); }
  }
  const total = money(amount.service_pence + amount.tip_pence);
  return (
    <section className="card-at-chair" aria-label="Card payment" data-testid="card-at-chair">
      {!live && <p className="workspace-footnote">Card through foliyo isn’t switched on yet. Once it is, this shows a QR the customer taps to pay on their own phone, or sends the amount to your reader.</p>}
      {error && <p className="workspace-error" role="alert">{error}</p>}
      {mode === "pick" && (
        <div className="card-pick">
          <button type="button" className="card-option" disabled={!live || busy} onClick={startLink} data-testid="card-link">
            <Icon name="phone" size={18} />
            <span><b>Tap on their phone</b><small>Show a QR — they scan and pay with Apple Pay, Google Pay or card. No reader needed.</small></span>
          </button>
          {readers.map((r) => (
            <button type="button" key={r.id} className="card-option" disabled={!live || busy || r.status === "offline"} onClick={() => startReader(r.id)} data-testid="card-reader">
              <Icon name="card" size={18} />
              <span><b>{r.label}</b><small>{r.status === "offline" ? "Reader is offline" : "Send the amount to the reader — they tap their card on it."}</small></span>
            </button>
          ))}
          {readers.length === 0 && <span className="workspace-footnote">Got a Stripe reader? Pair it in Settings → Payments to tap cards on the counter too.</span>}
          <Button variant="ghost" onClick={onClose}>Back</Button>
        </div>
      )}
      {mode === "link" && req && (
        <div className="card-link-view">
          {req.status === "OPEN" && (
            <>
              <img src={qr} alt={`QR code to pay ${total}`} className="card-qr" />
              <p><strong>{total}</strong> · ask them to point their camera at the code</p>
              <p className="workspace-footnote">Opens a secure foliyo checkout on their phone. Apple Pay / Google Pay if they have it, card if not.</p>
              <div className="panel-actions-row">
                {booking.phone && <Button variant="secondary" onClick={() => send("SMS")}>Text it</Button>}
                {booking.email && <Button variant="secondary" onClick={() => send("EMAIL")}>Email it</Button>}
                <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(shortUrl || req.url)}>Copy link</Button>
              </div>
              {sent && <p className="workspace-success" role="status">Sent to {sent}.</p>}
              <p className="workspace-footnote"><Icon name="hourglass" size={13} /> Waiting for the customer… valid 30 minutes.</p>
            </>
          )}
          {req.status === "PAID" && <p className="workspace-success" role="status" data-testid="card-paid"><Icon name="check" size={14} /> Paid {total}. Recorded and checked out — it goes on the barber’s next pay run.</p>}
          {(req.status === "EXPIRED" || req.status === "CANCELLED") && <p className="workspace-error" role="alert">This link is no longer valid.</p>}
          <Button variant="ghost" onClick={cancel}>{req.status === "OPEN" ? "Cancel" : "Done"}</Button>
        </div>
      )}
      {mode === "reader" && req && (
        <div className="card-reader-view">
          {req.status === "OPEN" && <p><Icon name="card" size={16} /> <strong>{total}</strong> on the reader — ask the customer to tap.</p>}
          {req.status === "PAID" && <p className="workspace-success" role="status" data-testid="card-paid"><Icon name="check" size={14} /> Paid {total} by card. Recorded and checked out.</p>}
          {(req.status === "EXPIRED" || req.status === "CANCELLED") && <p className="workspace-error" role="alert">The reader didn’t complete the payment.</p>}
          <Button variant="ghost" onClick={cancel}>{req.status === "OPEN" ? "Cancel on reader" : "Done"}</Button>
        </div>
      )}
    </section>
  );
}

function SplitAmount({ max, onAdd }: { max: number; onAdd: (pence: number) => void }) {
  const [value, setValue] = useState("");
  const pence = Math.round(Number(value) * 100) || 0;
  return (
    <>
      <span className="checkout-money-input">
        <span aria-hidden="true">{currencySymbol()}</span>
        <input aria-label="Part payment amount" type="number" inputMode="decimal" min={0.5} step="0.5" max={max / 100} value={value} onChange={(e) => setValue(e.target.value)} />
      </span>
      <Button variant="secondary" disabled={pence <= 0 || pence >= max} onClick={() => { onAdd(pence); setValue(""); }}>
        Add part payment
      </Button>
    </>
  );
}

// Compact "paid" strip for the appointment panel details card.
export function PaidStrip({ payments, booking, canVoid, onVoid }: { payments: Payment[]; booking: StoredBooking; canVoid: boolean; onVoid: (p: Payment) => void }) {
  const rows = payments.filter((p) => p.booking_id === booking.id);
  if (!rows.length) return null;
  return (
    <ul className="paid-strip" aria-label="Payments recorded">
      {rows.map((p) => (
        <li key={p.id} className={p.voided_at ? "voided" : ""}>
          <Icon name={METHODS.find((m) => m.key === p.method)?.icon || "card"} size={14} />
          <span>
            {METHODS.find((m) => m.key === p.method)?.label} · {money(p.service_pence)}
            {p.tip_pence ? ` + ${money(p.tip_pence)} tip` : ""}
            {p.discount_pence ? ` (−${money(p.discount_pence)} discount)` : ""}
          </span>
          {p.voided_at ? <StatusPill tone="warn">Voided</StatusPill> : <StatusPill tone="paid"><Icon name="paid" size={12} /> Paid</StatusPill>}
          {!p.voided_at && canVoid && (
            <button type="button" className="panel-inline" onClick={() => onVoid(p)}>
              Void
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
