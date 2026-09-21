// Pay Runs (owner/manager): everyone for one period, create drafts in one go, open a barber to
// approve. My pay (barber): their deal, this period's live estimate, statements, payout account.
import { useEffect, useMemo, useState } from "react";
import type { PayPeriod, PayRun, Staff, WorkspaceData } from "../server/domain";
import { Button, Icon, Notice, StatusPill } from "./ui";
import { money, datePlus } from "./fixtures";
import { PAY_MODELS, PayStatement, payFormOf, resultOfRun, summariseTerms, describeDeduction } from "./Pay";
import { BarberPayoutCard } from "./Payouts";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const fmt = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(d + "T12:00:00Z"));
function bounds(period: PayPeriod, today: string, offset: number) {
  if (period === "MONTHLY") {
    const d = new Date(today + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + offset, 1);
    const from = d.toISOString().slice(0, 10); d.setUTCMonth(d.getUTCMonth() + 1, 0);
    return { from, to: d.toISOString().slice(0, 10) };
  }
  const len = period === "WEEKLY" ? 7 : 14;
  const dow = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7;
  const monday = datePlus(today, -dow + offset * len);
  return { from: monday, to: datePlus(monday, len - 1) };
}
const tone: Record<PayRun["status"], "good" | "next" | "paid" | "warn" | "note"> = { DRAFT: "note", APPROVED: "next", TRANSFERRED: "good", PAID: "good", VOID: "warn" };
const label: Record<PayRun["status"], string> = { DRAFT: "draft", APPROVED: "approved", TRANSFERRED: "sent to Stripe", PAID: "settled", VOID: "void" };

type PeriodRow = { staff_id: string; name: string; pay_model: string; existing: PayRun | null; sales_pence: number; tips_pence: number; visits: number; owed_to_staff_pence: number; owed_to_business_pence: number; deductions_pence: number; has_activity: boolean };

