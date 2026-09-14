// Appointment side panel: right-hand drawer on desktop, bottom sheet on phones.
// The calendar stays visible behind it so the owner can compare or move visits.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StoredBooking, WorkspaceData, BookingItem } from "../server/domain";
import { Avatar, Badge, Button, Icon, IconButton, Notice } from "./ui";

export type TimelineEvent = { id: string; action: string; actor: string; reason: string; created_at: number };
export type PanelCustomer = {
  id: string;
  name: string;
  phone: string;
  email: string;
  tags: string;
  notes: string;
  preferred_staff_id: string | null;
  version: number;
  visits: number;
  completed: number;
  no_shows: number;
  completed_value_pence: number;
  last_visit_at: number | null;
};
export type SeriesVisit = { id: string; date: string; start_min: number; status: string; version: number };
export type Timeline = {
  booking: StoredBooking;
  events: TimelineEvent[];
  customer: PanelCustomer | null;
  series: SeriesVisit[];
};

const labels: Record<string, string> = {
  CONFIRMED: "Confirmed",
  CHECKED_IN: "Checked in",
  IN_SERVICE: "In service",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No-show",
};
const tones: Record<string, string> = {
  CONFIRMED: "confirmed",
  CHECKED_IN: "checked",
  IN_SERVICE: "service",
  COMPLETED: "done",
  CANCELLED: "cancelled",
  NO_SHOW: "noshow",
};
const actionLabels: Record<string, string> = {
  BOOKING_CREATED: "Booked",
  RESCHEDULED: "Moved",
  DETAILS_UPDATED: "Details edited",
  STATUS_CHECKED_IN: "Checked in",
  STATUS_IN_SERVICE: "Service started",
  STATUS_COMPLETED: "Completed",
  STATUS_CANCELLED: "Cancelled",
  STATUS_NO_SHOW: "Marked no-show",
  MANAGE_LINK_ISSUED: "Confirmation link shared",
  NOTE_ADDED: "Note added",
};
export const time = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const money = (p: number) => `£${(p / 100).toFixed(p % 100 ? 2 : 0)}`;
const when = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(new Date(ms));
const longDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(d + "T12:00:00Z"));
const initials = (name: string) => name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();

