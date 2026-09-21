import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Button, Icon, Modal, Notice, Rail, StatusPill } from "./ui";
import { money } from "./fixtures";
import { AdminCatalogue, AdminInvoices, AdminOps, AdminTeam } from "./AdminMore";
import { AdminAlerts, AdminBroadcasts, Exports, Trend } from "./AdminGrowth";

// OLLO master admin. Separate shell (ink on cream) so it is never mistaken for a shop workspace.
// Sections: Overview · Shops (list → detail with subscription, features, invoices, usage, messaging,
// payments, notes, impersonate, audit) · Billing catalogue · Invoices · Ops · Team.

export type AdminApi = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export const adminApi: AdminApi = async (path, method = "GET", body) => {
  const r = await fetch(`/api/admin${path}`, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { message?: string }).message || `Request failed (${r.status})`);
  return j as never;
};
export const when = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
export const ago = (ts: number | null | undefined) => { if (!ts) return "never"; const d = Math.floor((Date.now() - ts) / 86400000); return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`; };
export const tone = (s: string): "good" | "next" | "warn" | "note" | "paid" => (s === "ACTIVE" || s === "PAID" ? "good" : s === "TRIAL" || s === "OPEN" ? "next" : s === "PAST_DUE" || s === "UNCOLLECTIBLE" ? "warn" : "note");
export const label = (s: string) => (s === "PAST_DUE" ? "Payment due" : s[0] + s.slice(1).toLowerCase());

const SECTIONS = [
  { key: "overview", label: "Overview", icon: "dashboard" },
  { key: "shops", label: "Shops", icon: "store" },
  { key: "catalogue", label: "Billing", icon: "banknote" },
  { key: "invoices", label: "Invoices", icon: "file" },
  { key: "alerts", label: "Alerts", icon: "bell" },
  { key: "broadcasts", label: "Broadcasts", icon: "send" },
  { key: "ops", label: "Ops", icon: "sliders" },
  { key: "team", label: "Team", icon: "shield" },
];

export function Admin() {
  const [me, setMe] = useState<{ name: string; email: string; role: string } | null | "denied">(null);
  const parts = location.pathname.split("/").filter(Boolean); // admin, section, id
  const [section, setSection] = useState(parts[1] || "overview");
  const [shopId, setShopId] = useState<string | null>(parts[1] === "shops" && parts[2] ? parts[2] : null);
  useEffect(() => { adminApi<{ admin: { name: string; email: string; role: string } }>("/me").then((r) => setMe(r.admin)).catch(() => setMe("denied")); }, []);
  useEffect(() => { history.replaceState(null, "", `/admin/${section}${section === "shops" && shopId ? `/${shopId}` : ""}`); }, [section, shopId]);
  if (me === null) return <main className="ollo-admin-shell"><p className="boot-message">Opening OLLO admin…</p></main>;
  if (me === "denied") return (
    <main className="ollo-admin-shell admin-denied">
      <h1>Not found</h1>
      <p>There's nothing here. <a href="/workspace">Back to your workspace</a></p>
    </main>
  );
  return (
    <div className="ollo-admin-shell" data-testid="admin">
      <Rail items={SECTIONS} current={section} onSelect={(k) => { setSection(k); if (k !== "shops") setShopId(null); }} />
      <div className="ollo-admin-body">
        <header className="admin-top">
          <div className="admin-brand"><strong>OLLO</strong> <span>Admin</span></div>
          <div className="admin-me"><span>{me.name}</span><small>{me.email} · {me.role.toLowerCase()}</small><a className="button ghost" href="/workspace">Workspace</a></div>
        </header>
        <main className="ollo-admin-main">
          {section === "overview" && <Overview onShops={(status) => { setSection("shops"); setShopId(null); sessionStorage.setItem("admin.shops.status", status); }} onAlerts={() => setSection("alerts")} />}
          {section === "shops" && (shopId ? <ShopDetail id={shopId} onBack={() => setShopId(null)} me={me} /> : <ShopsList onOpen={setShopId} />)}
          {section === "catalogue" && <AdminCatalogue me={me} />}
          {section === "invoices" && <AdminInvoices me={me} onShop={(id) => { setSection("shops"); setShopId(id); }} />}
          {section === "alerts" && <AdminAlerts onShop={(id) => { setSection("shops"); setShopId(id); }} />}
          {section === "broadcasts" && <AdminBroadcasts me={me} />}
          {section === "ops" && <AdminOps onShop={(id) => { setSection("shops"); setShopId(id); }} />}
          {section === "team" && <AdminTeam me={me} />}
        </main>
      </div>
    </div>
  );
}

// ---- Overview ------------------------------------------------------------------------------------
type OverviewData = { alerts: Record<string, number>; shops: number; by_status: Record<string, number>; trials_ending_7d: number; past_due: number; failed_messages_24h: number; upcoming_appointments_7d: number; mrr_pence: number; trial_pipeline_pence: number; vat: { mode: string; threshold_pence: number; annualised_pence: number; pct_of_threshold: number }; providers: Record<string, unknown> };
function Overview({ onShops, onAlerts }: { onShops: (status: string) => void; onAlerts: () => void }) {
  const [d, setD] = useState<OverviewData | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { adminApi<OverviewData>("/overview").then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <p className="workspace-error">{err}</p>;
  if (!d) return <p className="workspace-footnote">Loading…</p>;
  const Tile = ({ label: l, value, hint, onClick, warn }: { label: string; value: ReactNode; hint?: string; onClick?: () => void; warn?: boolean }) => (
    <button type="button" className={`admin-tile ${warn ? "warn" : ""}`} onClick={onClick} disabled={!onClick}>
      <small>{l}</small><strong>{value}</strong>{hint && <span>{hint}</span>}
    </button>
  );
  return (
    <section className="admin-section" data-testid="admin-overview">
      <h1>Overview</h1>
      <div className="admin-tiles">
        <Tile label="Monthly revenue" value={money(d.mrr_pence)} hint={`${d.by_status.ACTIVE ?? 0} paying shop${(d.by_status.ACTIVE ?? 0) === 1 ? "" : "s"}`} onClick={() => onShops("ACTIVE")} />
        <Tile label="Trials" value={d.by_status.TRIAL ?? 0} hint={`${money(d.trial_pipeline_pence)}/mo if they convert`} onClick={() => onShops("TRIAL")} />
        <Tile label="Trials ending in 7 days" value={d.trials_ending_7d} onClick={() => onShops("TRIAL")} warn={d.trials_ending_7d > 0} />
        <Tile label="Payment overdue" value={d.past_due} onClick={() => onShops("PAST_DUE")} warn={d.past_due > 0} />
        <Tile label="Alerts" value={(d.alerts.CRIT ?? 0) + (d.alerts.WARN ?? 0) + (d.alerts.INFO ?? 0)} hint={d.alerts.CRIT ? `${d.alerts.CRIT} critical` : d.failed_messages_24h ? `${d.failed_messages_24h} failed messages · 24h` : "nothing urgent"} onClick={onAlerts} warn={(d.alerts.CRIT ?? 0) + (d.alerts.WARN ?? 0) > 0} />
        <Tile label="Appointments · next 7 days" value={d.upcoming_appointments_7d} hint="across all shops" />
        <Tile label="All shops" value={d.shops} onClick={() => onShops("")} />
        <Tile label="VAT threshold" value={`${d.vat.pct_of_threshold}%`} hint={`${money(d.vat.annualised_pence)} of ${money(d.vat.threshold_pence)} a year · ${d.vat.mode === "NONE" ? "not charging VAT" : d.vat.mode}`} warn={d.vat.pct_of_threshold >= 80} />
      </div>
      <Trend />
      <Exports />
      <details className="admin-providers"><summary>Providers</summary><pre className="admin-pre">{JSON.stringify(d.providers, null, 2)}</pre></details>
    </section>
  );
}

// ---- Shops list ------------------------------------------------------------------------------------
type ShopRow = { id: string; name: string; slug: string; kind: string; created_at: number; status: string | null; plan_id: string | null; seats: number | null; trial_ends_at: number | null; past_due_since: number | null; owner_email: string | null; owner_name: string | null; active_staff: number; last_booking_at: number | null; bookings_30d: number; base_pence: number | null; online_booking: number };
function ShopsList({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(() => sessionStorage.getItem("admin.shops.status") || "");
  const [rows, setRows] = useState<ShopRow[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { const t = setTimeout(() => adminApi<{ shops: ShopRow[] }>(`/shops?q=${encodeURIComponent(q)}&status=${status}`).then((r) => setRows(r.shops)).catch((e) => setErr(e.message)), 150); return () => clearTimeout(t); }, [q, status]);
  useEffect(() => { sessionStorage.setItem("admin.shops.status", status); }, [status]);
  return (
    <section className="admin-section" data-testid="admin-shops">
      <header className="admin-section-head">
        <h1>Shops {rows ? <small>{rows.length}</small> : null}</h1>
        <div className="toolbar">
          <label className="customers-search"><Icon name="search" size={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, slug or owner email" aria-label="Search shops" /></label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
            <option value="">All statuses</option>{["TRIAL", "ACTIVE", "PAST_DUE", "PAUSED", "CANCELLED"].map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </div>
      </header>
      {err && <p className="workspace-error">{err}</p>}
      {rows && (
        <table className="admin-table">
          <thead><tr><th>Shop</th><th>Owner</th><th>Status</th><th>Plan</th><th className="num">Seats</th><th className="num">£/mo</th><th className="num">Bookings 30d</th><th>Last booking</th><th>Health</th></tr></thead>
          <tbody>
            {rows.map((s) => {
              const health: string[] = [];
              if (s.status === "PAST_DUE") health.push("overdue");
              if (s.status === "TRIAL" && s.trial_ends_at && s.trial_ends_at - Date.now() < 7 * 86400000) health.push("trial ending");
              if (!s.online_booking) health.push("online booking off");
              if (s.last_booking_at && Date.now() - s.last_booking_at > 30 * 86400000) health.push("quiet");
              return (
                <tr key={s.id} onClick={() => onOpen(s.id)} className="clickable">
                  <td><strong>{s.name}</strong><br /><small>/{s.slug} · {s.kind || "barber"}</small></td>
                  <td>{s.owner_name || "—"}<br /><small>{s.owner_email || ""}</small></td>
                  <td>{s.status ? <StatusPill tone={tone(s.status)}>{label(s.status)}</StatusPill> : "—"}</td>
                  <td>{s.plan_id || "—"}</td>
                  <td className="num">{s.active_staff}{s.seats && s.seats !== s.active_staff ? <small> / {s.seats}</small> : null}</td>
                  <td className="num">{s.base_pence != null ? money(s.base_pence) : "—"}</td>
                  <td className="num">{s.bookings_30d}</td>
                  <td>{ago(s.last_booking_at)}</td>
                  <td>{health.length ? health.map((h) => <span key={h} className="admin-flag">{h}</span>) : <span className="admin-ok">ok</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---- Shop detail -------------------------------------------------------------------------------------
export type AdminInvoice = { id: string; shop_id: string; shop_name?: string; number: string; status: string; kind: string; credit_note_for: string | null; period_key: string; period_start: number; period_end: number; subtotal_pence: number; discount_pence: number; tax_pence: number; total_pence: number; paid_pence: number; credit_applied_pence: number; due_at: number | null; paid_at: number | null; paid_via: string; paid_ref: string; sent_at: number | null; sent_to: string; issued_at: number | null; voided_at: number | null; void_reason: string; note: string; lines_json: string; view_token: string; hosted_url: string; created_at: number };
type Detail = {
  shop: Record<string, unknown> & { id: string; name: string; slug: string; timezone: string; created_at: number; owner_email: string; owner_name: string; online_booking: number; kind: string; suspended_at: number | null; suspended_reason: string };
  entitlements: { plan: { id: string; name: string; monthly_pence: number; included_seats: number; seat_pence: number }; subscription: { status: string; seats: number; trial_ends_at: number | null; current_period_end: number | null; past_due_since: number | null; billing_email: string; stripe_customer_id: string }; seats: { used: number; included: number; billable: number }; features: Record<string, { enabled: boolean; source: string; note: string; ends_at: number | null }>; readOnly: boolean; reasons: string[]; trial_days_left: number | null };
  estimate: { lines: { label: string; amount_pence: number; detail: string }[]; total_pence: number; discount_pence: number };
  usage: { feature_key: string; name: string; unit: string; quantity: number; billable: number; amount_pence: number }[];
  invoices: AdminInvoice[];
  adjustments: { id: string; kind: string; amount_pence: number; reason: string; created_at: number; invoice_id: string | null }[];
  events: { id: string; summary: string; created_at: number; actor: string }[];
  notes: { id: string; body: string; created_at: number; admin_name: string }[];
  admin_audit: { id: string; action: string; reason: string; created_at: number; admin_name: string }[];
  members: { id: string; role: string; active: number; name: string; email: string }[];
  staff: { id: string; name: string; role: string; active: number }[];
  messaging_30d: { channel: string; status: string; n: number }[];
  calls_30d: { n: number; secs: number } | null;
  connect: { id: string; owner_type: string; charges_enabled: number; payouts_enabled: number; disabled_reason: string }[];
  open_disputes: number; upcoming: number;
  audit: { id: string; action: string; reason: string; actor: string; created_at: number }[];
  discounts: { id: string; code: string; name: string; kind: string; value: number; applied_until: number | null }[];
  features: { key: string; name: string; kind: string; monthly_pence: number; in_plan: number }[];
  plans: { id: string; name: string }[];
};

export function ReasonAction({ title, cta, fields, onSubmit, danger }: { title: string; cta: string; fields?: ReactNode; onSubmit: (reason: string, f: FormData) => Promise<void>; danger?: boolean }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button variant={danger ? "danger" : "secondary"} onClick={() => setOpen(true)}>{title}</Button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)} context="OLLO ADMIN">
          <form className="workspace-form" onSubmit={async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); setBusy(true); setErr(""); const f = new FormData(e.currentTarget); try { await onSubmit(String(f.get("reason") || ""), f); setOpen(false); } catch (x) { setErr(x instanceof Error ? x.message : "Failed"); } finally { setBusy(false); } }}>
            {fields}
            <label className="workspace-field"><span>Reason (recorded in the audit)</span><input name="reason" required minLength={5} maxLength={300} placeholder="e.g. Customer asked for extra time to add a card" /></label>
            {err && <p className="workspace-error" role="alert">{err}</p>}
            <div className="workspace-save-actions"><Button type="submit" variant={danger ? "danger" : "primary"} disabled={busy}>{busy ? "Saving…" : cta}</Button><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
          </form>
        </Modal>
      )}
    </>
  );
}

function ShopDetail({ id, onBack, me }: { id: string; onBack: () => void; me: { role: string } }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"summary" | "billing" | "features" | "messaging" | "support" | "account" | "audit">("summary");
  const [note, setNote] = useState("");
  const load = () => adminApi<Detail>(`/shops/${id}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { void load(); }, [id]);
  if (err) return <p className="workspace-error">{err}</p>;
  if (!d) return <p className="workspace-footnote">Loading…</p>;
  const e = d.entitlements, sub = e.subscription;
  const finance = me.role === "SUPER" || me.role === "FINANCE";
  const post = async (path: string, body: unknown) => { await adminApi(path, "POST", body); await load(); };
  const msgTotals = (ch: string) => d.messaging_30d.filter((m) => m.channel === ch).reduce((a, m) => ({ ...a, [m.status]: m.n }), {} as Record<string, number>);
  return (
    <section className="admin-section" data-testid="admin-shop">
      <button type="button" className="linklike admin-back" onClick={onBack}><Icon name="arrowLeft" size={14} /> All shops</button>
      <header className="admin-shop-head">
        <div>
          <h1>{d.shop.name}</h1>
          <p>/{d.shop.slug} · {d.shop.kind || "barber"} · {d.shop.timezone} · joined {when(d.shop.created_at)} · owner {d.shop.owner_name} &lt;{d.shop.owner_email}&gt;</p>
        </div>
        <div className="admin-shop-actions">
          <StatusPill tone={tone(sub.status)}>{label(sub.status)}{sub.status === "TRIAL" && e.trial_days_left != null ? ` · ${e.trial_days_left}d left` : ""}</StatusPill>
          <a className="button secondary" href={`/${d.shop.slug}`} target="_blank" rel="noreferrer">Public page</a>
          <ReasonAction title="Open as owner" cta="Open workspace (30 min)" onSubmit={async (reason) => { await adminApi(`/shops/${id}/impersonate`, "POST", { reason }); location.href = "/workspace"; }} />
        </div>
      </header>
      {d.shop.suspended_at && <Notice tone="warning" icon="alert" data-testid="admin-suspended"><strong>Suspended</strong> since {when(d.shop.suspended_at)} — {d.shop.suspended_reason}. The team can sign in and look, but nothing can be changed and the public page is off.</Notice>}
      {e.readOnly && <Notice tone="warning" icon="alert"><strong>Read-only for the shop:</strong> {e.reasons.join(" · ")}</Notice>}
      <div className="segmented admin-tabs" role="tablist">
        {(["summary", "billing", "features", "messaging", "support", "account", "audit"] as const).map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
      </div>

      {tab === "summary" && (
        <div className="admin-cards">
          <div className="admin-card"><small>Team</small><strong>{d.staff.filter((s) => s.active).length} active</strong><span>{d.staff.filter((s) => !s.active).length} inactive · {d.members.length} account{d.members.length === 1 ? "" : "s"}</span></div>
          <div className="admin-card"><small>Upcoming appointments</small><strong>{d.upcoming}</strong></div>
          <div className="admin-card"><small>Estimated next invoice</small><strong>{money(d.estimate.total_pence)}</strong><span>{e.seats.used} seat{e.seats.used === 1 ? "" : "s"} · plan {e.plan.name}</span></div>
          <div className="admin-card"><small>Card payments</small><strong>{d.connect.some((c) => c.charges_enabled) ? "Live" : "Not set up"}</strong><span>{d.connect.length} connected account{d.connect.length === 1 ? "" : "s"}{d.open_disputes ? ` · ${d.open_disputes} open dispute${d.open_disputes === 1 ? "" : "s"}` : ""}</span></div>
          <div className="admin-card"><small>Messages · 30d</small><strong>{d.messaging_30d.reduce((n, m) => n + (m.status === "SENT" ? m.n : 0), 0)} sent</strong><span>{d.messaging_30d.reduce((n, m) => n + (m.status === "FAILED" ? m.n : 0), 0)} failed</span></div>
          <div className="admin-card"><small>AI Concierge · 30d</small><strong>{d.calls_30d?.n ?? 0} calls</strong><span>{Math.round((d.calls_30d?.secs ?? 0) / 60)} min</span></div>
          <div className="admin-card admin-card-wide"><small>Accounts</small><ul className="admin-list">{d.members.map((m) => <li key={m.id}><strong>{m.name}</strong> · {m.role.toLowerCase()} · {m.email}{!m.active && <span className="admin-flag">inactive</span>}</li>)}</ul></div>
        </div>
      )}

      {tab === "billing" && (
        <div className="admin-two">
          <div className="workspace-panel">
            <h3>Subscription</h3>
            <dl className="billing-facts">
              <div><dt>Status</dt><dd><StatusPill tone={tone(sub.status)}>{label(sub.status)}</StatusPill></dd></div>
              <div><dt>Plan</dt><dd>{e.plan.name} · {money(e.plan.monthly_pence)}/mo · {e.plan.included_seats} seat incl · {money(e.plan.seat_pence)}/extra</dd></div>
              <div><dt>Seats</dt><dd>{e.seats.used} used · {e.seats.billable} billable</dd></div>
              <div><dt>Trial ends</dt><dd>{when(sub.trial_ends_at)}</dd></div>
              <div><dt>Period end</dt><dd>{when(sub.current_period_end)}</dd></div>
              <div><dt>Overdue since</dt><dd>{when(sub.past_due_since)}</dd></div>
              <div><dt>Stripe customer</dt><dd>{sub.stripe_customer_id || <em>not connected yet</em>}</dd></div>
              <div><dt>Billing email</dt><dd>{sub.billing_email || d.shop.owner_email}</dd></div>
            </dl>
            <div className="admin-actions">
              <ReasonAction title="Extend trial" cta="Extend" fields={<label className="workspace-field"><span>Days</span><input name="days" type="number" min={1} max={365} defaultValue={14} /></label>} onSubmit={(reason, f) => post(`/shops/${id}/subscription`, { action: "EXTEND_TRIAL", days: Number(f.get("days") || 14), reason })} />
              {sub.status !== "PAUSED" ? <ReasonAction title="Pause" cta="Pause subscription" onSubmit={(reason) => post(`/shops/${id}/subscription`, { action: "PAUSE", reason })} /> : <ReasonAction title="Resume" cta="Resume" onSubmit={(reason) => post(`/shops/${id}/subscription`, { action: "RESUME", reason })} />}
              {finance && sub.status === "PAST_DUE" && <ReasonAction title="Clear overdue" cta="Mark paid / clear" onSubmit={(reason) => post(`/shops/${id}/subscription`, { action: "CLEAR_PAST_DUE", reason })} />}
              {finance && sub.status !== "PAST_DUE" && sub.status !== "TRIAL" && <ReasonAction title="Mark overdue" cta="Mark overdue" onSubmit={(reason) => post(`/shops/${id}/subscription`, { action: "MARK_PAST_DUE", reason })} />}
              {finance && sub.status === "TRIAL" && <ReasonAction title="Mark active" cta="Activate (offline payment)" onSubmit={(reason) => post(`/shops/${id}/subscription`, { action: "MARK_ACTIVE", reason })} />}
              {finance && <ReasonAction title="Change plan" cta="Change" fields={<label className="workspace-field"><span>Plan</span><select name="plan_id" defaultValue={e.plan.id}>{d.plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>} onSubmit={(reason, f) => post(`/shops/${id}/subscription`, { action: "SET_PLAN", plan_id: String(f.get("plan_id")), reason })} />}
              {finance && sub.status !== "CANCELLED" && <ReasonAction title="Cancel" cta="Cancel subscription" danger onSubmit={(reason) => post(`/shops/${id}/subscription`, { action: "CANCEL", reason })} />}
            </div>
          </div>
          <div className="workspace-panel">
            <h3>Estimated next invoice · {money(d.estimate.total_pence)}</h3>
            <ul className="billing-lines">{d.estimate.lines.map((l, i) => <li key={i}><span>{l.label}<small>{l.detail}</small></span><strong>{money(l.amount_pence)}</strong></li>)}{d.estimate.discount_pence > 0 && <li className="billing-discount"><span>Discounts</span><strong>−{money(d.estimate.discount_pence)}</strong></li>}</ul>
            <h4>Discounts</h4>
            <ul className="admin-list">{d.discounts.length === 0 && <li className="muted">None</li>}{d.discounts.map((x) => <li key={x.id}><code>{x.code}</code> {x.name} · {x.kind === "PERCENT" ? `${x.value}%` : x.kind === "FIXED" ? money(x.value) : x.kind === "FREE_MONTHS" ? `${x.value} free month${x.value === 1 ? "" : "s"}` : `${x.value} seat${x.value === 1 ? "" : "s"} free`}{x.applied_until ? ` until ${when(x.applied_until)}` : ""}{finance && <ReasonAction title="Remove" cta="Remove discount" onSubmit={(reason) => post(`/shops/${id}/discounts`, { code: x.code, remove: true, reason })} />}</li>)}</ul>
            {finance && <div className="admin-actions">
              <ReasonAction title="Apply discount code" cta="Apply" fields={<label className="workspace-field"><span>Code</span><input name="code" required placeholder="LAUNCH50" /></label>} onSubmit={(reason, f) => post(`/shops/${id}/discounts`, { code: String(f.get("code")), reason })} />
              <ReasonAction title="Add credit" cta="Add credit" fields={<label className="workspace-field"><span>Amount (£)</span><input name="amount" type="number" step="0.01" min="0.01" required /></label>} onSubmit={(reason, f) => post(`/shops/${id}/adjustments`, { kind: "CREDIT", amount_pence: Math.round(Number(f.get("amount")) * 100), reason })} />
              <ReasonAction title="Add one-off charge" cta="Add charge" fields={<label className="workspace-field"><span>Amount (£)</span><input name="amount" type="number" step="0.01" min="0.01" required /></label>} onSubmit={(reason, f) => post(`/shops/${id}/adjustments`, { kind: "CHARGE", amount_pence: Math.round(Number(f.get("amount")) * 100), reason })} />
            </div>}
            <h4>Usage this month</h4>
            <ul className="admin-list">{d.usage.map((u) => <li key={u.feature_key}>{u.quantity} {u.unit}{u.quantity === 1 ? "" : "s"} · {u.name}{u.billable ? ` · ${money(u.amount_pence)}` : ""}</li>)}</ul>
            <h4>Invoices</h4>
            {finance && <div className="admin-actions">
              <ManualInvoiceAction shopId={id} onDone={load} />
              <ReasonAction title="Close a period now" cta="Issue invoice" fields={<label className="workspace-field"><span>Period (month)</span><input name="period" type="month" required defaultValue={lastMonth()} max={lastMonth()} /></label>} onSubmit={(reason, f) => post(`/shops/${id}/invoices`, { kind: "PERIOD", period: String(f.get("period")), force: true, send: true, reason })} />
            </div>}
            {d.invoices.length === 0 ? <p className="muted">None yet — issued automatically at each month end once the trial converts.</p> : <InvoiceTable invoices={d.invoices} finance={finance} onChanged={load} />}
            {d.adjustments.filter((a) => !a.invoice_id).length > 0 && <><h4>Pending on next invoice</h4><ul className="admin-list">{d.adjustments.filter((a) => !a.invoice_id).map((a) => <li key={a.id}>{a.kind === "CREDIT" ? "Credit" : "Charge"} {money(a.amount_pence)} · {a.reason} · {when(a.created_at)}</li>)}</ul></>}
            <h4>Timeline</h4>
            <ol className="billing-timeline">{d.events.map((ev) => <li key={ev.id}><Icon name="clock" size={14} /><span>{ev.summary}</span><small>{when(ev.created_at)}</small></li>)}</ol>
          </div>
        </div>
      )}

      {tab === "features" && (
        <div className="workspace-panel">
          <h3>Features</h3>
          <p className="workspace-footnote">Grant gives the shop a feature free of charge; Block removes it even if they pay for it. Clear returns to plan/add-on behaviour.</p>
          <table className="admin-table" data-testid="admin-features">
            <thead><tr><th>Feature</th><th>Price</th><th>State</th><th>Source</th><th>Note</th><th /></tr></thead>
            <tbody>
              {d.features.map((f) => { const ent = e.features[f.key]; return (
                <tr key={f.key}>
                  <td><strong>{f.name}</strong><br /><small>{f.key}</small></td>
                  <td>{f.monthly_pence ? `${money(f.monthly_pence)}/mo` : f.in_plan ? "in plan" : "—"}</td>
                  <td><StatusPill tone={ent?.enabled ? "good" : "note"}>{ent?.enabled ? "On" : "Off"}</StatusPill></td>
                  <td><code>{ent?.source ?? "—"}</code>{ent?.ends_at ? <small> until {when(ent.ends_at)}</small> : null}</td>
                  <td><small>{ent?.note}</small></td>
                  <td className="admin-actions">
                    <ReasonAction title="Grant" cta="Grant free" fields={<label className="workspace-field"><span>Until (optional)</span><input name="until" type="date" /></label>} onSubmit={(reason, fd) => post(`/shops/${id}/features`, { key: f.key, mode: "GRANT", ends_at: fd.get("until") ? Date.parse(String(fd.get("until")) + "T23:59:59Z") : null, reason })} />
                    <ReasonAction title="Block" cta="Block" danger onSubmit={(reason) => post(`/shops/${id}/features`, { key: f.key, mode: "BLOCK", reason })} />
                    {(ent?.source === "ADMIN_GRANT" || ent?.source === "ADMIN_BLOCK") && <ReasonAction title="Clear" cta="Clear override" onSubmit={(reason) => post(`/shops/${id}/features`, { key: f.key, mode: "CLEAR", reason })} />}
                  </td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
      )}

      {tab === "messaging" && (
        <div className="admin-cards">
          {["SMS", "WA", "EMAIL"].map((ch) => { const t = msgTotals(ch); return <div key={ch} className="admin-card"><small>{ch === "WA" ? "WhatsApp" : ch === "SMS" ? "Texts" : "Email"} · 30d</small><strong>{t.SENT ?? 0} sent</strong><span>{t.FAILED ?? 0} failed · {t.QUEUED ?? 0} queued</span></div>; })}
          <div className="admin-card"><small>AI Concierge · 30d</small><strong>{d.calls_30d?.n ?? 0} calls</strong><span>{Math.round((d.calls_30d?.secs ?? 0) / 60)} minutes</span></div>
        </div>
      )}

      {tab === "support" && (
        <div className="admin-two">
          <div className="workspace-panel">
            <h3>Notes</h3>
            <form className="workspace-form" onSubmit={async (ev) => { ev.preventDefault(); if (!note.trim()) return; await post(`/shops/${id}/notes`, { body: note.trim() }); setNote(""); }}>
              <textarea value={note} onChange={(ev) => setNote(ev.target.value)} rows={3} maxLength={4000} placeholder="What happened, what was agreed…" aria-label="New note" />
              <div className="workspace-save-actions"><Button type="submit" disabled={!note.trim()}>Add note</Button></div>
            </form>
            <ul className="admin-notes">{d.notes.map((n) => <li key={n.id}><p>{n.body}</p><small>{n.admin_name} · {when(n.created_at)}</small></li>)}</ul>
          </div>
          <div className="workspace-panel">
            <h3>Admin actions on this shop</h3>
            <ol className="billing-timeline">{d.admin_audit.length === 0 && <li className="muted">None yet.</li>}{d.admin_audit.map((a) => <li key={a.id}><Icon name="shield" size={14} /><span><strong>{a.action.replace(/_/g, " ").toLowerCase()}</strong> · {a.reason} <small>— {a.admin_name}</small></span><small>{when(a.created_at)}</small></li>)}</ol>
          </div>
        </div>
      )}

      {tab === "account" && (
        <div className="admin-two" data-testid="admin-account">
          <div className="workspace-panel">
            <h3>Owner &amp; access</h3>
            <dl className="billing-facts">
              <div><dt>Owner</dt><dd>{d.shop.owner_name} · {d.shop.owner_email}</dd></div>
              <div><dt>Web address</dt><dd>/{d.shop.slug}</dd></div>
              <div><dt>Online booking</dt><dd>{d.shop.online_booking ? "On" : "Off"}</dd></div>
              <div><dt>Status</dt><dd>{d.shop.suspended_at ? <StatusPill tone="warn">Suspended</StatusPill> : <StatusPill tone="good">In good standing</StatusPill>}</dd></div>
            </dl>
            <div className="admin-actions">
              <ReasonAction title="Edit details" cta="Save changes" fields={<>
                <label className="workspace-field"><span>Shop name</span><input name="name" defaultValue={d.shop.name} maxLength={80} /></label>
                <label className="workspace-field"><span>Web address</span><input name="slug" defaultValue={d.shop.slug} pattern="[a-z0-9][a-z0-9\\-]{1,38}[a-z0-9]" /></label>
                <label className="workspace-field"><span>Owner name</span><input name="owner_name" defaultValue={d.shop.owner_name} maxLength={80} /></label>
                <label className="workspace-field"><span>Owner email</span><input name="owner_email" type="email" defaultValue={d.shop.owner_email} /></label>
              </>} onSubmit={async (reason, f) => { const b: Record<string, unknown> = { reason }; for (const k of ["name", "slug", "owner_name", "owner_email"]) { const v = String(f.get(k) || "").trim(); if (v && v !== String(d.shop[k === "owner_name" ? "owner_name" : k === "owner_email" ? "owner_email" : k])) b[k] = v; } await adminApi(`/shops/${id}/account`, "PUT", b); await load(); }} />
              <SigninLinkAction shopId={id} onDone={load} />
              <ReasonAction title="Sign out all devices" cta="Sign everyone out" onSubmit={(reason) => post(`/shops/${id}/signout-all`, { reason })} />
              {me.role === "SUPER" && d.members.filter((m) => m.active && m.role !== "OWNER").length > 0 && <ReasonAction title="Transfer ownership" cta="Make owner" danger fields={<label className="workspace-field"><span>New owner</span><select name="membership_id" required>{d.members.filter((m) => m.active && m.role !== "OWNER").map((m) => <option key={m.id} value={m.id}>{m.name} · {m.role.toLowerCase()} · {m.email}</option>)}</select></label>} onSubmit={(reason, f) => post(`/shops/${id}/owner`, { membership_id: String(f.get("membership_id")), reason })} />}
            </div>
          </div>
          <div className="workspace-panel">
            <h3>Suspension</h3>
            <p className="workspace-footnote">Suspending signs everyone out, makes the workspace read-only and takes the public booking page offline. Billing keeps running — pause the subscription too if you don't want to charge them.</p>
            {finance && (d.shop.suspended_at
              ? <ReasonAction title="Lift suspension" cta="Restore access" onSubmit={(reason) => post(`/shops/${id}/suspend`, { suspend: false, reason })} />
              : <ReasonAction title="Suspend shop" cta="Suspend" danger onSubmit={(reason) => post(`/shops/${id}/suspend`, { suspend: true, reason })} />)}
            <h4>Shop-visible record</h4>
            <p className="workspace-footnote">Owners see these entries under Settings → Billing → "OLLO support access".</p>
            <ol className="billing-timeline">{d.audit.filter((a) => ["SUPPORT_ACCESS", "SIGNIN_LINK_SENT", "SIGNIN_LINK_USED", "ACCOUNT_EDITED_BY_SUPPORT", "OWNER_TRANSFERRED", "SUSPENDED", "UNSUSPENDED"].includes(a.action)).map((a) => <li key={a.id}><Icon name="shield" size={14} /><span>{a.reason || a.action.replace(/_/g, " ").toLowerCase()}</span><small>{when(a.created_at)}</small></li>)}</ol>
          </div>
        </div>
      )}

      {tab === "audit" && (
        <div className="workspace-panel">
          <h3>Shop audit (latest 40)</h3>
          <ol className="billing-timeline">{d.audit.map((a) => <li key={a.id}><Icon name="file" size={14} /><span><strong>{a.action.replace(/_/g, " ").toLowerCase()}</strong> {a.reason && `· ${a.reason}`} <small>— {a.actor}</small></span><small>{when(a.created_at)}</small></li>)}</ol>
        </div>
      )}
    </section>
  );
}


export const lastMonth = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7); };
const overdue = (i: AdminInvoice) => i.status === "OPEN" && !!i.due_at && i.due_at < Date.now();
export const invoiceLabel = (i: AdminInvoice) => (i.kind === "CREDIT_NOTE" ? "Credit note" : overdue(i) ? "Overdue" : i.status === "UNCOLLECTIBLE" ? "Written off" : label(i.status));
export const invoiceTone = (i: AdminInvoice) => (i.kind === "CREDIT_NOTE" ? "note" : overdue(i) ? "warn" : tone(i.status));

// Free-form invoice: up to 8 lines.
export function ManualInvoiceAction({ shopId, onDone }: { shopId: string; onDone: () => void }) {
  const [rows, setRows] = useState(2);
  return (
    <ReasonAction title="New invoice" cta="Issue & send" fields={<>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="workspace-form-grid two admin-invoice-line">
          <label className="workspace-field"><span>{i === 0 ? "Description" : ""}</span><input name={`label${i}`} required={i === 0} maxLength={160} placeholder={i === 0 ? "e.g. Onboarding & data import" : "Another line (optional)"} /></label>
          <label className="workspace-field"><span>{i === 0 ? "Amount (£)" : ""}</span><input name={`amount${i}`} type="number" step="0.01" required={i === 0} placeholder="0.00" /></label>
        </div>
      ))}
      {rows < 8 && <button type="button" className="linklike" onClick={() => setRows(rows + 1)}>+ Add a line</button>}
      <label className="workspace-field"><span>Note on the invoice (optional)</span><input name="note" maxLength={300} /></label>
      <label className="workspace-field"><span>Due in (days)</span><input name="due_days" type="number" min={0} max={60} defaultValue={7} /></label>
    </>} onSubmit={async (reason, f) => {
      const lines = Array.from({ length: rows }, (_, i) => ({ label: String(f.get(`label${i}`) || "").trim(), amount_pence: Math.round(Number(f.get(`amount${i}`) || 0) * 100) })).filter((l) => l.label);
      await adminApi(`/shops/${shopId}/invoices`, "POST", { kind: "MANUAL", lines, note: String(f.get("note") || ""), due_days: Number(f.get("due_days") || 7), send: true, reason });
      onDone();
    }} />
  );
}

