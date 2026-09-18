// Appointment side panel: right-hand drawer on desktop, bottom sheet on phones.
// The calendar stays visible behind it so the owner can compare or move visits.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StoredBooking, WorkspaceData, BookingItem, Payment } from "../server/domain";
import { Avatar, Badge, Button, Icon, IconButton, Notice } from "./ui";
import { Checkout, PaidStrip, paidFor, type Tender } from "./Checkout";

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
  ITEMS_UPDATED: "Service or price changed",
  DEPOSIT_REFUNDED: "Deposit refunded",
  DEPOSIT_REFUND_FAILED: "Deposit refund failed",
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
import { money } from "./fixtures";
export { money };
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
  payments = [],
  canTakePayment = true,
  canVoid = false,
  onCheckout,
  onVoidPayment,
  api,
  onPaid,
  cardLive,
  onItems,
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
  payments?: Payment[];
  canTakePayment?: boolean;
  canVoid?: boolean;
  onCheckout?: (body: { version: number; discount_pence: number; note: string; tenders: Tender[]; complete: boolean }) => Promise<void>;
  onVoidPayment?: (payment: Payment, reason: string) => Promise<void>;
  api?: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  onPaid?: () => Promise<void> | void;
  cardLive?: boolean;
  /** Edit service / add-ons / price / duration in place. Resolves with the server's refund figure. */
  onItems?: (body: { service_id: string; addon_ids: string[]; service_price_pence?: number; service_duration_min?: number; addon_prices: Record<string, number>; reason: string; version: number; force?: boolean }) => Promise<{ refunded_pence: number } | void>;
  children?: ReactNode;
}) {
  const [editingItems, setEditingItems] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const [confirm, setConfirm] = useState<null | { status: string; series?: boolean }>(null);
  const [reason, setReason] = useState("");
  const [fromThis, setFromThis] = useState(true);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [checkout, setCheckout] = useState(false);
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const paid = paidFor(payments, booking.id);
  const outstanding = Math.max(0, booking.price_pence - paid.service - paid.discount);
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
    setCheckout(false);
    setVoiding(null);
    // After a save the confirm/checkout controls unmount; keep keyboard focus inside the panel so
    // Escape and Tab keep working rather than falling back to the page body.
    requestAnimationFrame(() => {
      if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus();
    });
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
            {booking.group_id && (
              <span className="channel-badge series" title="Part of a group booking" data-testid="group-badge">
                <Icon name="users" size={12} /> Group
              </span>
            )}
          </div>
          <div className="panel-title-line">
            <h2 id="panel-title">
              {time(booking.start_min)} · {booking.attendee_name || booking.customer_name}
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
                {booking.attendee_name && (
                  <span className="panel-attendee" data-testid="panel-attendee">
                    <Icon name="userRound" size={12} /> Booked for <strong>{booking.attendee_name}</strong>
                  </span>
                )}
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
              <Avatar initials={initials(barber?.name || "?")} colour={barber?.colour || "sage"} />
              <div>
                <strong>{barber?.name || "Unknown barber"}</strong>
                <small>{barber?.role}</small>
              </div>
              <span className="panel-time">
                {time(booking.start_min)} – {time(booking.start_min + booking.duration_min)}
              </span>
            </div>
            {editingItems && onItems ? (
              <EditItems
                booking={booking}
                w={w}
                items={items}
                busy={!!busy}
                onCancel={() => setEditingItems(false)}
                onSave={async (body) => {
                  const r = await onItems(body);
                  setEditingItems(false);
                  return r;
                }}
              />
            ) : (
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
                  <span>
                    Total
                    {booking.items_edited_at ? <small className="panel-edited" title="Price or time changed by hand"> · edited</small> : null}
                  </span>
                  <span>{money(booking.price_pence)}</span>
                </li>
                {onItems && ["CONFIRMED", "CHECKED_IN", "IN_SERVICE"].includes(booking.status) && payments.filter((p) => !p.voided_at).length === 0 && (
                  <li className="panel-items-edit">
                    <button type="button" className="panel-inline-action" onClick={() => setEditingItems(true)} disabled={!!busy} data-testid="edit-items">
                      <Icon name="scissors" size={13} /> Change service, price or time
                    </button>
                  </li>
                )}
              </ul>
            )}
            <PaidStrip payments={payments} booking={booking} canVoid={canVoid && !!onVoidPayment} onVoid={(p) => { setVoiding(p); setVoidReason(""); }} />
            {voiding && (
              <form
                className="panel-note-form"
                aria-label="Void payment"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!onVoidPayment || voidReason.trim().length < 3) return;
                  await onVoidPayment(voiding, voidReason.trim());
                  setVoiding(null);
                }}
              >
                <label className="panel-reason">
                  <span>Why is this payment being voided?</span>
                  <input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} minLength={3} maxLength={300} required autoFocus />
                </label>
                <div className="panel-actions-row">
                  <Button variant="danger" type="submit" disabled={!!busy || voidReason.trim().length < 3}>Void payment</Button>
                  <Button variant="ghost" onClick={() => setVoiding(null)}>Back</Button>
                </div>
              </form>
            )}
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
                  data-dirty={note !== booking.notes ? "true" : undefined}
                  aria-busy={busy === "note"}
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
              {booking.deposit_status === "PAID" ? `Deposit ${money(booking.deposit_paid_pence ?? 0)} paid by card` : booking.deposit_status === "REFUNDED" ? `Deposit ${money(booking.deposit_paid_pence ?? 0)} refunded` : `Deposit policy ${money(booking.deposit_policy_pence)}`} · cancel window {booking.cancel_hours_snapshot}h · booked {when(booking.created_at)}
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

          {checkout && onCheckout && (
            <Checkout
              booking={booking}
              w={w}
              payments={payments}
              busy={busy === "CHECKOUT"}
              onRecord={async (body) => {
                await onCheckout(body);
                setCheckout(false);
              }}
              onCancel={() => setCheckout(false)}
              api={api}
              cardLive={cardLive}
              onPaid={async () => {
                await onPaid?.();
                setCheckout(false);
              }}
            />
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
          {/* One ceremony: Checkout. Payment method (card via reader / QR, cash, transfer, voucher)
              is chosen on the checkout screen; recording it completes the visit. */}
          {["CONFIRMED", "CHECKED_IN", "IN_SERVICE"].includes(booking.status) && (
            <>
              {canTakePayment && onCheckout ? (
                !checkout && (
                  <Button disabled={!!busy} onClick={() => setCheckout(true)} data-testid="take-payment">
                    <Icon name="wallet" size={16} /> Checkout · {money(outstanding)}
                  </Button>
                )
              ) : (
                <Button disabled={!!busy} onClick={() => onStatus("COMPLETED", "")}>
                  <Icon name="checks" size={16} /> {busy === "COMPLETED" ? "Saving…" : "Mark done"}
                </Button>
              )}
              {booking.status === "CONFIRMED" && <Button variant="secondary" onClick={goMove}>Reschedule</Button>}
              <Button variant="ghost" onClick={() => setConfirm({ status: "CANCELLED" })}>Cancel</Button>
              {booking.status === "CONFIRMED" && (isPast || !noShowEarly) && (
                <Button variant="ghost" onClick={() => setConfirm({ status: "NO_SHOW" })}>No-show</Button>
              )}
            </>
          )}
          {booking.status === "COMPLETED" && outstanding > 0 && canTakePayment && onCheckout && !checkout && (
            <Button variant="secondary" disabled={!!busy} onClick={() => setCheckout(true)} data-testid="take-payment">
              <Icon name="wallet" size={16} /> Record payment · {money(outstanding)}
            </Button>
          )}
          <Button variant={["COMPLETED", "CANCELLED", "NO_SHOW"].includes(booking.status) ? "primary" : "ghost"} onClick={goRebook}>
            <Icon name="calendar" size={16} /> Book again
          </Button>
          <details className="panel-more">
            <summary aria-label="More actions"><Icon name="more" size={18} /></summary>
            <div className="panel-more-menu">
              <button type="button" onClick={goEdit}><Icon name="user" size={14} /> Edit name and phone</button>
              {["CONFIRMED", "CHECKED_IN", "IN_SERVICE"].includes(booking.status) && canTakePayment && onCheckout && (
                <button type="button" onClick={() => onStatus("COMPLETED", "")}><Icon name="checks" size={14} /> Mark done without payment</button>
              )}
              <button type="button" onClick={goShare}><Icon name="message" size={14} /> Share confirmation</button>
              <button type="button" onClick={copyDetails}><Icon name="external" size={14} /> {copied ? "Copied" : "Copy details"}</button>
              {!canTakePayment && <span className="panel-more-note"><Icon name="lock" size={14} /> Payments are taken on the shop device</span>}
            </div>
          </details>
        </footer>
      </aside>
    </div>
  );
}

