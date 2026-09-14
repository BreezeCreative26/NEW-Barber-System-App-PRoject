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
import { Calendar, WeekStrip, type CalendarDraft } from "./Calendar";
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
        slug_taken:
          "Another shop already uses this public address. Choose a different one.",
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
async function readDay(date: string): Promise<StoredBooking[]> {
  const rows: StoredBooking[] = [];
  let cursor: { cursor_start: number; cursor_id: string } | null = null;
  do {
    const query = new URLSearchParams({
      date,
      limit: "200",
      ...(cursor
        ? {
            cursor_start: String(cursor.cursor_start),
            cursor_id: cursor.cursor_id,
          }
        : {}),
    });
    const page: {
      bookings: StoredBooking[];
      next_cursor: { cursor_start: number; cursor_id: string } | null;
    } = await api(`/bookings?${query}`);
    if (!Array.isArray(page.bookings))
      throw new Error("Invalid calendar response. Retry workspace.");
    rows.push(...page.bookings);
    cursor = page.next_cursor;
  } while (cursor);
  return rows;
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
  className = "",
}: {
  children?: ReactNode;
  onSave: (data: FormData) => Promise<unknown>;
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const lock = useRef(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (lock.current) return;
    const form = e.currentTarget;
    if (
      form.closest(".account-settings")?.querySelector('form[aria-busy="true"]')
    ) {
      setError("Wait for the current account change before starting another.");
      return;
    }
    const f = new FormData(form);
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave(f);
      if (label !== "Review appointment") delete form.dataset.dirty;
      if (label.endsWith(" rule"))
        setSavedMessage(
          "This service rule is saved. Other unsaved edits are kept.",
        );
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
    <form
      className={`workspace-form ${className}`}
      onSubmit={submit}
      onChange={(e) => {
        e.currentTarget.dataset.dirty = "true";
        setSavedMessage("");
      }}
      aria-busy={busy}
    >
      <fieldset disabled={busy}>
        {children}
        <ErrorMessage error={error} />
        {savedMessage && <p role="status">{savedMessage}</p>}
        <div className="workspace-save-actions">
          <Button type="submit">{busy ? "Saving…" : label}</Button>
        </div>
      </fieldset>
    </form>
  );
}
function AuthEntry({
  token = "",
  claim = false,
  onDone,
}: {
  token?: string;
  claim?: boolean;
  onDone: () => Promise<void>;
}) {
  return (
    <section className="workspace-panel account-entry">
      <Badge>Local test accounts</Badge>
      <h2>
        {claim
          ? "Secure this test shop"
          : token
            ? "Accept staff invitation"
            : "Sign in to your shop"}
      </h2>
      <p>
        {claim
          ? "Keep this shop, its catalogue and every saved appointment. Creating your owner account retires this shop’s browser-only access."
          : token
            ? "Use the email on your invitation. Your owner chooses your shop, staff profile and permissions."
            : "Return to your existing shop from another browser using your local test account."}
      </p>
      <SaveForm
        label={
          claim
            ? "Create owner account"
            : token
              ? "Accept invitation"
              : "Sign in"
        }
        onSave={async (f) => {
          const creating = claim || !!token;
          await api(
            `/auth/${claim ? "register" : token ? "accept" : "login"}`,
            "POST",
            {
              email: text(f, "email"),
              password: text(f, "password"),
              ...(creating ? { name: text(f, "name") } : {}),
              ...(token ? { token } : {}),
            },
          );
          await onDone();
        }}
      >
        {(claim || token) && (
          <Field label="Your name">
            <input
              name="name"
              autoComplete="name"
              required
              minLength={2}
              maxLength={100}
            />
          </Field>
        )}
        <Field label="Account email">
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            maxLength={254}
          />
        </Field>
        <Field label="Password">
          <input
            name="password"
            type="password"
            autoComplete={claim || token ? "new-password" : "current-password"}
            required
            minLength={claim || token ? 12 : 1}
            maxLength={128}
          />
        </Field>
      </SaveForm>
      <p className="helper">
        Fictional accounts only. Use a unique test password of at least 12
        characters. Email verification, password recovery, MFA and customer
        accounts are not connected.
      </p>
    </section>
  );
}
type AccessMember = {
  id: string;
  name: string;
  email: string;
  staff_id: string | null;
  role: string;
  active: number;
  version: number;
};
type StaffInvite = {
  id: string;
  staff_id: string;
  email: string;
  role: string;
  expires_at: number;
  accepted_at: number | null;
  revoked: number;
};
function RoleOptions() {
  return (
    <>
      <option value="BARBER">Barber · assigned appointments</option>
      <option value="RECEPTION">Reception · all bookings</option>
      <option value="MANAGER">Manager · shop operations</option>
    </>
  );
}
function AccountSettings({
  w,
  onDone,
}: {
  w: WorkspaceData;
  onDone: () => Promise<void>;
}) {
  const [access, setAccess] = useState<{
    members: AccessMember[];
    invitations: StaffInvite[];
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [link, setLink] = useState("");
  const [revision, setRevision] = useState(0);
  const account = w.account;
  const root = useRef<HTMLElement>(null);
  async function loadAccess() {
    setAccess(await api("/auth/access"));
    setError("");
  }
  useEffect(() => {
    if (account?.role === "OWNER")
      loadAccess().catch((e) => setError(e.message));
  }, [account?.id]);
  async function mutate(path: string, method: string, body: unknown) {
    const result = await api<{ token?: string }>(path, method, body);
    if (result.token)
      setLink(`${location.origin}/workspace#invite=${result.token}`);
    setNotice("Access change saved. No email or message was sent.");
    try {
      await loadAccess();
    } catch {
      setAccess(null);
      setError(
        "Saved, but access could not reload. Refresh access; do not repeat the saved action.",
      );
    }
    return result;
  }
  if (!account) return <AuthEntry claim onDone={onDone} />;
  return (
    <section className="account-settings" ref={root}>
      <header className="workspace-panel">
        <Badge>{account.role} · local test</Badge>
        <h2>Accounts & permissions</h2>
        <p>
          Signed in as <strong>{account.name}</strong> · {account.email}
        </p>
        <p>
          Owners control access. Managers manage operations. Reception handles
          all bookings. Barbers see and manage only their assigned appointments.
        </p>
        <SaveForm
          label="Sign out"
          onSave={async () => {
            const others = [
              ...(root.current?.querySelectorAll('form[data-dirty="true"]') ||
                []),
            ];
            if (
              others.length &&
              !window.confirm("Discard unsaved account changes and sign out?")
            )
              return;
            await api("/auth/logout", "POST", {});
            await onDone();
          }}
        />
      </header>
      {notice && (
        <p className="workspace-success" role="status">
          {notice}
        </p>
      )}
      <ErrorMessage error={error} />
      <div className="account-grid">
        <section className="workspace-panel">
          <h3>Change password</h3>
          <p>Changing your password signs out your other sessions.</p>
          <SaveForm
            key={revision}
            label="Update password"
            onSave={async (f) => {
              await api("/auth/password", "POST", {
                current_password: text(f, "current"),
                password: text(f, "password"),
              });
              setNotice(
                "Password changed. Other sessions have been signed out.",
              );
              setRevision((n) => n + 1);
            }}
          >
            <Field label="Current password">
              <input
                name="current"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </Field>
            <Field label="New password">
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
              />
            </Field>
          </SaveForm>
        </section>
        {account.role === "OWNER" && (
          <section className="workspace-panel">
            <h3>Invite staff</h3>
            <p>
              Choose an existing active team profile. Links expire after 48
              hours and can be accepted once. No email is sent.
            </p>
            <SaveForm
              label="Create invitation"
              onSave={async (f) => {
                await mutate("/auth/invites", "POST", {
                  email: text(f, "email"),
                  staff_id: text(f, "staff"),
                  role: text(f, "role"),
                });
              }}
            >
              <Field label="Staff profile">
                <select name="staff" required defaultValue="">
                  <option value="" disabled>
                    Choose staff profile
                  </option>
                  {w.staff
                    .filter(
                      (s) =>
                        s.active &&
                        !access?.members.some((m) => m.staff_id === s.id),
                    )
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Invitation email">
                <input name="email" type="email" required maxLength={254} />
              </Field>
              <Field label="Invitation role">
                <select name="role" defaultValue="BARBER">
                  <RoleOptions />
                </select>
              </Field>
            </SaveForm>
            {link && (
              <aside className="account-invite-link">
                <Field label="Staff invitation link">
                  <textarea
                    readOnly
                    value={link}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </Field>
                <p>
                  Copy now and open in a separate browser/private window. The
                  token is shown only here; treat it as a secret.
                </p>
                <Button variant="ghost" onClick={() => setLink("")}>
                  Hide invitation link
                </Button>
              </aside>
            )}
          </section>
        )}
      </div>
      {account.role === "OWNER" && (
        <section className="workspace-panel">
          <h3>Team access</h3>
          <Button
            variant="secondary"
            onClick={() => {
              if (root.current?.querySelector('form[aria-busy="true"]')) return;
              if (
                root.current?.querySelector('form[data-dirty="true"]') &&
                !window.confirm("Discard unsaved access edits and refresh?")
              )
                return;
              loadAccess()
                .then(() => setRevision((n) => n + 1))
                .catch((e) => setError(e.message));
            }}
          >
            Refresh access
          </Button>
          {!access ? (
            <p>Access list has not loaded. Use Refresh access.</p>
          ) : (
            <>
              <div className="account-grid">
                {access.members.map((m) => (
                  <article
                    className="account-member"
                    key={`${m.id}-${m.version}-${revision}`}
                  >
                    <h4>{m.name}</h4>
                    <p>{m.email}</p>
                    {m.role === "OWNER" ? (
                      <Badge>Owner · protected</Badge>
                    ) : (
                      <SaveForm
                        label={`Save access for ${m.name}`}
                        onSave={async (f) => {
                          await mutate(`/auth/members/${m.id}`, "PUT", {
                            role: text(f, "role"),
                            active: Number(text(f, "active")),
                            version: m.version,
                          });
                        }}
                      >
                        <Field label={`Role for ${m.name}`}>
                          <select name="role" defaultValue={m.role}>
                            <RoleOptions />
                          </select>
                        </Field>
                        <Field label={`Access for ${m.name}`}>
                          <select name="active" defaultValue={m.active}>
                            <option value="1">Active</option>
                            <option value="0">Suspended</option>
                          </select>
                        </Field>
                      </SaveForm>
                    )}
                  </article>
                ))}
              </div>
              <h3>Invitations</h3>
              <p>
                Latest 100 invitations. Issuing a replacement revokes the
                previous link for that staff profile.
              </p>
              {access.invitations.length === 0 && <p>No invitations yet.</p>}
              {access.invitations.map((i) => (
                <article className="account-member" key={i.id}>
                  <strong>{i.email}</strong>
                  <p>
                    {i.role} ·{" "}
                    {i.accepted_at
                      ? "Accepted"
                      : i.revoked
                        ? "Revoked"
                        : i.expires_at <= Date.now()
                          ? "Expired"
                          : "Pending"}{" "}
                    · expires {new Date(i.expires_at).toLocaleString("en-GB")}
                  </p>
                  {!i.accepted_at &&
                    !i.revoked &&
                    i.expires_at > Date.now() && (
                      <SaveForm
                        label={`Revoke invitation for ${i.email}`}
                        onSave={async () => {
                          await mutate(
                            `/auth/invites/${i.id}/revoke`,
                            "POST",
                            {},
                          );
                          setLink("");
                        }}
                      />
                    )}
                </article>
              ))}
            </>
          )}
        </section>
      )}
      <Notice>
        Local identity testing only: one shop per account. No customer identity,
        email verification, recovery or live provider is enabled. Suspending
        access or changing a role revokes that member’s sessions; deactivating
        their team profile also blocks access.
      </Notice>
    </section>
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
  | {
      kind: "booking";
      item?: StoredBooking;
      draft?: CalendarDraft;
      rebook?: StoredBooking;
      waitlist?: WaitlistEntry;
    }
  | { kind: "detail"; item: StoredBooking }
  | { kind: "contacts"; item: StoredBooking }
  | { kind: "holiday" }
  | { kind: "removeHoliday"; item: Holiday };

export function Workspace() {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [inviteToken, setInviteToken] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("invite") || "",
  );
  useEffect(() => {
    if (location.hash.startsWith("#invite="))
      history.replaceState(null, "", location.pathname);
  }, []);
  async function accountChanged() {
    ++loadSequence.current;
    setData(null);
    setEditor(null);
    setTab("Appointments");
    setBarber("");
    setSearch("");
    setStatusFilter("");
    setNotice("");
    setInviteToken("");
    try {
      await refresh();
    } catch {
      /* Refresh provides honest read recovery; never repeat auth mutation. */
    }
  }
  function canNavigate() {
    const main = document.getElementById("workspace-main");
    if (main?.querySelector('form[aria-busy="true"]')) {
      setNotice("Wait for the current save before changing screens.");
      return false;
    }
    return (
      !main?.querySelector('form[data-dirty="true"]') ||
      window.confirm("Discard unsaved changes and leave this screen?")
    );
  }
  const [needsSession, setNeedsSession] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState("Appointments");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const [date, setDate] = useState("");
  const dateRef = useRef("");
  dateRef.current = date;
  const queriedDate = useRef("");
  const [loadedDate, setLoadedDate] = useState("");
  const [calendarView, setCalendarView] = useState(() =>
    window.matchMedia("(max-width: 740px)").matches ? "agenda" : "day",
  );
  const [search, setSearch] = useState("");
  const [barber, setBarber] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [directorySearch, setDirectorySearch] = useState("");
  const [directoryStatus, setDirectoryStatus] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const loadSequence = useRef(0);
  const identity = useRef("");
  async function refresh() {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const w = await api<WorkspaceData>("/workspace");
      for (const key of [
        "staff",
        "services",
        "hours",
        "holidays",
        "days_off",
        "addons",
        "addon_links",
        "service_rules",
        "schedule_overrides",
        "audit",
        "issues",
      ] as const) {
        if (!Array.isArray(w[key]))
          throw new Error(
            "The workspace response is incomplete. Retry workspace to load a fresh copy.",
          );
      }
      const targetDate = dateRef.current || w.today;
      const bookings = await readDay(targetDate);
      if (sequence === loadSequence.current) {
        queriedDate.current = targetDate;
        setLoadedDate(targetDate);
        const nextIdentity = `${w.shop.id}:${w.account?.id || "legacy"}:${w.account?.role || ""}`;
        if (identity.current && identity.current !== nextIdentity) {
          setEditor(null);
          setTab("Appointments");
          setSearch("");
          setBarber("");
          setStatusFilter("");
        }
        identity.current = nextIdentity;
        setData({ ...w, bookings });
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
          setTab("Appointments");
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
  useEffect(() => {
    if (date && date !== queriedDate.current) refresh().catch(() => {});
  }, [date]);
  async function openBooking(id: string) {
    try {
      const result = await api<{ booking: StoredBooking }>(`/bookings/${id}`);
      setEditor({ kind: "detail", item: result.booking });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not open appointment. Retry workspace.",
      );
    }
  }
  async function saved(path: string, method: string, body?: unknown) {
    if (stale)
      throw new ApiError(
        "The workspace needs a fresh read before saving. Close this dialog and use Retry workspace; no page reload is needed.",
        409,
      );
    const result = await api<{ booking?: StoredBooking }>(path, method, body);
    if (
      result.booking &&
      (path === "/bookings" || path.endsWith("/reschedule"))
    ) {
      // Show the actual saved destination, including a new visit on another date.
      dateRef.current = result.booking.date;
      queriedDate.current = result.booking.date;
      setDate(result.booking.date);
      setBarber("");
      setStatusFilter("");
      setSearch("");
    }
    if (editor?.kind !== "serviceRules") setEditor(null);
    setNotice("Saved to your local test database.");
    try {
      await refresh();
    } catch {
      setError(
        "Saved successfully, but the updated view could not load. Use Retry workspace below; do not repeat the saved action.",
      );
    }
    return result;
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
  const dayReady = !!w && loadedDate === date && !loading;
  const filteredBookings = (w?.bookings || [])
    .filter(
      (b) =>
        b.date === date &&
        (!barber || b.staff_id === barber) &&
        (!statusFilter || b.status === statusFilter) &&
        `${b.customer_name} ${b.phone} ${b.service_name} ${reference(b)}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => a.start_at - b.start_at || a.id.localeCompare(b.id));
  const activeBookings = filteredBookings.filter(
    (b) => !["CANCELLED", "NO_SHOW"].includes(b.status),
  );
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
          <Brand light />
          <p className="workspace-shop">
            {w?.shop.name || "Build better days."}
          </p>
          <nav aria-label="Workspace sections">
            {[
              "Appointments",
              "Customers",
              "Team",
              "Services",
              "Settings",
              "Audit",
              "Accounts",
            ].map(
              (name, i) =>
                (!w?.account ||
                  ["OWNER", "MANAGER"].includes(w.account.role) ||
                  ["Appointments", "Customers", "Accounts"].includes(name)) && (
                  <button
                    key={name}
                    type="button"
                    aria-current={tab === name ? "page" : undefined}
                    onClick={() => {
                      if (name === tab || !canNavigate()) return;
                      setTab(name);
                      setNotice("");
                      setDirectorySearch("");
                      setDirectoryStatus("");
                    }}
                  >
                    <Icon
                      name={
                        [
                          "calendar",
                          "user",
                          "users",
                          "scissors",
                          "settings",
                          "shield",
                          "user",
                        ][i]
                      }
                    />
                    {name}
                  </button>
                ),
            )}
          </nav>
          <p className="workspace-footnote">
            {w?.account
              ? `${w.account.name} · ${w.account.role.toLowerCase()} · Local test account`
              : "Browser test access · Claim your shop in Accounts to return from another browser."}
          </p>
          <details className="design-reference-links">
            <summary>Design references · sample only</summary>
            <a href="/preview/admin">Original admin reference</a>
            <a href="/preview/book">Customer design reference</a>
            <a href="/preview/barber">Barber design reference</a>
          </details>
        </aside>
        <main id="workspace-main" className="workspace-main">
          <header className="workspace-heading">
            <div>
              <p className="eyebrow">
                {tab === "Appointments"
                  ? "LET’S MAKE IT A GOOD ONE"
                  : "YOUR SHOP / " + tab.toUpperCase()}
              </p>
              <h1>{tab === "Appointments" ? "Your day, at a glance." : tab}</h1>
              <p>
                {tab === "Appointments"
                  ? "Keep the chairs moving. Your saved timetable, all in one place."
                  : "Manage your shop with changes saved to the local test database."}
              </p>
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
          {(inviteToken || (needsSession && !w)) && (
            <AuthEntry token={inviteToken} onDone={accountChanged} />
          )}
          {needsSession && !w && !inviteToken && (
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
                  await api("/auth/logout", "POST", {});
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
          {w && !inviteToken && (
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
                        onClick={() => openBooking(issue.booking_id)}
                      >
                        Review appointment
                      </button>
                    </p>
                  ))}
                </Notice>
              )}
              {tab === "Appointments" && (
                <>
                  <WaitlistPanel w={w} date={date} onBook={(entry) => setEditor({ kind: "booking", waitlist: entry })} />
                  <section
                    className="stats-grid connected-stats"
                    aria-label="Selected day statistics"
                  >
                    {[
                      {
                        label: "Appointments",
                        value: filteredBookings.length,
                        icon: "calendarCheck",
                        foot: "Selected day and filters",
                      },
                      {
                        label: "Booked service value",
                        value: money(
                          activeBookings.reduce((n, b) => n + b.price_pence, 0),
                        ),
                        icon: "wallet",
                        foot: "Not collected · excludes cancelled / no-show",
                      },
                      {
                        label: "Chair time booked",
                        value: (() => {
                          const booked = activeBookings.reduce((n, b) => n + b.duration_min, 0);
                          const open = w.staff
                            .filter((s) => s.active && (!barber || s.id === barber))
                            .reduce((n, s) => {
                              const h = w.hours.find(
                                (x) => x.staff_id === s.id && x.weekday === new Date(`${date}T12:00:00Z`).getUTCDay(),
                              );
                              if (!h?.enabled) return n;
                              return n + (Math.min(h.ends, w.shop.closes) - Math.max(h.starts, w.shop.opens)) - Math.max(0, h.break_end - h.break_start);
                            }, 0);
                          return open ? `${Math.min(100, Math.round((booked / open) * 100))}%` : "—";
                        })(),
                        icon: "checks",
                        foot: `${activeBookings.filter((b) => b.status === "COMPLETED").length} completed · of rostered hours`,
                      },
                      {
                        label: "Booked online",
                        value: filteredBookings.filter(
                          (b) => b.channel === "ONLINE",
                        ).length,
                        icon: "user",
                        foot: `${filteredBookings.filter((b) => b.source === "WALK_IN").length} walk-ins · included above`,
                      },
                    ].map((s) => (
                      <article className="stat-card" key={s.label}>
                        <div className="stat-label">
                          {s.label}
                          <Icon name={s.icon} />
                        </div>
                        <div className="stat-value">
                          {dayReady ? s.value : "—"}
                        </div>
                        <div className="stat-foot">{s.foot}</div>
                      </article>
                    ))}
                  </section>
                  <section
                    className="calendar-card connected-calendar"
                    aria-label="Appointment calendar"
                  >
                    <header className="calendar-toolbar calendar-command-bar">
                      <div className="calendar-date-heading">
                        <h2>Your timetable</h2>
                        <p>
                          {date
                            ? new Intl.DateTimeFormat("en-GB", {
                                dateStyle: "full",
                              }).format(new Date(date + "T12:00:00Z"))
                            : "Choose a date"}{" "}
                          · London time
                        </p>
                      </div>
                      <div className="calendar-primary-actions">
                        <div className="segmented" aria-label="Calendar view">
                          <button
                            type="button"
                            aria-pressed={calendarView === "day"}
                            onClick={() => setCalendarView("day")}
                          >
                            <Icon name="calendar" size={16} />
                            Day timetable
                          </button>
                          <button
                            type="button"
                            aria-pressed={calendarView === "agenda"}
                            onClick={() => setCalendarView("agenda")}
                          >
                            <Icon name="list" size={16} />
                            Agenda
                          </button>
                        </div>
                        <Button
                          disabled={!online || stale || loading}
                          onClick={() => setEditor({ kind: "booking" })}
                        >
                          <Icon name="plus" />
                          New booking
                        </Button>
                      </div>
                    </header>
                    <div className="calendar-controls">
                      <div className="calendar-date-controls">
                        <Field label="Appointment date">
                          <input
                            type="date"
                            value={date}
                            onChange={(e) => {
                              if (e.target.value) setDate(e.target.value);
                            }}
                          />
                        </Field>
                        <div className="calendar-day-actions">
                          <Button
                            variant="ghost"
                            aria-label="Previous day"
                            onClick={() =>
                              setDate(datePlus(date || w.today, -1))
                            }
                          >
                            <Icon name="left" />
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => setDate(w.today)}
                          >
                            Today
                          </Button>
                          <Button
                            variant="ghost"
                            aria-label="Next day"
                            onClick={() =>
                              setDate(datePlus(date || w.today, 1))
                            }
                          >
                            <Icon name="right" />
                          </Button>
                        </div>
                      </div>
                      <div className="calendar-filters">
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
                      </div>
                    </div>
                    <div className="calendar-filter-summary">
                      <span>
                        {dayReady
                          ? `${filteredBookings.length} matching appointment${filteredBookings.length === 1 ? "" : "s"}`
                          : "Loading appointments…"}{" "}
                        · Selected-day search only
                      </span>
                      {(barber || statusFilter || search) && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setBarber("");
                            setStatusFilter("");
                            setSearch("");
                          }}
                        >
                          Clear filters
                        </Button>
                      )}
                    </div>
                    {date && <WeekStrip date={date} onDate={setDate} />}
                    {!dayReady ? (
                      <p role="status" className="calendar-empty">
                        {error
                          ? "Calendar unavailable. Use Retry workspace above."
                          : "Loading this day’s appointments…"}
                      </p>
                    ) : (
                      <>
                        {calendarView === "day" && (
                          <Calendar
                            w={w}
                            date={date}
                            barber={barber}
                            bookings={filteredBookings}
                            disabled={!online || stale || loading}
                            onDraft={(draft) =>
                              setEditor({ kind: "booking", draft })
                            }
                            onOpen={(item) =>
                              setEditor({ kind: "detail", item })
                            }
                          />
                        )}
                        {(calendarView === "agenda" ||
                          filteredBookings.length === 0) && (
                          <BookingList
                            bookings={filteredBookings}
                            w={w}
                            onOpen={(item) =>
                              setEditor({ kind: "detail", item })
                            }
                          />
                        )}
                        {calendarView === "day" &&
                          filteredBookings.some((b) =>
                            ["CANCELLED", "NO_SHOW"].includes(b.status),
                          ) && (
                            <section className="closed-day-bookings">
                              <h3>Cancelled and no-show history</h3>
                              <BookingList
                                bookings={filteredBookings.filter((b) =>
                                  ["CANCELLED", "NO_SHOW"].includes(b.status),
                                )}
                                w={w}
                                onOpen={(item) =>
                                  setEditor({ kind: "detail", item })
                                }
                              />
                            </section>
                          )}
                      </>
                    )}
                    <p className="workspace-footnote">
                      Complete selected-day records loaded from the database.
                      Timetable clicks start a draft; the service, extras and
                      buffer must fit before confirmation. No deposits
                      collected.
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
                  <OnlineBookingPanel w={w} saved={saved} />
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
              {tab === "Customers" && (
                <CustomersPanel
                  w={w}
                  onOpen={(b) => setEditor({ kind: "detail", item: b })}
                />
              )}
              {tab === "Accounts" && (
                <AccountSettings w={w} onDone={accountChanged} />
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
          onRebook={(rebook) => setEditor({ kind: "booking", rebook })}
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


type WaitlistEntry = {
  id: string;
  staff_id: string | null;
  service_id: string;
  customer_name: string;
  phone: string;
  email: string;
  date: string;
  daypart: string;
  notes: string;
  status: string;
  version: number;
  created_at: number;
  service_name: string;
  staff_name: string | null;
};
function WaitlistPanel({
  w,
  date,
  onBook,
}: {
  w: WorkspaceData;
  date: string;
  onBook: (entry: WaitlistEntry) => void;
}) {
  const [rows, setRows] = useState<WaitlistEntry[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [expanded, setExpanded] = useState(false);
  const load = () =>
    api<{ waitlist: WaitlistEntry[] }>(`/waitlist?from=${w.today}`)
      .then((r) => {
        setRows(r.waitlist);
        setError("");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load waitlist."));
  useEffect(() => {
    load();
  }, [w.now, w.bookings.length]);
  async function close(entry: WaitlistEntry) {
    setBusyId(entry.id);
    try {
      await api(`/waitlist/${entry.id}/status`, "POST", { status: "CLOSED", version: entry.version });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update.");
    } finally {
      setBusyId("");
    }
  }
  if (!rows || rows.length === 0) return null;
  const today = rows.filter((r) => r.date === date);
  const shown = expanded ? rows : today.length ? today : rows.slice(0, 3);
  const part: Record<string, string> = { ANY: "any time", MORNING: "morning", AFTERNOON: "afternoon", EVENING: "evening" };
  return (
    <section className="waitlist-panel" aria-labelledby="waitlist-panel-heading">
      <header>
        <div>
          <h2 id="waitlist-panel-heading">
            <Icon name="bell" /> Waitlist
            <span className="nav-count">{rows.length}</span>
          </h2>
          <p>
            {today.length
              ? `${today.length} customer${today.length === 1 ? "" : "s"} waiting for ${date === w.today ? "today" : "this day"}. Book them into a free slot or close the request.`
              : "Customers who asked to be contacted when a full day opens up. Nothing is reserved until you book them."}
          </p>
        </div>
        {rows.length > shown.length || expanded ? (
          <Button variant="ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show fewer" : `Show all ${rows.length}`}
          </Button>
        ) : null}
      </header>
      <ErrorMessage error={error} />
      <ul>
        {shown.map((r) => (
          <li key={r.id}>
            <div>
              <strong>{r.customer_name}</strong>
              <small>
                {r.phone}
                {r.email ? ` · ${r.email}` : ""}
              </small>
            </div>
            <div>
              <span>{r.service_name}</span>
              <small>
                {r.staff_name || "Any barber"} · {part[r.daypart]}
              </small>
            </div>
            <div>
              <span>{new Date(`${r.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" })}</span>
              <small>asked {new Date(r.created_at).toLocaleDateString("en-GB")}</small>
            </div>
            <div className="waitlist-row-actions">
              <Button onClick={() => onBook(r)} disabled={busyId === r.id}>
                Book them in
              </Button>
              <Button variant="ghost" onClick={() => close(r)} disabled={busyId === r.id}>
                {busyId === r.id ? "…" : "Close"}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
function ShareBooking({ booking, w }: { booking: StoredBooking; w: WorkspaceData }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const staff = w.staff.find((s) => s.id === booking.staff_id)?.name;
  const when = `${new Date(`${booking.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" })} at ${time(booking.start_min)}`;
  const message = `Hi ${booking.customer_name.split(" ")[0]}, your ${booking.service_name}${staff ? ` with ${staff}` : ""} at ${w.shop.name} is booked for ${when} (ref ${reference(booking)}).${link ? ` Need to change it? ${link}` : ""}`;
  async function generate() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ path: string }>(`/bookings/${booking.id}/manage-link`, "POST", {});
      setLink(`${location.origin}${r.path}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create link.");
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(`${label} copied.`);
    } catch {
      setCopied("Copy unavailable here; select the text instead.");
    }
  }
  if (["CANCELLED", "NO_SHOW", "COMPLETED"].includes(booking.status)) return null;
  return (
    <details className="share-booking">
      <summary>
        <Icon name="message" /> Share confirmation with customer
      </summary>
      <p>
        Nothing is sent automatically. Generate a private manage link, then copy the message into your own SMS or
        WhatsApp. Generating a new link revokes any earlier one.
      </p>
      <div className="online-link-row">
        {link ? <code>{link}</code> : <small>No manage link generated in this session.</small>}
        <Button variant="secondary" onClick={generate} disabled={busy || !w.shop.slug}>
          {busy ? "Creating…" : link ? "Regenerate link" : "Create manage link"}
        </Button>
        {link && (
          <Button variant="ghost" onClick={() => copy(link, "Link")}>
            Copy link
          </Button>
        )}
      </div>
      {!w.shop.slug && (
        <p className="workspace-footnote">Set a public address in Settings → Online booking to enable manage links.</p>
      )}
      <ErrorMessage error={error} />
      <textarea className="share-message" readOnly value={message} rows={4} aria-label="Confirmation message" />
      <div className="workspace-save-actions">
        <Button variant="ghost" onClick={() => copy(message, "Message")}>
          Copy message
        </Button>
        <a className="button secondary" href={`sms:${booking.phone}?&body=${encodeURIComponent(message)}`}>
          Open in SMS
        </a>
        <a
          className="button secondary"
          href={`https://wa.me/${booking.phone.replace(/^0/, "44").replace(/^\+/, "")}?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noreferrer"
        >
          Open in WhatsApp
        </a>
      </div>
      {copied && <p role="status">{copied}</p>}
    </details>
  );
}

function OnlineBookingPanel({
  w,
  saved,
}: {
  w: WorkspaceData;
  saved: EditorProps["saved"];
}) {
  const suggested =
    w.shop.slug ||
    w.shop.name
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) ||
    "my-shop";
  const [slug, setSlug] = useState(suggested);
  const [copied, setCopied] = useState("");
  const link = `${location.origin}/book/${w.shop.slug || slug}`;
  const readOnly = !!w.account && !["OWNER", "MANAGER"].includes(w.account.role);
  return (
    <section className="workspace-panel" aria-labelledby="online-booking-heading">
      <div className="workspace-section-heading">
        <h2 id="online-booking-heading">Online booking</h2>
        <Badge tone={w.shop.online_booking ? "" : "warning"}>
          {w.shop.online_booking ? "Customers can book" : "Off"}
        </Badge>
      </div>
      <p>
        Customers book from a public page using your live services, barbers,
        hours and prices. Every online booking follows the same availability
        and collision guards as this workspace. No payment or message is sent.
      </p>
      <div className="online-link-row">
        <code data-testid="online-link">{link}</code>
        {w.shop.slug && w.shop.online_booking ? (
          <>
            <a
              className="button secondary"
              href={link}
              target="_blank"
              rel="noreferrer"
            >
              Open booking page
            </a>
            <Button
              variant="ghost"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link);
                  setCopied("Link copied.");
                } catch {
                  setCopied("Copy unavailable; select the link text instead.");
                }
              }}
            >
              Copy link
            </Button>
          </>
        ) : (
          <small>Save with online booking switched on to activate this address.</small>
        )}
      </div>
      {copied && <p role="status">{copied}</p>}
      {!readOnly && (
        <SaveForm
          key={w.shop.version}
          label="Save online booking"
          onSave={(f) =>
            saved("/shop/online", "PUT", {
              slug: text(f, "slug"),
              online_booking: f.get("online_booking") ? 1 : 0,
              lead_time_min: number(f, "lead_time_min"),
              booking_window_days: number(f, "booking_window_days"),
              version: w.shop.version,
            })
          }
        >
          <Field label="Public address (letters, numbers, hyphens)">
            <input
              name="slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              required
              minLength={3}
              maxLength={40}
              pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
              autoCapitalize="off"
              spellCheck={false}
            />
          </Field>
          <label className="workspace-check">
            <input
              type="checkbox"
              name="online_booking"
              defaultChecked={!!w.shop.online_booking}
            />
            Allow customers to book online
          </label>
          <div className="workspace-form-grid">
            <Field label="Minimum notice (minutes)">
              <input
                type="number"
                name="lead_time_min"
                min={0}
                max={10080}
                step={15}
                required
                defaultValue={w.shop.lead_time_min}
              />
            </Field>
            <Field label="Book up to (days ahead)">
              <input
                type="number"
                name="booking_window_days"
                min={1}
                max={365}
                required
                defaultValue={w.shop.booking_window_days}
              />
            </Field>
          </div>
          <p className="workspace-footnote">
            Customers can move or cancel online while the visit is further away
            than the minimum notice. Changes inside your {w.shop.cancel_hours}
            -hour cancellation policy are recorded as late. Switching online
            booking off keeps existing bookings and manage links.
          </p>
        </SaveForm>
      )}
    </section>
  );
}
type CustomerRow = {
  phone: string;
  customer_name: string;
  email: string | null;
  visits: number;
  completed: number;
  no_shows: number;
  cancelled: number;
  completed_value_pence: number;
  first_visit_at: number;
  last_visit_at: number;
  next_visit_at: number | null;
};
function CustomersPanel({
  w,
  onOpen,
}: {
  w: WorkspaceData;
  onOpen: (b: StoredBooking) => void;
}) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{
    phone: string;
    bookings: StoredBooking[];
  } | null>(null);
  const [historyError, setHistoryError] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    const id = ++sequence.current;
    const handle = window.setTimeout(() => {
      api<{ customers: CustomerRow[] }>(
        `/customers?q=${encodeURIComponent(query.trim())}`,
      )
        .then((r) => id === sequence.current && (setRows(r.customers), setError("")))
        .catch(
          (e) =>
            id === sequence.current &&
            setError(e instanceof Error ? e.message : "Could not load customers."),
        );
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query, w.bookings.length, w.now]);
  async function open(phone: string) {
    setHistoryError("");
    try {
      setSelected(await api(`/customers/${encodeURIComponent(phone)}`));
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : "Could not load history.");
    }
  }
  const fmt = (ms: number | null) =>
    ms ? new Date(ms).toLocaleDateString("en-GB", { timeZone: "Europe/London" }) : "—";
  return (
    <div className="workspace-settings">
      <section className="workspace-panel" aria-labelledby="customers-heading">
        <div className="workspace-section-heading">
          <h2 id="customers-heading">Customers</h2>
          <small>{rows ? `${rows.length} shown` : "Loading…"}</small>
        </div>
        <p>
          Built from saved visits and grouped by mobile number. Names and
          emails come from each customer’s latest booking. No marketing or
          messaging is connected.
        </p>
        <Field label="Search customers">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, mobile or email"
          />
        </Field>
        <ErrorMessage error={error} />
        {rows && rows.length === 0 && (
          <div className="workspace-empty">
            <Icon name="user" size={34} />
            <h3>No customers yet</h3>
            <p>Customers appear here after their first saved booking.</p>
          </div>
        )}
        {rows && rows.length > 0 && (
          <table className="customer-table">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Visits</th>
                <th scope="col">Completed</th>
                <th scope="col">No-shows</th>
                <th scope="col">Completed value</th>
                <th scope="col">Last visit</th>
                <th scope="col">Next visit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.phone}>
                  <td className="customer-name">
                    <button
                      className="workspace-text-button"
                      onClick={() => open(r.phone)}
                      aria-expanded={selected?.phone === r.phone}
                    >
                      {r.customer_name}
                    </button>
                    <br />
                    <small>
                      {r.phone}
                      {r.email ? ` · ${r.email}` : ""}
                    </small>
                  </td>
                  <td className="num" data-label="Visits">{r.visits}</td>
                  <td className="num" data-label="Completed">{r.completed}</td>
                  <td className="num" data-label="No-shows">{r.no_shows}</td>
                  <td className="num" data-label="Completed value">
                    {money(r.completed_value_pence)}
                  </td>
                  <td data-label="Last visit">{fmt(r.last_visit_at)}</td>
                  <td data-label="Next visit">{fmt(r.next_visit_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="workspace-panel" aria-labelledby="history-heading">
        <h2 id="history-heading">
          {selected
            ? `${selected.bookings[0]?.customer_name} · visit history`
            : "Visit history"}
        </h2>
        <ErrorMessage error={historyError} />
        {!selected && <p>Select a customer to see every saved visit.</p>}
        {selected && (
          <div className="customer-history">
            {selected.bookings.map((b) => (
              <article key={b.id}>
                <strong>{b.date}</strong>
                <span>
                  {time(b.start_min)} · {b.service_name} ·{" "}
                  {w.staff.find((s) => s.id === b.staff_id)?.name || "Barber"} ·{" "}
                  {money(b.price_pence)}
                  {b.channel === "ONLINE" && (
                    <>
                      {" "}
                      <span className="channel-badge online">Online</span>
                    </>
                  )}
                </span>
                <button
                  className="workspace-text-button"
                  onClick={() => onOpen(b)}
                >
                  {labels[b.status]} · Open
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
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
              {b.channel === "ONLINE" && (
                <>
                  {" "}
                  <span className="channel-badge online">Online</span>
                </>
              )}
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
  saved: (path: string, method: string, body?: unknown) => Promise<{ booking?: StoredBooking } | void>;
  onMove: (b: StoredBooking) => void;
  onRebook: (b: StoredBooking) => void;
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
  onRebook,
  onEdit,
  reloadEditor,
  onRemoveDayOff,
  onEditOverride,
  onRemoveOverride,
}: EditorProps) {
  const detailRef = useRef<HTMLDivElement>(null);
  const [nextAction, setNextAction] = useState<(() => void) | null>(null);
  const [transitionError, setTransitionError] = useState("");
  function requestAction(action: () => void) {
    if (detailRef.current?.querySelector('form[aria-busy="true"]')) {
      setTransitionError(
        "A save is in progress. Wait for its result before switching actions.",
      );
      return;
    }
    if (detailRef.current?.querySelector('form[data-dirty="true"]')) {
      setNextAction(() => action);
      return;
    }
    action();
  }
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
      protectChanges
      wide={e.kind === "hours" || e.kind === "booking"}
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
        <BookingForm
          w={w}
          initialDate={e.waitlist?.date || date}
          booking={e.item}
          draft={e.draft}
          rebook={e.rebook}
          waitlist={e.waitlist}
          saved={saved}
        />
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
        <div ref={detailRef}>
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
              {e.item.channel === "ONLINE" ? (
                <span className="channel-badge online">Booked online</span>
              ) : e.item.source === "WALK_IN" ? (
                "Walk-in"
              ) : (
                "Test booking"
              )}
              {e.item.email && <> · {e.item.email}</>} · {e.item.notes || "No notes"}
            </p>
            <Notice>
              Service snapshot retained. Deposit policy:{" "}
              {money(e.item.deposit_policy_pence)}; no payment collected.
              Cancellation policy snapshot: {e.item.cancel_hours_snapshot}{" "}
              hours. Owner test overrides require a reason.
            </Notice>
          </section>
          <div className="appointment-detail-actions">
            <Button onClick={() => requestAction(() => onRebook(e.item))}>
              <Icon name="calendar" />
              Book again
            </Button>
            {e.item.status === "CONFIRMED" && (
              <Button
                variant="secondary"
                onClick={() => requestAction(() => onMove(e.item))}
              >
                Reschedule
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => requestAction(() => onEdit(e.item))}
            >
              Edit booking details
            </Button>
          </div>
          <ShareBooking booking={e.item} w={w} />
          <ErrorMessage error={transitionError} />
          {nextAction && (
            <section className="dialog-close-warning" role="alert">
              <p>
                You have unsaved appointment changes. Keep editing or discard
                them before switching actions.
              </p>
              <Button variant="secondary" onClick={() => setNextAction(null)}>
                Keep editing appointment
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (
                    detailRef.current?.querySelector('form[aria-busy="true"]')
                  )
                    return;
                  nextAction();
                }}
              >
                Discard changes and continue
              </Button>
            </section>
          )}
          <StatusForm booking={e.item} w={w} saved={saved} />
        </div>
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
  draft,
  rebook: rebookInput,
  waitlist,
  saved,
}: {
  w: WorkspaceData;
  initialDate: string;
  draft?: CalendarDraft;
  rebook?: StoredBooking;
  waitlist?: WaitlistEntry;
  booking?: StoredBooking;
  saved: EditorProps["saved"];
}) {
  // A waitlist entry prefills like a rebooking: customer, service and preferred barber.
  const rebook = rebookInput || (waitlist
    ? ({
        customer_name: waitlist.customer_name,
        phone: waitlist.phone,
        staff_id: waitlist.staff_id || "",
        service_id: waitlist.service_id,
        service_name: waitlist.service_name,
        date: waitlist.date,
        price_pence: 0,
      } as unknown as StoredBooking)
    : undefined);
  const rebookBase = rebook && rebook.date > w.today ? rebook.date : w.today;
  const [date, setDate] = useState(
    b?.date || (waitlist ? waitlist.date : rebook ? datePlus(rebookBase, 21) : initialDate),
  );
  const reviewRef = useRef<HTMLElement>(null);
  const [reviewContact, setReviewContact] = useState({ name: "", phone: "" });
  function markDraft(button: HTMLElement) {
    const form = button.closest("form");
    if (form) form.dataset.dirty = "true";
    setReview(false);
  }
  const [staff, setStaff] = useState(
    b?.staff_id ||
      draft?.staffId ||
      (rebook
        ? w.staff.find((s) => s.id === rebook.staff_id && s.active)?.id || ""
        : w.staff.find((s) => s.active)?.id || ""),
  );
  const [service, setService] = useState(
    b?.service_id ||
      (rebook
        ? w.services.find(
            (s) =>
              s.id === rebook.service_id &&
              s.active &&
              !w.service_rules.some(
                (r) =>
                  r.staff_id === staff && r.service_id === s.id && !r.enabled,
              ),
          )?.id || ""
        : w.services.find(
            (s) =>
              s.active &&
              !w.service_rules.some(
                (r) =>
                  r.staff_id === staff && r.service_id === s.id && !r.enabled,
              ),
          )?.id || ""),
  );
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [start, setStart] = useState("");
  const [slots, setSlots] = useState<Slots | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState(false);
  const request = useRef({ payload: "", key: crypto.randomUUID() });
  const draftPending = useRef(draft?.start);
  useEffect(() => {
    if (review) {
      reviewRef.current?.focus();
      reviewRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [review]);
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
        if (current) {
          setSlots(s);
          if (draftPending.current !== undefined) {
            const candidate = s.slots.find(
              (slot) => slot.start_min === draftPending.current && !slot.reason,
            );
            if (candidate) setStart(String(candidate.start_min));
            else
              setError(
                "The clicked time does not fit this service and buffer. Choose another time or service.",
              );
            draftPending.current = undefined;
          }
        }
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
      className="booking-workflow"
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
          setReviewContact({
            name: b?.customer_name || text(f, "customer_name"),
            phone: b?.phone || text(f, "phone"),
          });
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
          const result = await saved(
            b ? `/bookings/${b.id}/reschedule` : "/bookings",
            "POST",
            b ? payload : { ...payload, request_id: request.current.key },
          );
          // Link the waitlist request to the saved visit; a failure here never undoes the booking.
          if (waitlist && result?.booking)
            api(`/waitlist/${waitlist.id}/status`, "POST", {
              status: "BOOKED",
              booking_id: result.booking.id,
              version: waitlist.version,
            }).catch(() => {});
        } catch (e) {
          setReview(false);
          if (e instanceof ApiError && e.status === 409) {
            setRefresh((n) => n + 1);
          }
          throw e;
        }
      }}
    >
      {waitlist && (
        <aside className="booking-slot-origin" aria-label="Waitlist request">
          <strong>
            <Icon name="bell" /> From the waitlist · {waitlist.customer_name}
          </strong>
          <p>
            Asked for {waitlist.service_name} on {waitlist.date}
            {waitlist.staff_name ? ` with ${waitlist.staff_name}` : " with any barber"} ·{" "}
            {({ ANY: "any time", MORNING: "morning", AFTERNOON: "afternoon", EVENING: "evening" } as Record<string, string>)[waitlist.daypart]}.
          </p>
          <p>
            Pick a free time below. Saving books the customer and marks this waitlist request as booked.
            {!waitlist.staff_id && " Choose whichever barber has space."}
          </p>
          {(!staff || !service) && (
            <p>Choose an active, eligible barber and service.</p>
          )}
        </aside>
      )}
      {rebook && !waitlist && (
        <aside className="booking-slot-origin" aria-label="Previous visit">
          <strong>Book again · {reference(rebook)}</strong>
          <p>
            {rebook.customer_name} · {rebook.service_name} · previous price{" "}
            {money(rebook.price_pence)}
          </p>
          <p>
            A separate new appointment using current prices. Previous notes and
            add-ons are not copied; choose any extras below. The original visit
            stays unchanged.
          </p>
          {(!staff || !service) && (
            <p>
              The previous barber or service is unavailable. Choose an active,
              eligible replacement.
            </p>
          )}
        </aside>
      )}
      {b && (
        <aside
          className="booking-slot-origin"
          aria-label="Original appointment"
        >
          <strong>
            Moving {reference(b)} · {b.customer_name}
          </strong>
          <p>
            {b.date} · {time(b.start_min)} ·{" "}
            {w.staff.find((s) => s.id === b.staff_id)?.name}
          </p>
          <p>
            Original price {money(b.price_pence)} and service items stay
            unchanged. The original time is kept if the move fails.
          </p>
        </aside>
      )}
      {draft && (
        <aside
          className="booking-slot-origin"
          aria-label="Timetable starting point"
        >
          <strong>Started from the timetable</strong>
          <p>
            {w.staff.find((s) => s.id === draft.staffId)?.name} · {initialDate}{" "}
            · {time(draft.start)}
          </p>
          <p>
            This was your starting point, not a reservation. The fields below
            show your current selection.
          </p>
        </aside>
      )}
      <div className="booking-layout" onChange={() => setReview(false)}>
        <section
          className="booking-selection"
          aria-labelledby="booking-service-heading"
        >
          <h3 id="booking-service-heading">1. Service & time</h3>
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
          <h4>Choose your date</h4>
          {rebook && !waitlist && (
            <div
              className="booking-date-shortcuts"
              aria-label="Rebooking date shortcuts"
            >
              <p>
                Weeks from {rebookBase}. Choose a date, then check available
                times.
              </p>
              {[3, 4, 6].map((weeks) => (
                <Button
                  key={weeks}
                  variant="secondary"
                  aria-pressed={date === datePlus(rebookBase, weeks * 7)}
                  onClick={(e) => {
                    markDraft(e.currentTarget);
                    setDate(datePlus(rebookBase, weeks * 7));
                  }}
                >
                  {weeks} weeks
                </Button>
              ))}
            </div>
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
            <Button
              variant="secondary"
              onClick={() => setRefresh((n) => n + 1)}
            >
              Retry availability
            </Button>
          )}
          {!slots && !error && (
            <p role="status">Checking saved availability…</p>
          )}
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
              <div className="booking-time-shortcut">
                <Button
                  variant="secondary"
                  disabled={!slots.slots.some((s) => !s.reason)}
                  onClick={(e) => {
                    markDraft(e.currentTarget);
                    const first = slots.slots.find((s) => !s.reason);
                    if (first) setStart(String(first.start_min));
                  }}
                >
                  Use first available time
                </Button>
                <small>Selected barber and date only. No time is held.</small>
              </div>
              {slots.slots.every((s) => s.reason) && (
                <Notice tone="warning">
                  No available times. Try another day or barber, or review
                  weekly hours.
                </Notice>
              )}
              <BookingItems items={slots.items} />
              {slots.overridden && (
                <Badge>Barber-specific price / duration</Badge>
              )}
              <p className="workspace-quote">
                <strong>{money(slots.price_pence)}</strong> ·{" "}
                {slots.duration_min} minutes + 10-minute buffer
                <br />
                Test deposit policy {money(slots.deposit_policy_pence)} — not
                collected. Cancellation policy: {slots.cancel_hours} hours.
              </p>
            </>
          )}
        </section>
        <section
          className="booking-customer"
          aria-labelledby="booking-customer-heading"
        >
          <h3 id="booking-customer-heading">
            2. {b ? "Move details" : "Customer details"}
          </h3>
          {!b && (
            <>
              <Field label="Fictional customer name">
                <input
                  name="customer_name"
                  defaultValue={rebook?.customer_name}
                  required
                  minLength={2}
                  maxLength={100}
                />
              </Field>
              <Field label="Test UK mobile number">
                <input
                  name="phone"
                  defaultValue={rebook?.phone}
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
          <p className="workspace-footnote">
            Review the details before saving. No payment or message will be
            sent.
          </p>
        </section>
      </div>
      {review && (
        <section
          className="booking-review"
          ref={reviewRef}
          tabIndex={-1}
          aria-label="Review appointment details"
        >
          <Notice>
            <strong>
              Ready to save: {date} at {time(Number(start))}.
            </strong>
            <p>
              {reviewContact.name} · {reviewContact.phone}
            </p>
            {b && (
              <div className="reschedule-comparison">
                <p>
                  <strong>From</strong>
                  {b.date} · {time(b.start_min)}
                  <br />
                  {w.staff.find((s) => s.id === b.staff_id)?.name}
                </p>
                <p>
                  <strong>To</strong>
                  {date} · {time(Number(start))}
                  <br />
                  {w.staff.find((s) => s.id === staff)?.name}
                </p>
              </div>
            )}
            <BookingItems items={slots?.items || []} />
            <p>
              {w.staff.find((s) => s.id === staff)?.name} ·{" "}
              {slots?.service_name} · {money(slots?.price_pence || 0)}
            </p>
            Confirm below to save in local D1. Availability is checked again
            atomically; no hold, payment or notification is created.
          </Notice>
          <Button
            variant="ghost"
            onClick={(e) => {
              const first = e.currentTarget
                .closest("form")
                ?.querySelector<HTMLSelectElement>("select:not(:disabled)");
              setReview(false);
              first?.focus();
            }}
          >
            Edit selections
          </Button>
        </section>
      )}
      <p className="workspace-footnote">
        Local test workflow only. Times are Europe/London. Data is saved only
        after confirmation.
      </p>
    </SaveForm>
  );
}
