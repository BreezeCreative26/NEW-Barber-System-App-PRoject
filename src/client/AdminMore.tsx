import { useEffect, useState, type FormEvent } from "react";
import { Button, Notice, StatusPill } from "./ui";
import { money } from "./fixtures";
import { adminApi, when, tone, label, InvoiceTable, ReasonAction, type AdminInvoice } from "./Admin";

// Admin: billing catalogue (plans, features, discounts, platform settings), invoices across shops,
// ops health, and the admin team. Every write asks for a reason and lands in admin_audit.

type Plan = { id: string; name: string; monthly_pence: number; included_seats: number; seat_pence: number; active: number };
type Feature = { key: string; name: string; description: string; kind: string; monthly_pence: number; unit: string; unit_pence: number; included_units: number; in_plan: number; active: number };
type Discount = { id: string; code: string; name: string; kind: string; value: number; applies_to: string; duration: string; duration_months: number; max_redemptions: number | null; redeemed: number; ends_at: number | null; active: number; shops: number; note: string };
type Platform = { vat_mode: string; vat_number: string; trial_days: number; grace_days: number; vat_threshold_pence: number; invoice_prefix: string; due_days: number; company_name: string; company_address: string; company_email: string; company_number: string; bank_details: string; invoice_footer: string; last_period_close: string };

function useForm(onDone: () => void) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (fn: (f: FormData) => Promise<void>) => async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setBusy(true); setErr("");
    const form = e.currentTarget;
    try { await fn(new FormData(form)); form.reset(); onDone(); } catch (x) { setErr(x instanceof Error ? x.message : "Failed"); } finally { setBusy(false); }
  };
  return { err, busy, submit };
}
const Reason = () => <label className="workspace-field"><span>Reason</span><input name="reason" required minLength={5} maxLength={300} /></label>;

