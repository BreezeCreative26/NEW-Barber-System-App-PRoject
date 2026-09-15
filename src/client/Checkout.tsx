// Checkout: record how a visit was paid at the chair. The wallet is a ledger, not a balance —
// nothing here moves money. Flow: amount (price − discount) → tip → method → record.
import { useState } from "react";
import type { Payment, StoredBooking, WorkspaceData } from "../server/domain";
import { Button, Icon, StatusPill } from "./ui";
import { money } from "./fixtures";

export type Tender = { method: Payment["method"]; service_pence: number; tip_pence: number };
export const METHODS: { key: Payment["method"]; label: string; icon: string }[] = [
  { key: "CARD", label: "Card", icon: "card" },
  { key: "CASH", label: "Cash", icon: "banknote" },
  { key: "TRANSFER", label: "Transfer", icon: "landmark" },
  { key: "VOUCHER", label: "Voucher", icon: "gift" },
];
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
}: {
  booking: StoredBooking;
  w: WorkspaceData;
  payments: Payment[];
  busy: boolean;
  onRecord: (body: { version: number; discount_pence: number; note: string; tenders: Tender[]; complete: boolean }) => Promise<void>;
  onCancel: () => void;
}) {
  const paid = paidFor(payments, booking.id);
  const [discount, setDiscount] = useState(0);
  const [tip, setTip] = useState(0);
  const [customTip, setCustomTip] = useState("");
  const [method, setMethod] = useState<Payment["method"]>("CARD");
  const [split, setSplit] = useState<Tender[]>([]);
  const [note, setNote] = useState("");
  const due = Math.max(0, booking.price_pence - discount - paid.service);
  const splitPaid = split.reduce((n, t) => n + t.service_pence, 0);
  const remaining = due - splitPaid;
  const tipPence = customTip !== "" ? Math.max(0, Math.round(Number(customTip) * 100) || 0) : tip;
  const barber = w.staff.find((s) => s.id === booking.staff_id);
  const canRecord = !busy && remaining >= 0 && (remaining > 0 || tipPence > 0 || split.length > 0);

  async function record(all: boolean) {
    const tenders: Tender[] = [...split];
    if (remaining > 0 || tipPence > 0) tenders.push({ method, service_pence: all ? remaining : 0, tip_pence: tipPence });
    if (!tenders.length) return;
    await onRecord({ version: booking.version, discount_pence: discount, note: note.trim(), tenders, complete: all });
  }

  return (
    <section className="panel-card checkout" aria-label="Checkout" data-testid="checkout">
      <header className="checkout-head">
        <strong>
          <Icon name="wallet" size={16} /> Checkout
        </strong>
        <StatusPill tone="note">Records the payment only</StatusPill>
      </header>
      <dl className="checkout-lines">
        <div>
          <dt>{booking.service_name}</dt>
          <dd>{money(booking.price_pence)}</dd>
        </div>
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
              <span aria-hidden="true">£</span>
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
            <span aria-hidden="true">£</span>
            <input aria-label="Custom tip" type="number" inputMode="decimal" min={0} step="0.5" placeholder="Other" value={customTip} onChange={(e) => setCustomTip(e.target.value)} />
          </span>
        </div>
        <small>Tips are recorded against the barber, 100%.</small>
      </fieldset>

      <fieldset className="checkout-methods">
        <legend>Paid by</legend>
        <div className="method-grid">
          {METHODS.map((m) => (
            <button key={m.key} type="button" className="method-tile" aria-pressed={method === m.key} onClick={() => setMethod(m.key)}>
              <Icon name={m.icon} size={18} />
              <b>{m.label}</b>
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

      <div className="panel-actions-row checkout-actions">
        <Button disabled={!canRecord} onClick={() => record(true)} data-testid="record-payment">
          <Icon name="checks" size={16} />
          {busy ? "Recording…" : `Record ${money(remaining + tipPence)} · complete`}
        </Button>
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
      <p className="drawer-note left">No card reader or live payment is connected. This writes a ledger row your wallet and payouts read from.</p>
    </section>
  );
}

function SplitAmount({ max, onAdd }: { max: number; onAdd: (pence: number) => void }) {
  const [value, setValue] = useState("");
  const pence = Math.round(Number(value) * 100) || 0;
  return (
    <>
      <span className="checkout-money-input">
        <span aria-hidden="true">£</span>
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
