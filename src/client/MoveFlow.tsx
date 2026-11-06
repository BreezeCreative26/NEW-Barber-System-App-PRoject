// Reschedule a visit: the same screens as booking. Step 1 is the booking flow's "when" screen (day
// strip with how many times are free, times grouped by part of the day); step 2 shows the old and
// new time side by side and asks the customer to confirm. Full screen with a fixed action bar, so
// the confirm button is always on screen on a phone. Used by the manage link and the account area.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { dateLabel, datePlus, money, time } from "./fixtures";
import { Button, Icon, Notice } from "./ui";
import { brandStyle, themeClass, type ShopBrand } from "./theme";

type Day = { date: string; available: number; closed: boolean; beyond: boolean };
type MoveSlot = { start_min: number; available: boolean; reason: string };
export type MoveVisit = {
  service_name: string;
  staff_name: string | null;
  attendee_name?: string;
  date: string;
  start_min: number;
  duration_min: number;
  price_pence: number;
  version: number;
  late_change: boolean;
  cancel_hours: number;
};
const friendly: Record<string, string> = {
  slot_taken: "That time has just been taken. Pick another time.",
  outside_booking_window: "That date is outside the shop's online booking window.",
  record_changed: "This booking changed somewhere else. Close this and open it again.",
  invalid_transition: "This booking can no longer be changed online. Contact the shop.",
  service_ineligible: "This service can't be moved online any more. Contact the shop.",
};
class MoveError extends Error {
  constructor(message: string, public code = "") {
    super(message);
  }
}
async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/public${path}`, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new MoveError("Couldn't reach the shop. Check your connection and try again.");
  }
  const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new MoveError(friendly[j.error || ""] || j.message || j.error || "Something went wrong. Try again.", j.error || "");
  return j as T;
}
const PARTS = ["Morning", "Afternoon", "Evening"] as const;
const partOf = (m: number) => (m < 720 ? "Morning" : m < 1020 ? "Afternoon" : "Evening");
const longDay = (d: string) => dateLabel(d, { weekday: "long", day: "numeric", month: "long" });
const shortDay = (d: string) => dateLabel(d, { weekday: "short", day: "numeric", month: "short" });

export function MoveFlow({
  base,
  visit,
  shop,
  onCancel,
  onDone,
}: {
  // API prefix for this visit: /manage/<token> or /shops/<slug>/account/bookings/<id>.
  base: string;
  visit: MoveVisit;
  shop: { name: string; logo_url?: string; brand?: ShopBrand };
  onCancel: () => void;
  onDone: (booking: unknown) => void;
}) {
  const [step, setStep] = useState<"time" | "confirm">("time");
  const [meta, setMeta] = useState<{ today: string; max_date: string } | null>(null);
  const [from, setFrom] = useState("");
  const [days, setDays] = useState<Day[] | null>(null);
  const [date, setDate] = useState(visit.date);
  const [slots, setSlots] = useState<MoveSlot[] | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const opened = useRef(false);

  // The page underneath doesn't scroll while this is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  // Day strip: how many times are free each day for this visit (same barber, same length).
  useEffect(() => {
    let cancelled = false;
    call<{ from: string; today: string; max_date: string; days: Day[] }>(`${base}/days${from ? `?from=${from}` : ""}`)
      .then((r) => {
        if (cancelled) return;
        setMeta({ today: r.today, max_date: r.max_date });
        setDays(r.days);
        if (!from) setFrom(r.from);
        // First open: start on the visit's own day if it can be moved within the window, otherwise
        // the first day with free times. Make sure that day is in the strip.
        if (!opened.current) {
          opened.current = true;
          const inWindow = visit.date >= r.today && visit.date <= r.max_date;
          const own = r.days.find((d) => d.date === visit.date);
          const first = r.days.find((d) => !d.closed && !d.beyond && d.available > 0);
          const start = inWindow && (!own || own.available > 0) ? visit.date : first?.date || r.today;
          setDate(start);
          if (start > datePlus(r.from, 6)) setFrom(start);
        }
      })
      .catch(() => !cancelled && setDays([]));
    return () => {
      cancelled = true;
    };
  }, [base, from, nonce]);

  // Times on the chosen day.
  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setSlots(null);
    call<{ slots: MoveSlot[]; today: string; max_date: string }>(`${base}/availability?date=${date}`)
      .then((r) => {
        if (cancelled) return;
        setSlots(r.slots);
        setMeta((m) => m || { today: r.today, max_date: r.max_date });
      })
      .catch((e) => {
        if (cancelled) return;
        setSlots([]);
        setError(e instanceof Error ? e.message : "Couldn't load times.");
      });
    return () => {
      cancelled = true;
    };
  }, [base, date, nonce]);

  const isCurrent = (m: number) => date === visit.date && m === visit.start_min;
  const open = (slots || []).filter((s) => s.available);
  const groups = PARTS.map((p) => ({ label: p, slots: open.filter((s) => partOf(s.start_min) === p) })).filter((g) => g.slots.length);
  const strip = from ? Array.from({ length: 7 }, (_, i) => datePlus(from, i)) : [];
  const dayInfo = (d: string) => days?.find((x) => x.date === d);
  const who = visit.staff_name ? visit.staff_name.split(" ")[0] : "";

  async function confirm() {
    if (slot === null) return;
    setBusy(true);
    setError("");
    try {
      const r = await call<{ booking: unknown }>(`${base}/reschedule`, "POST", { date, start_min: slot, version: visit.version });
      onDone(r.booking);
    } catch (e) {
      const err = e as MoveError;
      setError(err.message);
      // The time went while they were confirming: back to the times, refreshed.
      if (err.code === "slot_taken") {
        setSlot(null);
        setStep("time");
        setNonce((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={scroller}
      className={themeClass(shop.brand, "booking-app standalone no-tabbar move-flow")}
      style={brandStyle(shop.brand) as CSSProperties}
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-flow-heading"
      data-testid="move-flow"
    >
      <header className="booking-topbar">
        <button type="button" className="booking-back" onClick={onCancel} disabled={busy} data-testid="move-close" aria-label={`Close and keep your current time at ${shop.name}`}>
          <Icon name="arrowLeft" size={16} />
          <span className="move-shop">{shop.name}</span>
        </button>
        <span className="booking-brand" aria-hidden="true">
          {shop.logo_url ? <img className="shop-emblem shop-logo" src={shop.logo_url} alt="" /> : null}
        </span>
      </header>
      <main className="booking-body">
        <section className="booking-flow move-flow-body">
          <nav className="booking-bars move-bars" aria-label="Reschedule steps">
            {(["New time", "Confirm"] as const).map((label, i) => {
              const at = step === "time" ? 0 : 1;
              return (
                <button key={label} type="button" disabled={i > at || busy} onClick={() => i === 0 && setStep("time")} aria-current={i === at ? "step" : undefined} className={i < at ? "done" : i === at ? "on" : ""}>
                  <i aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>
          <p className="step-summary" data-testid="move-summary">
            <span>
              <b>{visit.service_name}</b>
              {who && ` · with ${who}`}
              {visit.attendee_name && ` · for ${visit.attendee_name}`} · {visit.duration_min} min
            </span>
            <span className="move-now">Now {shortDay(visit.date)}, {time(visit.start_min)}</span>
          </p>
          <header className="step-heading">
            <h2 id="move-flow-heading" ref={heading} tabIndex={-1}>
              {step === "time" ? "Pick a new time" : "Confirm your new time"}
            </h2>
          </header>

          {step === "time" && (
            <>
              <div className="booking-date-toolbar">
                <button type="button" aria-label="Previous week" disabled={!meta || !from || from <= meta.today} onClick={() => meta && setFrom(datePlus(from, -7) < meta.today ? meta.today : datePlus(from, -7))}>
                  <Icon name="left" size={14} /> Earlier
                </button>
                <h3 data-testid="move-chosen-day">{longDay(date)}</h3>
                <button type="button" aria-label="Next week" disabled={!meta || !from || datePlus(from, 7) > meta.max_date} onClick={() => setFrom(datePlus(from, 7))}>
                  Later <Icon name="right" size={14} />
                </button>
              </div>
              <div className="booking-dates" role="group" aria-label="Choose a day" data-testid="move-days">
                {strip.map((d) => {
                  const info = dayInfo(d);
                  const beyond = !!meta && d > meta.max_date;
                  const disabled = beyond || !!info?.closed;
                  const level = !info || beyond ? "" : info.closed ? "closed" : info.available === 0 ? "full" : info.available < 6 ? "low" : "open";
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`${date === d ? "chosen" : ""} ${level}`}
                      disabled={disabled}
                      aria-pressed={date === d}
                      aria-label={`${longDay(d)}, ${!info ? "checking" : beyond ? "not open yet" : info.closed ? "closed" : info.available === 0 ? "fully booked" : `${info.available} times`}`}
                      onClick={() => {
                        setDate(d);
                        setSlot(null);
                        setError("");
                      }}
                    >
                      <span>{meta && d === meta.today ? "Today" : dateLabel(d, { weekday: "short" })}</span>
                      <strong>{dateLabel(d, { day: "2-digit" })}</strong>
                      <small>{!info ? "…" : beyond ? "Later" : info.closed ? "Closed" : info.available ? `${info.available} times` : "Full"}</small>
                    </button>
                  );
                })}
              </div>
              {error && (
                <p className="workspace-error" role="alert">
                  {error}
                </p>
              )}
              <div className="time-groups" role="group" aria-label="Choose a new time" aria-busy={!slots}>
                {!slots && <div className="time-slots skeleton-slots" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <span key={i} />)}</div>}
                {groups.map((g) => (
                  <div className="time-group" key={g.label}>
                    <h4>
                      {g.label} <small>{g.slots.length}</small>
                    </h4>
                    <div className="time-slots">
                      {g.slots.map((s) => {
                        const current = isCurrent(s.start_min);
                        return (
                          <button
                            key={s.start_min}
                            type="button"
                            className={`${slot === s.start_min ? "chosen" : ""} ${current ? "current" : ""}`}
                            disabled={current}
                            aria-pressed={slot === s.start_min}
                            aria-label={`${time(s.start_min)}${current ? ", your current time" : ", available"}`}
                            onClick={() => {
                              setSlot(s.start_min);
                              setError("");
                            }}
                            data-testid="move-slot"
                          >
                            {time(s.start_min)}
                            {current && <small>Now</small>}
                            {slot === s.start_min && <Icon name="check" size={14} />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              {slots && open.filter((s) => !isCurrent(s.start_min)).length === 0 && (
                <Notice icon="calendar" tone="warning">
                  No free times with {who || "your barber"} on {shortDay(date)}. Try another day.
                </Notice>
              )}
            </>
          )}

          {step === "confirm" && slot !== null && (
            <>
              <dl className="review-facts move-facts" data-testid="move-review">
                <div>
                  <dt><Icon name="calendar" size={16} /></dt>
                  <dd>
                    <strong>{longDay(date)}</strong>
                    <small>
                      {time(slot)}–{time(slot + visit.duration_min)} · new time
                    </small>
                  </dd>
                </div>
                <div className="move-was">
                  <dt><Icon name="clock" size={16} /></dt>
                  <dd>
                    <s>{shortDay(visit.date)}, {time(visit.start_min)}</s>
                    <small>Your current time. It's released once you confirm.</small>
                  </dd>
                </div>
                <div>
                  <dt><Icon name="scissors" size={16} /></dt>
                  <dd>
                    <strong>{visit.service_name}</strong>
                    <small>{visit.duration_min} min{visit.attendee_name ? ` · for ${visit.attendee_name}` : ""}</small>
                  </dd>
                </div>
                <div>
                  <dt><Icon name="userRound" size={16} /></dt>
                  <dd>
                    <strong>{visit.staff_name || "Your barber"}</strong>
                    <small>Same barber</small>
                  </dd>
                </div>
                <div>
                  <dt><Icon name="wallet" size={16} /></dt>
                  <dd>
                    <strong>{money(visit.price_pence)}</strong>
                    <small>Price stays the same</small>
                  </dd>
                </div>
              </dl>
              {visit.late_change && (
                <Notice tone="warning" icon="clock">
                  This is inside the shop's {visit.cancel_hours}-hour notice period, so the shop will see it as a late change.
                </Notice>
              )}
              <p className="move-note">We'll send you a confirmation of the new time.</p>
              {error && (
                <p className="workspace-error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}

          <footer className="booking-actions">
            <Button variant="secondary" className="booking-back-btn" aria-label={step === "time" ? "Back, keep my current time" : "Back to times"} onClick={() => (step === "time" ? onCancel() : setStep("time"))} disabled={busy}>
              <Icon name="arrowLeft" />
              <span>Back</span>
            </Button>
            {step === "time" ? (
              <Button disabled={slot === null} onClick={() => setStep("confirm")} data-testid="move-continue">
                {slot !== null ? `Continue · ${time(slot)}` : "Pick a time"}
                <Icon name="arrowRight" />
              </Button>
            ) : (
              <Button disabled={busy || slot === null} aria-busy={busy} onClick={confirm} data-testid="confirm-move">
                {busy ? "Moving…" : `Confirm move to ${slot !== null ? time(slot) : ""}`}
                <Icon name="check" />
              </Button>
            )}
          </footer>
        </section>
      </main>
    </div>
  );
}
