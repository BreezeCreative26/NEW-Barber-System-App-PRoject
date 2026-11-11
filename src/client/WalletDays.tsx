// Day by day (full wallet): pick any day with ‹ › or the calendar and see what each barber took that day
// (card, cash, transfer, £0 visits) and what it added to the wallet. Barbers only ever get their own.
import { useEffect, useState } from "react";
import type { WorkspaceData } from "../server/domain";
import type { WalletDay } from "../server/walletDays";
import { Icon, IconButton, StatusPill } from "./ui";
import { money, datePlus } from "./fixtures";
import { PaymentRows, compact, longDay } from "./WalletPage";

type DaysResp = { staff: { id: string; name: string }[]; days: WalletDay[] };
const monthStart = (d: string) => d.slice(0, 8) + "01";
const monthEnd = (d: string) => { const x = new Date(monthStart(d) + "T12:00:00Z"); x.setUTCMonth(x.getUTCMonth() + 1, 0); return x.toISOString().slice(0, 10); };
const monthLabel = (d: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(d + "T12:00:00Z"));

export function WalletDays({ w, api, self, onOpenBooking }: { w: WorkspaceData; api: <T>(path: string) => Promise<T>; self: boolean; onOpenBooking?: (id: string) => void }) {
  const [day, setDay] = useState(w.today);
  const [calOpen, setCalOpen] = useState(false);
  const [calMonth, setCalMonth] = useState(monthStart(w.today));
  const [month, setMonth] = useState<DaysResp | null>(null);
  const [error, setError] = useState("");
  const shownMonth = calOpen ? calMonth : monthStart(day);
  useEffect(() => {
    let off = false;
    const to = monthEnd(shownMonth) < w.today ? monthEnd(shownMonth) : w.today;
    if (shownMonth > w.today) { setMonth({ staff: [], days: [] }); return; }
    api<DaysResp>(`/wallet/days?from=${shownMonth}&to=${to}&payments=1`).then((d) => !off && setMonth(d)).catch((e) => !off && setError(e instanceof Error ? e.message : "Could not load the days."));
    return () => { off = true; };
  }, [shownMonth, w.now, w.payments.length]);
  const sel = month?.days.find((d) => d.date === day) ?? null;
  const go = (n: number) => { const d = datePlus(day, n); if (d <= w.today) { setDay(d); setCalMonth(monthStart(d)); } };
  return (
    <div className="wallet-days-view">
      {error && <p className="workspace-error" role="alert">{error}</p>}
        <section className="wq-day" data-testid="wallet-day">
          <div className="wq-daybar">
            <IconButton name="left" label="Previous day" onClick={() => go(-1)} />
            <button type="button" className="wq-daylabel" aria-expanded={calOpen} onClick={() => { setCalOpen((v) => !v); setCalMonth(monthStart(day)); }} data-testid="wallet-day-label">
              <Icon name="calendar" size={15} /> {day === w.today ? `Today · ${longDay(day)}` : longDay(day)}
            </button>
            <IconButton name="right" label="Next day" disabled={day >= w.today} onClick={() => go(1)} />
          </div>
          {calOpen && <MonthGrid month={calMonth} today={w.today} selected={day} days={month?.days ?? []} onMonth={setCalMonth} onPick={(d) => { setDay(d); setCalOpen(false); }} />}
          {!sel && <p className="drawer-note left">Loading…</p>}
          {sel && (
            <>
              <div className="wq-daytotals" data-testid="wallet-day-totals">
                <div><small>Taken</small><b data-testid="wd-taken">{money(sel.taken)}</b></div>
                <div><small>Card</small><b data-testid="wd-card">{money(sel.reader)}</b></div>
                <div><small>Kept</small><b data-testid="wd-kept">{money(sel.kept)}</b></div>
                <div className="owed"><small>{self ? "Owed to you" : "Owed to barbers"}</small><b data-testid="wd-owed">{money(sel.owed_to_barbers)}</b></div>
              </div>
              {sel.owed_to_shop > 0 && <p className="drawer-note left">{money(sel.owed_to_shop)} owed to the shop that day (rent on a cash day).</p>}
              {sel.barbers.length === 0 && <p className="drawer-note left">Nothing taken on {longDay(day)}.</p>}
              {sel.barbers.map((b) => (
                <article key={b.staff_id} className="wq-daycard" data-testid="wallet-day-barber" data-staff={b.staff_id}>
                  <header>
                    <strong>{self ? "You" : b.name}</strong>
                    {b.paid ? <StatusPill tone="paid">Paid</StatusPill> : <span className="muted">{b.visits} visit{b.visits === 1 ? "" : "s"}{b.zero_visits ? ` · ${b.zero_visits} at £0` : ""}</span>}
                  </header>
                  <dl className="wq-dayline">
                    <div><dt>Taken</dt><dd data-testid="wdb-taken">{money(b.taken)}</dd></div>
                    <div><dt>Card</dt><dd data-testid="wdb-card">{money(b.reader + b.online)}</dd></div>
                    <div><dt>Cash</dt><dd>{money(b.cash)}</dd></div>
                    <div><dt>Transfer</dt><dd>{money(b.transfer + b.other)}</dd></div>
                  </dl>
                  <p className="wq-dayowed">
                    {b.fee > 0 && <span>Fee − {money(b.fee)}</span>}
                    {b.rent > 0 && <span>Rent − {money(b.rent)}</span>}
                    <b className={b.owed < 0 ? "neg" : ""} data-testid="wdb-owed">{b.owed < 0 ? `Owes shop ${money(-b.owed)}` : `Owed ${money(b.owed)}`}</b>
                  </p>
                  {b.rows && b.rows.length > 0 && (
                    <details>
                      <summary>{b.rows.length} payment{b.rows.length === 1 ? "" : "s"}</summary>
                      <PaymentRows rows={b.rows} onOpenBooking={onOpenBooking} />
                    </details>
                  )}
                </article>
              ))}
            </>
          )}
        </section>
    </div>
  );
}

