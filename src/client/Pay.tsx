// Pay terms + pay runs for one barber. Terms are saved on the staff record (PUT /staff/:id);
// pay runs are calculated server-side from the payments ledger and the terms in force.
import { useEffect, useState } from "react";
import type { PayModel, PayPeriod, PayRun, Staff, WorkspaceData } from "../server/domain";
import { Button, Icon, Notice, StatusPill } from "./ui";
import { money, datePlus, currencySymbol } from "./fixtures";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

export const PAY_MODELS: { key: PayModel; label: string; blurb: string }[] = [
  { key: "COMMISSION", label: "Commission", blurb: "Barber earns a % of their service takings. Most common for self-employed barbers." },
  { key: "CHAIR_RENT", label: "Chair rent", blurb: "Barber pays a fixed rent per period and keeps 100% of their takings." },
  { key: "HOURLY", label: "Hourly", blurb: "Paid per rostered hour. Usual for employed juniors and apprentices." },
  { key: "SALARY", label: "Salary", blurb: "Fixed amount per period regardless of takings." },
  { key: "HYBRID", label: "Base + commission", blurb: "Guaranteed base per period, plus commission on takings above a threshold." },
];
const PERIODS: { key: PayPeriod; label: string }[] = [
  { key: "WEEKLY", label: "Weekly" },
  { key: "FORTNIGHTLY", label: "Fortnightly" },
  { key: "MONTHLY", label: "Monthly" },
];
const pounds = (pence: number) => (pence ? (pence / 100).toString() : "");
const pence = (v: string) => Math.max(0, Math.round(Number(v) * 100) || 0);

export type PayForm = {
  pay_model: PayModel;
  pay_period: PayPeriod;
  commission_pct: number;
  base_pence: number;
  hourly_pence: number;
  rent_pence: number;
  commission_threshold_pence: number;
  commission_tiers: { from_pence: number; pct: number }[];
  tip_share_pct: number;
  product_commission_pct: number;
  employment: "SELF_EMPLOYED" | "EMPLOYED";
  pay_notes: string;
};
export function payFormOf(s: Staff | null): PayForm {
  let tiers: { from_pence: number; pct: number }[] = [];
  try {
    tiers = s ? JSON.parse(s.commission_tiers || "[]") : [];
  } catch {
    tiers = [];
  }
  return {
    pay_model: s?.pay_model ?? "COMMISSION",
    pay_period: s?.pay_period ?? "WEEKLY",
    commission_pct: s?.commission_pct ?? 50,
    base_pence: s?.base_pence ?? 0,
    hourly_pence: s?.hourly_pence ?? 0,
    rent_pence: s?.rent_pence ?? 0,
    commission_threshold_pence: s?.commission_threshold_pence ?? 0,
    commission_tiers: tiers,
    tip_share_pct: s?.tip_share_pct ?? 100,
    product_commission_pct: s?.product_commission_pct ?? 0,
    employment: s?.employment ?? "SELF_EMPLOYED",
    pay_notes: s?.pay_notes ?? "",
  };
}

export function summariseTerms(f: PayForm) {
  const per = f.pay_period.toLowerCase();
  switch (f.pay_model) {
    case "COMMISSION":
      return f.commission_tiers.length
        ? `${f.commission_tiers.map((t, i) => `${t.pct}%${i === 0 ? "" : ` above ${money(t.from_pence)}`}`).join(" · ")} of services, ${per}`
        : `${f.commission_pct}% of service takings, ${per}`;
    case "CHAIR_RENT":
      return `${money(f.rent_pence)} chair rent ${per}; keeps all takings`;
    case "HOURLY":
      return `${money(f.hourly_pence)}/hour on rostered hours, paid ${per}`;
    case "SALARY":
      return `${money(f.base_pence)} ${per}`;
    case "HYBRID":
      return `${money(f.base_pence)} base ${per} + ${f.commission_pct}% above ${money(f.commission_threshold_pence)} takings`;
  }
}