export function AdminCatalogue({ me }: { me: { role: string } }) {
  const [d, setD] = useState<{ plans: Plan[]; features: Feature[]; discounts: Discount[]; platform: Platform } | null>(null);
  const load = () => adminApi<typeof d>("/catalogue").then(setD);
  useEffect(() => { void load(); }, []);
  const f = useForm(load);
  const superUser = me.role === "SUPER";
  const finance = superUser || me.role === "FINANCE";
  if (!d) return <p className="workspace-footnote">Loading…</p>;
  return (
    <section className="admin-section" data-testid="admin-catalogue">
      <h1>Billing catalogue</h1>
      <Notice>Prices here are what shops are charged from their next invoice. Existing estimates update immediately; Stripe prices are re-published when Stripe Billing is connected. VAT mode: <strong>{d.platform.vat_mode === "NONE" ? "none (not VAT-registered)" : d.platform.vat_mode}</strong>.</Notice>
      {f.err && <p className="workspace-error" role="alert">{f.err}</p>}

      <div className="admin-two">
        <div className="workspace-panel">
          <h3>Plans</h3>
          {d.plans.map((p) => (
            <form key={p.id} className="admin-inline-form" onSubmit={f.submit(async (fd) => adminApi(`/catalogue/plans/${p.id}`, "PUT", { name: String(fd.get("name")), monthly_pence: Math.round(Number(fd.get("monthly")) * 100), included_seats: Number(fd.get("included")), seat_pence: Math.round(Number(fd.get("seat")) * 100), active: fd.get("active") === "on", reason: String(fd.get("reason")) }))}>
              <fieldset disabled={!superUser || f.busy}>
                <legend><code>{p.id}</code></legend>
                <div className="workspace-form-grid four">
                  <label className="workspace-field"><span>Name</span><input name="name" defaultValue={p.name} required /></label>
                  <label className="workspace-field"><span>Monthly (£)</span><input name="monthly" type="number" step="0.01" min="0" defaultValue={(p.monthly_pence / 100).toFixed(2)} /></label>
                  <label className="workspace-field"><span>Seats included</span><input name="included" type="number" min="0" defaultValue={p.included_seats} /></label>
                  <label className="workspace-field"><span>Extra seat (£)</span><input name="seat" type="number" step="0.01" min="0" defaultValue={(p.seat_pence / 100).toFixed(2)} /></label>
                </div>
                <label className="workspace-check"><input type="checkbox" name="active" defaultChecked={!!p.active} /> Available to new shops</label>
                {superUser && <><Reason /><div className="workspace-save-actions"><Button type="submit">Save plan</Button></div></>}
              </fieldset>
            </form>
          ))}
        </div>
        <div className="workspace-panel">
          <h3>Platform</h3>
          <form className="admin-inline-form" data-testid="admin-platform-form" onSubmit={f.submit(async (fd) => adminApi("/catalogue/platform", "PUT", {
            vat_mode: String(fd.get("vat_mode")), vat_number: String(fd.get("vat_number") || ""), trial_days: Number(fd.get("trial_days")), grace_days: Number(fd.get("grace_days")),
            invoice_prefix: String(fd.get("invoice_prefix") || "OLLO-"), due_days: Number(fd.get("due_days")), company_name: String(fd.get("company_name") || "OLLO"), company_address: String(fd.get("company_address") || ""),
            company_email: String(fd.get("company_email") || ""), company_number: String(fd.get("company_number") || ""), bank_details: String(fd.get("bank_details") || ""), invoice_footer: String(fd.get("invoice_footer") || ""),
            reason: String(fd.get("reason")) }))}>
            <fieldset disabled={!superUser || f.busy}>
              <div className="workspace-form-grid">
                <label className="workspace-field"><span>VAT</span><select name="vat_mode" defaultValue={d.platform.vat_mode}><option value="NONE">None — not VAT-registered</option><option value="UK_20">UK 20% on invoices</option><option value="STRIPE_TAX">Stripe Tax (automatic)</option></select></label>
                <label className="workspace-field"><span>VAT number</span><input name="vat_number" defaultValue={d.platform.vat_number} placeholder="GB…" /></label>
                <label className="workspace-field"><span>Trial days</span><input name="trial_days" type="number" min="0" max="90" defaultValue={d.platform.trial_days} /></label>
                <label className="workspace-field"><span>Overdue grace days</span><input name="grace_days" type="number" min="0" max="60" defaultValue={d.platform.grace_days} /></label>
              </div>
              <h4>On every invoice</h4>
              <div className="workspace-form-grid">
                <label className="workspace-field"><span>Company name</span><input name="company_name" defaultValue={d.platform.company_name} maxLength={80} /></label>
                <label className="workspace-field"><span>Company number</span><input name="company_number" defaultValue={d.platform.company_number} maxLength={40} /></label>
                <label className="workspace-field"><span>Billing email</span><input name="company_email" type="email" defaultValue={d.platform.company_email} /></label>
                <label className="workspace-field"><span>Invoice prefix</span><input name="invoice_prefix" defaultValue={d.platform.invoice_prefix} maxLength={12} /></label>
                <label className="workspace-field"><span>Payment terms (days)</span><input name="due_days" type="number" min="0" max="60" defaultValue={d.platform.due_days} /></label>
              </div>
              <label className="workspace-field"><span>Address</span><textarea name="company_address" rows={2} defaultValue={d.platform.company_address} maxLength={400} /></label>
              <label className="workspace-field"><span>Bank details for transfers (shown on open invoices)</span><textarea name="bank_details" rows={3} defaultValue={d.platform.bank_details} maxLength={600} placeholder={"Account name: …\nSort code: 00-00-00\nAccount number: 00000000"} /></label>
              <label className="workspace-field"><span>Footer line</span><input name="invoice_footer" defaultValue={d.platform.invoice_footer} maxLength={300} /></label>
              {superUser && <><Reason /><div className="workspace-save-actions"><Button type="submit">Save platform settings</Button></div></>}
            </fieldset>
          </form>
        </div>
      </div>

      <div className="workspace-panel">
        <h3>Features & add-ons</h3>
        <table className="admin-table">
          <thead><tr><th>Feature</th><th>Kind</th><th>Monthly</th><th>Per unit</th><th>Included</th><th>In plan</th><th>Active</th>{superUser && <th />}</tr></thead>
          <tbody>
            {d.features.map((x) => (
              <tr key={x.key}>
                <td colSpan={superUser ? 8 : 7} className="admin-feature-row">
                  <form className="admin-feature-form" onSubmit={f.submit(async (fd) => adminApi(`/catalogue/features/${x.key}`, "PUT", { name: String(fd.get("name")), description: String(fd.get("description")), monthly_pence: Math.round(Number(fd.get("monthly")) * 100), unit_pence: Number(fd.get("unit_pence")), included_units: Number(fd.get("included")), in_plan: fd.get("in_plan") === "on", active: fd.get("active") === "on", reason: String(fd.get("reason")) }))}>
                    <fieldset disabled={!superUser || f.busy}>
                      <div className="admin-feature-grid">
                        <label className="workspace-field"><span>Name · <code>{x.key}</code></span><input name="name" defaultValue={x.name} required /></label>
                        <label className="workspace-field"><span>Description</span><input name="description" defaultValue={x.description} /></label>
                        <span className="workspace-field"><span>Kind</span><StatusPill tone="note">{x.kind}</StatusPill></span>
                        <label className="workspace-field"><span>Monthly (£)</span><input name="monthly" type="number" step="0.01" min="0" defaultValue={(x.monthly_pence / 100).toFixed(2)} /></label>
                        <label className="workspace-field"><span>Per {x.unit || "unit"} (p)</span><input name="unit_pence" type="number" min="0" defaultValue={x.unit_pence} disabled={!x.unit} /></label>
                        <label className="workspace-field"><span>Included {x.unit ? x.unit + "s" : ""}</span><input name="included" type="number" min="0" defaultValue={x.included_units} disabled={!x.unit} /></label>
                        <label className="workspace-check"><input type="checkbox" name="in_plan" defaultChecked={!!x.in_plan} /> In plan</label>
                        <label className="workspace-check"><input type="checkbox" name="active" defaultChecked={!!x.active} /> Active</label>
                        {superUser && <label className="workspace-field"><span>Reason</span><input name="reason" required minLength={5} /></label>}
                        {superUser && <Button type="submit" variant="secondary">Save</Button>}
                      </div>
                    </fieldset>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="admin-two">
        <div className="workspace-panel">
          <h3>Discount codes</h3>
          <table className="admin-table small" data-testid="admin-discounts">
            <thead><tr><th>Code</th><th>What</th><th>Applies</th><th>Used</th><th>Ends</th><th>Status</th>{finance && <th />}</tr></thead>
            <tbody>
              {d.discounts.length === 0 && <tr><td colSpan={7} className="muted">No codes yet.</td></tr>}
              {d.discounts.map((x) => (
                <tr key={x.id}>
                  <td><code>{x.code}</code><br /><small>{x.name}</small></td>
                  <td>{x.kind === "PERCENT" ? `${x.value}% off` : x.kind === "FIXED" ? `${money(x.value)} off` : x.kind === "FREE_MONTHS" ? `${x.value} month${x.value === 1 ? "" : "s"} free` : `${x.value} seat${x.value === 1 ? "" : "s"} free`}<br /><small>{x.duration === "ONCE" ? "once" : x.duration === "FOREVER" ? "forever" : `${x.duration_months} months`}</small></td>
                  <td>{x.applies_to}</td>
                  <td>{x.redeemed}{x.max_redemptions ? ` / ${x.max_redemptions}` : ""}<br /><small>{x.shops} shop{x.shops === 1 ? "" : "s"}</small></td>
                  <td>{when(x.ends_at)}</td>
                  <td><StatusPill tone={x.active ? "good" : "note"}>{x.active ? "Active" : "Off"}</StatusPill></td>
                  {finance && <td>{x.active && <form onSubmit={f.submit(async (fd) => adminApi(`/catalogue/discounts/${x.id}/deactivate`, "POST", { reason: String(fd.get("reason")) }))} className="admin-mini-form"><input name="reason" required minLength={5} placeholder="Reason" /><Button type="submit" variant="ghost">Deactivate</Button></form>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {finance && (
          <div className="workspace-panel">
            <h3>New discount code</h3>
            <form className="workspace-form" data-testid="admin-new-discount" onSubmit={f.submit(async (fd) => adminApi("/catalogue/discounts", "POST", { code: String(fd.get("code")), name: String(fd.get("name")), kind: String(fd.get("kind")), value: Number(fd.get("value")), applies_to: String(fd.get("applies_to")), duration: String(fd.get("duration")), duration_months: Number(fd.get("duration_months") || 1), max_redemptions: fd.get("max") ? Number(fd.get("max")) : null, ends_at: fd.get("ends") ? Date.parse(String(fd.get("ends")) + "T23:59:59Z") : null, note: String(fd.get("note") || ""), reason: String(fd.get("reason")) }))}>
              <div className="workspace-form-grid">
                <label className="workspace-field"><span>Code</span><input name="code" required pattern="[A-Za-z0-9_\-]+" placeholder="LAUNCH50" /></label>
                <label className="workspace-field"><span>Name</span><input name="name" required placeholder="Launch offer" /></label>
                <label className="workspace-field"><span>Type</span><select name="kind"><option value="PERCENT">Percent off</option><option value="FIXED">Fixed £ off (pence)</option><option value="FREE_MONTHS">Free months</option><option value="SEATS_FREE">Free seats</option></select></label>
                <label className="workspace-field"><span>Value</span><input name="value" type="number" min="0" required placeholder="50 (%), 500 (pence), 1 (month/seat)" /></label>
                <label className="workspace-field"><span>Applies to</span><select name="applies_to"><option value="ALL">Whole invoice</option><option value="PLAN">Plan only</option>{d.features.filter((x) => x.monthly_pence > 0).map((x) => <option key={x.key} value={`FEATURE:${x.key}`}>{x.name}</option>)}</select></label>
                <label className="workspace-field"><span>Duration</span><select name="duration"><option value="ONCE">One invoice</option><option value="REPEATING">N months</option><option value="FOREVER">Forever</option></select></label>
                <label className="workspace-field"><span>Months (if repeating)</span><input name="duration_months" type="number" min="1" defaultValue={3} /></label>
                <label className="workspace-field"><span>Max redemptions</span><input name="max" type="number" min="1" placeholder="unlimited" /></label>
                <label className="workspace-field"><span>Ends</span><input name="ends" type="date" /></label>
                <label className="workspace-field"><span>Internal note</span><input name="note" /></label>
              </div>
              <Reason />
              <div className="workspace-save-actions"><Button type="submit" disabled={f.busy}>Create code</Button></div>
            </form>
          </div>
        )}
      </div>
    </section>
  );
}

type InvoiceStats = { outstanding_pence: number; overdue_pence: number; overdue_n: number; paid_30d_pence: number; issued_ytd_pence: number; written_off_pence: number; credits_pence: number; charges_pence: number; last_period_close: string; closable_period: string };
export function AdminInvoices({ onShop, me }: { onShop: (id: string) => void; me: { role: string } }) {
  const [status, setStatus] = useState(() => sessionStorage.getItem("admin.invoices.status") ?? "");
  const [q, setQ] = useState("");
  const [d, setD] = useState<{ invoices: AdminInvoice[]; pending_adjustments: { id: string; shop_id: string; shop_name: string; kind: string; amount_pence: number; reason: string; created_at: number }[]; stats: InvoiceStats } | null>(null);
  const [run, setRun] = useState<{ period: string; issued: { shop: string; number: string; total_pence: number }[]; skipped: { shop: string; why: string }[]; errors: { shop: string; error: string }[]; dunning: { overdue: number; flipped: number } } | null>(null);
  const load = () => adminApi<typeof d>(`/invoices?status=${status}&q=${encodeURIComponent(q)}`).then(setD);
  useEffect(() => { sessionStorage.setItem("admin.invoices.status", status); const t = setTimeout(() => void load(), q ? 250 : 0); return () => clearTimeout(t); }, [status, q]);
  if (!d) return <p className="workspace-footnote">Loading…</p>;
  const finance = me.role === "SUPER" || me.role === "FINANCE";
  const st = d.stats;
  const closeDue = st.last_period_close < st.closable_period;
  return (
    <section className="admin-section" data-testid="admin-invoices">
      <header className="admin-section-head">
        <h1>Invoices <small>{d.invoices.length} shown</small></h1>
        <div className="toolbar">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number or shop" aria-label="Search invoices" />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All</option><option value="OPEN">Open</option><option value="OVERDUE">Overdue</option><option value="PAID">Paid</option><option value="UNCOLLECTIBLE">Written off</option><option value="VOID">Void</option></select>
          {finance && <ReasonAction title={closeDue ? `Run month close · ${st.closable_period}` : "Re-run month close"} cta="Issue invoices" fields={<>
            <label className="workspace-field"><span>Period</span><input name="period" type="month" defaultValue={st.closable_period} max={st.closable_period} required /></label>
            <p className="workspace-footnote">Issues one invoice per paying shop for that month (plan, seats, add-ons, usage, discounts, pending credits and charges), emails them, and flags overdue invoices. Safe to run twice — shops already invoiced are skipped.</p>
          </>} onSubmit={async (reason, f) => { setRun(await adminApi(`/invoices/run`, "POST", { period: String(f.get("period")), reason })); await load(); }} />}
        </div>
      </header>
      {closeDue && finance && <Notice tone="warning" icon="alert">Month close for <strong>{st.closable_period}</strong> hasn't been run yet{st.last_period_close ? ` (last: ${st.last_period_close})` : ""}. Run it to issue last month's invoices.</Notice>}
      {run && (
        <Notice tone="success" icon="check" data-testid="admin-run-result">
          <strong>{run.period}:</strong> {run.issued.length} issued ({money(run.issued.reduce((n, i) => n + i.total_pence, 0))}), {run.skipped.length} skipped{run.errors.length ? `, ${run.errors.length} errors` : ""}. {run.dunning.flipped ? `${run.dunning.flipped} shop${run.dunning.flipped === 1 ? "" : "s"} marked overdue.` : ""}
          {run.errors.length > 0 && <ul className="admin-list">{run.errors.map((e, i) => <li key={i}>{e.shop}: {e.error}</li>)}</ul>}
        </Notice>
      )}
      <div className="admin-tiles" data-testid="admin-invoice-stats">
        <div className="admin-tile"><small>Outstanding</small><strong>{money(st.outstanding_pence)}</strong><span>open invoices</span></div>
        <div className={`admin-tile ${st.overdue_n ? "warn" : ""}`}><small>Overdue</small><strong>{money(st.overdue_pence)}</strong><span>{st.overdue_n} invoice{st.overdue_n === 1 ? "" : "s"}</span></div>
        <div className="admin-tile"><small>Collected · 30d</small><strong>{money(st.paid_30d_pence)}</strong></div>
        <div className="admin-tile"><small>Issued this year</small><strong>{money(st.issued_ytd_pence)}</strong><span>{st.written_off_pence ? `${money(st.written_off_pence)} written off` : "nothing written off"}</span></div>
      </div>
      {d.invoices.length === 0 ? <Notice>No invoices match. Invoices are issued at month close for every shop past its trial, or by hand from a shop's Billing tab.</Notice> : <InvoiceTable invoices={d.invoices} finance={finance} onChanged={load} showShop onShop={onShop} />}
      <h2>Pending on next invoices <small className="muted">· {money(st.credits_pence)} credit · {money(st.charges_pence)} charges</small></h2>
      {d.pending_adjustments.length === 0 ? <p className="muted">None.</p> : (
        <table className="admin-table small"><tbody>{d.pending_adjustments.map((a) => <tr key={a.id}><td><button type="button" className="linklike" onClick={() => onShop(a.shop_id)}>{a.shop_name}</button></td><td>{a.kind === "CREDIT" ? "Credit" : "Charge"}</td><td className="num">{money(a.amount_pence)}</td><td>{a.reason}</td><td>{when(a.created_at)}</td></tr>)}</tbody></table>
      )}
    </section>
  );
}

export function AdminOps({ onShop }: { onShop: (id: string) => void }) {
  const [d, setD] = useState<{ providers: Record<string, unknown>; failed_messages_7d: { id: string; shop_id: string; shop_name: string; channel: string; recipient: string; template: string; error: string; created_at: number }[]; queued: number; stripe_events_7d: { type: string; n: number; last: number }[]; usage_unreported: { n: number; pence: number } } | null>(null);
  useEffect(() => { adminApi<typeof d>("/ops").then(setD); }, []);
  if (!d) return <p className="workspace-footnote">Loading…</p>;
  return (
    <section className="admin-section" data-testid="admin-ops">
      <h1>Ops</h1>
      <div className="admin-tiles">
        <div className="admin-tile"><small>Messages queued</small><strong>{d.queued}</strong></div>
        <div className={`admin-tile ${d.failed_messages_7d.length ? "warn" : ""}`}><small>Failed messages · 7d</small><strong>{d.failed_messages_7d.length}</strong></div>
        <div className="admin-tile"><small>Usage not yet on Stripe</small><strong>{d.usage_unreported.n}</strong><span>{money(d.usage_unreported.pence)}</span></div>
      </div>
      <h2>Providers</h2><pre className="admin-pre">{JSON.stringify(d.providers, null, 2)}</pre>
      <h2>Failed messages</h2>
      {d.failed_messages_7d.length === 0 ? <p className="muted">None in the last 7 days.</p> : <table className="admin-table small"><thead><tr><th>When</th><th>Shop</th><th>Channel</th><th>To</th><th>Template</th><th>Error</th></tr></thead><tbody>{d.failed_messages_7d.map((m) => <tr key={m.id}><td>{when(m.created_at)}</td><td><button type="button" className="linklike" onClick={() => onShop(m.shop_id)}>{m.shop_name}</button></td><td>{m.channel}</td><td>{m.recipient}</td><td>{m.template}</td><td><small>{m.error}</small></td></tr>)}</tbody></table>}
      <h2>Stripe webhooks · 7d</h2>
      {d.stripe_events_7d.length === 0 ? <p className="muted">None received.</p> : <table className="admin-table small"><tbody>{d.stripe_events_7d.map((e) => <tr key={e.type}><td>{e.type}</td><td className="num">{e.n}</td><td>{when(e.last)}</td></tr>)}</tbody></table>}
    </section>
  );
}

export function AdminTeam({ me }: { me: { role: string } }) {
  const [d, setD] = useState<{ admins: { user_id: string; role: string; created_at: number; name: string; email: string }[] } | null>(null);
  const load = () => adminApi<typeof d>("/team").then(setD);
  useEffect(() => { void load(); }, []);
  const f = useForm(load);
  if (!d) return <p className="workspace-footnote">Loading…</p>;
  return (
    <section className="admin-section" data-testid="admin-team">
      <h1>Admin team</h1>
      <table className="admin-table small"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Since</th>{me.role === "SUPER" && <th />}</tr></thead>
        <tbody>{d.admins.map((a) => <tr key={a.user_id}><td>{a.name}</td><td>{a.email}</td><td><code>{a.role}</code></td><td>{when(a.created_at)}</td>{me.role === "SUPER" && <td><Button variant="ghost" onClick={async () => { if (confirm(`Remove ${a.name} from admin?`)) { await adminApi(`/team/${a.user_id}`, "DELETE"); await load(); } }}>Remove</Button></td>}</tr>)}</tbody></table>
      {me.role === "SUPER" && (
        <form className="workspace-form admin-inline-form" onSubmit={f.submit(async (fd) => adminApi("/team", "POST", { email: String(fd.get("email")), role: String(fd.get("role")), reason: String(fd.get("reason")) }))}>
          <h3>Add or change an admin</h3>
          <div className="workspace-form-grid">
            <label className="workspace-field"><span>Email (existing OLLO account)</span><input name="email" type="email" required /></label>
            <label className="workspace-field"><span>Role</span><select name="role" defaultValue="SUPPORT"><option value="SUPPORT">Support — read, notes, grants, open as owner</option><option value="FINANCE">Finance — plus invoices, discounts, subscription changes</option><option value="SUPER">Super — everything incl. prices and admins</option></select></label>
          </div>
          <Reason />
          {f.err && <p className="workspace-error" role="alert">{f.err}</p>}
          <div className="workspace-save-actions"><Button type="submit" disabled={f.busy}>Save</Button></div>
        </form>
      )}
    </section>
  );
}