// Month calendar: each day shows what was taken and what it added to the wallet.
function MonthGrid({ month, today, selected, days, onMonth, onPick }: { month: string; today: string; selected: string; days: WalletDay[]; onMonth: (m: string) => void; onPick: (d: string) => void }) {
  const first = new Date(month + "T12:00:00Z");
  const lead = (first.getUTCDay() + 6) % 7;
  const end = monthEnd(month);
  const cells: (string | null)[] = [...Array(lead).fill(null)];
  for (let d = month; d <= end; d = datePlus(d, 1)) cells.push(d);
  const prev = monthStart(datePlus(month, -1));
  const next = monthStart(datePlus(end, 1));
  return (
    <div className="wq-cal" data-testid="wallet-calendar">
      <div className="wq-calhead">
        <IconButton name="left" label="Previous month" onClick={() => onMonth(prev)} />
        <b>{monthLabel(month)}</b>
        <IconButton name="right" label="Next month" disabled={next > today} onClick={() => onMonth(next)} />
      </div>
      <div className="wq-calgrid" role="grid">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <span key={i} className="wq-dow">{d}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={i} />;
          const info = days.find((x) => x.date === d);
          const future = d > today;
          return (
            <button key={d} type="button" disabled={future} aria-pressed={d === selected} className={`${d === today ? "today" : ""} ${info && info.taken ? "has" : ""}`} onClick={() => onPick(d)} data-testid="wallet-cal-day" data-date={d}>
              <span>{Number(d.slice(8))}</span>
              {info && info.taken > 0 && <small title={`Taken ${money(info.taken)} · owed ${money(info.owed_to_barbers)}`}>{compact(info.taken)}</small>}
              {info && info.owed_to_barbers > 0 && <em>{compact(info.owed_to_barbers)}</em>}
            </button>
          );
        })}
      </div>
      <p className="drawer-note left"><small>top</small> taken · <em>bottom</em> owed to barbers</p>
    </div>
  );
}

