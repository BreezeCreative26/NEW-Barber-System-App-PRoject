import { useEffect, useMemo, useState } from "react";
import type { Staff, StaffBlock, WorkspaceData } from "../server/domain";
import { BLOCK_KINDS } from "../server/domain";
import { Button, Icon, Modal, Notice } from "./ui";
import { money, time } from "./fixtures";
import { BLOCK_LABELS } from "./Calendar";

// Block a barber's time with a reason (Fresha "Add blocked time") and decide, per affected
// appointment, whether to keep it, move it (server suggests the next free slot) or cancel and
// refund. Customers are told through their preferred channel. Three steps: when → who's affected →
// outcome. Owners decided barbers can do this for themselves.

type Affected = {
  id: string;
  customer_name: string;
  attendee_name: string;
  phone: string;
  email: string;
  service_name: string;
  start_min: number;
  duration_min: number;
  price_pence: number;
  version: number;
  status: string;
  deposit_status: string;
  deposit_paid_pence: number;
  channel: string | null;
  service_id: string;
  contact_pref: "AUTO" | "SMS" | "EMAIL" | "NONE";
};
type Suggestion = { staff_id: string; staff_name: string; date: string; start_min: number } | null;
type Preview = { affected: Affected[]; suggestions: Record<string, Suggestion> };
type Resolution = { action: "KEEP" | "CANCEL" | "MOVE"; notify: boolean; move_to?: { staff_id: string; date: string; start_min: number } };
type Outcome = { booking_id: string; action: string; ok: boolean; note: string; notified: string[] };

const clock = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const minute = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
const snap = (n: number) => Math.round(n / 15) * 15;
const longDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

