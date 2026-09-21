// Pay terms + pay runs for one barber. Terms are saved on the staff record (PUT /staff/:id);
// pay runs are calculated server-side from the payments ledger and the terms in force.
import { useEffect, useState } from "react";
import type { Deduction, PayModel, PayPeriod, PayRun, Staff, WorkspaceData } from "../server/domain";
import { Button, Icon, Notice, StatusPill } from "./ui";
import { money, datePlus, currencySymbol } from "./fixtures";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

export const PAY_MODELS: { key: PayModel; label: string; blurb: string }[] = [
  { key: "COMMISSION", label: "Commission", blurb: "Barber earns a % of their service takings. Most common for self-employed barbers." },
  { key: "CHAIR_RENT", label: "Keeps all takings", blurb: "Barber keeps 100% of their takings and pays chair/room rent (set below under deductions)." },
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
  deductions: Deduction[];
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
    deductions: (() => { try { const d = JSON.parse(s?.deductions_json || "[]"); return Array.isArray(d) ? d : []; } catch { return []; } })(),
  };
}
export const DEDUCTION_PRESETS: { key: string; label: string; make: (period: PayPeriod) => Omit<Deduction, "id"> }[] = [
  { key: "chair", label: "Chair rent", make: (p) => ({ label: "Chair rent", kind: "FIXED", amount_pence: 15000, pct_x100: 0, cadence: p === "MONTHLY" ? "MONTHLY" : "WEEKLY", proration: "FULL", waive_on_leave: 0, active: 1 }) },
  { key: "room", label: "Room rent", make: () => ({ label: "Room rent", kind: "FIXED", amount_pence: 60000, pct_x100: 0, cadence: "MONTHLY", proration: "BY_DAYS", waive_on_leave: 0, active: 1 }) },
  { key: "pct", label: "% of takings", make: () => ({ label: "Supplies", kind: "PERCENT_OF_TAKINGS", amount_pence: 0, pct_x100: 500, cadence: "PER_RUN", proration: "FULL", waive_on_leave: 0, active: 1 }) },
  { key: "other", label: "Other deduction", make: () => ({ label: "", kind: "FIXED", amount_pence: 0, pct_x100: 0, cadence: "PER_RUN", proration: "FULL", waive_on_leave: 0, active: 1 }) },
];
export function describeDeduction(d: Deduction) {
  if (d.kind === "FIXED") return `${money(d.amount_pence)} ${d.cadence === "PER_RUN" ? "per run" : d.cadence === "WEEKLY" ? "a week" : d.cadence === "FORTNIGHTLY" ? "a fortnight" : "a month"}${d.cadence !== "PER_RUN" ? (d.proration === "BY_DAYS" ? ", prorated by day" : ", whole periods") : ""}${d.waive_on_leave ? ", waived on leave" : ""}`;
  return `${(d.pct_x100 / 100).toFixed(d.pct_x100 % 100 ? 2 : 0)}% of ${d.kind === "PERCENT_OF_TAKINGS" ? "sales" : "the barber's share"}`;
}

export function summariseTerms(f: PayForm) {
  const per = f.pay_period.toLowerCase();
  switch (f.pay_model) {
    case "COMMISSION":
      return f.commission_tiers.length
        ? `${f.commission_tiers.map((t, i) => `${t.pct}%${i === 0 ? "" : ` above ${money(t.from_pence)}`}`).join(" · ")} of services, ${per}`
        : `${f.commission_pct}% of service takings, ${per}`;
    case "CHAIR_RENT":
      return `keeps 100% of takings${f.deductions.filter((d) => d.active).length ? ` less ${f.deductions.filter((d) => d.active).map((d) => d.label.toLowerCase()).join(", ")}` : ""}, ${per}`;
    case "HOURLY":
      return `${money(f.hourly_pence)}/hour on rostered hours, paid ${per}`;
    case "SALARY":
      return `${money(f.base_pence)} ${per}`;
    case "HYBRID":
      return `${money(f.base_pence)} base ${per} + ${f.commission_pct}% above ${money(f.commission_threshold_pence)} takings`;
  }
}

