// Holiday allowance and tracker for each barber. Days off are recorded on the rota (Team → barber →
// Schedule → Days off, or the Shifts page). Holidays count against the allowance; sick, unpaid and
// other days are listed but don't use it up. Everything here is worked out from the days-off list.
import { useState } from "react";
import type { Staff, StaffDayOff, WorkspaceData } from "../server/domain";
import { Button } from "./ui";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

export const KIND_LABEL: Record<string, string> = { HOLIDAY: "Holiday", SICK: "Sick", UNPAID: "Unpaid", OTHER: "Other" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// The leave year that contains `today`, from the shop's start (MM-DD, default 1 January).
export function leaveYear(start: string | undefined, today: string) {
  const [m, d] = (start && /^\d\d-\d\d$/.test(start) ? start : "01-01").split("-").map(Number);
  const y = Number(today.slice(0, 4));
  const iso = (yy: number) => `${yy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const from = iso(y) <= today ? iso(y) : iso(y - 1);
  const next = iso(Number(from.slice(0, 4)) + 1);
  const to = new Date(Date.parse(next + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);
  return { from, to };
}
const nice = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const days = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} day${n === 1 ? "" : "s"}`;

export function holidayStats(staff: Staff, daysOff: StaffDayOff[], shop: WorkspaceData["shop"], today: string) {
  const year = leaveYear((shop as { leave_year_start?: string }).leave_year_start, today);
  const mine = daysOff.filter((x) => x.staff_id === staff.id && x.date >= year.from && x.date <= year.to);
  const hol = mine.filter((x) => (x.kind ?? "HOLIDAY") === "HOLIDAY");
  const allowance = (staff.holiday_allowance_x2 ?? 0) / 2;
  const carry = (staff.holiday_carry_x2 ?? 0) / 2;
  const taken = hol.filter((x) => x.date <= today).length;
  const booked = hol.filter((x) => x.date > today).length;
  const total = allowance + carry;
  return {
    year,
    allowance,
    carry,
    total,
    taken,
    booked,
    left: total - taken - booked,
    sick: mine.filter((x) => x.kind === "SICK").length,
    unpaid: mine.filter((x) => x.kind === "UNPAID").length,
    other: mine.filter((x) => x.kind === "OTHER").length,
    set: total > 0,
  };
}

export function HolidayTracker({ w, staff, api, canEdit, onSaved, own }: { w: WorkspaceData; staff: Staff; api?: Api; canEdit: boolean; onSaved?: () => void; own?: boolean }) {
  const s = holidayStats(staff, w.days_off, w.shop, w.today);
  const [editing, setEditing] = useState(false);
  const [allowance, setAllowance] = useState(String(s.allowance || ""));
  const [carry, setCarry] = useState(String(s.carry || ""));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const over = s.set && s.left < 0;
  const pctUsed = s.set ? Math.min(100, ((s.taken + s.booked) / s.total) * 100) : 0;
  const pctTaken = s.set ? Math.min(100, (s.taken / s.total) * 100) : 0;
  const first = staff.name.split(" ")[0];
  async function save() {
    if (!api) return;
    setBusy(true);
    setErr("");
    try {
      await api(`/staff/${staff.id}/holiday-allowance`, "PUT", { allowance_days: Number(allowance) || 0, carry_days: Number(carry) || 0 });
      setEditing(false);
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="holiday-tracker" data-testid="holiday-tracker">
      <div className="holiday-head">
        <div>
          <strong>{own ? "Your holiday" : "Holiday"}</strong>
          <small>
            {nice(s.year.from)} to {nice(s.year.to)}
          </small>
        </div>
        {canEdit && !editing && (
          <Button variant="ghost" onClick={() => setEditing(true)} data-testid="edit-allowance">
            {s.set ? "Change allowance" : "Set allowance"}
          </Button>
        )}
      </div>
      {editing ? (
        <div className="holiday-edit">
          <label className="workspace-field narrow">
            <span>Days a year</span>
            <input type="number" min={0} max={365} step={0.5} value={allowance} onChange={(e) => setAllowance(e.target.value)} data-testid="allowance-days" />
          </label>
          <label className="workspace-field narrow">
            <span>Carried over</span>
            <input type="number" min={0} max={365} step={0.5} value={carry} onChange={(e) => setCarry(e.target.value)} />
          </label>
          <Button onClick={save} disabled={busy} data-testid="save-allowance">{busy ? "Saving…" : "Save"}</Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          <p className="workspace-footnote">
            Employed staff who work 5 days a week are entitled to at least 28 days a year, including bank holidays (
            <a href="https://www.gov.uk/holiday-entitlement-rights" target="_blank" rel="noreferrer">GOV.UK</a>). Self-employed barbers don't have a legal allowance, so set whatever you've agreed.
          </p>
          {err && <p className="workspace-error" role="alert">{err}</p>}
        </div>
      ) : s.set ? (
        <>
          <div className="holiday-bar" aria-hidden="true">
            <span className="taken" style={{ width: `${pctTaken}%` }} />
            <span className="booked" style={{ width: `${Math.max(0, pctUsed - pctTaken)}%` }} />
          </div>
          <dl className="holiday-figures">
            <div><dt>Allowance</dt><dd>{days(s.total)}{s.carry ? <small> incl. {days(s.carry)} carried over</small> : null}</dd></div>
            <div><dt>Taken</dt><dd data-testid="holiday-taken">{days(s.taken)}</dd></div>
            <div><dt>Booked</dt><dd data-testid="holiday-booked">{days(s.booked)}</dd></div>
            <div className={over ? "over" : ""}><dt>Left</dt><dd data-testid="holiday-left">{days(s.left)}</dd></div>
          </dl>
        </>
      ) : (
        <p className="workspace-footnote">
          No allowance set yet. {s.taken + s.booked > 0 ? `${days(s.taken + s.booked)} of holiday recorded this year.` : "Days off are still tracked."}
        </p>
      )}
      {over && (
        <p className="holiday-warn" role="status" data-testid="holiday-over">
          {own ? "You're" : `${first} is`} {days(-s.left)} over the allowance this year.
        </p>
      )}
      {(s.sick > 0 || s.unpaid > 0 || s.other > 0) && (
        <p className="workspace-footnote">
          Also this year: {[s.sick && `${days(s.sick)} sick`, s.unpaid && `${days(s.unpaid)} unpaid`, s.other && `${days(s.other)} other`].filter(Boolean).join(", ")}. These don't use up the allowance.
        </p>
      )}
    </section>
  );
}

// Shop-wide summary for the Shifts page: every active barber's holiday at a glance.
export function HolidayTable({ w, api, isOwner, onSaved }: { w: WorkspaceData; api: Api; isOwner: boolean; onSaved: () => void }) {
  const start = (w.shop as { leave_year_start?: string }).leave_year_start ?? "01-01";
  const [m, d] = start.split("-").map(Number);
  const [month, setMonth] = useState(m);
  const [day, setDay] = useState(d);
  const [msg, setMsg] = useState("");
  const year = leaveYear(start, w.today);
  const rows = w.staff.filter((s) => s.active).map((s) => ({ s, h: holidayStats(s, w.days_off, w.shop, w.today) }));
  return (
    <div className="holiday-table-wrap" data-testid="holiday-table">
      <h3>Holiday this year</h3>
      <p className="workspace-footnote">{nice(year.from)} to {nice(year.to)}. Set each barber's allowance under Team, on their Schedule tab.</p>
      <table className="pay-history-table">
        <thead>
          <tr><th>Barber</th><th className="num">Allowance</th><th className="num">Taken</th><th className="num">Booked</th><th className="num">Left</th></tr>
        </thead>
        <tbody>
          {rows.map(({ s, h }) => (
            <tr key={s.id} className={h.set && h.left < 0 ? "over" : ""}>
              <td>{s.name}</td>
              <td className="num">{h.set ? days(h.total) : "Not set"}</td>
              <td className="num">{days(h.taken)}</td>
              <td className="num">{days(h.booked)}</td>
              <td className="num">{h.set ? days(h.left) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {isOwner && (
        <div className="holiday-year">
          <span>Holiday year starts</span>
          <select aria-label="Holiday year start day" value={day} onChange={(e) => setDay(Number(e.target.value))}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <select aria-label="Holiday year start month" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {MONTHS.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
          </select>
          <Button
            variant="secondary"
            disabled={month === m && day === d}
            onClick={async () => {
              setMsg("");
              try {
                await api("/shop/leave-year", "PUT", { leave_year_start: `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` });
                setMsg("Saved.");
                onSaved();
              } catch (e) {
                setMsg(e instanceof Error ? e.message : "Could not save.");
              }
            }}
          >
            Save
          </Button>
          {msg && <small>{msg}</small>}
        </div>
      )}
    </div>
  );
}
