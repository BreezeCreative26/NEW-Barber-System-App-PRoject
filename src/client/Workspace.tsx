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
  StaffBlock,
} from "../server/domain";
import { Brand, Button, Icon, IconButton, Modal, Notice, Badge, Avatar, TopBar, Rail, TabBar, StatusPill, type NavItem } from "./ui";
import { AppointmentPanel, type Timeline } from "./AppointmentPanel";
import { ServiceStudio, BarberStudio } from "./Studio";
import { Calendar, WeekStrip, WeekView, blockLabel, type CalendarDraft, type RangeBooking } from "./Calendar";
import { BlockDialog } from "./BlockDialog";
import { PayRunsPage, MyPay } from "./PayRunsPage";
import { Shifts } from "./Shifts";
import { BillingPanel } from "./Billing";
import { ConflictResolver, ConflictOutcome, type Preview as ConflictPreview, type Decision as ConflictDecision, type Outcome as ConflictOutcomeRow, type ScheduleChange } from "./ConflictResolver";
import { WalletDrawer } from "./Wallet";
import { PaymentsPanel } from "./Payouts";
import { SetupWizard } from "./Setup";
import { SearchPalette, AccountMenu } from "./Palette";
import { PhotoUpload, PhotoPreview } from "./Media";
import { money, time, datePlus, shopWeekOf, shopDayOf, setCurrency, currencySymbol, type ShopDayLite } from "./fixtures";

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
    const response = await fetch(`/api/app${path}`, {
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
          "Your session has expired. Sign in again.",
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
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const labelId = useId();
  const hintId = useId();
  return (
    <label className="workspace-field">
      <span id={labelId}>{label}</span>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            "aria-labelledby": labelId,
            ...(hint ? { "aria-describedby": hintId } : {}),
          })
        : children}
      {hint && <small id={hintId} className="field-help">{hint}</small>}
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
const DEMO_ENABLED_KEY = "ollo:demo";
type AuthMode = "signin" | "signup" | "invite" | "forgot" | "reset";
type InvitePeek = { shop_name: string; logo_url: string; staff_name: string; role: string; inviter: string; email: string; email_fixed: boolean; phone_hint: string; expires_at: number };
// Real front door. `/signin` and `/signup` render this; `/workspace` shows it when signed out.
// The demo shortcut appears only when the server reports DEMO_ENABLED=1.
function AuthScreen({ token = "", onDone }: { token?: string; onDone: () => Promise<void> }) {
  const resetToken = new URLSearchParams(location.search).get("token") || "";
  const initial: AuthMode = token ? "invite" : location.pathname === "/signup" ? "signup" : location.pathname === "/forgot" ? "forgot" : location.pathname === "/reset" && resetToken ? "reset" : "signin";
  const [mode, setMode] = useState<AuthMode>(initial);
  const [kind, setKind] = useState<"BARBER" | "HAIR" | "SALON">("BARBER");
  const [peek, setPeek] = useState<InvitePeek | null>(null);
  const [peekError, setPeekError] = useState("");
  const [forgotSent, setForgotSent] = useState<{ delivery: string[]; sandbox_token?: string } | null>(null);
  const [resetState, setResetState] = useState<{ email_hint: string } | { error: string } | null>(null);
  useEffect(() => {
    if (token) api<InvitePeek>(`/auth/invites/peek?token=${encodeURIComponent(token)}`).then(setPeek).catch((e) => setPeekError(e.message));
  }, [token]);
  useEffect(() => {
    if (mode === "reset" && resetToken) api<{ email_hint: string }>(`/auth/reset/peek?token=${encodeURIComponent(resetToken)}`).then(setResetState).catch((e) => setResetState({ error: e.message }));
  }, [mode, resetToken]);
  const [demo, setDemo] = useState<boolean>(() => sessionStorage.getItem(DEMO_ENABLED_KEY) === "1");
  const [demoBusy, setDemoBusy] = useState("");
  const [demoError, setDemoError] = useState("");
  useEffect(() => {
    api<{ demo: boolean }>("/auth/me")
      .then((r) => {
        setDemo(!!r.demo);
        sessionStorage.setItem(DEMO_ENABLED_KEY, r.demo ? "1" : "0");
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (mode !== "invite" && mode !== "reset") {
      const path = mode === "signup" ? "/signup" : mode === "forgot" ? "/forgot" : "/signin";
      if (location.pathname !== path && location.pathname !== "/workspace") history.replaceState(null, "", path);
    }
  }, [mode]);
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London";
    } catch {
      return "Europe/London";
    }
  })();
  async function openDemo(as: "owner" | "barber") {
    setDemoBusy(as);
    setDemoError("");
    try {
      await api("/auth/demo", "POST", { as });
      await onDone();
    } catch (e) {
      setDemoError(e instanceof Error ? e.message : "Could not open the demo shop.");
    } finally {
      setDemoBusy("");
    }
  }
  return (
    <div className="auth-screen">
      <aside className="auth-brand" aria-hidden="true">
        <img className="auth-brand-logo" src="/static/brand/foliyo-wordmark-white.svg" alt="foliyo" width={128} height={48} />
        <div className="auth-brand-copy">
          <p className="auth-brand-eyebrow">Booking software for any appointment business</p>
          <h1>Built for people<br />who run on appointments.</h1>
          <p className="auth-brand-tag">Book · Manage · Show up</p>
        </div>
        <ul className="auth-brand-points">
          <li>One fair monthly price, no commission</li>
          <li>WhatsApp, text &amp; email confirmations</li>
          <li>Your logo on everything your customers see</li>
        </ul>
      </aside>
      <div className="auth-main">
      <section className="workspace-panel account-entry auth-card" aria-labelledby="auth-heading">
        <Brand />
        {mode !== "invite" && (
          <div className="auth-tabs" role="tablist" aria-label="Sign in or create a shop">
            <button type="button" role="tab" aria-selected={mode === "signin"} onClick={() => setMode("signin")}>
              Sign in
            </button>
            <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => setMode("signup")}>
              Create your shop
            </button>
          </div>
        )}
        {mode === "invite" && peek && (
          <div className="auth-invite-card" data-testid="invite-peek">
            {peek.logo_url ? <img src={peek.logo_url} alt="" width={44} height={44} /> : <span className="auth-invite-mark" aria-hidden="true">{peek.shop_name.slice(0, 1)}</span>}
            <div>
              <strong>{peek.shop_name}</strong>
              <span>{peek.inviter ? `${peek.inviter} invited you` : "You've been invited"} as <b>{peek.staff_name}</b> · {peek.role.charAt(0) + peek.role.slice(1).toLowerCase()}</span>
            </div>
          </div>
        )}
        <h2 id="auth-heading">
          {mode === "invite" ? (peek ? `Join ${peek.shop_name}` : "Accept your invitation") : mode === "signup" ? "Set up your shop" : mode === "forgot" ? "Forgot your password?" : mode === "reset" ? "Choose a new password" : "Welcome back"}
        </h2>
        <p>
          {mode === "invite"
            ? peekError || (peek?.email_fixed ? "Choose a password. Your login is the email the invitation went to." : "Enter the email you'd like to sign in with and choose a password.")
            : mode === "signup"
              ? "Your shop, your team and online booking in a few minutes. You'll be added as the first person on the team."
              : mode === "forgot"
                ? "Enter your login email. We'll send a link to choose a new password — it works for 30 minutes."
                : mode === "reset"
                  ? resetState && "error" in resetState ? resetState.error : resetState ? `For ${resetState.email_hint}. At least 12 characters.` : "Checking your link…"
                  : "Sign in to your shop's workspace."}
        </p>
        {mode === "forgot" && forgotSent ? (
          <div className="auth-sent" role="status" data-testid="forgot-sent">
            <Icon name="send" />
            <p>If that address has an account, a reset link is on its way{forgotSent.delivery.includes("sms") ? " by email and text" : ""}. Check spam if it hasn't arrived in a minute.</p>
            {forgotSent.sandbox_token && <p className="helper">No email provider is connected here, so: <a href={`/reset?token=${forgotSent.sandbox_token}`} data-testid="sandbox-reset-link">open the reset link</a>.</p>}
            <button type="button" className="linklike" onClick={() => setMode("signin")}>Back to sign in</button>
          </div>
        ) : mode === "reset" && resetState && "error" in resetState ? (
          <p className="helper auth-switch"><button type="button" className="linklike" onClick={() => { history.replaceState(null, "", "/forgot"); setMode("forgot"); }}>Request a new link</button></p>
        ) : mode === "invite" && peekError ? (
          <p className="helper auth-switch"><button type="button" className="linklike" onClick={() => { history.replaceState(null, "", "/signin"); location.reload(); }}>Go to sign in</button></p>
        ) : (
        <SaveForm
          key={mode}
          label={mode === "invite" ? "Join the team" : mode === "signup" ? "Create shop" : mode === "forgot" ? "Send reset link" : mode === "reset" ? "Set password and sign in" : "Sign in"}
          onSave={async (f) => {
            if (mode === "signup")
              await api("/auth/signup", "POST", {
                shop_name: text(f, "shop_name"),
                name: text(f, "name"),
                email: text(f, "email"),
                password: text(f, "password"),
                timezone: tz,
                kind,
              });
            else if (mode === "invite")
              await api("/auth/accept", "POST", { email: peek?.email_fixed ? peek.email : text(f, "email"), password: text(f, "password"), name: text(f, "name"), token });
            else if (mode === "forgot") {
              const r = await api<{ delivery: string[]; sandbox_token?: string }>("/auth/forgot", "POST", { email: text(f, "email") });
              setForgotSent(r);
              return;
            } else if (mode === "reset") await api("/auth/reset", "POST", { token: resetToken, password: text(f, "password") });
            else await api("/auth/login", "POST", { email: text(f, "email"), password: text(f, "password") });
            history.replaceState(null, "", mode === "signup" ? "/workspace/setup" : "/workspace");
            await onDone();
          }}
        >
          {mode === "signup" && (
            <>
              <Field label="Shop name">
                <input name="shop_name" autoComplete="organization" required minLength={2} maxLength={100} placeholder="e.g. Fade Society" />
              </Field>
              <div className="auth-kind" role="radiogroup" aria-label="What kind of shop">
                {(["BARBER", "HAIR", "SALON"] as const).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} data-testid={`signup-kind-${k}`}>
                    <Icon name={k === "BARBER" ? "razor" : k === "HAIR" ? "scissors" : "sparkles"} size={16} /> {k === "BARBER" ? "Barbershop" : k === "HAIR" ? "Hairdresser" : "Salon"}
                  </button>
                ))}
              </div>
            </>
          )}
          {(mode === "signup" || mode === "invite") && (
            <Field label="Your name">
              <input name="name" autoComplete="name" required minLength={2} maxLength={100} />
            </Field>
          )}
          {mode !== "reset" && !(mode === "invite" && peek?.email_fixed) && (
            <Field label="Email">
              <input name="email" type="email" autoComplete="username" required maxLength={254} inputMode="email" />
            </Field>
          )}
          {mode === "invite" && peek?.email_fixed && (
            <Field label="Email"><input value={peek.email} readOnly aria-readonly /></Field>
          )}
          {mode !== "forgot" && (
            <Field label={mode === "reset" ? "New password" : "Password"}>
              <input
                name="password"
                type="password"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                required
                minLength={mode === "signin" ? 1 : 12}
                maxLength={128}
              />
            </Field>
          )}
          {(mode === "signup" || mode === "invite") && <p className="helper">At least 12 characters.{mode === "signup" ? ` Timezone will be set to ${tz}; change it in setup.` : ""}</p>}
        </SaveForm>
        )}
        {mode === "signin" && (
          <p className="helper auth-switch">
            New here? <button type="button" className="linklike" onClick={() => setMode("signup")}>Create your shop</button>
            {" · "}
            <button type="button" className="linklike" onClick={() => setMode("forgot")} data-testid="forgot-link">Forgot password?</button>
          </p>
        )}
        {mode === "forgot" && !forgotSent && (
          <p className="helper auth-switch"><button type="button" className="linklike" onClick={() => setMode("signin")}>Back to sign in</button></p>
        )}
        {mode === "signup" && (
          <p className="helper auth-switch">
            Already have a shop? <button type="button" className="linklike" onClick={() => setMode("signin")}>Sign in</button>
          </p>
        )}
      </section>
      {demo && mode !== "invite" && (
        <aside className="workspace-panel auth-demo" aria-labelledby="demo-heading">
          <Badge>Demo</Badge>
          <h3 id="demo-heading">Just looking?</h3>
          <p>Open Northline Barbers, a fully seeded demo shop — 3 barbers, 8 services, a month of appointments. Anyone can reset it.</p>
          <div className="demo-actions">
            <Button variant="secondary" disabled={!!demoBusy} onClick={() => openDemo("owner")} data-testid="open-demo-owner">
              {demoBusy === "owner" ? "Opening…" : "Open as owner"}
            </Button>
            <Button variant="ghost" disabled={!!demoBusy} onClick={() => openDemo("barber")} data-testid="open-demo-barber">
              {demoBusy === "barber" ? "Opening…" : "Open as barber"}
            </Button>
            <a className="button ghost" href="/book/demo" data-testid="open-customer">Customer booking page</a>
          </div>
          <ErrorMessage error={demoError} />
        </aside>
      )}
      </div>
    </div>
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
    const result = await api<{ token?: string; link?: string }>(path, method, body);
    if (result.link || result.token)
      setLink(result.link || `${location.origin}/workspace?invite=${result.token}`);
    setNotice("Access change saved.");
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
  if (!account) return <AuthScreen onDone={onDone} />;
  return (
    <section className="account-settings" ref={root}>
      <header className="workspace-panel">
        <Badge>{account.role}</Badge>
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
              Choose an existing active team profile. The invitation is emailed from the shop and the
              link (7 days, one use) is shown here too. For texts, resends and a per-person view, use
              Setup → Team.
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
        Suspending access or changing a role signs that member out everywhere; deactivating their
        team profile also blocks access.
      </Notice>
    </section>
  );
}

type ShopDayClient = ShopDayLite;
const COMMON_TIMEZONES = [
  "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam", "Europe/Lisbon", "Europe/Stockholm", "Europe/Warsaw", "Europe/Athens", "Europe/Istanbul",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto", "America/Vancouver", "America/Mexico_City", "America/Sao_Paulo",
  "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Tokyo", "Australia/Sydney", "Australia/Melbourne", "Australia/Perth", "Pacific/Auckland", "Africa/Lagos", "Africa/Johannesburg", "Africa/Nairobi",
];
const TAB_TITLES: Record<string, string> = { Pay: "Pay runs", MyPay: "My pay" };
// One-line purpose per section, shown under the title. Sections without a line show none.
const SECTION_BLURB: Record<string, string> = {
  Pay: "Everyone's pay for a period — sales, deductions, what each side is owed. Create drafts together, approve one by one.",
  MyPay: "Your deal, this period so far, and every statement.",
  Shifts: "Who's in, when, and what's booked against it. Changes that land on appointments ask you what to do with each one.",
  Customers: "Everyone who has booked with you, with visits, spend and what's next.",
  Team: "Barbers, their hours, breaks and pricing.",
  Services: "What you offer, grouped by category, with prices and durations.",
  Settings: "Opening hours, online booking, shop page and policies.",
  Insights: "How the shop is doing, from saved appointments.",
  Accounts: "Who can sign in to this workspace and what they can do.",
  Audit: "A record of every change made in this workspace.",
};
const CURRENCIES = [
  { code: "GBP", label: "British pound" },
  { code: "EUR", label: "Euro" },
  { code: "USD", label: "US dollar" },
  { code: "CAD", label: "Canadian dollar" },
  { code: "AUD", label: "Australian dollar" },
  { code: "NZD", label: "New Zealand dollar" },
  { code: "CHF", label: "Swiss franc" },
  { code: "SEK", label: "Swedish krona" },
  { code: "NOK", label: "Norwegian krone" },
  { code: "DKK", label: "Danish krone" },
  { code: "PLN", label: "Polish złoty" },
  { code: "CZK", label: "Czech koruna" },
  { code: "AED", label: "UAE dirham" },
  { code: "ZAR", label: "South African rand" },
  { code: "INR", label: "Indian rupee" },
  { code: "SGD", label: "Singapore dollar" },
  { code: "HKD", label: "Hong Kong dollar" },
  { code: "JPY", label: "Japanese yen" },
];
function timezoneOptions(current: string) {
  const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? COMMON_TIMEZONES;
  const set = new Set([current, ...COMMON_TIMEZONES, ...all]);
  return [...set];
}
// Weekly opening hours: one row per day, Monday first, open toggle + start/end.
function WeekHoursEditor({ week }: { week: ShopDayClient[] }) {
  const [open, setOpen] = useState(week.map((d) => !!d.enabled));
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <fieldset className="week-hours">
      <legend>Opening hours</legend>
      {order.map((i) => (
        <div className="week-hours-row" key={i} data-open={open[i]}>
          <label className="week-hours-day">
            <input
              type="checkbox"
              name={`open_${i}`}
              value="1"
              checked={open[i]}
              onChange={(e) => setOpen((o) => o.map((v, k) => (k === i ? e.target.checked : v)))}
            />
            <span>{days[i]}</span>
          </label>
          {open[i] ? (
            <>
              <input type="time" name={`starts_${i}`} aria-label={`${days[i]} opens`} required defaultValue={clock(week[i].starts)} step={900} />
              <span className="week-hours-dash">–</span>
              <input type="time" name={`ends_${i}`} aria-label={`${days[i]} closes`} required defaultValue={clock(week[i].ends)} step={900} />
            </>
          ) : (
            <span className="week-hours-closed">Closed</span>
          )}
        </div>
      ))}
    </fieldset>
  );
}