function DeductionsEditor({ form, set }: { form: PayForm; set: <K extends keyof PayForm>(k: K, v: PayForm[K]) => void }) {
  const upd = (i: number, patch: Partial<Deduction>) => set("deductions", form.deductions.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const ownerPct = form.pay_model === "COMMISSION" && !form.commission_tiers.length ? 100 - form.commission_pct : null;
  return (
    <div className="pay-deductions" data-testid="pay-deductions">
      <div className="workspace-section-heading compact">
        <div>
          <strong>Deductions & rent</strong>
          <p className="workspace-footnote">
            Taken off the barber's pay on every run and owed to the business.{ownerPct != null ? ` Their ${form.commission_pct}% split already leaves the owner ${ownerPct}% of sales.` : ""}
          </p>
        </div>
        <div className="admin-actions">
          {DEDUCTION_PRESETS.map((p) => (
            <Button key={p.key} variant="ghost" disabled={form.deductions.length >= 10} onClick={() => set("deductions", [...form.deductions, { id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...p.make(form.pay_period) }])}>
              <Icon name="plus" size={14} /> {p.label}
            </Button>
          ))}
        </div>
      </div>
      {form.deductions.length === 0 && <p className="muted">None — the barber keeps their full share.</p>}
      {form.deductions.map((d, i) => (
        <div className={`pay-deduction-row ${d.active ? "" : "off"}`} key={d.id} data-testid="pay-deduction">
          <label className="workspace-field"><span>Label</span><input value={d.label} maxLength={60} placeholder="e.g. Chair rent" onChange={(e) => upd(i, { label: e.target.value })} /></label>
          <label className="workspace-field"><span>Type</span>
            <select value={d.kind} onChange={(e) => upd(i, { kind: e.target.value as Deduction["kind"] })}>
              <option value="FIXED">Fixed amount</option>
              <option value="PERCENT_OF_TAKINGS">% of sales</option>
              <option value="PERCENT_OF_STAFF_SHARE">% of barber's share</option>
            </select>
          </label>
          {d.kind === "FIXED" ? (
            <>
              <label className="workspace-field narrow"><span>Amount ({currencySymbol()})</span><input type="number" min={0} step="0.01" value={pounds(d.amount_pence)} onChange={(e) => upd(i, { amount_pence: pence(e.target.value) })} /></label>
              <label className="workspace-field"><span>Per</span>
                <select value={d.cadence} onChange={(e) => upd(i, { cadence: e.target.value as Deduction["cadence"] })}>
                  <option value="WEEKLY">Week</option><option value="FORTNIGHTLY">Fortnight</option><option value="MONTHLY">Month</option><option value="PER_RUN">Pay run</option>
                </select>
              </label>
              {d.cadence !== "PER_RUN" && (
                <label className="workspace-field"><span>When periods differ</span>
                  <select value={d.proration} onChange={(e) => upd(i, { proration: e.target.value as Deduction["proration"] })}>
                    <option value="BY_DAYS">Prorate by day</option><option value="FULL">Charge whole periods</option>
                  </select>
                </label>
              )}
              {d.cadence !== "PER_RUN" && <label className="setup-check pay-deduction-check"><input type="checkbox" checked={!!d.waive_on_leave} onChange={(e) => upd(i, { waive_on_leave: e.target.checked ? 1 : 0 })} /><span>Waive on approved leave</span></label>}
            </>
          ) : (
            <label className="workspace-field narrow"><span>Rate (%)</span><input type="number" min={0} max={100} step="0.01" value={d.pct_x100 ? (d.pct_x100 / 100).toString() : ""} onChange={(e) => upd(i, { pct_x100: Math.max(0, Math.min(10000, Math.round(Number(e.target.value) * 100) || 0)) })} /></label>
          )}
          <label className="setup-check pay-deduction-check"><input type="checkbox" checked={!!d.active} onChange={(e) => upd(i, { active: e.target.checked ? 1 : 0 })} /><span>Active</span></label>
          <Button variant="ghost" aria-label={`Remove ${d.label || "deduction"}`} onClick={() => set("deductions", form.deductions.filter((_, j) => j !== i))}><Icon name="close" size={14} /></Button>
        </div>
      ))}
    </div>
  );
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
      <DeductionsEditor form={form} set={set} />
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
  input: { service_pence: number; tips_pence: number; visits: number; hours_x100: number; periods: number; days?: number; leave_days?: number };
  result: { commission_pence: number; base_pence: number; hourly_pence: number; tip_pence: number; rent_pence: number; adjustments_pence: number; net_pence: number; staff_share_pence: number; owner_share_pence: number; deductions: { label: string; pence: number; detail: string }[]; deductions_pence: number; owed_to_business_pence: number };
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
        <PayStatement
          barber={staff.name.split(" ")[0]}
          terms={preview.terms}
          input={preview.input}
          result={existing ? resultOfRun(existing) : { ...preview.result, adjustments_pence: preview.result.adjustments_pence + adjTotal, net_pence: preview.result.net_pence + adjTotal, owed_to_business_pence: preview.result.owed_to_business_pence - adjTotal }}
          adjustments={existing ? (JSON.parse(existing.adjustments_json) as { label: string; pence: number }[]) : adjust}
          split={existing ? { card: (existing.card_service_pence ?? 0), cash: (existing.cash_service_pence ?? 0) } : { card: preview.split?.card_service_pence ?? 0, cash: preview.split?.cash_service_pence ?? 0 }}
          showOwner={w.shop.pay_show_owner_share !== 0 || canEdit}
          onRemoveAdjustment={!existing && canEdit ? (i) => setAdjust(adjust.filter((_, j) => j !== i)) : undefined}
          frozen={!!existing}
        />
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
// Rebuild the engine result from a stored run (history and barber views).
export function resultOfRun(r: PayRun) {
  const staff_share_pence = r.staff_share_pence ?? (r.pay_model === "CHAIR_RENT" ? r.service_pence : r.commission_pence + r.base_pence + r.hourly_pence);
  let deductions: { label: string; pence: number; detail: string }[] = [];
  try { deductions = JSON.parse(r.deductions_json || "[]"); } catch { deductions = []; }
  if (!deductions.length && r.rent_pence) deductions = [{ label: "Chair rent", pence: r.rent_pence, detail: "" }];
  return {
    commission_pence: r.commission_pence, base_pence: r.base_pence, hourly_pence: r.hourly_pence, tip_pence: r.tip_pence, rent_pence: r.rent_pence,
    adjustments_pence: r.adjustments_pence, net_pence: r.net_pence, staff_share_pence,
    owner_share_pence: r.owner_share_pence ?? Math.max(0, r.service_pence - staff_share_pence),
    deductions, deductions_pence: r.deductions_pence ?? r.rent_pence,
    owed_to_business_pence: r.owed_to_business_pence ?? (Math.max(0, r.service_pence - staff_share_pence) + (r.deductions_pence ?? r.rent_pence) - r.adjustments_pence),
  };
}
type StatementResult = ReturnType<typeof resultOfRun>;
// The statement: how the number was reached, in the order an owner explains it to a barber.
export function PayStatement({ barber, terms, input, result, adjustments, split, showOwner, onRemoveAdjustment, frozen }: {
  barber: string; terms: PayForm; input: Preview["input"]; result: StatementResult; adjustments: { label: string; pence: number }[]; split?: { card: number; cash: number }; showOwner: boolean; onRemoveAdjustment?: (i: number) => void; frozen?: boolean;
}) {
  const shareLabel = terms.pay_model === "COMMISSION" ? (terms.commission_tiers.length ? "tiered commission" : `${terms.commission_pct}% of sales`) : terms.pay_model === "CHAIR_RENT" ? "keeps 100% of sales" : terms.pay_model === "HOURLY" ? `${(input.hours_x100 / 100).toFixed(1)} h × ${money(terms.hourly_pence)}` : terms.pay_model === "SALARY" ? "salary" : `base + ${terms.commission_pct}% above ${money(terms.commission_threshold_pence)}`;
  const ownerPct = terms.pay_model === "COMMISSION" && !terms.commission_tiers.length ? `${100 - terms.commission_pct}%` : "";
  const grossToStaff = result.staff_share_pence + result.tip_pence;
  const plus = adjustments.filter((a) => a.pence > 0), minus = adjustments.filter((a) => a.pence < 0);
  return (
    <dl className="pay-statement" aria-label="Pay run statement" data-testid="pay-statement">
      <div className="pay-statement-group">
        <Line label="Total sales (ledger)" value={money(input.service_pence)} sub={`${input.visits} paid visit${input.visits === 1 ? "" : "s"}${split ? ` · card ${money(split.card)} · cash ${money(split.cash)}` : ""}`} />
        <Line label="Tips" value={money(input.tips_pence)} />
      </div>
      <div className="pay-statement-group">
        <Line label={`${barber}'s share`} value={money(result.staff_share_pence)} sub={shareLabel} />
        <Line label={`Tips to ${barber}`} value={money(result.tip_pence)} sub={`${terms.tip_share_pct}%`} />
        <div className="pay-subtotal" data-testid="pay-gross"><dt>Gross to {barber}</dt><dd>{money(grossToStaff)}</dd></div>
      </div>
      {(result.deductions.length > 0 || adjustments.length > 0) && (
        <div className="pay-statement-group">
          {result.deductions.map((d, i) => <Line key={`d${i}`} label={d.label} value={`− ${money(d.pence)}`} sub={d.detail} />)}
          {minus.map((a) => { const i = adjustments.indexOf(a); return <Line key={`m${i}`} label={a.label} value={`− ${money(-a.pence)}`} sub="one-off" onRemove={onRemoveAdjustment ? () => onRemoveAdjustment(i) : undefined} />; })}
          {plus.map((a) => { const i = adjustments.indexOf(a); return <Line key={`p${i}`} label={a.label} value={`+ ${money(a.pence)}`} sub="one-off" onRemove={onRemoveAdjustment ? () => onRemoveAdjustment(i) : undefined} />; })}
        </div>
      )}
      <div className={`pay-net ${result.net_pence < 0 ? "negative" : ""}`} data-testid="pay-owed-staff">
        <dt>{result.net_pence < 0 ? `${barber} owes the shop` : `Owed to ${barber}`}</dt>
        <dd data-testid="pay-net">{money(Math.abs(result.net_pence))}</dd>
      </div>
      {showOwner && (
        <div className="pay-statement-group pay-owner" data-testid="pay-owed-business">
          <Line label={`Owner's share${ownerPct ? ` ${ownerPct}` : ""}`} value={money(result.owner_share_pence)} sub="sales less barber's share" />
          {result.deductions_pence > 0 && <Line label="Deductions" value={`+ ${money(result.deductions_pence)}`} />}
          {result.adjustments_pence !== 0 && <Line label={result.adjustments_pence > 0 ? "less one-off payments" : "one-off charges"} value={`${result.adjustments_pence > 0 ? "− " : "+ "}${money(Math.abs(result.adjustments_pence))}`} />}
          <div className="pay-subtotal strong"><dt>Owed to business</dt><dd>{money(result.owed_to_business_pence)}</dd></div>
        </div>
      )}
      {frozen && <p className="workspace-footnote pay-statement-group">Terms, shares and deductions were frozen when this run was created. Void and recreate to pick up changed terms.</p>}
    </dl>
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
// What foliyo moves by card versus what changes hands at the chair.
function Settlement({ card, cash, toBarber, toShop, reserve, residual, barber, status, ready }: { card: number; cash: number; toBarber: number; toShop: number; reserve: number; residual: number; barber: string; status?: PayRun["status"]; ready: boolean }) {
  if (card === 0 && cash === 0) return null;
  const sent = status === "TRANSFERRED" || status === "PAID";
  return (
    <section className="pay-settlement" aria-label="How this is settled" data-testid="pay-settlement">
      <div className="pay-settlement-col">
        <h4>
          <Icon name="card" size={14} /> By card · {money(card)}
        </h4>
        <p className="workspace-footnote">Held on foliyo's Stripe balance. {sent ? "Sent" : "Approving sends it"} to each Stripe account; their bank gets it on their payout schedule.</p>
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
            <Icon name="hourglass" size={13} /> {barber} hasn’t finished Stripe setup — their share stays on foliyo until they do. Team → {barber} → Set up payouts.
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
