import { useEffect, useState } from "react";
import { Button, Icon, StatusPill } from "./ui";
import { money } from "./fixtures";

// Settings → Billing, top of the page: this month's invoice as it builds. Every text is a dated line,
// the total updates the moment a message goes out, and the shop can see when the invoice closes,
// when it's due, and what next month is likely to cost at the current pace.

type Line = { label: string; amount_pence: number; detail: string };
type Item = { id: string; at: number; feature_key: string; unit: string; label: string; detail: string; quantity: number; unit_pence: number; amount_pence: number; billable: boolean };
type Daily = { day: string; quantity: number; amount_pence: number };
export type Statement = {
  period: string; period_start: number; period_end: number; closes_at: number; due_at: number; days_left: number;
  status: "TRIAL" | "BUILDING" | "PAUSED";
  lines: Line[]; subtotal_pence: number; discount_pence: number; tax_pence: number; total_pence: number; vat_mode: string;
  usage: { feature_key: string; name: string; unit: string; quantity: number; included: number; billable: number; unit_pence: number; amount_pence: number }[];
  items: Item[]; items_total: number; daily: Daily[];
  forecast: { period: string; lines: Line[]; total_pence: number; basis: string };
};
type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

const monthName = (key: string) => new Date(key + "-01T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
const dayShort = (ts: number) => new Date(ts).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const timeShort = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dateLong = (ts: number) => new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "long" });