export function BlockDialog({
  staff,
  date,
  at,
  w,
  api,
  onClose,
  onDone,
}: {
  staff: Staff;
  date: string;
  at?: number;
  w: WorkspaceData;
  api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  onClose: () => void;
  onDone: (block: StaffBlock, outcome: Outcome[]) => void;
}) {
  const weekday = new Date(date + "T12:00:00Z").getUTCDay();
  const shift = w.schedule_overrides.find((o) => o.staff_id === staff.id && o.date === date) || w.hours.find((h) => h.staff_id === staff.id && h.weekday === weekday);
  const defaultStart = at ?? (shift?.enabled ? shift.starts : 540);
  const [day, setDay] = useState(date);
  const [start, setStart] = useState(clock(defaultStart));
  const [end, setEnd] = useState(clock(Math.min(1440, defaultStart + 60)));
  const [kind, setKind] = useState<StaffBlock["kind"]>("OTHER");
  const [reason, setReason] = useState("");
  const [step, setStep] = useState<"when" | "who" | "done">("when");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Resolution>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ block: StaffBlock; outcome: Outcome[] } | null>(null);
  const startMin = snap(minute(start)), endMin = snap(minute(end));
  const valid = day && endMin > startMin && startMin >= 0 && endMin <= 1440;
  const first = staff.name.split(" ")[0];

  // Whole-day shortcut fills the shift.
  function allDay() {
    if (shift?.enabled) {
      setStart(clock(shift.starts));
      setEnd(clock(shift.ends));
    } else {
      setStart("09:00");
      setEnd("18:00");
    }
  }

  async function check() {
    if (!valid) {
      setError("Finish time must be after the start.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const p = await api<Preview>(`/staff/${staff.id}/blocks/preview`, "POST", { date: day, start_min: startMin, end_min: endMin });
      setPreview(p);
      const d: Record<string, Resolution> = {};
      for (const a of p.affected) {
        const s = p.suggestions[a.id];
        d[a.id] = s ? { action: "MOVE", notify: a.contact_pref !== "NONE", move_to: { staff_id: s.staff_id, date: s.date, start_min: s.start_min } } : { action: "KEEP", notify: false };
      }
      setDecisions(d);
      if (!p.affected.length) await save({}, p);
      else setStep("who");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check this time.");
    } finally {
      setBusy(false);
    }
  }
  async function save(d = decisions, p = preview) {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ block: StaffBlock; outcome: Outcome[] }>(`/staff/${staff.id}/blocks`, "POST", {
        date: day,
        start_min: startMin,
        end_min: endMin,
        kind,
        reason: reason.trim(),
        resolutions: (p?.affected ?? []).map((a) => {
          const x = d[a.id] ?? { action: "KEEP", notify: false };
          return { booking_id: a.id, action: x.action, notify: x.notify, ...(x.action === "MOVE" && x.move_to ? { move_to: x.move_to } : {}) };
        }),
      });
      setResult(r);
      setStep("done");
      onDone(r.block, r.outcome);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the block.");
    } finally {
      setBusy(false);
    }
  }
  const summary = useMemo(() => {
    if (!preview) return null;
    const n = { KEEP: 0, MOVE: 0, CANCEL: 0 };
    let notify = 0;
    for (const a of preview.affected) {
      const x = decisions[a.id];
      if (!x) continue;
      n[x.action]++;
      if (x.notify && x.action !== "KEEP" && a.channel) notify++;
    }
    return { ...n, notify };
  }, [preview, decisions]);
  useEffect(() => setError(""), [step]);

  return (
    <Modal title={`Block time · ${first}`} onClose={onClose} context="TIMETABLE" protectChanges={step === "who"}>
      <div className="block-dialog" data-testid="block-dialog" data-step={step}>
        {step === "when" && (
          <form
            className="workspace-form"
            onSubmit={(e) => {
              e.preventDefault();
              void check();
            }}
          >
            <fieldset disabled={busy}>
              <Notice icon="blocked">
                <strong>{first} won't be bookable online during this time.</strong> The calendar greys it out with your reason; you can still book over it deliberately. If appointments already sit here you'll choose what happens to each customer next.
              </Notice>
              <div className="workspace-form-grid">
                <label className="workspace-field">
                  <span>Date</span>
                  <input type="date" required value={day} min={w.today} onChange={(e) => setDay(e.target.value)} />
                </label>
                <label className="workspace-field">
                  <span>From</span>
                  <input type="time" step={900} required value={start} onChange={(e) => setStart(e.target.value)} data-testid="block-from" />
                </label>
                <label className="workspace-field">
                  <span>Until</span>
                  <input type="time" step={900} required value={end} onChange={(e) => setEnd(e.target.value)} data-testid="block-until" />
                </label>
              </div>
              <div className="block-quick" aria-label="Quick lengths">
                {[15, 30, 60, 120].map((n) => (
                  <button key={n} type="button" className="block-chip" onClick={() => setEnd(clock(Math.min(1440, startMin + n)))} aria-pressed={endMin - startMin === n}>
                    {n < 60 ? `${n} min` : `${n / 60} h`}
                  </button>
                ))}
                <button type="button" className="block-chip" onClick={allDay}>
                  Whole shift
                </button>
              </div>
              <label className="workspace-field">
                <span>Type</span>
                <div className="block-kinds" role="radiogroup" aria-label="Block type">
                  {BLOCK_KINDS.map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={kind === k} className={`block-chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
                      {BLOCK_LABELS[k]}
                    </button>
                  ))}
                </div>
              </label>
              <label className="workspace-field">
                <span>Reason (shows on the calendar)</span>
                <input value={reason} maxLength={120} placeholder={kind === "OTHER" ? "e.g. Dentist · Stock run · Deep clean" : `Defaults to “${BLOCK_LABELS[kind]}”`} onChange={(e) => setReason(e.target.value)} data-testid="block-reason" />
              </label>
              {error && (
                <p className="workspace-error" role="alert">
                  {error}
                </p>
              )}
              <div className="workspace-save-actions">
                <Button type="submit" disabled={!valid || busy} data-testid="block-check">
                  {busy ? "Checking…" : "Check appointments"}
                </Button>
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
              </div>
              <p className="workspace-footnote">
                {longDate(day)} · {clock(startMin)}–{clock(endMin)} · {endMin > startMin ? `${endMin - startMin} min` : "—"}. Times snap to 15 minutes.
              </p>
            </fieldset>
          </form>
        )}
        {step === "who" && preview && (
          <form
            className="workspace-form"
            data-dirty="true"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy}>
              <Notice icon="users" tone="warning">
                <strong>
                  {preview.affected.length} appointment{preview.affected.length === 1 ? "" : "s"} sit{preview.affected.length === 1 ? "s" : ""} in {clock(startMin)}–{clock(endMin)}.
                </strong>{" "}
                Decide what happens to each customer. Moves go to the next free time we found; cancellations refund any deposit automatically. Messages go by each customer's preferred channel.
              </Notice>
              <ul className="block-affected" data-testid="block-affected">
                {preview.affected.map((a) => {
                  const d = decisions[a.id];
                  const s = preview.suggestions[a.id];
                  const set = (patch: Partial<Resolution>) => setDecisions((prev) => ({ ...prev, [a.id]: { ...prev[a.id], ...patch } }));
                  return (
                    <li key={a.id} className="block-affected-row" data-action={d.action}>
                      <div className="block-affected-who">
                        <strong>
                          {time(a.start_min)} · {a.attendee_name || a.customer_name}
                        </strong>
                        <span>
                          {a.service_name} · {a.duration_min} min · {money(a.price_pence)}
                          {a.deposit_status === "PAID" ? ` · ${money(a.deposit_paid_pence)} deposit paid` : ""}
                        </span>
                        <small className="block-channel">
                          {a.contact_pref === "NONE" ? (
                            <>
                              <Icon name="blocked" size={11} /> Asked not to be contacted
                            </>
                          ) : a.channel ? (
                            <>
                              <Icon name={a.channel === "EMAIL" ? "message" : "phone"} size={11} /> {a.channel === "EMAIL" ? `Email · ${a.email}` : `SMS · ${a.phone}`}
                            </>
                          ) : (
                            <>
                              <Icon name="offline" size={11} /> No way to reach them
                            </>
                          )}
                        </small>
                      </div>
                      <div className="segmented block-actions" role="radiogroup" aria-label={`What happens to ${a.customer_name}'s visit`}>
                        <button type="button" role="radio" aria-checked={d.action === "MOVE"} disabled={!s} title={s ? `Next free: ${longDate(s.date)} ${time(s.start_min)} with ${s.staff_name}` : "No free time in the next week"} onClick={() => s && set({ action: "MOVE", move_to: { staff_id: s.staff_id, date: s.date, start_min: s.start_min } })}>
                          Move
                        </button>
                        <button type="button" role="radio" aria-checked={d.action === "CANCEL"} onClick={() => set({ action: "CANCEL" })}>
                          Cancel{a.deposit_status === "PAID" ? " & refund" : ""}
                        </button>
                        <button type="button" role="radio" aria-checked={d.action === "KEEP"} onClick={() => set({ action: "KEEP" })}>
                          Keep
                        </button>
                      </div>
                      <div className="block-affected-detail">
                        {d.action === "MOVE" && s && (
                          <span>
                            <Icon name="repeat" size={12} /> {s.date === day ? "Same day" : longDate(s.date)} {time(s.start_min)}
                            {s.staff_id !== staff.id ? ` with ${s.staff_name.split(" ")[0]}` : ""}
                          </span>
                        )}
                        {d.action === "CANCEL" && <span>{a.deposit_status === "PAID" ? `Cancelled · ${money(a.deposit_paid_pence)} refunded from ${first}'s wallet` : "Cancelled"}</span>}
                        {d.action === "KEEP" && <span>Stays booked; the card sits on top of the block.</span>}
                        {d.action !== "KEEP" && a.channel && a.contact_pref !== "NONE" && (
                          <label className="workspace-check">
                            <input type="checkbox" checked={d.notify} onChange={(e) => set({ notify: e.target.checked })} /> Tell them by {a.channel === "EMAIL" ? "email" : "text"}
                          </label>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {error && (
                <p className="workspace-error" role="alert">
                  {error}
                </p>
              )}
              <div className="workspace-save-actions">
                <Button type="submit" disabled={busy} data-testid="block-save">
                  {busy ? "Saving…" : `Block time${summary ? ` · ${[summary.MOVE ? `move ${summary.MOVE}` : "", summary.CANCEL ? `cancel ${summary.CANCEL}` : "", summary.KEEP ? `keep ${summary.KEEP}` : ""].filter(Boolean).join(", ")}` : ""}`}
                </Button>
                <Button variant="ghost" onClick={() => setStep("when")}>
                  Back
                </Button>
                {summary && summary.notify > 0 && (
                  <span className="workspace-footnote">
                    {summary.notify} message{summary.notify === 1 ? "" : "s"} will be sent.
                  </span>
                )}
              </div>
            </fieldset>
          </form>
        )}
        {step === "done" && result && (
          <div className="block-outcome" data-testid="block-outcome">
            <Notice icon="shield" tone="success">
              <strong>
                {first} is blocked {longDate(result.block.date)} {clock(result.block.start_min)}–{clock(result.block.end_min)}
              </strong>{" "}
              · {result.block.reason || BLOCK_LABELS[result.block.kind]}.
            </Notice>
            {result.outcome.length > 0 && (
              <ul className="block-affected">
                {result.outcome.map((o) => {
                  const a = preview?.affected.find((x) => x.id === o.booking_id);
                  return (
                    <li key={o.booking_id} className="block-affected-row" data-ok={o.ok}>
                      <div className="block-affected-who">
                        <strong>
                          {a ? `${time(a.start_min)} · ${a.attendee_name || a.customer_name}` : o.booking_id}
                        </strong>
                        <span>{o.note}</span>
                        <small className="block-channel">
                          {o.ok ? <Icon name="paid" size={11} /> : <Icon name="blocked" size={11} />} {o.ok ? (o.notified.length ? `Told by ${o.notified.map((c) => (c === "EMAIL" ? "email" : "text")).join(" and ")}` : "Not contacted") : "Failed — still booked as before"}
                        </small>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="workspace-save-actions">
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
