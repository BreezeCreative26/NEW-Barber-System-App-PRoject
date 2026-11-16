// "Hold for someone": keep a free time for a named customer and send them a link to confirm.
// Existing customer → book them in now, or send the link. New customer → name + mobile (+ email) → send.
// The same dialog opens for a held space on the calendar: resend, book now, or release it.
import { useEffect, useRef, useState } from "react";
import type { StaffBlock, WorkspaceData } from "../server/domain";
import { Button, Icon, Modal } from "./ui";
import { time } from "./fixtures";
import { offersService } from "./offers";

export type HoldCustomer = { id: string | null; name: string; phone: string; email: string };
type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Found = { id: string; name: string; phone: string; email: string };
type HeldRow = { id: string; status: string; date: string; start_min: number; expires_at: number; staff_id: string; service_id: string; customer_name: string; phone: string; email: string; service_name: string };

const lengthLabel = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${+(m / 60).toFixed(1)} hour${m === 60 ? "" : "s"}` : `${+(m / 1440).toFixed(1)} day${m === 1440 ? "" : "s"}`);
// Quick choices around the shop's default (Settings → Waiting list → Holding a space).
const lengthsFor = (def: number) => [...new Set([60, def, 240, 1440])].sort((a, b) => a - b).slice(0, 4);
const mobileOk = (p: string) => /^(?:\+44|0)7\d{9}$/.test(p.replace(/[\s()-]/g, ""));
const leftLabel = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`;
};

export function HoldDialog({ w, staffId, date, start, api, onClose, onDone, onBookNow }: {
  w: WorkspaceData; staffId: string; date: string; start: number; api: Api;
  onClose: () => void; onDone: (message: string) => void;
  onBookNow: (customer: HoldCustomer, serviceId: string) => void;
}) {
  const staff = w.staff.find((s) => s.id === staffId);
  const services = w.services.filter((s) => s.active && offersService(w.service_rules, staffId, s.id));
  const [service, setService] = useState(services[0]?.id || "");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [picked, setPicked] = useState<HoldCustomer | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const defaultHold = w.shop.slot_hold_min ?? 240;
  const lengths = lengthsFor(defaultHold);
  const [length, setLength] = useState(defaultHold);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (!q) { setFound(null); return; }
    const id = ++seq.current;
    const t = window.setTimeout(() => {
      api<{ customers: Found[] }>(`/customers?${new URLSearchParams({ q, limit: "5" })}`)
        .then((r) => id === seq.current && setFound(r.customers))
        .catch(() => id === seq.current && setFound([]));
    }, 180);
    return () => window.clearTimeout(t);
  }, [query, api]);
  const who: HoldCustomer | null = picked ?? (adding && name.trim() && mobileOk(phone) ? { id: null, name: name.trim(), phone: phone.trim(), email: email.trim() } : null);
  const svc = w.services.find((s) => s.id === service);
  function startNew() {
    const q = query.trim();
    if (mobileOk(q)) setPhone(q); else if (q.includes("@")) setEmail(q); else setName(q);
    setAdding(true);
    setQuery("");
  }
  async function hold() {
    if (!who || !service) return;
    setBusy(true);
    setError("");
    try {
      await api("/holds", "POST", { staff_id: staffId, service_id: service, date, start_min: start, customer_name: who.name, phone: who.phone, email: who.email || "", hold_min: length, send: true, force: true });
      onDone(`Held ${time(start)} for ${who.name.split(" ")[0]} · link sent.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not hold this time.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Hold ${time(start)} · ${staff?.name.split(" ")[0] ?? ""}`} onClose={onClose} context="TIMETABLE">
      <div className="hold-dialog" data-testid="hold-dialog">
        <p className="hold-lead">Keep this time for someone. They get a text/email to sign up (or sign in) and confirm. Nobody else can book it meanwhile.</p>
        <label className="workspace-field">
          <span>Service</span>
          <select value={service} onChange={(e) => setService(e.target.value)} data-testid="hold-service">
            {services.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.duration_min} min</option>)}
          </select>
        </label>
        <div className="workspace-field">
          <span>Customer</span>
          {picked ? (
            <div className="hold-picked" data-testid="hold-picked">
              <span><b>{picked.name}</b><small>{picked.phone}{picked.email ? ` · ${picked.email}` : ""}</small></span>
              <button type="button" className="panel-inline" onClick={() => setPicked(null)}>Change</button>
            </div>
          ) : adding ? (
            <div className="hold-new">
              <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="hold-new-name" />
              <input placeholder="Mobile" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="hold-new-phone" />
              <input placeholder="Email (optional)" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="hold-new-email" />
              <button type="button" className="panel-inline" onClick={() => setAdding(false)}>Find an existing customer instead</button>
            </div>
          ) : (
            <div className="hold-find">
              <label className="customers-search">
                <Icon name="search" size={16} />
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, mobile or email" autoFocus autoComplete="off" data-testid="hold-find" />
              </label>
              {found && (
                <ul className="hold-results" role="listbox">
                  {found.map((c) => (
                    <li key={c.id}><button type="button" onClick={() => { setPicked({ id: c.id, name: c.name, phone: c.phone, email: c.email }); setQuery(""); }}><b>{c.name}</b><small>{c.phone}</small></button></li>
                  ))}
                  <li><button type="button" className="hold-add" onClick={startNew} data-testid="hold-add-new"><Icon name="plus" size={14} /> New customer{query.trim() ? `: ${query.trim()}` : ""}</button></li>
                </ul>
              )}
              {!found && <button type="button" className="panel-inline" onClick={() => setAdding(true)} data-testid="hold-add-new">+ New customer</button>}
            </div>
          )}
        </div>
        <div className="workspace-field">
          <span>Hold for</span>
          <div className="block-quick" role="radiogroup" aria-label="Hold for">
            {lengths.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={length === m} className={`block-chip ${length === m ? "on" : ""}`} onClick={() => setLength(m)} data-testid={`hold-len-${m}`}>
                {lengthLabel(m)}{m === defaultHold ? " · default" : ""}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="hold-actions">
          {picked && (
            <Button variant="secondary" disabled={busy || !service} onClick={() => onBookNow(picked, service)} data-testid="hold-book-now">
              <Icon name="calendarCheck" size={16} /> Book now
            </Button>
          )}
          <Button disabled={busy || !who || !service} onClick={hold} data-testid="hold-send">
            <Icon name="send" size={16} /> {busy ? "Holding…" : `Hold & send link`}
          </Button>
        </div>
        {svc && <p className="hold-fine">{svc.name} · {time(start)}–{time(start + svc.duration_min)}. Held until they confirm, say no, or the time runs out.</p>}
      </div>
    </Modal>
  );
}