export function PayRunsPage({ w, api, onOpenBarber }: { w: WorkspaceData; api: Api; onOpenBarber: (staffId: string) => void }) {
  const [period, setPeriod] = useState<PayPeriod>("WEEKLY");
  const [offset, setOffset] = useState(-1);
  const b = bounds(period, w.today, offset);
  const [d, setD] = useState<{ rows: PeriodRow[] } | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const load = () => api<{ rows: PeriodRow[] }>(`/pay-runs/period?from=${b.from}&to=${b.to}`).then(setD).catch(() => setD({ rows: [] }));
  useEffect(() => { setD(null); void load(); }, [b.from, b.to]);
  const rows = d?.rows ?? [];
  const totals = rows.reduce((a, r) => ({ sales: a.sales + r.sales_pence, staff: a.staff + r.owed_to_staff_pence, biz: a.biz + r.owed_to_business_pence }), { sales: 0, staff: 0, biz: 0 });
  const todo = rows.filter((r) => r.has_activity && !r.existing);
  const act = async (fn: () => Promise<unknown>, what: string) => { setBusy(what); setMsg(""); try { const r = (await fn()) as { created?: number; skipped?: { name: string; why: string }[] }; if (r?.created != null) setMsg(`${r.created} draft${r.created === 1 ? "" : "s"} created${r.skipped?.length ? ` · skipped ${r.skipped.map((s) => `${s.name} (${s.why})`).join(", ")}` : ""}.`); await load(); } catch (e) { setMsg(e instanceof Error ? e.message : "Failed"); } finally { setBusy(""); } };
  return (
    <section className="pay-runs-page" data-testid="pay-runs-page">
      <div className="toolbar pay-period-bar">
        <div className="segmented" role="tablist" aria-label="Pay period">{(["WEEKLY", "FORTNIGHTLY", "MONTHLY"] as PayPeriod[]).map((p) => <button key={p} type="button" role="tab" aria-selected={period === p} onClick={() => { setPeriod(p); setOffset(-1); }}>{p[0] + p.slice(1).toLowerCase()}</button>)}</div>
        <Button variant="ghost" className="icon-only" aria-label="Previous period" onClick={() => setOffset((o) => o - 1)}><Icon name="left" /></Button>
        <strong className="pay-period-label">{fmt(b.from)} – {fmt(b.to)}<small>{offset === 0 ? " · current" : offset === -1 ? " · last period" : ""}</small></strong>
        <Button variant="ghost" className="icon-only" aria-label="Next period" disabled={offset >= 0} onClick={() => setOffset((o) => Math.min(0, o + 1))}><Icon name="right" /></Button>
        <span className="toolbar-grow" />
        {todo.length > 0 && <Button disabled={!!busy} data-testid="bulk-create" onClick={() => act(() => api("/pay-runs/bulk", "POST", { from: b.from, to: b.to }), "bulk")}><Icon name="file" size={16} /> {busy === "bulk" ? "Creating…" : `Create ${todo.length} draft${todo.length === 1 ? "" : "s"}`}</Button>}
        <a className="button ghost" href={`/api/app/pay-runs/export.csv?from=${b.from}&to=${b.to}`} download><Icon name="download" size={14} /> CSV</a>
      </div>
      {msg && <p className="workspace-footnote" role="status" data-testid="pay-runs-msg">{msg}</p>}
      {!d ? <p className="workspace-footnote">Calculating…</p> : rows.length === 0 ? <Notice>No active barbers.</Notice> : (
        <table className="pay-runs-table" data-testid="pay-runs-table">
          <thead><tr><th>Barber</th><th>Deal</th><th className="num">Sales</th><th className="num">Deductions</th><th className="num">Owed to barber</th><th className="num">Owed to business</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.staff_id} className={r.has_activity ? "" : "quiet"} data-testid="pay-runs-row">
                <td><strong>{r.name}</strong></td>
                <td><small>{PAY_MODELS.find((m) => m.key === r.pay_model)?.label}</small></td>
                <td className="num">{money(r.sales_pence)}<br /><small className="muted">{r.visits} visit{r.visits === 1 ? "" : "s"} · tips {money(r.tips_pence)}</small></td>
                <td className="num">{r.deductions_pence ? `− ${money(r.deductions_pence)}` : "—"}</td>
                <td className={`num ${r.owed_to_staff_pence < 0 ? "neg" : ""}`}>{r.owed_to_staff_pence < 0 ? `owes ${money(-r.owed_to_staff_pence)}` : money(r.owed_to_staff_pence)}</td>
                <td className="num">{money(r.owed_to_business_pence)}</td>
                <td>{r.existing ? <StatusPill tone={tone[r.existing.status]}>{label[r.existing.status]}</StatusPill> : r.has_activity ? <small className="muted">not created</small> : <small className="muted">nothing to pay</small>}</td>
                <td><Button variant="secondary" onClick={() => onOpenBarber(r.staff_id)}>{r.existing ? "Open" : "Review"}</Button></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={2}><strong>Totals</strong></td><td className="num">{money(totals.sales)}</td><td /><td className="num" data-testid="pay-runs-total-staff">{money(totals.staff)}</td><td className="num" data-testid="pay-runs-total-biz">{money(totals.biz)}</td><td colSpan={2} /></tr></tfoot>
        </table>
      )}
      <p className="workspace-footnote">Figures for barbers without a run are live estimates from the ledger and their current terms. Once a draft exists the numbers are frozen. Open a barber to add one-off adjustments, approve, or mark paid.</p>
    </section>
  );
}