export function RunningBill({ api, apiBase, refreshKey = 0 }: { api: Api; apiBase: string; refreshKey?: number }) {
  const [s, setS] = useState<Statement | null>(null);
  const [err, setErr] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState<string>("");
  useEffect(() => {
    api<Statement>("/billing/statement").then(setS).catch((e) => setErr(e instanceof Error ? e.message : "Could not load your statement."));
  }, [refreshKey]);
  if (err) return <p className="workspace-error" role="alert">{err}</p>;
  if (!s) return <p className="workspace-footnote">Loading your statement…</p>;

  const texts = s.usage.find((u) => u.feature_key === "sms");
  const usageTotal = s.usage.reduce((n, u) => n + u.amount_pence, 0);
  const fixedTotal = s.subtotal_pence - usageTotal;
  const maxDay = Math.max(1, ...s.daily.map((d) => d.quantity));
  const items = s.items.filter((i) => !filter || i.feature_key === filter);
  const shown = showAll ? items : items.slice(0, 12);
  const kinds = Array.from(new Set(s.items.map((i) => i.feature_key)));
  const kindName = (k: string) => s.usage.find((u) => u.feature_key === k)?.name ?? k;

  // Group itemised lines by day so the list reads like a bank statement.
  const groups: { day: string; items: Item[]; total: number }[] = [];
  for (const it of shown) {
    const day = new Date(it.at).toISOString().slice(0, 10);
    let g = groups[groups.length - 1];
    if (!g || g.day !== day) { g = { day, items: [], total: 0 }; groups.push(g); }
    g.items.push(it);
    g.total += it.amount_pence;
  }

  return (
    <section className="rbill" aria-labelledby="rbill-heading" data-testid="running-bill">
      <div className="rbill-hero">
        <div className="rbill-hero-main">
          <div className="rbill-kicker">
            <StatusPill tone={s.status === "BUILDING" ? "next" : s.status === "TRIAL" ? "good" : "note"} data-testid="rbill-status">
              {s.status === "BUILDING" ? "Invoice building" : s.status === "TRIAL" ? "Free trial" : "Paused"}
            </StatusPill>
            <span>{monthName(s.period)}</span>
          </div>
          <h3 id="rbill-heading" className="rbill-total" data-testid="billing-total">{money(s.total_pence)}</h3>
          <p className="rbill-sub">
            {s.status === "TRIAL"
              ? <>What this month would cost. Nothing is charged during your trial.</>
              : <>So far this month. Closes <strong>{dateLong(s.closes_at)}</strong> · due <strong>{dateLong(s.due_at)}</strong> · {s.days_left} day{s.days_left === 1 ? "" : "s"} to go.</>}
          </p>
          <ul className="rbill-split">
            <li><span>Plan, seats &amp; add-ons</span><strong>{money(fixedTotal)}</strong></li>
            <li><span>Texts &amp; messages{texts ? <small> · {texts.quantity} text{texts.quantity === 1 ? "" : "s"} × {texts.unit_pence}p</small> : null}</span><strong data-testid="rbill-usage-total">{money(usageTotal)}</strong></li>
            {s.discount_pence > 0 && <li className="rbill-discount"><span>Discount</span><strong>−{money(s.discount_pence)}</strong></li>}
            {s.tax_pence > 0 ? <li><span>VAT</span><strong>{money(s.tax_pence)}</strong></li> : <li className="rbill-novat"><small>No VAT is charged</small></li>}
          </ul>
        </div>
        <div className="rbill-hero-side">
          <div className="rbill-chart" role="img" aria-label={`Texts sent per day this month, ${s.daily.reduce((n, d) => n + d.quantity, 0)} in total`}>
            {s.daily.map((d) => (
              <span key={d.day} className={`rbill-bar${d.quantity ? "" : " empty"}`} style={{ height: `${Math.max(4, Math.round((d.quantity / maxDay) * 100))}%` }} title={`${d.day}: ${d.quantity} · ${money(d.amount_pence)}`} />
            ))}
          </div>
          <p className="rbill-chart-cap">Messages per day · updates the moment one is sent</p>
        </div>
      </div>

      <div className="rbill-grid">
        <div className="workspace-panel rbill-items">
          <header className="billing-card-head">
            <h3>Itemised</h3>
            <div className="rbill-tools">
              {kinds.length > 1 && (
                <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter items">
                  <option value="">Everything</option>
                  {kinds.map((k) => <option key={k} value={k}>{kindName(k)}</option>)}
                </select>
              )}
              <a className="button ghost" href={`${apiBase}/billing/statement.csv?period=${s.period}`} download data-testid="rbill-csv"><Icon name="download" size={14} /> CSV</a>
            </div>
          </header>
          {s.items_total === 0 ? (
            <p className="workspace-footnote" data-testid="rbill-empty">No texts or messages sent yet this month. Each one will appear here with the date, type and who it went to.</p>
          ) : (
            <ol className="rbill-list" data-testid="rbill-items">
              {groups.map((g) => (
                <li key={g.day} className="rbill-day">
                  <div className="rbill-day-head"><span>{dayShort(new Date(g.day + "T12:00:00Z").getTime())}</span><strong>{money(g.total)}</strong></div>
                  <ul>
                    {g.items.map((it) => (
                      <li key={it.id} data-testid="rbill-item">
                        <time>{timeShort(it.at)}</time>
                        <span className="rbill-item-text"><b>{it.label}</b><small>{it.detail}</small></span>
                        <strong className={it.billable ? "" : "rbill-free"}>{it.billable ? money(it.amount_pence) : "included"}</strong>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
          {items.length > 12 && (
            <Button variant="ghost" onClick={() => setShowAll((v) => !v)} data-testid="rbill-more">{showAll ? "Show fewer" : `Show all ${items.length}`}</Button>
          )}
          {s.items_total > s.items.length && showAll && <p className="workspace-footnote">Showing the latest {s.items.length} of {s.items_total}. Download the CSV for the full month.</p>}
        </div>

        <aside className="workspace-panel rbill-forecast" aria-labelledby="rbill-forecast-h">
          <header className="billing-card-head"><h3 id="rbill-forecast-h">Next month, at this pace</h3><span className="billing-period">{monthName(s.forecast.period)}</span></header>
          <ul className="billing-lines" data-testid="rbill-forecast">
            {s.forecast.lines.map((l, i) => <li key={i}><span>{l.label}<small>{l.detail}</small></span><strong>{money(l.amount_pence)}</strong></li>)}
            <li className="billing-total"><span>Likely total</span><strong data-testid="rbill-forecast-total">{money(s.forecast.total_pence)}</strong></li>
          </ul>
          <p className="workspace-footnote">Based on {s.forecast.basis}. Texts are {texts?.unit_pence ?? 8}p each; emails are free. Fewer texts next month means a smaller bill — nothing is fixed until the invoice closes.</p>
        </aside>
      </div>
    </section>
  );
}