// Free start times as tappable chips, grouped by part of day. Unavailable times live in the
// fallback select so the grid stays scannable.
function SlotGrid({
  slots,
  value,
  onPick,
}: {
  slots: { start_min: number; reason: string }[];
  value: string;
  onPick: (minute: number, el: HTMLElement) => void;
}) {
  const free = slots.filter((s) => !s.reason);
  if (!free.length) return null;
  const groups: [string, (m: number) => boolean][] = [
    ["Morning", (m) => m < 720],
    ["Afternoon", (m) => m >= 720 && m < 1020],
    ["Evening", (m) => m >= 1020],
  ];
  return (
    <div className="slot-grid" role="group" aria-label="Free times">
      {groups.map(([label, test]) => {
        const items = free.filter((s) => test(s.start_min));
        if (!items.length) return null;
        return (
          <div className="slot-grid-group" key={label}>
            <h5>{label}</h5>
            <div className="slot-grid-chips">
              {items.map((s) => (
                <button
                  type="button"
                  key={s.start_min}
                  className="slot-chip"
                  aria-pressed={value === String(s.start_min)}
                  onClick={(e) => onPick(s.start_min, e.currentTarget)}
                >
                  {time(s.start_min)}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Walk-in: seat someone now. Picks the next free 15-minute start for the chosen barber today;
// customer details are optional (a name defaults to "Walk-in", no number needed).
function WalkInForm({ w, saved, staffId }: { w: WorkspaceData; saved: EditorProps["saved"]; staffId?: string }) {
  const barbers = w.staff.filter((s) => s.active);
  const [staff, setStaff] = useState(staffId && barbers.some((b) => b.id === staffId) ? staffId : barbers.length === 1 ? barbers[0].id : "");
  const [service, setService] = useState("");
  const [slots, setSlots] = useState<Slots | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [okMsg, setOkMsg] = useState("");
  const offered = (sid: string, svc: string) => !w.service_rules.some((r) => r.staff_id === sid && r.service_id === svc && !r.enabled);
  useEffect(() => {
    if (!staff || !service) {
      setSlots(null);
      return;
    }
    let cancelled = false;
    setError("");
    api<Slots>(`/availability?date=${w.today}&staff_id=${staff}&service_id=${service}&walk_in=1`)
      .then((r) => !cancelled && setSlots(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not check availability."));
    return () => {
      cancelled = true;
    };
  }, [staff, service, w.today]);
  const next = slots?.slots.find((s) => !s.reason) ?? null;
  const [start, setStart] = useState<number | null>(null);
  useEffect(() => setStart(next?.start_min ?? null), [next?.start_min]);
  const upcoming = slots?.slots.filter((s) => !s.reason).slice(0, 6) ?? [];
  return (
    <SaveForm
      label={busy ? "Seating…" : start !== null ? `Seat now · ${time(start)}` : "Seat now"}
      onSave={async (f) => {
        if (!slots || start === null) throw new Error("Choose a barber and a service with a free time.");
        setBusy(true);
        try {
          await saved("/bookings", "POST", {
            request_id: crypto.randomUUID(),
            staff_id: staff,
            service_id: service,
            customer_name: text(f, "customer_name") || "Walk-in",
            phone: text(f, "phone"),
            notes: text(f, "notes"),
            date: w.today,
            start_min: start,
            source: "WALK_IN",
            addon_ids: [],
            quote: slots.quote,
          });
          setOkMsg("Seated.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="helper">Books the next free time today for the barber you pick. No message is sent; the customer is in the chair.</p>
      <div className="workspace-form-grid">
        <Field label="Barber">
          <select value={staff} onChange={(e) => setStaff(e.target.value)} required data-testid="walkin-barber">
            <option value="">Choose barber</option>
            {barbers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Service">
          <select value={service} onChange={(e) => setService(e.target.value)} required data-testid="walkin-service">
            <option value="">Choose service</option>
            {w.services
              .filter((s) => s.active && (!staff || offered(staff, s.id)))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {money(s.price_pence)} · {s.duration_min} min
                </option>
              ))}
          </select>
        </Field>
      </div>
      <ErrorMessage error={error} />
      {staff && service && slots && !next && <Notice tone="warning">No free time left today for this barber. Try another barber or add a booking for another day.</Notice>}
      {upcoming.length > 0 && (
        <div className="slot-grid" role="group" aria-label="Start time">
          <div className="slot-grid-group">
            <h5>Start</h5>
            <div className="slot-grid-chips">
              {upcoming.map((s) => (
                <button type="button" key={s.start_min} className="slot-chip" aria-pressed={start === s.start_min} onClick={() => setStart(s.start_min)}>
                  {time(s.start_min)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="workspace-form-grid">
        <Field label="Name (optional)">
          <input name="customer_name" maxLength={100} placeholder="Walk-in" />
        </Field>
        <Field label="Mobile (optional)">
          <input name="phone" inputMode="tel" maxLength={20} placeholder="07700 900123" />
        </Field>
      </div>
      <Field label="Notes (optional)">
        <input name="notes" maxLength={500} />
      </Field>
      {okMsg && <p role="status">{okMsg}</p>}
    </SaveForm>
  );
}

// Barber weekly hours: Monday first, a working toggle, start/end, and an explicit break toggle
// (the API encodes "no break" as break_start == break_end == starts). "Copy Monday to all" fills
// the week from the first row.
function WeeklyHoursFields({ staff, hours, shop }: { staff: Staff; hours: Hours[]; shop: WorkspaceData["shop"] }) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const initial = (i: number) => {
    const h = hours.find((x) => x.weekday === i);
    const day = shopWeekOf(shop)[i];
    return h ?? { weekday: i, enabled: day.enabled, starts: day.starts, ends: day.ends, break_start: day.starts, break_end: day.starts };
  };
  type Row = { enabled: boolean; starts: string; ends: string; hasBreak: boolean; break_start: string; break_end: string };
  const [rows, setRows] = useState<Row[]>(() =>
    days.map((_, i) => {
      const h = initial(i);
      const hasBreak = h.break_end > h.break_start;
      return {
        enabled: !!h.enabled,
        starts: clock(h.starts),
        ends: clock(h.ends),
        hasBreak,
        break_start: clock(hasBreak ? h.break_start : Math.min(h.ends - 30, Math.max(h.starts, 12 * 60 + 45))),
        break_end: clock(hasBreak ? h.break_end : Math.min(h.ends, Math.max(h.starts, 13 * 60 + 30))),
      };
    }),
  );
  const set = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  // Copies Monday's times and break to every day; each day keeps its own Working flag.
  const copyMonday = () => setRows((r) => r.map((x) => ({ ...r[1], enabled: x.enabled })));
  return (
    <div className="weekly-hours">
      <div className="weekly-hours-head">
        <p className="helper">
          {staff.name.split(" ")[0]}’s working week. Shop opening hours still cap what customers can book.
        </p>
        <Button variant="ghost" onClick={copyMonday} data-testid="copy-monday">
          Copy Monday to all
        </Button>
      </div>
      {order.map((i) => {
        const r = rows[i];
        const day = days[i];
        return (
          <fieldset className="workspace-hours weekly-hours-row" key={day} data-working={r.enabled} aria-label={day}>
            <strong className="weekly-hours-dayname">{day}</strong>
            <label className="workspace-check">
              <input name={`enabled-${i}`} type="checkbox" checked={r.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} />
              Working
            </label>
            {r.enabled ? (
              <>
                <div className="weekly-hours-times">
                  <Field label={`${day} start`}>
                    <input type="time" required name={`starts-${i}`} step={900} value={r.starts} onChange={(e) => set(i, { starts: e.target.value })} />
                  </Field>
                  <span className="week-hours-dash">–</span>
                  <Field label={`${day} end`}>
                    <input type="time" required name={`ends-${i}`} step={900} value={r.ends} onChange={(e) => set(i, { ends: e.target.value })} />
                  </Field>
                </div>
                <label className="workspace-check">
                  <input name={`break-${i}`} type="checkbox" checked={r.hasBreak} onChange={(e) => set(i, { hasBreak: e.target.checked })} />
                  Break
                </label>
                {r.hasBreak && (
                  <div className="weekly-hours-times">
                    <Field label={`${day} break start`}>
                      <input type="time" required name={`break_start-${i}`} step={900} value={r.break_start} onChange={(e) => set(i, { break_start: e.target.value })} />
                    </Field>
                    <span className="week-hours-dash">–</span>
                    <Field label={`${day} break end`}>
                      <input type="time" required name={`break_end-${i}`} step={900} value={r.break_end} onChange={(e) => set(i, { break_end: e.target.value })} />
                    </Field>
                  </div>
                )}
              </>
            ) : (
              <>
                <span className="week-hours-closed">Day off</span>
                <input type="hidden" name={`starts-${i}`} value={r.starts} />
                <input type="hidden" name={`ends-${i}`} value={r.ends} />
              </>
            )}
          </fieldset>
        );
      })}
    </div>
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
  | { kind: "walkin"; staffId?: string }
  | { kind: "block"; item: Staff; at?: number }
  | { kind: "removeBlock"; item: StaffBlock }
  | { kind: "detail"; item: StoredBooking }
  | { kind: "seriesMove"; item: StoredBooking }
  | { kind: "share"; item: StoredBooking }
  | { kind: "contacts"; item: StoredBooking }
  | { kind: "holiday" }
  | { kind: "removeHoliday"; item: Holiday };

type SettingsTabKey = "general" | "booking" | "page" | "messages" | "payments" | "billing";
const SETTINGS_TABS: { key: SettingsTabKey; label: string; hint: string; icon: string; owner?: boolean }[] = [
  { key: "general", label: "General", hint: "Details, hours, policies", icon: "settings" },
  { key: "booking", label: "Online booking", hint: "Link, notice, customer pages", icon: "globe" },
  { key: "page", label: "Shop page", hint: "Public page & reviews", icon: "star" },
  { key: "messages", label: "Messages & AI", hint: "Texts, WhatsApp, email, calls", icon: "message" },
  { key: "payments", label: "Payments", hint: "Cards, deposits, payouts", icon: "card" },
  { key: "billing", label: "Billing", hint: "Your foliyo plan, usage, invoices", icon: "file", owner: true },
];


// Shown when foliyo support opened this workspace from the admin panel (cookie set by /api/admin/…/impersonate).
function ImpersonationBar() {
  const [info, setInfo] = useState<{ admin: string; until: number } | null>(() => {
    const m = document.cookie.match(/(?:^|; )ollo_impersonating=([^;]*)/);
    try { return m ? (JSON.parse(decodeURIComponent(m[1])) as { admin: string; until: number }) : null; } catch { return null; }
  });
  useEffect(() => {
    if (!info) return;
    const t = setInterval(() => { if (Date.now() > info.until) setInfo(null); }, 15000);
    return () => clearInterval(t);
  }, [info]);
  if (!info) return null;
  const mins = Math.max(0, Math.ceil((info.until - Date.now()) / 60000));
  return (
    <div className="impersonation-bar" role="status" data-testid="impersonation-bar">
      <Icon name="shield" size={16} /> <strong>foliyo support session</strong> · {info.admin} is viewing this shop as the owner · ends in {mins} min ·{" "}
      <a href="/admin/shops">Back to admin</a>
    </div>
  );
}

export function Workspace() {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [inviteToken, setInviteToken] = useState(
    // Emailed/texted links use ?invite=; the in-app "copy link" historically used #invite=. Accept both.
    () => new URLSearchParams(location.search).get("invite") || new URLSearchParams(location.hash.slice(1)).get("invite") || "",
  );
  useEffect(() => {
    if (location.hash.startsWith("#invite=") || new URLSearchParams(location.search).has("invite"))
      history.replaceState(null, "", location.pathname);
  }, []);
  async function accountChanged() {
    ++loadSequence.current;
    setData(null);
    setEditor(null);
    setTab("Appointments");
    setSetupOpen(location.pathname === "/workspace/setup");
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
  // Keep the view current without a Refresh button: re-read when the tab regains focus and every
  // 60s while idle. Never while a form is dirty or a save is in flight.
  const lastTick = useRef(0);
  useEffect(() => {
    const idle = () => {
      const main = document.getElementById("workspace-main");
      return !main?.querySelector('form[data-dirty="true"], form[aria-busy="true"]') && !document.querySelector('[role="dialog"]');
    };
    const tick = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine || !idle()) return;
      refresh({ background: true }).catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVisible);
    // Live view: a 4-second heartbeat asks /changes for the shop's change cursor (one indexed read).
    // Only when the cursor moves — a booking from the website, a colleague's edit, a payment — does
    // the client re-read the workspace, in the background, swapping data in place. A full re-read
    // still happens every 60s as a safety net.
    let cursor = "";
    let inFlight = false;
    const beat = async () => {
      if (document.visibilityState !== "visible" || !navigator.onLine || inFlight) return;
      inFlight = true;
      try {
        const r = await api<{ cursor: string }>("/changes");
        if (cursor && r.cursor !== cursor && idle()) { lastTick.current = Date.now(); tick(); }
        cursor = r.cursor;
      } catch { /* offline or signed out; the next beat retries */ } finally { inFlight = false; }
    };
    const heartbeat = window.setInterval(beat, 4000);
    const timer = window.setInterval(() => {
      if (Date.now() - lastTick.current >= 60000 - 500) {
        lastTick.current = Date.now();
        tick();
      }
    }, 20000);
    return () => {
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
      window.clearInterval(heartbeat);
    };
    // refresh is stable enough for this purpose; re-binding on every render would thrash the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  // One-step undo for calendar gestures (move / resize): the inverse call, offered beside the notice
  // until the next change or 20 s pass.
  const [undo, setUndo] = useState<{ label: string; run: () => Promise<void> } | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 20000);
    return () => window.clearTimeout(t);
  }, [undo]);
  const [tab, setTab] = useState("Appointments");
  // Settings is split into clear sections; the URL hash remembers the open one (#settings/payments).
  const [settingsTab, setSettingsTab] = useState<SettingsTabKey>(() => {
    const m = /^#settings\/(\w+)$/.exec(location.hash);
    return (m && SETTINGS_TABS.some((t) => t.key === m[1]) ? (m[1] as SettingsTabKey) : "general");
  });
  useEffect(() => {
    if (tab === "Settings") history.replaceState(null, "", `${location.pathname}#settings/${settingsTab}`);
    else if (location.hash.startsWith("#settings/")) history.replaceState(null, "", location.pathname);
  }, [tab, settingsTab]);
  // /workspace/setup opens the guided setup over the Appointments tab; the URL is the state so a
  // refresh or a link from the landing page lands back in it.
  const [setupOpen, setSetupOpen] = useState(() => location.pathname === "/workspace/setup");
  function openSetup(on: boolean) {
    setSetupOpen(on);
    history.replaceState(null, "", on ? "/workspace/setup" : "/workspace");
    if (on) setTab("Appointments");
  }
  const [editor, setEditor] = useState<Editor | null>(null);
  // "Move on timetable": the appointment panel closes, the calendar arms, the next slot click
  // reschedules the armed booking (same confirm + undo as drag-and-drop). Escape cancels.
  const [moving, setMoving] = useState<StoredBooking | null>(null);
  useEffect(() => {
    if (!moving) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMoving(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [moving]);
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
  const [queueOpen, setQueueOpen] = useState(false);
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
  // Scheduled team (Fresha): rostered barbers show by default; extra barbers added per date live
  // here (and in localStorage so a page reload keeps the day as arranged).
  const [team, setTeam] = useState<Record<string, string[]>>(() => {
    try {
      return JSON.parse(localStorage.getItem("ollo.team") || "{}");
    } catch {
      return {};
    }
  });
  const [teamOpen, setTeamOpen] = useState(false);
  function toggleTeam(d: string, staffId: string, on: boolean) {
    setTeam((prev) => {
      const list = new Set(prev[d] ?? []);
      if (on) list.add(staffId);
      else list.delete(staffId);
      const next = { ...prev, [d]: [...list] };
      // Keep the store small: only today onwards.
      for (const k of Object.keys(next)) if (k < (dateRef.current || d) && k !== d) delete next[k];
      try {
        localStorage.setItem("ollo.team", JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  }
  useEffect(() => {
    if (!teamOpen) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.(".team-picker")) setTeamOpen(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setTeamOpen(false);
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [teamOpen]);
  const [statusFilter, setStatusFilter] = useState("");
  const [directorySearch, setDirectorySearch] = useState("");
  const [directoryStatus, setDirectoryStatus] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [loading, setLoading] = useState(true);
  // True while a background re-read is in flight; the UI stays fully interactive.
  const [revalidating, setRevalidating] = useState(false);
  const [stale, setStale] = useState(false);
  const loadSequence = useRef(0);
  const identity = useRef("");
  async function refresh(opts: { background?: boolean } = {}) {
    const sequence = ++loadSequence.current;
    // Background revalidation (polling, focus, after a save) keeps the current view on screen and
    // swaps the data in place — no placeholder, no greyed-out calendar. Only a first load or a
    // change of date shows the loading state.
    const targetDate0 = dateRef.current || queriedDate.current;
    const background = opts.background ?? (!!data && (!targetDate0 || targetDate0 === queriedDate.current));
    if (!background) setLoading(true);
    else setRevalidating(true);
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
        setCurrency(w.shop.currency);
        setData({ ...w, bookings });
        setNeedsSession(false);
        if (/^\/(signin|signup)$/.test(location.pathname)) history.replaceState(null, "", "/workspace");
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
            "",
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
      if (sequence === loadSequence.current) { setLoading(false); setRevalidating(false); }
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
      setNotice("Saved.");
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
    setNotice("Saved.");
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
  // Card at the chair is available once foliyo's Stripe keys are live (checked once per session).
  const [cardLive, setCardLive] = useState(false);
  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then((h: { livePayments?: boolean }) => setCardLive(!!h.livePayments)).catch(() => null);
  }, []);
  const navItems: NavItem[] = [
    { key: "Appointments", label: "Appointments", icon: "calendar" },
    { key: "Insights", label: "Insights", icon: "trend" },
    { key: "Customers", label: "Customers", icon: "contact" },
    ...(manager
      ? [
          { key: "Team", label: "Team", icon: "users" },
          { key: "Shifts", label: "Shifts", icon: "clock" },
          { key: "Pay", label: "Pay runs", icon: "payrun" },
          { key: "Services", label: "Services", icon: "scissors" },
          { key: "Settings", label: "Settings", icon: "settings" },
          { key: "Audit", label: "Audit", icon: "shield" },
        ]
      : [{ key: "MyPay", label: "My pay", icon: "payrun" }]),
    { key: "Accounts", label: "Accounts", icon: "userRound" },
  ];
  const phoneNav: NavItem[] = [
    { key: "Appointments", label: "Today", icon: "sun" },
    { key: "Insights", label: "Insights", icon: "trend" },
    { key: "Customers", label: "Customers", icon: "contact" },
  ];
  const phoneMore = navItems.filter((n) => !phoneNav.some((p) => p.key === n.key));
  function goTo(name: string) {
    if (setupOpen) { setSetupOpen(false); history.replaceState(null, "", "/workspace"); }
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
            const day = shopDayOf(w.shop, date);
            if (!h?.enabled || !day.enabled) return n;
            return n + (Math.min(h.ends, day.ends) - Math.max(h.starts, day.starts)) - Math.max(0, h.break_end - h.break_start);
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
  // Signed out: the front door only. No rail, search or chips until there is a shop to show.
  if (!w && (needsSession || inviteToken))
    return (
      <div className="workspace workspace-signed-out">
        <main id="workspace-main" className="workspace-main">
          <ErrorMessage error={error} />
          <AuthScreen token={inviteToken} onDone={accountChanged} />
        </main>
      </div>
    );
  return (
    <div className="workspace">
      <ImpersonationBar />
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
        queue={w ? { count: waitlist.length, offered: waitlist.filter((e) => e.status === "OFFERED").length, open: queueOpen } : null}
        onQueue={() => setQueueOpen((v) => !v)}
        bell={w ? { count: w.issues.length, open: notificationsOpen } : null}
        onBell={() => setNotificationsOpen((v) => !v)}
        account={
          w
            ? {
                initials: initialsOf(w.account?.name || w.shop.name),
                logo: w.logo_url || undefined,
                name: w.account?.name || w.shop.name,
                caption: w.account ? `${w.shop.name} · ${w.account.role.toLowerCase()}` : "Browser test access",
              }
            : null
        }
        onAccount={() => setAccountOpen((v) => !v)}
        accountOpen={accountOpen}
        shop={w ? { name: w.shop.name, logo: w.logo_url || null } : null}
      >
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
          onReview={(id) => {
            setNotificationsOpen(false);
            openBooking(id);
          }}
          onClose={() => setNotificationsOpen(false)}
        />
      )}
      {w && queueOpen && (
        <QueueDrawer
          w={w}
          date={date}
          waitlist={waitlist}
          onRefresh={() =>
            api<{ waitlist: WaitlistEntry[] }>(`/waitlist?from=${w.today}`)
              .then((r) => setWaitlist(r.waitlist))
              .catch(() => {})
          }
          onBook={(entry) => {
            setQueueOpen(false);
            if (tab !== "Appointments") setTab("Appointments");
            setEditor({ kind: "booking", waitlist: entry });
          }}
          onOpenSettings={() => {
            setQueueOpen(false);
            setSettingsTab("messages");
            setTab("Settings");
          }}
          onClose={() => setQueueOpen(false)}
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
            label: "New booking",
            disabled: !w || !online,
            onClick: () => {
              if (!w) return;
              if (tab !== "Appointments" && !canNavigate()) return;
              setTab("Appointments");
              if (tab === "Appointments" && !stale && !loading) setEditor({ kind: "booking" });
              else setTimeout(() => setEditor({ kind: "booking" }), 150);
            },
          }}
        />
        <main id="workspace-main" className="workspace-main">
          {tab === "Appointments" ? (
            <h1 className="visually-hidden">Appointments</h1>
          ) : (
            <header className="workspace-heading">
              <div>
                <h1>{TAB_TITLES[tab] || tab}</h1>
                {SECTION_BLURB[tab] && <p>{SECTION_BLURB[tab]}</p>}
              </div>
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
          {moving && (
            <div className="move-bar" role="status" data-testid="move-bar">
              <Icon name="calendar" size={18} />
              <span>Moving <b>{moving.attendee_name || moving.customer_name}</b> · {moving.service_name} · click a free slot on the timetable. Change the day with the arrows above.</span>
              <Button variant="ghost" onClick={() => setMoving(null)}>Cancel</Button>
            </div>
          )}
          {notice && (
            <p className="workspace-success" role="status">
              {notice}
              {undo && (
                <button
                  type="button"
                  className="undo-button"
                  data-testid="undo"
                  disabled={undoBusy || !online}
                  onClick={async () => {
                    const u = undo;
                    setUndo(null);
                    setUndoBusy(true);
                    try {
                      await u.run();
                      setNotice(`Undone · ${u.label}.`);
                      await refresh();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "Could not undo.");
                    } finally {
                      setUndoBusy(false);
                    }
                  }}
                >
                  {undoBusy ? "Undoing…" : "Undo"}
                </button>
              )}
            </p>
          )}
          {!w && !needsSession && !error && (
            <p role="status">Loading local workspace…</p>
          )}
          {w && !inviteToken && manager && setupOpen && (
            <SetupWizard w={w} api={api} refresh={async () => { await refresh(); }} goTo={goTo} onExit={() => { openSetup(false); refresh().catch(() => {}); }} />
          )}
          {w && !inviteToken && manager && !setupOpen && tab === "Appointments" && (() => {
            // Until setup is finished (or dismissed) a one-line banner offers the way back in.
            let st: { completed_at?: number | null; dismissed?: boolean; done?: string[] } = {};
            try { st = JSON.parse((w.shop as { setup_json?: string }).setup_json || "{}"); } catch { /* none */ }
            if (st.completed_at || st.dismissed) return null;
            const done = (st.done || []).length;
            return (
              <section className="setup-banner" data-testid="setup-banner">
                <div>
                  <strong>{done ? `Setup: ${done} of 7 steps done.` : `Get ${w.shop.name} live in a few minutes.`}</strong>
                  <span>{done ? "Pick up where you left off." : "Services, team, texts, your booking link — one screen at a time."}</span>
                </div>
                <div className="setup-banner-actions">
                  <Button onClick={() => openSetup(true)} data-testid="setup-continue">{done ? "Continue setup" : "Start setup"}</Button>
                  <button type="button" className="linklike" onClick={() => { api("/setup/state", "PUT", { dismissed: true }).then(() => refresh()).catch(() => {}); setNotice("Setup hidden. Run it again any time from Settings."); }}>Hide</button>
                </div>
              </section>
            );
          })()}
          {w && !inviteToken && !setupOpen && (
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
                    {calendarView === "day" && !barber && date && (() => {
                      const wd = new Date(date + "T12:00:00Z").getUTCDay();
                      const rostered = (s: Staff) => {
                        const sh = w.schedule_overrides.find((o) => o.staff_id === s.id && o.date === date) || w.hours.find((h) => h.staff_id === s.id && h.weekday === wd);
                        return !!sh?.enabled && !w.days_off.some((d) => d.staff_id === s.id && d.date === date);
                      };
                      const extra = new Set(team[date] ?? []);
                      const active = w.staff.filter((s) => s.active);
                      const shown = active.filter((s) => rostered(s) || extra.has(s.id));
                      return (
                        <span className="team-picker">
                          <Button variant={extra.size ? "secondary" : "ghost"} aria-haspopup="dialog" aria-expanded={teamOpen} onClick={() => setTeamOpen((v) => !v)} data-testid="team-picker" title="Who shows on today's timetable">
                            <Icon name="contact" size={15} />
                            <span className="toolbar-label"><span className="team-word">Scheduled team · </span>{shown.length}/{active.length}</span>
                          </Button>
                          {teamOpen && (
                            <div className="team-picker-list" role="dialog" aria-label="Scheduled team">
                              <header>Working {new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date(date + "T12:00:00Z"))}</header>
                              {active.map((s, i) => {
                                const on = rostered(s);
                                return (
                                  <label key={s.id} className={on ? "" : "off"}>
                                    <input type="checkbox" checked={on || extra.has(s.id)} disabled={on} onChange={(e) => toggleTeam(date, s.id, e.target.checked)} />
                                    <Avatar initials={s.name.split(" ").map((n) => n[0]).slice(0, 2).join("")} colour={s.colour || ["sage", "sand", "blue", "clay"][i % 4]} src={s.photo_url} />
                                    {s.name}
                                    <small>{on ? "Rostered" : extra.has(s.id) ? "Added" : "Not working"}</small>
                                  </label>
                                );
                              })}
                              <footer>
                                <Button variant="ghost" onClick={() => setTeamOpen(false)}>
                                  Done
                                </Button>
                              </footer>
                            </div>
                          )}
                        </span>
                      );
                    })()}
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
                      variant="secondary"
                      disabled={!online || stale || loading || date !== w.today}
                      onClick={() => setEditor({ kind: "walkin" })}
                      data-testid="walk-in"
                      className="toolbar-walkin"
                      title={date !== w.today ? "Walk-ins are for today" : "Seat someone now"}
                    >
                      <Icon name="user" />
                      <span className="toolbar-label">Walk-in</span>
                    </Button>
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
                          disabled={!online || stale}
                          onDraft={async (draft) => {
                            if (moving) {
                              const b = moving;
                              const who = w.staff.find((x) => x.id === draft.staffId)?.name.split(" ")[0] ?? "";
                              const same = draft.staffId === b.staff_id && date === b.date;
                              const at = time(draft.start);
                              const warn = draft.outside === "Occupied" ? "\n\nThis overlaps another appointment — both will sit side by side." : draft.outside ? `\n\n${who || "The barber"} isn't rostered then (${draft.outside.toLowerCase()}). Book it anyway?` : "";
                              if (!window.confirm(`Move ${b.attendee_name || b.customer_name} to ${at} on ${new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date(date + "T12:00:00Z"))}${same ? "" : ` with ${who}`}?${warn}`)) return;
                              setMoving(null);
                              try {
                                await api(`/bookings/${b.id}/reschedule`, "POST", { date, start_min: draft.start, staff_id: draft.staffId, reason: "Moved on the timetable", version: b.version, ...(draft.outside ? { force: true } : {}) });
                                setNotice(`Moved ${b.attendee_name || b.customer_name} to ${at}${same ? "" : ` with ${who}`}.`);
                                const from = { date: b.date, start_min: b.start_min, staff_id: b.staff_id };
                                setUndo({ label: `back to ${time(from.start_min)}`, run: async () => { const cur = (await api<{ booking: StoredBooking }>(`/bookings/${b.id}`)).booking; await api(`/bookings/${b.id}/reschedule`, "POST", { ...from, reason: "Undo timetable move", version: cur.version, force: true }); } });
                                await refresh({ background: true });
                              } catch (e) { setError(e instanceof Error ? e.message : "Could not move the appointment."); }
                              return;
                            }
                            setEditor({ kind: "booking", draft });
                          }}
                          onOpen={(item) => {
                            if (moving) return;
                            setEditor({ kind: "detail", item });
                          }}
                          onHours={(staffMember, d) => {
                            setDate(d);
                            setEditor({ kind: "override", item: staffMember, override: w.schedule_overrides.find((o) => o.staff_id === staffMember.id && o.date === d) });
                          }}
                          team={barber ? undefined : new Set(team[date] ?? [])}
                          onAction={(action, staffMember, at) => {
                            if (action === "hours") setEditor({ kind: "override", item: staffMember, override: w.schedule_overrides.find((o) => o.staff_id === staffMember.id && o.date === date) });
                            else if (action === "block") setEditor({ kind: "block", item: staffMember, at });
                            else if (action === "dayOff") setEditor({ kind: "daysOff", item: staffMember });
                            else setEditor({ kind: "walkin", staffId: staffMember.id });
                          }}
                          onResize={
                            manager || w.shop.till_access === "ALL"
                              ? async (b, to) => {
                                  if (w.payments.some((p) => p.booking_id === b.id && !p.voided_at)) {
                                    setError("This visit has been paid; change its length from the appointment panel as a refund instead.");
                                    return;
                                  }
                                  const items = JSON.parse(b.items_json || "[]") as BookingItem[];
                                  const svc = items.find((i) => i.kind === "SERVICE");
                                  const addons = items.filter((i) => i.kind === "ADDON");
                                  const addonMinutes = addons.reduce((n, i) => n + i.duration_min, 0);
                                  const serviceDuration = Math.max(5, to.duration - addonMinutes);
                                  if (to.override && !window.confirm(`Make ${b.attendee_name || b.customer_name} ${to.duration} min?\n\n${to.override === "Occupied" ? "It will overlap the next appointment — both sit side by side." : `${to.override} — save it anyway?`}`)) return;
                                  setPanelError("");
                                  const body = (dur: number, version: number) => ({
                                    service_id: b.service_id,
                                    addon_ids: addons.map((a) => a.id),
                                    service_price_pence: svc?.price_pence ?? b.price_pence,
                                    service_duration_min: dur,
                                    addon_prices: Object.fromEntries(addons.map((a) => [a.id, a.price_pence])),
                                    reason: "Length changed on the calendar",
                                    version,
                                    force: true,
                                  });
                                  try {
                                    await api(`/bookings/${b.id}/items`, "PATCH", body(serviceDuration, b.version));
                                    setNotice(`${b.attendee_name || b.customer_name} is now ${to.duration} min (until ${time(b.start_min + to.duration)}).`);
                                    const before = (svc?.duration_min ?? b.duration_min) as number;
                                    setUndo({
                                      label: `back to ${b.duration_min} min`,
                                      run: async () => {
                                        const cur = (await api<{ booking: StoredBooking }>(`/bookings/${b.id}`)).booking;
                                        await api(`/bookings/${b.id}/items`, "PATCH", { ...body(before, cur.version), reason: "Undo calendar resize" });
                                      },
                                    });
                                    await refresh();
                                  } catch (e) {
                                    setError(e instanceof Error ? e.message : "Could not change the length.");
                                  }
                                }
                              : undefined
                          }
                          onBlock={(k) => setEditor({ kind: "block", item: w.staff.find((s) => s.id === k.staff_id)!, at: k.start_min })}
                          onRemoveBlock={(k) => setEditor({ kind: "removeBlock", item: k })}
                          onMove={
                            manager || w.shop.till_access === "ALL"
                              ? async (b, to) => {
                                  const who = w.staff.find((x) => x.id === to.staffId)?.name.split(" ")[0] ?? "";
                                  const same = to.staffId === b.staff_id;
                                  const at = `${String(Math.floor(to.start / 60)).padStart(2, "0")}:${String(to.start % 60).padStart(2, "0")}`;
                                  const warn = to.override === "Occupied"
                                    ? `\n\nThis overlaps another appointment — both will sit side by side.`
                                    : to.override
                                      ? `\n\n${who || "The barber"} isn't rostered then (${to.override.toLowerCase()}). Book it anyway?`
                                      : "";
                                  if (!window.confirm(`Move ${b.attendee_name || b.customer_name} to ${at}${same ? "" : ` with ${who}`}?${warn}`)) return;
                                  setPanelError("");
                                  try {
                                    const r = await api<{ booking: StoredBooking }>(`/bookings/${b.id}/reschedule`, "POST", { date, start_min: to.start, staff_id: to.staffId, reason: to.override ? `Moved on the calendar (over: ${to.override.toLowerCase()})` : "Moved on the calendar", version: b.version, ...(to.override ? { force: true } : {}) });
                                    setNotice(`Moved to ${at}${same ? "" : ` with ${who}`}.`);
                                    const from = { date: b.date, start_min: b.start_min, staff_id: b.staff_id };
                                    setUndo({
                                      label: `back to ${time(from.start_min)}`,
                                      run: async () => {
                                        const cur = (await api<{ booking: StoredBooking }>(`/bookings/${b.id}`)).booking;
                                        await api(`/bookings/${b.id}/reschedule`, "POST", { ...from, reason: "Undo calendar move", version: cur.version, force: true });
                                      },
                                    });
                                    await refresh();
                                    void r;
                                  } catch (e) {
                                    setError(e instanceof Error ? e.message : "Could not move the appointment.");
                                  }
                                }
                              : undefined
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
              {tab === "Shifts" && (
                <Shifts
                  w={w}
                  date={date || w.today}
                  onDate={(d) => setDate(d)}
                  onEditDay={(item, d) => { setDate(d); setEditor({ kind: "override", item, override: w.schedule_overrides.find((o) => o.staff_id === item.id && o.date === d) }); }}
                  onDayOff={(item) => setEditor({ kind: "daysOff", item })}
                  onWeekly={(item) => setEditor({ kind: "hours", item })}
                  onHoliday={() => setEditor({ kind: "holiday" })}
                  onRemoveDayOff={(item) => setEditor({ kind: "removeDayOff", item })}
                  onRemoveHoliday={(item) => setEditor({ kind: "removeHoliday", item })}
                  onOpenBooking={openBooking}
                />
              )}
              {tab === "Pay" && <PayRunsPage w={w} api={api} onOpenBarber={(sid) => { setFocusBarber(sid); setTab("Team"); }} />}
              {tab === "MyPay" && <MyPay w={w} api={api} />}
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
                <div className="settings-shell" data-testid="settings">
                  <nav className="settings-nav" role="tablist" aria-label="Settings sections">
                    {SETTINGS_TABS.filter((t) => !t.owner || !w.account || w.account.role === "OWNER").map((t) => (
                      <button key={t.key} type="button" role="tab" aria-selected={settingsTab === t.key} aria-controls={`settings-${t.key}`} onClick={() => setSettingsTab(t.key)} data-testid={`settings-tab-${t.key}`}>
                        <Icon name={t.icon} size={18} />
                        <span><b>{t.label}</b><small>{t.hint}</small></span>
                      </button>
                    ))}
                  </nav>
                  <div className="settings-body" id={`settings-${settingsTab}`} role="tabpanel">
                    {settingsTab === "general" && (
                      <>
                        <header className="settings-head"><h2>General</h2><p>Your business details, opening hours and booking policies.</p></header>
                  <section className="workspace-panel">
                    <h2>Shop settings</h2>
                    <SaveForm
                      key={w.shop.version}
                      onSave={(f) =>
                        saved("/shop", "PUT", {
                          name: text(f, "name"),
                          address: text(f, "address"),
                          timezone: text(f, "timezone"),
                          currency: text(f, "currency") || "GBP",
                          week: days.map((_, i) => ({
                            enabled: f.get(`open_${i}`) ? 1 : 0,
                            starts: minute(text(f, `starts_${i}`) || "09:00"),
                            ends: minute(text(f, `ends_${i}`) || "18:00"),
                          })),
                          deposit_pence: Math.round(number(f, "deposit") * 100),
                          cancel_hours: number(f, "cancel_hours"),
                          buffer_min: number(f, "buffer_min"),
                          card_colour: text(f, "card_colour") === "SERVICE" ? "SERVICE" : "BARBER",
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
                      <Field label="Timezone">
                        <select name="timezone" defaultValue={w.shop.timezone}>
                          {timezoneOptions(w.shop.timezone).map((tz) => (
                            <option key={tz} value={tz}>
                              {tz.replace(/_/g, " ")}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Currency · how prices are shown">
                        <select name="currency" defaultValue={w.shop.currency || "GBP"} data-testid="shop-currency">
                          {CURRENCIES.map((c) => (
                            <option key={c.code} value={c.code}>
                              {c.code} · {c.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <WeekHoursEditor week={shopWeekOf(w.shop)} />
                      <p className="helper">Times between visits include a 10-minute buffer. Each barber has their own hours under Team.</p>
                      <Field label={`Deposit (${currencySymbol(w.shop.currency || "GBP")}) · shown to customers, payable in the shop`}>
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
                      <Field label="Gap between appointments" hint="Time held after every appointment for tidy-up. Off means back-to-back bookings.">
                        <select name="buffer_min" defaultValue={String(w.shop.buffer_min ?? 10)} data-testid="shop-buffer">
                          <option value="0">Off · back to back</option>
                          <option value="5">5 minutes</option>
                          <option value="10">10 minutes</option>
                          <option value="15">15 minutes</option>
                          <option value="20">20 minutes</option>
                          <option value="30">30 minutes</option>
                        </select>
                      </Field>
                      <Field label="Calendar card colour" hint="Colour every appointment by who is doing it, or by the service booked.">
                        <select name="card_colour" defaultValue={w.shop.card_colour || "BARBER"} data-testid="shop-card-colour">
                          <option value="BARBER">By team member</option>
                          <option value="SERVICE">By service</option>
                        </select>
                      </Field>
                      <Field label="Who can take payment">
                        <select name="till_access" defaultValue={w.shop.till_access}>
                          <option value="OWNER">Shop device only (owner or manager)</option>
                          <option value="ALL">Barbers too, for their own visits</option>
                        </select>
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
                      </>
                    )}
                    {settingsTab === "booking" && (
                      <>
                        <header className="settings-head"><h2>Online booking</h2><p>Your public booking link, notice periods, and the customer-facing pages.</p></header>
                        <OnlineBookingPanel w={w} saved={saved} />
                        <CustomerPagesPanel w={w} onOpenBooking={openBooking} />
                      </>
                    )}
                    {settingsTab === "page" && (
                      <>
                        <header className="settings-head"><h2>Shop page &amp; reviews</h2><p>How your business looks to the public: page content, photos, reviews.</p></header>
                        <ShopPagePanel w={w} />
                        <ReviewsPanel w={w} />
                      </>
                    )}
                    {settingsTab === "messages" && (
                      <>
                        <header className="settings-head"><h2>Messages &amp; AI</h2><p>Text, WhatsApp and email confirmations, reminders, owner alerts and the AI receptionist.</p></header>
                        <WaitlistSettingsPanel w={w} />
                      </>
                    )}
                    {settingsTab === "payments" && (
                      <>
                        <header className="settings-head"><h2>Payments</h2><p>Card payments, deposits, payouts and pay runs.</p></header>
                        <PaymentsPanel api={api} canEdit={manager} isOwner={!w.account || w.account.role === "OWNER"} />
                      </>
                    )}
                    {settingsTab === "billing" && (
                      <>
                        <header className="settings-head"><h2>Billing</h2><p>Your foliyo plan, seats, usage and invoices. Prices are what you pay — no VAT is added.</p></header>
                        <BillingPanel api={api} isOwner={!w.account || w.account.role === "OWNER"} onOpenOutbox={() => setSettingsTab("messages")} />
                      </>
                    )}
                  </div>
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
          onPickSlot={() => { const b = editor.item; setEditor(null); setCalendarView("day"); setMoving(b); }}
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
          api={api}
          cardLive={cardLive}
          onItems={async (body) => {
            // Errors must reach the editor (it offers "save anyway" on overlap), so no panelAction wrapper.
            setPanelBusy("items");
            setPanelError("");
            try {
              const r = await api<{ booking: StoredBooking; refunded_pence: number }>(`/bookings/${editor.item.id}/items`, "PATCH", body);
              setNotice(r.refunded_pence > 0 ? `Saved · ${money(r.refunded_pence)} refunded to the customer.` : "Saved.");
              await refresh().catch(() => {});
              setEditor({ kind: "detail", item: r.booking });
              return { refunded_pence: r.refunded_pence };
            } finally {
              setPanelBusy("");
            }
          }}
          onPaid={() => panelAction("CARD", async () => undefined)}
        >
          {/* Status changes, edits and sharing live in the panel footer / ⋯ menu; nothing duplicated here. */}
        </AppointmentPanel>
      )}
      {w && editor?.kind === "block" && (
        <BlockDialog
          staff={editor.item}
          date={date || w.today}
          at={editor.at}
          w={w}
          api={api}
          onClose={() => setEditor(null)}
          onDone={(block, outcome) => {
            const failed = outcome.filter((o) => !o.ok).length;
            setNotice(failed ? `Blocked ${blockLabel(block)} · ${failed} appointment${failed === 1 ? "" : "s"} could not be changed.` : `Blocked · ${blockLabel(block)}.`);
            void refresh().catch(() => {});
          }}
        />
      )}
      {w && editor && editor.kind !== "detail" && editor.kind !== "block" && (
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
          onRefresh={() => refresh({ background: true })}
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
  offer_id: string | null;
  offers_made: number;
  offer_date?: string | null;
  offer_start_min?: number | null;
  offer_expires_at?: number | null;
  offer_staff_name?: string | null;
  offer_source?: string | null;
};
type QueueMatch = { staff_id: string; staff_name: string; start_min: number; price_pence: number; duration_min: number };
// Settings → Shop page: content of the public home page at /<slug>. Presentation only.
type PageForm = { strapline: string; about: string; cover_url: string; logo_url: string; gallery: string[]; phone: string; email: string; instagram: string; map_url: string; transport_note: string; policy_text: string; sections: string[]; accent: string; theme: ThemeForm; published: number; version: number };
type ThemeForm = { font: string; mode: string; corners: string; hero: string; logo: string };
const THEME_FONTS: { id: string; name: string; sample: string; note: string }[] = [
  { id: "modern", name: "Modern", sample: "Inter", note: "Clean and neutral" },
  { id: "editorial", name: "Editorial", sample: "Fraunces + Manrope", note: "Warm serif headlines" },
  { id: "grotesk", name: "Grotesk", sample: "Space Grotesk", note: "Sharp, contemporary" },
  { id: "heritage", name: "Heritage", sample: "Playfair + DM Sans", note: "Classic barbershop" },
  { id: "condensed", name: "Condensed", sample: "Bebas Neue + DM Sans", note: "Bold, street" },
  { id: "soft", name: "Soft", sample: "DM Sans", note: "Friendly and rounded" },
];
const STOCK_COVERS: { id: string; name: string }[] = [
  { id: "brick", name: "Brick & Edison" },
  { id: "minimal", name: "Bright minimal" },
  { id: "heritage", name: "Heritage green" },
  { id: "industrial", name: "Industrial black" },
  { id: "terracotta", name: "Warm terracotta" },
  { id: "tools", name: "The tools" },
];
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
        logo_url: String(p.logo_url || ""),
        gallery: JSON.parse(String(p.gallery_json || "[]")),
        phone: String(p.phone || ""),
        email: String(p.email || ""),
        instagram: String(p.instagram || ""),
        map_url: String(p.map_url || ""),
        transport_note: String(p.transport_note || ""),
        policy_text: String(p.policy_text || ""),
        sections: JSON.parse(String(p.sections_json || "[]")),
        accent: String(p.accent || "ollo"),
        theme: (() => {
          try {
            const t = JSON.parse(String(p.theme_json || "{}")) as Partial<ThemeForm>;
            return { font: t.font || "modern", mode: t.mode || "light", corners: t.corners || "soft", hero: t.hero || "editorial", logo: t.logo || "auto" };
          } catch {
            return { font: "modern", mode: "light", corners: "soft", hero: "editorial", logo: "auto" };
          }
        })(),
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
            <Field label="Cover photo (upload or https URL)">
              <div className="photo-field">
                <PhotoPreview url={form.cover_url} label="cover photo" onClear={() => set("cover_url", "")} />
                <input type="text" inputMode="url" value={form.cover_url} maxLength={500} placeholder="https://…/shopfront.jpg" onChange={(e) => set("cover_url", e.target.value)} />
                <PhotoUpload kind="cover" label="Upload" testId="upload-cover" onUploaded={([u]) => set("cover_url", u)} />
              </div>
              <div className="stock-covers" role="group" aria-label="Choose a stock cover">
                {STOCK_COVERS.map((c) => {
                  const url = `/static/stock/${c.id}.webp`;
                  return (
                    <button key={c.id} type="button" className={`stock-cover ${form.cover_url === url ? "selected" : ""}`} aria-pressed={form.cover_url === url} onClick={() => set("cover_url", url)} title={c.name} data-testid={`stock-${c.id}`}>
                      <img src={`/static/stock/${c.id}-thumb.webp`} alt={c.name} loading="lazy" />
                      <span>{c.name}</span>
                    </button>
                  );
                })}
              </div>
              <p className="helper">No photo yet? Pick one of ours to start; swap it for your own shopfront any time. Landscape, at least 1600×900; keep the subject centred — the hero crops the edges on tall phones.</p>
            </Field>
            <Field label="Logo (transparent PNG or SVG, square or wide)">
              <div className="photo-field">
                <PhotoPreview url={form.logo_url} label="logo" onClear={() => set("logo_url", "")} />
                <input type="text" inputMode="url" value={form.logo_url} maxLength={500} placeholder="https://…/logo.png" onChange={(e) => set("logo_url", e.target.value)} />
                <PhotoUpload kind="logo" label="Upload" testId="upload-logo" onUploaded={([u]) => set("logo_url", u)} />
              </div>
              <p className="helper">Shown on your shop page, the booking flow and your workspace. Leave empty to use your initials.</p>
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
            <div className="theme-editor" data-testid="theme-editor">
              <div>
                <span className="workspace-field"><span>Typeface</span></span>
                <div className="theme-fonts" role="group" aria-label="Typeface">
                  {THEME_FONTS.map((f) => (
                    <button key={f.id} type="button" className={`theme-font font-${f.id} ${form.theme.font === f.id ? "selected" : ""}`} aria-pressed={form.theme.font === f.id} onClick={() => set("theme", { ...form.theme, font: f.id })} data-testid={`font-${f.id}`}>
                      <b>Aa</b>
                      <span>
                        <strong>{f.name}</strong>
                        <small>{f.note}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="theme-row">
                <Field label="Look">
                  <div className="segmented" role="group" aria-label="Look">
                    {[["light", "Light"], ["dark", "Dark"]].map(([v, l]) => (
                      <button key={v} type="button" aria-pressed={form.theme.mode === v} onClick={() => set("theme", { ...form.theme, mode: v })}>{l}</button>
                    ))}
                  </div>
                </Field>
                <Field label="Corners">
                  <div className="segmented" role="group" aria-label="Corners">
                    {[["soft", "Soft"], ["sharp", "Sharp"]].map(([v, l]) => (
                      <button key={v} type="button" aria-pressed={form.theme.corners === v} onClick={() => set("theme", { ...form.theme, corners: v })}>{l}</button>
                    ))}
                  </div>
                </Field>
                <Field label="Hero layout">
                  <div className="segmented" role="group" aria-label="Hero layout">
                    {[["editorial", "Editorial"], ["centred", "Centred"], ["split", "Split"]].map(([v, l]) => (
                      <button key={v} type="button" aria-pressed={form.theme.hero === v} onClick={() => set("theme", { ...form.theme, hero: v })}>{l}</button>
                    ))}
                  </div>
                </Field>
                {form.logo_url && (
                  <Field label="Logo on dark backgrounds">
                    <div className="segmented" role="group" aria-label="Logo on dark backgrounds">
                      {[["auto", "Auto"], ["original", "Keep colours"]].map(([v, l]) => (
                        <button key={v} type="button" aria-pressed={form.theme.logo === v} onClick={() => set("theme", { ...form.theme, logo: v })}>{l}</button>
                      ))}
                    </div>
                    <span className="helper">Auto turns a dark one-colour logo white where it would otherwise disappear. Choose Keep colours for a full-colour logo.</span>
                  </Field>
                )}
              </div>
            </div>
            <div>
              <span className="workspace-field"><span>Gallery (upload or https URLs, up to 12)</span></span>
              <div className="page-gallery-list" data-testid="gallery-list">
                {form.gallery.map((u, i) => (
                  <div key={i}>
                    <PhotoPreview url={u} label={`gallery image ${i + 1}`} onClear={() => set("gallery", form.gallery.filter((_, j) => j !== i))} />
                    <input type="text" inputMode="url" value={u} maxLength={500} aria-label={`Gallery image ${i + 1}`} onChange={(e) => set("gallery", form.gallery.map((x, j) => (j === i ? e.target.value : x)))} />
                    <Button variant="ghost" aria-label={`Remove gallery image ${i + 1}`} onClick={() => set("gallery", form.gallery.filter((_, j) => j !== i))}>
                      <Icon name="close" size={14} />
                    </Button>
                  </div>
                ))}
                {form.gallery.length < 12 && (
                  <div className="page-gallery-add">
                    <PhotoUpload kind="gallery" multiple label="Upload photos" testId="upload-gallery" onUploaded={(urls) => set("gallery", [...form.gallery.filter(Boolean), ...urls].slice(0, 12))} />
                    <Button variant="ghost" onClick={() => set("gallery", [...form.gallery, ""])}>
                      <Icon name="plus" size={14} /> Add by URL
                    </Button>
                  </div>
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
// Settings → Messages: delivery status, channels, reminders, test send, waiting-list wording, and the outbox.
type OutboxRow = { id: string; channel: string; recipient: string; template: string; body: string; status: string; status_note: string; related_type: string; created_at: number };
const TEMPLATE_LABELS: Record<string, { label: string; hint: string }> = {
  waitlist_joined: { label: "Joined the list", hint: "{first} {shop} {date} {daypart}" },
  waitlist_offer: { label: "A time is offered", hint: "{first} {shop} {service} {barber} {date} {time} {expires} {link}" },
  waitlist_booked: { label: "Offer accepted", hint: "{service} {barber} {shop} {date} {time} {ref} {manage}" },
  waitlist_released: { label: "Declined or expired", hint: "{first} {shop} {date}" },
};
// Settings → Reviews: everything customers have left, hide/show and a public reply.
type ReviewRowView = { id: string; rating: number; body: string; display_name: string; status: "PUBLISHED" | "HIDDEN"; reply: string; reply_at: number | null; version: number; created_at: number; service_name: string; staff_name: string | null; visit_date: string };
function ReviewsPanel({ w }: { w: WorkspaceData }) {
  const [data, setData] = useState<{ reviews: ReviewRowView[]; summary: { count: number; average: number | null; hidden: number } } | null>(null);
  const [error, setError] = useState("");
  const [replying, setReplying] = useState<{ id: string; text: string } | null>(null);
  const [filter, setFilter] = useState<"ALL" | "PUBLISHED" | "HIDDEN">("ALL");
  const canModerate = !w.account || ["OWNER", "MANAGER"].includes(w.account.role);
  const load = () =>
    api<{ reviews: ReviewRowView[]; summary: { count: number; average: number | null; hidden: number } }>("/reviews")
      .then((r) => {
        setData(r);
        setError("");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load reviews."));
  useEffect(() => {
    load();
  }, []);
  async function act(id: string, path: string, body: unknown) {
    try {
      await api(`/reviews/${id}/${path}`, "POST", body);
      setReplying(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That change did not save.");
      if ((e as ApiError).status === 409) load();
    }
  }
  const rows = (data?.reviews || []).filter((r) => filter === "ALL" || r.status === filter);
  const stars = (n: number) => (
    <span className="stars" role="img" aria-label={`${n} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Icon key={i} name="star" size={14} className={i <= n ? "on" : "off"} />
      ))}
    </span>
  );
  return (
    <section className="workspace-card reviews-panel" data-testid="reviews-panel" aria-labelledby="reviews-panel-heading">
      <header className="workspace-card-head">
        <div>
          <h2 id="reviews-panel-heading">Reviews</h2>
          <p>
            Only people who had a booked visit can leave one. You can hide a review from the shop page and reply publicly; the customer's words are never edited.
            {data && data.summary.count > 0 && (
              <>
                {" "}
                <strong data-testid="reviews-summary">
                  {data.summary.average} · {data.summary.count} shown
                </strong>
                {data.summary.hidden > 0 && ` · ${data.summary.hidden} hidden`}
              </>
            )}
          </p>
        </div>
        <div className="queue-filters" role="group" aria-label="Filter reviews">
          {(["ALL", "PUBLISHED", "HIDDEN"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "ALL" ? "All" : f === "PUBLISHED" ? "Shown" : "Hidden"}
            </button>
          ))}
        </div>
      </header>
      {error && <Notice tone="warning">{error}</Notice>}
      {!data ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted" data-testid="reviews-empty">
          No reviews yet. Customers are asked for one after each completed visit (see the outbox above).
        </p>
      ) : (
        <ul className="review-admin-list">
          {rows.map((r) => (
            <li key={r.id} className={`review-admin ${r.status === "HIDDEN" ? "hidden" : ""}`} data-testid="review-row">
              <header>
                {stars(r.rating)}
                <strong>{r.display_name}</strong>
                <span>
                  {r.service_name}
                  {r.staff_name ? ` · ${r.staff_name.split(" ")[0]}` : ""} · {r.visit_date}
                </span>
                {r.status === "HIDDEN" && <StatusPill tone="note">Hidden</StatusPill>}
              </header>
              {r.body ? <p className="review-admin-body">{r.body}</p> : <p className="review-admin-body muted">No comment</p>}
              {r.reply && replying?.id !== r.id && (
                <p className="review-reply">
                  <strong>Your reply</strong>
                  {r.reply}
                </p>
              )}
              {replying?.id === r.id && (
                <div className="review-reply-form">
                  <textarea rows={3} maxLength={400} value={replying.text} onChange={(e) => setReplying({ id: r.id, text: e.target.value })} aria-label="Reply" data-testid="reply-text" />
                  <div className="review-actions">
                    <Button variant="ghost" onClick={() => setReplying(null)}>
                      Cancel
                    </Button>
                    <Button variant="primary" onClick={() => act(r.id, "reply", { reply: replying.text.trim(), version: r.version })} data-testid="reply-save">
                      <Icon name="messageReply" size={14} /> {r.reply ? "Update reply" : "Post reply"}
                    </Button>
                  </div>
                </div>
              )}
              {canModerate && replying?.id !== r.id && (
                <div className="review-admin-actions">
                  <Button variant="ghost" onClick={() => setReplying({ id: r.id, text: r.reply })} data-testid="review-reply">
                    <Icon name="messageReply" size={14} /> {r.reply ? "Edit reply" : "Reply"}
                  </Button>
                  <Button variant="ghost" onClick={() => act(r.id, "status", { status: r.status === "HIDDEN" ? "PUBLISHED" : "HIDDEN", version: r.version })} data-testid="review-toggle">
                    <Icon name={r.status === "HIDDEN" ? "eye" : "eyeOff"} size={14} /> {r.status === "HIDDEN" ? "Show" : "Hide"}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
const MSG_LABELS: Record<string, string> = {
  booking_confirmed: "Booking confirmed", booking_moved: "Booking moved", booking_cancelled: "Booking cancelled",
  booking_reminder: "Reminder (day before)", booking_reminder_soon: "Reminder (2 hours before)", signin_code: "Sign-in code",
  staff_invite: "Team invitation", review_request: "Review request", test_message: "Test message",
  waitlist_joined: "Joined the list", waitlist_offer: "A time is offered", waitlist_booked: "Offer accepted", waitlist_released: "Declined or expired",
  pay_link: "Pay link", verify_contact: "Verification code", password_reset: "Password reset",
  owner_new_booking: "Alert · new booking", owner_cancelled: "Alert · cancellation", owner_no_show: "Alert · no-show", owner_daily_summary: "Alert · morning summary", owner_callback: "Alert · call back (AI receptionist)",
};
// Owner/manager alert preferences (Settings → Messages).
type AlertCh = "OFF" | "EMAIL" | "SMS" | "BOTH";
type AlertPrefs = { new_booking: AlertCh; cancelled: AlertCh; no_show: AlertCh; daily_summary: AlertCh; managers: boolean; summary_hour: number };
type AlertsData = { prefs: AlertPrefs; kinds: { key: keyof AlertPrefs; label: string; hint: string }[]; recipients: { owner_email: string; owner_phone: string; phone_unverified: boolean; managers: { name: string; email: string }[] } };
// AI receptionist (ElevenLabs): per-shop switch, one-time secret, endpoints + prompt to paste, call log.
type VoiceData = {
  settings: { enabled: boolean; agent_id: string; greeting: string; notes: string; has_secret: boolean; created_at: number | null };
  secret_hint: string;
  endpoints: Record<string, { method: string; url: string; query?: string[]; body?: string[] }> | null;
  prompt: string;
  online_booking_required: boolean;
  calls: { id: string; conversation_id: string; caller: string; outcome: string; summary: string; booking_id: string | null; duration_s: number; started_at: number }[];
};
function VoicePanel({ timezone }: { timezone: string }) {
  const [d, setD] = useState<VoiceData | null>(null);
  const [f, setF] = useState<{ enabled: boolean; agent_id: string; greeting: string; notes: string } | null>(null);
  const [secret, setSecret] = useState("");
  const [st, setSt] = useState<{ kind: "idle" | "saving" | "saved" | "error"; text: string }>({ kind: "idle", text: "" });
  const [copied, setCopied] = useState("");
  const [call, setCall] = useState<{ transcript: string; summary: string; caller: string } | null>(null);
  const load = () => api<VoiceData>("/shop/voice").then((r) => { setD(r); setF({ enabled: r.settings.enabled, agent_id: r.settings.agent_id, greeting: r.settings.greeting, notes: r.settings.notes }); }).catch((e) => setSt({ kind: "error", text: e.message }));
  useEffect(() => { load(); }, []);
  if (!d || !f) return null;
  const dirty = JSON.stringify(f) !== JSON.stringify({ enabled: d.settings.enabled, agent_id: d.settings.agent_id, greeting: d.settings.greeting, notes: d.settings.notes });
  async function copy(v: string, label: string) { try { await navigator.clipboard.writeText(v); setCopied(`${label} copied.`); setTimeout(() => setCopied(""), 2500); } catch { setCopied("Copy unavailable here; select the text instead."); } }
  const when = (ms: number) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: timezone || "Europe/London" });
  const TOOLS: { key: string; name: string; what: string }[] = [
    { key: "info", name: "get_shop_info", what: "hours, services, barbers, policies" },
    { key: "availability", name: "check_availability", what: "open times for a service on a day" },
    { key: "book", name: "book_appointment", what: "save the booking; sends the confirmation" },
    { key: "bookings", name: "find_bookings", what: "the caller's upcoming visits by mobile" },
    { key: "cancel", name: "cancel_booking", what: "cancel one of them" },
    { key: "callback", name: "request_callback", what: "leave a message for the shop" },
  ];
  return (
    <section className="workspace-panel" aria-labelledby="voice-heading" data-testid="voice-panel">
      <div className="workspace-section-heading">
        <div>
          <h2 id="voice-heading">AI receptionist</h2>
          <p className="workspace-footnote">An ElevenLabs voice agent answers your phone, checks the diary, books, cancels and takes messages — as your shop, in your name. Your shop gets its own agent and its own key; nothing here is shared with any other shop.</p>
        </div>
        <StatusPill tone={d.settings.enabled ? "good" : "note"} data-testid="voice-status">{d.settings.enabled ? "On" : "Off"}</StatusPill>
      </div>
      {d.online_booking_required && <Notice icon="info">Turn on online booking first — the receptionist books through the same diary and rules.</Notice>}
      <form className="workspace-form" data-testid="voice-form" onSubmit={async (e) => {
        e.preventDefault(); setSt({ kind: "saving", text: "" });
        try {
          const r = await api<{ secret?: string }>("/shop/voice", "PUT", f);
          if (r.secret) setSecret(r.secret);
          await load();
          setSt({ kind: "saved", text: r.secret ? "Receptionist on. Copy the key below now — it is shown once." : "Saved." });
        } catch (err) { setSt({ kind: "error", text: err instanceof Error ? err.message : "Could not save." }); }
      }}>
        <div className="workspace-form-grid">
          <div className="workspace-switch-row">
            <span><strong>Answer calls with the AI receptionist</strong><small>Switching off stops the tools immediately; your ElevenLabs agent keeps its number.</small></span>
            <label className="switch"><input type="checkbox" checked={f.enabled} disabled={d.online_booking_required} onChange={(e) => setF({ ...f, enabled: e.target.checked })} aria-label="AI receptionist" data-testid="voice-enabled" /><span /></label>
          </div>
          <label>ElevenLabs agent ID (optional, for your records)<input type="text" value={f.agent_id} onChange={(e) => setF({ ...f, agent_id: e.target.value })} placeholder="agent_…" /></label>
          <label>Greeting<input type="text" value={f.greeting} maxLength={300} onChange={(e) => setF({ ...f, greeting: e.target.value })} placeholder="Hello, you're through to … how can I help?" /></label>
          <label>Things the receptionist should know<textarea value={f.notes} maxLength={1500} rows={3} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Parking round the back. Card and cash. Kids' cuts weekdays before 4." /></label>
        </div>
        <div className="workspace-form-actions">
          <Button type="submit" disabled={!dirty || st.kind === "saving"} data-testid="voice-save">{st.kind === "saving" ? "Saving…" : "Save"}</Button>
          {st.text && <p className={st.kind === "error" ? "workspace-error" : "workspace-success"} role="status">{st.text}</p>}
        </div>
      </form>
      {d.settings.enabled && d.endpoints && (
        <div className="voice-setup" data-testid="voice-setup">
          <h3>Connect your ElevenLabs agent</h3>
          <ol className="voice-steps">
            <li>
              <strong>Secret key</strong> — in ElevenLabs, add a <em>secret</em> and use it as the <code>Authorization: Bearer</code> header on every tool and on both webhooks.
              <div className="voice-secret">
                <code data-testid="voice-secret">{secret || `ollo_vk_…${d.secret_hint.replace("…", "")} (hidden)`}</code>
                {secret ? <Button variant="ghost" onClick={() => copy(secret, "Key")}>Copy</Button> : (
                  <Button variant="ghost" onClick={async () => { if (!confirm("Generate a new key? The old one stops working straight away.")) return; const r = await api<{ secret: string }>("/shop/voice/rotate", "POST", {}); setSecret(r.secret); load(); }} data-testid="voice-rotate">New key</Button>
                )}
              </div>
            </li>
            <li>
              <strong>System prompt</strong> — paste into the agent. <Button variant="ghost" onClick={() => copy(d.prompt, "Prompt")}>Copy prompt</Button>
            </li>
            <li>
              <strong>Tools</strong> (Agent → Tools → Add webhook). Create one per row; the parameters are the query/body fields.
              <table className="voice-tools">
                <tbody>
                  {TOOLS.map((t) => { const e = d.endpoints![t.key]; return (
                    <tr key={t.key}>
                      <td><code>{t.name}</code><small>{t.what}</small></td>
                      <td><span className="voice-method">{e.method}</span> <code className="voice-url">{e.url}</code>{(e.query || e.body) && <small>{e.query ? `query: ${e.query.join(", ")}` : `body: ${e.body!.join(", ")}`}</small>}</td>
                      <td><Button variant="ghost" onClick={() => copy(e.url, t.name)}>Copy</Button></td>
                    </tr>
                  ); })}
                </tbody>
              </table>
            </li>
            <li>
              <strong>Webhooks</strong> (Agent → Advanced): <em>Conversation initiation</em> → <code>{d.endpoints.personalise_webhook.url}</code> <Button variant="ghost" onClick={() => copy(d.endpoints!.personalise_webhook.url, "Webhook")}>Copy</Button>; <em>Post-call</em> → <code>{d.endpoints.post_call_webhook.url}</code> <Button variant="ghost" onClick={() => copy(d.endpoints!.post_call_webhook.url, "Webhook")}>Copy</Button>. Both use the same bearer key.
            </li>
            <li><strong>Phone number</strong> — buy or import a number in ElevenLabs (Phone numbers) and assign it to the agent; forward your shop line to it.</li>
          </ol>
          {copied && <p className="workspace-success" role="status">{copied}</p>}
        </div>
      )}
      <h3>Recent calls</h3>
      {d.calls.length === 0 ? <p className="workspace-footnote">Calls appear here once the receptionist has answered one, with a summary and transcript.</p> : (
        <ul className="outbox-list" data-testid="voice-calls">
          {d.calls.map((x) => (
            <li key={x.id}>
              <div className="outbox-meta">
                <StatusPill tone={x.outcome === "handled" ? "good" : x.outcome === "callback" ? "warn" : x.outcome === "in_progress" ? "next" : "note"}>{x.outcome.replace("_", " ")}</StatusPill>
                <span>{x.caller || "Unknown number"} · {when(x.started_at)}{x.duration_s ? ` · ${Math.round(x.duration_s / 60)} min` : ""}{x.booking_id ? " · booked" : ""}</span>
              </div>
              <code>{x.summary || "No summary yet."}</code>
              {x.outcome !== "callback" && <div className="outbox-actions"><Button variant="ghost" onClick={async () => { const r = await api<{ call: { transcript: string; summary: string; caller: string } }>(`/shop/voice/calls/${x.id}`); setCall(r.call); }}><Icon name="eye" size={14} /> Transcript</Button></div>}
            </li>
          ))}
        </ul>
      )}
      {call && (
        <Modal title={`Call from ${call.caller || "unknown number"}`} onClose={() => setCall(null)}>
          <p className="workspace-footnote">{call.summary}</p>
          <pre className="voice-transcript">{call.transcript || "No transcript was sent."}</pre>
        </Modal>
      )}
    </section>
  );
}
function AlertsPanel({ smsLive }: { smsLive: boolean }) {
  const [d, setD] = useState<AlertsData | null>(null);
  const [p, setP] = useState<AlertPrefs | null>(null);
  const [st, setSt] = useState<{ kind: "idle" | "saving" | "saved" | "error"; text: string }>({ kind: "idle", text: "" });
  useEffect(() => { api<AlertsData>("/shop/alerts").then((r) => { setD(r); setP(r.prefs); }).catch((e) => setSt({ kind: "error", text: e.message })); }, []);
  if (!d || !p) return null;
  const dirty = JSON.stringify(p) !== JSON.stringify(d.prefs);
  const r = d.recipients;
  return (
    <form className="workspace-form" data-testid="alerts-form" onSubmit={async (e) => {
      e.preventDefault(); setSt({ kind: "saving", text: "" });
      try { await api("/shop/alerts", "PUT", p); setD({ ...d, prefs: p }); setSt({ kind: "saved", text: "Alert settings saved." }); } catch (err) { setSt({ kind: "error", text: err instanceof Error ? err.message : "Could not save." }); }
    }}>
      <h3>Alerts for you and your managers</h3>
      <p className="workspace-footnote">
        Go to <strong>{r.owner_email}</strong>{r.owner_phone ? <> and <strong>{r.owner_phone}</strong></> : r.phone_unverified ? <> — verify the shop mobile in setup to get texts</> : <> — add a shop mobile in setup to get texts</>}
        {r.managers.length ? <>; managers ({r.managers.map((m) => m.name).join(", ")}) get the emails too.</> : "."}
      </p>
      <div className="alerts-grid">
        {d.kinds.map((k) => (
          <div className="alerts-row" key={k.key}>
            <span><strong>{k.label}</strong><small>{k.hint}</small></span>
            <div className="segmented" role="group" aria-label={k.label}>
              {(["OFF", "EMAIL", "SMS", "BOTH"] as AlertCh[]).map((v) => (
                <button key={v} type="button" aria-pressed={p[k.key] === v} disabled={(v === "SMS" || v === "BOTH") && !r.owner_phone} title={(v === "SMS" || v === "BOTH") && !r.owner_phone ? "Needs a verified shop mobile" : undefined} onClick={() => setP({ ...p, [k.key]: v })} data-testid={`alert-${k.key}-${v}`}>
                  {v === "OFF" ? "Off" : v === "EMAIL" ? "Email" : v === "SMS" ? "Text" : "Both"}
                </button>
              ))}
            </div>
          </div>
        ))}
        {p.daily_summary !== "OFF" && (
          <div className="alerts-row">
            <span><strong>Summary time</strong><small>Shop local time, only on days with visits.</small></span>
            <select value={p.summary_hour} onChange={(e) => setP({ ...p, summary_hour: Number(e.target.value) })}>{[5, 6, 7, 8, 9, 10, 11, 12].map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</select>
          </div>
        )}
        <label className="setup-check"><input type="checkbox" checked={p.managers} onChange={(e) => setP({ ...p, managers: e.target.checked })} /> <span>Managers get these alerts too (email only)</span></label>
      </div>
      {!smsLive && (p.new_booking.includes("SMS") || p.new_booking === "BOTH") && <p className="workspace-footnote">Texting isn't connected on this deployment yet; text alerts show in the list below until it is.</p>}
      {st.text && <p className={st.kind === "error" ? "workspace-error" : "workspace-success"} role="status">{st.text}</p>}
      <div className="workspace-save-actions"><Button type="submit" disabled={!dirty || st.kind === "saving"}>{st.kind === "saving" ? "Saving…" : "Save alerts"}</Button></div>
    </form>
  );
}
type Providers = { email: { provider: "resend" | "mailbox"; from: string }; sms: { provider: "twilio" | "clicksend" | "mailbox"; from: string }; wa?: { provider: "infobip" | "mailbox"; sender: string; test_sender: boolean; keyword: string } };
type Messaging = { msg_sms: number; msg_email: number; msg_wa?: number; msg_reminders: number; msg_reminder_hours: number; msg_reply_to: string; msg_sms_sender: string };
const CHANNEL_LABEL: Record<string, string> = { SMS: "Text", EMAIL: "Email", WA: "WhatsApp" };
type OutboxData = {
  shop_version?: number; notifications: (OutboxRow & { subject?: string; provider?: string; attempts?: number; error?: string; sent_at?: number | null })[]; counts_30d: Record<string, number>; providers: Providers; messaging: Messaging; templates: Record<string, string>; defaults: Record<string, string>; settings: { waitlist_auto_offer: number; waitlist_offer_hold_min: number } };
function WaitlistSettingsPanel({ w }: { w: WorkspaceData }) {
  const [data, setData] = useState<OutboxData | null>(null);
  const [form, setForm] = useState<{ auto: number; hold: number; templates: Record<string, string> } | null>(null);
  const [msg, setMsg] = useState<Messaging | null>(null);
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" | "error"; text: string }>({ kind: "idle", text: "" });
  const [msgState, setMsgState] = useState<{ kind: "idle" | "saving" | "saved" | "error"; text: string }>({ kind: "idle", text: "" });
  const [test, setTest] = useState<{ channel: "SMS" | "EMAIL"; to: string; busy: boolean; result: string }>({ channel: "EMAIL", to: "", busy: false, result: "" });
  const [filter, setFilter] = useState<"" | "SENT" | "FAILED" | "QUEUED">("");
  const [preview, setPreview] = useState<{ subject: string; html: string; body: string; channel: string } | null>(null);
  const [copied, setCopied] = useState("");
  const load = () =>
    api<OutboxData>(`/notifications?limit=60${filter ? `&status=${filter}` : ""}`)
      .then((d) => {
        setData(d);
        setForm((f) => f ?? { auto: d.settings.waitlist_auto_offer, hold: d.settings.waitlist_offer_hold_min, templates: { ...d.templates } });
        setMsg((m) => m ?? d.messaging);
      })
      .catch((e) => setState({ kind: "error", text: e instanceof Error ? e.message : "Could not load." }));
  useEffect(() => {
    load();
  }, [w.shop.version, filter]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setState({ kind: "saving", text: "" });
    try {
      const r = await api<{ shop: { version: number } }>("/shop/waitlist", "PUT", { waitlist_auto_offer: form.auto, waitlist_offer_hold_min: form.hold, templates: form.templates, version: data?.shop_version ?? w.shop.version });
      setData((d) => (d ? { ...d, shop_version: r.shop.version } : d));
      setState({ kind: "saved", text: "Saved. New offers use this wording; existing messages are unchanged." });
    } catch (err) {
      setState({ kind: "error", text: err instanceof Error ? err.message : "Could not save." });
    }
  }
  async function saveMessaging(e: FormEvent) {
    e.preventDefault();
    if (!msg) return;
    setMsgState({ kind: "saving", text: "" });
    try {
      const r = await api<{ shop_version?: number }>("/shop/messaging", "PUT", msg);
      setData((d) => (d && typeof r.shop_version === "number" ? { ...d, shop_version: r.shop_version } : d));
      setMsgState({ kind: "saved", text: "Saved." });
    } catch (err) {
      setMsgState({ kind: "error", text: err instanceof Error ? err.message : "Could not save." });
    }
  }
  async function sendTest(e: FormEvent) {
    e.preventDefault();
    setTest({ ...test, busy: true, result: "" });
    try {
      const r = await api<{ notification: { status: string; status_note: string; error: string } }>("/notifications/test", "POST", { channel: test.channel, to: test.to });
      const n = r.notification;
      setTest({ ...test, busy: false, result: n.status === "SENT" ? `Sent${n.status_note ? ` — ${n.status_note}` : "."}` : `${n.status}: ${n.error || n.status_note}` });
      load();
    } catch (err) {
      setTest({ ...test, busy: false, result: err instanceof Error ? err.message : "Could not send." });
    }
  }
  async function resend(id: string) {
    try {
      await api(`/notifications/${id}/resend`, "POST", {});
      load();
    } catch (err) {
      setCopied(err instanceof Error ? err.message : "Could not resend.");
    }
  }
  async function openPreview(id: string) {
    const r = await api<{ notification: { subject: string; html: string; body: string; channel: string } }>(`/notifications/${id}`);
    setPreview(r.notification);
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("Message copied.");
    } catch {
      setCopied("Copy unavailable here; select the text instead.");
    }
  }
  const fmtWhen = (ms: number) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: w.shop.timezone || "Europe/London" });
  const tone: Record<string, "good" | "next" | "paid" | "warn" | "note"> = { SENT: "good", QUEUED: "next", SENDING: "next", FAILED: "warn", SKIPPED: "note" };
  const smsLive = data ? data.providers.sms.provider !== "mailbox" : false;
  const waLive = data ? data.providers.wa?.provider === "infobip" : false;
  const live = data ? data.providers.email.provider === "resend" || smsLive || waLive : false;
  const c30 = data?.counts_30d || {};
  return (
    <section className="workspace-panel" aria-labelledby="waitlist-settings-heading" data-testid="waitlist-settings">
      <div className="workspace-section-heading">
        <div>
          <h2 id="waitlist-settings-heading">Messages</h2>
          <p className="workspace-footnote">Confirmations, reminders, sign-in codes and waiting-list offers go out from your shop — your name, your logo. Choose the channels below; every message is listed at the bottom with its delivery status.</p>
        </div>
        {data && (
          <StatusPill tone={live ? "good" : "note"} data-testid="messaging-status">
            {live ? `Live · ${[data.providers.email.provider === "resend" && "email", smsLive && "SMS", waLive && "WhatsApp"].filter(Boolean).join(" + ")}` : "Preview mode · nothing is sent"}
          </StatusPill>
        )}
      </div>
      {data && !live && (
        <p className="workspace-footnote" data-testid="messaging-preview-note">
          No email or SMS provider is connected to this deployment yet, so messages are delivered to a preview mailbox here instead of to customers. Once a provider is connected they go out for real without any other change.
        </p>
      )}
      {msg && data && (
        <form className="workspace-form" onSubmit={saveMessaging} data-testid="messaging-form">
          <div className="workspace-form-grid">
            <div className="workspace-switch-row">
              <span>
                <strong>Text messages</strong>
                <small>Confirmations, reminders and sign-in codes by SMS when we have a mobile number.{smsLive ? ` Sending from ${msg.msg_sms_sender || data.providers.sms.from || "a shared number"}.` : ""}</small>
              </span>
              <label className="switch">
                <input type="checkbox" checked={!!msg.msg_sms} onChange={(e) => setMsg({ ...msg, msg_sms: e.target.checked ? 1 : 0 })} aria-label="Text messages" data-testid="msg-sms" />
                <span />
              </label>
            </div>
            <div className="workspace-switch-row">
              <span>
                <strong>WhatsApp</strong>
                <small>
                  Customers who pick WhatsApp when booking get their confirmation and reminder there, from foliyo’s WhatsApp number with your shop name in the message. Falls back to a text if WhatsApp cannot deliver.
                  {waLive && data.providers.wa?.test_sender ? ` Test sender: customers must first text “${data.providers.wa.keyword}” to +${data.providers.wa.sender} on WhatsApp.` : waLive ? ` Sending from +${data.providers.wa?.sender}.` : " Not connected on this deployment yet."}
                </small>
              </span>
              <label className="switch">
                <input type="checkbox" checked={(msg.msg_wa ?? 1) === 1} onChange={(e) => setMsg({ ...msg, msg_wa: e.target.checked ? 1 : 0 })} aria-label="WhatsApp messages" data-testid="msg-wa" />
                <span />
              </label>
            </div>
            <div className="workspace-switch-row">
              <span>
                <strong>Emails</strong>
                <small>Sent as “{w.shop.name}”{data.providers.email.from ? ` from ${data.providers.email.from}` : ""}. Replies go to your shop email{msg.msg_reply_to ? ` (${msg.msg_reply_to})` : ""}.</small>
              </span>
              <label className="switch">
                <input type="checkbox" checked={!!msg.msg_email} onChange={(e) => setMsg({ ...msg, msg_email: e.target.checked ? 1 : 0 })} aria-label="Emails" data-testid="msg-email" />
                <span />
              </label>
            </div>
            <div className="workspace-switch-row">
              <span>
                <strong>Reminders</strong>
                <small>A reminder the day before, and a short one two hours before the visit.</small>
              </span>
              <label className="switch">
                <input type="checkbox" checked={!!msg.msg_reminders} onChange={(e) => setMsg({ ...msg, msg_reminders: e.target.checked ? 1 : 0 })} aria-label="Reminders" data-testid="msg-reminders" />
                <span />
              </label>
            </div>
            <Field label="Day-before reminder, hours ahead">
              <input type="number" min={1} max={72} value={msg.msg_reminder_hours} disabled={!msg.msg_reminders} onChange={(e) => setMsg({ ...msg, msg_reminder_hours: Number(e.target.value) })} data-testid="msg-reminder-hours" />
            </Field>
            <Field label="Reply-to email (optional)">
              <input type="email" value={msg.msg_reply_to} maxLength={120} placeholder="hello@yourshop.com" onChange={(e) => setMsg({ ...msg, msg_reply_to: e.target.value })} />
            </Field>
            <Field label="SMS sender name (optional, up to 11 letters)">
              <input type="text" value={msg.msg_sms_sender} maxLength={11} placeholder={w.shop.name.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 11)} onChange={(e) => setMsg({ ...msg, msg_sms_sender: e.target.value })} />
            </Field>
          </div>
          {msgState.text && (
            <p className={msgState.kind === "error" ? "workspace-error" : "workspace-success"} role={msgState.kind === "error" ? "alert" : "status"}>
              {msgState.text}
            </p>
          )}
          <div className="workspace-form-actions">
            <Button type="submit" disabled={msgState.kind === "saving"} data-testid="save-messaging">
              {msgState.kind === "saving" ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      )}
      {data && (
        <form className="workspace-form test-message-form" onSubmit={sendTest} data-testid="test-message-form">
          <h3>Send yourself a test</h3>
          <div className="workspace-form-grid">
            <Field label="Channel">
              <select value={test.channel} onChange={(e) => setTest({ ...test, channel: e.target.value as "SMS" | "EMAIL" })} data-testid="test-channel">
                <option value="EMAIL">Email</option>
                <option value="SMS">Text message</option>
              </select>
            </Field>
            <Field label={test.channel === "SMS" ? "Mobile number" : "Email address"}>
              <input type={test.channel === "SMS" ? "tel" : "email"} required value={test.to} onChange={(e) => setTest({ ...test, to: e.target.value })} placeholder={test.channel === "SMS" ? "07…" : "you@example.com"} data-testid="test-to" />
            </Field>
          </div>
          {test.result && (
            <p className="workspace-success" role="status" data-testid="test-result">
              {test.result}
            </p>
          )}
          <div className="workspace-form-actions">
            <Button type="submit" variant="secondary" disabled={test.busy} data-testid="send-test">
              {test.busy ? "Sending…" : "Send test"}
            </Button>
          </div>
        </form>
      )}
      {form && data && (
        <form className="workspace-form" onSubmit={save} data-testid="waitlist-settings-form">
          <h3>Waiting list</h3>
          <div className="workspace-form-grid">
            <div className="workspace-switch-row">
              <span>
                <strong>Offer freed slots automatically</strong>
                <small>When a booking is cancelled or moved, the oldest matching request on that day is offered the time.</small>
              </span>
              <label className="switch">
                <input type="checkbox" checked={!!form.auto} onChange={(e) => setForm({ ...form, auto: e.target.checked ? 1 : 0 })} aria-label="Offer freed slots automatically" data-testid="auto-offer" />
                <span />
              </label>
            </div>
            <Field label="Hold an offer for (minutes)">
              <input type="number" min={15} max={1440} step={15} value={form.hold} onChange={(e) => setForm({ ...form, hold: Number(e.target.value) })} data-testid="offer-hold" />
            </Field>
          </div>
          <fieldset className="template-fields">
            <legend>Waiting-list wording</legend>
            {Object.keys(TEMPLATE_LABELS).map((k) => (
              <Field key={k} label={TEMPLATE_LABELS[k].label}>
                <textarea value={form.templates[k] ?? ""} rows={2} maxLength={400} onChange={(e) => setForm({ ...form, templates: { ...form.templates, [k]: e.target.value } })} data-testid={`template-${k}`} />
                <span className="field-help">
                  Placeholders: <code>{TEMPLATE_LABELS[k].hint}</code>
                  {form.templates[k] !== data.defaults[k] && (
                    <>
                      {" · "}
                      <button type="button" className="linkish" onClick={() => setForm({ ...form, templates: { ...form.templates, [k]: data.defaults[k] } })}>
                        Reset to default
                      </button>
                    </>
                  )}
                </span>
              </Field>
            ))}
          </fieldset>
          {state.text && (
            <p className={state.kind === "error" ? "workspace-error" : "workspace-success"} role={state.kind === "error" ? "alert" : "status"}>
              {state.text}
            </p>
          )}
          <div className="workspace-form-actions">
            <Button type="submit" disabled={state.kind === "saving"} data-testid="save-waitlist-settings">
              {state.kind === "saving" ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      )}
      {data && <AlertsPanel smsLive={smsLive} />}
      {data && <VoicePanel timezone={w.shop.timezone} />}
      <div className="outbox" data-testid="outbox">
        <div className="outbox-head">
          <h3>
            Sent messages <small>{data ? `last 30 days: ${c30.SENT || 0} sent · ${c30.FAILED || 0} failed · ${(c30.QUEUED || 0) + (c30.SENDING || 0)} waiting` : ""}</small>
          </h3>
          <div className="segmented" role="group" aria-label="Filter messages">
            {([["", "All"], ["SENT", "Sent"], ["FAILED", "Failed"], ["QUEUED", "Waiting"]] as const).map(([v, l]) => (
              <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}>{l}</button>
            ))}
          </div>
        </div>
        {copied && (
          <p className="workspace-success" role="status">
            {copied}
          </p>
        )}
        {data && data.notifications.length === 0 && <p className="workspace-footnote">Nothing here yet. Confirmations, reminders, codes and waiting-list offers all appear as they go out.</p>}
        <ul className="outbox-list">
          {data?.notifications.map((n) => (
            <li key={n.id} data-testid="outbox-row" data-status={n.status}>
              <div className="outbox-meta">
                <StatusPill tone={tone[n.status] ?? "note"}>{n.status === "SKIPPED" ? "Not sent" : n.status === "QUEUED" || n.status === "SENDING" ? "Waiting" : n.status.toLowerCase()}</StatusPill>
                <span>
                  {CHANNEL_LABEL[n.channel] ?? n.channel} · {n.recipient} · {MSG_LABELS[n.template] ?? TEMPLATE_LABELS[n.template]?.label ?? n.template} · {fmtWhen(n.sent_at || n.created_at)}
                  {n.provider === "mailbox" && " · preview"}
                </span>
              </div>
              <code>{n.channel === "EMAIL" && n.subject ? `${n.subject} — ` : ""}{n.body}</code>
              {n.status === "FAILED" && n.error && <p className="workspace-error outbox-error">{n.error}</p>}
              <div className="outbox-actions">
                {n.channel === "EMAIL" && (
                  <Button variant="ghost" onClick={() => openPreview(n.id)} data-testid="preview-email">
                    <Icon name="eye" size={14} /> Preview
                  </Button>
                )}
                <Button variant="ghost" onClick={() => copy(n.body)}>
                  <Icon name="copy" size={14} /> Copy
                </Button>
                {(n.status === "FAILED" || n.status === "SKIPPED") && (
                  <Button variant="ghost" onClick={() => resend(n.id)} data-testid="resend-message">
                    <Icon name="refresh" size={14} /> Send again
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
      {preview && (
        <div className="modal-scrim" onClick={() => setPreview(null)} role="presentation">
          <div className="modal email-preview" role="dialog" aria-label="Email preview" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong>{preview.subject}</strong>
              <Button variant="ghost" onClick={() => setPreview(null)} aria-label="Close preview">
                <Icon name="close" size={16} />
              </Button>
            </div>
            <iframe title="Email preview" srcDoc={preview.html} {...{ ["sand" + "box"]: "" }} />
          </div>
        </div>
      )}
    </section>
  );
}
function CustomerPagesPanel({ w, onOpenBooking }: { w: WorkspaceData; onOpenBooking: (id: string) => void }) {
  const [manageLink, setManageLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = !!w.shop.slug && w.shop.online_booking === 1;
  const bookUrl = w.shop.slug ? `${location.origin}/book/${w.shop.slug}` : "";
  // `w.bookings` only holds the calendar day; look ahead a month for the next upcoming visit.
  const [sample, setSample] = useState<{ id: string; customer_name: string; start_at: number } | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    api<{ bookings: { id: string; customer_name: string; start_at: number; status: string }[] }>(
      `/bookings/range?from=${w.today}&to=${datePlus(w.today, 31)}`,
    )
      .then((r) => {
        if (cancelled) return;
        const next = r.bookings
          .filter((b) => ["CONFIRMED", "CHECKED_IN"].includes(b.status) && b.start_at > Date.now())
          .sort((a, b) => a.start_at - b.start_at)[0];
        setSample(next);
      })
      .catch(() => {
        if (!cancelled) setSample(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [w.shop.id, w.today]);
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
      note: live ? `${bookUrl} · straight to booking, for Instagram bios and QR codes` : w.shop.slug ? "Online booking is switched off above" : "Choose a public address above to enable",
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
      note: sample ? `What customers get after booking: reschedule, cancel, add to calendar. Preview uses ${sample.customer_name}'s next visit.` : "Appears once there is an upcoming appointment",
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
    { icon: "hourglass", title: "Waiting list & offers", note: "Customers join from the booking page when a day is full; you work the queue from the hourglass in the top bar. Freed slots are offered automatically.", status: "live" },
    {
      icon: "globe",
      title: "Shop home page",
      note: live ? `${location.origin}/${w.shop.slug} · your public page: next available, services, team, hours and booking` : "Publishes when online booking is on",
      status: "live",
      action: live ? (
        <a className="button secondary" href={`${location.origin}/${w.shop.slug}`} target="_blank" rel="noreferrer" data-testid="view-home-page">
          <Icon name="external" size={15} /> View as customer
        </a>
      ) : undefined,
    },
    {
      icon: "userRound",
      title: "Customer accounts",
      note: "Customers sign in with a one-time code to see upcoming visits, move or cancel, rebook their usual and manage their details.",
      status: "live",
      action: live ? (
        <a className="button secondary" href={`${location.origin}/${w.shop.slug}/me`} target="_blank" rel="noreferrer" data-testid="view-customer-area">
          <Icon name="external" size={15} /> View as customer
        </a>
      ) : undefined,
    },
  ];
  return (
    <section className="workspace-panel" aria-labelledby="customer-pages-heading" data-testid="customer-pages">
      <div className="workspace-section-heading">
        <div>
          <h2 id="customer-pages-heading">Your links</h2>
          <p className="workspace-footnote">Everything your customers see. Share these on Instagram, Google and in the shop.</p>
        </div>
      </div>
      <ErrorMessage error={error} />
      <ul className="customer-pages">
        {rows.map((r) => (
          <li key={r.title}>
            <span className="tx-ic">
              <Icon name={r.icon} size={16} />
            </span>
            <span className="customer-page-text">
              <b>{r.title}</b>
              <small>{r.note}</small>
            </span>
            <span className="customer-page-action">{r.action}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Notifications drawer (bell): schedule issues. The waiting list has its own Queue drawer.
function NotificationsDrawer({ w, onReview, onClose }: { w: WorkspaceData; onReview: (bookingId: string) => void; onClose: () => void }) {
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
  const total = w.issues.length;
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer-right notifications-drawer" aria-label="Notifications" ref={ref} data-testid="notifications">
        <h2>
          Notifications
          <small>{total ? `${total} item${total === 1 ? "" : "s"}` : "All clear"}</small>
          <IconButton name="close" label="Close notifications" onClick={onClose} />
        </h2>
        {w.issues.length > 0 ? (
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
        ) : (
          <p className="drawer-note left">Nothing needs your attention. The waiting list lives under the hourglass in the top bar.</p>
        )}
      </aside>
    </>
  );
}
// Queue drawer (hourglass): the waiting list, worked from the top bar. See docs/WAITLIST-PLAN.md.
function QueueDrawer({
  w,
  date,
  waitlist,
  onRefresh,
  onBook,
  onOpenSettings,
  onClose,
}: {
  w: WorkspaceData;
  date: string;
  waitlist: WaitlistEntry[];
  onRefresh: () => void;
  onBook: (entry: WaitlistEntry) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [offering, setOffering] = useState<{ entry: WaitlistEntry; matches: QueueMatch[] | null } | null>(null);
  const [lastOffer, setLastOffer] = useState<{ link: string; body: string; name: string } | null>(null);
  const [copied, setCopied] = useState("");
  const [filter, setFilter] = useState<"all" | "today" | "offered">("all");
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (offering ? setOffering(null) : onClose());
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [offering]);
  async function close(entry: WaitlistEntry) {
    setBusyId(entry.id);
    setError("");
    try {
      await api(`/waitlist/${entry.id}/status`, "POST", { status: "CLOSED", version: entry.version });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update.");
    } finally {
      setBusyId("");
    }
  }
  async function startOffer(entry: WaitlistEntry) {
    setOffering({ entry, matches: null });
    setError("");
    try {
      const r = await api<{ matches: QueueMatch[] }>(`/waitlist/${entry.id}/matches`);
      setOffering((o) => (o && o.entry.id === entry.id ? { entry, matches: r.matches } : o));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load times.");
      setOffering(null);
    }
  }
  async function sendOffer(entry: WaitlistEntry, m: QueueMatch) {
    setBusyId(entry.id);
    setError("");
    try {
      const r = await api<{ offer: { link: string; body: string } }>(`/waitlist/${entry.id}/offer`, "POST", { staff_id: m.staff_id, start_min: m.start_min, version: entry.version });
      setLastOffer({ link: r.offer.link, body: r.offer.body, name: entry.customer_name });
      setOffering(null);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not offer that time.");
    } finally {
      setBusyId("");
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
  const part: Record<string, string> = { ANY: "any time", MORNING: "morning", AFTERNOON: "afternoon", EVENING: "evening" };
  const shown = waitlist.filter((r) => (filter === "today" ? r.date === date : filter === "offered" ? r.status === "OFFERED" : true));
  const offered = waitlist.filter((r) => r.status === "OFFERED").length;
  const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" });
  const canOffer = (r: WaitlistEntry) => r.date >= w.today;
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer-right queue-drawer" aria-label="Waiting list" ref={ref} data-testid="queue-drawer">
        <h2>
          Waiting list
          <small>{waitlist.length ? `${waitlist.length} waiting${offered ? ` · ${offered} offered` : ""}` : "Nobody waiting"}</small>
          <IconButton name="close" label="Close waiting list" onClick={onClose} />
        </h2>
        <p className="drawer-note left">
          Customers who asked to be contacted when a full day opens up. Offer a time and the message is prepared for them; a freed slot is offered automatically when auto-offer is on.
        </p>
        <div className="queue-filters" role="group" aria-label="Filter waiting list">
          {(
            [
              ["all", `All · ${waitlist.length}`],
              ["today", `${date === w.today ? "Today" : fmt(date)} · ${waitlist.filter((r) => r.date === date).length}`],
              ["offered", `Offered · ${offered}`],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <ErrorMessage error={error} />
        {lastOffer && (
          <div className="queue-offer-sent" role="status" data-testid="offer-sent">
            <strong>Offer sent to {lastOffer.name}.</strong>
            <small>Delivery shows under Settings → Messages. Want to send it yourself too?</small>
            <code>{lastOffer.body}</code>
            <div className="queue-offer-actions">
              <Button variant="secondary" onClick={() => copy(lastOffer.body, "Message")}>
                <Icon name="copy" size={14} /> Copy message
              </Button>
              <Button variant="ghost" onClick={() => copy(lastOffer.link, "Link")}>
                Copy link only
              </Button>
              <Button variant="ghost" onClick={() => setLastOffer(null)}>
                Dismiss
              </Button>
            </div>
            {copied && <small>{copied}</small>}
          </div>
        )}
        {offering ? (
          <section className="queue-offering" aria-labelledby="queue-offer-heading" data-testid="queue-offer-picker">
            <h3 id="queue-offer-heading">
              <Icon name="send" size={16} /> Offer a time to {offering.entry.customer_name}
            </h3>
            <p className="drawer-note left">
              {offering.entry.service_name} · {offering.entry.staff_name || "any barber"} · {fmt(offering.entry.date)} · {part[offering.entry.daypart]}. Free times that fit their request:
            </p>
            {offering.matches === null ? (
              <p className="drawer-note left">Checking the diary…</p>
            ) : offering.matches.length === 0 ? (
              <p className="drawer-note left">Nothing fits yet. Times will be offered automatically if a booking on that day is cancelled or moved.</p>
            ) : (
              <ul className="queue-matches">
                {offering.matches.map((m) => (
                  <li key={`${m.staff_id}-${m.start_min}`}>
                    <button type="button" onClick={() => sendOffer(offering.entry, m)} disabled={busyId === offering.entry.id} data-testid="queue-match">
                      <b>{time(m.start_min)}</b>
                      <span>
                        {m.staff_name.split(" ")[0]} · {m.duration_min} min · {money(m.price_pence)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="ghost" onClick={() => setOffering(null)}>
              <Icon name="arrowLeft" size={14} /> Back to the list
            </Button>
          </section>
        ) : (
          <ul className="notify-list queue-list" data-testid="queue-list">
            {shown.length === 0 && <li className="queue-empty">{waitlist.length ? "Nothing in this view." : "No one is waiting. Customers can join from the booking page when a day is full."}</li>}
            {shown.map((r) => (
              <li key={r.id} className={r.status === "OFFERED" ? "offered" : ""} data-testid="queue-row">
                <div>
                  <strong>
                    {r.customer_name}
                    {r.status === "OFFERED" && (
                      <StatusPill tone="next">
                        Offered{r.offer_source === "AUTO" ? " · auto" : ""}
                      </StatusPill>
                    )}
                  </strong>
                  <small>
                    {r.service_name} · {r.staff_name || "Any barber"} · {part[r.daypart]}
                  </small>
                  <small>
                    {fmt(r.date)} · {r.phone}
                    {r.offers_made > 0 && r.status !== "OFFERED" ? ` · ${r.offers_made} offer${r.offers_made === 1 ? "" : "s"} so far` : ""}
                  </small>
                  {r.status === "OFFERED" && r.offer_start_min != null && (
                    <small className="queue-offer-line">
                      <Icon name="clock" size={11} /> {time(r.offer_start_min)} with {(r.offer_staff_name || "").split(" ")[0]} · until{" "}
                      {r.offer_expires_at ? new Date(r.offer_expires_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : ""}
                    </small>
                  )}
                </div>
                <div className="waitlist-row-actions">
                  {canOffer(r) && (
                    <Button onClick={() => startOffer(r)} disabled={busyId === r.id} data-testid="queue-offer">
                      {r.status === "OFFERED" ? "Offer another" : "Offer a time"}
                    </Button>
                  )}
                  <Button variant="secondary" onClick={() => onBook(r)} disabled={busyId === r.id}>
                    Book them in
                  </Button>
                  <Button variant="ghost" onClick={() => close(r)} disabled={busyId === r.id}>
                    {busyId === r.id ? "…" : "Remove"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {w.account?.role !== "BARBER" && (
          <button type="button" className="queue-settings-link" onClick={onOpenSettings} data-testid="queue-settings">
            <Icon name="settings" size={14} /> Auto-offer, hold time and message wording are in Settings → Messages
          </button>
        )}
        <p className="drawer-note">Messages are recorded in the outbox; connect a provider in Settings to send them.</p>
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
    <details className="share-booking" open>
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
        and collision guards as this workspace. Customers get a confirmation by text or email; no payment is taken online.
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
              pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
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
  account_last_seen_at: number | null;
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
  const [importing, setImporting] = useState(false);
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
    }, query ? 120 : 0);
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
            <div className="row-actions">
              {canMerge && (
                <Button variant="secondary" onClick={() => setImporting(true)} data-testid="import-customers">
                  <Icon name="download" size={16} /> Import
                </Button>
              )}
              <Button onClick={() => setAdding(true)}>
                <Icon name="plus" size={16} /> Add customer
              </Button>
            </div>
          )}
        </div>
        {importing && <ImportCustomers onClose={() => setImporting(false)} onDone={() => { setImporting(false); setReload((n) => n + 1); }} />}
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
                      {c.account_last_seen_at ? (
                        <>
                          {" · "}
                          <Icon name="userRound" size={11} /> online account
                        </>
                      ) : null}
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
                    {profile.customer.account_last_seen_at ? <span className="tag" data-testid="has-account">Online account</span> : null}
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
                  <strong>{profile.favourite_staff_id ? staffName(profile.favourite_staff_id) : "None yet"}</strong>
                  {profile.customer.preferred_staff_id && profile.customer.preferred_staff_id !== profile.favourite_staff_id && (
                    <small>Prefers {staffName(profile.customer.preferred_staff_id)}</small>
                  )}
                </div>
                <div>
                  <span className="eyebrow">Usual service</span>
                  <strong>{profile.favourite_service || "None yet"}</strong>
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
      <p>Add a booking, change the date or clear your filters.</p>
    </div>
  );
}

type EditorProps = {
  editor: Editor;
  w: WorkspaceData;
  date: string;
  onClose: () => void;
  saved: (path: string, method: string, body?: unknown) => Promise<{ booking?: StoredBooking } | void>;
  onRefresh: () => Promise<unknown>;
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
  onRefresh,
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
  // Conflict management: hours/leave/closure forms preview first. If appointments clash, the
  // resolver replaces the form; "Save and …" applies the change plus every decision in one call.
  const [conflict, setConflict] = useState<{ change: ScheduleChange; preview: ConflictPreview; title: string } | null>(null);
  const [conflictDone, setConflictDone] = useState<{ outcome: ConflictOutcomeRow[]; title: string } | null>(null);
  async function guardedSave(change: ScheduleChange, title: string) {
    const preview = await api<ConflictPreview>("/schedule/preview", "POST", change);
    if (preview.conflicts.length === 0) {
      await saved("/schedule/apply", "POST", { change, decisions: [] });
      return;
    }
    setConflict({ change, preview, title });
  }
  async function applyConflict(decisions: ConflictDecision[]) {
    if (!conflict) return;
    const r = await api<{ outcome: ConflictOutcomeRow[] }>("/schedule/apply", "POST", { change: conflict.change, decisions });
    setConflictDone({ outcome: r.outcome, title: conflict.title });
    setConflict(null);
    // Refresh in the background so the calendar reflects moves/cancellations; keep the outcome open.
    void onRefresh().catch(() => {});
  }
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
                              : "New booking"
                          : e.kind === "walkin"
                            ? "Walk-in"
                            : e.kind === "removeBlock"
                              ? "Remove blocked time"
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
      context="APPOINTMENT"
      protectChanges
      wide={e.kind === "hours" || e.kind === "booking" || !!conflict}
    >
      {conflict && (
        <ConflictResolver preview={conflict.preview} title={conflict.title} onApply={applyConflict} onBack={() => setConflict(null)} />
      )}
      {conflictDone && !conflict && (
        <>
          <ConflictOutcome outcome={conflictDone.outcome} title={conflictDone.title} />
          <div className="workspace-save-actions">
            <Button onClick={onClose} data-testid="conflict-close">Done</Button>
          </div>
        </>
      )}
      {!conflict && !conflictDone && e.kind === "addon" && <AddonEditor addon={e.item} w={w} saved={saved} />}
      {!conflict && !conflictDone && (<>
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
          guardedSave={guardedSave}
        />
      )}
      {e.kind === "removeBlock" && (
        <SaveForm label="Remove block" onSave={() => saved(`/staff/${e.item.staff_id}/blocks/${e.item.id}`, "DELETE")}>
          <p>
            Remove <strong>{blockLabel(e.item)}</strong> on {e.item.date}, {clock(e.item.start_min)}–{clock(e.item.end_min)}? The time opens up again online straight away. Appointments that were moved or cancelled stay as they are.
          </p>
        </SaveForm>
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
            guardedSave({
              kind: "weekly",
              staff_id: e.item.id,
              change: {
                version: e.item.version,
                rows: days.map((_, i) => {
                  const hasBreak = f.has(`break-${i}`);
                  const starts = minute(text(f, `starts-${i}`));
                  return {
                    weekday: i,
                    enabled: f.has(`enabled-${i}`) ? 1 : 0,
                    starts,
                    ends: minute(text(f, `ends-${i}`)),
                    break_start: hasBreak ? minute(text(f, `break_start-${i}`)) : starts,
                    break_end: hasBreak ? minute(text(f, `break_end-${i}`)) : starts,
                  };
                }),
              },
            }, `${e.item.name.split(" ")[0]}'s new weekly hours`)
          }
        >
          <WeeklyHoursFields staff={e.item} hours={w.hours.filter((h) => h.staff_id === e.item.id)} shop={w.shop} />
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
              guardedSave(
                { kind: "day_off", staff_id: e.item.id, change: { date: text(f, "date"), reason: text(f, "reason") } },
                `${e.item.name.split(" ")[0]} off on ${new Date(text(f, "date") + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`,
              )
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
                placeholder="Annual leave"
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
            guardedSave(
              { kind: "holiday", change: { date: text(f, "date"), label: text(f, "label") } },
              `the shop closing on ${new Date(text(f, "date") + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`,
            )
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
      {e.kind === "walkin" && <WalkInForm w={w} saved={saved} staffId={e.staffId} />}
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
          <Field label="Customer name">
            <input
              name="customer_name"
              required
              minLength={2}
              maxLength={100}
              defaultValue={e.item.customer_name}
            />
          </Field>
          <Field label="Mobile number">
            <input
              name="phone"
              type="tel"
              required
              defaultValue={e.item.phone}
            />
          </Field>
          <Field label="Notes">
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
                "Booked in shop"
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
      </>)}
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
        <Field label={`Add-on price (${currencySymbol()})`}>
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
  guardedSave,
}: {
  staff: Staff;
  override?: ScheduleOverride;
  date: string;
  w: WorkspaceData;
  saved: EditorProps["saved"];
  guardedSave: (change: ScheduleChange, title: string) => Promise<void>;
}) {
  void saved;
  const base =
    o ??
    w.hours.find(
      (h) =>
        h.staff_id === staff.id &&
        h.weekday === new Date(date + "T12:00:00Z").getUTCDay(),
    )!;
  return (
    <SaveForm
      onSave={(f) => {
        const enabled = f.has("enabled") ? 1 : 0;
        const d = text(f, "date");
        const nice = new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
        return guardedSave(
          {
            kind: "override",
            staff_id: staff.id,
            ...(o ? { override_id: o.id } : {}),
            change: {
              date: d,
              enabled,
              starts: minute(text(f, "starts")),
              ends: minute(text(f, "ends")),
              break_start: minute(text(f, "break_start")),
              break_end: minute(text(f, "break_end")),
              reason: text(f, "reason"),
              ...(o ? { version: o.version } : {}),
            },
          },
          enabled ? `${staff.name.split(" ")[0]}'s hours on ${nice}` : `${staff.name.split(" ")[0]} off on ${nice}`,
        );
      }}
    >
      <Notice>
        <strong>{staff.name.split(" ")[0]} · {new Date((o?.date ?? date) + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}.</strong> Changes this day only; the weekly pattern stays as it is. Appointments already booked outside the new hours stay saved and are flagged for you to move.
      </Notice>
      <Field label="Date">
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
        Working this day (untick for a day off)
      </label>
      <div className="workspace-form-grid">
        {(["starts", "ends", "break_start", "break_end"] as const).map(
          (key, i) => (
            <Field
              key={key}
              label={
                ["Starts", "Finishes", "Break from", "Break until"][i]
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
      <Field label="Why (shows in the audit)">
        <input
          name="reason"
          required
          minLength={3}
          maxLength={100}
          placeholder="e.g. Late start · Covering Sat · Dentist"
          defaultValue={o?.reason ?? "Changed on the calendar"}
        />
      </Field>
      <p className="workspace-footnote">Equal break times mean no break. Shop opening hours still apply.</p>
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
        <Field label="Customer name" hint="Leave blank for a walk-in">
          <input
            name="customer_name"
            value={name}
            onChange={(e) => { setName(e.target.value); if (pickedId) setPickedId(null); }}
            minLength={2}
            maxLength={100}
            placeholder="Walk-in"
            autoComplete="off"
          />
        </Field>
        <Field label="Mobile number" hint={name.trim() ? "For confirmations and reminders" : "Optional for walk-ins"}>
          <input
            name="phone"
            value={phone}
            onChange={(e) => { setPhone(e.target.value); if (pickedId) setPickedId(null); }}
            type="tel"
            required={!!name.trim()}
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
  // Fresha-style override: the clicked cell was outside hours / on a break / already occupied and the
  // shop chose it anyway. Holds the server's reason so the review step can say what's being overridden.
  const [override, setOverride] = useState<string>("");
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
      customer_name: text(f, "customer_name") || "Walk-in",
      phone: text(f, "phone"),
      notes: text(f, "notes"),
      source: text(f, "customer_name") ? text(f, "source") : "WALK_IN",
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
            const at = s.slots.find((slot) => slot.start_min === draftPending.current);
            const soft = at?.reason && ["Slot taken", "Outside working hours", "Lunch break", "Barber off duty", "Blocked time"].includes(at.reason);
            if (at && !at.reason) {
              setStart(String(at.start_min));
              setOverride("");
            } else if (at && soft) {
              // Greyed-but-clickable: keep the time, flag the override, let the review step confirm it.
              setStart(String(at.start_min));
              setOverride(at.reason);
            } else
              setError(
                at?.reason ? `${at.reason}. Choose another time.` : "The clicked time does not fit this service and buffer. Choose another time or service.",
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
              : "Confirm booking"
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
              ...(override ? { force: true } : {}),
            }
          : {
              staff_id: staff,
              service_id: service,
              date,
              start_min: Number(start),
              customer_name: text(f, "customer_name") || "Walk-in",
              phone: text(f, "phone"),
              notes: text(f, "notes"),
              source: text(f, "customer_name") ? text(f, "source") : "WALK_IN",
              quote: slots.quote,
              addon_ids: addonIds,
              ...(pickedCustomer?.id ? { customer_id: pickedCustomer.id } : {}),
              ...(override ? { force: true } : {}),
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
      {override && start && (
        <Notice icon="blocked" tone="warning">
          <span data-testid="override-notice">
            <strong>{override === "Slot taken" ? "Double-booking" : override}</strong> at {time(Number(start))}.
            {override === "Slot taken"
              ? " This overlaps another appointment; both will show side by side on the calendar."
              : override === "Blocked time"
                ? " The barber blocked this time; saving books over the block regardless."
                : " The barber isn't rostered then; saving books it regardless."}
            <Button variant="ghost" onClick={() => { setStart(""); setOverride(""); }}>Pick a free time instead</Button>
          </span>
        </Notice>
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
              <SlotGrid
                slots={slots.slots}
                value={start}
                onPick={(m, el) => {
                  markDraft(el);
                  setStart(String(m));
                }}
              />
              <details className="booking-time-fallback" open>
                <summary>All times, including unavailable</summary>
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
              </details>
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
                Deposit {money(slots.deposit_policy_pence)} · payable in shop. Cancellation policy: {slots.cancel_hours} hours.
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
                  <option value="TEST_BOOKING">Phone / in person</option>
                  <option value="WALK_IN">Walk-in</option>
                </select>
              </Field>
              <Field label="Notes">
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
          <p className="workspace-footnote">Review the details before saving.</p>
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
        Times are Europe/London. Data is saved only after confirmation.
      </p>
    </SaveForm>
  );
}

// CSV import: pick a file → we detect columns → preview what will happen → import.
type ImportRowView = { line: number; name: string; phone: string; email: string; tags: string[]; action: "create" | "update" | "skip" | "invalid"; reason: string };
type ImportPreviewView = { columns: string[]; mapping: Record<string, string | null>; rows: ImportRowView[]; counts: { create: number; update: number; skip: number; invalid: number; total: number }; truncated: boolean };
const IMPORT_FIELDS: [string, string][] = [["name", "Full name"], ["first_name", "First name"], ["last_name", "Last name"], ["phone", "Mobile"], ["email", "Email"], ["notes", "Notes"], ["tags", "Tags"], ["birthday", "Birthday"], ["marketing", "Marketing consent"]];
function ImportCustomers({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreviewView | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; invalid: number } | null>(null);
  async function runPreview(text: string, map?: Record<string, string | null>) {
    setBusy(true); setError("");
    try {
      const p = await api<ImportPreviewView>("/customers/import/preview", "POST", { csv: text, ...(map ? { mapping: map } : {}) });
      setPreview(p); setMapping(p.mapping);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the file.");
      // Still let the owner map columns by hand when detection failed.
      if (!preview && text) {
        const header = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
        const delim = [",", ";", "\t"].sort((a, b) => header.split(b).length - header.split(a).length)[0];
        setPreview({ columns: header.split(delim).map((h) => h.trim().replace(/^"|"$/g, "")), mapping: map ?? {}, rows: [], counts: { create: 0, update: 0, skip: 0, invalid: 0, total: 0 }, truncated: false });
      }
    } finally { setBusy(false); }
  }
  async function onFile(f: File | undefined) {
    if (!f) return;
    setFileName(f.name); setResult(null);
    const text = await f.text();
    setCsv(text);
    await runPreview(text);
  }
  async function commit() {
    setBusy(true); setError("");
    try {
      const r = await api<{ created: number; updated: number; skipped: number; invalid: number }>("/customers/import", "POST", { csv, mapping });
      setResult(r);
    } catch (e) { setError(e instanceof Error ? e.message : "Import failed. Nothing was saved."); }
    finally { setBusy(false); }
  }
  const tone = (a: ImportRowView["action"]) => (a === "create" ? "good" : a === "update" ? "next" : a === "skip" ? "note" : "warn");
  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div className="modal import-modal" role="dialog" aria-label="Import customers" onClick={(e) => e.stopPropagation()} data-testid="import-modal">
        <header className="modal-head">
          <h3>Import customers</h3>
          <Button variant="ghost" onClick={onClose} aria-label="Close import"><Icon name="close" size={16} /></Button>
        </header>
        {!result && (
          <>
            <p className="workspace-footnote">A CSV export from Fresha, Booksy, Square, Treatwell or a spreadsheet. We match on mobile number: new numbers are added, existing customers only get blanks filled in — nothing is overwritten.</p>
            <label className="import-file">
              <input type="file" accept=".csv,text/csv,text/plain" data-testid="import-file" onChange={(e) => onFile(e.target.files?.[0])} />
              <span>{fileName || "Choose a CSV file"}</span>
            </label>
            {preview && (
              <details className="import-mapping" open={!preview.rows.length}>
                <summary>Columns {Object.values(mapping).some(Boolean) ? "· detected automatically, change if wrong" : "· choose which column is which"}</summary>
                <div className="import-mapping-grid">
                  {IMPORT_FIELDS.map(([field, label]) => (
                    <label key={field} className="workspace-field narrow">
                      <span>{label}</span>
                      <select value={mapping[field] ?? ""} data-testid={`map-${field}`} onChange={(e) => { const m = { ...mapping, [field]: e.target.value || null }; setMapping(m); runPreview(csv, m); }}>
                        <option value="">—</option>
                        {preview.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </details>
            )}
            {error && <p className="workspace-error" role="alert">{error}</p>}
            {preview && preview.rows.length > 0 && (
              <>
                <div className="import-counts" data-testid="import-counts">
                  <StatusPill tone="good">{preview.counts.create} new</StatusPill>
                  <StatusPill tone="next">{preview.counts.update} to update</StatusPill>
                  <StatusPill tone="note">{preview.counts.skip} already here</StatusPill>
                  <StatusPill tone="warn">{preview.counts.invalid} can't import</StatusPill>
                </div>
                <div className="import-table-wrap">
                  <table className="import-table">
                    <thead><tr><th>Line</th><th>Name</th><th>Mobile</th><th>Email</th><th>Result</th></tr></thead>
                    <tbody>
                      {preview.rows.map((r) => (
                        <tr key={r.line} data-action={r.action}>
                          <td>{r.line}</td>
                          <td>{r.name || <em>—</em>}</td>
                          <td>{r.phone || <em>—</em>}</td>
                          <td>{r.email}</td>
                          <td><StatusPill tone={tone(r.action)}>{r.action === "create" ? "New" : r.action === "update" ? "Update" : r.action === "skip" ? "Skip" : "Invalid"}</StatusPill>{r.reason && <small> {r.reason}</small>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.truncated && <p className="workspace-footnote">Showing the first 200 of {preview.counts.total} rows. All will be imported.</p>}
                </div>
              </>
            )}
            <div className="workspace-form-actions">
              <Button disabled={busy || !preview || preview.counts.create + preview.counts.update === 0} data-testid="import-commit" onClick={commit}>
                {busy ? "Working…" : preview ? `Import ${preview.counts.create + preview.counts.update} customer${preview.counts.create + preview.counts.update === 1 ? "" : "s"}` : "Import"}
              </Button>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
        {result && (
          <div className="import-result" data-testid="import-result">
            <p className="workspace-success" role="status"><Icon name="check" size={16} /> Imported: {result.created} added, {result.updated} updated. {result.skipped} were already here, {result.invalid} couldn't be read.</p>
            <div className="workspace-form-actions"><Button onClick={onDone}>Done</Button></div>
          </div>
        )}
      </div>
    </div>
  );
}
