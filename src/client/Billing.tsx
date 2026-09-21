import { useEffect, useState } from "react";
import { Button, Icon, Notice, StatusPill } from "./ui";
import { money } from "./fixtures";

// Settings → Billing: what the shop pays OLLO. Plan & seats, live usage this period, estimated next
// invoice, add-ons the owner can switch on/off, invoices (from Stripe once connected), and a plain
// English timeline of every change that affected the bill. No VAT while vat_mode = NONE.

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Line = { label: string; amount_pence: number; detail: string };
type Usage = { feature_key: string; name: string; unit: string; quantity: number; included: number; billable: number; unit_pence: number; amount_pence: number };
type Feature = { key: string; name: string; description: string; kind: "ADDON" | "FLAG"; monthly_pence: number; unit: string; unit_pence: number; included_units: number; in_plan: number };
type Ent = { enabled: boolean; source: string; note: string; ends_at: number | null };
type Summary = {
  lines: Line[]; subtotal_pence: number; discount_pence: number; discounts: { code: string; name: string }[]; tax_pence: number; total_pence: number; vat_mode: string; period: string; usage: Usage[];
  entitlements: { plan: { id: string; name: string; monthly_pence: number; included_seats: number; seat_pence: number }; subscription: { status: string; seats: number; trial_ends_at: number | null; current_period_end: number | null; billing_email: string; billing_name: string; stripe_customer_id: string }; seats: { used: number; included: number; billable: number }; features: Record<string, Ent>; readOnly: boolean; reasons: string[]; trial_days_left: number | null };
  invoices: { id: string; number: string; status: string; period_start: number; period_end: number; total_pence: number; hosted_url: string; pdf_url: string; paid_at: number | null; lines_json: string }[];
  events: { id: string; type: string; summary: string; created_at: number }[];
  features: Feature[];
};