// A held space on the calendar: who it's for, time left, and what to do with it.
export function HeldDialog({ w, block, api, onClose, onDone, onBookNow }: {
  w: WorkspaceData; block: StaffBlock; api: Api;
  onClose: () => void; onDone: (message: string) => void;
  onBookNow: (customer: HoldCustomer, serviceId: string, block: StaffBlock) => void;
}) {
  const [row, setRow] = useState<HeldRow | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ hold: HeldRow }>(`/holds/${block.offer_id}`).then((r) => setRow(r.hold)).catch((e) => setError(e instanceof Error ? e.message : "Could not load this hold."));
  }, [api, block.offer_id]);
  const staff = w.staff.find((s) => s.id === block.staff_id);
  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError("");
    try { onDone(await fn()); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); } finally { setBusy(false); }
  }
  const live = row && row.status === "PENDING" && row.expires_at > Date.now();
  return (
    <Modal title={`Held · ${time(block.start_min)} · ${staff?.name.split(" ")[0] ?? ""}`} onClose={onClose} context="TIMETABLE">
      <div className="hold-dialog" data-testid="held-dialog">
        {!row && !error && <p className="hold-lead">Loading…</p>}
        {row && (
          <>
            <div className="hold-picked">
              <span><b>{row.customer_name}</b><small>{row.phone}{row.email ? ` · ${row.email}` : ""}</small></span>
            </div>
            <p className="hold-lead">
              {row.service_name} · {time(row.start_min)}–{time(block.end_min)}.{" "}
              {live ? <>Waiting for them to confirm · <strong>{leftLabel(row.expires_at - Date.now())} left</strong>.</> : "This hold has ended."}
            </p>
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="hold-actions">
          <Button variant="ghost" disabled={busy || !row} onClick={() => run(async () => { await api(`/holds/${block.offer_id}`, "DELETE"); return "Hold released · the time is free again."; })} data-testid="held-release">
            <Icon name="close" size={16} /> Release
          </Button>
          {live && (
            <Button variant="secondary" disabled={busy} onClick={() => run(async () => { const r = await api<{ sent: boolean }>(`/holds/${block.offer_id}/resend`, "POST", {}); return r.sent ? "Link sent again." : "New link made, but they have no mobile/email we can message."; })} data-testid="held-resend">
              <Icon name="send" size={16} /> Send again
            </Button>
          )}
          {row && (
            <Button
              disabled={busy}
              onClick={async () => {
                // Use their customer record when the mobile already belongs to one (no retyping, no duplicate).
                const match = await api<{ customers: Found[] }>(`/customers?${new URLSearchParams({ q: row.phone, limit: "3" })}`).then((r) => r.customers.find((c) => c.phone === row.phone)).catch(() => undefined);
                onBookNow(match ? { id: match.id, name: match.name, phone: match.phone, email: match.email || row.email } : { id: null, name: row.customer_name, phone: row.phone, email: row.email }, row.service_id, block);
              }}
              data-testid="held-book-now"
            >
              <Icon name="calendarCheck" size={16} /> Book them in
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
