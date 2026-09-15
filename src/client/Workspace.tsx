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
import { Brand, Button, Icon, IconButton, Modal, Notice, Badge, Avatar, TopBar, Rail, TabBar, StatusPill, type NavItem } from "./ui";
import { AppointmentPanel, type Timeline } from "./AppointmentPanel";
import { ServiceStudio, BarberStudio } from "./Studio";
import { Calendar, WeekStrip, WeekView, type CalendarDraft, type RangeBooking } from "./Calendar";
import { WalletDrawer } from "./Wallet";
import { SearchPalette, AccountMenu } from "./Palette";
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
const DEMO = { email: "owner@demo.test", barber: "jay@demo.test", password: "Demo1234!" };
function DemoEntry({ onDone }: { onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function open(as: "owner" | "barber", rebuild = false) {
    setBusy(as + (rebuild ? "-rebuild" : ""));
    setError("");
    try {
      await api("/auth/demo", "POST", { as, rebuild });
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the demo shop.");
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="workspace-panel demo-entry" aria-labelledby="demo-heading">
      <Badge>One project · every view</Badge>
      <h2 id="demo-heading">Open the demo shop</h2>
      <p>
        <strong>Demo Barbershop</strong> is the single shared project. Every page of OLLO runs
        against it — the owner workspace, the barber's own view, the customer booking page and the
        customer's manage link — so you always see the same data from each side. Rebuild resets it
        to the seed (3 barbers, 8 services, ~120 fictional appointments, a standing booking, a
        waitlist).
      </p>
      <ul className="demo-surfaces" aria-label="Pages in this project">
        <li>
          <span className="demo-surface-icon"><Icon name="store" /></span>
          <div>
            <strong>Owner / admin</strong>
            <small>Calendar, customers, team, services, insights, settings, audit</small>
          </div>
          <Button onClick={() => open("owner")} disabled={!!busy} data-testid="open-owner">
            {busy === "owner" ? "Opening…" : "Open as owner"}
          </Button>
        </li>
        <li>
          <span className="demo-surface-icon"><Icon name="scissors" /></span>
          <div>
            <strong>Barber</strong>
            <small>Jay Carter's scoped view: own day, own customers, own profile</small>
          </div>
          <Button variant="secondary" onClick={() => open("barber")} disabled={!!busy} data-testid="open-barber">
            {busy === "barber" ? "Opening…" : "Open as barber"}
          </Button>
        </li>
        <li>
          <span className="demo-surface-icon"><Icon name="calendar" /></span>
          <div>
            <strong>Customer booking</strong>
            <small>Public page at <code>/book/demo</code> — pick service, barber, time</small>
          </div>
          <a className="button secondary" href="/book/demo" target="_blank" rel="noreferrer" data-testid="open-customer">
            Open booking page
          </a>
        </li>
        <li>
          <span className="demo-surface-icon"><Icon name="user" /></span>
          <div>
            <strong>Customer manage link</strong>
            <small>Open any appointment → Share → the <code>/manage/…</code> link a customer receives</small>
          </div>
          <span className="demo-surface-note">via an appointment</span>
        </li>
      </ul>
      <div className="demo-actions">
        <Button variant="ghost" onClick={() => open("owner", true)} disabled={!!busy}>
          <Icon name="refresh" />
          {busy === "owner-rebuild" ? "Rebuilding…" : "Rebuild demo data"}
        </Button>
      </div>
      <ErrorMessage error={error} />
      <p className="helper">
        Sign in from any browser with <code>{DEMO.email}</code> / <code>{DEMO.password}</code>
        {" "}(barber: <code>{DEMO.barber}</code>). Fictional data only; no payments or messages.
      </p>
    </section>
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
            defaultValue={!claim && !token ? DEMO.email : undefined}
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
            defaultValue={!claim && !token ? DEMO.password : undefined}
          />
        </Field>
        {!claim && !token && (
          <p className="helper demo-hint">
            Demo credentials are pre-filled: <code>{DEMO.email}</code> / <code>{DEMO.password}</code>. Barber view: <code>{DEMO.barber}</code>.
          </p>
        )}
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
  | { kind: "addon"; item?: Addon }
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
  | { kind: "seriesMove"; item: StoredBooking }
  | { kind: "share"; item: StoredBooking }
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
  // Day timetable everywhere: on phones the board scrolls sideways inside its own region.
  const [calendarView, setCalendarView] = useState("day");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [focusService, setFocusService] = useState<string | null>(null);
  const [focusBarber, setFocusBarber] = useState<string | null>(null);
  // "/" opens search anywhere outside an input, like the top-bar hint says.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      setSearchOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [week, setWeek] = useState<{ key: string; bookings: RangeBooking[] } | null>(null);
  const [weekLoading, setWeekLoading] = useState(false);
  const weekKey = date
    ? datePlus(date, -((new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7))
    : "";
  useEffect(() => {
    if (!data || calendarView !== "week" || !weekKey) return;
    let cancelled = false;
    setWeekLoading(true);
    api<{ bookings: RangeBooking[] }>(`/bookings/range?from=${weekKey}&to=${datePlus(weekKey, 6)}`)
      .then((r) => !cancelled && setWeek({ key: weekKey, bookings: r.bookings }))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not load the week."))
      .finally(() => !cancelled && setWeekLoading(false));
    return () => {
      cancelled = true;
    };
  }, [calendarView, weekKey, data?.now, data?.bookings.length]);
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
  // Appointment side panel: timeline read + lightweight actions that keep the panel open.
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [timelineError, setTimelineError] = useState("");
  const [panelBusy, setPanelBusy] = useState("");
  const [panelError, setPanelError] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const panelBooking = editor?.kind === "detail" ? editor.item : null;
  useEffect(() => {
    if (!panelBooking) {
      setTimeline(null);
      setTimelineError("");
      setPanelError("");
      return;
    }
    let cancelled = false;
    setTimelineError("");
    api<Timeline>(`/bookings/${panelBooking.id}/timeline`)
      .then((t) => !cancelled && setTimeline(t))
      .catch((e) => !cancelled && setTimelineError(e instanceof Error ? e.message : "Could not load history."));
    return () => {
      cancelled = true;
    };
  }, [panelBooking?.id, panelBooking?.version]);
  async function panelAction(label: string, run: () => Promise<{ booking?: StoredBooking } | void | unknown>) {
    setPanelBusy(label);
    setPanelError("");
    try {
      const result = (await run()) as { booking?: StoredBooking } | undefined;
      const fresh = result?.booking ?? (panelBooking ? (await api<{ booking: StoredBooking }>(`/bookings/${panelBooking.id}`)).booking : null);
      setNotice("Saved to your local test database.");
      await refresh().catch(() =>
        setError("Saved successfully, but the updated view could not load. Use Retry workspace below; do not repeat the saved action."),
      );
      if (fresh) setEditor({ kind: "detail", item: fresh });
    } catch (e) {
      setPanelError(e instanceof Error ? e.message : "Could not save.");
      if (e instanceof ApiError && e.status === 409 && panelBooking) {
        // Someone else changed this visit: reload it so the next action uses the current version.
        api<{ booking: StoredBooking }>(`/bookings/${panelBooking.id}`)
          .then((r) => setEditor({ kind: "detail", item: r.booking }))
          .catch(() => {});
      }
    } finally {
      setPanelBusy("");
    }
  }
  async function saved(path: string, method: string, body?: unknown) {
    if (stale)
      throw new ApiError(
        "The workspace needs a fresh read before saving. Close this dialog and use Retry workspace; no page reload is needed.",
        409,
      );
    const result = await api<{ booking?: StoredBooking; created?: StoredBooking[] }>(path, method, body);
    const landed =
      path === "/series" ? result.created?.[0] : result.booking;
    if (
      landed &&
      (path === "/bookings" || path === "/series" || path.endsWith("/reschedule"))
    ) {
      // Show the actual saved destination, including a new visit on another date.
      dateRef.current = landed.date;
      queriedDate.current = landed.date;
      setDate(landed.date);
      setBarber("");
      setStatusFilter("");
      setSearch("");
    }
    setEditor(null);
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
      current.kind === "hours" ||
      current.kind === "daysOff" ||
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
  const manager = !w?.account || ["OWNER", "MANAGER"].includes(w.account.role);
  const navItems: NavItem[] = [
    { key: "Appointments", label: "Appointments", icon: "calendar" },
    { key: "Insights", label: "Insights", icon: "trend" },
    { key: "Customers", label: "Customers", icon: "contact" },
    ...(manager
      ? [
          { key: "Team", label: "Team", icon: "users" },
          { key: "Services", label: "Services", icon: "scissors" },
          { key: "Settings", label: "Settings", icon: "settings" },
          { key: "Audit", label: "Audit", icon: "shield" },
        ]
      : []),
    { key: "Accounts", label: "Accounts", icon: "userRound" },
  ];
  const phoneNav: NavItem[] = [
    { key: "Appointments", label: "Today", icon: "sun" },
    { key: "Insights", label: "Insights", icon: "trend" },
    { key: "Customers", label: "Customers", icon: "contact" },
  ];
  const phoneMore = navItems.filter((n) => !phoneNav.some((p) => p.key === n.key));
  function goTo(name: string) {
    if (name === tab || !canNavigate()) return;
    setTab(name);
    setNotice("");
    setDirectorySearch("");
    setDirectoryStatus("");
  }
  // Wallet chip reads the ledger: money actually recorded today (services + tips), not bookings.
  const todayPayments = (w?.payments || []).filter((p) => p.date === (w?.today || "") && !p.voided_at);
  const todayTaken = todayPayments.reduce((n, p) => n + p.service_pence + p.tip_pence, 0);
  const todayVisits = new Set(todayPayments.map((p) => p.booking_id)).size;
  // Waitlist lives in the notifications drawer (bell) rather than on top of the timetable.
  useEffect(() => {
    if (!w) return;
    let cancelled = false;
    api<{ waitlist: WaitlistEntry[] }>(`/waitlist?from=${w.today}`)
      .then((r) => !cancelled && setWaitlist(r.waitlist))
      .catch(() => !cancelled && setWaitlist([]));
    return () => {
      cancelled = true;
    };
  }, [w?.now, w?.bookings.length, w?.today]);
  const activeFilterCount = [barber, statusFilter, search].filter(Boolean).length;
  const dayStats = (() => {
    const booked = activeBookings.reduce((n, b) => n + b.duration_min, 0);
    const open = w
      ? w.staff
          .filter((s) => s.active && (!barber || s.id === barber))
          .reduce((n, s) => {
            const h = w.hours.find(
              (x) => x.staff_id === s.id && x.weekday === new Date(`${date}T12:00:00Z`).getUTCDay(),
            );
            if (!h?.enabled) return n;
            return n + (Math.min(h.ends, w.shop.closes) - Math.max(h.starts, w.shop.opens)) - Math.max(0, h.break_end - h.break_start);
          }, 0)
      : 0;
    return {
      value: activeBookings.reduce((n, b) => n + b.price_pence, 0),
      visits: activeBookings.length,
      completed: activeBookings.filter((b) => b.status === "COMPLETED").length,
      online: filteredBookings.filter((b) => b.channel === "ONLINE").length,
      walkIns: filteredBookings.filter((b) => b.source === "WALK_IN").length,
      utilisation: open ? Math.min(100, Math.round((booked / open) * 100)) : null,
    };
  })();
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
      <TopBar
        onSearch={() => w && setSearchOpen(true)}
        wallet={
          w
            ? {
                amount: money(todayTaken),
                caption: `${w.account?.role === "BARBER" ? "Taken" : "Taken today"} · ${todayVisits} visit${todayVisits === 1 ? "" : "s"}`,
                open: walletOpen,
              }
            : null
        }
        onWallet={() => setWalletOpen((v) => !v)}
        bell={w ? { count: w.issues.length + waitlist.length, open: notificationsOpen } : null}
        onBell={() => setNotificationsOpen((v) => !v)}
        account={
          w
            ? {
                initials: initialsOf(w.account?.name || w.shop.name),
                name: w.account?.name || w.shop.name,
                caption: w.account ? `${w.shop.name} · ${w.account.role.toLowerCase()}` : "Browser test access",
              }
            : null
        }
        onAccount={() => setAccountOpen((v) => !v)}
        accountOpen={accountOpen}
      >
        <span className="topbar-env" title="Local test workspace: fictional data only, no live payments or messages">
          <Icon name="shield" size={14} /> Local test data
        </span>
      </TopBar>
      {w && accountOpen && (
        <AccountMenu
          w={w}
          onClose={() => setAccountOpen(false)}
          onAccounts={() => goTo("Accounts")}
          onSettings={manager ? () => goTo("Settings") : undefined}
          onPublicPage={w.shop.slug && w.shop.online_booking ? () => window.open(`/${w.shop.slug}`, "_blank", "noopener") : undefined}
          onSignOut={async () => {
            if (!canNavigate()) return;
            try {
              await api("/auth/logout", "POST", {});
            } catch {
              /* already signed out */
            }
            await accountChanged();
          }}
        />
      )}
      {w && searchOpen && (
        <SearchPalette
          w={w}
          api={(path) => api(path)}
          sections={navItems}
          onClose={() => setSearchOpen(false)}
          onSection={goTo}
          onCustomer={(id) => {
            if (!canNavigate()) return;
            setCustomerId(id);
            setTab("Customers");
          }}
          onBooking={(b) => {
            if (tab !== "Appointments" && !canNavigate()) return;
            setTab("Appointments");
            setDate(b.date);
            setEditor({ kind: "detail", item: b });
          }}
          onService={(id) => {
            if (!canNavigate()) return;
            setFocusService(id);
            setTab("Services");
          }}
          onBarber={(id) => {
            if (!canNavigate()) return;
            setFocusBarber(id);
            setTab("Team");
          }}
        />
      )}
      {w && walletOpen && (
        <WalletDrawer
          w={w}
          api={(path) => api(path)}
          onClose={() => setWalletOpen(false)}
          onOpenBooking={(id) => {
            setWalletOpen(false);
            openBooking(id);
          }}
        />
      )}
      {w && notificationsOpen && (
        <NotificationsDrawer
          w={w}
          date={date}
          waitlist={waitlist}
          onRefreshWaitlist={() =>
            api<{ waitlist: WaitlistEntry[] }>(`/waitlist?from=${w.today}`)
              .then((r) => setWaitlist(r.waitlist))
              .catch(() => {})
          }
          onBook={(entry) => {
            setNotificationsOpen(false);
            if (tab !== "Appointments") setTab("Appointments");
            setEditor({ kind: "booking", waitlist: entry });
          }}
          onReview={(id) => {
            setNotificationsOpen(false);
            openBooking(id);
          }}
          onClose={() => setNotificationsOpen(false)}
        />
      )}
      <div className="workspace-layout">
        <Rail
          items={navItems.filter((n) => n.key !== "Audit" && n.key !== "Accounts")}
          bottom={navItems.filter((n) => n.key === "Audit" || n.key === "Accounts")}
          current={tab}
          onSelect={goTo}
        />
        <TabBar
          items={phoneNav}
          more={phoneMore}
          current={tab}
          onSelect={goTo}
          fab={{
            label: "Add appointment",
            disabled: !w || !online,
            onClick: () => {
              if (!w) return;
              if (tab !== "Appointments" && !canNavigate()) return;
              setTab("Appointments");
              if (tab === "Appointments" && !stale && !loading) setEditor({ kind: "booking" });
              else setTimeout(() => document.querySelector<HTMLButtonElement>('[data-testid="new-booking"]')?.click(), 120);
            },
          }}
        />
        <main id="workspace-main" className="workspace-main">
          {tab === "Appointments" ? (
            <h1 className="visually-hidden">Appointments</h1>
          ) : (
            <header className="workspace-heading">
              <div>
                <p className="eyebrow">{"YOUR SHOP / " + tab.toUpperCase()}</p>
                <h1>{tab}</h1>
                <p>Manage your shop with changes saved to the local test database.</p>
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
          )}
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
          {needsSession && !w && !inviteToken && (
            <DemoEntry onDone={accountChanged} />
          )}
          {(inviteToken || (needsSession && !w)) && (
            <AuthEntry token={inviteToken} onDone={accountChanged} />
          )}
          {needsSession && !w && !inviteToken && (
            <details className="workspace-panel workspace-welcome">
              <summary>
                <Icon name="store" size={18} /> Need an empty shop instead? Start a blank test shop
              </summary>
              <p>
                Creates a separate, isolated shop with two example barbers and three editable
                services and no bookings. Use fictional names and numbers only.
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
            </details>
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
                  </strong>{" "}
                  <button
                    className="workspace-text-button"
                    onClick={() => setNotificationsOpen(true)}
                  >
                    Open notifications
                  </button>
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
                <section
                  className="calendar-card connected-calendar"
                  aria-label="Appointment calendar"
                >
                  <h2 className="visually-hidden">Your timetable</h2>
                  <div className="toolbar calendar-toolbar-row" aria-label="Timetable controls">
                    <Button
                      variant="secondary"
                      className="toolbar-today"
                      onClick={() => setDate(w.today)}
                      aria-pressed={date === w.today}
                    >
                      Today
                    </Button>
                    <span className="toolbar-date-group">
                      <Button
                        variant="ghost"
                        className="icon-only"
                        aria-label={calendarView === "week" ? "Previous week" : "Previous day"}
                        onClick={() => setDate(datePlus(date || w.today, calendarView === "week" ? -7 : -1))}
                      >
                        <Icon name="left" />
                      </Button>
                      <span className="toolbar-date">
                        <span className="toolbar-date-text" aria-hidden="true">
                          {!date
                            ? "Choose a date"
                            : calendarView === "week"
                              ? `Week of ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(weekKey + "T12:00:00Z"))}`
                              : new Intl.DateTimeFormat("en-GB", {
                                  weekday: "short",
                                  day: "numeric",
                                  month: "short",
                                }).format(new Date(date + "T12:00:00Z"))}
                          <Icon name="down" size={14} />
                        </span>
                        <input
                          type="date"
                          aria-label="Appointment date"
                          value={date}
                          onChange={(e) => {
                            if (e.target.value) setDate(e.target.value);
                          }}
                        />
                      </span>
                      <Button
                        variant="ghost"
                        className="icon-only"
                        aria-label={calendarView === "week" ? "Next week" : "Next day"}
                        onClick={() => setDate(datePlus(date || w.today, calendarView === "week" ? 7 : 1))}
                      >
                        <Icon name="right" />
                      </Button>
                    </span>
                    <span className="toolbar-select">
                      <Icon name="users" size={15} />
                      <select aria-label="Barber filter" value={barber} onChange={(e) => setBarber(e.target.value)}>
                        <option value="">All barbers</option>
                        {w.staff.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </span>
                    <Button
                      variant={filtersOpen || statusFilter || search ? "secondary" : "ghost"}
                      className="toolbar-filters"
                      aria-expanded={filtersOpen}
                      aria-controls="timetable-filters"
                      aria-label="Filters"
                      onClick={() => setFiltersOpen((v) => !v)}
                      data-testid="filters-toggle"
                    >
                      <Icon name="sliders" size={16} />
                      <span className="toolbar-label">Filters</span>
                      {(statusFilter || search) && (
                        <span className="count-badge inline" aria-label={`${[statusFilter, search].filter(Boolean).length} active`}>
                          {[statusFilter, search].filter(Boolean).length}
                        </span>
                      )}
                    </Button>
                    <span className="toolbar-grow" />
                    <Button
                      variant="ghost"
                      className="icon-only toolbar-refresh"
                      aria-label="Refresh"
                      title="Refresh"
                      aria-busy={loading}
                      disabled={loading || !online}
                      onClick={() =>
                        refresh()
                          .then(() => setNotice("View refreshed."))
                          .catch(() => {})
                      }
                    >
                      <Icon name="refresh" size={16} />
                    </Button>
                    <div className="segmented" aria-label="Calendar view">
                      <button
                        type="button"
                        aria-pressed={calendarView === "day"}
                        onClick={() => setCalendarView("day")}
                        aria-label="Day timetable"
                      >
                        <Icon name="calendar" size={16} />
                        <span className="toolbar-label">Day</span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={calendarView === "week"}
                        onClick={() => setCalendarView("week")}
                        aria-label="Week"
                      >
                        <Icon name="dashboard" size={16} />
                        <span className="toolbar-label">Week</span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={calendarView === "agenda"}
                        onClick={() => setCalendarView("agenda")}
                        aria-label="Agenda"
                      >
                        <Icon name="list" size={16} />
                        <span className="toolbar-label">Agenda</span>
                      </button>
                    </div>
                    <Button
                      disabled={!online || stale || loading}
                      onClick={() => setEditor({ kind: "booking" })}
                      data-testid="new-booking"
                      className="toolbar-add"
                    >
                      <Icon name="plus" />
                      New booking
                    </Button>
                  </div>
                  {filtersOpen && (
                    <div className="calendar-filters-panel" id="timetable-filters">
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
                        variant="ghost"
                        disabled={!activeFilterCount}
                        onClick={() => {
                          setBarber("");
                          setStatusFilter("");
                          setSearch("");
                        }}
                      >
                        Clear filters
                      </Button>
                    </div>
                  )}
                  <div className="calendar-summary" role="status">
                    <span>
                      {!dayReady
                        ? "Loading appointments…"
                        : `${filteredBookings.length} matching appointment${filteredBookings.length === 1 ? "" : "s"}`}
                      {activeFilterCount > 0 && dayReady ? " · filtered" : ""}
                    </span>
                    {dayReady && (
                      <span className="calendar-summary-stats" aria-label="Selected day statistics">
                        <span>
                          <b>{money(dayStats.value)}</b> booked
                        </span>
                        <span>
                          <b>{dayStats.completed}</b>/{dayStats.visits} completed
                        </span>
                        <span>
                          <b>{dayStats.online}</b> online
                        </span>
                        {dayStats.utilisation !== null && (
                          <span>
                            <b>{dayStats.utilisation}%</b> of chair time
                          </span>
                        )}
                      </span>
                    )}
                    {activeFilterCount > 0 && !filtersOpen && (
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
                  {date && calendarView !== "week" && <WeekStrip date={date} onDate={setDate} />}
                  {calendarView === "week" && date ? (
                    <WeekView
                      w={w}
                      date={date}
                      barber={barber}
                      bookings={week?.key === weekKey ? week.bookings : null}
                      loading={weekLoading}
                      onDay={(d) => {
                        setDate(d);
                        setCalendarView("day");
                      }}
                      onOpen={openBooking}
                    />
                  ) : !dayReady ? (
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
                          paid={new Set(w.payments.filter((p) => !p.voided_at).map((p) => p.booking_id))}
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
                          <details className="closed-day-bookings">
                            <summary>
                              <h3>Cancelled and no-show history</h3>
                              <span className="nav-count">
                                {filteredBookings.filter((b) => ["CANCELLED", "NO_SHOW"].includes(b.status)).length}
                              </span>
                            </summary>
                            <BookingList
                              bookings={filteredBookings.filter((b) =>
                                ["CANCELLED", "NO_SHOW"].includes(b.status),
                              )}
                              w={w}
                              onOpen={(item) =>
                                setEditor({ kind: "detail", item })
                              }
                            />
                          </details>
                        )}
                    </>
                  )}
                </section>
              )}
              {tab === "Team" && (
                <BarberStudio
                  w={w}
                  api={api}
                  refresh={refresh}
                  initialSelected={focusBarber}
                  canEdit={!w.account || ["OWNER", "MANAGER"].includes(w.account.role)}
                  onHours={(item) => setEditor({ kind: "hours", item })}
                  onDaysOff={(item) => setEditor({ kind: "daysOff", item })}
                  onOverrides={(item) => setEditor({ kind: "overrides", item })}
                  onOpenBooking={(item) => setEditor({ kind: "detail", item })}
                />
              )}
              {tab === "Services" && (
                <ServiceStudio
                  w={w}
                  api={api}
                  refresh={refresh}
                  initialSelected={focusService}
                  onAddon={(id) => setEditor({ kind: "addon", item: w.addons.find((a) => a.id === id) })}
                  onAddAddon={() => setEditor({ kind: "addon" })}
                />
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
                          till_access: text(f, "till_access") === "ALL" ? "ALL" : "OWNER",
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
                      <Field label="Who can take payment">
                        <select name="till_access" defaultValue={w.shop.till_access}>
                          <option value="OWNER">Shop device only (owner or manager)</option>
                          <option value="ALL">Barbers too, for their own visits</option>
                        </select>
                      </Field>
                    </SaveForm>
                  </section>
                  <OnlineBookingPanel w={w} saved={saved} />
                  <ShopPagePanel w={w} />
                  <CustomerPagesPanel w={w} onOpenBooking={openBooking} />
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
              {tab === "Insights" && <InsightsPanel w={w} />}
              {tab === "Customers" && (
                <CustomersPanel
                  w={w}
                  onOpen={(b) => setEditor({ kind: "detail", item: b })}
                  selectedId={customerId}
                  onSelect={setCustomerId}
                  onBook={(prefill) => setEditor({ kind: "booking", rebook: prefill })}
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
      {w && editor?.kind === "detail" && (
        <AppointmentPanel
          booking={editor.item}
          w={w}
          timeline={timeline}
          timelineError={timelineError}
          busy={panelBusy}
          error={panelError}
          onClose={() => setEditor(null)}
          onStatus={(status, reason) =>
            panelAction(status, () =>
              api(`/bookings/${editor.item.id}/status`, "POST", { status, reason, version: editor.item.version }),
            )
          }
          onMove={() => setEditor({ kind: "booking", item: editor.item })}
          onRebook={() => setEditor({ kind: "booking", rebook: editor.item })}
          onEdit={() => setEditor({ kind: "contacts", item: editor.item })}
          onShare={() => setEditor({ kind: "share", item: editor.item })}
          onCustomer={(id) => {
            setEditor(null);
            setCustomerId(id);
            setTab("Customers");
          }}
          onSeriesCancel={(reason, fromThis) =>
            panelAction("series", () =>
              api(`/series/${editor.item.series_id}/cancel`, "POST", {
                reason,
                ...(fromThis ? { from_booking_id: editor.item.id } : {}),
              }),
            )
          }
          onSeriesMove={() => setEditor({ kind: "seriesMove", item: editor.item })}
          onNote={(note) =>
            panelAction("note", () =>
              api(`/bookings/${editor.item.id}/details`, "PATCH", {
                customer_name: editor.item.customer_name,
                phone: editor.item.phone,
                notes: note,
                reason: "Note updated from appointment panel",
                version: editor.item.version,
              }),
            )
          }
          payments={w.payments.filter((p) => p.booking_id === editor.item.id)}
          canTakePayment={manager || (w.shop.till_access === "ALL" && w.account?.staff_id === editor.item.staff_id)}
          canVoid={manager}
          onCheckout={(body) => panelAction("CHECKOUT", () => api(`/bookings/${editor.item.id}/checkout`, "POST", body))}
          onVoidPayment={(payment, reason) => panelAction("VOID", () => api(`/payments/${payment.id}/void`, "POST", { reason }))}
        >
          <details className="panel-card panel-advanced" open>
            <summary>Status with note, edit details, share confirmation</summary>
            <section className="workspace-booking-detail">
              <BookingItems items={JSON.parse(editor.item.items_json) as BookingItem[]} />
            </section>
            <div className="appointment-detail-actions">
              <Button variant="ghost" onClick={() => setEditor({ kind: "contacts", item: editor.item })}>
                Edit booking details
              </Button>
            </div>
            <StatusForm booking={editor.item} w={w} saved={saved} />
            <ShareBooking booking={editor.item} w={w} />
          </details>
        </AppointmentPanel>
      )}
      {w && editor && editor.kind !== "detail" && (
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


type Insights = {
  from: string;
  to: string;
  days: number;
  by_status: { status: string; channel: string; n: number; value: number }[];
  services: { name: string; n: number; completed_value: number }[];
  barbers: { staff_id: string; name: string; n: number; minutes: number; completed_value: number; no_shows: number }[];
  hours: { hour: number; n: number }[];
  weekdays: { weekday: number; n: number }[];
  daily: { date: string; n: number; completed_value: number }[];
  customers: { customers: number; new_customers: number | null };
  upcoming: { n: number; value: number | null };
  waitlist_open: number;
};
function Bars({
  rows,
  max,
  label,
}: {
  rows: { key: string; label: string; value: number; sub?: string }[];
  max?: number;
  label: string;
}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="insight-bars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key}>
          <span className="insight-bar-label">{r.label}</span>
          <span className="insight-bar-track" aria-hidden="true">
            <span className="insight-bar-fill" style={{ width: `${Math.round((r.value / top) * 100)}%` }} />
          </span>
          <span className="insight-bar-value">
            {r.value}
            {r.sub && <small> {r.sub}</small>}
          </span>
        </li>
      ))}
    </ul>
  );
}
function InsightsPanel({ w }: { w: WorkspaceData }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Insights | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setData(null);
    api<Insights>(`/insights?days=${days}`)
      .then((r) => !cancelled && (setData(r), setError("")))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not load insights."));
    return () => {
      cancelled = true;
    };
  }, [days, w.now]);
  const sum = (f: (r: Insights["by_status"][number]) => boolean) =>
    (data?.by_status || []).filter(f).reduce((n, r) => n + r.n, 0);
  const value = (f: (r: Insights["by_status"][number]) => boolean) =>
    (data?.by_status || []).filter(f).reduce((n, r) => n + (r.value || 0), 0);
  const total = sum(() => true);
  const completed = sum((r) => r.status === "COMPLETED");
  const noShows = sum((r) => r.status === "NO_SHOW");
  const cancelled = sum((r) => r.status === "CANCELLED");
  const online = sum((r) => r.channel === "ONLINE" && !["CANCELLED", "NO_SHOW"].includes(r.status));
  const kept = total - cancelled;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const cards = data
    ? [
        { label: "Appointments", value: String(kept), foot: `${cancelled} cancelled · last ${days} days`, icon: "calendarCheck" },
        { label: "Completed value", value: money(value((r) => r.status === "COMPLETED")), foot: `${completed} completed · booked price, not payments`, icon: "wallet" },
        { label: "No-show rate", value: kept ? `${Math.round((noShows / kept) * 100)}%` : "—", foot: `${noShows} no-shows of ${kept}`, icon: "user" },
        { label: "Booked online", value: kept ? `${Math.round((online / kept) * 100)}%` : "—", foot: `${online} of ${kept} came through your booking page`, icon: "trend" },
        { label: "Customers seen", value: String(data.customers.customers), foot: `${data.customers.new_customers ?? 0} new in this period`, icon: "users" },
        { label: "Upcoming", value: String(data.upcoming.n), foot: `${money(data.upcoming.value || 0)} booked ahead · ${data.waitlist_open} on waitlist`, icon: "calendar" },
      ]
    : [];
  const peakHour = data?.hours.length ? data.hours.reduce((a, b) => (b.n > a.n ? b : a)) : null;
  return (
    <div className="workspace-settings insights">
      <section className="workspace-panel">
        <div className="workspace-section-heading">
          <div>
            <h2>Shop insights</h2>
            <p className="workspace-footnote">
              {data ? `${data.from} to ${data.to}` : "Loading…"} · saved appointment records only; value is booked service
              price, not collected payment.
            </p>
          </div>
          <div className="segmented" aria-label="Period">
            {[7, 30, 90, 365].map((n) => (
              <button type="button" key={n} aria-pressed={days === n} onClick={() => setDays(n)}>
                {n === 365 ? "Year" : `${n}d`}
              </button>
            ))}
          </div>
        </div>
        <ErrorMessage error={error} />
        <div className="stats-grid connected-stats insight-cards">
          {(cards.length ? cards : Array.from({ length: 6 }, (_, i) => ({ label: "…", value: "—", foot: "", icon: "loader", key: i }))).map((c, i) => (
            <article className="stat-card" key={i}>
              <div className="stat-label">
                {c.label}
                <Icon name={c.icon} />
              </div>
              <div className="stat-value">{c.value}</div>
              <div className="stat-foot">{c.foot}</div>
            </article>
          ))}
        </div>
      </section>
      {data && (
        <>
          <section className="workspace-panel">
            <h2>Busiest times</h2>
            <p className="workspace-footnote">
              {peakHour ? `Peak hour ${String(peakHour.hour).padStart(2, "0")}:00 with ${peakHour.n} starts.` : "No appointments in this period."}
            </p>
            <div className="insight-grid">
              <div>
                <h3>By hour</h3>
                <Bars
                  label="Appointments by start hour"
                  rows={Array.from({ length: Math.ceil(w.shop.closes / 60) - Math.floor(w.shop.opens / 60) }, (_, i) => {
                    const hour = Math.floor(w.shop.opens / 60) + i;
                    return { key: String(hour), label: `${String(hour).padStart(2, "0")}:00`, value: data.hours.find((h) => h.hour === hour)?.n || 0 };
                  })}
                />
              </div>
              <div>
                <h3>By weekday</h3>
                <Bars
                  label="Appointments by weekday"
                  rows={[1, 2, 3, 4, 5, 6, 0].map((d) => ({ key: String(d), label: dayNames[d], value: data.weekdays.find((x) => x.weekday === d)?.n || 0 }))}
                />
              </div>
            </div>
          </section>
          <section className="workspace-panel">
            <h2>Services and barbers</h2>
            <div className="insight-grid">
              <div>
                <h3>Most booked services</h3>
                {data.services.length ? (
                  <Bars
                    label="Services by bookings"
                    rows={data.services.map((s) => ({ key: s.name, label: s.name, value: s.n, sub: money(s.completed_value) }))}
                  />
                ) : (
                  <p className="workspace-footnote">No services booked yet.</p>
                )}
              </div>
              <div>
                <h3>Barbers</h3>
                {data.barbers.length ? (
                  <table className="customer-table insight-table">
                    <thead>
                      <tr>
                        <th scope="col">Barber</th>
                        <th scope="col">Visits</th>
                        <th scope="col">Hours</th>
                        <th scope="col">Completed</th>
                        <th scope="col">No-shows</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.barbers.map((b) => (
                        <tr key={b.staff_id}>
                          <td className="customer-name">{b.name}</td>
                          <td className="num" data-label="Visits">{b.n}</td>
                          <td className="num" data-label="Hours">{(b.minutes / 60).toFixed(1)}</td>
                          <td className="num" data-label="Completed">{money(b.completed_value)}</td>
                          <td className="num" data-label="No-shows">{b.no_shows}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="workspace-footnote">No barber activity yet.</p>
                )}
              </div>
            </div>
          </section>
          <section className="workspace-panel">
            <h2>Daily trend</h2>
            {data.daily.length ? (
              <div className="insight-trend" role="img" aria-label={`Appointments per day over ${days} days`}>
                {(() => {
                  const start = new Date(`${data.from}T12:00:00Z`);
                  const cells: { date: string; n: number; value: number }[] = [];
                  for (let i = 0; i < data.days; i++) {
                    const d = new Date(start);
                    d.setUTCDate(d.getUTCDate() + i);
                    const key = d.toISOString().slice(0, 10);
                    const row = data.daily.find((x) => x.date === key);
                    cells.push({ date: key, n: row?.n || 0, value: row?.completed_value || 0 });
                  }
                  const max = Math.max(1, ...cells.map((c) => c.n));
                  return cells.map((c) => (
                    <span
                      key={c.date}
                      className="insight-trend-bar"
                      style={{ height: `${Math.max(4, Math.round((c.n / max) * 100))}%` }}
                      title={`${c.date}: ${c.n} appointments, ${money(c.value)} completed`}
                    />
                  ));
                })()}
              </div>
            ) : (
              <p className="workspace-footnote">No appointments in this period.</p>
            )}
          </section>
        </>
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
// Settings → Shop page: content of the public home page at /<slug>. Presentation only.
type PageForm = { strapline: string; about: string; cover_url: string; gallery: string[]; phone: string; email: string; instagram: string; map_url: string; transport_note: string; policy_text: string; sections: string[]; accent: string; published: number; version: number };
const PAGE_SECTIONS: { key: string; label: string }[] = [
  { key: "hero", label: "Hero" },
  { key: "next", label: "Next available" },
  { key: "services", label: "Services" },
  { key: "team", label: "Team" },
  { key: "hours", label: "Opening hours" },
  { key: "gallery", label: "Gallery" },
  { key: "find", label: "Find us" },
  { key: "policies", label: "Good to know" },
];
function ShopPagePanel({ w }: { w: WorkspaceData }) {
  const [form, setForm] = useState<PageForm | null>(null);
  const [saved, setSavedForm] = useState<PageForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const load = () =>
    api<{ page: Record<string, unknown> }>("/shop/page").then((r) => {
      const p = r.page;
      const f: PageForm = {
        strapline: String(p.strapline || ""),
        about: String(p.about || ""),
        cover_url: String(p.cover_url || ""),
        gallery: JSON.parse(String(p.gallery_json || "[]")),
        phone: String(p.phone || ""),
        email: String(p.email || ""),
        instagram: String(p.instagram || ""),
        map_url: String(p.map_url || ""),
        transport_note: String(p.transport_note || ""),
        policy_text: String(p.policy_text || ""),
        sections: JSON.parse(String(p.sections_json || "[]")),
        accent: String(p.accent || "ollo"),
        published: Number(p.published ?? 1),
        version: Number(p.version ?? 0),
      };
      setForm(f);
      setSavedForm(f);
    });
  useEffect(() => {
    load().catch((e) => setState({ kind: "error", text: e instanceof Error ? e.message : "Could not load the page." }));
  }, [w.shop.version]);
  if (!form) return null;
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const live = !!w.shop.slug && w.shop.online_booking === 1;
  const url = w.shop.slug ? `${location.origin}/${w.shop.slug}` : "";
  const set = <K extends keyof PageForm>(k: K, v: PageForm[K]) => setForm({ ...form, [k]: v });
  return (
    <section className="workspace-panel" aria-labelledby="shop-page-heading" data-testid="shop-page-panel">
      <div className="workspace-section-heading">
        <div>
          <h2 id="shop-page-heading">Shop page</h2>
          <p className="workspace-footnote">Your public front door: customers land here and book from it. Services, team and hours come from the shop itself.</p>
        </div>
        {live && (
          <a className="button secondary" href={url} target="_blank" rel="noreferrer" data-testid="view-shop-page">
            <Icon name="external" size={15} /> View page
          </a>
        )}
      </div>
      <p className="page-live-link">
        {live ? (
          <>
            <StatusPill tone={form.published ? "good" : "note"}>{form.published ? "Published" : "Hidden"}</StatusPill> <code>{url}</code>
          </>
        ) : (
          <>
            <StatusPill tone="warn">Not live</StatusPill> Set a public address and turn on online booking above to publish.
          </>
        )}
      </p>
      <form
        className="page-editor"
        data-dirty={dirty ? "true" : undefined}
        aria-busy={busy}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setState(null);
          try {
            await api("/shop/page", "PUT", { ...form, gallery: form.gallery.filter(Boolean) });
            await load();
            setState({ kind: "ok", text: "Shop page saved." });
          } catch (err) {
            setState({ kind: "error", text: err instanceof Error ? err.message : "Could not save." });
            if (err instanceof ApiError && err.status === 409) load().catch(() => {});
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="studio-fieldset page-editor">
          <div className="workspace-form-grid">
            <Field label="Strapline">
              <input value={form.strapline} maxLength={120} placeholder="Sharp cuts, straight talk, no fuss." onChange={(e) => set("strapline", e.target.value)} />
            </Field>
            <Field label="Cover photo (https URL, optional)">
              <input type="url" value={form.cover_url} maxLength={500} placeholder="https://…/shopfront.jpg" onChange={(e) => set("cover_url", e.target.value)} />
            </Field>
          </div>
          <Field label="About the shop">
            <textarea rows={3} maxLength={1200} value={form.about} onChange={(e) => set("about", e.target.value)} />
          </Field>
          <div className="workspace-form-grid three">
            <Field label="Phone">
              <input value={form.phone} maxLength={20} placeholder="020 7946 0111" onChange={(e) => set("phone", e.target.value)} />
            </Field>
            <Field label="Email">
              <input type="email" value={form.email} maxLength={254} onChange={(e) => set("email", e.target.value)} />
            </Field>
            <Field label="Instagram">
              <input value={form.instagram} maxLength={40} placeholder="@handle" onChange={(e) => set("instagram", e.target.value)} />
            </Field>
          </div>
          <div className="workspace-form-grid">
            <Field label="Map link (https, optional)">
              <input type="url" value={form.map_url} maxLength={500} placeholder="Leave blank to use the address" onChange={(e) => set("map_url", e.target.value)} />
            </Field>
            <Field label="Getting here (parking, transport)">
              <input value={form.transport_note} maxLength={300} onChange={(e) => set("transport_note", e.target.value)} />
            </Field>
          </div>
          <Field label="House rules (shown under Good to know)">
            <textarea rows={3} maxLength={1200} value={form.policy_text} onChange={(e) => set("policy_text", e.target.value)} />
          </Field>
          <div>
            <span className="workspace-field"><span>Sections shown</span></span>
            <div className="page-sections" role="group" aria-label="Sections shown">
              {PAGE_SECTIONS.map((sec) => (
                <label key={sec.key}>
                  <input
                    type="checkbox"
                    checked={form.sections.includes(sec.key)}
                    onChange={(e) => set("sections", e.target.checked ? PAGE_SECTIONS.map((x) => x.key).filter((k) => k === sec.key || form.sections.includes(k)) : form.sections.filter((k) => k !== sec.key))}
                  />
                  {sec.label}
                </label>
              ))}
            </div>
          </div>
          <div className="workspace-form-grid">
            <div>
              <span className="workspace-field"><span>Accent colour</span></span>
              <div className="accent-picker" role="group" aria-label="Accent colour">
                {["ollo", "ink", "sage", "clay", "plum", "slate"].map((a) => (
                  <button key={a} type="button" className={`accent-swatch ${a}`} aria-label={a} aria-pressed={form.accent === a} onClick={() => set("accent", a)} />
                ))}
              </div>
            </div>
            <div>
              <span className="workspace-field"><span>Gallery (https image URLs, up to 12)</span></span>
              <div className="page-gallery-list">
                {form.gallery.map((u, i) => (
                  <div key={i}>
                    <input type="url" value={u} maxLength={500} aria-label={`Gallery image ${i + 1}`} onChange={(e) => set("gallery", form.gallery.map((x, j) => (j === i ? e.target.value : x)))} />
                    <Button variant="ghost" aria-label={`Remove gallery image ${i + 1}`} onClick={() => set("gallery", form.gallery.filter((_, j) => j !== i))}>
                      <Icon name="close" size={14} />
                    </Button>
                  </div>
                ))}
                {form.gallery.length < 12 && (
                  <Button variant="ghost" onClick={() => set("gallery", [...form.gallery, ""])}>
                    <Icon name="plus" size={14} /> Add image
                  </Button>
                )}
              </div>
            </div>
          </div>
          <div className="switch-row">
            <span>
              <strong>Published</strong>
              <small>Hidden pages still let customers book at /book/{w.shop.slug || "…"}.</small>
            </span>
            <label className="switch">
              <input type="checkbox" checked={!!form.published} onChange={(e) => set("published", e.target.checked ? 1 : 0)} aria-label="Published" />
              <span />
            </label>
          </div>
        </fieldset>
        <div className="panel-actions-row">
          <Button type="submit" disabled={busy || !dirty} data-testid="save-shop-page">
            {busy ? "Saving…" : "Save shop page"}
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setForm(saved)}>
              Revert
            </Button>
          )}
        </div>
        {state && (
          <p className={state.kind === "error" ? "workspace-error" : "workspace-success"} role={state.kind === "error" ? "alert" : "status"}>
            {state.text}
          </p>
        )}
      </form>
    </section>
  );
}

// Every customer-facing surface in one place so the owner can review them from the admin.
// Live pages open in a new tab; planned ones link to the plan so the roadmap is visible in-app.
function CustomerPagesPanel({ w, onOpenBooking }: { w: WorkspaceData; onOpenBooking: (id: string) => void }) {
  const [manageLink, setManageLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = !!w.shop.slug && w.shop.online_booking === 1;
  const bookUrl = w.shop.slug ? `${location.origin}/book/${w.shop.slug}` : "";
  const sample = w.bookings
    .filter((b) => ["CONFIRMED", "CHECKED_IN"].includes(b.status) && b.start_at > w.now)
    .sort((a, b) => a.start_at - b.start_at)[0];
  async function makeManageLink() {
    if (!sample) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ path: string }>(`/bookings/${sample.id}/manage-link`, "POST", {});
      setManageLink(location.origin + r.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create a link.");
    } finally {
      setBusy(false);
    }
  }
  const rows: { icon: string; title: string; note: string; status: "live" | "next" | "later"; action?: ReactNode }[] = [
    {
      icon: "store",
      title: "Direct booking link",
      note: live ? `${bookUrl} · booking flow only, for Instagram bios and QR codes` : w.shop.slug ? "Online booking is switched off above" : "Choose a public address above to enable",
      status: "live",
      action: live ? (
        <a className="button secondary" href={bookUrl} target="_blank" rel="noreferrer" data-testid="view-booking-page">
          <Icon name="external" size={15} /> Open
        </a>
      ) : undefined,
    },
    {
      icon: "calendar",
      title: "Manage-my-visit link",
      note: sample ? `Reschedule / cancel / add to calendar · sample uses ${sample.customer_name}'s next visit` : "Needs an upcoming appointment",
      status: "live",
      action: sample ? (
        manageLink ? (
          <a className="button secondary" href={manageLink} target="_blank" rel="noreferrer" data-testid="view-manage-page">
            <Icon name="external" size={15} /> Open link
          </a>
        ) : (
          <Button variant="secondary" disabled={busy} onClick={makeManageLink} data-testid="make-manage-link">
            {busy ? "Creating…" : "Create sample link"}
          </Button>
        )
      ) : (
        <Button variant="ghost" onClick={() => onOpenBooking("")} disabled>
          No upcoming visit
        </Button>
      ),
    },
    { icon: "bell", title: "Waitlist", note: "Customers join from the booking page when a day is full; you book them in from the bell.", status: "live" },
    {
      icon: "globe",
      title: "Shop home page",
      note: live ? `${location.origin}/${w.shop.slug} · the front door: hero, next available, services, team, booking, hours, find us, house rules` : "Publishes with online booking",
      status: "live",
      action: live ? (
        <a className="button secondary" href={`${location.origin}/${w.shop.slug}`} target="_blank" rel="noreferrer" data-testid="view-home-page">
          <Icon name="external" size={15} /> View as customer
        </a>
      ) : undefined,
    },
    { icon: "userRound", title: "Customer accounts", note: "Phone/email one-time code sign-in · upcoming, history, book my usual, profile, standing bookings", status: "next" },
    { icon: "repeat", title: "Booking flow upgrades", note: "Remember me · any barber · book for someone else · group booking", status: "next" },
    { icon: "message", title: "Reminders & reviews", note: "24h / 2h reminders with confirm links; post-visit star review with owner moderation", status: "later" },
    { icon: "card", title: "Deposits, loyalty, vouchers", note: "Card deposit at booking (Stripe), stamp card, gift vouchers bought online", status: "later" },
  ];
  const tone: Record<string, "good" | "next" | "note"> = { live: "good", next: "next", later: "note" };
  const label: Record<string, string> = { live: "Live", next: "Planned next", later: "Later · needs provider" };
  return (
    <section className="workspace-panel" aria-labelledby="customer-pages-heading" data-testid="customer-pages">
      <div className="workspace-section-heading">
        <div>
          <h2 id="customer-pages-heading">Customer pages</h2>
          <p className="workspace-footnote">Everything a customer sees, live and planned. Full plan: docs/CUSTOMER-PLAN.md.</p>
        </div>
        <a className="button ghost" href="/docs/customer-plan" target="_blank" rel="noreferrer">
          <Icon name="file" size={15} /> Read the plan
        </a>
      </div>
      <ErrorMessage error={error} />
      <ul className="customer-pages">
        {rows.map((r) => (
          <li key={r.title}>
            <span className="tx-ic">
              <Icon name={r.icon} size={16} />
            </span>
            <span className="customer-page-text">
              <b>
                {r.title} <StatusPill tone={tone[r.status]}>{label[r.status]}</StatusPill>
              </b>
              <small>{r.note}</small>
            </span>
            <span className="customer-page-action">{r.action}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Notifications drawer (bell): schedule issues and the waitlist live here, off the timetable.
function NotificationsDrawer({
  w,
  date,
  waitlist,
  onRefreshWaitlist,
  onBook,
  onReview,
  onClose,
}: {
  w: WorkspaceData;
  date: string;
  waitlist: WaitlistEntry[];
  onRefreshWaitlist: () => void;
  onBook: (entry: WaitlistEntry) => void;
  onReview: (bookingId: string) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  async function close(entry: WaitlistEntry) {
    setBusyId(entry.id);
    try {
      await api(`/waitlist/${entry.id}/status`, "POST", { status: "CLOSED", version: entry.version });
      onRefreshWaitlist();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update.");
    } finally {
      setBusyId("");
    }
  }
  const today = waitlist.filter((r) => r.date === date);
  const shown = expanded ? waitlist : today.length ? today : waitlist.slice(0, 3);
  const part: Record<string, string> = { ANY: "any time", MORNING: "morning", AFTERNOON: "afternoon", EVENING: "evening" };
  const total = w.issues.length + waitlist.length;
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer-right notifications-drawer" aria-label="Notifications" ref={ref} data-testid="notifications">
        <h2>
          Notifications
          <small>{total ? `${total} item${total === 1 ? "" : "s"}` : "All clear"}</small>
          <IconButton name="close" label="Close notifications" onClick={onClose} />
        </h2>
        {w.issues.length > 0 && (
          <section className="notify-group" aria-labelledby="notify-issues-heading">
            <h3 id="notify-issues-heading">
              <Icon name="blocked" size={16} /> Schedule review
              <span className="nav-count">{w.issues.length}</span>
            </h3>
            <p className="drawer-note left">Saved appointments that no longer fit the roster, hours or closures.</p>
            <ul className="notify-list">
              {w.issues.map((issue) => (
                <li key={issue.booking_id}>
                  <div>
                    <strong>{issue.ref}</strong>
                    <small>{issue.reason}</small>
                  </div>
                  <Button variant="secondary" onClick={() => onReview(issue.booking_id)}>
                    Review appointment
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="notify-group waitlist-panel" aria-labelledby="waitlist-panel-heading">
          <h3 id="waitlist-panel-heading">
            <Icon name="bell" size={16} /> Waitlist
            <span className="nav-count">{waitlist.length}</span>
          </h3>
          <p className="drawer-note left">
            {waitlist.length === 0
              ? "No one is waiting. Customers can join the waitlist from the public booking page when a day is full."
              : today.length
                ? `${today.length} customer${today.length === 1 ? "" : "s"} waiting for ${date === w.today ? "today" : "this day"}. Book them into a free slot or close the request.`
                : "Customers who asked to be contacted when a full day opens up. Nothing is reserved until you book them."}
          </p>
          <ErrorMessage error={error} />
          <ul className="notify-list">
            {shown.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>{r.customer_name}</strong>
                  <small>
                    {r.service_name} · {r.staff_name || "Any barber"} · {part[r.daypart]}
                  </small>
                  <small>
                    {new Date(`${r.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" })}
                    {" · "}
                    {r.phone}
                  </small>
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
          {waitlist.length > shown.length || expanded ? (
            <Button variant="ghost" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show fewer" : `Show all ${waitlist.length}`}
            </Button>
          ) : null}
        </section>
        <p className="drawer-note">Local test data · nothing here sends a message or takes a payment.</p>
      </aside>
    </>
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
  id: string;
  name: string;
  phone: string;
  email: string;
  tags: string;
  notes: string;
  preferred_staff_id: string | null;
  birthday: string | null;
  marketing_opt_in: number;
  version: number;
  created_at: number;
  visits: number;
  completed: number;
  no_shows: number;
  cancelled: number;
  completed_value_pence: number;
  first_visit_at: number | null;
  last_visit_at: number | null;
  next_visit_at: number | null;
  upcoming: number;
  favourite_staff_id: string | null;
  favourite_service: string | null;
};
type CustomerProfile = {
  customer: CustomerRow & { avg_spend_pence: number | null };
  bookings: StoredBooking[];
  barbers: { staff_id: string; name: string; n: number; last_at: number }[];
  services: { name: string; n: number; last_at: number }[];
  avg_gap_days: number | null;
  preferred_daypart: string | null;
  favourite_staff_id: string | null;
  favourite_service: string | null;
};
const customerFilters: [string, string][] = [
  ["all", "All"],
  ["upcoming", "Upcoming"],
  ["regulars", "Regulars"],
  ["new", "New (30d)"],
  ["lapsed", "Lapsed 60d+"],
  ["no_shows", "No-shows 2+"],
];
const shortDate = (ms: number | null) =>
  ms ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }).format(new Date(ms)) : "—";
const initialsOf = (name: string) => name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
function CustomersPanel({
  w,
  onOpen,
  selectedId,
  onSelect,
  onBook,
}: {
  w: WorkspaceData;
  onOpen: (b: StoredBooking) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onBook: (prefill: StoredBooking) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("recent");
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [profileError, setProfileError] = useState("");
  const [profileTab, setProfileTab] = useState<"history" | "details" | "notes">("history");
  const [reload, setReload] = useState(0);
  const sequence = useRef(0);
  const canEdit = !w.account || ["OWNER", "MANAGER", "RECEPTION"].includes(w.account.role);
  const canMerge = !w.account || ["OWNER", "MANAGER"].includes(w.account.role);
  useEffect(() => {
    const id = ++sequence.current;
    const handle = window.setTimeout(() => {
      api<{ customers: CustomerRow[] }>(
        `/customers?${new URLSearchParams({ q: query.trim(), filter, sort, limit: "200" })}`,
      )
        .then((r) => id === sequence.current && (setRows(r.customers), setError("")))
        .catch((e) => id === sequence.current && setError(e instanceof Error ? e.message : "Could not load customers."));
    }, 200);
    return () => window.clearTimeout(handle);
  }, [query, filter, sort, w.bookings.length, w.now, reload]);
  useEffect(() => {
    if (!selectedId) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    setProfileError("");
    api<CustomerProfile>(`/customers/${encodeURIComponent(selectedId)}`)
      .then((p) => !cancelled && setProfile(p))
      .catch((e) => !cancelled && setProfileError(e instanceof Error ? e.message : "Could not load this customer."));
    return () => {
      cancelled = true;
    };
  }, [selectedId, w.bookings.length, w.now, reload]);
  const staffName = (id: string | null | undefined) => w.staff.find((s) => s.id === id)?.name || "—";
  const totals = rows
    ? {
        n: rows.length,
        spend: rows.reduce((n, r) => n + (r.completed_value_pence || 0), 0),
        upcoming: rows.reduce((n, r) => n + (r.upcoming || 0), 0),
        noShows: rows.filter((r) => r.no_shows >= 2).length,
      }
    : null;
  function prefillFrom(c: CustomerRow, last?: StoredBooking): StoredBooking {
    const fav = c.favourite_staff_id || c.preferred_staff_id || last?.staff_id || "";
    const service = last ? w.services.find((s) => s.id === last.service_id) : w.services.find((s) => s.name === c.favourite_service);
    return {
      ...(last || ({} as StoredBooking)),
      id: last?.id || "",
      customer_id: c.id,
      customer_name: c.name,
      phone: c.phone,
      email: c.email,
      staff_id: fav,
      service_id: service?.id || last?.service_id || "",
      service_name: service?.name || last?.service_name || "",
      price_pence: last?.price_pence || service?.price_pence || 0,
      date: last?.date || w.today,
    } as StoredBooking;
  }
  return (
    <div className={`customers-layout ${selectedId ? "has-profile" : ""}`}>
      <section className="workspace-panel customers-directory" aria-labelledby="customers-heading">
        <div className="workspace-section-heading">
          <div>
            <h2 id="customers-heading">Customers</h2>
            <p className="workspace-footnote">
              {totals ? `${totals.n} shown · ${money(totals.spend)} completed · ${totals.upcoming} upcoming` : "Loading…"}
              {w.account?.role === "BARBER" ? " · your customers only" : ""}
            </p>
          </div>
          {canEdit && (
            <Button onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} /> Add customer
            </Button>
          )}
        </div>
        <div className="customers-toolbar">
          <label className="customers-search">
            <Icon name="search" size={16} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, mobile, email or tag"
              aria-label="Search customers"
            />
          </label>
          <label className="customers-sort">
            <span>Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort customers">
              <option value="recent">Last visit</option>
              <option value="next">Next visit</option>
              <option value="spend">Spend</option>
              <option value="visits">Visits</option>
              <option value="name">Name</option>
            </select>
          </label>
        </div>
        <div className="segmented customers-filters" aria-label="Customer filter">
          {customerFilters.map(([key, label]) => (
            <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
        <ErrorMessage error={error} />
        {adding && (
          <CustomerForm
            w={w}
            onDone={(c) => {
              setAdding(false);
              setReload((n) => n + 1);
              if (c) onSelect(c.id);
            }}
          />
        )}
        {rows && rows.length === 0 && <p className="workspace-footnote">No customers match.</p>}
        {rows && rows.length > 0 && (
          <ul className="customer-list" data-testid="customer-list">
            {rows.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`customer-row ${c.id === selectedId ? "selected" : ""}`}
                  onClick={() => {
                    onSelect(c.id);
                    setProfileTab("history");
                  }}
                  aria-current={c.id === selectedId ? "true" : undefined}
                >
                  <Avatar initials={initialsOf(c.name)} colour={["sage", "sand", "blue", "clay"][i % 4]} />
                  <div className="customer-row-main">
                    <strong>{c.name}</strong>
                    <small>
                      {c.phone}
                      {c.favourite_staff_id ? ` · ${staffName(c.favourite_staff_id)}` : ""}
                    </small>
                    {(JSON.parse(c.tags || "[]") as string[]).length > 0 && (
                      <span className="panel-tags">
                        {(JSON.parse(c.tags) as string[]).slice(0, 3).map((t) => (
                          <span className="tag" key={t}>{t}</span>
                        ))}
                      </span>
                    )}
                  </div>
                  <dl className="customer-row-stats">
                    <div><dt>Visits</dt><dd>{c.completed}</dd></div>
                    <div><dt>Spend</dt><dd>{money(c.completed_value_pence || 0)}</dd></div>
                    <div><dt>Last</dt><dd>{shortDate(c.last_visit_at)}</dd></div>
                    <div><dt>Next</dt><dd className={c.next_visit_at ? "good" : ""}>{shortDate(c.next_visit_at)}</dd></div>
                  </dl>
                  {c.no_shows >= 2 && <span className="tag warn" title="Two or more no-shows">{c.no_shows} no-shows</span>}
                  <Icon name="right" size={16} className="customer-row-chevron" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {selectedId && (
        <section className="workspace-panel customer-profile" aria-labelledby="customer-profile-heading" data-testid="customer-profile">
          <button type="button" className="panel-inline customer-back" onClick={() => onSelect(null)}>
            <Icon name="left" size={14} /> All customers
          </button>
          <ErrorMessage error={profileError} />
          {!profile && !profileError && <p className="workspace-footnote">Loading customer…</p>}
          {profile && (
            <>
              <header className="customer-profile-head">
                <Avatar initials={initialsOf(profile.customer.name)} colour="sage" size="large" />
                <div>
                  <h2 id="customer-profile-heading">{profile.customer.name}</h2>
                  <p>
                    <a href={`tel:${profile.customer.phone}`}>{profile.customer.phone}</a>
                    {profile.customer.email ? ` · ${profile.customer.email}` : ""}
                    {" · "}customer since {shortDate(profile.customer.first_visit_at || profile.customer.created_at)}
                  </p>
                  <div className="panel-tags">
                    {(JSON.parse(profile.customer.tags || "[]") as string[]).map((t) => (
                      <span className="tag" key={t}>{t}</span>
                    ))}
                    {profile.customer.no_shows >= 2 && <span className="tag warn">{profile.customer.no_shows} no-shows</span>}
                    {profile.customer.completed >= 4 && <span className="tag good">Regular</span>}
                  </div>
                </div>
                <div className="customer-profile-actions">
                  <Button onClick={() => onBook(prefillFrom(profile.customer, profile.bookings.find((b) => b.status === "COMPLETED")))}>
                    <Icon name="plus" size={16} /> New booking
                  </Button>
                </div>
              </header>
              <div className="stats-grid customer-stat-grid">
                <article className="stat-card">
                  <div className="stat-label">Lifetime spend <Icon name="wallet" /></div>
                  <div className="stat-value">{money(profile.customer.completed_value_pence || 0)}</div>
                  <div className="stat-foot">{profile.customer.avg_spend_pence ? `${money(Math.round(profile.customer.avg_spend_pence))} average` : "No completed visits"}</div>
                </article>
                <article className="stat-card">
                  <div className="stat-label">Visits <Icon name="calendarCheck" /></div>
                  <div className="stat-value">{profile.customer.completed}</div>
                  <div className="stat-foot">{profile.customer.upcoming} upcoming · {profile.customer.cancelled} cancelled</div>
                </article>
                <article className="stat-card">
                  <div className="stat-label">Reliability <Icon name="shield" /></div>
                  <div className="stat-value">
                    {profile.customer.visits ? `${Math.round(((profile.customer.visits - profile.customer.no_shows) / profile.customer.visits) * 100)}%` : "—"}
                  </div>
                  <div className="stat-foot">{profile.customer.no_shows} no-show{profile.customer.no_shows === 1 ? "" : "s"}</div>
                </article>
                <article className="stat-card">
                  <div className="stat-label">Rhythm <Icon name="clock" /></div>
                  <div className="stat-value">{profile.avg_gap_days ? `${profile.avg_gap_days}d` : "—"}</div>
                  <div className="stat-foot">
                    {profile.avg_gap_days ? "between visits" : "needs 2+ visits"}
                    {profile.preferred_daypart ? ` · ${profile.preferred_daypart}s` : ""}
                  </div>
                </article>
              </div>
              <div className="customer-favourites">
                <div>
                  <span className="eyebrow">Favourite barber</span>
                  <strong>{profile.favourite_staff_id ? staffName(profile.favourite_staff_id) : "Not yet"}</strong>
                  {profile.customer.preferred_staff_id && profile.customer.preferred_staff_id !== profile.favourite_staff_id && (
                    <small>Prefers {staffName(profile.customer.preferred_staff_id)}</small>
                  )}
                </div>
                <div>
                  <span className="eyebrow">Usual service</span>
                  <strong>{profile.favourite_service || "Not yet"}</strong>
                  {profile.services[1] && <small>also {profile.services[1].name}</small>}
                </div>
                <div>
                  <span className="eyebrow">Next visit</span>
                  <strong>{shortDate(profile.customer.next_visit_at)}</strong>
                  {profile.customer.next_visit_at && (
                    <small>{profile.bookings.find((b) => b.start_at === profile.customer.next_visit_at)?.service_name}</small>
                  )}
                </div>
              </div>
              <div className="segmented" aria-label="Customer sections">
                <button type="button" aria-pressed={profileTab === "history"} onClick={() => setProfileTab("history")}>History</button>
                <button type="button" aria-pressed={profileTab === "notes"} onClick={() => setProfileTab("notes")}>Notes & tags</button>
                <button type="button" aria-pressed={profileTab === "details"} onClick={() => setProfileTab("details")}>Details</button>
              </div>
              {profileTab === "history" && (
                <ol className="customer-history" aria-label="Visit history">
                  {profile.bookings.map((b) => (
                    <li key={b.id} className={b.status.toLowerCase()}>
                      <button type="button" onClick={() => onOpen(b)}>
                        <span className="history-date">
                          <strong>{b.date.slice(8)}</strong>
                          <small>{new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(b.date + "T12:00:00Z"))}</small>
                        </span>
                        <span className="history-main">
                          <strong>
                            {b.service_name}
                            {b.series_id ? " ↻" : ""}
                          </strong>
                          <small>
                            {time(b.start_min)} · {staffName(b.staff_id)}
                            {b.channel === "ONLINE" ? " · online" : ""}
                          </small>
                        </span>
                        <span className="history-side">
                          <Badge tone={b.status === "COMPLETED" ? "done" : b.status === "CANCELLED" ? "cancelled" : b.status === "NO_SHOW" ? "noshow" : "confirmed"}>{labels[b.status]}</Badge>
                          <strong>{money(b.price_pence)}</strong>
                        </span>
                      </button>
                    </li>
                  ))}
                  {!profile.bookings.length && <li className="workspace-footnote">No visits yet.</li>}
                </ol>
              )}
              {profileTab === "notes" && (
                <CustomerForm
                  w={w}
                  customer={profile.customer}
                  mode="notes"
                  readOnly={!canEdit}
                  onDone={() => setReload((n) => n + 1)}
                />
              )}
              {profileTab === "details" && (
                <>
                  <CustomerForm
                    w={w}
                    customer={profile.customer}
                    mode="details"
                    readOnly={!canEdit}
                    onDone={() => setReload((n) => n + 1)}
                  />
                  {canMerge && rows && rows.length > 1 && (
                    <MergeCustomer
                      customer={profile.customer}
                      candidates={rows.filter((r) => r.id !== profile.customer.id)}
                      onDone={(winner) => {
                        setReload((n) => n + 1);
                        onSelect(winner);
                      }}
                    />
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
function CustomerForm({
  w,
  customer,
  mode = "details",
  readOnly = false,
  onDone,
}: {
  w: WorkspaceData;
  customer?: CustomerRow;
  mode?: "details" | "notes";
  readOnly?: boolean;
  onDone: (c?: CustomerRow) => void;
}) {
  const [tags, setTags] = useState<string[]>(customer ? (JSON.parse(customer.tags || "[]") as string[]) : []);
  const [tagInput, setTagInput] = useState("");
  const suggestions = ["VIP", "Regular", "New", "Student", "Family", "Sensitive scalp", "Beard client", "Prefers quiet"].filter((t) => !tags.includes(t));
  function addTag(raw: string) {
    const t = raw.trim().slice(0, 24);
    if (t && !tags.includes(t) && tags.length < 12) setTags([...tags, t]);
    setTagInput("");
  }
  const notesOnly = mode === "notes";
  return (
    <SaveForm
      className={`customer-form ${notesOnly ? "notes" : ""}`}
      label={customer ? (notesOnly ? "Save notes & tags" : "Save customer") : "Add customer"}
      onSave={async (f) => {
        if (readOnly) throw new Error("Your account can view but not edit customers.");
        const body = {
          name: customer && notesOnly ? customer.name : text(f, "name"),
          phone: customer && notesOnly ? customer.phone : text(f, "phone"),
          email: customer && notesOnly ? customer.email : text(f, "email"),
          notes: notesOnly || !customer ? text(f, "notes") : customer.notes,
          tags: notesOnly || !customer ? tags : (JSON.parse(customer.tags || "[]") as string[]),
          birthday: customer && notesOnly ? customer.birthday || "" : text(f, "birthday"),
          preferred_staff_id: customer && notesOnly ? customer.preferred_staff_id || "" : text(f, "preferred_staff_id"),
          marketing_opt_in: customer && notesOnly ? customer.marketing_opt_in : f.get("marketing_opt_in") ? 1 : 0,
          ...(customer ? { version: customer.version } : {}),
        };
        const r = await api<{ customer: CustomerRow }>(customer ? `/customers/${customer.id}` : "/customers", customer ? "PUT" : "POST", body);
        onDone(r.customer);
      }}
    >
      <fieldset disabled={readOnly} className="customer-fieldset">
        {!notesOnly && (
          <div className="workspace-form-grid">
            <Field label="Full name">
              <input name="name" required minLength={2} maxLength={100} defaultValue={customer?.name} autoComplete="off" />
            </Field>
            <Field label="Mobile number">
              <input name="phone" type="tel" required defaultValue={customer?.phone} placeholder="07700 900123" autoComplete="off" />
            </Field>
            <Field label="Email (optional)">
              <input name="email" type="email" maxLength={254} defaultValue={customer?.email} autoComplete="off" />
            </Field>
            <Field label="Birthday (optional)">
              <input name="birthday" type="date" defaultValue={customer?.birthday || ""} />
            </Field>
            <Field label="Preferred barber">
              <select name="preferred_staff_id" defaultValue={customer?.preferred_staff_id || ""}>
                <option value="">No preference</option>
                {w.staff.filter((s) => s.active).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </Field>
            <label className="customer-check">
              <input type="checkbox" name="marketing_opt_in" defaultChecked={!!customer?.marketing_opt_in} />
              Happy to receive shop news (record only; nothing is sent)
            </label>
          </div>
        )}
        {(notesOnly || !customer) && (
          <>
            <Field label="Notes (preferences, allergies, how they like it)">
              <textarea name="notes" maxLength={1000} rows={4} defaultValue={customer?.notes} />
            </Field>
            <div className="tag-editor">
              <span className="field-label">Tags</span>
              <div className="panel-tags editable">
                {tags.map((t) => (
                  <span className="tag" key={t}>
                    {t}
                    {!readOnly && (
                      <button type="button" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}>×</button>
                    )}
                  </span>
                ))}
                {!readOnly && (
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        addTag(tagInput);
                      }
                    }}
                    onBlur={() => tagInput && addTag(tagInput)}
                    placeholder={tags.length ? "Add tag" : "Add a tag and press Enter"}
                    aria-label="Add tag"
                    maxLength={24}
                  />
                )}
              </div>
              {!readOnly && suggestions.length > 0 && (
                <div className="tag-suggestions">
                  {suggestions.slice(0, 6).map((t) => (
                    <button type="button" key={t} onClick={() => addTag(t)}>+ {t}</button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </fieldset>
      {readOnly && <p className="workspace-footnote">View only for your role.</p>}
    </SaveForm>
  );
}
function MergeCustomer({
  customer,
  candidates,
  onDone,
}: {
  customer: CustomerRow;
  candidates: CustomerRow[];
  onDone: (winnerId: string) => void;
}) {
  const [into, setInto] = useState("");
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <p className="customer-merge-hint">
        Duplicate record?{" "}
        <button type="button" className="panel-inline" onClick={() => setOpen(true)}>
          Merge into another customer
        </button>
      </p>
    );
  return (
    <SaveForm
      className="customer-merge"
      label="Merge records"
      onSave={async () => {
        if (!into) throw new Error("Choose the customer to keep.");
        await api(`/customers/${customer.id}/merge`, "POST", { into, version: customer.version });
        onDone(into);
      }}
    >
      <Notice tone="warning">
        Every visit of <strong>{customer.name}</strong> moves to the chosen record. This record is kept as a
        pointer so old links still work. Cannot be undone.
      </Notice>
      <Field label="Keep this customer">
        <select value={into} onChange={(e) => setInto(e.target.value)} required>
          <option value="">Choose…</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>{c.name} · {c.phone}</option>
          ))}
        </select>
      </Field>
      <Button variant="ghost" type="button" onClick={() => setOpen(false)}>Cancel</Button>
    </SaveForm>
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
                    : e.kind === "hours"
                          ? `${e.item.name} · weekly hours`
                          : e.kind === "booking"
                            ? e.item
                              ? "Reschedule appointment"
                              : "New test booking"
                            : e.kind === "detail"
                              ? reference(e.item)
                              : e.kind === "share"
                                ? `Share ${reference(e.item)}`
                                : e.kind === "seriesMove"
                                  ? "Move standing booking"
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
      {e.kind === "share" && (
        <div className="share-editor">
          <p className="workspace-footnote">
            {e.item.customer_name} · {e.item.date} at {time(e.item.start_min)} · {e.item.service_name}
          </p>
          <ShareBooking booking={e.item} w={w} />
        </div>
      )}
      {e.kind === "seriesMove" && <SeriesMoveForm booking={e.item} w={w} saved={saved} />}
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

function SeriesMoveForm({
  booking: b,
  w,
  saved,
}: {
  booking: StoredBooking;
  w: WorkspaceData;
  saved: EditorProps["saved"];
}) {
  const [staff, setStaff] = useState(b.staff_id);
  const [start, setStart] = useState(b.start_min);
  const [shift, setShift] = useState(0);
  const [scope, setScope] = useState<"this" | "all">("this");
  const [result, setResult] = useState<{ moved: StoredBooking[]; failed: { date: string; reason: string }[] } | null>(null);
  const times = Array.from({ length: (w.shop.closes - w.shop.opens) / 15 }, (_, i) => w.shop.opens + i * 15);
  return (
    <SaveForm
      label="Move remaining visits"
      onSave={async (f) => {
        const r = (await saved(`/series/${b.series_id}/reschedule`, "POST", {
          staff_id: staff,
          start_min: start,
          day_shift: shift,
          reason: text(f, "reason"),
          ...(scope === "this" ? { from_booking_id: b.id } : {}),
        })) as unknown as { moved: StoredBooking[]; failed: { date: string; reason: string }[] };
        setResult(r);
      }}
    >
      <Notice>
        Every remaining confirmed visit in this standing booking is moved to the new weekly time. Visits
        that do not fit (day off, clash, closed) are left where they are and listed afterwards.
      </Notice>
      <div className="panel-radio">
        <label><input type="radio" checked={scope === "this"} onChange={() => setScope("this")} /> This visit and later</label>
        <label><input type="radio" checked={scope === "all"} onChange={() => setScope("all")} /> All remaining visits</label>
      </div>
      <div className="workspace-form-grid">
        <Field label="Barber">
          <select value={staff} onChange={(e) => setStaff(e.target.value)}>
            {w.staff.filter((s) => s.active).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label="New start time">
          <select value={start} onChange={(e) => setStart(Number(e.target.value))}>
            {times.map((t) => (
              <option key={t} value={t}>{time(t)}</option>
            ))}
          </select>
        </Field>
        <Field label="Shift weekday">
          <select value={shift} onChange={(e) => setShift(Number(e.target.value))}>
            {[-3, -2, -1, 0, 1, 2, 3].map((d) => (
              <option key={d} value={d}>{d === 0 ? "Same weekday" : `${d > 0 ? "+" : ""}${d} day${Math.abs(d) === 1 ? "" : "s"}`}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Reason">
        <textarea name="reason" required minLength={3} maxLength={300} />
      </Field>
      {result && (
        <p role="status" className="series-result">
          {result.moved.length} moved{result.failed.length ? `, ${result.failed.length} kept in place (${result.failed.map((f) => `${f.date}: ${f.reason}`).join("; ")})` : ""}.
        </p>
      )}
    </SaveForm>
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
type PickedCustomer = { id: string | null; name: string; phone: string; favourite_staff_id?: string | null; email?: string };
// Search-or-add customer control for the booking form. Hidden inputs keep the existing
// FormData contract (customer_name / phone) so the save path is unchanged.
function CustomerPicker({
  w,
  initial,
  onChange,
}: {
  w: WorkspaceData;
  initial: PickedCustomer | null;
  onChange: (c: PickedCustomer | null) => void;
}) {
  const [pickedId, setPickedId] = useState<string | null>(initial?.id ?? null);
  const [pickedFav, setPickedFav] = useState<string | null | undefined>(initial?.favourite_staff_id);
  const [name, setName] = useState(initial?.name || "");
  const [phone, setPhone] = useState(initial?.phone || "");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CustomerRow[] | null>(null);
  const [active, setActive] = useState(0);
  const [duplicate, setDuplicate] = useState<CustomerRow | null>(null);
  const seq = useRef(0);
  const open = query.trim().length > 0;
  useEffect(() => {
    if (!open) {
      setResults(null);
      return;
    }
    const id = ++seq.current;
    const handle = window.setTimeout(() => {
      api<{ customers: CustomerRow[] }>(`/customers?${new URLSearchParams({ q: query.trim(), limit: "8" })}`)
        .then((r) => id === seq.current && (setResults(r.customers), setActive(0)))
        .catch(() => id === seq.current && setResults([]));
    }, 180);
    return () => window.clearTimeout(handle);
  }, [query, open]);
  // Warn when a typed mobile already belongs to a record that was not picked.
  useEffect(() => {
    const digits = phone.replace(/[\s()-]/g, "");
    if (pickedId || !/^(?:\+44|0)7\d{9}$/.test(digits)) {
      setDuplicate(null);
      return;
    }
    const id = ++seq.current + 100000;
    api<{ customers: CustomerRow[] }>(`/customers?${new URLSearchParams({ q: digits, limit: "1" })}`)
      .then((r) => setDuplicate(r.customers.find((c) => c.phone === digits) || null))
      .catch(() => {});
    return () => void id;
  }, [phone, pickedId]);
  useEffect(() => {
    onChange(name.trim() && phone.trim() ? { id: pickedId, name, phone, favourite_staff_id: pickedFav } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedId, name, phone]);
  const staffName = (id: string | null | undefined) => w.staff.find((s) => s.id === id)?.name;
  function choose(c: CustomerRow) {
    setPickedId(c.id);
    setPickedFav(c.favourite_staff_id || c.preferred_staff_id);
    setName(c.name);
    setPhone(c.phone);
    setQuery("");
  }
  return (
    <div className="customer-picker" data-testid="customer-picker">
      <label className="customers-search">
        <Icon name="search" size={16} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find an existing customer by name, mobile or email"
          aria-label="Find customer"
          aria-describedby="customer-picker-hint"
          autoComplete="off"
          onKeyDown={(e) => {
            if (!results?.length) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            if (e.key === "Enter") { e.preventDefault(); choose(results[active]); }
            if (e.key === "Escape") setQuery("");
          }}
        />
      </label>
      <p id="customer-picker-hint" className="visually-hidden">
        Use the arrow keys and Enter to choose a match, or type a new customer below.
      </p>
      {open && (
        <ul className="customer-picker-results" aria-label="Matching customers">
          {results === null && <li className="workspace-footnote">Searching…</li>}
          {results?.map((c, i) => (
            <li key={c.id}>
              <button type="button" className={i === active ? "active" : ""} aria-current={i === active ? "true" : undefined} onMouseEnter={() => setActive(i)} onClick={() => choose(c)}>
                <Avatar initials={initialsOf(c.name)} colour={["sage", "sand", "blue", "clay"][i % 4]} />
                <span className="customer-picker-main">
                  <strong>{c.name}</strong>
                  <small>
                    {c.phone} · {c.completed} visit{c.completed === 1 ? "" : "s"}
                    {c.favourite_staff_id && staffName(c.favourite_staff_id) ? ` · ${staffName(c.favourite_staff_id)}` : ""}
                    {c.favourite_service ? ` · ${c.favourite_service}` : ""}
                  </small>
                </span>
                <small className="customer-picker-side">{c.last_visit_at ? `last ${shortDate(c.last_visit_at)}` : c.next_visit_at ? `next ${shortDate(c.next_visit_at)}` : "no visits"}</small>
              </button>
            </li>
          ))}
          {results && results.length === 0 && <li className="workspace-footnote">No matching customers — fill in the details below to add them.</li>}
        </ul>
      )}
      {pickedId && (
        <p className="customer-picked-note" data-testid="customer-picked" role="status">
          <Icon name="check" size={14} /> Existing customer{pickedFav && staffName(pickedFav) ? ` · usually ${staffName(pickedFav)}` : ""}.{" "}
          <button type="button" className="panel-inline" onClick={() => { setPickedId(null); setPickedFav(null); }}>
            Book as someone else
          </button>
        </p>
      )}
      <div className="workspace-form-grid">
        <Field label="Fictional customer name">
          <input
            name="customer_name"
            value={name}
            onChange={(e) => { setName(e.target.value); if (pickedId) setPickedId(null); }}
            required
            minLength={2}
            maxLength={100}
            autoComplete="off"
          />
        </Field>
        <Field label="Test UK mobile number">
          <input
            name="phone"
            value={phone}
            onChange={(e) => { setPhone(e.target.value); if (pickedId) setPickedId(null); }}
            type="tel"
            required
            placeholder="07700 900123"
            autoComplete="off"
          />
        </Field>
      </div>
      {duplicate && (
        <p className="customer-duplicate" role="status">
          <Icon name="help" size={14} /> {duplicate.name} already has this number ·{" "}
          <button type="button" className="panel-inline" onClick={() => choose(duplicate)}>
            use existing record
          </button>
        </p>
      )}
      {!pickedId && <p className="workspace-footnote">New names are saved as a customer record with the booking.</p>}
    </div>
  );
}
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
  // Standing bookings: repeat every N weeks; the server previews each date before anything is written.
  const [repeat, setRepeat] = useState(false);
  const [intervalWeeks, setIntervalWeeks] = useState(2);
  const [occurrences, setOccurrences] = useState(6);
  const [skipDates, setSkipDates] = useState<string[]>([]);
  const [seriesPreview, setSeriesPreview] = useState<{
    dates: { date: string; reason: string | null; skipped: boolean }[];
    bookable: number;
  } | null>(null);
  const [seriesResult, setSeriesResult] = useState<{
    created: number;
    failed: { date: string; reason: string }[];
  } | null>(null);
  const seriesOn = repeat && !b;
  const [pickedCustomer, setPickedCustomer] = useState<PickedCustomer | null>(
    rebook?.customer_id ? { id: rebook.customer_id, name: rebook.customer_name, phone: rebook.phone } : null,
  );
  function seriesBody(f: FormData) {
    return {
      staff_id: staff,
      service_id: service,
      date,
      start_min: Number(start),
      customer_name: text(f, "customer_name"),
      phone: text(f, "phone"),
      notes: text(f, "notes"),
      source: text(f, "source"),
      quote: slots?.quote,
      addon_ids: addonIds,
      ...(pickedCustomer?.id ? { customer_id: pickedCustomer.id } : {}),
      interval_weeks: intervalWeeks,
      occurrences,
      skip_dates: skipDates,
    };
  }
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
            : seriesOn
              ? `Confirm standing booking (${seriesPreview?.bookable ?? 0} dates)`
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
          if (seriesOn) {
            const preview = await api<NonNullable<typeof seriesPreview>>(
              "/series/preview",
              "POST",
              seriesBody(f),
            );
            setSeriesPreview(preview);
          }
          setReview(true);
          return;
        }
        if (seriesOn) {
          const body = seriesBody(f);
          const unresolved = seriesPreview?.dates.filter((d) => d.reason && !d.skipped) || [];
          if (unresolved.length)
            throw new Error(
              `Skip the ${unresolved.length} unavailable date${unresolved.length === 1 ? "" : "s"} before saving.`,
            );
          try {
            const result = await saved("/series", "POST", body);
            const r = result as unknown as {
              created: StoredBooking[];
              failed: { date: string; reason: string }[];
            };
            setSeriesResult({ created: r.created.length, failed: r.failed });
            if (waitlist && r.created[0])
              api(`/waitlist/${waitlist.id}/status`, "POST", {
                status: "BOOKED",
                booking_id: r.created[0].id,
                version: waitlist.version,
              }).catch(() => {});
          } catch (e) {
            setReview(false);
            if (e instanceof ApiError && e.status === 409) setRefresh((n) => n + 1);
            throw e;
          }
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
              ...(pickedCustomer?.id ? { customer_id: pickedCustomer.id } : {}),
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
              <CustomerPicker
                w={w}
                initial={
                  rebook
                    ? { id: rebook.customer_id || null, name: rebook.customer_name, phone: rebook.phone }
                    : null
                }
                onChange={(c) => {
                  setPickedCustomer(c);
                  // A returning customer brings their favourite barber/service when nothing was chosen yet.
                  if (c?.favourite_staff_id && !draft && !rebook && w.staff.some((s) => s.id === c.favourite_staff_id && s.active))
                    setStaff(c.favourite_staff_id);
                }}
              />
              <Field label="Booking source">
                <select name="source">
                  <option value="TEST_BOOKING">Test booking</option>
                  <option value="WALK_IN">Walk-in</option>
                </select>
              </Field>
              <Field label="Test notes">
                <textarea name="notes" maxLength={500} />
              </Field>
              <fieldset className="series-options" data-testid="series-options">
                <legend>
                  <Icon name="repeat" /> Standing booking
                </legend>
                <label className="series-toggle">
                  <input
                    type="checkbox"
                    checked={repeat}
                    onChange={(e) => {
                      setRepeat(e.target.checked);
                      setSkipDates([]);
                      setSeriesPreview(null);
                    }}
                  />
                  Repeat this appointment at the same time
                </label>
                {repeat && (
                  <div className="series-controls">
                    <Field label="Every">
                      <select
                        value={intervalWeeks}
                        onChange={(e) => {
                          setIntervalWeeks(Number(e.target.value));
                          setSkipDates([]);
                        }}
                        aria-describedby="series-hint"
                      >
                        {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>
                            {n === 1 ? "week" : `${n} weeks`}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Visits">
                      <input
                        type="number"
                        min={2}
                        max={26}
                        value={occurrences}
                        onChange={(e) => {
                          setOccurrences(
                            Math.min(26, Math.max(2, Number(e.target.value) || 2)),
                          );
                          setSkipDates([]);
                        }}
                      />
                    </Field>
                    <p id="series-hint" className="workspace-footnote">
                      Up to 26 visits, every 1–12 weeks. Each date is checked
                      against the roster and time off before anything is saved;
                      you can skip individual dates on the review step.
                    </p>
                  </div>
                )}
              </fieldset>
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
            {seriesOn && seriesPreview && (
              <div className="series-preview" data-testid="series-preview">
                <p>
                  <strong>
                    Standing booking · every{" "}
                    {intervalWeeks === 1 ? "week" : `${intervalWeeks} weeks`} ·{" "}
                    {seriesPreview.bookable} of {seriesPreview.dates.length} dates
                    bookable
                  </strong>
                </p>
                <ul className="series-dates">
                  {seriesPreview.dates.map((d) => (
                    <li
                      key={d.date}
                      className={
                        d.skipped ? "is-skipped" : d.reason ? "is-blocked" : "is-free"
                      }
                    >
                      <span className="series-date">{d.date}</span>
                      <span className="series-reason">
                        {d.skipped ? "Skipped" : d.reason || "Available"}
                      </span>
                      <label>
                        <input
                          type="checkbox"
                          checked={d.skipped}
                          aria-label={`Skip ${d.date}`}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...skipDates, d.date]
                              : skipDates.filter((x) => x !== d.date);
                            setSkipDates(next);
                            setSeriesPreview({
                              dates: seriesPreview.dates.map((x) =>
                                x.date === d.date ? { ...x, skipped: e.target.checked } : x,
                              ),
                              bookable: seriesPreview.dates.filter(
                                (x) =>
                                  !(x.date === d.date ? e.target.checked : x.skipped) &&
                                  !x.reason,
                              ).length,
                            });
                          }}
                        />
                        Skip
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="workspace-footnote">
                  Unavailable dates must be skipped before saving. Every visit is
                  saved as its own appointment under one series and can be moved
                  or cancelled individually later.
                </p>
              </div>
            )}
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
      {seriesResult && (
        <p role="status" className="series-result">
          Standing booking saved: {seriesResult.created} appointments created
          {seriesResult.failed.length
            ? `, ${seriesResult.failed.length} failed (${seriesResult.failed.map((f) => `${f.date}: ${f.reason}`).join("; ")})`
            : ""}
          .
        </p>
      )}
      <p className="workspace-footnote">
        Local test workflow only. Times are Europe/London. Data is saved only
        after confirmation.
      </p>
    </SaveForm>
  );
}
