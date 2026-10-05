// Top-bar search: one palette over customers, appointments (selected/today), services, barbers and
// sections. Reads the workspace snapshot for instant results and the customers API for the directory.
import { useEffect, useRef, useState } from "react";
import type { StoredBooking, WorkspaceData } from "../server/domain";
import { Icon, useDialogFocus } from "./ui";
import { money, time } from "./fixtures";

type Api = <T>(path: string) => Promise<T>;
type Hit =
  | { kind: "section"; key: string; label: string; icon: string }
  | { kind: "customer"; id: string; name: string; phone: string; sub: string }
  | { kind: "booking"; booking: StoredBooking }
  | { kind: "service"; id: string; name: string; sub: string }
  | { kind: "barber"; id: string; name: string; sub: string };

export function SearchPalette({
  w,
  api,
  sections,
  onClose,
  onSection,
  onCustomer,
  onBooking,
  onService,
  onBarber,
}: {
  w: WorkspaceData;
  api: Api;
  sections: { key: string; label: string; icon: string }[];
  onClose: () => void;
  onSection: (key: string) => void;
  onCustomer: (id: string) => void;
  onBooking: (b: StoredBooking) => void;
  onService: (id: string) => void;
  onBarber: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [customers, setCustomers] = useState<{ id: string; name: string; phone: string; visits?: number; last_visit?: string | null }[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useDialogFocus<HTMLDivElement>(onClose);
  const [customerState, setCustomerState] = useState({ query: "", loading: false, error: "" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const term = q.trim();
    setCustomers([]);
    setCustomerState({ query: term, loading: term.length >= 2, error: "" });
    if (term.length < 2) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      api<{ customers: typeof customers }>(`/customers?q=${encodeURIComponent(term)}&limit=6`)
        .then((r) => { if (!cancelled) { setCustomers(r.customers); setCustomerState({ query: term, loading: false, error: "" }); } })
        .catch(() => { if (!cancelled) setCustomerState({ query: term, loading: false, error: "Could not search customers. Other results are still available." }); });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, retry]);
  const term = q.trim().toLowerCase();
  const match = (s: string) => s.toLowerCase().includes(term);
  const hits: Hit[] = [];
  if (!term) {
    sections.forEach((s) => hits.push({ kind: "section", ...s }));
  } else {
    sections.filter((s) => match(s.label)).forEach((s) => hits.push({ kind: "section", ...s }));
    w.bookings
      .filter((b) => match(`${b.customer_name} ${b.phone} ${b.service_name} BRB-${String(b.sequence).padStart(4, "0")}`))
      .sort((a, b) => Math.abs(a.start_at - w.now) - Math.abs(b.start_at - w.now))
      .slice(0, 5)
      .forEach((b) => hits.push({ kind: "booking", booking: b }));
    (customerState.query === q.trim() && !customerState.loading && !customerState.error ? customers : []).forEach((c) => hits.push({ kind: "customer", id: c.id, name: c.name, phone: c.phone, sub: `${c.visits ?? 0} visit${c.visits === 1 ? "" : "s"}${c.last_visit ? ` · last ${c.last_visit}` : ""}` }));
    w.services.filter((s) => match(`${s.name} ${s.category}`)).slice(0, 4).forEach((s) => hits.push({ kind: "service", id: s.id, name: s.name, sub: `${s.category} · ${s.duration_min} min · ${money(s.price_pence)}` }));
    w.staff.filter((s) => match(`${s.name} ${s.role} ${s.title}`)).slice(0, 3).forEach((s) => hits.push({ kind: "barber", id: s.id, name: s.name, sub: s.title || s.role }));
  }
  useEffect(() => setActive(0), [q, customers.length]);
  useEffect(() => { document.getElementById(`palette-hit-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  function pick(h: Hit) {
    onClose();
    if (h.kind === "section") onSection(h.key);
    else if (h.kind === "customer") onCustomer(h.id);
    else if (h.kind === "booking") onBooking(h.booking);
    else if (h.kind === "service") onService(h.id);
    else onBarber(h.id);
  }
  const groupLabel: Record<Hit["kind"], string> = { section: "Go to", booking: "Appointments", customer: "Customers", service: "Services", barber: "Barbers" };
  return (
    <div className="palette-scrim" onClick={(e) => e.target === e.currentTarget && onClose()} data-testid="search-palette">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        ref={dialog}
        aria-label="Search"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.max(0, Math.min(hits.length - 1, a + 1)));
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          }
          if (e.key === "Enter" && e.target === input.current && hits[active]) { e.preventDefault(); pick(hits[active]); }
        }}
      >
        <label className="palette-input">
          <Icon name="search" size={18} />
          <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} maxLength={100} placeholder="Search customers, appointments, services, barbers…" aria-label="Search everything" role="combobox" aria-expanded="true" aria-controls="palette-results" aria-activedescendant={hits[active] ? `palette-hit-${active}` : undefined} autoComplete="off" />
          {q && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => { setQ(""); input.current?.focus(); }}><Icon name="close" size={16} /></button>}
          <kbd aria-hidden="true">Esc</kbd>
        </label>
        <div className="palette-feedback" role="status">
          {customerState.loading ? "Searching customers…" : customerState.error || (hits.length === 0 ? "No matches. Try a name, phone number or reference." : "")}
          {customerState.error && <button type="button" className="button ghost" onClick={() => setRetry(n => n + 1)}>Retry customer search</button>}
        </div>
        <ul className="palette-results" id="palette-results" role="listbox" aria-label="Search results">
          {hits.map((h, i) => {
            const first = i === 0 || hits[i - 1].kind !== h.kind;
            return (
              <li key={i} role="option" id={`palette-hit-${i}`} aria-selected={i === active} className={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onClick={() => pick(h)}>
                {first && <span className="palette-group">{groupLabel[h.kind]}</span>}
                <span className="palette-ic">
                  <Icon name={h.kind === "section" ? h.icon : h.kind === "customer" ? "user" : h.kind === "booking" ? "calendar" : h.kind === "service" ? "scissors" : "users"} size={16} />
                </span>
                <span className="palette-text">
                  {h.kind === "section" && <b>{h.label}</b>}
                  {h.kind === "customer" && (
                    <>
                      <b>{h.name}</b>
                      <small>
                        {h.phone} · {h.sub}
                      </small>
                    </>
                  )}
                  {h.kind === "booking" && (
                    <>
                      <b>{h.booking.customer_name}</b>
                      <small>
                        {h.booking.date} {time(h.booking.start_min)} · {h.booking.service_name} · {w.staff.find((s) => s.id === h.booking.staff_id)?.name.split(" ")[0]} · {h.booking.status.replace("_", " ").toLowerCase()}
                      </small>
                    </>
                  )}
                  {(h.kind === "service" || h.kind === "barber") && (
                    <>
                      <b>{h.name}</b>
                      <small>{h.sub}</small>
                    </>
                  )}
                </span>
                <Icon name="right" size={14} />
              </li>
            );
          })}
        </ul>
        <p className="palette-foot">Up / Down to move · Enter to open · appointments searched across loaded days</p>
      </div>
    </div>
  );
}

// Account menu under the top-right pill: who you are, switch section, password, sign out.
export function AccountMenu({
  w,
  onClose,
  onAccounts,
  onSettings,
  onPublicPage,
  onSecurity,
  onBilling,
  onSignOut,
}: {
  w: WorkspaceData;
  onClose: () => void;
  onAccounts: () => void;
  onSettings?: () => void;
  onPublicPage?: () => void;
  onSecurity?: () => void;
  onBilling?: () => void;
  onSignOut: () => Promise<boolean>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lock = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    let restore = true;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        if (!lock.current) closeRef.current();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (lock.current) return;
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-testid="account-pill"]')) {
        restore = false;
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      if (restore && previous?.isConnected) previous.focus();
    };
  }, []);
  async function signOut() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try { if (await onSignOut()) onClose(); }
    catch { setError("Could not sign out. Check your connection and try again."); }
    finally { lock.current = false; setBusy(false); }
  }
  const role = w.account ? w.account.role.toLowerCase() : "shop access";
  return (
    <div className="account-menu" ref={ref} data-testid="account-menu" aria-busy={busy}
      onKeyDown={event => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      <div className="account-menu-head">
        <b>{w.account?.name || w.shop.name}</b>
        <small>
          {w.shop.name} · {role}
          {w.account?.email ? ` · ${w.account.email}` : ""}
        </small>
      </div>
      <div role="menu" aria-label="Account menu" className="account-menu-actions">
      <button type="button" role="menuitem" disabled={busy} onClick={() => { onClose(); onAccounts(); }}>
        <Icon name="userRound" size={16} /> Account & team
      </button>
      {onSettings && (
        <button type="button" role="menuitem" disabled={busy} onClick={() => { onClose(); onSettings(); }}>
          <Icon name="settings" size={16} /> Shop settings
        </button>
      )}
      {onPublicPage && (
        <button type="button" role="menuitem" disabled={busy} onClick={() => { onClose(); onPublicPage(); }}>
          <Icon name="globe" size={16} /> View shop page as a customer
        </button>
      )}
      {onSecurity && <button type="button" role="menuitem" disabled={busy} onClick={() => { onClose(); onSecurity(); }}><Icon name="lock" size={16} /> Password & security</button>}
      {onBilling && <button type="button" role="menuitem" disabled={busy} onClick={() => { onClose(); onBilling(); }}><Icon name="receipt" size={16} /> Plan & billing</button>}
      <div className="account-menu-divider" role="separator" />
      <button type="button" role="menuitem" disabled={busy} className="danger" onClick={signOut} data-testid="sign-out">
        <Icon name="logout" size={16} /> {busy ? "Signing out…" : "Sign out"}
      </button>
      </div>
      {error && <p className="account-menu-error" role="alert">{error}</p>}
    </div>
  );
}