export function SigninLinkAction({ shopId, onDone }: { shopId: string; onDone: () => void }) {
  const [result, setResult] = useState<{ to: string; delivered: boolean; link?: string; expires_at: number } | null>(null);
  return (
    <>
      <ReasonAction title="Send sign-in link" cta="Send link" fields={<p className="workspace-footnote">Emails the owner a one-time link (works once, 15 minutes). Use when they've lost their password and reset emails aren't arriving.</p>} onSubmit={async (reason) => { setResult(await adminApi(`/shops/${shopId}/signin-link`, "POST", { reason })); onDone(); }} />
      {result && <Notice tone="success" icon="check" data-testid="admin-signin-link">{result.delivered ? <>Link emailed to <strong>{result.to}</strong>.</> : <>No email provider configured — pass this link to <strong>{result.to}</strong> yourself:</>}{result.link && <> <code style={{ userSelect: "all", wordBreak: "break-all" }}>{result.link}</code></>} Expires {when(result.expires_at)}.</Notice>}
    </>
  );
}

// Invoice table with per-row actions. Used on the shop detail and the cross-shop Invoices page.
export function InvoiceTable({ invoices, finance, onChanged, showShop, onShop }: { invoices: AdminInvoice[]; finance: boolean; onChanged: () => void; showShop?: boolean; onShop?: (id: string) => void }) {
  const post = async (path: string, body: unknown) => { await adminApi(path, "POST", body); onChanged(); };
  return (
    <table className="admin-table small" data-testid="admin-invoice-table">
      <thead><tr><th>Number</th>{showShop && <th>Shop</th>}<th>Period / date</th><th>Status</th><th className="num">Total</th><th className="num">Balance</th><th>Due</th><th /></tr></thead>
      <tbody>
        {invoices.map((inv) => { const bal = inv.kind === "CREDIT_NOTE" || inv.status === "VOID" ? 0 : inv.total_pence - inv.paid_pence; return (
          <tr key={inv.id} data-testid="admin-invoice-row" className={overdue(inv) ? "overdue" : ""}>
            <td><strong>{inv.number || "—"}</strong>{inv.kind === "MANUAL" && <small className="muted"> · manual</small>}{inv.sent_at && <small className="muted"> · sent</small>}</td>
            {showShop && <td>{onShop ? <button type="button" className="linklike" onClick={() => onShop(inv.shop_id)}>{inv.shop_name}</button> : inv.shop_name}</td>}
            <td>{inv.kind === "PERIOD" ? <>{when(inv.period_start)} – {when(inv.period_end)}</> : when(inv.issued_at ?? inv.created_at)}</td>
            <td><StatusPill tone={invoiceTone(inv)}>{invoiceLabel(inv)}</StatusPill>{inv.status === "PAID" && inv.paid_via && <small className="muted"> {inv.paid_via.replace(/_/g, " ")}</small>}</td>
            <td className="num">{money(Math.abs(inv.total_pence))}</td>
            <td className="num">{inv.kind === "CREDIT_NOTE" ? "—" : money(Math.max(0, bal))}</td>
            <td>{inv.kind === "CREDIT_NOTE" ? "—" : when(inv.due_at)}</td>
            <td className="admin-actions admin-invoice-actions">
              <a className="button ghost small" href={`/invoice/${inv.id}?t=${inv.view_token}`} target="_blank" rel="noreferrer">View</a>
              {inv.status !== "VOID" && <ReasonlessAction title="Send" onRun={() => post(`/invoices/${inv.id}/send`, {})} />}
              {finance && inv.kind !== "CREDIT_NOTE" && (inv.status === "OPEN" || inv.status === "UNCOLLECTIBLE") && <ReasonAction title="Mark paid" cta="Record payment" fields={<>
                <label className="workspace-field"><span>Amount (£) — blank for the full balance</span><input name="amount" type="number" step="0.01" min="0.01" placeholder={(bal / 100).toFixed(2)} /></label>
                <label className="workspace-field"><span>Paid via</span><select name="via" defaultValue="bank_transfer"><option value="bank_transfer">Bank transfer</option><option value="card">Card</option><option value="cash">Cash</option><option value="stripe">Stripe</option><option value="other">Other</option></select></label>
                <label className="workspace-field"><span>Reference (optional)</span><input name="ref" maxLength={80} /></label>
              </>} onSubmit={(reason, f) => post(`/invoices/${inv.id}/pay`, { amount_pence: f.get("amount") ? Math.round(Number(f.get("amount")) * 100) : null, via: String(f.get("via")), ref: String(f.get("ref") || ""), reason })} />}
              {finance && inv.kind !== "CREDIT_NOTE" && inv.status !== "VOID" && <ReasonAction title="Credit note" cta="Issue credit note" fields={<>
                <label className="workspace-field"><span>Amount (£)</span><input name="amount" type="number" step="0.01" min="0.01" max={(Math.abs(inv.total_pence) / 100).toFixed(2)} required /></label>
                {inv.status === "PAID" && <label className="workspace-field"><span>Refund</span><select name="refund" defaultValue="none"><option value="none">No refund — keep as account credit</option><option value="bank_transfer">Refunded by bank transfer</option><option value="card">Refunded to card</option><option value="stripe">Refunded via Stripe</option><option value="other">Refunded another way</option></select></label>}
                <label className="workspace-field"><span>Refund reference (optional)</span><input name="ref" maxLength={80} /></label>
              </>} onSubmit={(reason, f) => post(`/invoices/${inv.id}/credit-note`, { amount_pence: Math.round(Number(f.get("amount")) * 100), refund: f.get("refund") && f.get("refund") !== "none" ? { via: String(f.get("refund")), ref: String(f.get("ref") || "") } : undefined, send: true, reason })} />}
              {finance && inv.status === "OPEN" && inv.paid_pence === 0 && inv.kind !== "CREDIT_NOTE" && <AmendInvoiceAction inv={inv} onDone={onChanged} />}
              {finance && inv.status === "OPEN" && inv.kind !== "CREDIT_NOTE" && <ReasonAction title="Write off" cta="Write off" danger onSubmit={(reason) => post(`/invoices/${inv.id}/write-off`, { reason })} />}
              {finance && (inv.status === "OPEN" || inv.status === "UNCOLLECTIBLE" || (inv.status === "PAID" && inv.paid_pence === 0)) && inv.kind !== "CREDIT_NOTE" && <ReasonAction title="Void" cta="Void invoice" danger onSubmit={(reason) => post(`/invoices/${inv.id}/void`, { reason })} />}
            </td>
          </tr>
        ); })}
      </tbody>
    </table>
  );
}

