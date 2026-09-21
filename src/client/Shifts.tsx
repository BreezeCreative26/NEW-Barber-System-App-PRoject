import { useMemo, useState } from "react";
import type { Staff, StaffDayOff, Holiday, ScheduleOverride, WorkspaceData } from "../server/domain";
import { Button, Icon, Notice, StatusPill, Avatar } from "./ui";
import { time, shopWeekOf } from "./fixtures";

// Shifts: the roster by date. Day = one row per barber with status, hours, break, blocks and
// utilisation; Week = barber × day grid; Leave = upcoming days off and closures. Every edit goes
// through the same dialogs as the calendar (so the conflict resolver runs) via the callbacks.

type Props = {
  w: WorkspaceData;
  date: string;
  onDate: (d: string) => void;
  onEditDay: (staff: Staff, date: string) => void;
  onDayOff: (staff: Staff) => void;
  onWeekly: (staff: Staff) => void;
  onHoliday: () => void;
  onRemoveDayOff: (d: StaffDayOff) => void;
  onRemoveHoliday: (h: Holiday) => void;
  onOpenBooking: (id: string) => void;
};

const wd = (d: string) => new Date(d + "T12:00:00Z").getUTCDay();
const plus = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const nice = (d: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", opts);
const initials = (n: string) => n.split(" ").map((p) => p[0]).slice(0, 2).join("");

type DayState =
  | { kind: "closed"; label: string }
  | { kind: "leave"; label: string; leave: StaffDayOff }
  | { kind: "off" }
  | { kind: "in"; starts: number; ends: number; break_start: number; break_end: number; dated: ScheduleOverride | null };

export function dayState(w: WorkspaceData, s: Staff, date: string): DayState {
  const hol = w.holidays.find((h) => h.date === date);
  if (hol) return { kind: "closed", label: hol.label };
  if (!shopWeekOf(w.shop)[wd(date)].enabled) return { kind: "closed", label: "Shop closed" };
  const leave = w.days_off.find((d) => d.staff_id === s.id && d.date === date);
  if (leave) return { kind: "leave", label: leave.reason, leave };
  const o = w.schedule_overrides.find((x) => x.staff_id === s.id && x.date === date) ?? null;
  const h = o ?? w.hours.find((x) => x.staff_id === s.id && x.weekday === wd(date));
  if (!h || !h.enabled) return { kind: "off" };
  return { kind: "in", starts: h.starts, ends: h.ends, break_start: h.break_start, break_end: h.break_end, dated: o };
}

export function Shifts({ w, date, onDate, onEditDay, onDayOff, onWeekly, onHoliday, onRemoveDayOff, onRemoveHoliday, onOpenBooking }: Props) {
  const [view, setView] = useState<"day" | "week" | "leave">("day");
  const staff = useMemo(() => w.staff.filter((s) => s.active), [w.staff]);
  const weekStart = useMemo(() => { const d = wd(date); return plus(date, -((d + 6) % 7)); }, [date]); // Monday
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => plus(weekStart, i)), [weekStart]);

  // Bookings by staff/date for utilisation (from the workspace snapshot; day view is exact for the selected date).
  const booked = (s: Staff, d: string) => w.bookings.filter((b) => b.staff_id === s.id && b.date === d && !["CANCELLED", "NO_SHOW"].includes(b.status));
  const issuesFor = (s: Staff, d: string) => w.issues.filter((i) => booked(s, d).some((b) => b.id === i.booking_id));

  const dayRows = staff.map((s) => {
    const st = dayState(w, s, date);
    const bs = booked(s, date);
    const blocks = w.blocks.filter((k) => k.staff_id === s.id && k.date === date);
    const chair = st.kind === "in" ? st.ends - st.starts - Math.max(0, st.break_end - st.break_start) - blocks.reduce((n, k) => n + (k.end_min - k.start_min), 0) : 0;
    const used = bs.reduce((n, b) => n + b.duration_min, 0);
    return { s, st, bs, blocks, chair, used, issues: issuesFor(s, date) };
  });
  const totals = dayRows.reduce((t, r) => ({ chair: t.chair + r.chair, used: t.used + r.used, in: t.in + (r.st.kind === "in" ? 1 : 0), visits: t.visits + r.bs.length }), { chair: 0, used: 0, in: 0, visits: 0 });

  const upcomingLeave = [...w.days_off].filter((d) => d.date >= w.today).sort((a, b) => a.date.localeCompare(b.date));
  const upcomingHolidays = [...w.holidays].filter((h) => h.date >= w.today).sort((a, b) => a.date.localeCompare(b.date));

  return (
    <section className="shifts" aria-labelledby="shifts-heading" data-testid="shifts">
      <header className="shifts-head">
        <h2 id="shifts-heading" className="visually-hidden">Shifts roster</h2>
        <div className="toolbar shifts-toolbar">
          <div className="segmented" role="tablist" aria-label="Shifts view">
            {(["day", "week", "leave"] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} data-testid={`shifts-tab-${v}`}>
                {v === "day" ? "Day" : v === "week" ? "Week" : "Leave"}
              </button>
            ))}
          </div>
          {view !== "leave" && (
            <span className="toolbar-date-group">
              <Button variant="ghost" className="icon-only" aria-label={view === "week" ? "Previous week" : "Previous day"} onClick={() => onDate(plus(date, view === "week" ? -7 : -1))}><Icon name="left" size={18} /></Button>
              <input type="date" value={date} onChange={(e) => e.target.value && onDate(e.target.value)} aria-label="Shifts date" className="toolbar-date" />
              <Button variant="ghost" className="icon-only" aria-label={view === "week" ? "Next week" : "Next day"} onClick={() => onDate(plus(date, view === "week" ? 7 : 1))}><Icon name="right" size={18} /></Button>
              <Button variant="secondary" onClick={() => onDate(w.today)} aria-pressed={date === w.today}>Today</Button>
            </span>
          )}
          <Button variant="secondary" onClick={onHoliday}><Icon name="blocked" size={16} /> Close the shop</Button>
        </div>
      </header>

      {view === "day" && (
        <div className="shifts-day" data-testid="shifts-day">
          <p className="shifts-summary">
            <strong>{nice(date, { weekday: "long", day: "numeric", month: "long" })}</strong> · {totals.in} of {staff.length} working · {totals.visits} appointment{totals.visits === 1 ? "" : "s"} · {totals.chair ? `${Math.round((totals.used / totals.chair) * 100)}% of chair time booked` : "no chair time"}
          </p>
          <ul className="shifts-rows">
            {dayRows.map(({ s, st, bs, blocks, chair, used, issues }) => (
              <li key={s.id} className="shifts-row" data-state={st.kind} data-testid="shift-row">
                <div className="shifts-who">
                  <Avatar initials={initials(s.name)} colour={s.colour || "sage"} src={s.photo_url} />
                  <div>
                    <strong>{s.name}</strong>
                    <small>{s.role || "Barber"}</small>
                  </div>
                </div>
                <div className="shifts-state">
                  {st.kind === "in" && <StatusPill tone="good">In</StatusPill>}
                  {st.kind === "off" && <StatusPill tone="note">Day off</StatusPill>}
                  {st.kind === "leave" && <StatusPill tone="warn" title={st.label}>Leave</StatusPill>}
                  {st.kind === "closed" && <StatusPill tone="note" title={st.label}>Closed</StatusPill>}
                  {st.kind === "in" && st.dated && <small className="shifts-dated" title={st.dated.reason}>dated · {st.dated.reason}</small>}
                  {st.kind === "leave" && <small>{st.label}</small>}
                </div>
                <div className="shifts-hours">
                  {st.kind === "in" ? (
                    <>
                      <span className="shifts-time">{time(st.starts)}–{time(st.ends)}</span>
                      {st.break_end > st.break_start && <small>break {time(st.break_start)}–{time(st.break_end)}</small>}
                      {blocks.map((k) => <small key={k.id} className="shifts-block"><Icon name="blocked" size={11} /> {time(k.start_min)}–{time(k.end_min)} {k.reason || k.kind.toLowerCase()}</small>)}
                    </>
                  ) : <span className="muted">—</span>}
                </div>
                <div className="shifts-load">
                  {st.kind === "in" ? (
                    <>
                      <div className="shifts-bar" aria-hidden="true"><span style={{ width: `${chair ? Math.min(100, (used / chair) * 100) : 0}%` }} /></div>
                      <small>{bs.length} visit{bs.length === 1 ? "" : "s"} · {used} of {chair} min</small>
                    </>
                  ) : bs.length > 0 ? (
                    <small className="shifts-warn"><Icon name="alert" size={12} /> {bs.length} appointment{bs.length === 1 ? "" : "s"} still booked</small>
                  ) : <small className="muted">nothing booked</small>}
                  {issues.length > 0 && (
                    <small className="shifts-warn">
                      <Icon name="alert" size={12} /> {issues.length} need{issues.length === 1 ? "s" : ""} moving —{" "}
                      {issues.map((i, n) => <button key={i.booking_id} type="button" className="linklike" onClick={() => onOpenBooking(i.booking_id)}>{i.ref}{n < issues.length - 1 ? "," : ""}</button>)}
                    </small>
                  )}
                </div>
                <div className="shifts-actions">
                  <Button variant="secondary" onClick={() => onEditDay(s, date)} data-testid="shift-edit"><Icon name="clock" size={16} /> Edit day</Button>
                  <Button variant="ghost" onClick={() => onDayOff(s)}>Day off</Button>
                  <Button variant="ghost" onClick={() => onWeekly(s)}>Weekly</Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {view === "week" && (
        <div className="shifts-week-wrap" data-testid="shifts-week">
          <table className="shifts-week">
            <thead>
              <tr>
                <th scope="col">Barber</th>
                {weekDays.map((d) => <th key={d} scope="col" className={d === w.today ? "today" : ""}>{DAYS[wd(d)]} <small>{new Date(d + "T12:00:00Z").getUTCDate()}</small></th>)}
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id}>
                  <th scope="row"><div className="shifts-who"><Avatar initials={initials(s.name)} colour={s.colour || "sage"} src={s.photo_url} /><strong>{s.name.split(" ")[0]}</strong></div></th>
                  {weekDays.map((d) => {
                    const st = dayState(w, s, d);
                    const n = booked(s, d).length;
                    return (
                      <td key={d} data-state={st.kind} className={d === w.today ? "today" : ""}>
                        <button type="button" className="shifts-cell" onClick={() => onEditDay(s, d)} aria-label={`${s.name} ${nice(d)}: ${st.kind === "in" ? `${time(st.starts)} to ${time(st.ends)}` : st.kind}`}>
                          {st.kind === "in" ? (
                            <>
                              <span>{time(st.starts)}–{time(st.ends)}</span>
                              {st.dated && <small className="shifts-dated">dated</small>}
                            </>
                          ) : st.kind === "leave" ? <span className="shifts-cell-leave">Leave</span> : st.kind === "closed" ? <span className="muted">Closed</span> : <span className="muted">Off</span>}
                          {n > 0 && <small className={st.kind === "in" ? "" : "shifts-warn"}>{n} booked</small>}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="workspace-footnote">Click any cell to set dated hours or a day off for that barber and date.</p>
        </div>
      )}

      {view === "leave" && (
        <div className="shifts-leave" data-testid="shifts-leave">
          <div className="shifts-leave-col">
            <h3>Days off</h3>
            {upcomingLeave.length === 0 && <p className="workspace-footnote">No upcoming days off.</p>}
            <ul className="shifts-leave-list">
              {upcomingLeave.map((d) => {
                const s = w.staff.find((x) => x.id === d.staff_id);
                const n = s ? booked(s, d.date).length : 0;
                return (
                  <li key={d.id}>
                    <div><strong>{s?.name ?? "—"}</strong> · {nice(d.date)}<br /><small>{d.reason}</small>{n > 0 && <small className="shifts-warn"> · {n} appointment{n === 1 ? "" : "s"} still booked</small>}</div>
                    <Button variant="ghost" onClick={() => onRemoveDayOff(d)}>Remove</Button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="shifts-leave-col">
            <h3>Shop closures</h3>
            {upcomingHolidays.length === 0 && <p className="workspace-footnote">No upcoming closures.</p>}
            <ul className="shifts-leave-list">
              {upcomingHolidays.map((h) => (
                <li key={h.id}>
                  <div><strong>{nice(h.date)}</strong><br /><small>{h.label}</small></div>
                  <Button variant="ghost" onClick={() => onRemoveHoliday(h)}>Remove</Button>
                </li>
              ))}
            </ul>
            <Button variant="secondary" onClick={onHoliday}><Icon name="plus" size={16} /> Add closure</Button>
          </div>
          <Notice>Adding leave or a closure that lands on booked appointments asks you what to do with each customer before anything is saved.</Notice>
        </div>
      )}
    </section>
  );
}