export function PayTermsForm({ form, setForm, disabled }: { form: PayForm; setForm: (f: PayForm) => void; disabled?: boolean }) {
  const set = <K extends keyof PayForm>(k: K, v: PayForm[K]) => setForm({ ...form, [k]: v });
  return (
    <fieldset disabled={disabled} className="studio-fieldset pay-terms" data-testid="pay-terms">
      <div className="pay-models" role="radiogroup" aria-label="Pay model">
        {PAY_MODELS.map((m) => (
          <button
            key={m.key}
            type="button"
            role="radio"
            aria-checked={form.pay_model === m.key}
            className="pay-model"
            onClick={() => set("pay_model", m.key)}
          >
            <b>{m.label}</b>
            <small>{m.blurb}</small>
          </button>
        ))}
      </div>
      <div className="workspace-form-grid three">
        <label className="workspace-field">
          <span>Pay period</span>
          <select value={form.pay_period} onChange={(e) => set("pay_period", e.target.value as PayPeriod)}>
            {PERIODS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="workspace-field">
          <span>Employment</span>
          <select value={form.employment} onChange={(e) => set("employment", e.target.value as PayForm["employment"])}>
            <option value="SELF_EMPLOYED">Self-employed (invoices the shop)</option>
            <option value="EMPLOYED">Employed (payroll)</option>
          </select>
        </label>
        <label className="workspace-field">
          <span>Tips kept by barber (%)</span>
          <input type="number" min={0} max={100} value={form.tip_share_pct} onChange={(e) => set("tip_share_pct", Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
        </label>
      </div>
      {(form.pay_model === "COMMISSION" || form.pay_model === "HYBRID") && (
        <div className="workspace-form-grid three">
          <label className="workspace-field">
            <span>Commission on services (%)</span>
            <input type="number" min={0} max={100} value={form.commission_pct} onChange={(e) => set("commission_pct", Math.max(0, Math.min(100, Number(e.target.value) || 0)))} disabled={form.commission_tiers.length > 0} />
            {form.commission_tiers.length > 0 && <small className="field-hint">Tiers below replace the flat rate.</small>}
          </label>
          {form.pay_model === "HYBRID" && (
            <>
              <label className="workspace-field">
                <span>Base per period ({currencySymbol()})</span>
                <input type="number" min={0} step="0.01" value={pounds(form.base_pence)} onChange={(e) => set("base_pence", pence(e.target.value))} />
              </label>
              <label className="workspace-field">
                <span>Commission starts above ({currencySymbol()} takings)</span>
                <input type="number" min={0} step="0.01" value={pounds(form.commission_threshold_pence)} onChange={(e) => set("commission_threshold_pence", pence(e.target.value))} />
              </label>
            </>
          )}
          <label className="workspace-field">
            <span>Product / retail commission (%)</span>
            <input type="number" min={0} max={100} value={form.product_commission_pct} onChange={(e) => set("product_commission_pct", Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
            <small className="field-hint">Recorded for when retail sales are added; not used in pay runs yet.</small>
          </label>
        </div>
      )}
      {form.pay_model === "COMMISSION" && (
        <div className="pay-tiers">
          <div className="workspace-section-heading compact">
            <div>
              <strong>Tiered commission (optional)</strong>
              <p className="workspace-footnote">Marginal bands on the period's service takings, e.g. 40% to {money(100000)} then 50% above.</p>
            </div>
            {form.commission_tiers.length < 6 && (
              <Button
                variant="ghost"
                onClick={() =>
                  set("commission_tiers", [
                    ...form.commission_tiers,
                    { from_pence: form.commission_tiers.length ? form.commission_tiers.at(-1)!.from_pence + 50000 : 0, pct: form.commission_tiers.at(-1)?.pct ?? form.commission_pct },
                  ])
                }
              >
                <Icon name="plus" size={14} /> Add tier
              </Button>
            )}
          </div>
          {form.commission_tiers.map((t, i) => (
            <div className="pay-tier-row" key={i}>
              <label className="workspace-field">
                <span>{i === 0 ? `From ${money(0)}` : `From ${currencySymbol()} takings`}</span>
                <input type="number" min={0} step="0.01" value={i === 0 ? "0" : pounds(t.from_pence)} disabled={i === 0} onChange={(e) => set("commission_tiers", form.commission_tiers.map((x, j) => (j === i ? { ...x, from_pence: pence(e.target.value) } : x)))} />
              </label>
              <label className="workspace-field">
                <span>Rate (%)</span>
                <input type="number" min={0} max={100} value={t.pct} onChange={(e) => set("commission_tiers", form.commission_tiers.map((x, j) => (j === i ? { ...x, pct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) } : x)))} />
              </label>
              <Button variant="ghost" aria-label={`Remove tier ${i + 1}`} onClick={() => set("commission_tiers", form.commission_tiers.filter((_, j) => j !== i))}>
                <Icon name="close" size={14} />
              </Button>
            </div>
          ))}
        </div>
      )}
      {form.pay_model === "CHAIR_RENT" && (
        <div className="workspace-form-grid">
          <label className="workspace-field">
            <span>Chair rent per period ({currencySymbol()})</span>
            <input type="number" min={0} step="0.01" value={pounds(form.rent_pence)} onChange={(e) => set("rent_pence", pence(e.target.value))} />
            <small className="field-hint">Pay runs show what the barber owes the shop (rent less any tips the shop collected for them).</small>
          </label>
        </div>
      )}
      {form.pay_model === "HOURLY" && (
        <div className="workspace-form-grid">
          <label className="workspace-field">
            <span>Hourly rate ({currencySymbol()})</span>
            <input type="number" min={0} step="0.01" value={pounds(form.hourly_pence)} onChange={(e) => set("hourly_pence", pence(e.target.value))} />
            <small className="field-hint">Hours come from the roster (weekly hours + dated shifts, less leave, closures and breaks).</small>
          </label>
        </div>
      )}
      {form.pay_model === "SALARY" && (
        <div className="workspace-form-grid">
          <label className="workspace-field">
            <span>Salary per period ({currencySymbol()})</span>
            <input type="number" min={0} step="0.01" value={pounds(form.base_pence)} onChange={(e) => set("base_pence", pence(e.target.value))} />
          </label>
        </div>
      )}
      <label className="workspace-field">
        <span>Notes for pay runs (optional)</span>
        <textarea rows={2} maxLength={600} value={form.pay_notes} onChange={(e) => set("pay_notes", e.target.value)} placeholder="e.g. rent due Mondays; holiday pay accrues at 12.07%" />
      </label>
      <p className="pay-summary" data-testid="pay-summary">
        <Icon name="wallet" size={14} /> {summariseTerms(form)} · tips {form.tip_share_pct}% to barber
      </p>
    </fieldset>
  );
}

// ---- Pay runs ----
type Preview = {
  terms: PayForm;
  input: { service_pence: number; tips_pence: number; visits: number; hours_x100: number; periods: number };
  result: { commission_pence: number; base_pence: number; hourly_pence: number; tip_pence: number; rent_pence: number; adjustments_pence: number; net_pence: number };
  split?: { card_service_pence: number; card_tips_pence: number; cash_service_pence: number; cash_tips_pence: number; platform_fee_pence: number };
  settlement?: { transfer_pence: number; shop_transfer_pence: number; reserve_pence: number; cash_residual_pence: number };
  payouts_ready?: boolean;
};
function periodBounds(period: PayPeriod, today: string, offset = 0) {
  if (period === "MONTHLY") {
    const d = new Date(today + "T12:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + offset, 1);
    const from = d.toISOString().slice(0, 10);
    d.setUTCMonth(d.getUTCMonth() + 1, 0);
    return { from, to: d.toISOString().slice(0, 10) };
  }
  const len = period === "WEEKLY" ? 7 : 14;
  const dow = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7;
  const monday = datePlus(today, -dow + offset * len);
  return { from: monday, to: datePlus(monday, len - 1) };
}
const statusTone: Record<PayRun["status"], "good" | "next" | "paid" | "warn" | "note"> = { DRAFT: "note", APPROVED: "next", TRANSFERRED: "good", PAID: "good", VOID: "warn" };
const statusLabel: Record<PayRun["status"], string> = { DRAFT: "draft", APPROVED: "approved", TRANSFERRED: "sent to Stripe", PAID: "settled", VOID: "void" };

export function PayRuns({ w, api, staff, canEdit, runs, onChanged }: { w: WorkspaceData; api: Api; staff: Staff; canEdit: boolean; runs: PayRun[]; onChanged: () => void }) {
  const [offset, setOffset] = useState(-1); // previous period by default: it is complete
  const bounds = periodBounds(staff.pay_period, w.today, offset);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [adjust, setAdjust] = useState<{ label: string; pence: number }[]>([]);
  const [adjLabel, setAdjLabel] = useState("");
  const [adjAmount, setAdjAmount] = useState("");
  const existing = runs.find((r) => r.staff_id === staff.id && r.period_from === bounds.from && r.period_to === bounds.to && r.status !== "VOID");
  useEffect(() => {
    let cancelled = false;
    setError("");
    api<Preview>(`/pay-runs/preview?staff_id=${staff.id}&from=${bounds.from}&to=${bounds.to}`)
      .then((p) => !cancelled && setPreview(p))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not calculate."));
    return () => {
      cancelled = true;
    };
  }, [staff.id, staff.version, bounds.from, bounds.to, w.payments.length]);
  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy("");
    }
  }
  const adjTotal = adjust.reduce((n, a) => n + a.pence, 0);
  const net = preview ? preview.result.net_pence + adjTotal : 0;
  const mine = runs.filter((r) => r.staff_id === staff.id);
  return (
    <div className="pay-runs" data-testid="pay-runs">
      <Notice>
        <strong>{staff.name.split(" ")[0]}'s deal:</strong> {summariseTerms(payFormOf(staff))} · tips {staff.tip_share_pct}% · {staff.employment === "EMPLOYED" ? "employed" : "self-employed"}. Runs use the payments ledger, so record every visit at checkout.
      </Notice>
      <div className="toolbar pay-period-bar">
        <Button variant="ghost" className="icon-only" aria-label="Previous period" onClick={() => setOffset((o) => o - 1)}>
          <Icon name="left" />
        </Button>
        <strong className="pay-period-label">
          {fmt(bounds.from)} – {fmt(bounds.to)}
          <small>{offset === 0 ? " · current period" : offset === -1 ? " · last period" : ""}</small>
        </strong>
        <Button variant="ghost" className="icon-only" aria-label="Next period" disabled={offset >= 0} onClick={() => setOffset((o) => Math.min(0, o + 1))}>
          <Icon name="right" />
        </Button>
        <span className="toolbar-grow" />
        {existing && <StatusPill tone={statusTone[existing.status]} data-testid="pay-run-status">{statusLabel[existing.status]}</StatusPill>}
      </div>
      {error && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <dl className="pay-breakdown" aria-label="Pay run breakdown">
          <Line label="Service takings (ledger)" value={money(preview.input.service_pence)} sub={`${preview.input.visits} paid visit${preview.input.visits === 1 ? "" : "s"}`} />
          {preview.terms.pay_model === "HOURLY" && <Line label="Rostered hours" value={(preview.input.hours_x100 / 100).toFixed(1)} sub={`× ${money(preview.terms.hourly_pence)}`} />}
          {preview.result.commission_pence > 0 && <Line label="Commission" value={money(preview.result.commission_pence)} />}
          {preview.result.base_pence > 0 && <Line label={preview.terms.pay_model === "SALARY" ? "Salary" : "Base"} value={money(preview.result.base_pence)} />}
          {preview.result.hourly_pence > 0 && <Line label="Hourly pay" value={money(preview.result.hourly_pence)} />}
          <Line label={`Tips (${preview.terms.tip_share_pct}% of ${money(preview.input.tips_pence)})`} value={money(preview.result.tip_pence)} />
          {preview.result.rent_pence > 0 && <Line label="Chair rent owed to shop" value={`− ${money(preview.result.rent_pence)}`} />}
          {(existing ? (JSON.parse(existing.adjustments_json) as { label: string; pence: number }[]) : adjust).map((a, i) => (
            <Line key={i} label={a.label} value={`${a.pence < 0 ? "− " : "+ "}${money(Math.abs(a.pence))}`} onRemove={!existing && canEdit ? () => setAdjust(adjust.filter((_, j) => j !== i)) : undefined} />
          ))}
          <div className="pay-net">
            <dt>{(existing ? existing.net_pence : net) < 0 ? "Barber pays shop" : "Shop pays barber"}</dt>
            <dd data-testid="pay-net">{money(Math.abs(existing ? existing.net_pence : net))}</dd>
          </div>
        </dl>
      )}
      {preview && (
        <Settlement
          card={existing ? (existing.card_service_pence ?? 0) + (existing.card_tips_pence ?? 0) : (preview.split?.card_service_pence ?? 0) + (preview.split?.card_tips_pence ?? 0)}
          cash={existing ? (existing.cash_service_pence ?? 0) + (existing.cash_tips_pence ?? 0) : (preview.split?.cash_service_pence ?? 0) + (preview.split?.cash_tips_pence ?? 0)}
          toBarber={existing ? existing.transfer_pence ?? 0 : preview.settlement?.transfer_pence ?? 0}
          toShop={existing ? existing.shop_transfer_pence ?? 0 : preview.settlement?.shop_transfer_pence ?? 0}
          reserve={existing ? existing.reserve_pence ?? 0 : preview.settlement?.reserve_pence ?? 0}
          residual={existing ? existing.cash_residual_pence ?? 0 : preview.settlement?.cash_residual_pence ?? 0}
          barber={staff.name.split(" ")[0]}
          status={existing?.status}
          ready={!!preview.payouts_ready}
        />
      )}
      {canEdit && !existing && preview && (
        <div className="pay-adjust">
          <label className="workspace-field">
            <span>Adjustment (bonus +, deduction −)</span>
            <input value={adjLabel} maxLength={60} placeholder="e.g. Product sales bonus · Late fee · Holiday pay" onChange={(e) => setAdjLabel(e.target.value)} />
          </label>
          <label className="workspace-field narrow">
            <span>Amount ({currencySymbol()})</span>
            <input type="number" step="0.01" value={adjAmount} placeholder="−20 or 35" onChange={(e) => setAdjAmount(e.target.value)} />
          </label>
          <Button
            variant="secondary"
            disabled={!adjLabel.trim() || !Number(adjAmount) || adjust.length >= 10}
            onClick={() => {
              setAdjust([...adjust, { label: adjLabel.trim(), pence: Math.round(Number(adjAmount) * 100) }]);
              setAdjLabel("");
              setAdjAmount("");
            }}
          >
            Add
          </Button>
        </div>
      )}
      {canEdit && preview && (
        <div className="panel-actions-row">
          {!existing && (
            <Button disabled={!!busy} data-testid="create-pay-run" onClick={() => act("create", () => api("/pay-runs", "POST", { staff_id: staff.id, period_from: bounds.from, period_to: bounds.to, adjustments: adjust }))}>
              <Icon name="file" size={16} /> {busy === "create" ? "Saving…" : "Create draft pay run"}
            </Button>
          )}
          {existing?.status === "DRAFT" && (
            <Button disabled={!!busy} data-testid="approve-pay-run" onClick={() => act("approve", () => api(`/pay-runs/${existing.id}`, "PUT", { version: existing.version, status: "APPROVED" }))}>
              <Icon name="check" size={16} /> Approve
            </Button>
          )}
          {existing?.status === "APPROVED" && ((existing.transfer_pence ?? 0) > 0 || (existing.shop_transfer_pence ?? 0) > 0) && (
            <Button variant="secondary" disabled={!!busy} data-testid="transfer-pay-run" onClick={() => act("transfer", () => api(`/pay-runs/${existing.id}/transfer`, "POST", {}))}>
              <Icon name="send" size={16} /> {busy === "transfer" ? "Sending…" : "Send card money now"}
            </Button>
          )}
          {(existing?.status === "APPROVED" || existing?.status === "TRANSFERRED") && (
            <MarkPaid run={existing} busy={!!busy} onPaid={(method, ref) => act("paid", () => api(`/pay-runs/${existing.id}`, "PUT", { version: existing.version, status: "PAID", paid_method: method, paid_reference: ref }))} />
          )}
          {existing && existing.status !== "PAID" && (
            <Button variant="ghost" disabled={!!busy} onClick={() => {
              const reason = window.prompt("Why void this pay run?");
              if (reason && reason.trim().length >= 3) act("void", () => api(`/pay-runs/${existing.id}`, "PUT", { version: existing.version, status: "VOID", reason: reason.trim() }));
            }}>
              Void
            </Button>
          )}
          {existing?.status === "PAID" && (
            <span className="workspace-footnote">
              {existing.transferred_at ? "Card money sent by Stripe" : ""}
              {existing.paid_method ? `${existing.transferred_at ? " · remainder " : "Settled "}by ${existing.paid_method.toLowerCase()}` : ""}
              {existing.paid_reference ? ` · ${existing.paid_reference}` : ""} · frozen
            </span>
          )}
        </div>
      )}
      {mine.length > 0 && (
        <details className="pay-history">
          <summary>
            <Icon name="list" size={14} /> Pay run history ({mine.length})
          </summary>
          <table className="pay-history-table">
            <thead>
              <tr>
                <th>Period</th>
                <th>Model</th>
                <th>Takings</th>
                <th>Net</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((r) => (
                <tr key={r.id} className={r.status === "VOID" ? "voided" : ""}>
                  <td>
                    {fmt(r.period_from)} – {fmt(r.period_to)}
                  </td>
                  <td>{PAY_MODELS.find((m) => m.key === r.pay_model)?.label}</td>
                  <td>{money(r.service_pence)}</td>
                  <td>
                    {r.net_pence < 0 ? "−" : ""}
                    {money(Math.abs(r.net_pence))}
                  </td>
                  <td>
                    <StatusPill tone={statusTone[r.status]}>{statusLabel[r.status]}</StatusPill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
function Line({ label, value, sub, onRemove }: { label: string; value: string; sub?: string; onRemove?: () => void }) {
  return (
    <div>
      <dt>
        {label}
        {sub && <small> · {sub}</small>}
      </dt>
      <dd>
        {value}
        {onRemove && (
          <button type="button" className="panel-inline" onClick={onRemove} aria-label={`Remove ${label}`}>
            <Icon name="close" size={12} />
          </button>
        )}
      </dd>
    </div>
  );
}
// What OLLO moves by card versus what changes hands at the chair.
function Settlement({ card, cash, toBarber, toShop, reserve, residual, barber, status, ready }: { card: number; cash: number; toBarber: number; toShop: number; reserve: number; residual: number; barber: string; status?: PayRun["status"]; ready: boolean }) {
  if (card === 0 && cash === 0) return null;
  const sent = status === "TRANSFERRED" || status === "PAID";
  return (
    <section className="pay-settlement" aria-label="How this is settled" data-testid="pay-settlement">
      <div className="pay-settlement-col">
        <h4>
          <Icon name="card" size={14} /> By card · {money(card)}
        </h4>
        <p className="workspace-footnote">Held on OLLO's Stripe balance. {sent ? "Sent" : "Approving sends it"} to each Stripe account; their bank gets it on their payout schedule.</p>
        <dl>
          <div>
            <dt>{barber}</dt>
            <dd data-testid="settle-barber">{money(toBarber)}</dd>
          </div>
          <div>
            <dt>Shop</dt>
            <dd data-testid="settle-shop">{money(toShop)}</dd>
          </div>
          {reserve > 0 && (
            <div>
              <dt>Held back (reserve)</dt>
              <dd>{money(reserve)}</dd>
            </div>
          )}
        </dl>
        {!ready && toBarber > 0 && !sent && (
          <p className="workspace-footnote pay-settlement-warn">
            <Icon name="hourglass" size={13} /> {barber} hasn’t finished Stripe setup — their share stays on OLLO until they do. Team → {barber} → Set up payouts.
          </p>
        )}
      </div>
      <div className="pay-settlement-col">
        <h4>
          <Icon name="banknote" size={14} /> In cash · {money(cash)}
        </h4>
        <p className="workspace-footnote">Already in someone's hand. Nothing moves online.</p>
        <dl>
          <div>
            <dt>{residual === 0 ? "Nothing to settle by hand" : residual > 0 ? `Shop still owes ${barber}` : `${barber} owes the shop`}</dt>
            <dd data-testid="settle-residual">{residual === 0 ? "—" : money(Math.abs(residual))}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
function MarkPaid({ run, busy, onPaid }: { run: PayRun; busy: boolean; onPaid: (method: "BANK" | "CASH" | "OTHER" | "STRIPE", ref: string) => void }) {
  const stripeOnly = run.status === "TRANSFERRED" && !(run.cash_residual_pence ?? 0);
  if (stripeOnly)
    return (
      <Button disabled={busy} data-testid="mark-paid" onClick={() => onPaid("STRIPE", run.transfer_group ?? "")}>
        <Icon name="check" size={16} /> Mark settled
      </Button>
    );
  const [method, setMethod] = useState<"BANK" | "CASH" | "OTHER">("BANK");
  const [ref, setRef] = useState("");
  return (
    <span className="pay-mark-paid">
      <label className="toolbar-select">
        <Icon name="landmark" size={15} />
        <select aria-label="Paid by" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          <option value="BANK">Bank transfer</option>
          <option value="CASH">Cash</option>
          <option value="OTHER">Other</option>
        </select>
      </label>
      <input aria-label="Payment reference" placeholder="Reference (optional)" value={ref} maxLength={80} onChange={(e) => setRef(e.target.value)} />
      <Button disabled={busy} data-testid="mark-paid" onClick={() => onPaid(method, ref.trim())}>
        <Icon name="paid" size={16} /> Mark paid · {money(Math.abs(run.net_pence))}
      </Button>
    </span>
  );
}
const fmt = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(d + "T12:00:00Z"));
