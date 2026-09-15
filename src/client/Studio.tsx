// Service studio and barber studio: catalogue presentation, per-barber matrix and
// team profiles. All writes go through the existing versioned sandbox routes.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  Service,
  Staff,
  StaffServiceRule,
  StoredBooking,
  WorkspaceData,
} from "../server/domain";
import { Avatar, Badge, Button, Icon, Notice } from "./ui";
import { money, time } from "./fixtures";
import { PayTermsForm, PayRuns, payFormOf, summariseTerms, type PayForm } from "./Pay";
import { PhotoUpload } from "./Media";
import type { PayRun } from "../server/domain";

export const COLOURS: { key: string; label: string }[] = [
  { key: "sage", label: "Sage" },
  { key: "sand", label: "Sand" },
  { key: "blue", label: "Blue" },
  { key: "clay", label: "Clay" },
  { key: "plum", label: "Plum" },
  { key: "slate", label: "Slate" },
];
const initials = (name: string) => name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

function ColourPicker({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  return (
    <fieldset className="colour-picker">
      <legend>{label}</legend>
      <div className="colour-picker-row">
        {COLOURS.map((c) => (
          <label key={c.key} className={`colour-swatch ${c.key} ${value === c.key ? "on" : ""}`} title={c.label}>
            <input type="radio" name={label} value={c.key} checked={value === c.key} onChange={() => onChange(c.key)} />
            <span className="visually-hidden">{c.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
function TagInput({ tags, onChange, suggestions, label }: { tags: string[]; onChange: (t: string[]) => void; suggestions: string[]; label: string }) {
  const [input, setInput] = useState("");
  const add = (raw: string) => {
    const t = raw.trim().slice(0, 30);
    if (t && !tags.includes(t) && tags.length < 12) onChange([...tags, t]);
    setInput("");
  };
  return (
    <div className="tag-editor">
      <span className="field-label">{label}</span>
      <div className="panel-tags editable">
        {tags.map((t) => (
          <span className="tag" key={t}>
            {t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>×</button>
          </span>
        ))}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(input);
            }
          }}
          onBlur={() => input && add(input)}
          placeholder={tags.length ? "Add" : "Type and press Enter"}
          aria-label={`Add ${label.toLowerCase()}`}
          maxLength={30}
        />
      </div>
      <div className="tag-suggestions">
        {suggestions.filter((s) => !tags.includes(s)).slice(0, 6).map((s) => (
          <button type="button" key={s} onClick={() => add(s)}>+ {s}</button>
        ))}
      </div>
    </div>
  );
}
type LineState = { kind: "ok" | "error"; text: string; conflict?: boolean } | null;
function StatusLine({ state, onDiscard }: { state: LineState; onDiscard?: () => void }) {
  if (!state) return null;
  return (
    <div className={state.kind === "error" ? "workspace-error studio-status" : "workspace-success studio-status"} role={state.kind === "error" ? "alert" : "status"}>
      <p>{state.text}</p>
      {state.conflict && onDiscard && (
        <Button variant="secondary" type="button" onClick={onDiscard}>
          Discard edits and load latest
        </Button>
      )}
    </div>
  );
}
const isConflict = (err: unknown) => err instanceof Error && /changed in another view|record_changed/i.test(err.message);
// Editors hold unsaved form state; leaving (close or tab switch) must be explicit when dirty.
function useLeaveGuard(rootId: string) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const guarded = (fn: () => void) => () => {
    const dirty = document.getElementById(rootId)?.querySelector('[data-dirty="true"]');
    if (dirty) setPending(() => fn);
    else fn();
  };
  const notice = pending ? (
    <div className="workspace-error studio-status" role="alert">
      <p>You have unsaved changes in this section.</p>
      <div className="panel-actions-row">
        <Button variant="secondary" type="button" onClick={() => { const fn = pending; setPending(null); fn(); }}>
          Discard changes and continue
        </Button>
        <Button variant="ghost" type="button" onClick={() => setPending(null)}>
          Keep editing
        </Button>
      </div>
    </div>
  ) : null;
  return { guarded, notice };
}

// ---------- Per-barber matrix (shared by both studios) ----------
type MatrixRow = { staff_id: string; service_id: string; enabled: number; price_pence: number | null; duration_min: number | null };
export function RuleMatrix({
  w,
  api,
  service,
  staff,
  onSaved,
}: {
  w: WorkspaceData;
  api: Api;
  service?: Service;
  staff?: Staff;
  onSaved: () => Promise<unknown>;
}) {
  const rows = useMemo<MatrixRow[]>(() => {
    const pairs = service
      ? w.staff.filter((s) => s.active).map((s) => ({ staff_id: s.id, service_id: service.id }))
      : w.services.filter((s) => s.active).map((s) => ({ staff_id: staff!.id, service_id: s.id }));
    return pairs.map((p) => {
      const r = w.service_rules.find((x) => x.staff_id === p.staff_id && x.service_id === p.service_id);
      return { ...p, enabled: r ? r.enabled : 1, price_pence: r?.price_pence ?? null, duration_min: r?.duration_min ?? null };
    });
  }, [w, service?.id, staff?.id]);
  const [draft, setDraft] = useState<MatrixRow[]>(rows);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<LineState>(null);
  useEffect(() => setDraft(rows), [rows]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(rows);
  const update = (i: number, patch: Partial<MatrixRow>) => setDraft(draft.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const base = (r: MatrixRow) => (service ? service : w.services.find((s) => s.id === r.service_id)!);
  const label = (r: MatrixRow) => (service ? w.staff.find((s) => s.id === r.staff_id)!.name : base(r).name);
  const barberName = (r: MatrixRow) => (staff ? staff.name : w.staff.find((s) => s.id === r.staff_id)!.name);
  return (
    <form
      className="rule-matrix"
      data-dirty={dirty ? "true" : undefined}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setState(null);
        try {
          await api("/service-rules", "PUT", { rules: draft });
          await onSaved();
          setState({ kind: "ok", text: `${draft.length} barber rule${draft.length === 1 ? "" : "s"} saved. Future availability and quotes use them; saved appointments keep their snapshots.` });
        } catch (err) {
          setState({ kind: "error", text: err instanceof Error ? err.message : "Could not save rules." });
        } finally {
          setBusy(false);
        }
      }}
    >
      <table className="matrix-table">
        <thead>
          <tr>
            <th scope="col">{service ? "Barber" : "Service"}</th>
            <th scope="col">Offers</th>
            <th scope="col">Price</th>
            <th scope="col">Duration</th>
            <th scope="col"><span className="visually-hidden">Override</span></th>
          </tr>
        </thead>
        <tbody>
          {draft.map((r, i) => {
            const b = base(r);
            const custom = r.price_pence !== null || r.duration_min !== null;
            return (
              <tr key={r.staff_id + r.service_id} className={r.enabled ? "" : "off"}>
                <th scope="row">
                  <span className="matrix-name">
                    {service ? <Avatar initials={initials(label(r))} colour={w.staff.find((s) => s.id === r.staff_id)?.colour || "sage"} /> : <span className={`service-dot ${b.colour}`} aria-hidden="true" />}
                    {label(r)}
                  </span>
                </th>
                <td>
                  <label className="switch">
                    <input type="checkbox" checked={!!r.enabled} onChange={(e) => update(i, { enabled: e.target.checked ? 1 : 0 })} aria-label={`${barberName(r)} offers ${b.name}`} />
                    <span />
                  </label>
                </td>
                <td>
                  <div className="matrix-input">
                    <span>£</span>
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      step="0.01"
                      disabled={!r.enabled}
                      placeholder={(b.price_pence / 100).toFixed(2)}
                      value={r.price_pence === null ? "" : (r.price_pence / 100).toString()}
                      onChange={(e) => update(i, { price_pence: e.target.value === "" ? null : Math.round(Number(e.target.value) * 100) })}
                      aria-label={`${barberName(r)} price for ${b.name}`}
                    />
                  </div>
                </td>
                <td>
                  <div className="matrix-input">
                    <input
                      type="number"
                      min={5}
                      max={240}
                      step={5}
                      disabled={!r.enabled}
                      placeholder={String(b.duration_min)}
                      value={r.duration_min === null ? "" : String(r.duration_min)}
                      onChange={(e) => update(i, { duration_min: e.target.value === "" ? null : Number(e.target.value) })}
                      aria-label={`${barberName(r)} duration for ${b.name}`}
                    />
                    <span>min</span>
                  </div>
                </td>
                <td>
                  {custom ? (
                    <button type="button" className="panel-inline" onClick={() => update(i, { price_pence: null, duration_min: null })}>
                      Reset
                    </button>
                  ) : (
                    <small className="matrix-default">default</small>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="matrix-footer">
        <p className="workspace-footnote">
          Blank price/duration = catalogue default{service ? ` (${money(service.price_pence)} · ${service.duration_min} min)` : ""}. Turning a service off flags future appointments for review; it never cancels them.
        </p>
        <div className="panel-actions-row">
          <Button type="submit" disabled={!dirty || busy}>{busy ? "Saving…" : "Save barber rules"}</Button>
          {dirty && <Button variant="ghost" type="button" onClick={() => setDraft(rows)}>Revert</Button>}
        </div>
      </div>
      <StatusLine state={state} />
    </form>
  );
}

// ---------- Service studio ----------
export function ServiceStudio({
  w,
  api,
  refresh,
  onAddon,
  onAddAddon,
  initialSelected = null,
}: {
  w: WorkspaceData;
  api: Api;
  refresh: () => Promise<WorkspaceData>;
  onAddon: (id: string) => void;
  onAddAddon: () => void;
  initialSelected?: string | null;
}) {
  const [selected, setSelected] = useState<string | "new" | null>(initialSelected);
  useEffect(() => {
    if (initialSelected) setSelected(initialSelected);
  }, [initialSelected]);
  const pendingSelect = useRef<string | null>(null);
  // The record created from the "new" editor keeps that editor instance so its confirmation stays visible.
  const [born, setBorn] = useState<string | null>(null);
  useEffect(() => {
    const id = pendingSelect.current;
    if (id && w.services.some((s) => s.id === id)) {
      pendingSelect.current = null;
      setSelected(id);
    }
  }, [w.services]);
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const categories = useMemo(() => {
    const seen = new Map<string, Service[]>();
    for (const s of [...w.services].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))) {
      if (!showInactive && !s.active) continue;
      if (query && !`${s.name} ${s.category} ${s.description}`.toLowerCase().includes(query.toLowerCase())) continue;
      seen.set(s.category, [...(seen.get(s.category) || []), s]);
    }
    return [...seen.entries()];
  }, [w.services, query, showInactive]);
  const offers = (s: Service) => w.staff.filter((b) => b.active && !w.service_rules.some((r) => r.staff_id === b.id && r.service_id === s.id && !r.enabled));
  const selectedService = selected && selected !== "new" ? w.services.find((s) => s.id === selected) || null : null;
  const upcoming = (s: Service) => w.bookings.filter((b) => b.service_id === s.id && ["CONFIRMED", "CHECKED_IN"].includes(b.status)).length;
  return (
    <div className={`studio ${selected ? "has-detail" : ""}`}>
      <section className="workspace-panel studio-list" aria-labelledby="service-studio-heading">
        <div className="workspace-section-heading">
          <div>
            <h2 id="service-studio-heading">Services</h2>
            <p className="workspace-footnote">
              {w.services.filter((s) => s.active).length} live · {w.addons.filter((a) => a.active).length} add-ons · saved appointments keep their price snapshot
            </p>
          </div>
          <Button onClick={() => setSelected("new")}>
            <Icon name="plus" size={16} /> New service
          </Button>
        </div>
        <div className="customers-toolbar">
          <label className="customers-search">
            <Icon name="search" size={16} />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search services" aria-label="Search services" />
          </label>
          <label className="studio-toggle">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
          </label>
        </div>
        {categories.length === 0 && <p className="workspace-footnote">No services match.</p>}
        {categories.map(([cat, list]) => (
          <section key={cat} className="studio-category" aria-label={cat}>
            <h3>
              {cat} <small>{list.length}</small>
            </h3>
            <ul className="service-cards">
              {list.map((s) => (
                <li key={s.id}>
                  <button type="button" data-testid="service-card" className={`service-card ${s.colour} ${selected === s.id ? "selected" : ""} ${s.active ? "" : "inactive"}`} onClick={() => setSelected(s.id)} aria-current={selected === s.id ? "true" : undefined}>
                    <span className="service-card-head">
                      <strong>{s.name}</strong>
                      {s.popular ? <span className="tag good">Popular</span> : null}
                      {!s.online_bookable && <span className="tag">In shop only</span>}
                      {!s.active && <span className="tag warn">Inactive</span>}
                    </span>
                    {s.description && <small className="service-card-desc">{s.description}</small>}
                    <span className="service-card-meta">
                      <strong>{money(s.price_pence)}</strong> · {s.duration_min} min · {offers(s).length}/{w.staff.filter((b) => b.active).length} barbers
                      {upcoming(s) ? ` · ${upcoming(s)} upcoming` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <section className="studio-addons" aria-labelledby="addons-heading">
          <div className="workspace-section-heading">
            <h3 id="addons-heading">Add-ons</h3>
            <Button variant="secondary" onClick={onAddAddon}>
              <Icon name="plus" size={14} /> Add add-on
            </Button>
          </div>
          {!w.addons.length && <p className="workspace-footnote">No add-ons yet.</p>}
          <ul className="addon-chips">
            {w.addons.map((a) => (
              <li key={a.id}>
                <button type="button" className={`addon-chip ${a.active ? "" : "inactive"}`} onClick={() => onAddon(a.id)}>
                  <strong>{a.name}</strong>
                  <small>
                    +{money(a.price_pence)} · +{a.duration_min} min · {w.addon_links.filter((l) => l.addon_id === a.id).length} services
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </section>
      {selected && (selected === "new" || selectedService) && (
        <ServiceEditor
          key={selected === born ? "new" : selected}
          w={w}
          api={api}
          service={selectedService}
          onClose={() => setSelected(null)}
          onSaved={async (id) => {
            // A failed re-read is surfaced by the workspace shell (Retry workspace); the write itself
            // succeeded, so keep the editor mounted and select the saved record once data arrives.
            if (id && selected === "new") setBorn(id);
            try {
              const latest = await refresh();
              if (id) setSelected(id);
              return latest;
            } catch {
              if (id) pendingSelect.current = id;
              return undefined;
            }
          }}
        />
      )}
    </div>
  );
}
const serviceForm = (service: Service | null, fallbackCategory: string) => ({
  name: service?.name || "",
  category: service?.category || fallbackCategory,
  description: service?.description || "",
  duration_min: service?.duration_min ?? 30,
  price_pence: service?.price_pence ?? 2800,
  colour: service?.colour || "sage",
  online_bookable: service ? service.online_bookable : 1,
  popular: service?.popular ?? 0,
  active: service ? service.active : 1,
  sort_order: service?.sort_order ?? 0,
});
function ServiceEditor({ w, api, service, onClose, onSaved }: { w: WorkspaceData; api: Api; service: Service | null; onClose: () => void; onSaved: (id?: string) => Promise<WorkspaceData | undefined> }) {
  const [tab, setTabRaw] = useState<"details" | "barbers" | "addons">("details");
  const { guarded, notice } = useLeaveGuard("service-editor");
  const setTab = (t: typeof tab) => guarded(() => setTabRaw(t))();
  const [form, setForm] = useState(() => serviceForm(service, w.services[0]?.category ?? "Hair"));
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<LineState>(null);
  const categories = [...new Set(w.services.map((s) => s.category))];
  const offering = service ? w.staff.filter((b) => b.active && !w.service_rules.some((r) => r.staff_id === b.id && r.service_id === service.id && !r.enabled)) : [];
  const priceRange = service
    ? w.service_rules.filter((r) => r.service_id === service.id && r.enabled && r.price_pence !== null).map((r) => r.price_pence as number)
    : [];
  const linkedAddons = service ? w.addons.filter((a) => w.addon_links.some((l) => l.addon_id === a.id && l.service_id === service.id)) : [];
  const dirty = service
    ? JSON.stringify(form) !==
      JSON.stringify({
        name: service.name,
        category: service.category,
        description: service.description,
        duration_min: service.duration_min,
        price_pence: service.price_pence,
        colour: service.colour,
        online_bookable: service.online_bookable,
        popular: service.popular,
        active: service.active,
        sort_order: service.sort_order,
      })
    : true;
  return (
    <section id="service-editor" className="workspace-panel studio-detail" aria-labelledby="service-editor-heading" data-testid="service-editor">
      <button type="button" className="panel-inline customer-back" onClick={guarded(onClose)}>
        <Icon name="left" size={14} /> All services
      </button>
      {notice}
      <header className="studio-detail-head">
        <span className={`service-swatch ${form.colour}`} aria-hidden="true">
          <Icon name="scissors" size={20} />
        </span>
        <div>
          <h2 id="service-editor-heading">{service ? service.name : "New service"}</h2>
          {service && (
            <p className="workspace-footnote">
              {offering.length} of {w.staff.filter((b) => b.active).length} barbers · {priceRange.length ? `${money(Math.min(service.price_pence, ...priceRange))}–${money(Math.max(service.price_pence, ...priceRange))}` : money(service.price_pence)} · {linkedAddons.length} add-on{linkedAddons.length === 1 ? "" : "s"}
            </p>
          )}
        </div>
      </header>
      {service && (
        <div className="segmented" aria-label="Service sections">
          <button type="button" aria-pressed={tab === "details"} onClick={() => setTab("details")}>Details</button>
          <button type="button" aria-pressed={tab === "barbers"} onClick={() => setTab("barbers")}>Barbers & pricing</button>
          <button type="button" aria-pressed={tab === "addons"} onClick={() => setTab("addons")}>Add-ons</button>
        </div>
      )}
      {tab === "details" && (
        <form
          className="studio-form"
          data-dirty={dirty && !locked ? "true" : undefined}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setState(null);
            try {
              const r = await api<{ id?: string }>(service ? `/services/${service.id}` : "/services", service ? "PUT" : "POST", {
                ...form,
                ...(service ? { version: service.version } : {}),
              });
              const latest = await onSaved(service ? service.id : r.id);
              if (!latest) setLocked(true);
              const fresh = latest?.services.find((x) => x.id === (service ? service.id : r.id));
              if (fresh) setForm(serviceForm(fresh, fresh.category));
              setState({
                kind: "ok",
                text: latest
                  ? service
                    ? "Service saved. Existing appointments keep their snapshot."
                    : "Service created."
                  : `${service ? "Service saved" : "Service created"}, but the updated list could not load. Use Retry workspace above; do not save it again.`,
              });
            } catch (err) {
              setState({ kind: "error", text: err instanceof Error ? err.message : "Could not save.", conflict: isConflict(err) });
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="workspace-form-grid">
            <label className="workspace-field">
              <span>Service name</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={100} />
            </label>
            <label className="workspace-field">
              <span>Category</span>
              <input list="service-categories" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} required minLength={2} maxLength={40} />
              <datalist id="service-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
          </div>
          <label className="workspace-field">
            <span>Description (shown to customers online)</span>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={400} rows={3} placeholder="What's included, who it suits, finish." />
          </label>
          <div className="workspace-form-grid three">
            <label className="workspace-field">
              <span>Duration (minutes)</span>
              <input type="number" min={5} max={240} step={5} required value={form.duration_min} onChange={(e) => setForm({ ...form, duration_min: Number(e.target.value) })} />
            </label>
            <label className="workspace-field">
              <span>Price (£)</span>
              <input type="number" min={0} max={1000} step="0.01" required value={(form.price_pence / 100).toString()} onChange={(e) => setForm({ ...form, price_pence: Math.round(Number(e.target.value) * 100) })} />
            </label>
            <label className="workspace-field">
              <span>Order in category</span>
              <input type="number" min={0} max={999} value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} />
            </label>
          </div>
          <ColourPicker label="Calendar colour" value={form.colour} onChange={(colour) => setForm({ ...form, colour })} />
          <div className="studio-switches">
            <div className="switch-row">
              <span>
                <strong>Bookable online</strong>
                <small>Off keeps it for walk-ins and owner bookings only.</small>
              </span>
              <label className="switch"><input type="checkbox" checked={!!form.online_bookable} onChange={(e) => setForm({ ...form, online_bookable: e.target.checked ? 1 : 0 })} aria-label="Bookable online" /><span /></label>
            </div>
            <div className="switch-row">
              <span>
                <strong>Mark as popular</strong>
                <small>Highlighted at the top of the online menu.</small>
              </span>
              <label className="switch"><input type="checkbox" checked={!!form.popular} onChange={(e) => setForm({ ...form, popular: e.target.checked ? 1 : 0 })} aria-label="Popular" /><span /></label>
            </div>
            <div className="switch-row">
              <span>
                <strong>Active</strong>
                <small>Inactive services cannot be booked; history is kept.</small>
              </span>
              <label className="switch"><input type="checkbox" checked={!!form.active} onChange={(e) => setForm({ ...form, active: e.target.checked ? 1 : 0 })} aria-label="Active" /><span /></label>
            </div>
          </div>
          <div className="panel-actions-row">
            <Button type="submit" disabled={busy || locked || !dirty}>{busy ? "Saving…" : service ? "Save service" : "Create service"}</Button>
          </div>
          <StatusLine
            state={state}
            onDiscard={async () => {
              const latest = await onSaved(service?.id);
              const fresh = (service && latest?.services.find((x) => x.id === service.id)) || service;
              setForm(serviceForm(fresh, w.services[0]?.category ?? "Hair"));
              setState(null);
            }}
          />
          <p className="workspace-footnote">Changing price or duration affects new quotes only. Buffer stays the shop-wide 10 minutes.</p>
        </form>
      )}
      {tab === "barbers" && service && <RuleMatrix w={w} api={api} service={service} onSaved={() => onSaved(service.id)} />}
      {tab === "addons" && service && (
        <div className="studio-addon-list">
          {linkedAddons.length === 0 && <p className="workspace-footnote">No add-ons offered with this service yet. Edit an add-on and tick this service.</p>}
          <ul>
            {linkedAddons.map((a) => (
              <li key={a.id}>
                <strong>{a.name}</strong> <small>+{money(a.price_pence)} · +{a.duration_min} min</small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------- Barber studio ----------
export function BarberStudio({
  w,
  api,
  refresh,
  onHours,
  onDaysOff,
  onOverrides,
  onOpenBooking,
  canEdit,
  initialSelected = null,
}: {
  w: WorkspaceData;
  api: Api;
  refresh: () => Promise<WorkspaceData>;
  onHours: (s: Staff) => void;
  onDaysOff: (s: Staff) => void;
  onOverrides: (s: Staff) => void;
  onOpenBooking: (b: StoredBooking) => void;
  canEdit: boolean;
  initialSelected?: string | null;
}) {
  const [selected, setSelected] = useState<string | "new" | null>(initialSelected);
  useEffect(() => {
    if (initialSelected) setSelected(initialSelected);
  }, [initialSelected]);
  const pendingSelect = useRef<string | null>(null);
  // The record created from the "new" editor keeps that editor instance so its confirmation stays visible.
  const [born, setBorn] = useState<string | null>(null);
  useEffect(() => {
    const id = pendingSelect.current;
    if (id && w.staff.some((s) => s.id === id)) {
      pendingSelect.current = null;
      setSelected(id);
    }
  }, [w.staff]);
  const [showInactive, setShowInactive] = useState(false);
  const [query, setQuery] = useState("");
  const staff = [...w.staff]
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    .filter((s) => showInactive || s.active)
    .filter((s) => !query || `${s.name} ${s.title} ${s.role} ${s.skills}`.toLowerCase().includes(query.toLowerCase()));
  const weekLoad = (s: Staff) => {
    const mine = w.bookings.filter((b) => b.staff_id === s.id && !["CANCELLED", "NO_SHOW"].includes(b.status));
    return mine.length;
  };
  const nextVisit = (s: Staff) =>
    w.bookings.filter((b) => b.staff_id === s.id && b.start_at > w.now && ["CONFIRMED", "CHECKED_IN"].includes(b.status)).sort((a, b) => a.start_at - b.start_at)[0];
  const selectedStaff = selected && selected !== "new" ? w.staff.find((s) => s.id === selected) || null : null;
  return (
    <div className={`studio ${selected ? "has-detail" : ""}`}>
      <section className="workspace-panel studio-list" aria-labelledby="team-heading">
        <div className="workspace-section-heading">
          <div>
            <h2 id="team-heading">Team</h2>
            <p className="workspace-footnote">{w.staff.filter((s) => s.active).length} active barbers · profiles, hours and pricing</p>
          </div>
          {canEdit && (
            <Button onClick={() => setSelected("new")}>
              <Icon name="plus" size={16} /> Add barber
            </Button>
          )}
        </div>
        <div className="customers-toolbar">
          <label className="customers-search">
            <Icon name="search" size={16} />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search team" aria-label="Search team" />
          </label>
          <label className="studio-toggle">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
          </label>
        </div>
        {staff.length === 0 && <p className="workspace-footnote">No barbers match.</p>}
        <ul className="team-cards">
          {staff.map((s) => {
            const next = nextVisit(s);
            const skills = JSON.parse(s.skills || "[]") as string[];
            return (
              <li key={s.id}>
                <button type="button" data-testid="team-card" className={`team-card ${selected === s.id ? "selected" : ""} ${s.active ? "" : "inactive"}`} onClick={() => setSelected(s.id)} aria-current={selected === s.id ? "true" : undefined}>
                  {s.photo_url ? <img className={`team-photo ${s.colour}`} src={s.photo_url} alt="" /> : <Avatar initials={initials(s.name)} colour={s.colour} size="large" />}
                  <span className="team-card-main">
                    <strong>{s.name}</strong>
                    <small>{s.title || s.role}</small>
                    {skills.length > 0 && (
                      <span className="panel-tags">
                        {skills.slice(0, 3).map((k) => (
                          <span className="tag" key={k}>{k}</span>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="team-card-side">
                    {!s.active && <span className="tag warn">Inactive</span>}
                    {s.active && !s.online_visible && <span className="tag">Hidden online</span>}
                    <small>{weekLoad(s)} today</small>
                    <small>{next ? `next ${time(next.start_min)}` : "no upcoming"}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      {selected && (selected === "new" || selectedStaff) && (
        <BarberEditor
          key={selected === born ? "new" : selected}
          w={w}
          api={api}
          staff={selectedStaff}
          canEdit={canEdit}
          onClose={() => setSelected(null)}
          onSaved={async (id) => {
            // A failed re-read is surfaced by the workspace shell (Retry workspace); the write itself
            // succeeded, so keep the editor mounted and select the saved record once data arrives.
            if (id && selected === "new") setBorn(id);
            try {
              const latest = await refresh();
              if (id) setSelected(id);
              return latest;
            } catch {
              if (id) pendingSelect.current = id;
              return undefined;
            }
          }}
          onHours={onHours}
          onDaysOff={onDaysOff}
          onOverrides={onOverrides}
          onOpenBooking={onOpenBooking}
        />
      )}
    </div>
  );
}
const staffForm = (staff: Staff | null) => ({
  name: staff?.name || "",
  role: staff?.role || "Barber",
  title: staff?.title || "",
  bio: staff?.bio || "",
  colour: staff?.colour || "sage",
  photo_url: staff?.photo_url || "",
  online_visible: staff ? staff.online_visible : 1,
  skills: staff ? (JSON.parse(staff.skills || "[]") as string[]) : [],
  instagram: staff?.instagram || "",
  start_date: staff?.start_date || "",
  active: staff ? staff.active : 1,
  sort_order: staff?.sort_order ?? 0,
  ...payFormOf(staff),
});
type Perf = { barbers: { staff_id: string; n: number; minutes: number; completed_value: number; no_shows: number }[]; from: string; to: string };
function BarberEditor({
  w,
  api,
  staff,
  canEdit,
  onClose,
  onSaved,
  onHours,
  onDaysOff,
  onOverrides,
  onOpenBooking,
}: {
  w: WorkspaceData;
  api: Api;
  staff: Staff | null;
  canEdit: boolean;
  onClose: () => void;
  onSaved: (id?: string) => Promise<WorkspaceData | undefined>;
  onHours: (s: Staff) => void;
  onDaysOff: (s: Staff) => void;
  onOverrides: (s: Staff) => void;
  onOpenBooking: (b: StoredBooking) => void;
}) {
  const [tab, setTabRaw] = useState<"profile" | "schedule" | "services" | "pay" | "performance" | "upcoming">("profile");
  const [payRuns, setPayRuns] = useState<PayRun[]>([]);
  const loadPayRuns = () => api<{ pay_runs: PayRun[] }>("/pay-runs").then((r) => setPayRuns(r.pay_runs)).catch(() => {});
  useEffect(() => {
    if (tab === "pay") loadPayRuns();
  }, [tab, staff?.version]);
  const { guarded, notice } = useLeaveGuard("barber-editor");
  const setTab = (t: typeof tab) => guarded(() => setTabRaw(t))();
  const [form, setForm] = useState(() => staffForm(staff));
  const [locked, setLocked] = useState(false);
  const dirty = !locked && JSON.stringify(form) !== JSON.stringify(staffForm(staff));
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<LineState>(null);
  const [perf, setPerf] = useState<Perf | null>(null);
  const [perfDays, setPerfDays] = useState(30);
  const [upcoming, setUpcoming] = useState<StoredBooking[] | null>(null);
  useEffect(() => {
    if (tab !== "performance" || !staff) return;
    let cancelled = false;
    api<Perf>(`/insights?days=${perfDays}`).then((p) => !cancelled && setPerf(p)).catch(() => !cancelled && setPerf(null));
    return () => {
      cancelled = true;
    };
  }, [tab, perfDays, staff?.id]);
  useEffect(() => {
    if (tab !== "upcoming" || !staff) return;
    let cancelled = false;
    const to = new Date(`${w.today}T12:00:00Z`);
    to.setUTCDate(to.getUTCDate() + 14);
    api<{ bookings: StoredBooking[] }>(`/bookings/range?from=${w.today}&to=${to.toISOString().slice(0, 10)}`)
      .then((r) => !cancelled && setUpcoming(r.bookings.filter((b) => b.staff_id === staff.id && ["CONFIRMED", "CHECKED_IN", "IN_SERVICE"].includes(b.status) && b.start_at > w.now).slice(0, 12)))
      .catch(() => !cancelled && setUpcoming([]));
    return () => {
      cancelled = true;
    };
  }, [tab, staff?.id, w.now]);
  const hours = staff ? w.hours.filter((h) => h.staff_id === staff.id) : [];
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const mine = perf?.barbers.find((b) => b.staff_id === staff?.id);
  const offering = staff ? w.services.filter((s) => s.active && !w.service_rules.some((r) => r.staff_id === staff.id && r.service_id === s.id && !r.enabled)) : [];
  const regulars = staff ? new Set(w.bookings.filter((b) => b.staff_id === staff.id && b.status === "COMPLETED").map((b) => b.phone)).size : 0;
  return (
    <section id="barber-editor" className="workspace-panel studio-detail" aria-labelledby="barber-editor-heading" data-testid="barber-editor">
      <button type="button" className="panel-inline customer-back" onClick={guarded(onClose)}>
        <Icon name="left" size={14} /> All barbers
      </button>
      {notice}
      <header className="studio-detail-head barber">
        {form.photo_url ? <img className={`team-photo large ${form.colour}`} src={form.photo_url} alt="" /> : <Avatar initials={initials(form.name || "?")} colour={form.colour} size="large" />}
        <div>
          <h2 id="barber-editor-heading">{staff ? staff.name : "New barber"}</h2>
          <p className="workspace-footnote">
            {form.title || form.role}
            {staff ? ` · ${offering.length} services · ${regulars} customers served` : ""}
            {staff?.start_date ? ` · since ${staff.start_date.slice(0, 7)}` : ""}
          </p>
        </div>
      </header>
      {staff && (
        <div className="segmented" aria-label="Barber sections">
          <button type="button" aria-pressed={tab === "profile"} onClick={() => setTab("profile")}>Profile</button>
          <button type="button" aria-pressed={tab === "schedule"} onClick={() => setTab("schedule")}>Schedule</button>
          <button type="button" aria-pressed={tab === "services"} onClick={() => setTab("services")}>Services & pricing</button>
          <button type="button" aria-pressed={tab === "pay"} onClick={() => setTab("pay")}>Pay</button>
          <button type="button" aria-pressed={tab === "performance"} onClick={() => setTab("performance")}>Performance</button>
          <button type="button" aria-pressed={tab === "upcoming"} onClick={() => setTab("upcoming")}>Upcoming</button>
        </div>
      )}
      {tab === "profile" && (
        <form
          className="studio-form"
          data-dirty={dirty ? "true" : undefined}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!canEdit) return;
            setBusy(true);
            setState(null);
            try {
              const r = await api<{ id?: string }>(staff ? `/staff/${staff.id}` : "/staff", staff ? "PUT" : "POST", {
                ...form,
                ...(staff ? { version: staff.version } : {}),
              });
              const latest = await onSaved(staff ? staff.id : r.id);
              if (!latest) setLocked(true);
              // The server normalises some fields (handle prefix, trimming); mirror the saved record so the form is clean.
              const fresh = latest?.staff.find((x) => x.id === (staff ? staff.id : r.id));
              if (fresh) setForm(staffForm(fresh));
              setState({
                kind: "ok",
                text: latest
                  ? staff
                    ? "Profile saved."
                    : "Barber added with default hours from the shop."
                  : `${staff ? "Profile saved" : "Barber added"}, but the updated list could not load. Use Retry workspace above; do not save it again.`,
              });
            } catch (err) {
              setState({ kind: "error", text: err instanceof Error ? err.message : "Could not save.", conflict: isConflict(err) });
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={!canEdit} className="studio-fieldset">
            <div className="workspace-form-grid">
              <label className="workspace-field">
                <span>Full name</span>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={100} />
              </label>
              <label className="workspace-field">
                <span>Job title (shown to customers)</span>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={60} placeholder="Senior barber" />
              </label>
              <label className="workspace-field">
                <span>Role (internal)</span>
                <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} required minLength={2} maxLength={50} />
              </label>
              <label className="workspace-field">
                <span>Started</span>
                <input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
              </label>
            </div>
            <label className="workspace-field">
              <span>Bio</span>
              <textarea value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} maxLength={600} rows={4} placeholder="Specialities, experience, style — shown on the online booking page." />
            </label>
            <TagInput label="Skills" tags={form.skills} onChange={(skills) => setForm({ ...form, skills })} suggestions={["Skin fades", "Beards", "Scissor work", "Kids", "Hot towel shaves", "Afro hair", "Colour", "Long hair"]} />
            <div className="workspace-form-grid">
              <div className="workspace-field">
                <span id="barber-photo-label">Photo (upload or https URL)</span>
                <div className="photo-field">
                  <input type="text" inputMode="url" aria-labelledby="barber-photo-label" value={form.photo_url} onChange={(e) => setForm({ ...form, photo_url: e.target.value })} placeholder="https://…/photo.jpg" maxLength={500} />
                  <PhotoUpload kind="staff" label="Upload" testId="upload-staff-photo" onUploaded={([u]) => setForm({ ...form, photo_url: u })} />
                </div>
              </div>
              <label className="workspace-field">
                <span>Instagram</span>
                <input value={form.instagram} onChange={(e) => setForm({ ...form, instagram: e.target.value })} placeholder="@handle" maxLength={40} />
              </label>
            </div>
            <ColourPicker label="Calendar colour" value={form.colour} onChange={(colour) => setForm({ ...form, colour })} />
            <div className="studio-switches">
              <div className="switch-row">
                <span>
                  <strong>Show on online booking</strong>
                  <small>Hidden barbers can still be booked by the team.</small>
                </span>
                <label className="switch"><input type="checkbox" checked={!!form.online_visible} onChange={(e) => setForm({ ...form, online_visible: e.target.checked ? 1 : 0 })} aria-label="Show on online booking" /><span /></label>
              </div>
              <div className="switch-row">
                <span>
                  <strong>Active and bookable</strong>
                  <small>Deactivating keeps history and flags future visits.</small>
                </span>
                <label className="switch"><input type="checkbox" checked={!!form.active} onChange={(e) => setForm({ ...form, active: e.target.checked ? 1 : 0 })} aria-label="Active and bookable" /><span /></label>
              </div>
            </div>
            <div className="workspace-form-grid">
              <label className="workspace-field narrow">
                <span>Order on the timetable</span>
                <input type="number" min={0} max={999} value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} />
              </label>
            </div>
          </fieldset>
          {canEdit ? (
            <div className="panel-actions-row">
              <Button type="submit" disabled={busy || locked || (!!staff && !dirty)}>{busy ? "Saving…" : staff ? "Save profile" : "Create barber"}</Button>
            </div>
          ) : (
            <p className="workspace-footnote">Profiles are edited by owners and managers.</p>
          )}
          <StatusLine
            state={state}
            onDiscard={async () => {
              const latest = await onSaved(staff?.id);
              const fresh = (staff && latest?.staff.find((x) => x.id === staff.id)) || staff;
              setForm(staffForm(fresh));
              setState(null);
            }}
          />
        </form>
      )}
      {tab === "schedule" && staff && (
        <div className="studio-schedule">
          <ul className="hours-strip" aria-label="Weekly hours">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => {
              const h = hours.find((x) => x.weekday === d);
              return (
                <li key={d} className={h?.enabled ? "" : "off"}>
                  <strong>{days[d]}</strong>
                  {h?.enabled ? (
                    <>
                      <span>{time(h.starts)}–{time(h.ends)}</span>
                      {h.break_end > h.break_start && <small>break {time(h.break_start)}</small>}
                    </>
                  ) : (
                    <span>Off</span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="panel-actions-row">
            <Button variant="secondary" onClick={() => onHours(staff)}>Edit weekly hours</Button>
            <Button variant="ghost" onClick={() => onDaysOff(staff)}>Days off ({w.days_off.filter((d) => d.staff_id === staff.id && d.date >= w.today).length})</Button>
            <Button variant="ghost" onClick={() => onOverrides(staff)}>Dated hours ({w.schedule_overrides.filter((o) => o.staff_id === staff.id && o.date >= w.today).length})</Button>
          </div>
          <Notice>Hours, leave and dated shifts feed availability immediately. Existing appointments outside new hours are flagged for review, never cancelled.</Notice>
        </div>
      )}
      {tab === "services" && staff && <RuleMatrix w={w} api={api} staff={staff} onSaved={() => onSaved(staff.id)} />}
      {tab === "pay" && staff && (
        <div className="studio-pay">
          <form
            className="studio-form"
            data-dirty={dirty ? "true" : undefined}
            aria-busy={busy}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!canEdit) return;
              setBusy(true);
              setState(null);
              try {
                await api(`/staff/${staff.id}`, "PUT", { ...form, version: staff.version });
                const latest = await onSaved(staff.id);
                if (!latest) setLocked(true);
                const fresh = latest?.staff.find((x) => x.id === staff.id);
                if (fresh) setForm(staffForm(fresh));
                setState({ kind: "ok", text: latest ? "Pay terms saved. They apply to pay runs created from now on." : "Pay terms saved, but the updated list could not load. Use Retry workspace above; do not save again." });
              } catch (err) {
                setState({ kind: "error", text: err instanceof Error ? err.message : "Could not save.", conflict: isConflict(err) });
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="workspace-section-heading compact">
              <div>
                <h3>Pay terms</h3>
                <p className="workspace-footnote">How {staff.name.split(" ")[0]} is paid. Existing pay runs keep the terms they were calculated with.</p>
              </div>
            </div>
            <PayTermsForm form={form as PayForm} setForm={(f) => setForm({ ...form, ...f })} disabled={!canEdit} />
            {canEdit && (
              <div className="panel-actions-row">
                <Button type="submit" disabled={busy || locked || !dirty} data-testid="save-pay-terms">{busy ? "Saving…" : "Save pay terms"}</Button>
              </div>
            )}
            <StatusLine state={state} />
          </form>
          <section className="workspace-section-heading compact">
            <div>
              <h3>Pay runs</h3>
              <p className="workspace-footnote">Settle a period from the payments ledger: draft → approve → mark paid. Paid runs are frozen.</p>
            </div>
          </section>
          <PayRuns w={w} api={api} staff={staff} canEdit={canEdit} runs={payRuns} onChanged={loadPayRuns} />
        </div>
      )}
      {tab === "performance" && staff && (
        <div className="studio-performance">
          <div className="segmented" aria-label="Period">
            {[30, 90, 365].map((n) => (
              <button type="button" key={n} aria-pressed={perfDays === n} onClick={() => setPerfDays(n)}>{n === 365 ? "Year" : `${n}d`}</button>
            ))}
          </div>
          {perf && (
            <div className="stats-grid customer-stat-grid">
              <article className="stat-card"><div className="stat-label">Visits <Icon name="calendarCheck" /></div><div className="stat-value">{mine?.n ?? 0}</div><div className="stat-foot">{perf.from} to {perf.to}</div></article>
              <article className="stat-card"><div className="stat-label">Chair hours <Icon name="clock" /></div><div className="stat-value">{((mine?.minutes ?? 0) / 60).toFixed(1)}</div><div className="stat-foot">booked minutes / 60</div></article>
              <article className="stat-card"><div className="stat-label">Completed value <Icon name="wallet" /></div><div className="stat-value">{money(mine?.completed_value ?? 0)}</div><div className="stat-foot">booked price, not payments</div></article>
              <article className="stat-card"><div className="stat-label">No-show rate <Icon name="user" /></div><div className="stat-value">{mine?.n ? `${Math.round(((mine.no_shows ?? 0) / mine.n) * 100)}%` : "—"}</div><div className="stat-foot">{mine?.no_shows ?? 0} no-shows</div></article>
            </div>
          )}
          {!perf && <p className="workspace-footnote">Loading…</p>}
        </div>
      )}
      {tab === "upcoming" && staff && (
        <ol className="customer-history" aria-label="Upcoming appointments">
          {upcoming === null && <li className="workspace-footnote">Loading…</li>}
          {upcoming?.length === 0 && <li className="workspace-footnote">Nothing booked in the next 14 days.</li>}
          {upcoming?.map((b) => (
            <li key={b.id}>
              <button type="button" onClick={() => onOpenBooking(b)}>
                <span className="history-date"><strong>{b.date.slice(8)}</strong><small>{new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(new Date(b.date + "T12:00:00Z"))}</small></span>
                <span className="history-main"><strong>{b.customer_name}</strong><small>{time(b.start_min)} · {b.service_name}</small></span>
                <span className="history-side"><Badge tone="confirmed">{b.status === "CONFIRMED" ? "Confirmed" : b.status.replace("_", " ").toLowerCase()}</Badge><strong>{money(b.price_pence)}</strong></span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
export function StudioNotice({ children }: { children: ReactNode }) {
  return <Notice>{children}</Notice>;
}
