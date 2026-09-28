// Barber's phone home: a clean operational agenda for one person. "Today" is the list of their
// own appointments with the next one up top and one-tap status moves (arrived → in the chair →
// done). "Week" is a strip of their own days with counts. Owners keep the full calendar; this is
// what a barber sees when they sign in on their phone at /staff.
import { useEffect, useMemo, useState } from "react";
import type { StoredBooking, WorkspaceData } from "../server/domain";
import { Avatar, Button, Icon } from "./ui";
import { datePlus, money, time } from "./fixtures";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Range = Pick<StoredBooking, "id" | "staff_id" | "date" | "start_min" | "status">;
const endOf = (b: { start_min: number; duration_min: number }) => b.start_min + b.duration_min;

const initials = (n: string) => n.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtDay = (d: string) => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short" }).format(new Date(d + "T12:00:00Z"));

export function BarberHome({ w, api, date, onDate, onOpen, onRefresh, onNew, onError }: {
  w: WorkspaceData; api: Api; date: string; onDate: (d: string) => void; onOpen: (b: StoredBooking) => void; onRefresh: () => Promise<void>; onNew: () => void; onError: (s: string) => void;
}) {
  const me = w.account?.staff_id || "";
  const staff = w.staff.find((s) => s.id === me);
  const mine = useMemo(() => w.bookings.filter((b) => b.staff_id === me && b.date === date).sort((a, b) => a.start_min - b.start_min), [w.bookings, me, date]);
  const live = mine.filter((b) => !["CANCELLED", "NO_SHOW"].includes(b.status));
  const nowMin = (() => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); })();
  const isToday = date === w.today;
  const current = isToday ? live.find((b) => b.status === "IN_SERVICE") || live.find((b) => b.status === "CHECKED_IN") : undefined;
  // Next up: the first confirmed booking still ahead; if the day is otherwise done, nothing.
  const next = live.find((b) => b.status === "CONFIRMED" && (!isToday || endOf(b) > nowMin)) || (isToday ? undefined : live.find((b) => b.status === "CONFIRMED"));
  const focus = current || next;
  const done = live.filter((b) => b.status === "COMPLETED");
  const takings = done.reduce((s, b) => s + b.price_pence, 0);

  // Week strip: this barber's counts per day, Mon–Sun around the selected date.
  const weekKey = datePlus(date, -((new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7));
  const [week, setWeek] = useState<{ key: string; rows: Range[] } | null>(null);
  useEffect(() => {
    let off = false;
    api<{ bookings: Range[] }>(`/bookings/range?from=${weekKey}&to=${datePlus(weekKey, 6)}`)
      .then((r) => !off && setWeek({ key: weekKey, rows: r.bookings.filter((b) => b.staff_id === me) }))
      .catch(() => {});
    return () => { off = true; };
  }, [weekKey, me, w.bookings.length, w.now]);

  const [busy, setBusy] = useState("");
  async function move(b: StoredBooking, status: "CHECKED_IN" | "IN_SERVICE" | "COMPLETED") {
    setBusy(b.id);
    try {
      await api(`/bookings/${b.id}/status`, "POST", { status, reason: "", version: b.version });
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not update the appointment.");
    } finally { setBusy(""); }
  }
  const nextStep = (b: StoredBooking): { status: "CHECKED_IN" | "IN_SERVICE" | "COMPLETED"; label: string; icon: string } | null =>
    b.status === "CONFIRMED" ? { status: "CHECKED_IN", label: "Arrived", icon: "check" } : b.status === "CHECKED_IN" ? { status: "IN_SERVICE", label: "In the chair", icon: "scissors" } : b.status === "IN_SERVICE" ? { status: "COMPLETED", label: "Done", icon: "paid" } : null;

  const offToday = (() => {
    const wd = new Date(date + "T12:00:00Z").getUTCDay();
    const o = w.schedule_overrides.find((x) => x.staff_id === me && x.date === date);
    const h = o ?? w.hours.find((x) => x.staff_id === me && x.weekday === wd);
    return !h?.enabled || w.days_off.some((d) => d.staff_id === me && d.date === date);
  })();

  return (
    <section className="barber-home" aria-label="Your day" data-testid="barber-home">
      <header className="barber-home-head">
        <div>
          <p className="barber-home-kicker">{isToday ? "Today" : fmtDay(date)}</p>
          <h1>{isToday ? `Hi ${(staff?.name || w.account?.name || "").split(" ")[0]}` : `${live.length} appointment${live.length === 1 ? "" : "s"}`}</h1>
        </div>
        {isToday && (
          <p className="barber-home-stats" data-testid="barber-stats">
            <span><b>{live.length}</b> booked</span>
            <span><b>{done.length}</b> done</span>
            <span><b>{money(takings)}</b> taken</span>
          </p>
        )}
      </header>

      <div className="barber-week" role="tablist" aria-label="This week" data-testid="barber-week">
        {Array.from({ length: 7 }, (_, i) => datePlus(weekKey, i)).map((d) => {
          const rows = week?.key === weekKey ? week.rows.filter((b) => b.date === d && !["CANCELLED", "NO_SHOW"].includes(b.status)) : [];
          const wd = new Date(d + "T12:00:00Z").getUTCDay();
          const off = !w.hours.find((x) => x.staff_id === me && x.weekday === wd)?.enabled || w.days_off.some((x) => x.staff_id === me && x.date === d);
          return (
            <button key={d} type="button" role="tab" aria-selected={d === date} className={`barber-week-day ${d === w.today ? "is-today" : ""} ${off ? "is-off" : ""}`} onClick={() => onDate(d)} data-testid={`barber-day-${d}`}>
              <small>{DAY[wd]}</small>
              <b>{Number(d.slice(8))}</b>
              <span className="barber-week-count" aria-label={`${rows.length} appointments`}>{off && !rows.length ? "–" : rows.length || ""}</span>
            </button>
          );
        })}
      </div>
      <div className="barber-week-nav">
        <Button variant="ghost" className="icon-only" aria-label="Previous week" onClick={() => onDate(datePlus(date, -7))}><Icon name="left" /></Button>
        <Button variant="secondary" onClick={() => onDate(w.today)} disabled={isToday}>Today</Button>
        <Button variant="ghost" className="icon-only" aria-label="Next week" onClick={() => onDate(datePlus(date, 7))}><Icon name="right" /></Button>
      </div>

      {focus && (
        <article className={`barber-focus ${focus.status === "IN_SERVICE" ? "in-chair" : ""}`} data-testid="barber-focus">
          <header>
            <span className="barber-focus-label">{focus.status === "IN_SERVICE" ? "In the chair" : focus.status === "CHECKED_IN" ? "Waiting for you" : isToday ? "Next up" : "First up"}</span>
            <strong className="barber-focus-time">{time(focus.start_min)}–{time(endOf(focus))}</strong>
          </header>
          <button type="button" className="barber-focus-body" onClick={() => onOpen(focus)}>
            <Avatar initials={initials(focus.customer_name)} colour={staff?.colour || "sage"} size="large" />
            <span>
              <b>{focus.customer_name}</b>
              <small>{focus.service_name} · {focus.duration_min} min · {money(focus.price_pence)}</small>
              {focus.notes && <small className="barber-note"><Icon name="message" size={12} /> {focus.notes}</small>}
            </span>
            <Icon name="right" />
          </button>
          <div className="barber-focus-actions">
            {focus.phone && <a className="button secondary" href={`tel:${focus.phone.replace(/\s/g, "")}`}><Icon name="call" size={15} /> Call</a>}
            {nextStep(focus) && (
              <Button onClick={() => move(focus, nextStep(focus)!.status)} disabled={busy === focus.id} data-testid="barber-advance">
                <Icon name={nextStep(focus)!.icon as "check"} size={15} /> {nextStep(focus)!.label}
              </Button>
            )}
          </div>
        </article>
      )}

      {live.length === 0 ? (
        <div className="workspace-empty barber-empty" data-testid="barber-empty">
          <Icon name={offToday ? "sun" : "calendar"} size={34} />
          <h2>{offToday ? "Day off" : isToday ? "Nothing booked today" : "Nothing booked"}</h2>
          <p>{offToday ? "Enjoy it. Your next working day is on the strip above." : "Walk-ins can be added with the + button."}</p>
        </div>
      ) : (
        <ol className="barber-agenda" aria-label="Appointments" data-testid="barber-agenda">
          {live.map((b) => {
            const past = isToday && endOf(b) <= nowMin && b.status === "CONFIRMED";
            const step = nextStep(b);
            return (
              <li key={b.id} className={`barber-row status-${b.status.toLowerCase()} ${past ? "is-past" : ""} ${focus?.id === b.id ? "is-focus" : ""}`} data-testid="barber-row">
                <span className="barber-row-time"><b>{time(b.start_min)}</b><small>{b.duration_min} min</small></span>
                <button type="button" className="barber-row-main" onClick={() => onOpen(b)}>
                  <b>{b.customer_name}</b>
                  <small>{b.service_name} · {money(b.price_pence)}{b.channel === "ONLINE" ? " · online" : ""}</small>
                  {b.status !== "CONFIRMED" && <em className={`barber-status s-${b.status.toLowerCase()}`}>{b.status === "CHECKED_IN" ? "Arrived" : b.status === "IN_SERVICE" ? "In the chair" : "Done"}</em>}
                </button>
                {step && b.status !== "COMPLETED" && (
                  <button type="button" className={`barber-row-step ${b.status === "IN_SERVICE" ? "is-done" : ""}`} aria-label={`${step.label}: ${b.customer_name}`} onClick={() => move(b, step.status)} disabled={busy === b.id}>
                    <Icon name={step.icon as "check"} size={16} />
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {mine.some((b) => ["CANCELLED", "NO_SHOW"].includes(b.status)) && (
        <details className="closed-day-bookings">
          <summary><h3>Cancelled and no-shows</h3><span className="nav-count">{mine.filter((b) => ["CANCELLED", "NO_SHOW"].includes(b.status)).length}</span></summary>
          <ul className="barber-agenda muted">
            {mine.filter((b) => ["CANCELLED", "NO_SHOW"].includes(b.status)).map((b) => (
              <li key={b.id} className="barber-row is-past"><span className="barber-row-time"><b>{time(b.start_min)}</b></span><button type="button" className="barber-row-main" onClick={() => onOpen(b)}><b>{b.customer_name}</b><small>{b.service_name} · {b.status === "CANCELLED" ? "Cancelled" : "No-show"}</small></button></li>
            ))}
          </ul>
        </details>
      )}
      <div className="barber-new">
        <Button onClick={onNew} data-testid="barber-new"><Icon name="plus" size={16} /> Add a walk-in</Button>
      </div>
    </section>
  );
}
