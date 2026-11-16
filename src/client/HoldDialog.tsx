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
// Clipboard with a fallback for older browsers / non-secure previews.
async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const t = document.createElement("textarea");
  t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
  document.body.appendChild(t); t.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  t.remove();
  return ok;
}
type HoldResult = { link: string; sent: boolean };
// After holding: say plainly whether a message went, and offer the link to copy either way.
function LinkReady({ who, result, onClose }: { who: string; result: HoldResult; onClose: () => void }) {
  const [copied, setCopied] = useState<"" | "yes" | "no">("");
  return (
    <div className="hold-ready" data-testid="hold-ready">
      <p className={`hold-ready-status ${result.sent ? "ok" : "warn"}`} data-testid="hold-ready-status">
        <Icon name={result.sent ? "check" : "alert"} size={16} />
        {result.sent ? <span>Link sent to {who}. You can also copy it to share yourself.</span> : <span><b>Not sent.</b> Text and email aren’t switched on, or {who} has no mobile/email we can message. Copy the link and send it yourself.</span>}
      </p>
      <div className="hold-link">
        <input readOnly value={result.link} onFocus={(e) => e.currentTarget.select()} aria-label="Confirmation link" data-testid="hold-link" />
        <Button variant={result.sent ? "secondary" : "primary"} onClick={async () => setCopied((await copyText(result.link)) ? "yes" : "no")} data-testid="hold-copy">
          <Icon name={copied === "yes" ? "check" : "copy"} size={16} /> {copied === "yes" ? "Copied" : "Copy link"}
        </Button>
      </div>
      {copied === "no" && <p className="hold-fine">Couldn’t copy automatically. Select the link above and copy it.</p>}
      <div className="hold-actions"><Button variant="ghost" onClick={onClose} data-testid="hold-ready-done">Done</Button></div>
    </div>
  );
}

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
  const [ready, setReady] = useState<HoldResult | null>(null);
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
      const r = await api<{ hold: HoldResult }>("/holds", "POST", { staff_id: staffId, service_id: service, date, start_min: start, customer_name: who.name, phone: who.phone, email: who.email || "", hold_min: length, send: true, force: true });
      setReady({ link: r.hold.link, sent: r.hold.sent });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not hold this time.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Hold ${time(start)} · ${staff?.name.split(" ")[0] ?? ""}`} onClose={ready ? () => onDone(`Held ${time(start)} for ${who?.name.split(" ")[0] ?? "them"}${ready.sent ? " · link sent" : " · link not sent"}.`) : onClose} context="TIMETABLE">
      {ready ? (
        <div className="hold-dialog" data-testid="hold-dialog">
          <p className="hold-lead">Held {time(start)} for <b>{who?.name}</b>. Nobody else can book it while it’s held.</p>
          <LinkReady who={who?.name.split(" ")[0] ?? "them"} result={ready} onClose={() => onDone(`Held ${time(start)} for ${who?.name.split(" ")[0] ?? "them"}${ready.sent ? " · link sent" : " · link not sent"}.`)} />
        </div>
      ) : (
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
      )}
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
  const [ready, setReady] = useState<HoldResult | null>(null);
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
        {ready && row && <LinkReady who={row.customer_name.split(" ")[0]} result={ready} onClose={() => onDone(ready.sent ? "Link sent again." : "New link ready · not sent.")} />}
        {ready && <p className="hold-fine">A new link was made, so any earlier link for this hold no longer works.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="hold-actions">
          <Button variant="ghost" disabled={busy || !row} onClick={() => run(async () => { await api(`/holds/${block.offer_id}`, "DELETE"); return "Hold released · the time is free again."; })} data-testid="held-release">
            <Icon name="close" size={16} /> Release
          </Button>
          {live && (
              <>
              <Button variant="secondary" disabled={busy} onClick={async () => {
                setBusy(true); setError("");
                try { setReady(await api<HoldResult>(`/holds/${block.offer_id}/resend`, "POST", { send: false })); } catch (e) { setError(e instanceof Error ? e.message : "Could not make a link."); } finally { setBusy(false); }
              }} data-testid="held-copy-link">
                <Icon name="copy" size={16} /> Copy link
              </Button>
              <Button variant="secondary" disabled={busy} onClick={async () => {
                setBusy(true); setError("");
                try { setReady(await api<HoldResult>(`/holds/${block.offer_id}/resend`, "POST", {})); } catch (e) { setError(e instanceof Error ? e.message : "Could not send."); } finally { setBusy(false); }
              }} data-testid="held-resend">
                <Icon name="send" size={16} /> Send again
              </Button>
            </>
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
