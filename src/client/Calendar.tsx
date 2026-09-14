import {
  useEffect,
  useState,
  type KeyboardEvent,
  type CSSProperties,
} from "react";
import type { WorkspaceData, StoredBooking } from "../server/domain";
import { Avatar, Icon } from "./ui";
import { time, money, datePlus } from "./fixtures";

export type CalendarDraft = { staffId: string; start: number };
// Native buttons remain buttons (not an incomplete ARIA grid). One free slot
// per barber is tabbable; arrows move focus only and never mutate bookings.
function navigateSlots(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const keys = [
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
  ];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  const button = event.currentTarget;
  const board = button.closest(".calendar-board");
  const slots = Array.from(
    board?.querySelectorAll<HTMLButtonElement>(
      ".timetable-slot:not(:disabled)",
    ) || [],
  );
  const column = Number(button.dataset.column);
  const minute = Number(button.dataset.minute);
  const sameColumn = slots.filter((s) => Number(s.dataset.column) === column);
  const index = sameColumn.indexOf(button);
  let target: HTMLButtonElement | undefined;
  if (event.key === "Home") target = sameColumn[0];
  if (event.key === "End") target = sameColumn.at(-1);
  if (event.key === "ArrowUp") target = sameColumn[index - 1];
  if (event.key === "ArrowDown") target = sameColumn[index + 1];
  if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const columns = [...new Set(slots.map((s) => Number(s.dataset.column)))]
      .filter((c) => (c - column) * direction > 0)
      .sort((a, b) => (a - b) * direction);
    target = slots
      .filter((s) => Number(s.dataset.column) === columns[0])
      .sort(
        (a, b) =>
          Math.abs(Number(a.dataset.minute) - minute) -
          Math.abs(Number(b.dataset.minute) - minute),
      )[0];
  }
  target?.focus();
}

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
  const [focusedSlot, setFocusedSlot] = useState<
    (CalendarDraft & { date: string }) | null
  >(null);
  const [activeSlots, setActiveSlots] = useState<Record<string, number>>({});
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
  const step = 44; // 15-minute cell; short events keep a 24px minimum plus agenda/detail alternatives.
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
      <div className="calendar-legend" aria-label="Timetable legend">
        <span>
          <i className="legend-free" aria-hidden="true" /> Free chair time
        </span>
        <span>
          <i className="legend-unavailable" aria-hidden="true" /> Break / leave
          / closed
        </span>
        <span>
          <i className="legend-buffer" aria-hidden="true" /> Buffer
        </span>
        <span>Card colour = barber · open short visits for full details</span>
      </div>
      <div
        className="calendar-scroll connected-scroll"
        tabIndex={0}
        role="region"
        aria-label="Saved appointment timetable"
        aria-describedby="timetable-keyboard-help"
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
            {staff.map((s) => (
              <div className="staff-column-heading" key={s.id}>
                <Avatar
                  initials={s.name
                    .split(" ")
                    .map((n) => n[0])
                    .slice(0, 2)
                    .join("")}
                  colour={
                    ["sage", "sand", "blue", "clay"][
                      w.staff.findIndex((member) => member.id === s.id) % 4
                    ]
                  }
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
              const slots = Array.from(
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
                              : date < today ||
                                  (date === today && start <= currentMinute)
                                ? "Past time"
                                : "";
                  const busy = dayBookings.some(
                    (b) =>
                      b.staff_id === s.id &&
                      start >= b.start_min &&
                      start < b.start_min + b.duration_min + b.buffer_min,
                  );
                  return { start, reason, busy };
                },
              );
              const enabledSlots = slots.filter(
                (slot) => !disabled && !slot.reason && !slot.busy,
              );
              const activeMinute =
                enabledSlots.find(
                  (slot) => slot.start === activeSlots[`${date}:${s.id}`],
                )?.start ?? enabledSlots[0]?.start;
              const colour = ["sage", "sand", "blue", "clay"][
                w.staff.findIndex((member) => member.id === s.id) % 4
              ];
              return (
                <div className="barber-column" key={s.id}>
                  {slots.map(({ start, reason, busy }, n) => {
                    return (
                      <button
                        key={start}
                        type="button"
                        className={`timetable-slot ${reason ? "blocked" : busy ? "occupied" : ""}`}
                        data-column={i}
                        data-minute={start}
                        tabIndex={start === activeMinute ? 0 : -1}
                        aria-describedby="timetable-keyboard-help"
                        onKeyDown={navigateSlots}
                        onFocus={() => {
                          setActiveSlots((previous) => ({
                            ...previous,
                            [`${date}:${s.id}`]: start,
                          }));
                          setFocusedSlot({ date, staffId: s.id, start });
                        }}
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
                          {reason
                            ? n === 0 ||
                              slots[n - 1].reason !== reason ||
                              n % 4 === 0
                              ? reason
                              : ""
                            : busy
                              ? "Occupied"
                              : `${time(start)} +`}
                        </span>
                      </button>
                    );
                  })}
                  {dayBookings
                    .filter((b) => b.staff_id === s.id && b.buffer_min > 0)
                    .map((b) => (
                      <div
                        key={`buffer-${b.id}`}
                        className="calendar-buffer"
                        style={{
                          top:
                            ((b.start_min + b.duration_min - begin) / 15) *
                            step,
                          height: (b.buffer_min / 15) * step,
                        }}
                        title={`${time(b.start_min + b.duration_min)}–${time(b.start_min + b.duration_min + b.buffer_min)} · Buffer`}
                      >
                        <span>{b.buffer_min} min buffer</span>
                      </div>
                    ))}
                  {occupied
                    .filter((b) => b.staff_id === s.id)
                    .map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        className={`calendar-event ${colour} ${b.status === "COMPLETED" ? "finished" : ""} ${b.duration_min < 15 ? "compact-event" : ""}`}
                        data-status={b.status}
                        style={{
                          top: ((b.start_min - begin) / 15) * step,
                          height: Math.max(
                            24,
                            (b.duration_min / 15) * step - 3,
                          ),
                        }}
                        onClick={() => onOpen(b)}
                        aria-label={`${b.customer_name}, ${b.service_name}, ${time(b.start_min)}, ${labels[b.status]}`}
                        title={`${b.customer_name} · ${b.service_name} · ${time(b.start_min)}–${time(b.start_min + b.duration_min)} · ${labels[b.status]} · ${money(b.price_pence)}`}
                      >
                        <strong>
                          <time>{time(b.start_min)}</time> {b.customer_name}
                        </strong>
                        {b.duration_min >= 30 && <span>{b.service_name}</span>}
                        {b.duration_min >= 15 && (
                          <small className="event-status">
                            {labels[b.status]}
                            {b.duration_min >= 45
                              ? ` · ${money(b.price_pence)}`
                              : ""}
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
      <div className="calendar-slot-context" role="status">
        {focusedSlot?.date === date &&
        staff.some((s) => s.id === focusedSlot.staffId)
          ? `Last focused chair time: ${time(focusedSlot.start)} · ${staff.find((s) => s.id === focusedSlot.staffId)?.name} · ${date}. Selecting a cell only starts a draft; review and confirm to save.`
          : ""}
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
      <p className="calendar-keyboard-help" id="timetable-keyboard-help">
        Tab to a free slot or appointment. Arrow keys move between free slots;
        Home / End jump within a barber. Enter opens a draft. Agenda and New
        booking are alternatives.
      </p>
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
