import { useMemo, useState } from "react";
import { Button, Icon, Notice } from "./ui";
import { money, time } from "./fixtures";

// Conflict management for schedule changes. Any hours/leave/closure form calls `previewThenApply`:
// if the change lands on booked appointments the resolver takes over the dialog body and the shop
// decides, per appointment, to move it (to one of the suggested times), keep it, cancel and refund,
// send it to the waitlist, or leave it flagged. One save applies the change and every decision.

export type Suggestion = { staff_id: string; staff_name: string; date: string; start_min: number; same_barber: boolean; same_day: boolean };
export type Conflict = {
  booking_id: string; ref: string; version: number; staff_id: string; staff_name: string;
  customer_name: string; attendee_name: string; phone: string; email: string; contact_pref: string; channel: string | null;
  service_id: string; service_name: string; date: string; start_min: number; duration_min: number; price_pence: number;
  deposit_status: string; deposit_paid_pence: number; series_id: string | null; reason: string; suggestions: Suggestion[];
};
export type Preview = { conflicts: Conflict[]; summary: { count: number; value_pence: number; deposits_pence: number }; window: { from: string; to: string } };
export type Decision = { booking_id: string; version: number; action: "MOVE" | "KEEP" | "CANCEL" | "WAITLIST" | "LATER"; notify: boolean; move_to?: { staff_id: string; date: string; start_min: number } };
export type Outcome = { booking_id: string; action: string; ok: boolean; note: string; notified: string[] };
export type ScheduleChange =
  | { kind: "override"; staff_id: string; override_id?: string; change: Record<string, unknown> }
  | { kind: "weekly"; staff_id: string; change: Record<string, unknown> }
  | { kind: "day_off"; staff_id: string; change: { date: string; reason: string } }
  | { kind: "holiday"; change: { date: string; label: string } };

const longDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export function ConflictResolver({
  preview,
  title,
  onApply,
  onBack,
}: {
  preview: Preview;
  /** e.g. "Dani off on Wed 23 Sept" — the thing being saved */
  title: string;
  onApply: (decisions: Decision[]) => Promise<void>;
  onBack: () => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() => {
    const d: Record<string, Decision> = {};
    for (const c of preview.conflicts) {
      const s = c.suggestions[0];
      d[c.booking_id] = s
        ? { booking_id: c.booking_id, version: c.version, action: "MOVE", notify: c.contact_pref !== "NONE" && !!c.channel, move_to: { staff_id: s.staff_id, date: s.date, start_min: s.start_min } }
        : { booking_id: c.booking_id, version: c.version, action: "LATER", notify: false };
    }
    return d;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (id: string, patch: Partial<Decision>) => setDecisions((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  const bulk = (action: Decision["action"]) =>
    setDecisions((p) => {
      const n = { ...p };
      for (const c of preview.conflicts) {
        const s = c.suggestions[0];
        if (action === "MOVE" && !s) continue;
        n[c.booking_id] = { ...n[c.booking_id], action, ...(action === "MOVE" && s ? { move_to: { staff_id: s.staff_id, date: s.date, start_min: s.start_min } } : {}) };
      }
      return n;
    });
  const summary = useMemo(() => {
    const n: Record<Decision["action"], number> = { MOVE: 0, KEEP: 0, CANCEL: 0, WAITLIST: 0, LATER: 0 };
    let notify = 0;
    for (const c of preview.conflicts) {
      const d = decisions[c.booking_id];
      n[d.action]++;
      if (d.notify && d.action !== "KEEP" && d.action !== "LATER" && c.channel) notify++;
    }
    return { ...n, notify };
  }, [decisions, preview]);
  const label = [summary.MOVE && `move ${summary.MOVE}`, summary.CANCEL && `cancel ${summary.CANCEL}`, summary.WAITLIST && `waitlist ${summary.WAITLIST}`, summary.KEEP && `keep ${summary.KEEP}`, summary.LATER && `flag ${summary.LATER}`].filter(Boolean).join(", ");

  return (
    <form
      className="workspace-form conflict-resolver"
      data-testid="conflict-resolver"
      data-dirty="true"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await onApply(preview.conflicts.map((c) => decisions[c.booking_id]));
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not save.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy}>
        <Notice tone="warning" icon="users">
          <strong>
            {preview.summary.count} appointment{preview.summary.count === 1 ? "" : "s"} clash{preview.summary.count === 1 ? "es" : ""} with {title}.
          </strong>{" "}
          {money(preview.summary.value_pence)} booked{preview.summary.deposits_pence ? ` · ${money(preview.summary.deposits_pence)} in deposits` : ""}. Decide what happens to each customer; moves and cancellations message them through their preferred channel, and cancellations refund deposits automatically.
        </Notice>
        <div className="conflict-bulk" role="group" aria-label="Apply to all">
          <span>Apply to all:</span>
          <button type="button" className="linklike" onClick={() => bulk("MOVE")}>Move to next free</button>
          <button type="button" className="linklike" onClick={() => bulk("KEEP")}>Keep all</button>
          <button type="button" className="linklike" onClick={() => bulk("CANCEL")}>Cancel all</button>
          <button type="button" className="linklike" onClick={() => bulk("LATER")}>Decide later</button>
        </div>
        <ul className="block-affected conflict-list">
          {preview.conflicts.map((c) => {
            const d = decisions[c.booking_id];
            const picked = c.suggestions.find((s) => d.move_to && s.staff_id === d.move_to.staff_id && s.date === d.move_to.date && s.start_min === d.move_to.start_min);
            return (
              <li key={c.booking_id} className="block-affected-row conflict-row" data-action={d.action} data-testid="conflict-row">
                <div className="block-affected-who">
                  <strong>
                    {longDate(c.date)} · {time(c.start_min)} · {c.attendee_name || c.customer_name}
                  </strong>
                  <span>
                    {c.service_name} · {c.duration_min} min · {money(c.price_pence)} · with {c.staff_name.split(" ")[0]}
                    {c.deposit_status === "PAID" ? ` · ${money(c.deposit_paid_pence)} deposit paid` : ""}
                    {c.series_id ? " · standing booking" : ""}
                  </span>
                  <small className="conflict-reason"><Icon name="alert" size={11} /> {c.reason}</small>
                </div>
                <div className="segmented block-actions conflict-actions" role="radiogroup" aria-label={`What happens to ${c.customer_name}'s visit`}>
                  <button type="button" role="radio" aria-checked={d.action === "MOVE"} disabled={!c.suggestions.length} onClick={() => { const s = c.suggestions[0]; if (s) set(c.booking_id, { action: "MOVE", move_to: { staff_id: s.staff_id, date: s.date, start_min: s.start_min } }); }}>Move</button>
                  <button type="button" role="radio" aria-checked={d.action === "KEEP"} onClick={() => set(c.booking_id, { action: "KEEP" })}>Keep</button>
                  <button type="button" role="radio" aria-checked={d.action === "CANCEL"} onClick={() => set(c.booking_id, { action: "CANCEL" })}>Cancel{c.deposit_status === "PAID" ? " & refund" : ""}</button>
                  <button type="button" role="radio" aria-checked={d.action === "WAITLIST"} onClick={() => set(c.booking_id, { action: "WAITLIST" })}>Waitlist</button>
                  <button type="button" role="radio" aria-checked={d.action === "LATER"} onClick={() => set(c.booking_id, { action: "LATER" })}>Later</button>
                </div>
                <div className="block-affected-detail conflict-detail">
                  {d.action === "MOVE" && (
                    <div className="conflict-suggestions" role="radiogroup" aria-label="Move to">
                      {c.suggestions.map((s) => {
                        const on = picked === s;
                        return (
                          <button key={`${s.staff_id}${s.date}${s.start_min}`} type="button" role="radio" aria-checked={on} className={`block-chip ${on ? "on" : ""}`} onClick={() => set(c.booking_id, { move_to: { staff_id: s.staff_id, date: s.date, start_min: s.start_min } })}>
                            {s.same_day ? "Same day" : longDate(s.date)} {time(s.start_min)}{s.same_barber ? "" : ` · ${s.staff_name.split(" ")[0]}`}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {d.action === "KEEP" && <span>Stays exactly as booked — you're choosing to work it.</span>}
                  {d.action === "CANCEL" && <span>{c.deposit_status === "PAID" ? `Cancelled · ${money(c.deposit_paid_pence)} refunded to the customer` : "Cancelled"}</span>}
                  {d.action === "WAITLIST" && <span>Cancelled and added to the waitlist for that day; they're offered the first slot that frees up.</span>}
                  {d.action === "LATER" && <span>Left as is and flagged in notifications for you to sort out.</span>}
                  {d.action !== "KEEP" && d.action !== "LATER" && (
                    c.contact_pref === "NONE" ? (
                      <small className="block-channel"><Icon name="blocked" size={11} /> Asked not to be contacted</small>
                    ) : c.channel ? (
                      <label className="workspace-check">
                        <input type="checkbox" checked={d.notify} onChange={(e) => set(c.booking_id, { notify: e.target.checked })} /> Tell them by {c.channel === "EMAIL" ? "email" : c.channel === "WA" ? "WhatsApp" : "text"}
                      </label>
                    ) : (
                      <small className="block-channel"><Icon name="offline" size={11} /> No way to reach them — call {c.phone || "them"}</small>
                    )
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {error && <p className="workspace-error" role="alert">{error}</p>}
        <div className="workspace-save-actions">
          <Button type="submit" disabled={busy} data-testid="conflict-apply">
            {busy ? "Saving…" : `Save and ${label}`}
          </Button>
          <Button variant="ghost" onClick={onBack}>Back</Button>
          {summary.notify > 0 && <span className="workspace-footnote">{summary.notify} message{summary.notify === 1 ? "" : "s"} will be sent.</span>}
        </div>
      </fieldset>
    </form>
  );
}

// Outcome summary shown after apply.
export function ConflictOutcome({ outcome, title }: { outcome: Outcome[]; title: string }) {
  const failed = outcome.filter((o) => !o.ok);
  return (
    <div className="block-outcome" data-testid="conflict-outcome">
      <Notice icon="shield" tone={failed.length ? "warning" : "success"}>
        <strong>{title} saved.</strong> {outcome.length - failed.length} of {outcome.length} decision{outcome.length === 1 ? "" : "s"} applied{failed.length ? `; ${failed.length} need${failed.length === 1 ? "s" : ""} a look` : ""}.
      </Notice>
      <ul className="block-outcome-list">
        {outcome.map((o) => (
          <li key={o.booking_id} data-ok={o.ok}>
            <Icon name={o.ok ? "check" : "alert"} size={14} /> <span>{o.note}</span>
            {o.notified.length > 0 && <small>· told by {o.notified.join(", ")}</small>}
          </li>
        ))}
      </ul>
    </div>
  );
}