const when = (ts: number) => new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const monthName = (key: string) => new Date(key + "-01T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
const tone = (s: string): "good" | "next" | "warn" | "note" | "paid" => (s === "ACTIVE" ? "good" : s === "TRIAL" ? "next" : s === "PAST_DUE" ? "warn" : s === "PAID" ? "paid" : "note");

export function BillingPanel({ api, isOwner, onOpenOutbox }: { api: Api; isOwner: boolean; onOpenOutbox?: () => void }) {
  const [d, setD] = useState<Summary | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const load = () => api<Summary>("/billing").then(setD).catch((e) => setErr(e instanceof Error ? e.message : "Could not load billing."));
  useEffect(() => { void load(); }, []);
  if (err) return <p className="workspace-error" role="alert">{err}</p>;
  if (!d) return <p className="workspace-footnote">Loading billing…</p>;
  const e = d.entitlements, sub = e.subscription;
  const addons = d.features.filter((f) => f.kind === "ADDON" && f.monthly_pence > 0);
  async function toggle(key: string, enabled: boolean) {
    setBusy(key); setErr("");
    try { setD(await api<Summary>(`/billing/features/${key}`, "POST", { enabled })); } catch (x) { setErr(x instanceof Error ? x.message : "Could not change that."); } finally { setBusy(""); }
  }
  return (
    <div className="billing" data-testid="billing-panel">
      {e.readOnly && <Notice tone="warning" icon="alert"><strong>Your account is read-only.</strong> {e.reasons.join(" · ")}. Appointments stay visible; new bookings are paused until this is sorted.</Notice>}
      {sub.status === "TRIAL" && !e.readOnly && (
        <Notice icon="sparkles">
          <strong>Free trial · {e.trial_days_left} day{e.trial_days_left === 1 ? "" : "s"} left.</strong> No card needed yet. Add one before {sub.trial_ends_at ? when(sub.trial_ends_at) : "the trial ends"} and your first invoice will look like the estimate below.
        </Notice>
      )}

      <div className="billing-grid">
        <section className="workspace-panel billing-card" aria-labelledby="billing-plan">
          <header className="billing-card-head">
            <h3 id="billing-plan">Plan &amp; seats</h3>
            <StatusPill tone={tone(sub.status)} data-testid="billing-status">{sub.status === "TRIAL" ? "Trial" : sub.status === "PAST_DUE" ? "Payment due" : sub.status[0] + sub.status.slice(1).toLowerCase()}</StatusPill>
          </header>
          <dl className="billing-facts">
            <div><dt>Plan</dt><dd><strong>{e.plan.name}</strong> · {money(e.plan.monthly_pence)} a month</dd></div>
            <div><dt>Seats</dt><dd><strong>{e.seats.used}</strong> active team member{e.seats.used === 1 ? "" : "s"} · {e.seats.included} included{e.seats.billable > 0 ? `, ${e.seats.billable} × ${money(e.plan.seat_pence)}` : ""}</dd></div>
            <div><dt>Next invoice</dt><dd>{sub.current_period_end ? when(sub.current_period_end) : sub.trial_ends_at ? `after your trial (${when(sub.trial_ends_at)})` : "—"}</dd></div>
          </dl>
          <p className="workspace-footnote">Adding or removing a team member changes your seats straight away; the difference is prorated on the next invoice and shown in the timeline below.</p>
        </section>

        <section className="workspace-panel billing-card" aria-labelledby="billing-estimate">
          <header className="billing-card-head">
            <h3 id="billing-estimate">Estimated next invoice</h3>
            <span className="billing-period">{monthName(d.period)}</span>
          </header>
          <ul className="billing-lines" data-testid="billing-lines">
            {d.lines.map((l, i) => (
              <li key={i}><span>{l.label}<small>{l.detail}</small></span><strong>{money(l.amount_pence)}</strong></li>
            ))}
            {d.discount_pence > 0 && <li className="billing-discount"><span>Discount<small>{d.discounts.map((x) => x.name).join(", ")}</small></span><strong>−{money(d.discount_pence)}</strong></li>}
            {d.tax_pence > 0 && <li><span>VAT</span><strong>{money(d.tax_pence)}</strong></li>}
            <li className="billing-total"><span>Total{d.vat_mode === "NONE" ? <small>No VAT is charged</small> : null}</span><strong data-testid="billing-total">{money(d.total_pence)}</strong></li>
          </ul>
          <p className="workspace-footnote">Usage is what you've actually sent so far this month; the final figure is on the invoice.</p>
        </section>

        <section className="workspace-panel billing-card" aria-labelledby="billing-usage">
          <header className="billing-card-head"><h3 id="billing-usage">Usage this month</h3>{onOpenOutbox && <Button variant="ghost" onClick={onOpenOutbox}>See messages</Button>}</header>
          <ul className="billing-usage" data-testid="billing-usage">
            {d.usage.map((u) => (
              <li key={u.feature_key}>
                <span><strong>{u.quantity}</strong> {u.unit}{u.quantity === 1 ? "" : "s"} · {u.name}</span>
                <small>{u.included ? `${Math.min(u.quantity, u.included)} of ${u.included} included · ` : ""}{u.billable > 0 ? `${u.billable} × ${u.unit_pence}p = ${money(u.amount_pence)}` : u.included ? "nothing to pay yet" : `${u.unit_pence}p each`}</small>
              </li>
            ))}
            <li><span><strong>Email</strong> · always free</span><small>—</small></li>
          </ul>
        </section>

        <section className="workspace-panel billing-card" aria-labelledby="billing-addons">
          <header className="billing-card-head"><h3 id="billing-addons">Add-ons</h3></header>
          <ul className="billing-addons">
            {addons.map((f) => {
              const ent = e.features[f.key];
              const locked = ent?.source === "ADMIN_BLOCK" || ent?.source === "ADMIN_GRANT";
              return (
                <li key={f.key} className="switch-row" data-testid={`addon-${f.key}`}>
                  <div>
                    <strong>{f.name} · {money(f.monthly_pence)} a month</strong>
                    <small>{f.description}{ent?.source === "ADMIN_GRANT" ? " · Included on your account, no charge." : ent?.source === "ADMIN_BLOCK" ? " · Not available on your account — contact support." : ""}</small>
                  </div>
                  <label className="switch"><input type="checkbox" checked={!!ent?.enabled} disabled={!isOwner || locked || busy === f.key} onChange={(ev) => toggle(f.key, ev.target.checked)} aria-label={f.name} /><span /></label>
                </li>
              );
            })}
          </ul>
          <p className="workspace-footnote">Switching on is billed from today (prorated). Switching off stops the charge at the end of the current period.</p>
        </section>
      </div>

      <section className="workspace-panel" aria-labelledby="billing-invoices">
        <h3 id="billing-invoices">Invoices</h3>
        {d.invoices.length === 0 ? (
          <p className="workspace-footnote">{sub.status === "TRIAL" ? "Your first invoice is issued when the trial ends." : "No invoices yet."}</p>
        ) : (
          <table className="billing-invoices" data-testid="billing-invoices">
            <thead><tr><th>Number</th><th>Period</th><th>Status</th><th className="num">Total</th><th /></tr></thead>
            <tbody>
              {d.invoices.map((inv) => (
                <tr key={inv.id}>
                  <td>{inv.number || "—"}</td>
                  <td>{when(inv.period_start)} – {when(inv.period_end)}</td>
                  <td><StatusPill tone={tone(inv.status)}>{inv.status[0] + inv.status.slice(1).toLowerCase()}</StatusPill></td>
                  <td className="num">{money(inv.total_pence)}</td>
                  <td className="billing-invoice-actions">{inv.hosted_url && <a href={inv.hosted_url} target="_blank" rel="noreferrer">View</a>}{inv.pdf_url && <a href={inv.pdf_url} target="_blank" rel="noreferrer">PDF</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="workspace-panel" aria-labelledby="billing-timeline">
        <h3 id="billing-timeline">What's changed</h3>
        {d.events.length === 0 ? <p className="workspace-footnote">Nothing yet.</p> : (
          <ol className="billing-timeline" data-testid="billing-timeline">
            {d.events.map((ev) => (
              <li key={ev.id}><Icon name={ev.type.startsWith("SEATS") ? "users" : ev.type.startsWith("FEATURE") ? "sparkles" : ev.type.includes("INVOICE") ? "file" : "clock"} size={14} /><span>{ev.summary}</span><small>{when(ev.created_at)}</small></li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
