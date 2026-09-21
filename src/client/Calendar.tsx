import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { WorkspaceData, StoredBooking, Staff, StaffBlock } from "../server/domain";
import { Avatar, BlockIcons, Icon } from "./ui";
import { time, money, datePlus, shopDayOf } from "./fixtures";

// Phone-first timetable: below this width columns narrow and the board scrolls sideways
// inside its own region so the page itself never overflows.
const PHONE = "(max-width: 767px)";
export function useCompact() {
  const [compact, setCompact] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const update = () => setCompact(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return compact;
}

export type CalendarDraft = { staffId: string; start: number; outside?: string };
// Where a drag may land and what the shop is knowingly overriding there ("" = clean slot).
export type MoveTarget = { staffId: string; start: number; override: string };
// New length after dragging the bottom edge (15-min steps) and what it overrides, if anything.
export type ResizeTarget = { duration: number; override: string };

// Overlapping appointments share the column side by side (Google/Fresha style). Cluster bookings
// whose intervals touch, then assign each a lane greedily; every card in a cluster gets the same
// lane count so widths line up.
export function layoutLanes<T extends { id: string; start_min: number; duration_min: number }>(items: T[]) {
  const sorted = [...items].sort((a, b) => a.start_min - b.start_min || b.duration_min - a.duration_min);
  const out = new Map<string, { lane: number; lanes: number }>();
  let cluster: T[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const laneEnds: number[] = [];
    const placed: { id: string; lane: number }[] = [];
    for (const b of cluster) {
      let lane = laneEnds.findIndex((e) => e <= b.start_min);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = b.start_min + Math.max(b.duration_min, 5);
      placed.push({ id: b.id, lane });
    }
    for (const p of placed) out.set(p.id, { lane: p.lane, lanes: laneEnds.length });
    cluster = [];
    clusterEnd = -1;
  };
  for (const b of sorted) {
    if (cluster.length && b.start_min >= clusterEnd) flush();
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.start_min + Math.max(b.duration_min, 5));
  }
  if (cluster.length) flush();
  return out;
}