export function AppointmentPanel({
  booking,
  w,
  timeline,
  timelineError,
  busy,
  error,
  onClose,
  onStatus,
  onMove,
  onRebook,
  onEdit,
  onShare,
  onCustomer,
  onSeriesCancel,
  onSeriesMove,
  onNote,
  children,
}: {
  booking: StoredBooking;
  w: WorkspaceData;
  timeline: Timeline | null;
  timelineError: string;
  busy: string;
  error: string;
  onClose: () => void;
  onStatus: (status: string, reason: string) => Promise<void>;
  onMove: () => void;
  onRebook: () => void;
  onEdit: () => void;
  onShare: () => void;
  onCustomer: (id: string) => void;
  onSeriesCancel: (reason: string, fromThis: boolean) => Promise<void>;
  onSeriesMove: () => void;
  onNote: (note: string) => Promise<void>;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [confirm, setConfirm] = useState<null | { status: string; series?: boolean }>(null);
  const [reason, setReason] = useState("");
  const [fromThis, setFromThis] = useState(true);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  // Switching to another editor while a nested form is saving or dirty needs an explicit choice.
  const [nextAction, setNextAction] = useState<(() => void) | null>(null);
  const [switchError, setSwitchError] = useState("");
  function guarded(action: () => void) {
    return () => {
      setSwitchError("");
      if (ref.current?.querySelector('form[aria-busy="true"]')) {
        setSwitchError("A save is in progress. Wait for its result before switching actions.");
        return;
      }
      if (ref.current?.querySelector('form[data-dirty="true"]')) {
        setNextAction(() => action);
        return;
      }
      action();
    };
  }
  const barber = w.staff.find((s) => s.id === booking.staff_id);
  const items = JSON.parse(booking.items_json) as BookingItem[];
  const noShowEarly = Date.now() < booking.start_at + w.shop.no_show_grace * 60000;
  const isPast = booking.end_at < Date.now();
  const remainingSeries = (timeline?.series || []).filter((v) => v.status === "CONFIRMED" && v.start_min >= 0);
  const laterInSeries = remainingSeries.filter((v) => v.date > booking.date || (v.date === booking.date && v.id === booking.id));

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const overflow = document.body.style.overflow;
    if (window.matchMedia("(max-width: 900px)").matches) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [booking.id]);
  useEffect(() => {
    setConfirm(null);
    setReason("");
    setNoteOpen(false);
  }, [booking.id, booking.version]);

  function keyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
    if (e.key !== "Tab") return;
    const nodes = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
      ) ?? [],
    ).filter((n) => n.getClientRects().length > 0);
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
  async function copyDetails() {
    const text = `${booking.customer_name} · ${longDate(booking.date)} ${time(booking.start_min)} · ${booking.service_name} with ${barber?.name} · ${money(booking.price_pence)} · ${labels[booking.status]}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable in some contexts; nothing else to do */
    }
  }
  const needsReason = confirm && ["CANCELLED", "NO_SHOW"].includes(confirm.status);
  const goMove = guarded(onMove), goRebook = guarded(onRebook), goEdit = guarded(onEdit), goShare = guarded(onShare), goSeriesMove = guarded(onSeriesMove);
  const customer = timeline?.customer ?? null;

  return (
    <div className="panel-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        ref={ref}
        className="appointment-panel"
        role="dialog"
        aria-modal="false"
        aria-labelledby="panel-title"
        tabIndex={-1}
        onKeyDown={keyDown}
        onChangeCapture={(e) => {
          const form = (e.target as HTMLElement).closest("form");
          if (form) form.dataset.dirty = "true";
        }}
        data-testid="appointment-panel"
      >
        <div className="panel-handle" aria-hidden="true" />
        <header className="panel-header">
          <div className="panel-title-row">
            <Badge tone={tones[booking.status]}>{labels[booking.status]}</Badge>
            {booking.channel === "ONLINE" && <span className="channel-badge online">Booked online</span>}
            {booking.source === "WALK_IN" && <span className="channel-badge">Walk-in</span>}
            {booking.series_id && (
              <span className="channel-badge series" title="Standing booking">
                <Icon name="repeat" size={12} /> Standing
              </span>
            )}
          </div>
          <div className="panel-title-line">
            <h2 id="panel-title">
              {time(booking.start_min)} · {booking.customer_name}
            </h2>
            <IconButton name="close" label="Close appointment panel" onClick={onClose} />
          </div>
          <p className="panel-subtitle">
            {longDate(booking.date)} · {booking.duration_min} min · ref {`BRB-${String(booking.sequence).padStart(4, "0")}`}
          </p>
        </header>

        <div className="panel-body">
          {/* Customer card */}
          <section className="panel-card panel-customer" aria-label="Customer">
            <div className="panel-customer-head">
              <Avatar initials={initials(booking.customer_name)} colour="sage" />
              <div className="panel-customer-name">
                <strong>{customer?.name || booking.customer_name}</strong>
                <a href={`tel:${booking.phone}`} className="panel-phone">
                  <Icon name="phone" size={13} /> {booking.phone}
                </a>
                {booking.email && <span className="panel-email">{booking.email}</span>}
              </div>
              {customer && (
                <Button variant="ghost" className="panel-link" onClick={() => onCustomer(customer.id)}>
                  Profile <Icon name="arrowRight" size={14} />
                </Button>
              )}
            </div>
            {customer ? (
              <>
                <dl className="panel-stats">
                  <div><dt>Visits</dt><dd>{customer.visits}</dd></div>
                  <div><dt>Spend</dt><dd>{money(customer.completed_value_pence || 0)}</dd></div>
                  <div><dt>No-shows</dt><dd className={customer.no_shows ? "warn" : ""}>{customer.no_shows}</dd></div>
                  <div><dt>Last visit</dt><dd>{customer.last_visit_at ? when(customer.last_visit_at).split(",")[0] : "First visit"}</dd></div>
                </dl>
                {(JSON.parse(customer.tags || "[]") as string[]).length > 0 && (
                  <div className="panel-tags">
                    {(JSON.parse(customer.tags) as string[]).map((t) => (
                      <span className="tag" key={t}>{t}</span>
                    ))}
                  </div>
                )}
                {customer.notes && <p className="panel-customer-notes">{customer.notes}</p>}
              </>
            ) : timeline ? (
              <p className="workspace-footnote">No customer record linked.</p>
            ) : (
              <p className="workspace-footnote" aria-busy="true">Loading customer…</p>
            )}
          </section>

          {/* Appointment details */}
          <section className="panel-card" aria-label="Appointment details">
            <div className="panel-barber">
              <Avatar initials={initials(barber?.name || "?")} colour={["sage", "sand", "blue", "clay"][Math.max(0, w.staff.findIndex((s) => s.id === booking.staff_id)) % 4]} />
              <div>
                <strong>{barber?.name || "Unknown barber"}</strong>
                <small>{barber?.role}</small>
              </div>
              <span className="panel-time">
                {time(booking.start_min)} – {time(booking.start_min + booking.duration_min)}
              </span>
            </div>
            <ul className="panel-items">
              {items.map((i) => (
                <li key={i.id}>
                  <span>
                    {i.name}
                    {i.kind === "ADDON" && <small> add-on</small>}
                  </span>
                  <span>{money(i.price_pence)} · {i.duration_min} min</span>
                </li>
              ))}
              <li className="panel-total">
                <span>Total</span>
                <span>{money(booking.price_pence)}</span>
              </li>
            </ul>
            <div className="panel-notes">
              <div className="panel-notes-head">
                <strong>Notes</strong>
                {!noteOpen && (
                  <button type="button" className="panel-inline" onClick={() => { setNote(booking.notes); setNoteOpen(true); }}>
                    <Icon name="message" size={13} /> {booking.notes ? "Edit" : "Add note"}
                  </button>
                )}
              </div>
              {noteOpen ? (
                <form
                  className="panel-note-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await onNote(note.trim());
                    setNoteOpen(false);
                  }}
                >
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} aria-label="Appointment note" />
                  <div className="panel-note-actions">
                    <Button type="submit" disabled={busy === "note"}>{busy === "note" ? "Saving…" : "Save note"}</Button>
                    <Button variant="ghost" type="button" onClick={() => setNoteOpen(false)}>Cancel</Button>
                  </div>
                </form>
              ) : (
                <p className={booking.notes ? "" : "muted"}>{booking.notes || "No notes yet."}</p>
              )}
            </div>
            <p className="panel-meta">
              Deposit policy {money(booking.deposit_policy_pence)} (not collected) · cancel window {booking.cancel_hours_snapshot}h · booked {when(booking.created_at)}
            </p>
          </section>

          {/* Standing series */}
          {booking.series_id && timeline && (
            <section className="panel-card panel-series" aria-label="Standing booking">
              <div className="panel-notes-head">
                <strong><Icon name="repeat" size={14} /> Standing booking</strong>
                <small>{remainingSeries.length} upcoming</small>
              </div>
              <ol className="series-strip">
                {timeline.series.slice(0, 8).map((v) => (
                  <li key={v.id} className={`${v.id === booking.id ? "current" : ""} ${v.status !== "CONFIRMED" ? "closed" : ""}`}>
                    <span>{v.date.slice(5)}</span>
                    <small>{labels[v.status]}</small>
                  </li>
                ))}
              </ol>
              {laterInSeries.length > 0 && (
                <div className="panel-actions-row">
                  <Button variant="secondary" onClick={goSeriesMove}>Move series</Button>
                  <Button variant="ghost" onClick={() => setConfirm({ status: "CANCELLED", series: true })}>Cancel series</Button>
                </div>
              )}
            </section>
          )}

          {/* Confirm step for status changes */}
          {confirm && (
            <section className="panel-card panel-confirm" role="alert" aria-label="Confirm change">
              <strong>
                {confirm.series
                  ? "Cancel standing booking"
                  : `Mark as ${labels[confirm.status].toLowerCase()}`}
              </strong>
              {confirm.series && (
                <div className="panel-radio">
                  <label><input type="radio" checked={fromThis} onChange={() => setFromThis(true)} /> This and later visits ({laterInSeries.length})</label>
                  <label><input type="radio" checked={!fromThis} onChange={() => setFromThis(false)} /> All remaining visits ({remainingSeries.length})</label>
                </div>
              )}
              {confirm.status === "NO_SHOW" && noShowEarly && (
                <Notice tone="warning">No-show is available {w.shop.no_show_grace} minutes after the start time.</Notice>
              )}
              <label className="panel-reason">
                <span>{needsReason ? "Reason (required)" : "Note (optional)"}</span>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} required={!!needsReason} minLength={needsReason ? 3 : undefined} />
              </label>
              <div className="panel-actions-row">
                <Button
                  variant={["CANCELLED", "NO_SHOW"].includes(confirm.status) ? "danger" : "primary"}
                  disabled={busy !== "" || (needsReason && reason.trim().length < 3) || (confirm.status === "NO_SHOW" && noShowEarly)}
                  onClick={async () => {
                    if (confirm.series) await onSeriesCancel(reason.trim(), fromThis);
                    else await onStatus(confirm.status, reason.trim());
                    setConfirm(null);
                    setReason("");
                  }}
                >
                  {busy ? "Saving…" : confirm.series ? "Cancel visits" : `Confirm ${labels[confirm.status].toLowerCase()}`}
                </Button>
                <Button variant="ghost" onClick={() => setConfirm(null)}>Back</Button>
              </div>
            </section>
          )}
          {error && <p className="workspace-error" role="alert">{error}</p>}
          {switchError && <p className="workspace-error" role="alert">{switchError}</p>}
          {nextAction && (
            <section className="dialog-close-warning" role="alert">
              <p>You have unsaved appointment changes. Keep editing or discard them before switching actions.</p>
              <Button variant="secondary" onClick={() => setNextAction(null)}>Keep editing appointment</Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (ref.current?.querySelector('form[aria-busy="true"]')) return;
                  const run = nextAction;
                  setNextAction(null);
                  run();
                }}
              >
                Discard changes and continue
              </Button>
            </section>
          )}

          {children}

          {/* Timeline */}
          <section className="panel-card panel-timeline" aria-label="Appointment history">
            <strong>History</strong>
            {timelineError && <p className="workspace-error" role="alert">{timelineError}</p>}
            {!timeline && !timelineError && <p className="workspace-footnote">Loading history…</p>}
            {timeline && (
              <ol>
                {timeline.events.map((ev) => (
                  <li key={ev.id}>
                    <span className="tl-dot" aria-hidden="true" />
                    <div>
                      <strong>{actionLabels[ev.action] || ev.action.replace(/_/g, " ").toLowerCase()}</strong>
                      <small>{when(ev.created_at)} · {ev.actor.replace(/^sandbox-owner:.*/, "owner").replace(/^user:.*/, "account")}</small>
                      {ev.reason && <p>{ev.reason}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        {/* Sticky contextual actions */}
        <footer className="panel-actions" aria-label="Appointment actions">
          {booking.status === "CONFIRMED" && (
            <>
              <Button disabled={!!busy} onClick={() => onStatus("CHECKED_IN", "")}>
                <Icon name="check" size={16} /> {busy === "CHECKED_IN" ? "Saving…" : "Check in"}
              </Button>
              <Button variant="secondary" onClick={goMove}>Reschedule</Button>
              <Button variant="ghost" onClick={() => setConfirm({ status: "CANCELLED" })}>Cancel</Button>
              {isPast || !noShowEarly ? (
                <Button variant="ghost" onClick={() => setConfirm({ status: "NO_SHOW" })}>No-show</Button>
              ) : null}
            </>
          )}
          {booking.status === "CHECKED_IN" && (
            <>
              <Button disabled={!!busy} onClick={() => onStatus("IN_SERVICE", "")}>
                <Icon name="scissors" size={16} /> {busy === "IN_SERVICE" ? "Saving…" : "Start service"}
              </Button>
              <Button variant="ghost" onClick={() => setConfirm({ status: "CANCELLED" })}>Cancel</Button>
            </>
          )}
          {booking.status === "IN_SERVICE" && (
            <Button disabled={!!busy} onClick={() => onStatus("COMPLETED", "")}>
              <Icon name="checks" size={16} /> {busy === "COMPLETED" ? "Saving…" : `Complete · ${money(booking.price_pence)}`}
            </Button>
          )}
          <Button variant={["COMPLETED", "CANCELLED", "NO_SHOW"].includes(booking.status) ? "primary" : "ghost"} onClick={goRebook}>
            <Icon name="calendar" size={16} /> Book again
          </Button>
          <details className="panel-more">
            <summary aria-label="More actions"><Icon name="more" size={18} /></summary>
            <div className="panel-more-menu">
              <button type="button" onClick={goEdit}><Icon name="user" size={14} /> Edit name and phone</button>
              <button type="button" onClick={goShare}><Icon name="message" size={14} /> Share confirmation</button>
              <button type="button" onClick={copyDetails}><Icon name="external" size={14} /> {copied ? "Copied" : "Copy details"}</button>
              <button type="button" disabled title="No live payments in this build"><Icon name="card" size={14} /> Record payment (off)</button>
            </div>
          </details>
        </footer>
      </aside>
    </div>
  );
}