// ---- Edit service / add-ons / price / duration in place -------------------------------------------
// Catalogue values for this barber are the starting point; each line's price and the service's
// duration can be overridden. Re-pricing below a paid deposit refunds the difference (shown first).
function EditItems({
  booking,
  w,
  items,
  busy,
  onCancel,
  onSave,
}: {
  booking: StoredBooking;
  w: WorkspaceData;
  items: BookingItem[];
  busy: boolean;
  onCancel: () => void;
  onSave: (body: { service_id: string; addon_ids: string[]; service_price_pence?: number; service_duration_min?: number; addon_prices: Record<string, number>; reason: string; version: number; force?: boolean }) => Promise<{ refunded_pence: number } | void>;
}) {
  const offered = (svc: string) => !w.service_rules.some((r) => r.staff_id === booking.staff_id && r.service_id === svc && !r.enabled);
  const services = w.services.filter((s) => s.active && (offered(s.id) || s.id === booking.service_id));
  const catalogue = (svcId: string) => {
    const s = w.services.find((x) => x.id === svcId)!;
    const rule = w.service_rules.find((r) => r.staff_id === booking.staff_id && r.service_id === svcId);
    return { price: rule?.price_pence ?? s.price_pence, duration: rule?.duration_min ?? s.duration_min, name: s.name };
  };
  const [serviceId, setServiceId] = useState(booking.service_id);
  const [addonIds, setAddonIds] = useState<string[]>(items.filter((i) => i.kind === "ADDON").map((i) => i.id));
  const [price, setPrice] = useState(String((items[0].price_pence / 100).toFixed(2)));
  const [duration, setDuration] = useState(items[0].duration_min);
  const [addonPrices, setAddonPrices] = useState<Record<string, string>>(Object.fromEntries(items.filter((i) => i.kind === "ADDON").map((i) => [i.id, (i.price_pence / 100).toFixed(2)])));
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ refunded_pence: number } | null>(null);
  const cat = catalogue(serviceId);
  const addonsFor = w.addons.filter((a) => a.active && w.addon_links.some((l) => l.addon_id === a.id && l.service_id === serviceId));
  const pence = (s: string) => Math.max(0, Math.round((Number(s.replace(/[^0-9.]/g, "")) || 0) * 100));
  const total = pence(price) + addonIds.reduce((n, id) => n + pence(addonPrices[id] ?? ((addonsFor.find((a) => a.id === id)?.price_pence ?? 0) / 100).toFixed(2)), 0);
  const totalMin = duration + addonIds.reduce((n, id) => n + (addonsFor.find((a) => a.id === id)?.duration_min ?? 0), 0);
  const depositPaid = booking.deposit_status === "PAID" ? booking.deposit_paid_pence ?? 0 : 0;
  const refund = Math.max(0, depositPaid - total);
  const priceChanged = pence(price) !== cat.price;
  const timeChanged = duration !== cat.duration;
  function pickService(id: string) {
    const c = catalogue(id);
    setServiceId(id);
    setPrice((c.price / 100).toFixed(2));
    setDuration(c.duration);
    setAddonIds((ids) => ids.filter((a) => w.addon_links.some((l) => l.addon_id === a && l.service_id === id)));
  }
  if (done)
    return (
      <div className="panel-items-editor" data-testid="items-saved">
        <Notice icon="checks" tone="success">
          <span>
            Saved. {done.refunded_pence > 0 ? `${money(done.refunded_pence)} refunded to the customer's card; it comes off ${w.staff.find((s) => s.id === booking.staff_id)?.name.split(" ")[0]}'s next pay run.` : "The calendar and checkout now use the new price and time."}
          </span>
        </Notice>
        <Button variant="ghost" onClick={onCancel}>Close</Button>
      </div>
    );
  return (
    <form
      className="panel-items-editor"
      aria-label="Change service, price or time"
      data-testid="items-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        if (reason.trim().length < 3) {
          setError("Say why in a few words — it shows in the history.");
          return;
        }
        try {
          const r = await onSave({
            service_id: serviceId,
            addon_ids: addonIds,
            ...(priceChanged ? { service_price_pence: pence(price) } : {}),
            ...(timeChanged ? { service_duration_min: duration } : {}),
            addon_prices: Object.fromEntries(addonIds.filter((id) => addonPrices[id] !== undefined && pence(addonPrices[id]) !== (addonsFor.find((a) => a.id === id)?.price_pence ?? -1)).map((id) => [id, pence(addonPrices[id])])),
            reason: reason.trim(),
            version: booking.version,
          });
          setDone({ refunded_pence: (r && "refunded_pence" in r ? r.refunded_pence : 0) || 0 });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Could not save.";
          if (/slot_taken|Slot taken|just booked/i.test(msg) && window.confirm("The longer time overlaps the next appointment. Save anyway (they'll sit side by side)?")) {
            try {
              const r = await onSave({ service_id: serviceId, addon_ids: addonIds, ...(priceChanged ? { service_price_pence: pence(price) } : {}), ...(timeChanged ? { service_duration_min: duration } : {}), addon_prices: {}, reason: reason.trim(), version: booking.version, force: true });
              setDone({ refunded_pence: (r && "refunded_pence" in r ? r.refunded_pence : 0) || 0 });
              return;
            } catch (e2) {
              setError(e2 instanceof Error ? e2.message : "Could not save.");
              return;
            }
          }
          setError(msg);
        }
      }}
    >
      <label className="panel-reason">
        <span>Service</span>
        <select value={serviceId} onChange={(e) => pickService(e.target.value)} data-testid="items-service">
          {services.map((s) => (
            <option key={s.id} value={s.id}>{s.name} · {money(catalogue(s.id).price)} · {catalogue(s.id).duration} min</option>
          ))}
        </select>
      </label>
      <div className="items-editor-row">
        <label className="panel-reason">
          <span>Price (£){priceChanged ? <em> · was {money(cat.price)}</em> : null}</span>
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} data-testid="items-price" />
        </label>
        <label className="panel-reason">
          <span>Time{timeChanged ? <em> · was {cat.duration} min</em> : null}</span>
          <span className="items-stepper">
            <button type="button" aria-label="5 minutes less" onClick={() => setDuration((d) => Math.max(5, d - 5))}>−</button>
            <input type="number" min={5} max={480} step={5} value={duration} onChange={(e) => setDuration(Math.max(5, Math.round((Number(e.target.value) || 5) / 5) * 5))} data-testid="items-duration" />
            <button type="button" aria-label="5 minutes more" onClick={() => setDuration((d) => Math.min(480, d + 5))}>+</button>
            <small>min</small>
          </span>
        </label>
      </div>
      {addonsFor.length > 0 && (
        <fieldset className="items-addons">
          <legend>Add-ons</legend>
          {addonsFor.map((a) => {
            const on = addonIds.includes(a.id);
            return (
              <div key={a.id} className="items-addon">
                <label>
                  <input type="checkbox" checked={on} onChange={(e) => setAddonIds((ids) => (e.target.checked ? [...ids, a.id] : ids.filter((x) => x !== a.id)))} />
                  <span>{a.name} <small>· {a.duration_min} min</small></span>
                </label>
                {on && (
                  <span className="items-addon-price">
                    £<input inputMode="decimal" value={addonPrices[a.id] ?? (a.price_pence / 100).toFixed(2)} onChange={(e) => setAddonPrices((p) => ({ ...p, [a.id]: e.target.value }))} aria-label={`${a.name} price`} />
                  </span>
                )}
              </div>
            );
          })}
        </fieldset>
      )}
      <div className="items-editor-total" data-testid="items-total">
        <span>New total</span>
        <strong>{money(total)} · {totalMin} min</strong>
      </div>
      {refund > 0 && (
        <Notice icon="card" tone="warning">
          <span>
            <strong>{money(refund)} goes back to the customer.</strong> They paid a {money(depositPaid)} deposit; the new price is lower. It's refunded to their card when you save and recovered from {w.staff.find((s) => s.id === booking.staff_id)?.name.split(" ")[0]}'s next pay run.
          </span>
        </Notice>
      )}
      <label className="panel-reason">
        <span>Why?</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. went for a skin fade instead" minLength={3} maxLength={300} required data-testid="items-reason" />
      </label>
      {error && <p className="workspace-error" role="alert">{error}</p>}
      <div className="panel-actions-row">
        <Button type="submit" disabled={busy} data-testid="items-save">Save changes</Button>
        <Button variant="ghost" type="button" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
