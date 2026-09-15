// Top-bar search: one palette over customers, appointments (selected/today), services, barbers and
// sections. Reads the workspace snapshot for instant results and the customers API for the directory.
import { useEffect, useRef, useState } from "react";
import type { StoredBooking, WorkspaceData } from "../server/domain";
import { Icon } from "./ui";
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
  useEffect(() => {
    input.current?.focus();
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setCustomers([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      api<{ customers: typeof customers }>(`/customers?q=${encodeURIComponent(term)}&limit=6`)
        .then((r) => !cancelled && setCustomers(r.customers))
        .catch(() => !cancelled && setCustomers([]));
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q]);
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
    customers.forEach((c) => hits.push({ kind: "customer", id: c.id, name: c.name, phone: c.phone, sub: `${c.visits ?? 0} visit${c.visits === 1 ? "" : "s"}${c.last_visit ? ` · last ${c.last_visit}` : ""}` }));
    w.services.filter((s) => match(`${s.name} ${s.category}`)).slice(0, 4).forEach((s) => hits.push({ kind: "service", id: s.id, name: s.name, sub: `${s.category} · ${s.duration_min} min · ${money(s.price_pence)}` }));
    w.staff.filter((s) => match(`${s.name} ${s.role} ${s.title}`)).slice(0, 3).forEach((s) => hits.push({ kind: "barber", id: s.id, name: s.name, sub: s.title || s.role }));
  }
  useEffect(() => setActive(0), [q, customers.length]);
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
        aria-label="Search"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(hits.length - 1, a + 1));
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          }
          if (e.key === "Enter" && hits[active]) pick(hits[active]);
        }}
      >
        <label className="palette-input">
          <Icon name="search" size={18} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers, appointments, services, barbers…" aria-label="Search everything" role="combobox" aria-expanded="true" aria-controls="palette-results" aria-activedescendant={hits[active] ? `palette-hit-${active}` : undefined} autoComplete="off" />
          <kbd aria-hidden="true">Esc</kbd>
        </label>
        <ul className="palette-results" id="palette-results" role="listbox">
          {hits.length === 0 && <li className="palette-empty">No matches. Try a name, phone number or reference.</li>}
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
  onSignOut,
}: {
  w: WorkspaceData;
  onClose: () => void;
  onAccounts: () => void;
  onSettings?: () => void;
  onPublicPage?: () => void;
  onSignOut: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-testid="account-pill"]')) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);
  const role = w.account ? w.account.role.toLowerCase() : "browser test access";
  return (
    <div className="account-menu" role="menu" aria-label="Account menu" ref={ref} data-testid="account-menu">
      <div className="account-menu-head">
        <b>{w.account?.name || w.shop.name}</b>
        <small>
          {w.shop.name} · {role}
          {w.account?.email ? ` · ${w.account.email}` : ""}
        </small>
      </div>
      <button type="button" role="menuitem" onClick={() => { onClose(); onAccounts(); }}>
        <Icon name="userRound" size={16} /> Account & team access
      </button>
      {onSettings && (
        <button type="button" role="menuitem" onClick={() => { onClose(); onSettings(); }}>
          <Icon name="settings" size={16} /> Shop settings
        </button>
      )}
      {onPublicPage && (
        <button type="button" role="menuitem" onClick={() => { onClose(); onPublicPage(); }}>
          <Icon name="globe" size={16} /> Open public booking page
        </button>
      )}
      <button type="button" role="menuitem" className="danger" onClick={() => { onClose(); onSignOut(); }} data-testid="sign-out">
        <Icon name="logout" size={16} /> Sign out
      </button>
    </div>
  );
}