function ReasonlessAction({ title, onRun }: { title: string; onRun: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return <><Button variant="secondary" disabled={busy} onClick={async () => { setBusy(true); setErr(""); try { await onRun(); } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); } }}>{busy ? "…" : title}</Button>{err && <small className="workspace-error">{err}</small>}</>;
}

function AmendInvoiceAction({ inv, onDone }: { inv: AdminInvoice; onDone: () => void }) {
  const lines = JSON.parse(inv.lines_json || "[]") as { label: string; detail?: string; amount_pence: number }[];
  return (
    <ReasonAction title="Amend" cta="Save invoice" fields={<>
      {lines.map((l, i) => (
        <div key={i} className="workspace-form-grid two admin-invoice-line">
          <label className="workspace-field"><span>{i === 0 ? "Description" : ""}</span><input name={`label${i}`} defaultValue={l.label} maxLength={160} /></label>
          <label className="workspace-field"><span>{i === 0 ? "Amount (£)" : ""}</span><input name={`amount${i}`} type="number" step="0.01" defaultValue={(l.amount_pence / 100).toFixed(2)} /></label>
        </div>
      ))}
      <p className="workspace-footnote">Clear a description to drop that line. Discounts and credit already applied stay as they were.</p>
    </>} onSubmit={async (reason, f) => {
      const next = lines.map((l, i) => ({ label: String(f.get(`label${i}`) || "").trim(), detail: l.detail, amount_pence: Math.round(Number(f.get(`amount${i}`) || 0) * 100) })).filter((l) => l.label);
      await adminApi(`/invoices/${inv.id}/lines`, "PUT", { lines: next, reason });
      onDone();
    }} />
  );
}
