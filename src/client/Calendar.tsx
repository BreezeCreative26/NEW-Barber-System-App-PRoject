import { useEffect, useState, type CSSProperties } from "react";
import type { WorkspaceData, StoredBooking } from "../server/domain";
import { Avatar, Icon } from "./ui";
import { time, money, datePlus } from "./fixtures";

export type CalendarDraft = { staffId: string; start: number };
const labels: Record<string, string> = {
  CONFIRMED: "Confirmed",
  CHECKED_IN: "Checked in",
  IN_SERVICE: "In service",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No-show",
};

// Presentation only: a timetable click is a draft, never a reservation or availability guarantee.
export function Calendar({
  w,
  date,
  barber,
  bookings,
  disabled,
  onDraft,
  onOpen,
}: {
  w: WorkspaceData;
  date: string;
  barber: string;
  bookings: StoredBooking[];
  disabled: boolean;
  onDraft: (draft: CalendarDraft) => void;
  onOpen: (booking: StoredBooking) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const staff = w.staff.filter(
    (s) =>
      (!barber || s.id === barber) &&
      (s.active || bookings.some((b) => b.staff_id === s.id)),
  );
  const occupied = bookings.filter(
    (b) => !["CANCELLED", "NO_SHOW"].includes(b.status),
  );
  const dayBookings = w.bookings.filter(
    (b) => b.date === date && !["CANCELLED", "NO_SHOW"].includes(b.status),
  );
  const begin =
    Math.floor(
      Math.min(w.shop.opens, ...dayBookings.map((b) => b.start_min)) / 60,
    ) * 60;
  const end = Math.min(
    1440,
    Math.ceil(
      Math.max(
        w.shop.closes,
        ...dayBookings.map((b) => b.start_min + b.duration_min + b.buffer_min),
      ) / 60,
    ) * 60,
  );
  const step = 28; // 15-minute cell. Short events still have an accessible full description.
  const height = ((end - begin) / 15) * step;
  const closed =
    JSON.parse(w.shop.closed_days).includes(
      new Date(date + "T12:00:00Z").getUTCDay(),
    ) || w.holidays.some((h) => h.date === date);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: w.shop.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const currentMinute =
    Number(parts.find((p) => p.type === "hour")?.value) * 60 +
    Number(parts.find((p) => p.type === "minute")?.value);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: w.shop.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  if (!staff.length)
    return (
      <p className="calendar-empty">
        No barbers match this view. Add a barber or clear the filter.
      </p>
    );
  return (
    <>
      <div
        className="calendar-scroll connected-scroll"
        tabIndex={0}
        role="region"
        aria-label="Saved appointment timetable"
      >
        <div
          className="calendar-board"
          style={
            {
              "--columns": staff.length,
              minWidth: Math.max(310, staff.length * 190 + 64),
            } as CSSProperties
          }
        >
          <div className="calendar-staff-header">
            <div className="timezone-label">
              UK time<span>London</span>
            </div>
            {staff.map((s, i) => (
              <div className="staff-column-heading" key={s.id}>
                <Avatar
                  initials={s.name
                    .split(" ")
                    .map((n) => n[0])
                    .slice(0, 2)
                    .join("")}
                  colour={["sage", "sand", "blue", "clay"][i % 4]}
                />
                <div>
                  <strong>{s.name}</strong>
                  <span>
                    {occupied.filter((b) => b.staff_id === s.id).length}{" "}
                    appointments
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div
            className="calendar-timeline connected-timeline"
            style={{ height }}
          >
            <div className="time-gutter">
              {Array.from({ length: Math.ceil((end - begin) / 60) }, (_, i) => (
                <span key={i} style={{ top: i * step * 4 }}>
                  {time(begin + i * 60)}
                </span>
              ))}
            </div>
            {staff.map((s, i) => {
              const shift =
                w.schedule_overrides.find(
                  (o) => o.staff_id === s.id && o.date === date,
                ) ||
                w.hours.find(
                  (h) =>
                    h.staff_id === s.id &&
                    h.weekday === new Date(date + "T12:00:00Z").getUTCDay(),
                );
              const leave = w.days_off.some(
                (d) => d.staff_id === s.id && d.date === date,
              );
              return (
                <div className="barber-column" key={s.id}>
                  {Array.from(
                    { length: Math.ceil((end - begin) / 15) },
                    (_, n) => {
                      const start = begin + n * 15;
                      const reason = !s.active
                        ? "Inactive barber"
                        : closed
                          ? "Shop closed"
                          : leave
                            ? "Day off"
                            : !shift?.enabled
                              ? "Off duty"
                              : start < Math.max(w.shop.opens, shift.starts) ||
                                  start >= Math.min(w.shop.closes, shift.ends)
                                ? "Outside hours"
                                : start >= shift.break_start &&
                                    start < shift.break_end
                                  ? "Break"
                                  : "";
                      const busy = dayBookings.some(
                        (b) =>
                          b.staff_id === s.id &&
                          start >= b.start_min &&
                          start < b.start_min + b.duration_min + b.buffer_min,
                      );
                      return (
                        <button
                          key={start}
                          type="button"
                          className={`timetable-slot ${reason ? "blocked" : ""}`}
                          style={{ top: n * step, height: step }}
                          aria-label={`${time(start)}, ${s.name}${reason ? ` — ${reason}` : busy ? " — occupied or buffer" : " — add booking"}`}
                          title={
                            reason ||
                            (busy
                              ? "Appointment / buffer"
                              : `Add booking at ${time(start)}; service availability is checked next`)
                          }
                          disabled={disabled || !!reason || busy}
                          onClick={() => onDraft({ staffId: s.id, start })}
                        >
                          <span>
                            {reason ? (n % 4 === 0 ? reason : "") : "+"}
                          </span>
                        </button>
                      );
                    },
                  )}
                  {occupied
                    .filter((b) => b.staff_id === s.id)
                    .map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        className={`calendar-event ${["sage", "sand", "blue", "clay"][i % 4]} ${b.status === "COMPLETED" ? "finished" : ""}`}
                        style={{
                          top: ((b.start_min - begin) / 15) * step,
                          height: Math.max(
                            24,
                            (b.duration_min / 15) * step - 3,
                          ),
                        }}
                        onClick={() => onOpen(b)}
                        aria-label={`${b.customer_name}, ${b.service_name}, ${time(b.start_min)}, ${labels[b.status]}`}
                        title={`${b.customer_name} · ${b.service_name} · ${labels[b.status]} · ${money(b.price_pence)}`}
                      >
                        <strong>{b.customer_name}</strong>
                        {b.duration_min >= 20 && <span>{b.service_name}</span>}
                        {b.duration_min >= 30 && (
                          <small>
                            {time(b.start_min)} · {labels[b.status]} ·{" "}
                            {money(b.price_pence)}
                          </small>
                        )}
                      </button>
                    ))}
                </div>
              );
            })}
            {date === today &&
              currentMinute >= begin &&
              currentMinute < end && (
                <div
                  className="connected-now"
                  style={{ top: ((currentMinute - begin) / 15) * step }}
                  aria-label={`Current time ${time(currentMinute)}`}
                >
                  <span>{time(currentMinute)}</span>
                </div>
              )}
          </div>
        </div>
      </div>
      <footer className="calendar-footer">
        <span>
          <Icon name="clock" size={15} /> Click a free 15-minute cell to start a
          booking.
        </span>
        <span>
          Service + extras + 10-minute buffer are checked before saving.
        </span>
      </footer>
    </>
  );
}

export function WeekStrip({
  date,
  onDate,
}: {
  date: string;
  onDate: (date: string) => void;
}) {
  const monday = datePlus(
    date,
    -((new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7),
  );
  return (
    <div className="week-strip" aria-label="Calendar week dates">
      {Array.from({ length: 7 }, (_, i) => datePlus(monday, i)).map((d) => (
        <button
          type="button"
          key={d}
          aria-pressed={d === date}
          onClick={() => onDate(d)}
          aria-label={new Intl.DateTimeFormat("en-GB", {
            dateStyle: "full",
          }).format(new Date(d + "T12:00:00Z"))}
        >
          <span>
            {new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(
              new Date(d + "T12:00:00Z"),
            )}
          </span>
          <strong>{d.slice(-2)}</strong>
        </button>
      ))}
    </div>
  );
}
