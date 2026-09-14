import {
  useEffect,
  useId,
  cloneElement,
  isValidElement,
  type ReactElement,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  Addon,
  ScheduleOverride,
  BookingItem,
  WorkspaceData,
  Staff,
  Service,
  Hours,
  StoredBooking,
  Holiday,
  StaffDayOff,
} from "../server/domain";
import { Brand, Button, Icon, Modal, Notice, Badge } from "./ui";
import { money, time, datePlus } from "./fixtures";

const reference = (b: StoredBooking) =>
  `BRB-${String(b.sequence).padStart(4, "0")}`;
const days = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const labels: Record<string, string> = {
  CONFIRMED: "Confirmed",
  CHECKED_IN: "Checked in",
  IN_SERVICE: "In service",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No-show",
};
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (!navigator.onLine)
    throw new ApiError(
      "You are offline. Reconnect and retry; changes are not queued.",
      0,
    );
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/sandbox${path}`, {
      method,
      credentials: "same-origin",
      signal: controller.signal,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new ApiError(
        "The local server returned an unexpected response. Check the connection and retry without reloading the page.",
        response.status,
      );
    }
    const result = await response.json();
    if (!response.ok) {
      const friendly: Record<string, string> = {
        record_changed:
          "This record changed in another view. Discard edits and load the latest record before trying again.",
        addon_unavailable:
          "An add-on is no longer available for this service. Remove it or refresh the workspace, then review again.",
        service_ineligible:
          "This barber does not offer the selected service. Choose another service or barber.",
        quote_changed:
          "The service or shop policy changed. Review the refreshed price and time before confirming again.",
        slot_taken:
          "That time was just booked. Choose another available time; your customer details have been kept.",
        session_required:
          "This browser’s test session is missing or expired. Close this dialog and refresh workspace access.",
      };
      throw new ApiError(
        friendly[result.error] ||
          result.message ||
          "Request failed. Retry without reloading the page.",
        response.status,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      method === "GET"
        ? "Unable to reach the local workspace. Check your connection and retry; no page reload is needed."
        : "The save response was interrupted. Your entries are kept. For a booking, retry the unchanged form safely; for other records, refresh the workspace to check whether it saved before retrying.",
      0,
    );
  } finally {
    window.clearTimeout(timeout);
  }
}
const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const number = (f: FormData, k: string) => Number(text(f, k));
const minute = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
const clock = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
function Field({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <label className="workspace-field">
      <span id={labelId}>{label}</span>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            "aria-labelledby": labelId,
          })
        : children}
    </label>
  );
}
function ErrorMessage({ error }: { error: string }) {
  return error ? (
    <p className="workspace-error" role="alert">
      {error.replaceAll("_", " ")}
    </p>
  ) : null;
}
function SaveForm({
  children,
  onSave,
  label = "Save changes",
}: {
  children: ReactNode;
  onSave: (data: FormData) => Promise<void>;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (lock.current) return;
    const f = new FormData(e.currentTarget);
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave(f);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Unable to save. Check your connection and retry.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form className="workspace-form" onSubmit={submit}>
      <fieldset disabled={busy}>
        {children}
        <ErrorMessage error={error} />
        <div className="workspace-save-actions">
          <Button type="submit">{busy ? "Saving…" : label}</Button>
        </div>
      </fieldset>
    </form>
  );
}
type Editor =
  | { kind: "staff"; item?: Staff }
  | { kind: "service"; item?: Service }
  | { kind: "addon"; item?: Addon }
  | { kind: "serviceRules"; item: Staff }
  | { kind: "overrides"; item: Staff }
  | { kind: "override"; item: Staff; override?: ScheduleOverride }
  | { kind: "removeOverride"; item: ScheduleOverride }
  | { kind: "hours"; item: Staff }
  | { kind: "daysOff"; item: Staff }
  | { kind: "removeDayOff"; item: StaffDayOff }
  | { kind: "booking"; item?: StoredBooking }
  | { kind: "detail"; item: StoredBooking }
  | { kind: "contacts"; item: StoredBooking }
  | { kind: "holiday" }
  | { kind: "removeHoliday"; item: Holiday };

export function Workspace() {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [needsSession, setNeedsSession] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState("Appointments");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const [date, setDate] = useState("");
  const [search, setSearch] = useState("");
  const [barber, setBarber] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [directorySearch, setDirectorySearch] = useState("");
  const [directoryStatus, setDirectoryStatus] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const loadSequence = useRef(0);
  async function refresh() {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const w = await api<WorkspaceData>("/workspace");
      if (sequence === loadSequence.current) {
        setData(w);
        setNeedsSession(false);
        setError("");
        setStale(false);
        setDate((d) => d || w.today);
      }
      return w;
    } catch (e) {
      if (sequence === loadSequence.current) {
        if (e instanceof ApiError && e.status === 401) {
          setData(null);
          setEditor(null);
          setNeedsSession(true);
          setError("");
          setNotice(
            "No active browser session. Existing test records have not been deleted; creating a workspace starts a separate shop.",
          );
        } else {
          setError(
            e instanceof Error
              ? e.message
              : "Could not load the workspace. Retry below.",
          );
          setStale(true);
        }
      }
      throw e;
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    refresh().catch(() => {});
    const reconnect = () => {
      setOnline(true);
      refresh().catch(() => {});
    };
    const disconnect = () => {
      setOnline(false);
      setStale(true);
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("offline", disconnect);
    return () => {
      ++loadSequence.current;
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", disconnect);
    };
  }, []);
  async function saved(path: string, method: string, body?: unknown) {
    if (stale)
      throw new ApiError(
        "The workspace needs a fresh read before saving. Close this dialog and use Retry workspace; no page reload is needed.",
        409,
      );
    await api(path, method, body);
    setEditor(null);
    setNotice("Saved to your local test database.");
    try {
      await refresh();
    } catch {
      setError(
        "Saved successfully, but the updated view could not load. Use Retry workspace below; do not repeat the saved action.",
      );
    }
  }
  async function reloadEditor() {
    const current = editor;
    const latest = await refresh();
    if (!current || !("item" in current) || !current.item) return;
    const itemId = current.item.id;
    let replacement: Editor | null = null;
    if (
      current.kind === "staff" ||
      current.kind === "hours" ||
      current.kind === "daysOff" ||
      current.kind === "serviceRules" ||
      current.kind === "overrides" ||
      current.kind === "override"
    ) {
      const item = latest.staff.find((s) => s.id === itemId);
      if (item)
        replacement =
          current.kind === "override"
            ? {
                ...current,
                item,
                override: latest.schedule_overrides.find(
                  (o) => o.id === current.override?.id,
                ),
              }
            : { ...current, item };
    } else if (current.kind === "addon") {
      const item = latest.addons.find((a) => a.id === itemId);
      if (item) replacement = { ...current, item };
    } else if (current.kind === "service") {
      const item = latest.services.find((s) => s.id === itemId);
      if (item) replacement = { ...current, item };
    } else if (["booking", "detail", "contacts"].includes(current.kind)) {
      const result = await api<{ booking: StoredBooking }>(
        `/bookings/${itemId}`,
      );
      replacement = {
        kind: current.kind as "booking" | "detail" | "contacts",
        item: result.booking,
      };
    }
    if (replacement) {
      setEditor(replacement);
      setEditorRevision((n) => n + 1);
    }
  }
  const w = data;
  const visibleStaff =
    w?.staff.filter(
      (s) =>
        (!directoryStatus || String(s.active) === directoryStatus) &&
        `${s.name} ${s.role}`
          .toLowerCase()
          .includes(directorySearch.toLowerCase()),
    ) || [];
  const visibleServices =
    w?.services.filter(
      (s) =>
        (!directoryStatus || String(s.active) === directoryStatus) &&
        `${s.name} ${s.category}`
          .toLowerCase()
          .includes(directorySearch.toLowerCase()),
    ) || [];
  const directoryFilters = (
    <section className="workspace-toolbar" aria-label="Directory filters">
      <Field label={tab === "Team" ? "Search team" : "Search catalogue"}>
        <input
          value={directorySearch}
          onChange={(e) => setDirectorySearch(e.target.value)}
          placeholder="Name or category / role"
        />
      </Field>
      <Field label="Directory status">
        <select
          value={directoryStatus}
          onChange={(e) => setDirectoryStatus(e.target.value)}
        >
          <option value="">Active and inactive</option>
          <option value="1">Active only</option>
          <option value="0">Inactive only</option>
        </select>
      </Field>
      <Button
        variant="ghost"
        onClick={() => {
          setDirectorySearch("");
          setDirectoryStatus("");
        }}
      >
        Clear filters
      </Button>
    </section>
  );
  return (
    <div className="workspace">
      <a className="skip-link" href="#workspace-main">
        Skip to content
      </a>
      <header className="workspace-banner">
        <span>
          <strong>LOCAL TEST WORKSPACE</strong> · Fictional data only
        </span>
        <span>No live payments or messages</span>
      </header>
      <div className="workspace-layout">
        <aside className="workspace-sidebar">
          <Brand />
          <p className="workspace-shop">
            {w?.shop.name || "Build better days."}
          </p>
          <nav aria-label="Workspace sections">
            {["Appointments", "Team", "Services", "Settings", "Audit"].map(
              (name, i) => (
                <button
                  key={name}
                  type="button"
                  aria-current={tab === name ? "page" : undefined}
                  onClick={() => {
                    setTab(name);
                    setNotice("");
                    setDirectorySearch("");
                    setDirectoryStatus("");
                  }}
                >
                  <Icon
                    name={
                      ["calendar", "users", "scissors", "settings", "shield"][i]
                    }
                  />
                  {name}
                </button>
              ),
            )}
          </nav>
          <p className="workspace-footnote">
            Development access belongs to this browser for 7 days. This is not
            production sign-in.
          </p>
          <a href="/preview/admin">Original design previews</a>
        </aside>
        <main id="workspace-main" className="workspace-main">
          <header className="workspace-heading">
            <div>
              <p className="eyebrow">BARBERSHOP OS / LOCAL DEVELOPMENT</p>
              <h1>{tab}</h1>
              <p>Same calm workspace. Now with saved test records.</p>
            </div>
            <Button
              variant="secondary"
              disabled={loading || !online}
              onClick={() =>
                refresh()
                  .then(() => setNotice("View refreshed."))
                  .catch(() => {})
              }
            >
              <Icon name="refresh" />
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </header>
          {!online && (
            <Notice tone="warning" icon="offline">
              Offline: this view may be stale. Changes are not queued or saved
              offline. Reconnect and refresh before continuing.
            </Notice>
          )}
          <ErrorMessage error={error} />
          {error && (
            <Button
              variant="secondary"
              disabled={loading || !online}
              onClick={() => refresh().catch(() => {})}
            >
              {loading ? "Retrying…" : "Retry workspace"}
            </Button>
          )}
          {notice && (
            <p className="workspace-success" role="status">
              {notice}
            </p>
          )}
          {needsSession && !w && (
            <section className="workspace-panel workspace-welcome">
              <Icon name="store" size={40} />
              <h2>Start your test shop</h2>
              <p>
                Create an isolated local database workspace with two example
                barbers and three editable services. Bookings start empty. Use
                fictional names and numbers only.
              </p>
              <SaveForm
                label="Create test workspace"
                onSave={async (f) => {
                  await api("/session", "POST", { name: text(f, "name") });
                  await refresh();
                }}
              >
                <Field label="Test shop name">
                  <input
                    name="name"
                    required
                    minLength={2}
                    maxLength={100}
                    defaultValue="The Matte Barbershop"
                  />
                </Field>
              </SaveForm>
              <p>
                Keep this browser’s cookies to return to your saved test data.
                No production account, subscription or payment is created.
              </p>
            </section>
          )}
          {!w && !needsSession && !error && (
            <p role="status">Loading local workspace…</p>
          )}
          {w && (
            <>
              {w.issues.length > 0 && (
                <Notice tone="warning">
                  <strong>
                    {w.issues.length} appointment(s) need schedule review.
                  </strong>
                  {w.issues.map((issue) => (
                    <p key={issue.booking_id}>
                      {issue.ref}: {issue.reason}.{" "}
                      <button
                        className="workspace-text-button"
                        onClick={() =>
                          setEditor({
                            kind: "detail",
                            item: w.bookings.find(
                              (b) => b.id === issue.booking_id,
                            )!,
                          })
                        }
                      >
                        Review appointment
                      </button>
                    </p>
                  ))}
                </Notice>
              )}
              {tab === "Appointments" && (
                <>
                  <section className="workspace-toolbar">
                    <Field label="Appointment date">
                      <input
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                      />
                    </Field>
                    <Field label="Barber filter">
                      <select
                        value={barber}
                        onChange={(e) => setBarber(e.target.value)}
                      >
                        <option value="">All barbers</option>
                        {w.staff.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Status filter">
                      <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                      >
                        <option value="">All statuses</option>
                        {Object.entries(labels).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Search appointments">
                      <input
                        placeholder="Name, phone or reference"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </Field>
                    <Button
                      disabled={!online || stale || loading}
                      onClick={() => setEditor({ kind: "booking" })}
                    >
                      <Icon name="plus" />
                      New booking
                    </Button>
                  </section>
                  <div className="workspace-day">
                    <Button
                      variant="ghost"
                      aria-label="Previous day"
                      onClick={() => setDate(datePlus(date || w.today, -1))}
                    >
                      <Icon name="left" />
                    </Button>
                    <strong>
                      {date
                        ? new Intl.DateTimeFormat("en-GB", {
                            dateStyle: "full",
                          }).format(new Date(date + "T12:00:00Z"))
                        : "Choose a date"}
                    </strong>
                    <Button
                      variant="ghost"
                      aria-label="Next day"
                      onClick={() => setDate(datePlus(date || w.today, 1))}
                    >
                      <Icon name="right" />
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setDate(w.today)}
                    >
                      Today
                    </Button>
                  </div>
                  <section className="workspace-panel">
                    <BookingList
                      bookings={w.bookings
                        .filter(
                          (b) =>
                            b.date === date &&
                            (!barber || b.staff_id === barber) &&
                            (!statusFilter || b.status === statusFilter) &&
                            `${b.customer_name} ${b.phone} ${reference(b)}`
                              .toLowerCase()
                              .includes(search.toLowerCase()),
                        )
                        .sort((a, b) => a.start_at - b.start_at)}
                      w={w}
                      onOpen={(item) => setEditor({ kind: "detail", item })}
                    />
                    <p className="workspace-footnote">
                      Showing saved appointments for this day (latest 500
                      records loaded). Service status is separate from payment.
                      No deposits collected.
                    </p>
                  </section>
                </>
              )}
              {tab === "Team" && (
                <>
                  <div className="workspace-section-heading">
                    <h2>Your team</h2>
                    <Button onClick={() => setEditor({ kind: "staff" })}>
                      <Icon name="plus" />
                      Add barber
                    </Button>
                  </div>
                  {directoryFilters}
                  <p className="workspace-footnote">
                    {visibleStaff.length} of {w.staff.length} staff profiles.
                    Inactive profiles keep their appointment history.
                  </p>
                  {visibleStaff.length === 0 && (
                    <p>
                      No matching team members. Clear filters or add a barber.
                    </p>
                  )}
                  <section className="workspace-card-grid">
                    {visibleStaff.map((s) => (
                      <article className="workspace-panel" key={s.id}>
                        <Badge>{s.active ? "Active" : "Inactive"}</Badge>
                        <h3>{s.name}</h3>
                        <p>{s.role}</p>
                        <div className="workspace-actions">
                          <Button
                            variant="secondary"
                            onClick={() =>
                              setEditor({ kind: "staff", item: s })
                            }
                          >
                            Edit barber
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setEditor({ kind: "hours", item: s })
                            }
                          >
                            Weekly hours
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setEditor({ kind: "daysOff", item: s })
                            }
                          >
                            Days off
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setEditor({ kind: "serviceRules", item: s })
                            }
                          >
                            Services & pricing
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setEditor({ kind: "overrides", item: s })
                            }
                          >
                            Dated hours
                          </Button>
                        </div>
                      </article>
                    ))}
                  </section>
                </>
              )}
              {tab === "Services" && (
                <>
                  <div className="workspace-section-heading">
                    <h2>Service catalogue</h2>
                    <Button onClick={() => setEditor({ kind: "service" })}>
                      <Icon name="plus" />
                      Add service
                    </Button>
                  </div>
                  {directoryFilters}
                  <p className="workspace-footnote">
                    {visibleServices.length} of {w.services.length} services.
                  </p>
                  {visibleServices.length === 0 && (
                    <p>No matching services. Clear filters or add a service.</p>
                  )}
                  <section className="workspace-card-grid">
                    {visibleServices.map((s) => (
                      <article className="workspace-panel" key={s.id}>
                        <Badge>{s.active ? "Available" : "Inactive"}</Badge>
                        <h3>{s.name}</h3>
                        <p>
                          {s.category} · {s.duration_min} minutes
                        </p>
                        <strong className="workspace-price">
                          {money(s.price_pence)}
                        </strong>
                        <Button
                          variant="secondary"
                          onClick={() =>
                            setEditor({ kind: "service", item: s })
                          }
                        >
                          Edit service
                        </Button>
                      </article>
                    ))}
                  </section>
                  <Notice>
                    Existing appointments keep their original price, service
                    name and duration when the catalogue changes.
                  </Notice>
                  <section className="workspace-addon-catalogue">
                    <div className="workspace-section-heading">
                      <h2>Add-ons</h2>
                      <Button onClick={() => setEditor({ kind: "addon" })}>
                        Add add-on
                      </Button>
                    </div>
                    <p>
                      Optional items add their own price and exact duration.
                      Choose which services offer each add-on.
                    </p>
                    {!w.addons.length && <p>No saved add-ons yet.</p>}
                    <div className="workspace-card-grid">
                      {w.addons.map((a) => (
                        <article className="workspace-panel" key={a.id}>
                          <Badge>{a.active ? "Available" : "Inactive"}</Badge>
                          <h3>{a.name}</h3>
                          <p>
                            {money(a.price_pence)} · +{a.duration_min} minutes
                          </p>
                          <p>
                            {w.addon_links
                              .filter((l) => l.addon_id === a.id)
                              .map(
                                (l) =>
                                  w.services.find((s) => s.id === l.service_id)
                                    ?.name,
                              )
                              .join(", ")}
                          </p>
                          <Button
                            variant="secondary"
                            onClick={() =>
                              setEditor({ kind: "addon", item: a })
                            }
                          >
                            Edit add-on
                          </Button>
                        </article>
                      ))}
                    </div>
                  </section>
                </>
              )}
              {tab === "Settings" && (
                <div className="workspace-settings">
                  <section className="workspace-panel">
                    <h2>Shop settings</h2>
                    <SaveForm
                      key={w.shop.version}
                      onSave={(f) =>
                        saved("/shop", "PUT", {
                          name: text(f, "name"),
                          address: text(f, "address"),
                          timezone: "Europe/London",
                          opens: minute(text(f, "opens")),
                          closes: minute(text(f, "closes")),
                          closed_days: f.getAll("closed_days").map(Number),
                          deposit_pence: Math.round(number(f, "deposit") * 100),
                          cancel_hours: number(f, "cancel_hours"),
                          no_show_grace: number(f, "no_show_grace"),
                          version: w.shop.version,
                        })
                      }
                    >
                      <Field label="Shop name">
                        <input
                          name="name"
                          required
                          minLength={2}
                          maxLength={100}
                          defaultValue={w.shop.name}
                        />
                      </Field>
                      <Field label="Address">
                        <textarea
                          name="address"
                          maxLength={200}
                          defaultValue={w.shop.address}
                        />
                      </Field>
                      <p>
                        Timezone: Europe/London. Scheduling includes a 10-minute
                        buffer.
                      </p>
                      <div className="workspace-form-grid">
                        <Field label="Shop opens">
                          <input
                            type="time"
                            name="opens"
                            required
                            defaultValue={clock(w.shop.opens)}
                          />
                        </Field>
                        <Field label="Shop closes">
                          <input
                            type="time"
                            name="closes"
                            required
                            defaultValue={clock(w.shop.closes)}
                          />
                        </Field>
                      </div>
                      <fieldset className="workspace-checks">
                        <legend>Closed weekdays</legend>
                        {days.map((day, i) => (
                          <label key={day}>
                            <input
                              type="checkbox"
                              name="closed_days"
                              value={i}
                              defaultChecked={JSON.parse(
                                w.shop.closed_days,
                              ).includes(i)}
                            />
                            {day}
                          </label>
                        ))}
                      </fieldset>
                      <Field label="Test deposit policy (£) — not collected">
                        <input
                          type="number"
                          name="deposit"
                          min={0}
                          max={100}
                          step="0.01"
                          required
                          defaultValue={w.shop.deposit_pence / 100}
                        />
                      </Field>
                      <Field label="Cancellation policy hours">
                        <input
                          type="number"
                          name="cancel_hours"
                          min={0}
                          max={168}
                          required
                          defaultValue={w.shop.cancel_hours}
                        />
                      </Field>
                      <Field label="No-show grace minutes">
                        <input
                          type="number"
                          name="no_show_grace"
                          min={0}
                          max={120}
                          required
                          defaultValue={w.shop.no_show_grace}
                        />
                      </Field>
                    </SaveForm>
                  </section>
                  <section className="workspace-panel">
                    <div className="workspace-section-heading">
                      <h2>Shop closures</h2>
                      <Button
                        variant="secondary"
                        onClick={() => setEditor({ kind: "holiday" })}
                      >
                        Add closure
                      </Button>
                    </div>
                    {w.holidays.length === 0 && <p>No dated closures.</p>}
                    {w.holidays.map((h) => (
                      <article className="workspace-closure" key={h.id}>
                        <strong>{h.date}</strong>
                        <p>{h.label}</p>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setEditor({ kind: "removeHoliday", item: h })
                          }
                        >
                          Remove closure
                        </Button>
                      </article>
                    ))}
                    <Notice>
                      Changes do not silently cancel existing appointments.
                      Affected future appointments are flagged for review.
                    </Notice>
                  </section>
                </div>
              )}
              {tab === "Audit" && (
                <section className="workspace-panel">
                  <h2>Recorded activity</h2>
                  <p>
                    Latest 200 events. Append-only database history, attributed
                    to this browser’s test session. No external payments or
                    messages are implied.
                  </p>
                  <ol className="workspace-audit">
                    {w.audit.map((a) => (
                      <li key={a.id}>
                        <strong>{a.action.replaceAll("_", " ")}</strong>
                        <time>
                          {new Date(a.created_at).toLocaleString("en-GB")}
                        </time>
                        <p>{a.reason || a.entity_type}</p>
                        <small>{a.actor}</small>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </>
          )}
        </main>
      </div>
      {w && editor && (
        <WorkspaceEditor
          key={
            editor.kind +
            ("item" in editor ? editor.item?.id || "" : "") +
            editorRevision
          }
          editor={editor}
          w={w}
          date={date || w.today}
          onClose={() => setEditor(null)}
          saved={saved}
          onMove={(item) => setEditor({ kind: "booking", item })}
          onEdit={(item) => setEditor({ kind: "contacts", item })}
          reloadEditor={reloadEditor}
          onRemoveDayOff={(item) => setEditor({ kind: "removeDayOff", item })}
          onEditOverride={(item, override) =>
            setEditor({ kind: "override", item, override })
          }
          onRemoveOverride={(item) =>
            setEditor({ kind: "removeOverride", item })
          }
        />
      )}
    </div>
  );
}

function BookingList({
  bookings,
  w,
  onOpen,
}: {
  bookings: StoredBooking[];
  w: WorkspaceData;
  onOpen: (b: StoredBooking) => void;
}) {
  return bookings.length ? (
    <div className="workspace-bookings">
      {bookings.map((b) => (
        <button
          className="workspace-booking-row"
          key={b.id}
          onClick={() => onOpen(b)}
        >
          <span className="workspace-booking-time">
            {time(b.start_min)}
            <small>{b.duration_min} min</small>
          </span>
          <span>
            <strong>{b.customer_name}</strong>
            <small>
              {b.service_name} ·{" "}
              {w.staff.find((s) => s.id === b.staff_id)?.name}
            </small>
            <small>
              {reference(b)} · {money(b.price_pence)}
            </small>
          </span>
          <Badge tone={b.status === "CANCELLED" ? "warning" : ""}>
            {labels[b.status]}
          </Badge>
          <Icon name="right" />
        </button>
      ))}
    </div>
  ) : (
    <div className="workspace-empty">
      <Icon name="calendar" size={34} />
      <h2>No matching appointments</h2>
      <p>Create a test booking, change the date or clear your filters.</p>
    </div>
  );
}

type EditorProps = {
  editor: Editor;
  w: WorkspaceData;
  date: string;
  onClose: () => void;
  saved: (path: string, method: string, body?: unknown) => Promise<void>;
  onMove: (b: StoredBooking) => void;
  onEdit: (b: StoredBooking) => void;
  reloadEditor: () => Promise<void>;
  onRemoveDayOff: (item: StaffDayOff) => void;
  onEditOverride: (item: Staff, override?: ScheduleOverride) => void;
  onRemoveOverride: (item: ScheduleOverride) => void;
};
function WorkspaceEditor({
  editor: e,
  w,
  date,
  onClose,
  saved,
  onMove,
  onEdit,
  reloadEditor,
  onRemoveDayOff,
  onEditOverride,
  onRemoveOverride,
}: EditorProps) {
  const [reloadError, setReloadError] = useState("");
  const [reloading, setReloading] = useState(false);
  const title =
    e.kind === "addon"
      ? e.item
        ? "Edit add-on"
        : "Add add-on"
      : e.kind === "serviceRules"
        ? `${e.item.name} · services & pricing`
        : e.kind === "overrides"
          ? `${e.item.name} · dated hours`
          : e.kind === "override"
            ? e.override
              ? "Edit dated hours"
              : "Add dated hours"
            : e.kind === "removeOverride"
              ? "Remove dated hours"
              : e.kind === "daysOff"
                ? `${e.item.name} · days off`
                : e.kind === "removeDayOff"
                  ? "Remove day off"
                  : e.kind === "contacts"
                    ? "Edit booking details"
                    : e.kind === "staff"
                      ? e.item
                        ? "Edit barber"
                        : "Add barber"
                      : e.kind === "service"
                        ? e.item
                          ? "Edit service"
                          : "Add service"
                        : e.kind === "hours"
                          ? `${e.item.name} · weekly hours`
                          : e.kind === "booking"
                            ? e.item
                              ? "Reschedule appointment"
                              : "New test booking"
                            : e.kind === "detail"
                              ? reference(e.item)
                              : e.kind === "holiday"
                                ? "Add shop closure"
                                : "Remove shop closure";
  return (
    <Modal
      title={title}
      onClose={onClose}
      context="LOCAL DATABASE · TEST DATA ONLY"
      wide={e.kind === "hours"}
    >
      {e.kind === "addon" && <AddonEditor addon={e.item} w={w} saved={saved} />}
      {e.kind === "serviceRules" && (
        <ServiceRulesEditor staff={e.item} w={w} saved={saved} />
      )}
      {e.kind === "overrides" && (
        <>
          <Notice>
            Dated hours replace one day's weekly shift and break. Shop closures
            and full-day leave still take priority. Existing bookings are
            flagged, never automatically cancelled.
          </Notice>
          <Button onClick={() => onEditOverride(e.item)}>
            Add dated hours
          </Button>
          <section className="workspace-day-off-list">
            {!w.schedule_overrides.some((o) => o.staff_id === e.item.id) && (
              <p>No dated hours yet.</p>
            )}
            {w.schedule_overrides
              .filter((o) => o.staff_id === e.item.id)
              .map((o) => (
                <article className="workspace-closure" key={o.id}>
                  <h3>{o.date}</h3>
                  <p>
                    {o.enabled
                      ? `${clock(o.starts)}–${clock(o.ends)}`
                      : "Off duty"}{" "}
                    · {o.reason}
                  </p>
                  <div className="workspace-actions">
                    <Button
                      variant="secondary"
                      onClick={() => onEditOverride(e.item, o)}
                    >
                      Edit {o.date}
                    </Button>
                    <Button variant="ghost" onClick={() => onRemoveOverride(o)}>
                      Remove {o.date}
                    </Button>
                  </div>
                </article>
              ))}
          </section>
        </>
      )}
      {e.kind === "override" && (
        <OverrideEditor
          staff={e.item}
          override={e.override}
          date={date}
          w={w}
          saved={saved}
        />
      )}
      {e.kind === "removeOverride" && (
        <SaveForm
          label="Confirm removal"
          onSave={() =>
            saved(`/staff/${e.item.staff_id}/overrides/${e.item.id}`, "DELETE")
          }
        >
          <p>
            Remove dated hours for {e.item.date}? The weekly schedule will apply
            again. Existing bookings and audit records stay saved.
          </p>
        </SaveForm>
      )}
      {e.kind === "staff" && (
        <SaveForm
          onSave={(f) =>
            saved(
              `/staff${e.item ? "/" + e.item.id : ""}`,
              e.item ? "PUT" : "POST",
              {
                name: text(f, "name"),
                role: text(f, "role"),
                active: f.has("active") ? 1 : 0,
                ...(e.item ? { version: e.item.version } : {}),
              },
            )
          }
        >
          <Field label="Barber name">
            <input
              name="name"
              required
              minLength={2}
              maxLength={100}
              defaultValue={e.item?.name}
            />
          </Field>
          <Field label="Role description">
            <input
              name="role"
              required
              minLength={2}
              maxLength={50}
              defaultValue={e.item?.role || "Barber"}
            />
          </Field>
          <label className="workspace-check">
            <input
              type="checkbox"
              name="active"
              defaultChecked={e.item ? !!e.item.active : true}
            />
            Active and bookable
          </label>
          <Notice>
            This is a staff profile, not an invitation or login. Deactivation
            keeps appointment history.
          </Notice>
        </SaveForm>
      )}
      {e.kind === "service" && (
        <SaveForm
          onSave={(f) =>
            saved(
              `/services${e.item ? "/" + e.item.id : ""}`,
              e.item ? "PUT" : "POST",
              {
                name: text(f, "name"),
                category: text(f, "category"),
                duration_min: number(f, "duration"),
                price_pence: Math.round(number(f, "price") * 100),
                active: f.has("active") ? 1 : 0,
                ...(e.item ? { version: e.item.version } : {}),
              },
            )
          }
        >
          <Field label="Service name">
            <input
              name="name"
              required
              minLength={2}
              maxLength={100}
              defaultValue={e.item?.name}
            />
          </Field>
          <Field label="Category">
            <input
              name="category"
              required
              minLength={2}
              maxLength={40}
              defaultValue={e.item?.category || "Hair"}
            />
          </Field>
          <div className="workspace-form-grid">
            <Field label="Duration (minutes)">
              <input
                name="duration"
                type="number"
                min={5}
                max={240}
                required
                defaultValue={e.item?.duration_min || 30}
              />
            </Field>
            <Field label="Price (£)">
              <input
                name="price"
                type="number"
                min={0}
                max={1000}
                step="0.01"
                required
                defaultValue={(e.item?.price_pence ?? 2800) / 100}
              />
            </Field>
          </div>
          <label className="workspace-check">
            <input
              type="checkbox"
              name="active"
              defaultChecked={e.item ? !!e.item.active : true}
            />
            Available for new bookings
          </label>
        </SaveForm>
      )}
      {e.kind === "hours" && (
        <SaveForm
          onSave={(f) =>
            saved(`/staff/${e.item.id}/hours`, "PUT", {
              version: e.item.version,
              rows: days.map((_, i) => ({
                weekday: i,
                enabled: f.has(`enabled-${i}`) ? 1 : 0,
                starts: minute(text(f, `starts-${i}`)),
                ends: minute(text(f, `ends-${i}`)),
                break_start: minute(text(f, `break_start-${i}`)),
                break_end: minute(text(f, `break_end-${i}`)),
              })),
            })
          }
        >
          <Notice>
            Use equal break start/end times for no break. Shop opening hours
            still apply.
          </Notice>
          {days.map((day, i) => {
            const h = w.hours.find(
              (h) => h.staff_id === e.item.id && h.weekday === i,
            )!;
            return (
              <fieldset className="workspace-hours" key={day}>
                <legend>{day}</legend>
                <label className="workspace-check">
                  <input
                    name={`enabled-${i}`}
                    type="checkbox"
                    defaultChecked={!!h.enabled}
                  />
                  Working
                </label>
                <div className="workspace-form-grid">
                  {(
                    ["starts", "ends", "break_start", "break_end"] as const
                  ).map((key, j) => (
                    <Field
                      key={key}
                      label={`${day} ${["start", "end", "break start", "break end"][j]}`}
                    >
                      <input
                        type="time"
                        required
                        name={`${key}-${i}`}
                        defaultValue={clock(h[key])}
                      />
                    </Field>
                  ))}
                </div>
              </fieldset>
            );
          })}
        </SaveForm>
      )}
      {e.kind === "daysOff" && (
        <>
          <Notice>
            Full-day leave overrides weekly hours for this barber only. Existing
            appointments stay saved and are flagged for review. Partial-day
            overrides are not available yet.
          </Notice>
          <section className="workspace-day-off-list">
            <h3>Saved days off</h3>
            {w.days_off.filter((d) => d.staff_id === e.item.id).length ===
              0 && <p>No saved days off.</p>}
            {w.days_off
              .filter((d) => d.staff_id === e.item.id)
              .map((d) => (
                <article className="workspace-closure" key={d.id}>
                  <strong>{d.date}</strong>
                  <p>{d.reason}</p>
                  <Button variant="ghost" onClick={() => onRemoveDayOff(d)}>
                    Remove {d.date}
                  </Button>
                </article>
              ))}
          </section>
          <SaveForm
            label="Save day off"
            onSave={(f) =>
              saved(`/staff/${e.item.id}/days-off`, "POST", {
                date: text(f, "date"),
                reason: text(f, "reason"),
              })
            }
          >
            <Field label="Day off date">
              <input type="date" name="date" required defaultValue={date} />
            </Field>
            <Field label="Day off reason">
              <input
                name="reason"
                required
                minLength={3}
                maxLength={100}
                placeholder="Fictional test leave"
              />
            </Field>
          </SaveForm>
        </>
      )}
      {e.kind === "removeDayOff" && (
        <SaveForm
          label="Confirm removal"
          onSave={() =>
            saved(`/staff/${e.item.staff_id}/days-off/${e.item.id}`, "DELETE")
          }
        >
          <p>
            Remove the day off on {e.item.date}? Weekly hours will apply again.
            Saved appointments and the audit history remain unchanged.
          </p>
        </SaveForm>
      )}
      {e.kind === "holiday" && (
        <SaveForm
          onSave={(f) =>
            saved("/holidays", "POST", {
              date: text(f, "date"),
              label: text(f, "label"),
            })
          }
        >
          <Field label="Closure date">
            <input name="date" type="date" required defaultValue={date} />
          </Field>
          <Field label="Closure reason">
            <input name="label" required minLength={2} maxLength={100} />
          </Field>
        </SaveForm>
      )}
      {e.kind === "removeHoliday" && (
        <SaveForm
          label="Confirm removal"
          onSave={() => saved(`/holidays/${e.item.id}`, "DELETE")}
        >
          <p>
            Remove {e.item.label} on {e.item.date}? The audit record will
            remain.
          </p>
        </SaveForm>
      )}
      {e.kind === "booking" && (
        <BookingForm w={w} initialDate={date} booking={e.item} saved={saved} />
      )}
      {e.kind === "contacts" && (
        <SaveForm
          onSave={(f) =>
            saved(`/bookings/${e.item.id}/details`, "PATCH", {
              customer_name: text(f, "customer_name"),
              phone: text(f, "phone"),
              notes: text(f, "notes"),
              reason: text(f, "reason"),
              version: e.item.version,
            })
          }
        >
          <Field label="Fictional customer name">
            <input
              name="customer_name"
              required
              minLength={2}
              maxLength={100}
              defaultValue={e.item.customer_name}
            />
          </Field>
          <Field label="Test UK mobile number">
            <input
              name="phone"
              type="tel"
              required
              defaultValue={e.item.phone}
            />
          </Field>
          <Field label="Test notes">
            <textarea
              name="notes"
              maxLength={500}
              defaultValue={e.item.notes}
            />
          </Field>
          <Field label="Reason for detail changes">
            <textarea name="reason" required minLength={3} maxLength={300} />
          </Field>
          <Notice>
            This edits the appointment only. The reference, price, duration and
            service history stay unchanged. Do not enter real personal or
            sensitive information.
          </Notice>
        </SaveForm>
      )}
      {e.kind === "detail" && (
        <>
          <section className="workspace-booking-detail">
            <BookingItems
              items={JSON.parse(e.item.items_json) as BookingItem[]}
            />
            <Badge>{labels[e.item.status]}</Badge>
            <h3>{e.item.customer_name}</h3>
            <p>{e.item.phone}</p>
            <p>
              {e.item.date} at {time(e.item.start_min)} ·{" "}
              {w.staff.find((s) => s.id === e.item.staff_id)?.name}
            </p>
            <p>
              {e.item.service_name} · {e.item.duration_min} minutes ·{" "}
              {money(e.item.price_pence)}
            </p>
            <p>
              {e.item.source === "WALK_IN" ? "Walk-in" : "Test booking"} ·{" "}
              {e.item.notes || "No notes"}
            </p>
            <Notice>
              Service snapshot retained. Deposit policy:{" "}
              {money(e.item.deposit_policy_pence)}; no payment collected.
              Cancellation policy snapshot: {e.item.cancel_hours_snapshot}{" "}
              hours. Owner test overrides require a reason.
            </Notice>
          </section>
          {e.item.status === "CONFIRMED" && (
            <Button variant="secondary" onClick={() => onMove(e.item)}>
              Reschedule
            </Button>
          )}
          <Button variant="ghost" onClick={() => onEdit(e.item)}>
            Edit booking details
          </Button>
          <StatusForm booking={e.item} w={w} saved={saved} />
        </>
      )}
      {"item" in e && e.item && "version" in e.item && (
        <footer className="workspace-editor-recovery">
          <p className="workspace-footnote">
            Record changed elsewhere? This discards unsaved edits in this
            dialog, not saved records.
          </p>
          <ErrorMessage error={reloadError} />
          <Button
            variant="ghost"
            disabled={reloading}
            onClick={async () => {
              setReloading(true);
              setReloadError("");
              try {
                await reloadEditor();
              } catch (error) {
                setReloadError(
                  error instanceof Error
                    ? error.message
                    : "Unable to refresh. Try again.",
                );
              } finally {
                setReloading(false);
              }
            }}
          >
            {reloading ? "Loading latest…" : "Discard edits and load latest"}
          </Button>
        </footer>
      )}
    </Modal>
  );
}

function AddonEditor({
  addon: a,
  w,
  saved,
}: {
  addon?: Addon;
  w: WorkspaceData;
  saved: EditorProps["saved"];
}) {
  return (
    <SaveForm
      onSave={(f) =>
        saved(`/addons${a ? "/" + a.id : ""}`, a ? "PUT" : "POST", {
          name: text(f, "name"),
          price_pence: Math.round(number(f, "price") * 100),
          duration_min: number(f, "duration"),
          active: f.has("active") ? 1 : 0,
          service_ids: f.getAll("service_ids").map(String),
          ...(a ? { version: a.version } : {}),
        })
      }
    >
      <Field label="Add-on name">
        <input
          name="name"
          required
          minLength={2}
          maxLength={100}
          defaultValue={a?.name}
        />
      </Field>
      <div className="workspace-form-grid">
        <Field label="Add-on price (£)">
          <input
            name="price"
            type="number"
            min={0}
            max={1000}
            step="0.01"
            required
            defaultValue={(a?.price_pence ?? 500) / 100}
          />
        </Field>
        <Field label="Extra minutes">
          <input
            name="duration"
            type="number"
            min={0}
            max={120}
            required
            defaultValue={a?.duration_min ?? 10}
          />
        </Field>
      </div>
      <label className="workspace-check">
        <input
          type="checkbox"
          name="active"
          defaultChecked={a ? !!a.active : true}
        />
        Available for selection
      </label>
      <fieldset className="workspace-checks">
        <legend>Offered with services (choose at least one)</legend>
        {w.services.map((s) => (
          <label key={s.id}>
            <input
              type="checkbox"
              name="service_ids"
              value={s.id}
              defaultChecked={
                !a ||
                w.addon_links.some(
                  (l) => l.addon_id === a.id && l.service_id === s.id,
                )
              }
            />
            {s.name}
            {s.active ? "" : " (inactive)"}
          </label>
        ))}
      </fieldset>
      <Notice>
        Changes apply to new bookings. Saved appointment items and totals remain
        unchanged.
      </Notice>
    </SaveForm>
  );
}
function ServiceRulesEditor({
  staff,
  w,
  saved,
}: {
  staff: Staff;
  w: WorkspaceData;
  saved: EditorProps["saved"];
}) {
  return (
    <>
      <Notice>
        By default this barber offers all services at catalogue prices and
        durations. Clear an override to inherit the catalogue again. Disabling
        eligibility flags future appointments; it does not cancel them.
      </Notice>
      {w.services.map((s) => {
        const r = w.service_rules.find(
          (r) => r.staff_id === staff.id && r.service_id === s.id,
        );
        return (
          <section
            className="workspace-rule-panel"
            key={s.id}
            aria-label={`${s.name} rule`}
          >
            <h3>{s.name}</h3>
            <p>
              Catalogue: {money(s.price_pence)} · {s.duration_min} minutes
            </p>
            <SaveForm
              label={`Save ${s.name} rule`}
              onSave={(f) =>
                saved(`/staff/${staff.id}/services/${s.id}`, "PUT", {
                  enabled: f.has("enabled") ? 1 : 0,
                  price_pence:
                    text(f, "price") === ""
                      ? null
                      : Math.round(number(f, "price") * 100),
                  duration_min:
                    text(f, "duration") === "" ? null : number(f, "duration"),
                  version: r?.version ?? 0,
                })
              }
            >
              <label className="workspace-check">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={r ? !!r.enabled : true}
                />
                Offers {s.name}
              </label>
              <div className="workspace-form-grid">
                <Field label={`${s.name} price override (£)`}>
                  <input
                    name="price"
                    type="number"
                    min={0}
                    max={1000}
                    step="0.01"
                    placeholder="Catalogue price"
                    defaultValue={
                      r?.price_pence == null ? "" : r.price_pence / 100
                    }
                  />
                </Field>
                <Field label={`${s.name} duration override`}>
                  <input
                    name="duration"
                    type="number"
                    min={5}
                    max={240}
                    placeholder="Catalogue minutes"
                    defaultValue={r?.duration_min ?? ""}
                  />
                </Field>
              </div>
            </SaveForm>
          </section>
        );
      })}
    </>
  );
}
function OverrideEditor({
  staff,
  override: o,
  date,
  w,
  saved,
}: {
  staff: Staff;
  override?: ScheduleOverride;
  date: string;
  w: WorkspaceData;
  saved: EditorProps["saved"];
}) {
  const base =
    o ??
    w.hours.find(
      (h) =>
        h.staff_id === staff.id &&
        h.weekday === new Date(date + "T12:00:00Z").getUTCDay(),
    )!;
  return (
    <SaveForm
      onSave={(f) =>
        saved(
          `/staff/${staff.id}/overrides${o ? "/" + o.id : ""}`,
          o ? "PUT" : "POST",
          {
            date: text(f, "date"),
            enabled: f.has("enabled") ? 1 : 0,
            starts: minute(text(f, "starts")),
            ends: minute(text(f, "ends")),
            break_start: minute(text(f, "break_start")),
            break_end: minute(text(f, "break_end")),
            reason: text(f, "reason"),
            ...(o ? { version: o.version } : {}),
          },
        )
      }
    >
      <Field label="Override date">
        <input
          name="date"
          type="date"
          required
          defaultValue={o?.date ?? date}
        />
      </Field>
      <label className="workspace-check">
        <input
          name="enabled"
          type="checkbox"
          defaultChecked={o ? !!o.enabled : true}
        />
        Working on this date
      </label>
      <div className="workspace-form-grid">
        {(["starts", "ends", "break_start", "break_end"] as const).map(
          (key, i) => (
            <Field
              key={key}
              label={
                ["Shift start", "Shift end", "Break start", "Break end"][i]
              }
            >
              <input
                name={key}
                type="time"
                required
                defaultValue={clock(base[key])}
              />
            </Field>
          ),
        )}
      </div>
      <Field label="Override reason">
        <input
          name="reason"
          required
          minLength={3}
          maxLength={100}
          defaultValue={o?.reason}
        />
      </Field>
      <Notice>
        This replaces the weekly shift and break for this date. Equal break
        times mean no break. Shop limits and full-day leave still apply.
      </Notice>
    </SaveForm>
  );
}
function BookingItems({ items }: { items: BookingItem[] }) {
  return (
    <ul className="workspace-quote-items">
      {items.map((i) => (
        <li key={i.id}>
          <span>
            {i.name}
            {i.kind === "ADDON" ? " (add-on)" : ""}
          </span>
          <span>
            {money(i.price_pence)} · {i.duration_min} min
          </span>
        </li>
      ))}
    </ul>
  );
}

function StatusForm({
  booking: b,
  w,
  saved,
}: {
  booking: StoredBooking;
  w: WorkspaceData;
  saved: EditorProps["saved"];
}) {
  const options: Record<string, string[]> = {
    CONFIRMED: ["CHECKED_IN", "CANCELLED", "NO_SHOW"],
    CHECKED_IN: ["IN_SERVICE", "CANCELLED"],
    IN_SERVICE: ["COMPLETED"],
  };
  const [status, setStatus] = useState(options[b.status]?.[0] || "");
  if (!options[b.status])
    return (
      <p className="workspace-footnote">
        This appointment is closed. Its history cannot be deleted.
      </p>
    );
  const noShowEarly =
    status === "NO_SHOW" &&
    Date.now() < b.start_at + w.shop.no_show_grace * 60000;
  return (
    <SaveForm
      label="Update appointment status"
      onSave={(f) => {
        if (noShowEarly)
          throw new Error("The no-show grace period has not elapsed.");
        return saved(`/bookings/${b.id}/status`, "POST", {
          status,
          version: b.version,
          reason: text(f, "reason"),
        });
      }}
    >
      <Field label="Next status">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {options[b.status].map((s) => (
            <option key={s} value={s}>
              {labels[s]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reason / operational note">
        <textarea
          name="reason"
          required={["CANCELLED", "NO_SHOW"].includes(status)}
          minLength={["CANCELLED", "NO_SHOW"].includes(status) ? 3 : undefined}
          maxLength={300}
        />
      </Field>
      {noShowEarly && (
        <Notice tone="warning">
          No-show is available only after the start time plus{" "}
          {w.shop.no_show_grace} minutes. The server enforces this.
        </Notice>
      )}
      <p>Completing a service does not record or collect payment.</p>
    </SaveForm>
  );
}

type Slots = {
  items: BookingItem[];
  overridden: boolean;
  service_name: string;
  cancel_hours: number;
  slots: { start_min: number; reason: string }[];
  price_pence: number;
  duration_min: number;
  deposit_policy_pence: number;
  quote: { service_version: number; shop_version: number };
};
function BookingForm({
  w,
  initialDate,
  booking: b,
  saved,
}: {
  w: WorkspaceData;
  initialDate: string;
  booking?: StoredBooking;
  saved: EditorProps["saved"];
}) {
  const [date, setDate] = useState(b?.date || initialDate);
  const [staff, setStaff] = useState(
    b?.staff_id || w.staff.find((s) => s.active)?.id || "",
  );
  const [service, setService] = useState(
    b?.service_id || w.services.find((s) => s.active)?.id || "",
  );
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [start, setStart] = useState("");
  const [slots, setSlots] = useState<Slots | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState(false);
  const request = useRef({ payload: "", key: crypto.randomUUID() });
  useEffect(() => {
    let current = true;
    setSlots(null);
    setStart("");
    setReview(false);
    setError("");
    if (!date || !staff || !service) {
      setError("Add an active barber and service first.");
      return;
    }
    api<Slots>(
      `/availability?${new URLSearchParams({ date, staff_id: staff, service_id: service, addon_ids: addonIds.join(","), ...(b ? { booking_id: b.id } : {}) })}`,
    )
      .then((s) => {
        if (current) setSlots(s);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [date, staff, service, addonIds, refresh, b?.id]);
  return (
    <SaveForm
      label={
        review
          ? b
            ? "Confirm reschedule"
            : "Confirm test booking"
          : "Review appointment"
      }
      onSave={async (f) => {
        if (!slots || !start) throw new Error("Choose an available time.");
        if (!review) {
          setReview(true);
          return;
        }
        const payload = b
          ? {
              staff_id: staff,
              date,
              start_min: Number(start),
              version: b.version,
              reason: text(f, "reason"),
            }
          : {
              staff_id: staff,
              service_id: service,
              date,
              start_min: Number(start),
              customer_name: text(f, "customer_name"),
              phone: text(f, "phone"),
              notes: text(f, "notes"),
              source: text(f, "source"),
              quote: slots.quote,
              addon_ids: addonIds,
            };
        const serial = JSON.stringify(payload);
        if (request.current.payload !== serial)
          request.current = { payload: serial, key: crypto.randomUUID() };
        try {
          await saved(
            b ? `/bookings/${b.id}/reschedule` : "/bookings",
            "POST",
            b ? payload : { ...payload, request_id: request.current.key },
          );
        } catch (e) {
          setReview(false);
          if (e instanceof ApiError && e.status === 409) {
            setRefresh((n) => n + 1);
          }
          throw e;
        }
      }}
    >
      <div onChange={() => setReview(false)}>
        <div className="workspace-form-grid">
          <Field label="Barber">
            <select
              value={staff}
              onChange={(e) => setStaff(e.target.value)}
              required
            >
              <option value="">Choose barber</option>
              {w.staff
                .filter((s) => s.active || s.id === b?.staff_id)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.active ? "" : " (inactive)"}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Service">
            <select
              value={service}
              onChange={(e) => {
                setService(e.target.value);
                setAddonIds([]);
              }}
              disabled={!!b}
              required
            >
              <option value="">Choose service</option>
              {w.services
                .filter((s) => s.active || s.id === b?.service_id)
                .map((s) => (
                  <option
                    key={s.id}
                    value={s.id}
                    disabled={w.service_rules.some(
                      (r) =>
                        r.staff_id === staff &&
                        r.service_id === s.id &&
                        !r.enabled,
                    )}
                  >
                    {s.name}
                    {w.service_rules.some(
                      (r) =>
                        r.staff_id === staff &&
                        r.service_id === s.id &&
                        !r.enabled,
                    )
                      ? " (not offered)"
                      : ""}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        {!b && (
          <fieldset className="workspace-addon-options">
            <legend>Optional add-ons</legend>
            {w.addons
              .filter(
                (a) =>
                  (a.active &&
                    w.addon_links.some(
                      (l) => l.addon_id === a.id && l.service_id === service,
                    )) ||
                  addonIds.includes(a.id),
              )
              .map((a) => (
                <label className="workspace-check" key={a.id}>
                  <input
                    type="checkbox"
                    checked={addonIds.includes(a.id)}
                    onChange={(e) =>
                      setAddonIds((ids) =>
                        e.target.checked
                          ? [...ids, a.id]
                          : ids.filter((id) => id !== a.id),
                      )
                    }
                  />
                  {a.name} · {money(a.price_pence)} · +{a.duration_min} min
                  {a.active ? "" : " (unavailable)"}
                </label>
              ))}
            {!w.addons.some(
              (a) =>
                a.active &&
                w.addon_links.some(
                  (l) => l.addon_id === a.id && l.service_id === service,
                ),
            ) && <p>No add-ons offered with this service.</p>}
          </fieldset>
        )}
        <Field label="Booking date">
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <ErrorMessage error={error} />
        {error && (
          <Button variant="secondary" onClick={() => setRefresh((n) => n + 1)}>
            Retry availability
          </Button>
        )}
        {!slots && !error && <p role="status">Checking saved availability…</p>}
        {slots && (
          <>
            <Field label="Available start time">
              <select
                value={start}
                onChange={(e) => setStart(e.target.value)}
                required
              >
                <option value="">Choose a time</option>
                {slots.slots.map((s) => (
                  <option
                    key={s.start_min}
                    value={s.start_min}
                    disabled={!!s.reason}
                  >
                    {time(s.start_min)}
                    {s.reason ? ` — ${s.reason}` : ""}
                  </option>
                ))}
              </select>
            </Field>
            {slots.slots.every((s) => s.reason) && (
              <Notice tone="warning">
                No available times. Try another day or barber, or review weekly
                hours.
              </Notice>
            )}
            <BookingItems items={slots.items} />
            {slots.overridden && (
              <Badge>Barber-specific price / duration</Badge>
            )}
            <p className="workspace-quote">
              <strong>{money(slots.price_pence)}</strong> · {slots.duration_min}{" "}
              minutes + 10-minute buffer
              <br />
              Test deposit policy {money(slots.deposit_policy_pence)} — not
              collected. Cancellation policy: {slots.cancel_hours} hours.
            </p>
          </>
        )}
        {!b && (
          <>
            <Field label="Fictional customer name">
              <input
                name="customer_name"
                required
                minLength={2}
                maxLength={100}
              />
            </Field>
            <Field label="Test UK mobile number">
              <input
                name="phone"
                type="tel"
                required
                placeholder="07700 900123"
              />
            </Field>
            <Field label="Booking source">
              <select name="source">
                <option value="TEST_BOOKING">Test booking</option>
                <option value="WALK_IN">Walk-in</option>
              </select>
            </Field>
            <Field label="Test notes">
              <textarea name="notes" maxLength={500} />
            </Field>
          </>
        )}
        {b && (
          <Field label="Reason for rescheduling">
            <textarea name="reason" required minLength={3} maxLength={300} />
          </Field>
        )}
      </div>
      {review && (
        <Notice>
          <strong>
            Ready to save: {date} at {time(Number(start))}.
          </strong>
          <BookingItems items={slots?.items || []} />
          <p>
            {w.staff.find((s) => s.id === staff)?.name} · {slots?.service_name}{" "}
            · {money(slots?.price_pence || 0)}
          </p>
          Confirm below to save in local D1. Availability is checked again
          atomically; no hold, payment or notification is created.
        </Notice>
      )}
      <p className="workspace-footnote">
        Local test workflow only. Times are Europe/London. Data is saved only
        after confirmation.
      </p>
    </SaveForm>
  );
}