// ---- Barber: My pay ---------------------------------------------------------------------------------
type Preview = { terms: ReturnType<typeof payFormOf>; input: { service_pence: number; tips_pence: number; visits: number; hours_x100: number; periods: number; days?: number; leave_days?: number }; result: ReturnType<typeof resultOfRun>; split?: { card_service_pence: number; cash_service_pence: number } };
export function MyPay({ w, api }: { w: WorkspaceData; api: Api }) {
  const me = useMemo(() => w.staff.find((s) => s.id === w.account?.staff_id) ?? null, [w.staff, w.account]);
  const [runs, setRuns] = useState<PayRun[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const period = me?.pay_period ?? "WEEKLY";
  const cur = bounds(period, w.today, 0);
  useEffect(() => {
    if (!me) return;
    api<{ pay_runs: PayRun[] }>("/pay-runs").then((r) => setRuns(r.pay_runs)).catch(() => {});
    api<Preview>(`/pay-runs/preview?staff_id=${me.id}&from=${cur.from}&to=${cur.to}`).then(setPreview).catch((e) => setErr(e instanceof Error ? e.message : "Could not calculate"));
  }, [me?.id, me?.version, cur.from, cur.to, w.payments.length]);
  if (!me) return <Notice>Your login isn't linked to a chair yet — ask the owner to connect your account under Team.</Notice>;
  const form = payFormOf(me);
  const showOwner = w.shop.pay_show_owner_share !== 0;
  const first = me.name.split(" ")[0];
  return (
    <section className="my-pay" data-testid="my-pay">
      <div className="admin-two">
        <div className="workspace-panel">
          <h3>Your deal</h3>
          <p className="pay-summary"><Icon name="wallet" size={14} /> {summariseTerms(form)} · tips {form.tip_share_pct}% to you · {form.employment === "EMPLOYED" ? "employed" : "self-employed"} · paid {form.pay_period.toLowerCase()}</p>
          {form.deductions.filter((d) => d.active).length > 0 && (
            <ul className="admin-list" data-testid="my-pay-deductions">{form.deductions.filter((d) => d.active).map((d) => <li key={d.id}><strong>{d.label}</strong> · {describeDeduction(d)}</li>)}</ul>
          )}
          {form.pay_notes && <p className="workspace-footnote">{form.pay_notes}</p>}
        </div>
        <div className="workspace-panel">
          <h3>This period so far <small className="muted">· {fmt(cur.from)} – {fmt(cur.to)}</small></h3>
          {err && <p className="workspace-error">{err}</p>}
          {preview ? <PayStatement barber={first} terms={preview.terms} input={preview.input} result={preview.result} adjustments={[]} split={{ card: preview.split?.card_service_pence ?? 0, cash: preview.split?.cash_service_pence ?? 0 }} showOwner={showOwner} /> : <p className="workspace-footnote">Calculating…</p>}
          <p className="workspace-footnote">Live estimate from what's been recorded at checkout. Your statement is final once the owner creates the pay run.</p>
        </div>
      </div>
      <div className="workspace-panel">
        <h3>Statements</h3>
        {runs.length === 0 ? <p className="muted">No pay runs yet.</p> : (
          <table className="pay-history-table" data-testid="my-pay-history">
            <thead><tr><th>Period</th><th className="num">Sales</th><th className="num">Owed to you</th><th>Status</th><th /></tr></thead>
            <tbody>
              {runs.map((r) => (
                <>
                  <tr key={r.id} className={r.status === "VOID" ? "voided" : ""} data-testid="my-pay-run">
                    <td>{fmt(r.period_from)} – {fmt(r.period_to)}</td>
                    <td className="num">{money(r.service_pence)}</td>
                    <td className="num">{r.net_pence < 0 ? `you owe ${money(-r.net_pence)}` : money(r.net_pence)}</td>
                    <td><StatusPill tone={tone[r.status]}>{label[r.status]}</StatusPill></td>
                    <td className="admin-actions"><Button variant="ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "Hide" : "Breakdown"}</Button>{r.view_token && <a className="button ghost" href={`/pay-run/${r.id}?t=${r.view_token}`} target="_blank" rel="noreferrer">Print</a>}</td>
                  </tr>
                  {open === r.id && (
                    <tr key={r.id + "x"} className="my-pay-detail"><td colSpan={5}>
                      <PayStatement barber={first} terms={{ ...form, ...(JSON.parse(r.terms_json) as Partial<typeof form>) }} input={{ service_pence: r.service_pence, tips_pence: r.tips_pence, visits: r.visits, hours_x100: r.hours_x100, periods: 1 }} result={resultOfRun(r)} adjustments={JSON.parse(r.adjustments_json)} split={{ card: r.card_service_pence ?? 0, cash: r.cash_service_pence ?? 0 }} showOwner={showOwner} frozen />
                    </td></tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <BarberPayoutCard api={api} staffId={me.id} staffName={me.name} canEdit={false} from={cur.from} to={cur.to} earned={preview?.result.net_pence ?? 0} cash={preview?.split?.cash_service_pence ?? 0} />
    </section>
  );
}
export type { Staff };
