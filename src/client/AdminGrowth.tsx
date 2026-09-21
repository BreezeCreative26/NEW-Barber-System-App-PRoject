import { useEffect, useState, type FormEvent } from "react";
import { Button, Icon, Notice, StatusPill } from "./ui";
import { money } from "./fixtures";
import { adminApi, when, ReasonAction } from "./Admin";

// Admin: alerts inbox, MRR trend, CSV exports, broadcasts to shop owners.

type Alert = { id: string; kind: string; severity: "INFO" | "WARN" | "CRIT"; shop_id: string | null; shop_name: string | null; title: string; detail: string; created_at: number; acked_at: number | null; emailed_at: number | null };
export function AdminAlerts({ onShop }: { onShop: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const [d, setD] = useState<{ alerts: Alert[]; alert_email: string } | null>(null);
  const [swept, setSwept] = useState<string>("");
  const load = () => adminApi<typeof d>(`/alerts?all=${all ? 1 : 0}`).then(setD);
  useEffect(() => { void load(); }, [all]);
  if (!d) return <p className="workspace-footnote">Loading…</p>;
  const open = d.alerts.filter((a) => !a.acked_at);
  return (
    <section className="admin-section" data-testid="admin-alerts">
      <header className="admin-section-head">
        <h1>Alerts <small>{open.length} open</small></h1>
        <div className="toolbar">
          <label className="admin-check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show acknowledged</label>
          <Button variant="secondary" onClick={async () => { const r = await adminApi<{ lifecycle: number; alerts_emailed: number; snapshot: string | null }>("/sweep", "POST", {}); setSwept(`Checked now · ${r.lifecycle} lifecycle email${r.lifecycle === 1 ? "" : "s"} sent · ${r.alerts_emailed} alert${r.alerts_emailed === 1 ? "" : "s"} emailed`); await load(); }}>Check now</Button>
          {open.length > 0 && <Button variant="secondary" onClick={async () => { await adminApi("/alerts/ack-all", "POST", {}); await load(); }}>Acknowledge all</Button>}
        </div>
      </header>
      <Notice icon="bell">{d.alert_email ? <>Warnings and critical alerts are emailed to <strong>{d.alert_email}</strong> (batched, at most every 30 minutes).</> : <>Set <code>OLLO_ALERT_EMAIL</code> in the environment to get warnings and critical alerts by email. Until then they only appear here.</>} Checks run automatically every few minutes while the app is in use.</Notice>
      {swept && <p className="workspace-footnote" data-testid="admin-swept">{swept}</p>}
      {d.alerts.length === 0 ? <p className="muted">Nothing to report.</p> : (
        <ul className="admin-alert-list">
          {d.alerts.map((a) => (
            <li key={a.id} className={`admin-alert ${a.severity.toLowerCase()} ${a.acked_at ? "acked" : ""}`} data-testid="admin-alert">
              <Icon name={a.severity === "CRIT" ? "alert" : a.severity === "WARN" ? "bell" : "check"} size={16} />
              <div>
                <strong>{a.title}</strong>
                {a.detail && <p>{a.detail}</p>}
                <small>{when(a.created_at)} · {a.kind.replace(/_/g, " ").toLowerCase()}{a.shop_id && <> · <button type="button" className="linklike" onClick={() => onShop(a.shop_id!)}>{a.shop_name ?? "open shop"}</button></>}{a.emailed_at ? " · emailed" : ""}{a.acked_at ? ` · acknowledged ${when(a.acked_at)}` : ""}</small>
              </div>
              {!a.acked_at && <Button variant="ghost" onClick={async () => { await adminApi(`/alerts/${a.id}/ack`, "POST", {}); await load(); }}>Acknowledge</Button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Snapshot = { day: string; mrr_pence: number; active: number; trial: number; past_due: number; paused: number; cancelled: number; new_shops: number; converted: number; churned: number };
export function Trend() {
  const [d, setD] = useState<{ snapshots: Snapshot[]; last_30d: { signups: number; converted: number; churned: number; trials_finished: number; conversion_pct: number | null; churn_pct: number | null } } | null>(null);
  useEffect(() => { adminApi<typeof d>("/trend?days=90").then(setD).catch(() => setD({ snapshots: [], last_30d: { signups: 0, converted: 0, churned: 0, trials_finished: 0, conversion_pct: null, churn_pct: null } })); }, []);
  if (!d) return null;
  const s = d.snapshots;
  const first = s[0], last = s[s.length - 1];
  const delta = first && last ? last.mrr_pence - first.mrr_pence : 0;
  return (
    <div className="admin-trend" data-testid="admin-trend">
      <div className="admin-trend-head">
        <h2>Trend · 90 days</h2>
        <div className="admin-trend-facts">
          <span><strong>{d.last_30d.signups}</strong> sign-ups · 30d</span>
          <span><strong>{d.last_30d.converted}</strong> converted{d.last_30d.conversion_pct != null && <> · {d.last_30d.conversion_pct}%</>}</span>
          <span><strong>{d.last_30d.churned}</strong> cancelled{d.last_30d.churn_pct != null && <> · {d.last_30d.churn_pct}% churn</>}</span>
          {s.length > 1 && <span className={delta >= 0 ? "up" : "down"}>MRR {delta >= 0 ? "+" : "−"}{money(Math.abs(delta))} since {first.day}</span>}
        </div>
      </div>
      {s.length < 2 ? <p className="muted">The trend fills in as daily snapshots are taken (one per day from now). {s.length === 1 && <>Today: {money(s[0].mrr_pence)} MRR · {s[0].active} active · {s[0].trial} trials.</>}</p> : <Sparkline data={s} />}
    </div>
  );
}
function Sparkline({ data }: { data: Snapshot[] }) {
  const W = 720, H = 120, P = 8;
  const max = Math.max(1, ...data.map((d) => d.mrr_pence));
  const maxShops = Math.max(1, ...data.map((d) => d.active + d.trial));
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(1, data.length - 1);
  const yM = (v: number) => H - P - (v * (H - 2 * P)) / max;
  const yS = (v: number) => H - P - (v * (H - 2 * P)) / maxShops;
  const mrr = data.map((d, i) => `${x(i)},${yM(d.mrr_pence)}`).join(" ");
  const shops = data.map((d, i) => `${x(i)},${yS(d.active)}`).join(" ");
  const trials = data.map((d, i) => `${x(i)},${yS(d.active + d.trial)}`).join(" ");
  return (
    <figure className="admin-sparkline">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="MRR and shop counts over time">
        <polyline points={trials} fill="none" stroke="#c9c5b8" strokeWidth="1.5" strokeDasharray="3 3" />
        <polyline points={shops} fill="none" stroke="#6b6f6d" strokeWidth="1.5" />
        <polyline points={mrr} fill="none" stroke="#0b1a17" strokeWidth="2.5" />
      </svg>
      <figcaption><span><i style={{ background: "#0b1a17" }} /> MRR (now {money(data[data.length - 1].mrr_pence)})</span><span><i style={{ background: "#6b6f6d" }} /> paying shops ({data[data.length - 1].active})</span><span><i style={{ background: "#c9c5b8" }} /> + trials ({data[data.length - 1].trial})</span><span>{data[0].day} → {data[data.length - 1].day}</span></figcaption>
    </figure>
  );
}

export function Exports() {
  const [from, setFrom] = useState(() => new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  return (
    <div className="workspace-panel admin-exports" data-testid="admin-exports">
      <h3>Exports <small className="muted">CSV for your accountant</small></h3>
      <div className="admin-actions">
        <a className="button secondary" href="/api/admin/export/shops.csv" download><Icon name="download" size={14} /> Shops</a>
        <span className="admin-export-range"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" /> – <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" /><a className="button secondary" href={`/api/admin/export/invoices.csv?from=${from}&to=${to}`} download><Icon name="download" size={14} /> Invoices</a></span>
        <span className="admin-export-range"><input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Usage month" /><a className="button secondary" href={`/api/admin/export/usage.csv?period=${period}`} download><Icon name="download" size={14} /> Usage</a></span>
      </div>
    </div>
  );
}

type Broadcast = { id: string; subject: string; heading: string; body: string; cta_label: string; cta_url: string; segment_json: string; status: string; recipients: number; sent: number; author: string; created_at: number; sent_at: number | null; test_sent_to: string };
const STATUSES = ["TRIAL", "ACTIVE", "PAST_DUE", "PAUSED", "CANCELLED"] as const;
export function AdminBroadcasts({ me }: { me: { role: string; email: string } }) {
  const [list, setList] = useState<Broadcast[] | null>(null);
  const [seg, setSeg] = useState<{ status: string[]; trial_ending_days: number | ""; feature: string }>({ status: [], trial_ending_days: "", feature: "" });
  const [preview, setPreview] = useState<{ count: number; sample: { shop: string; email: string }[] } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => adminApi<{ broadcasts: Broadcast[] }>("/broadcasts").then((r) => setList(r.broadcasts));
  useEffect(() => { void load(); }, []);
  const segment = () => ({ ...(seg.status.length ? { status: seg.status } : {}), ...(seg.trial_ending_days ? { trial_ending_days: Number(seg.trial_ending_days) } : {}), ...(seg.feature ? { feature: seg.feature } : {}) });
  useEffect(() => { const t = setTimeout(() => adminApi<typeof preview>("/broadcasts/preview", "POST", segment()).then(setPreview).catch(() => setPreview(null)), 200); return () => clearTimeout(t); }, [seg]);
  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setErr(""); setBusy(true);
    const f = new FormData(e.currentTarget); const form = e.currentTarget;
    try {
      await adminApi("/broadcasts", "POST", { subject: String(f.get("subject")), heading: String(f.get("heading") || ""), body: String(f.get("body")), cta_label: String(f.get("cta_label") || ""), cta_url: String(f.get("cta_url") || ""), segment: segment() });
      form.reset(); await load();
    } catch (x) { setErr(x instanceof Error ? x.message : "Failed"); } finally { setBusy(false); }
  };
  return (
    <section className="admin-section" data-testid="admin-broadcasts">
      <h1>Broadcasts <small>announcements to shop owners</small></h1>
      <div className="admin-two">
        <form className="workspace-panel workspace-form" onSubmit={create} data-testid="admin-new-broadcast">
          <h3>New announcement</h3>
          <label className="workspace-field"><span>Subject</span><input name="subject" required minLength={3} maxLength={120} placeholder="e.g. New: AI receptionist answers your phone" /></label>
          <label className="workspace-field"><span>Heading (optional)</span><input name="heading" maxLength={120} /></label>
          <label className="workspace-field"><span>Message</span><textarea name="body" required minLength={10} maxLength={5000} rows={7} placeholder={"Plain text. Blank line between paragraphs.\n\nIt goes out from OLLO to the shop owner's email."} /></label>
          <div className="workspace-form-grid two">
            <label className="workspace-field"><span>Button label (optional)</span><input name="cta_label" maxLength={40} placeholder="Find out more" /></label>
            <label className="workspace-field"><span>Button link</span><input name="cta_url" type="url" maxLength={300} placeholder="https://…" /></label>
          </div>
          <fieldset className="admin-segment">
            <legend>Who gets it</legend>
            <div className="admin-actions">{STATUSES.map((s) => <label key={s} className="admin-check"><input type="checkbox" checked={seg.status.includes(s)} onChange={(e) => setSeg({ ...seg, status: e.target.checked ? [...seg.status, s] : seg.status.filter((x) => x !== s) })} /> {s === "PAST_DUE" ? "Overdue" : s[0] + s.slice(1).toLowerCase()}</label>)}</div>
            <div className="workspace-form-grid two">
              <label className="workspace-field"><span>Trial ending within (days)</span><input type="number" min={1} max={60} value={seg.trial_ending_days} onChange={(e) => setSeg({ ...seg, trial_ending_days: e.target.value ? Number(e.target.value) : "" })} placeholder="any" /></label>
              <label className="workspace-field"><span>Has feature</span><select value={seg.feature} onChange={(e) => setSeg({ ...seg, feature: e.target.value })}><option value="">any</option><option value="ai_concierge">AI Concierge</option><option value="sms">Texts</option><option value="whatsapp">WhatsApp</option><option value="card_payments">Card payments</option></select></label>
            </div>
            <p className="workspace-footnote" data-testid="admin-segment-preview">{preview ? <><strong>{preview.count}</strong> owner{preview.count === 1 ? "" : "s"} match{preview.sample.length ? ` — e.g. ${preview.sample.slice(0, 3).map((s) => s.shop).join(", ")}` : ""}.</> : "Counting…"} Leave everything blank for every shop.</p>
          </fieldset>
          {err && <p className="workspace-error" role="alert">{err}</p>}
          <div className="workspace-save-actions"><Button type="submit" disabled={busy}>Save draft</Button></div>
        </form>
        <div className="workspace-panel">
          <h3>Drafts &amp; sent</h3>
          {!list ? <p className="muted">Loading…</p> : list.length === 0 ? <p className="muted">None yet.</p> : (
            <ul className="admin-broadcast-list">
              {list.map((b) => (
                <li key={b.id} data-testid="admin-broadcast">
                  <div className="admin-broadcast-head"><strong>{b.subject}</strong><StatusPill tone={b.status === "SENT" ? "good" : b.status === "CANCELLED" ? "note" : "next"}>{b.status[0] + b.status.slice(1).toLowerCase()}</StatusPill></div>
                  <small>{b.author} · {when(b.created_at)}{b.status === "SENT" ? ` · sent to ${b.sent} of ${b.recipients}` : ""}{b.test_sent_to ? ` · test sent to ${b.test_sent_to}` : ""} · audience {describeSegment(b.segment_json)}</small>
                  <p className="admin-broadcast-body">{b.body.length > 220 ? b.body.slice(0, 220) + "…" : b.body}</p>
                  {b.status === "DRAFT" && (
                    <div className="admin-actions">
                      <Button variant="secondary" onClick={async () => { await adminApi(`/broadcasts/${b.id}/test`, "POST", { to: me.email }); await load(); }}>Send me a test</Button>
                      {me.role === "SUPER" && <ReasonAction title="Send to everyone matching" cta="Send now" danger onSubmit={async (reason) => { await adminApi(`/broadcasts/${b.id}/send`, "POST", { reason }); await load(); }} />}
                      <Button variant="ghost" onClick={async () => { await adminApi(`/broadcasts/${b.id}/cancel`, "POST", {}); await load(); }}>Discard</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
function describeSegment(json: string) {
  try {
    const s = JSON.parse(json || "{}") as { status?: string[]; trial_ending_days?: number; feature?: string };
    const parts: string[] = [];
    if (s.status?.length) parts.push(s.status.map((x) => (x === "PAST_DUE" ? "overdue" : x.toLowerCase())).join("/"));
    if (s.trial_ending_days) parts.push(`trial ends ≤${s.trial_ending_days}d`);
    if (s.feature) parts.push(`has ${s.feature.replace(/_/g, " ")}`);
    return parts.length ? parts.join(" · ") : "all shops";
  } catch { return "all shops"; }
}