// Haptic "click" as the drag passes each 15-minute line (touch devices); desktop gets a CSS tick.
function tick() {
  try {
    navigator.vibrate?.(6);
  } catch {
    /* not supported */
  }
}
// Slot reasons the shop may knowingly book over from the calendar. Mirrors OVERRIDABLE_REASONS server-side.
const SOFT_REASONS = new Set(["Outside hours", "Off duty", "Break", "Occupied", "Blocked"]);
const HARD_REASONS = new Set(["Past time", "Shop closed", "Day off", "Inactive barber"]);
export const BLOCK_LABELS: Record<StaffBlock["kind"], string> = { LUNCH: "Lunch", TRAINING: "Training", PERSONAL: "Personal", SICK: "Off sick", OTHER: "Blocked" };
export function blockLabel(b: Pick<StaffBlock, "kind" | "reason">) {
  return b.reason || BLOCK_LABELS[b.kind];
}
// What a barber may do from the ⋯ menu beside their name on the timetable.
export type StaffAction = "hours" | "block" | "dayOff" | "walkIn";
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
  // Arrow keys hop between free cells only; greyed/occupied cells stay reachable by pointer.
  const slots = Array.from(
    board?.querySelectorAll<HTMLButtonElement>(
      ".timetable-slot:not(:disabled):not(.blocked):not(.occupied)",
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
// "BST" / "GMT" / "CET" style short name for the timezone gutter; falls back to the region.
function tzShort(tz: string, at: number) {
  try {
    const part = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
    return part && part.length <= 5 ? part : tz.split("/")[0];
  } catch {
    return tz.split("/")[0];
  }
}
export function Calendar({
  w,
  date,
  barber,
  bookings,
  disabled,
  onDraft,
  onOpen,
  onHours,
  onMove,
  onAction,
  onBlock,
  onRemoveBlock,
  onResize,
  team,
  paid = new Set<string>(),
}: {
  paid?: Set<string>;
  onResize?: (booking: StoredBooking, to: ResizeTarget) => Promise<void> | void;
  w: WorkspaceData;
  date: string;
  barber: string;
  bookings: StoredBooking[];
  disabled: boolean;
  onDraft: (draft: CalendarDraft) => void;
  onOpen: (booking: StoredBooking) => void;
  onHours?: (staff: Staff, date: string) => void;
  onMove?: (booking: StoredBooking, to: MoveTarget) => Promise<void> | void;
  // Per-barber ⋯ menu. `block` may carry the slot that was right-clicked / chosen.
  onAction?: (action: StaffAction, staff: Staff, at?: number) => void;
  onBlock?: (block: StaffBlock) => void;
  onRemoveBlock?: (block: StaffBlock) => void;
  // Extra (non-rostered) barbers the user added to the day via "Scheduled team".
  team?: Set<string>;
}) {
  // Pointer-driven drag: the card's TOP edge is the booking time. `overStart` is snapped to 15 min.
  const [dragging, setDragging] = useState<{ id: string; overStaff: string; overStart: number; tick: number } | null>(null);
  // Bottom-edge resize: the card's END snaps to 15 minutes; duration = end - start.
  const [resizing, setResizing] = useState<{ id: string; duration: number; tick: number } | null>(null);
  const resizeRef = useRef<{ id: string; pointerId: number; origin: number } | null>(null);
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    grabOffsetY: number; // px from card top to the pointer at grab time
    originStaff: string;
    originStart: number;
    startX: number;
    startY: number;
    armed: boolean; // moved past the slop threshold, so this is a drag not a click
    timer: number | null; // long-press arm on touch
  } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ staffId: string; start: number } | null>(null);
  const [focusedSlot, setFocusedSlot] = useState<
    (CalendarDraft & { date: string }) | null
  >(null);
  const [activeSlots, setActiveSlots] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());
  const compact = useCompact();
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.(".staff-menu")) setMenu(null);
    };
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [menu]);
  const weekdayOf = new Date(date + "T12:00:00Z").getUTCDay();
  // Scheduled team (Fresha): rostered barbers show by default; others only when the user adds them
  // for the day (or when they hold an appointment). A barber filter overrides all of that.
  const rostered = (s: Staff) => {
    const shift = w.schedule_overrides.find((o) => o.staff_id === s.id && o.date === date) || w.hours.find((h) => h.staff_id === s.id && h.weekday === weekdayOf);
    return !!shift?.enabled && !w.days_off.some((d) => d.staff_id === s.id && d.date === date);
  };
  const staff = w.staff.filter(
    (s) =>
      (!barber || s.id === barber) &&
      (s.active || bookings.some((b) => b.staff_id === s.id)) &&
      (barber || !team || rostered(s) || team.has(s.id) || bookings.some((b) => b.staff_id === s.id)),
  );
  const dayBlocks = w.blocks.filter((b) => b.date === date);
  // Returning customers: the same customer record holds more than one saved visit in the workspace snapshot.
  const regulars = (() => {
    const seen = new Map<string, number>();
    for (const b of w.bookings) if (b.customer_id && b.status !== "CANCELLED") seen.set(b.customer_id, (seen.get(b.customer_id) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([id]) => id));
  })();
  const occupied = bookings.filter(
    (b) => !["CANCELLED", "NO_SHOW"].includes(b.status),
  );
  const dayBookings = w.bookings.filter(
    (b) => b.date === date && !["CANCELLED", "NO_SHOW"].includes(b.status),
  );
  const dayHours = shopDayOf(w.shop, date);
  const begin =
    Math.floor(
      Math.min(dayHours.starts, ...dayBookings.map((b) => b.start_min), ...dayBlocks.map((k) => k.start_min)) / 60,
    ) * 60;
  const end = Math.min(
    1440,
    Math.ceil(
      Math.max(
        dayHours.ends,
        ...dayBookings.map((b) => b.start_min + b.duration_min + b.buffer_min),
        ...dayBlocks.map((k) => k.end_min),
      ) / 60,
    ) * 60,
  );
  const step = 44; // 15-minute cell; short events keep a 24px minimum plus agenda/detail alternatives.
  const height = ((end - begin) / 15) * step;
  const closed = !dayHours.enabled || w.holidays.some((h) => h.date === date);
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
  // Open on what matters: today lands a little above the current time, other days on the first
  // appointment (or opening time). Runs once per mounted day; a user's own scrolling is not overridden.
  const firstStart = dayBookings.length ? Math.min(...dayBookings.map((b) => b.start_min)) : dayHours.starts;
  const positioned = useRef<string>("");
  useLayoutEffect(() => {
    const el = scroller.current;
    const key = `${date}:${barber}`;
    if (!el || positioned.current === key) return;
    const anchor = date === today && currentMinute >= begin && currentMinute < end ? currentMinute - 30 : firstStart - 15;
    el.scrollTop = Math.max(0, ((anchor - begin) / 15) * step);
    positioned.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, barber, begin, staff.length]);
  if (!staff.length)
    return (
      <p className="calendar-empty">
        No barbers match this view. Add a barber or clear the filter.
      </p>
    );
  const gutter = compact ? 44 : 64;
  const columnWidth = compact ? 150 : 190;

  // ---- Drag engine ----------------------------------------------------------------------------
  // Geometry: the timeline element is positioned; columns share the width after the gutter.
  function locate(clientX: number, clientY: number, grabOffsetY: number) {
    const timeline = boardRef.current?.querySelector<HTMLElement>(".calendar-timeline");
    if (!timeline) return null;
    const rect = timeline.getBoundingClientRect();
    const colW = (rect.width - gutter) / staff.length;
    const col = Math.min(staff.length - 1, Math.max(0, Math.floor((clientX - rect.left - gutter) / colW)));
    const topPx = clientY - rect.top - grabOffsetY;
    const minute = begin + Math.round(topPx / step) * 15;
    return { staffId: staff[col].id, start: Math.min(end - 15, Math.max(begin, minute)) };
  }
  function slotState(staffId: string, start: number, excludeId?: string): string {
    const s = staff.find((x) => x.id === staffId);
    if (!s) return "Inactive barber";
    const shift = w.schedule_overrides.find((o) => o.staff_id === s.id && o.date === date) || w.hours.find((h) => h.staff_id === s.id && h.weekday === new Date(date + "T12:00:00Z").getUTCDay());
    const leave = w.days_off.some((d) => d.staff_id === s.id && d.date === date);
    if (!s.active) return "Inactive barber";
    if (closed) return "Shop closed";
    if (leave) return "Day off";
    if (date < today || (date === today && start <= currentMinute)) return "Past time";
    if (!shift?.enabled) return "Off duty";
    if (start < Math.max(dayHours.starts, shift.starts) || start >= Math.min(dayHours.ends, shift.ends)) return "Outside hours";
    if (start >= shift.break_start && start < shift.break_end) return "Break";
    const moving = excludeId ? dayBookings.find((b) => b.id === excludeId) : null;
    const dur = moving?.duration_min ?? 15;
    if (dayBlocks.some((k) => k.staff_id === s.id && start < k.end_min && start + dur > k.start_min)) return "Blocked";
    if (dayBookings.some((b) => b.id !== excludeId && b.staff_id === s.id && start < b.start_min + b.duration_min + b.buffer_min && start + dur > b.start_min)) return "Occupied";
    return "";
  }
  // Would this footprint (start..start+dur) for barber `staffId` collide with something soft/hard?
  function footprintState(staffId: string, start: number, dur: number, excludeId: string): string {
    const s = staff.find((x) => x.id === staffId);
    if (!s) return "Inactive barber";
    const shift = w.schedule_overrides.find((o) => o.staff_id === s.id && o.date === date) || w.hours.find((h) => h.staff_id === s.id && h.weekday === weekdayOf);
    const endAt = start + dur;
    if (shift?.enabled && endAt > Math.min(dayHours.ends, shift.ends)) return "Outside hours";
    if (shift?.enabled && start < shift.break_end && endAt > shift.break_start && shift.break_end > shift.break_start) return "Break";
    if (dayBlocks.some((k) => k.staff_id === s.id && start < k.end_min && endAt > k.start_min)) return "Blocked";
    if (dayBookings.some((b) => b.id !== excludeId && b.staff_id === s.id && start < b.start_min + b.duration_min + b.buffer_min && endAt > b.start_min)) return "Occupied";
    return "";
  }
  function onResizePointerDown(e: ReactPointerEvent<HTMLSpanElement>, b: StoredBooking) {
    if (!onResize || b.status !== "CONFIRMED" || disabled || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    resizeRef.current = { id: b.id, pointerId: e.pointerId, origin: b.duration_min };
    setResizing({ id: b.id, duration: b.duration_min, tick: 0 });
    document.body.classList.add("is-dragging-appointment");
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onResizePointerMove(e: ReactPointerEvent<HTMLSpanElement>, b: StoredBooking) {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    const timeline = boardRef.current?.querySelector<HTMLElement>(".calendar-timeline");
    if (!timeline) return;
    const rect = timeline.getBoundingClientRect();
    const endMinute = begin + Math.round((e.clientY - rect.top) / step) * 15;
    const duration = Math.max(15, Math.min(end - b.start_min, endMinute - b.start_min));
    setResizing((prev) => {
      if (!prev || prev.duration === duration) return prev;
      tick();
      return { ...prev, duration, tick: prev.tick + 1 };
    });
  }
  function onResizePointerUp(e: ReactPointerEvent<HTMLSpanElement>, b: StoredBooking) {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    resizeRef.current = null;
    const live = resizing;
    setResizing(null);
    document.body.classList.remove("is-dragging-appointment");
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const swallow = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    e.currentTarget.closest("button")?.addEventListener("click", swallow, { capture: true, once: true });
    if (!live || !onResize || live.duration === b.duration_min) return;
    const reason = footprintState(b.staff_id, b.start_min, live.duration, b.id);
    if (HARD_REASONS.has(reason)) return;
    void onResize(b, { duration: live.duration, override: SOFT_REASONS.has(reason) ? reason : "" });
  }
  function endDrag(commit: boolean) {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.timer) window.clearTimeout(d.timer);
    const live = dragging;
    setDragging(null);
    document.body.classList.remove("is-dragging-appointment");
    if (!commit || !d || !d.armed || !live || !onMove) return;
    const b = bookings.find((x) => x.id === d.id);
    if (!b) return;
    if (live.overStaff === b.staff_id && live.overStart === b.start_min) return;
    const reason = slotState(live.overStaff, live.overStart, b.id);
    if (HARD_REASONS.has(reason)) return; // ghost was already red; drop is a no-op
    void onMove(b, { staffId: live.overStaff, start: live.overStart, override: SOFT_REASONS.has(reason) ? reason : "" });
  }
  function onEventPointerDown(e: ReactPointerEvent<HTMLButtonElement>, b: StoredBooking) {
    if (!onMove || b.status !== "CONFIRMED" || disabled) return;
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".resize-handle")) return;
    const card = e.currentTarget.getBoundingClientRect();
    const touch = e.pointerType === "touch";
    dragRef.current = {
      id: b.id,
      pointerId: e.pointerId,
      grabOffsetY: e.clientY - card.top,
      originStaff: b.staff_id,
      originStart: b.start_min,
      startX: e.clientX,
      startY: e.clientY,
      armed: false,
      timer: touch
        ? window.setTimeout(() => {
            // Long-press on touch arms the drag so a plain scroll still scrolls.
            const d = dragRef.current;
            if (!d || d.id !== b.id) return;
            d.armed = true;
            tick();
            setDragging({ id: b.id, overStaff: b.staff_id, overStart: b.start_min, tick: 0 });
            document.body.classList.add("is-dragging-appointment");
          }, 260)
        : null,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onEventPointerMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.armed) {
      const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
      if (e.pointerType === "touch") {
        if (moved > 10 && d.timer) {
          // Finger moved before long-press fired: it's a scroll. Let go.
          window.clearTimeout(d.timer);
          dragRef.current = null;
        }
        return;
      }
      if (moved < 5) return;
      d.armed = true;
      setDragging({ id: d.id, overStaff: d.originStaff, overStart: d.originStart, tick: 0 });
      document.body.classList.add("is-dragging-appointment");
    }
    e.preventDefault();
    const at = locate(e.clientX, e.clientY, d.grabOffsetY);
    if (!at) return;
    setDragging((prev) => {
      if (!prev) return prev;
      if (prev.overStaff === at.staffId && prev.overStart === at.start) return prev;
      tick();
      return { ...prev, overStaff: at.staffId, overStart: at.start, tick: prev.tick + 1 };
    });
  }
  function onEventPointerUp(e: ReactPointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const wasArmed = d.armed;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    endDrag(true);
    if (wasArmed) {
      // Swallow the click that follows a drag so the panel doesn't open.
      const swallow = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      e.currentTarget.addEventListener("click", swallow, { capture: true, once: true });
    }
  }
  useEffect(() => {
    if (!dragging) return;
    const cancel = (ev: KeyboardEvent | globalThis.KeyboardEvent) => {
      if ((ev as globalThis.KeyboardEvent).key === "Escape") endDrag(false);
    };
    window.addEventListener("keydown", cancel as EventListener);
    return () => window.removeEventListener("keydown", cancel as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging?.id]);
  const draggingBooking = dragging ? bookings.find((x) => x.id === dragging.id) : null;
  const dropReason = dragging ? slotState(dragging.overStaff, dragging.overStart, dragging.id) : "";

  return (
    <>
      <div
        className={`calendar-scroll connected-scroll ${compact ? "compact" : ""}`}
        ref={scroller}
        tabIndex={0}
        role="region"
        aria-label="Saved appointment timetable"
        aria-describedby="timetable-keyboard-help"
      >
        <div
          className={`calendar-board ${dragging ? "dragging" : ""}`}
          ref={boardRef}
          style={
            {
              "--columns": staff.length,
              "--gutter": `${gutter}px`,
              minWidth: Math.max(compact ? 260 : 310, staff.length * columnWidth + gutter),
            } as CSSProperties
          }
        >
          <div className="calendar-staff-header">
            <div className="timezone-label" title={w.shop.timezone}>
              {tzShort(w.shop.timezone, now)}<span>{w.shop.timezone.split("/").pop()?.replace(/_/g, " ")}</span>
            </div>
            {staff.map((s) => {
              const mine = occupied.filter((b) => b.staff_id === s.id);
              const taken = mine.reduce((n, b) => n + b.price_pence, 0);
              return (
                <div className="staff-column-heading" key={s.id}>
                  <Avatar
                    initials={s.name
                      .split(" ")
                      .map((n) => n[0])
                      .slice(0, 2)
                      .join("")}
                    colour={s.colour || ["sage", "sand", "blue", "clay"][w.staff.findIndex((member) => member.id === s.id) % 4]}
                  />
                  <div>
                    <strong>{s.name}</strong>
                    <span aria-label={`${money(taken)} booked, ${mine.length} visit${mine.length === 1 ? "" : "s"}`}>
                      {money(taken)} · {mine.length} visit{mine.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {onHours && (() => {
                    const ov = w.schedule_overrides.find((o) => o.staff_id === s.id && o.date === date);
                    const wk = w.hours.find((h) => h.staff_id === s.id && h.weekday === weekdayOf);
                    const sh = ov ?? wk;
                    const off = w.days_off.some((d) => d.staff_id === s.id && d.date === date);
                    const label = off ? "Day off" : !sh?.enabled ? "Off" : `${time(sh.starts)}–${time(sh.ends)}`;
                    return (
                      <button type="button" className={`staff-hours-chip ${ov ? "edited" : ""} ${off || !sh?.enabled ? "off" : ""}`} onClick={() => onHours(s, date)} title={ov ? `Hours changed for this day: ${ov.reason}` : "Change this day's hours"} aria-label={`${s.name}: ${label}. Change this day's hours`} data-testid="staff-hours-chip">
                        <Icon name="clock" size={11} /> {label}
                      </button>
                    );
                  })()}
                  {onAction && (
                    <div className="staff-menu">
                      <button
                        type="button"
                        className="staff-menu-button"
                        aria-label={`${s.name}: day actions`}
                        aria-haspopup="menu"
                        aria-expanded={menu === s.id}
                        data-testid="staff-menu"
                        onClick={() => setMenu((m) => (m === s.id ? null : s.id))}
                      >
                        <Icon name="more" size={16} />
                      </button>
                      {menu === s.id && (
                        <div className="staff-menu-list" role="menu" aria-label={`${s.name} day actions`}>
                          <button type="button" role="menuitem" onClick={() => { setMenu(null); onAction("hours", s); }}>
                            <Icon name="clock" size={14} /> Edit today's hours
                          </button>
                          <button type="button" role="menuitem" onClick={() => { setMenu(null); onAction("block", s); }} disabled={date < today}>
                            <Icon name="blocked" size={14} /> Block time…
                          </button>
                          <button type="button" role="menuitem" onClick={() => { setMenu(null); onAction("dayOff", s); }}>
                            <Icon name="sun" size={14} /> Day off
                          </button>
                          <button type="button" role="menuitem" onClick={() => { setMenu(null); onAction("walkIn", s); }} disabled={date !== today}>
                            <Icon name="footprints" size={14} /> Add walk-in
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
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
                  // Hard reasons first (never bookable), then the soft ones the shop may book over.
                  const reason = !s.active
                    ? "Inactive barber"
                    : closed
                      ? "Shop closed"
                      : leave
                        ? "Day off"
                        : date < today || (date === today && start <= currentMinute)
                          ? "Past time"
                          : !shift?.enabled
                            ? "Off duty"
                            : start < Math.max(dayHours.starts, shift.starts) ||
                                start >= Math.min(dayHours.ends, shift.ends)
                              ? "Outside hours"
                              : start >= shift.break_start &&
                                  start < shift.break_end
                                ? "Break"
                                : dayBlocks.some((k) => k.staff_id === s.id && start >= k.start_min && start < k.end_min)
                                  ? "Blocked"
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
              const colour = s.colour || ["sage", "sand", "blue", "clay"][w.staff.findIndex((member) => member.id === s.id) % 4];
              const byService = w.shop.card_colour === "SERVICE";
              const cardColour = (b: StoredBooking) => (byService ? w.services.find((x) => x.id === b.service_id)?.colour || colour : colour);
              const lanes = layoutLanes(occupied.filter((b) => b.staff_id === s.id));
              return (
                <div
                  className="barber-column"
                  key={s.id}
                  onPointerMove={(e) => {
                    if (dragging || e.pointerType === "touch") return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const start = begin + Math.floor((e.clientY - rect.top) / step) * 15;
                    if (hover?.staffId !== s.id || hover.start !== start) setHover({ staffId: s.id, start });
                  }}
                  onPointerLeave={() => setHover((h) => (h?.staffId === s.id ? null : h))}
                >
                  {slots.map(({ start, reason, busy }, n) => {
                    // Greyed but clickable (Fresha): only truly impossible times are disabled.
                    const hard = HARD_REASONS.has(reason);
                    return (
                      <button
                        key={start}
                        type="button"
                        className={`timetable-slot ${reason ? "blocked" : busy ? "occupied" : ""} ${reason && !hard ? "soft" : ""}`}
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
                        aria-label={`${time(start)}, ${s.name}${reason ? ` — ${reason}${hard ? "" : " (book anyway)"}` : busy ? " — occupied, book alongside" : " — add booking"}`}
                        title={
                          hard
                            ? reason
                            : reason
                              ? `${reason} · click to book anyway`
                              : busy
                                ? `Occupied · click to book alongside at ${time(start)}`
                                : `Add booking at ${time(start)}`
                        }
                        disabled={disabled || hard}
                        onClick={() => onDraft({ staffId: s.id, start, outside: reason || (busy ? "Occupied" : "") || undefined })}
                        onContextMenu={
                          onAction && !hard && date >= today
                            ? (e) => {
                                e.preventDefault();
                                onAction("block", s, start);
                              }
                            : undefined
                        }
                        data-drop={dragging && dragging.overStaff === s.id && dragging.overStart === start ? "over" : undefined}
                      >
                        <span>
                          {reason
                            ? n === 0 ||
                              slots[n - 1].reason !== reason ||
                              (reason !== "Past time" && n % 4 === 0)
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
                  {dayBlocks
                    .filter((k) => k.staff_id === s.id)
                    .map((k) => (
                      <div
                        key={k.id}
                        className={`calendar-block kind-${k.kind.toLowerCase()}`}
                        data-testid="calendar-block"
                        style={{ top: ((k.start_min - begin) / 15) * step, height: Math.max(24, ((k.end_min - k.start_min) / 15) * step - 3) }}
                        title={`${time(k.start_min)}–${time(k.end_min)} · ${blockLabel(k)}${k.kind !== "OTHER" ? ` (${BLOCK_LABELS[k.kind].toLowerCase()})` : ""}`}
                      >
                        <button
                          type="button"
                          className="calendar-block-body"
                          onClick={() => onBlock?.(k)}
                          aria-label={`${s.name}: blocked ${time(k.start_min)} to ${time(k.end_min)}, ${blockLabel(k)}`}
                        >
                          <strong>
                            <Icon name="blocked" size={11} /> {blockLabel(k)}
                          </strong>
                          {k.end_min - k.start_min >= 30 && (
                            <span>
                              {time(k.start_min)}–{time(k.end_min)}
                            </span>
                          )}
                        </button>
                        {onRemoveBlock && !disabled && (
                          <button type="button" className="calendar-block-remove" aria-label={`Remove block: ${blockLabel(k)} ${time(k.start_min)}–${time(k.end_min)}`} title="Remove this block" onClick={() => onRemoveBlock(k)}>
                            <Icon name="close" size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                  {hover && !dragging && hover.staffId === s.id && hover.start >= begin && hover.start < end && (
                    <div className="slot-hover" aria-hidden="true" data-testid="slot-hover" style={{ top: ((hover.start - begin) / 15) * step }}>
                      <b>{time(hover.start)}</b>
                    </div>
                  )}
                  {dragging && draggingBooking && dragging.overStaff === s.id && (
                    <div
                      key={dragging.tick}
                      className={`calendar-drop-ghost ${HARD_REASONS.has(dropReason) ? "refused" : dropReason ? "soft" : ""}`}
                      aria-hidden="true"
                      data-testid="drop-ghost"
                      style={{ top: ((dragging.overStart - begin) / 15) * step, height: Math.max(24, (draggingBooking.duration_min / 15) * step - 3) }}
                    >
                      <strong className="ghost-time">{time(dragging.overStart)}</strong>
                      <span>
                        {draggingBooking.attendee_name || draggingBooking.customer_name}
                        {s.id !== draggingBooking.staff_id ? ` · ${s.name.split(" ")[0]}` : ""}
                      </span>
                      {dropReason && <small>{HARD_REASONS.has(dropReason) ? `Can't: ${dropReason.toLowerCase()}` : `${dropReason} · drop to book anyway`}</small>}
                    </div>
                  )}
                  {occupied
                    .filter((b) => b.staff_id === s.id)
                    .map((b) => {
                      const lane = lanes.get(b.id) ?? { lane: 0, lanes: 1 };
                      const laneStyle: CSSProperties = lane.lanes > 1 ? { left: `calc(5px + ${(lane.lane / lane.lanes) * 100}% - ${(5 * lane.lane) / lane.lanes}px)`, width: `calc(${100 / lane.lanes}% - ${10 / lane.lanes}px)`, right: "auto" } : {};
                      return (
                      <button
                        key={b.id}
                        type="button"
                        className={`calendar-event ${cardColour(b)} ${b.status === "COMPLETED" ? "finished" : ""} ${b.duration_min < 15 ? "compact-event" : ""} ${lane.lanes > 1 ? "overlapping" : ""}`}
                        data-status={b.status}
                        data-lanes={lane.lanes > 1 ? lane.lanes : undefined}
                        style={{
                          top: ((b.start_min - begin) / 15) * step,
                          height: Math.max(
                            24,
                            ((resizing?.id === b.id ? resizing.duration : b.duration_min) / 15) * step - 3,
                          ),
                          ...laneStyle,
                        }}
                        data-resizing={resizing?.id === b.id ? "true" : undefined}
                        onClick={() => onOpen(b)}
                        data-draggable={!!onMove && b.status === "CONFIRMED" && !disabled ? "true" : undefined}
                        onPointerDown={(e) => onEventPointerDown(e, b)}
                        onPointerMove={onEventPointerMove}
                        onPointerUp={onEventPointerUp}
                        onPointerCancel={() => endDrag(false)}
                        data-dragging={dragging?.id === b.id ? "true" : undefined}
                        aria-label={`${b.attendee_name || b.customer_name}, ${b.service_name}, ${time(b.start_min)}, ${labels[b.status]}${b.attendee_name ? `, booked by ${b.customer_name}` : ""}${b.group_id ? ", group booking" : ""}`}
                        title={`${b.attendee_name || b.customer_name}${b.attendee_name ? ` (booked by ${b.customer_name})` : ""} · ${b.service_name} · ${time(b.start_min)}–${time(b.start_min + b.duration_min)} · ${labels[b.status]} · ${money(b.price_pence)}`}
                      >
                        <strong>
                          <time>{time(b.start_min)}</time> {b.attendee_name || b.customer_name}
                          {b.group_id && <Icon name="users" size={11} className="event-group" />}
                        </strong>
                        {b.duration_min >= 30 && (
                          <span>
                            {b.service_name} · {money(b.price_pence)}
                          </span>
                        )}
                        {b.duration_min >= 15 && (
                          <small className="event-status">
                            {labels[b.status]}
                            <BlockIcons
                              online={b.channel === "ONLINE"}
                              series={!!b.series_id}
                              walkIn={b.source === "WALK_IN"}
                              paid={paid.has(b.id)}
                              regular={!!b.customer_id && regulars.has(b.customer_id)}
                              deposit={b.deposit_status === "PAID"}
                            />
                          </small>
                        )}
                        {resizing?.id === b.id && (
                          <span className="resize-label" aria-hidden="true" data-testid="resize-label" key={resizing.tick}>
                            {time(b.start_min + resizing.duration)} · {resizing.duration} min
                            {(() => {
                              const why = footprintState(b.staff_id, b.start_min, resizing.duration, b.id);
                              return why ? <small>{HARD_REASONS.has(why) ? `Can't: ${why.toLowerCase()}` : `${why} · release to save anyway`}</small> : null;
                            })()}
                          </span>
                        )}
                        {onResize && b.status === "CONFIRMED" && !disabled && (
                          <span
                            className="resize-handle"
                            data-testid="resize-handle"
                            role="presentation"
                            title="Drag to change the length"
                            onPointerDown={(e) => onResizePointerDown(e, b)}
                            onPointerMove={(e) => onResizePointerMove(e, b)}
                            onPointerUp={(e) => onResizePointerUp(e, b)}
                            onPointerCancel={() => {
                              resizeRef.current = null;
                              setResizing(null);
                              document.body.classList.remove("is-dragging-appointment");
                            }}
                          />
                        )}
                      </button>
                      );
                    })}
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
      <footer className="calendar-foot">
        <div className="calendar-legend" aria-label="Timetable legend">
          <span>
            <i className="legend-free" aria-hidden="true" /> Free
          </span>
          <span>
            <i className="legend-unavailable" aria-hidden="true" /> Break / leave / closed
          </span>
          <span>
            <i className="legend-block" aria-hidden="true" /> Blocked time
          </span>
          <span>
            <i className="legend-buffer" aria-hidden="true" /> Buffer
          </span>
          <span className="legend-note">Card colour = {w.shop.card_colour === "SERVICE" ? "service" : "barber"}</span>
        </div>
        <details className="calendar-help">
          <summary>
            <Icon name="help" size={14} /> How the timetable works
          </summary>
          <p id="timetable-keyboard-help">
            Click any 15-minute cell to book there — greyed cells (outside hours, breaks, occupied) still
            work, you just confirm you mean it. Press and drag a confirmed appointment to move it: the top
            edge is the new start time and it snaps every 15 minutes, sideways moves it to another barber;
            drag the bottom edge to change its length. Undo sits in the green message after each change.
            On a phone, hold for a moment first. Overlapping appointments sit side by side. Click the hours
            under a barber's name to change that day's shift; the ⋯ beside it blocks time with a reason,
            books a day off or seats a walk-in. Right-click a cell to block from that time. Tab reaches
            one free slot per barber; arrow keys move between slots, Home / End jump within a barber.
          </p>
        </details>
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

// Week overview: one column per day, one row per barber, cards sized by duration.
// Read-only planning view; clicking a day opens the day timetable.
export type RangeBooking = Pick<
  StoredBooking,
  | "id"
  | "staff_id"
  | "service_id"
  | "customer_name"
  | "service_name"
  | "date"
  | "start_min"
  | "duration_min"
  | "price_pence"
  | "status"
  | "channel"
> & { series_id: string | null; attendee_name?: string; group_id?: string | null };
export function WeekView({
  w,
  date,
  barber,
  bookings,
  loading,
  onDay,
  onOpen,
}: {
  w: WorkspaceData;
  date: string;
  barber: string;
  bookings: RangeBooking[] | null;
  loading: boolean;
  onDay: (date: string) => void;
  onOpen: (id: string) => void;
}) {
  const monday = datePlus(
    date,
    -((new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7),
  );
  const days = Array.from({ length: 7 }, (_, i) => datePlus(monday, i));
  const staff = w.staff.filter((s) => s.active && (!barber || s.id === barber));
  const active = (b: RangeBooking) =>
    !["CANCELLED", "NO_SHOW"].includes(b.status);
  const rostered = (staffId: string, d: string) => {
    const weekday = new Date(d + "T12:00:00Z").getUTCDay();
    const day = shopDayOf(w.shop, d);
    if (!day.enabled || w.holidays.some((h) => h.date === d))
      return 0;
    if (w.days_off.some((x) => x.staff_id === staffId && x.date === d)) return 0;
    const override = w.schedule_overrides.find(
      (o) => o.staff_id === staffId && o.date === d,
    );
    const h =
      override ??
      w.hours.find((x) => x.staff_id === staffId && x.weekday === weekday);
    if (!h?.enabled) return 0;
    return (
      Math.min(h.ends, day.ends) -
      Math.max(h.starts, day.starts) -
      Math.max(0, h.break_end - h.break_start)
    );
  };
  const colour = (i: number) => staff[i]?.colour || ["sage", "sand", "blue", "clay"][i % 4];
  const cardColour = (i: number, b: { service_id?: string }) => (w.shop.card_colour === "SERVICE" ? w.services.find((x) => x.id === b.service_id)?.colour || colour(i) : colour(i));
  return (
    <div className="week-view" aria-busy={loading}>
      <div className="week-view-head">
        <span className="week-view-corner" aria-hidden="true" />
        {days.map((d) => {
          const dayBookings = (bookings || []).filter(
            (b) => b.date === d && active(b),
          );
          const booked = dayBookings.reduce((n, b) => n + b.duration_min, 0);
          const open = staff.reduce((n, s) => n + rostered(s.id, d), 0);
          const pct = open ? Math.min(100, Math.round((booked / open) * 100)) : 0;
          const isToday = d === w.today;
          return (
            <button
              type="button"
              key={d}
              className={`week-day-head ${d === date ? "chosen" : ""} ${open ? "" : "closed"}`}
              onClick={() => onDay(d)}
              aria-label={`${new Intl.DateTimeFormat("en-GB", { dateStyle: "full" }).format(new Date(d + "T12:00:00Z"))}, ${
                open ? `${dayBookings.length} appointments, ${pct}% booked` : "closed"
              }. Open day timetable.`}
            >
              <span>
                {isToday
                  ? "Today"
                  : new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(
                      new Date(d + "T12:00:00Z"),
                    )}
              </span>
              <strong>{d.slice(-2)}</strong>
              <small>
                {open ? `${dayBookings.length} · ${pct}%` : "Closed"}
              </small>
              <i
                className="week-load"
                style={{ "--load": `${pct}%` } as CSSProperties}
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>
      {staff.map((s, i) => (
        <div className="week-row" key={s.id}>
          <div className="week-row-label">
            <Avatar
              initials={s.name
                .split(" ")
                .map((p) => p[0])
                .join("")
                .slice(0, 2)}
              colour={colour(i)}
            />
            <div>
              <strong>{s.name}</strong>
              <small>
                {(bookings || []).filter(
                  (b) => b.staff_id === s.id && active(b) && days.includes(b.date),
                ).length}{" "}
                this week
              </small>
            </div>
          </div>
          {days.map((d) => {
            const cell = (bookings || [])
              .filter((b) => b.staff_id === s.id && b.date === d && active(b))
              .sort((a, b) => a.start_min - b.start_min);
            const off = rostered(s.id, d) === 0;
            return (
              <div
                className={`week-cell ${off ? "off" : ""}`}
                key={d}
                role="group"
                aria-label={`${s.name}, ${d}${off ? ", not working" : ""}`}
              >
                {off && !cell.length && <span className="week-off">—</span>}
                {cell.map((b) => (
                  <button
                    type="button"
                    className={`week-card ${cardColour(i, b)} ${b.status === "COMPLETED" ? "done" : ""}`}
                    key={b.id}
                    style={{ "--span": Math.max(1, Math.round(b.duration_min / 15)) } as CSSProperties}
                    onClick={() => onOpen(b.id)}
                    title={`${time(b.start_min)} ${b.customer_name} · ${b.service_name} · ${money(b.price_pence)}`}
                  >
                    <strong>{time(b.start_min)}</strong>
                    <span>{b.customer_name}</span>
                    <small>
                      {b.service_name}
                      {b.series_id ? " ↻" : ""}
                      {b.channel === "ONLINE" ? " · online" : ""}
                    </small>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ))}
      {!staff.length && (
        <p className="calendar-empty">No active barbers match this filter.</p>
      )}
      {bookings && bookings.length === 0 && staff.length > 0 && (
        <p className="calendar-footnote">No appointments saved for this week yet.</p>
      )}
    </div>
  );
}
