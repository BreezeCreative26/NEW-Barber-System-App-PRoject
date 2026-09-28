// Customer account area at /<slug>/me: passwordless sign-in (one-time code), upcoming visits with
// move/cancel, "your usual" one-tap rebook, history, profile and privacy controls. Talks only to
// /api/public/shops/:slug/account/*; the shop never sees another shop's history.
import { Boot, useLive } from "./boot";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { ShopTabBar } from "./ShopTabBar";
import { Avatar, Button, Icon, Notice, StatusPill } from "./ui";
import { dateLabel, datePlus, money, time, setCurrency } from "./fixtures";
import { ReviewCard, type OwnReview } from "./Reviews";
import { applyThemeColor, brandStyle, serverBrand, themeClass, type ShopBrand, shopPath } from "./theme";

type Profile = { id: string; phone: string; name: string; email: string; birthday: string; preferred_staff_id: string; marketing_opt_in: number; contact_pref?: "AUTO" | "EMAIL" | "NONE"; complete?: boolean; notes: string; version: number; member_since: number; has_password?: boolean; account_email?: string; email_verified?: boolean };
type Visit = {
  review?: OwnReview;
  can_review?: boolean;
  id: string; reference: string; status: string; date: string; start_min: number; start_at: number; duration_min: number; service_name: string; service_id: string; staff_id: string; staff_name: string | null;
  price_pence: number; cancel_hours: number; version: number; can_manage: boolean; late_change: boolean; series_id: string | null; attendee_name?: string; group_id?: string | null; items: { id: string; name: string; price_pence: number }[];
};
type Me = {
  shop: { name: string; slug: string; address: string; timezone: string; currency?: string; cancel_hours: number; lead_time_min: number; today: string; logo_url?: string; brand?: ShopBrand; google_review_url?: string; channels?: { sms: boolean; email: boolean } };
  profile: Profile;
  upcoming: Visit[];
  history: Visit[];
  usual: null | { service_id: string; service_name: string; staff_id: string; staff_name: string | null; gap_weeks: number | null; price_pence: number; count: number };
  next_usual: null | { date: string; start_min: number; price_pence: number };
  staff: { id: string; name: string }[];
  stats: { visits: number; spent_pence: number; first_visit: string | null };
  waiting: { id: string; date: string; date_to?: string; daypart: string; from_min?: number; to_min?: number; status: "OPEN" | "OFFERED"; version: number; service_name: string; staff_name: string | null; offer_start_min: number | null; offer_date?: string | null; offer_expires_at: number | null; offer_staff_name: string | null }[];
};
class ApiError extends Error {
  constructor(message: string, public status: number, public code = "") {
    super(message);
  }
}
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api/public${path}`, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(json.message || json.error || "Request failed", res.status, json.error || "");
  return json as T;
}
const initials = (n: string) => n.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
// Preset windows read as words; a customer's own window as HH:MM–HH:MM.
function windowLabel(e: { daypart: string; from_min?: number; to_min?: number }) {
  const words: Record<string, string> = { ANY: "any time", MORNING: "morning", AFTERNOON: "afternoon", EVENING: "evening" };
  const preset: Record<string, [number, number]> = { ANY: [0, 1440], MORNING: [0, 720], AFTERNOON: [720, 1020], EVENING: [1020, 1440] };
  if (e.from_min == null || e.to_min == null) return words[e.daypart] ?? "any time";
  for (const k of Object.keys(preset)) if (preset[k][0] === e.from_min && preset[k][1] === e.to_min) return words[k];
  return `${time(e.from_min)}–${time(Math.min(e.to_min, 1439))}`;
}
const statusLabel: Record<string, { text: string; tone: "good" | "next" | "paid" | "warn" | "note" }> = {
  CONFIRMED: { text: "Confirmed", tone: "good" },
  CHECKED_IN: { text: "Checked in", tone: "next" },
  IN_SERVICE: { text: "In the chair", tone: "next" },
  COMPLETED: { text: "Completed", tone: "paid" },
  CANCELLED: { text: "Cancelled", tone: "note" },
  NO_SHOW: { text: "Missed", tone: "warn" },
};

export function CustomerArea({ slug }: { slug: string }) {
  const A = `/shops/${encodeURIComponent(slug)}/account`;
  const [me, setMe] = useState<Me | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"visits" | "profile">(new URLSearchParams(location.search).get("tab") === "profile" ? "profile" : "visits");
  const load = async () => {
    setError("");
    try {
      // Probe the session first so a signed-out visit is a clean 200, not a console 401.
      const s = await api<{ profile: Profile | null }>(`${A}/session`);
      if (!s.profile) {
        setMe(null);
        setSignedOut(true);
        return;
      }
      const d = await api<Me>(`${A}/me`);
      setCurrency(d.shop.currency);
      setMe(d);
      applyThemeColor(d.shop.brand);
      setSignedOut(false);
      document.title = `Your visits · ${d.shop.name}`;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setSignedOut(true);
      else setError(e instanceof Error ? e.message : "Could not load your visits.");
    }
  };
  useEffect(() => {
    load();
  }, [slug]);
  // Background re-read (no flicker: state is swapped in place) — only once signed in.
  useLive(() => (me ? load() : undefined), [slug, !!me]);
  async function signOut() {
    await api(`${A}/logout`, "POST", {});
    setMe(null);
    setSignedOut(true);
    setNotice("");
  }
  if (error && !me)
    return (
      <main className="state-card">
        <h1>Something went wrong</h1>
        <p>{error}</p>
        <Button onClick={load}>Try again</Button>
      </main>
    );
  if (signedOut) return <SignIn slug={slug} A={A} onDone={load} />;
  // A code-only account (no email/password yet) finishes its profile before using the area.
  if (me && me.profile.complete === false) return <SignIn slug={slug} A={A} onDone={load} startMode="complete" seedProfile={{ name: me.profile.name, email: me.profile.email }} />;
  if (!me)
    return (
      <div className={themeClass(serverBrand()?.brand, "customer-area")} style={brandStyle(serverBrand()?.brand) as CSSProperties}>
        <Boot label="Opening your visits…" />
      </div>
    );
  const first = me.profile.name.split(" ")[0] || "there";
  return (
    <div className={themeClass(me.shop.brand, "customer-area")} style={brandStyle(me.shop.brand) as CSSProperties} data-testid="customer-area">
      <header className="sp-nav">
        <a className="sp-brand" href={shopPath(me.shop.slug, "/")}>
          {me.shop.logo_url ? <img className="shop-emblem shop-logo" src={me.shop.logo_url} alt="" /> : <span className="shop-emblem">{initials(me.shop.name)}</span>}
          <strong>{me.shop.name}</strong>
        </a>
        <nav aria-label="Account">
          <a href={shopPath(me.shop.slug, "/book")}>Book</a>
        </nav>
        <button type="button" className="button secondary ca-signout" onClick={signOut} data-testid="sign-out" aria-label="Sign out">
          <Icon name="logout" size={15} /> <span>Sign out</span>
        </button>
      </header>
      <main id="main-content" className="ca-main">
        <section className="ca-hero">
          <Avatar initials={initials(me.profile.name || "You")} size="large" />
          <div>
            <span className="eyebrow">YOUR ACCOUNT</span>
            <h1>Hello, {first}.</h1>
            <p>
              {me.stats.visits ? `${me.stats.visits} visit${me.stats.visits === 1 ? "" : "s"} · ${money(me.stats.spent_pence)} with ${me.shop.name}` : `Welcome to ${me.shop.name}.`}
              {me.stats.first_visit && ` · since ${dateLabel(me.stats.first_visit)}`}
            </p>
          </div>
        </section>
        {notice && (
          <Notice icon="check">
            <span role="status">{notice}</span>
          </Notice>
        )}
        <AppCard slug={me.shop.slug} A={A} shopName={me.shop.name} hasPassword={!!me.profile.has_password} onSetPassword={() => setTab("profile")} />
        <div className="ca-tabs" role="tablist" aria-label="Account sections">
          <button type="button" role="tab" aria-selected={tab === "visits"} onClick={() => setTab("visits")} data-testid="tab-visits">
            <Icon name="calendar" size={15} /> Visits
          </button>
          <button type="button" role="tab" aria-selected={tab === "profile"} onClick={() => setTab("profile")} data-testid="tab-profile">
            <Icon name="userRound" size={15} /> Profile
          </button>
        </div>
        {tab === "visits" ? (
          <Visits me={me} A={A} onChanged={(msg) => { setNotice(msg); load(); }} />
        ) : (
          <ProfileForm me={me} A={A} onSaved={(msg) => { setNotice(msg); load(); }} onDeleted={() => { setMe(null); setSignedOut(true); setNotice(""); }} />
        )}
      </main>
      <footer className="sp-footer">
        <span>
          {me.shop.name}
          {me.shop.address && ` · ${me.shop.address}`}
        </span>
        <span className="sp-powered">Powered by foliyo</span>
      </footer>
      <ShopTabBar slug={me.shop.slug} active={tab === "profile" ? "account" : "visits"} signedIn />
    </div>
  );
}

type SignInMode = "login" | "register" | "forgot" | "code" | "code-verify" | "complete" | "reset" | "sent";
function SignIn({ slug, A, onDone, startMode, seedProfile }: { slug: string; A: string; onDone: () => void; startMode?: SignInMode; seedProfile?: { name: string; email: string } }) {
  const params = new URLSearchParams(location.search);
  const resetToken = params.get("reset") || params.get("welcome") || "";
  const isWelcome = params.has("welcome");
  const [mode, setMode] = useState<SignInMode>(startMode || (resetToken ? "reset" : params.get("forgot") ? "forgot" : "login"));
  const [email, setEmail] = useState(seedProfile?.email || "");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [name, setName] = useState(seedProfile?.name || "");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [shownCode, setShownCode] = useState("");
  const [sandboxToken, setSandboxToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Themed from the first frame: the shell carries the brand. The fetch below only fills gaps.
  const seed = serverBrand();
  // Consent at sign-up. Email reminders come with the account; text reminders are offered only when
  // the shop sends texts (on by default then). Marketing is a separate opt-in, off by default.
  const smsOffered = seed?.channels ? seed.channels.sms : true;
  const [textReminders, setTextReminders] = useState(true);
  const [marketing, setMarketing] = useState(false);
  // The shop's own booking terms (from the shell). Sign-up requires accepting the current version.
  const terms = seed?.terms || null;
  const [termsTick, setTermsTick] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [shopName, setShopName] = useState(seed?.name || "");
  const [shopBrand, setShopBrand] = useState<(ShopBrand & { logo_url: string }) | null>(seed ? { ...seed.brand, logo_url: seed.brand.logo_url } : null);
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (seed) applyThemeColor(seed.brand);
    if (seed) return;
    fetch(`/api/public/shops/${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setShopName(d.shop.name);
        if (d.shop.brand) {
          setShopBrand({ ...d.shop.brand, logo_url: d.shop.logo_url || "" });
          applyThemeColor(d.shop.brand);
        }
      })
      .catch(() => {});
  }, [slug]);
  const go = (m: SignInMode) => { setMode(m); setError(""); };
  async function run(fn: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError("");
    try { await fn(); } catch (err) { setError(err instanceof Error ? err.message : fallback); } finally { setBusy(false); }
  }
  const finish = () => {
    if (resetToken) history.replaceState(null, "", location.pathname);
    onDone();
  };
  const login = (e: FormEvent) => { e.preventDefault(); run(async () => { await api(`${A}/login`, "POST", { email, password }); finish(); }, "Could not sign in."); };
  const register = (e: FormEvent) => {
    e.preventDefault();
    if (password !== password2) { setError("The two passwords don't match."); return; }
    if (terms && !termsTick) { setError(`Please accept ${shopName || "the shop"}’s booking terms.`); return; }
    run(async () => { await api(`${A}/register`, "POST", { name, phone, email, password, marketing_opt_in: marketing ? 1 : 0, contact_pref: smsOffered && textReminders ? "AUTO" : "EMAIL", accept_terms_version: terms?.version || 0 }); finish(); }, "Could not create your account.");
  };
  const forgot = (e: FormEvent) => { e.preventDefault(); run(async () => { const r = await api<{ sandbox_token?: string }>(`${A}/forgot`, "POST", { email }); setSandboxToken(r.sandbox_token || ""); go("sent"); }, "Could not send the link."); };
  const reset = (e: FormEvent) => {
    e.preventDefault();
    if (password !== password2) { setError("The two passwords don't match."); return; }
    run(async () => { await api(`${A}/reset`, "POST", { token: resetToken || sandboxToken, password }); finish(); }, "Could not set your password.");
  };
  const startCode = (e: FormEvent) => { e.preventDefault(); run(async () => { const r = await api<{ sandbox_code?: string; delivery: "sms" | "on_screen" }>(`${A}/start`, "POST", { phone }); setShownCode(r.delivery === "sms" ? "" : r.sandbox_code || ""); go("code-verify"); setTimeout(() => codeRef.current?.focus(), 30); }, "Could not send a code."); };
  const verifyCode = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ needs_profile?: boolean; profile?: { name?: string; email?: string } }>(`${A}/verify`, "POST", { phone, code });
      if (r.needs_profile) { setName(r.profile?.name || ""); setEmail(r.profile?.email || ""); go("complete"); return; }
      finish();
    }, "Could not verify the code.");
  };
  // Code-only accounts finish here: name, email, password, consents — then they are a full account.
  const complete = (e: FormEvent) => {
    e.preventDefault();
    if (password !== password2) { setError("The two passwords don't match."); return; }
    if (terms && !termsTick) { setError(`Please accept ${shopName || "the shop"}’s booking terms.`); return; }
    run(async () => { await api(`${A}/complete`, "POST", { name, email, password, marketing_opt_in: marketing ? 1 : 0, contact_pref: smsOffered && textReminders ? "AUTO" : "EMAIL", accept_terms_version: terms?.version || 0 }); finish(); }, "Could not finish your account.");
  };

  const title: Record<SignInMode, string> = {
    login: "Sign in.",
    register: "Create your account.",
    forgot: "Forgot your password?",
    sent: "Check your email.",
    reset: isWelcome ? "Choose a password." : "Choose a new password.",
    code: "Sign in with a text code.",
    "code-verify": "Enter your code.",
    complete: "Finish your account.",
  };
  const lead: Record<string, string> = {
    login: `See upcoming visits, move or cancel them, and rebook your usual in one tap${shopName ? ` at ${shopName}` : ""}.`,
    register: "Every visit in one place: move or cancel, rebook your usual, and get reminders before you're due.",
    forgot: "Enter the email on your account and we'll send a link to choose a new password. It lasts 30 minutes.",
    sent: `If there's an account for ${email}, a reset link is on its way. It lasts 30 minutes.`,
    reset: isWelcome ? "Your account was created when you booked. Set a password to finish — you'll use your email and this password to sign in." : "Your other devices will be signed out.",
    code: "No password? We text a 6-digit code to the mobile you booked with. You can set a password once you're in.",
    "code-verify": `Code for ${phone}. It lasts ten minutes.`,
    complete: "You're in. Add your name, email and a password so your confirmations reach you and you can sign in anywhere.",
  };
  const Err = () => (error ? <p className="form-error" role="alert">{error}</p> : null);
  const PasswordFields = ({ confirm }: { confirm: boolean }) => (
    <>
      <label>
        <span>{confirm ? "Password" : "Password"}</span>
        <input type="password" autoComplete={confirm ? "new-password" : "current-password"} minLength={confirm ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} required data-testid="signin-password" />
        {confirm && <small className="ca-hint">At least 8 characters.</small>}
      </label>
      {confirm && (
        <label>
          <span>Repeat password</span>
          <input type="password" autoComplete="new-password" minLength={8} value={password2} onChange={(e) => setPassword2(e.target.value)} required data-testid="signin-password2" />
        </label>
      )}
    </>
  );
  return (
    <div className={themeClass(shopBrand, "customer-area no-tabbar")} style={brandStyle(shopBrand) as CSSProperties} data-testid="customer-signin">
      <header className="sp-nav">
        <a className="sp-brand" href={shopPath(slug, "/")}>
          {shopBrand?.logo_url ? <img className="shop-emblem shop-logo" src={shopBrand.logo_url} alt="" /> : <span className="shop-emblem">{shopName ? initials(shopName) : "··"}</span>}
          <strong>{shopName || "Back to the shop"}</strong>
        </a>
      </header>
      <main id="main-content" className="ca-main ca-signin">
        <div className="ca-card">
          <span className="eyebrow">YOUR VISITS</span>
          <h1>{title[mode]}</h1>
          <p className="ca-lead">{lead[mode]}</p>

          {mode === "login" && (
            <form onSubmit={login} className="ca-form" data-testid="login-form">
              <label>
                <span>Email</span>
                <input type="email" inputMode="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="signin-email" />
              </label>
              <PasswordFields confirm={false} />
              <Err />
              <Button type="submit" disabled={busy} data-testid="signin-submit">{busy ? "Signing in…" : "Sign in"} <Icon name="arrowRight" size={16} /></Button>
              <div className="ca-links">
                <button type="button" className="link" onClick={() => go("forgot")} data-testid="signin-forgot">Forgot password?</button>
                {smsOffered && <button type="button" className="link" onClick={() => go("code")} data-testid="signin-use-code">Text me a code instead</button>}
              </div>
              <p className="ca-switch">New here? <button type="button" className="link" onClick={() => go("register")} data-testid="signin-register">Create an account</button></p>
            </form>
          )}
          {mode === "login" && (
            <p className="auth-staff-link">Work at {shopName || "this shop"}? <a href={document.querySelector('meta[name="foliyo-shop"]') ? "/staff" : "/signin"} data-testid="staff-signin-link">Staff sign in</a></p>
          )}

          {mode === "register" && (
            <form onSubmit={register} className="ca-form" data-testid="register-form">
              <label><span>Your name</span><input type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} data-testid="register-name" /></label>
              <label><span>Mobile number</span><input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07700 900123" required data-testid="register-phone" /><small className="ca-hint">{smsOffered ? "For your booking and text reminders." : "So the shop can reach you about your booking."}</small></label>
              <label><span>Email</span><input type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="register-email" /><small className="ca-hint">You'll sign in with this. Confirmations and reminders come here too.</small></label>
              <PasswordFields confirm />
              <div className="ca-consent" data-testid="register-consent">
                {smsOffered && (
                  <label className="ca-check">
                    <input type="checkbox" checked={textReminders} onChange={(e) => setTextReminders(e.target.checked)} data-testid="register-texts" />
                    <span>Text me confirmations and reminders</span>
                  </label>
                )}
                <label className="ca-check">
                  <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} data-testid="register-marketing" />
                  <span>Send me offers and news from {shopName || "the shop"}</span>
                </label>
                {terms && (
                  <label className="ca-check" data-testid="register-terms">
                    <input type="checkbox" checked={termsTick} onChange={(e) => setTermsTick(e.target.checked)} required data-testid="register-terms-tick" />
                    <span>I accept {shopName || "the shop"}’s booking terms. <button type="button" className="link" onClick={() => setTermsOpen((v) => !v)} aria-expanded={termsOpen}>{termsOpen ? "Hide" : "Read them"}</button></span>
                  </label>
                )}
                {terms && termsOpen && <div className="ca-terms-text">{terms.text.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}</div>}
                <small className="ca-hint">By creating an account you agree to the <a href="/legal/terms" target="_blank" rel="noopener">terms</a> and <a href="/legal/privacy" target="_blank" rel="noopener">privacy notice</a>. Booking messages always come by email{smsOffered ? "; texts are your choice" : ""}.</small>
              </div>
              <Err />
              <Button type="submit" disabled={busy} data-testid="register-submit">{busy ? "Creating…" : "Create account"} <Icon name="arrowRight" size={16} /></Button>
              <p className="ca-switch">Already have one? <button type="button" className="link" onClick={() => go("login")}>Sign in</button></p>
            </form>
          )}

          {mode === "forgot" && (
            <form onSubmit={forgot} className="ca-form" data-testid="forgot-form">
              <label><span>Email</span><input type="email" inputMode="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="forgot-email" /></label>
              <Err />
              <div className="ca-form-actions">
                <Button variant="ghost" onClick={() => go("login")}>Back</Button>
                <Button type="submit" disabled={busy} data-testid="forgot-submit">{busy ? "Sending…" : "Send reset link"}</Button>
              </div>
            </form>
          )}

          {mode === "sent" && (
            <div className="ca-form">
              {sandboxToken ? (
                <Notice icon="shield" tone="info"><strong>Preview mode:</strong> no email provider is set up, so <button type="button" className="link" onClick={() => go("reset")} data-testid="sandbox-reset-link">open the reset link here</button>.</Notice>
              ) : (
                <Notice icon="message" tone="info">Didn't get it? Check spam, or <button type="button" className="link" onClick={() => go("code")}>sign in with a text code</button>.</Notice>
              )}
              <Button variant="ghost" onClick={() => go("login")}>Back to sign in</Button>
            </div>
          )}

          {mode === "reset" && (
            <form onSubmit={reset} className="ca-form" data-testid="reset-form">
              <PasswordFields confirm />
              <Err />
              <Button type="submit" disabled={busy} data-testid="reset-submit">{busy ? "Saving…" : isWelcome ? "Set password and sign in" : "Save new password"}</Button>
            </form>
          )}

          {mode === "code" && (
            <form onSubmit={startCode} className="ca-form" data-testid="code-form">
              <label><span>Mobile number</span><input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07700 900123" required data-testid="signin-phone" /></label>
              <Err />
              <div className="ca-form-actions">
                <Button variant="ghost" onClick={() => go("login")}>Back</Button>
                <Button type="submit" disabled={busy} data-testid="signin-send">{busy ? "Sending…" : "Send code"} <Icon name="arrowRight" size={16} /></Button>
              </div>
            </form>
          )}

          {mode === "code-verify" && (
            <form onSubmit={verifyCode} className="ca-form">
              {shownCode ? (
                <Notice icon="shield" tone="info"><strong>Preview mode:</strong> your code is <code data-testid="shown-code">{shownCode}</code>.</Notice>
              ) : (
                <Notice icon="message" tone="info">We've texted a 6-digit code to <strong>{phone}</strong>. It expires in 10 minutes.</Notice>
              )}
              <label>
                <span>6-digit code</span>
                <input ref={codeRef} type="text" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required data-testid="signin-code" />
              </label>
              <Err />
              <div className="ca-form-actions">
                <Button variant="ghost" onClick={() => { go("code"); setCode(""); }}>Different number</Button>
                <Button type="submit" disabled={busy || code.length !== 6} data-testid="signin-verify">{busy ? "Checking…" : "Sign in"}</Button>
              </div>
            </form>
          )}
          {mode === "complete" && (
            <form onSubmit={complete} className="ca-form" data-testid="complete-form">
              <label><span>Your name</span><input type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} data-testid="complete-name" /></label>
              <label><span>Email</span><input type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="complete-email" /><small className="ca-hint">You'll sign in with this. Confirmations and reminders come here too.</small></label>
              <PasswordFields confirm />
              <div className="ca-consent" data-testid="complete-consent">
                {smsOffered && (
                  <label className="ca-check">
                    <input type="checkbox" checked={textReminders} onChange={(e) => setTextReminders(e.target.checked)} />
                    <span>Text me confirmations and reminders</span>
                  </label>
                )}
                <label className="ca-check">
                  <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
                  <span>Send me offers and news from {shopName || "the shop"}</span>
                </label>
                {terms && (
                  <label className="ca-check">
                    <input type="checkbox" checked={termsTick} onChange={(e) => setTermsTick(e.target.checked)} required data-testid="complete-terms-tick" />
                    <span>I accept {shopName || "the shop"}’s booking terms. <button type="button" className="link" onClick={() => setTermsOpen((v) => !v)} aria-expanded={termsOpen}>{termsOpen ? "Hide" : "Read them"}</button></span>
                  </label>
                )}
                {terms && termsOpen && <div className="ca-terms-text">{terms.text.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}</div>}
                <small className="ca-hint">By continuing you agree to the <a href="/legal/terms" target="_blank" rel="noopener">terms</a> and <a href="/legal/privacy" target="_blank" rel="noopener">privacy notice</a>.</small>
              </div>
              <Err />
              <Button type="submit" disabled={busy} data-testid="complete-submit">{busy ? "Saving…" : "Finish and continue"} <Icon name="arrowRight" size={16} /></Button>
            </form>
          )}
          <p className="ca-fine">Your account is for this shop's bookings. Delete it any time from your profile.</p>
        </div>
      </main>
      <ShopTabBar slug={slug} active="account" signedIn={false} />
    </div>
  );
}

// ---- Installed app: home-screen install + notifications ----------------------------------
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
const standalone = () => (typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches) || (navigator as unknown as { standalone?: boolean }).standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
function urlB64ToUint8Array(b64: string) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
}
// Registers the shared worker at this shop's scope so the installed app is per shop.
export async function registerShopWorker(slug: string) {
  if (!("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("/sw.js", { scope: `/${slug}/` }); } catch { return null; }
}
function AppCard({ slug, A, shopName, hasPassword, onSetPassword }: { slug: string; A: string; shopName: string; hasPassword: boolean; onSetPassword: () => void }) {
  const [installEvt, setInstallEvt] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(standalone());
  const [push, setPush] = useState<{ enabled: boolean; public_key: string; subscribed: boolean; permission: NotificationPermission | "unsupported" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(`foliyo:${slug}:install-dismissed`) === "1");
  useEffect(() => {
    registerShopWorker(slug);
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallEvt(e as InstallEvent); };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, [slug]);
  useEffect(() => {
    (async () => {
      const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      let endpoint = "";
      if (supported) {
        const reg = await navigator.serviceWorker.getRegistration(`/${slug}/`);
        const sub = await reg?.pushManager.getSubscription();
        endpoint = sub?.endpoint || "";
      }
      const r = await api<{ enabled: boolean; public_key: string; subscribed: boolean }>(`${A}/push${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ""}`).catch(() => null);
      if (r) setPush({ ...r, permission: supported ? Notification.permission : "unsupported" });
    })();
  }, [A, slug]);
  async function install() {
    if (!installEvt) return;
    await installEvt.prompt();
    const { outcome } = await installEvt.userChoice;
    if (outcome === "accepted") setInstalled(true);
    setInstallEvt(null);
  }
  async function togglePush() {
    if (!push || !push.enabled || push.permission === "unsupported") return;
    setBusy(true);
    try {
      const reg = (await navigator.serviceWorker.getRegistration(`/${slug}/`)) || (await registerShopWorker(slug));
      if (!reg) return;
      await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setPush({ ...push, permission: perm }); return; }
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(push.public_key) }));
      const j = sub.toJSON();
      await api(`${A}/push`, "POST", { endpoint: sub.endpoint, keys: { p256dh: j.keys!.p256dh, auth: j.keys!.auth } });
      setPush({ ...push, subscribed: true, permission: "granted" });
    } catch { /* leave state */ } finally { setBusy(false); }
  }
  const showInstall = !installed && !dismissed && (installEvt || isIOS());
  // Once notifications are on for this device the row has done its job — it goes away (turning
  // them off again lives in the phone's settings). Blocked stays visible so the customer knows why.
  const showPush = !!push?.enabled && push.permission !== "unsupported" && !push.subscribed;
  if (!showInstall && !showPush && hasPassword) return null;
  return (
    <section className="ca-app" data-testid="app-card" aria-label="Shop app">
      {!hasPassword && (
        <div className="ca-app-row">
          <Icon name="lock" size={18} />
          <div>
            <strong>Finish your account</strong>
            <p>Set a password so you can sign in with your email from any device.</p>
          </div>
          <Button variant="secondary" onClick={onSetPassword} data-testid="set-password-cta">Set password</Button>
        </div>
      )}
      {showInstall && (
        <div className="ca-app-row">
          <Icon name="phone" size={18} />
          <div>
            <strong>Add {shopName} to your home screen</strong>
            <p>{installEvt ? "One tap to your visits, and reminders as notifications." : "In Safari tap Share, then \u201cAdd to Home Screen\u201d."}</p>
          </div>
          {installEvt ? <Button onClick={install} data-testid="install-app">Install</Button> : null}
          <button type="button" className="link small" onClick={() => { localStorage.setItem(`foliyo:${slug}:install-dismissed`, "1"); setDismissed(true); }} aria-label="Dismiss">Not now</button>
        </div>
      )}
      {showPush && push && (
        <div className="ca-app-row">
          <Icon name="bell" size={18} />
          <div>
            <strong>Notifications</strong>
            <p>{push.permission === "denied" ? "Blocked in your browser settings for this site." : "Get confirmations, changes and reminders on this device."}</p>
          </div>
          {push.permission !== "denied" && (
            <Button onClick={togglePush} disabled={busy} aria-busy={busy} data-testid="push-toggle">{busy ? "Turning on…" : "Turn on"}</Button>
          )}
        </div>
      )}
    </section>
  );
}
function PasswordPanel({ me, A, onSaved }: { me: Me; A: string; onSaved: (msg: string) => void }) {
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const has = !!me.profile.has_password;
  async function save(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) { setError("The two passwords don't match."); return; }
    setBusy(true); setError("");
    try {
      await api(`${A}/password`, "PUT", { current, password: pw });
      setCurrent(""); setPw(""); setPw2("");
      onSaved(has ? "Password changed." : "Password set. You can now sign in with your email.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save."); } finally { setBusy(false); }
  }
  return (
    <form className="ca-form ca-password" onSubmit={save} data-testid="password-form">
      <h3>{has ? "Change password" : "Set a password"}</h3>
      <p>{has ? "Use at least 8 characters." : "Sign in with your email and a password from any device. At least 8 characters."}</p>
      {has && <label><span>Current password</span><input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required data-testid="pw-current" /></label>}
      <label><span>New password</span><input type="password" autoComplete="new-password" minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} required data-testid="pw-new" /></label>
      <label><span>Repeat new password</span><input type="password" autoComplete="new-password" minLength={8} value={pw2} onChange={(e) => setPw2(e.target.value)} required data-testid="pw-new2" /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="ca-form-actions start"><Button type="submit" variant="secondary" disabled={busy} data-testid="pw-save">{busy ? "Saving…" : has ? "Change password" : "Set password"}</Button></div>
    </form>
  );
}

function Visits({ me, A, onChanged }: { me: Me; A: string; onChanged: (msg: string) => void }) {
  // Emails link to /me?visit=<id>: bring that visit into view and highlight it once.
  const focusVisit = new URLSearchParams(location.search).get("visit") || "";
  useEffect(() => {
    if (!focusVisit) return;
    const el = document.getElementById(`visit-${focusVisit}`);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusVisit]);
  const [moving, setMoving] = useState<Visit | null>(null);
  const [cancelling, setCancelling] = useState<Visit | null>(null);
  const [showAll, setShowAll] = useState(false);
  const book = (q: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") params.set(k, String(v));
    location.href = shopPath(me.shop.slug, "/book", `?${params.toString()}`);
  };
  const history = showAll ? me.history : me.history.slice(0, 6);
  return (
    <>
      {me.usual && (
        <section className="ca-usual" aria-labelledby="usual-heading" data-testid="your-usual">
          <div className="ca-usual-text">
            <span className="eyebrow">YOUR USUAL</span>
            <h2 id="usual-heading">
              {me.usual.service_name}
              {me.usual.staff_name && ` with ${me.usual.staff_name.split(" ")[0]}`}
            </h2>
            <p>
              {me.usual.count} time{me.usual.count === 1 ? "" : "s"}
              {me.usual.gap_weeks && ` · about every ${me.usual.gap_weeks} week${me.usual.gap_weeks === 1 ? "" : "s"}`} · {money(me.usual.price_pence)}
            </p>
          </div>
          <div className="ca-usual-actions">
            {me.next_usual ? (
              <Button onClick={() => book({ service: me.usual!.service_id, staff: me.usual!.staff_id, date: me.next_usual!.date, start: me.next_usual!.start_min, step: 2 })} data-testid="book-usual-next">
                <Icon name="sparkles" size={16} /> Next free: {me.next_usual.date === me.shop.today ? "today" : dateLabel(me.next_usual.date)} {time(me.next_usual.start_min)}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => book({ service: me.usual!.service_id, staff: me.usual!.staff_id, step: 2 })} data-testid="book-usual">
              Pick another time
            </Button>
          </div>
        </section>
      )}
      <section className="ca-section" aria-labelledby="waiting-heading" data-testid="waiting-list">
        <div className="sp-section-head">
          <h2 id="waiting-heading">Waiting list</h2>
          <p>{me.waiting?.length ? "Days you asked to be told about. When a time opens we message you a link to take it." : "Nothing at the moment. If the day you want is full, join the list from the booking page and we’ll text you when a time opens."}</p>
        </div>
        {me.waiting?.length > 0 ? (
          <ul className="ca-visits">
            {me.waiting.map((wt) => (
              <li key={wt.id} className="ca-visit">
                <div className="ca-visit-when">
                  <b>{wt.date_to && wt.date_to !== wt.date ? `${dateLabel(wt.date, { day: "numeric", month: "short" })} – ${dateLabel(wt.date_to, { day: "numeric", month: "short" })}` : dateLabel(wt.date)}</b>
                  <span>{windowLabel(wt)}</span>
                </div>
                <div className="ca-visit-what">
                  <b>{wt.service_name}</b>
                  <span>
                    {wt.staff_name ? `with ${wt.staff_name}` : "any barber"}
                    {wt.status === "OFFERED" && wt.offer_start_min != null && ` · offered ${wt.offer_date && wt.offer_date !== wt.date ? `${dateLabel(wt.offer_date, { weekday: "short", day: "numeric", month: "short" })} ` : ""}${time(wt.offer_start_min)}${wt.offer_staff_name ? ` with ${wt.offer_staff_name.split(" ")[0]}` : ""} — check your messages`}
                  </span>
                </div>
                <StatusPill tone={wt.status === "OFFERED" ? "next" : "note"}>{wt.status === "OFFERED" ? "Time offered" : "Waiting"}</StatusPill>
                <div className="ca-visit-actions">
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      await api(`${A}/waitlist/${wt.id}/leave`, "POST", { version: wt.version });
                      onChanged("You’re off the list for " + dateLabel(wt.date) + ".");
                    }}
                    data-testid="leave-waitlist"
                  >
                    Leave the list
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="ca-visit-actions">
            <a className="button secondary" href={shopPath(me.shop.slug, "/book")} data-testid="waiting-empty-book">Book a visit</a>
          </div>
        )}
      </section>
      <section className="ca-section" aria-labelledby="upcoming-heading">
        <div className="sp-section-head">
          <h2 id="upcoming-heading">Upcoming</h2>
          <p>{me.upcoming.length ? "Move or cancel online up to " + me.shop.cancel_hours + " hours ahead." : "Nothing booked yet."}</p>
        </div>
        {me.upcoming.length ? (
          <ul className="ca-visits" data-testid="upcoming-list">
            {me.upcoming.map((v) => (
              <li key={v.id} id={`visit-${v.id}`} className={`ca-visit${focusVisit === v.id ? " ca-visit-focus" : ""}`}>
                <div className="ca-visit-when">
                  <b>{v.date === me.shop.today ? "Today" : dateLabel(v.date)}</b>
                  <span>{time(v.start_min)} · {v.duration_min} min</span>
                </div>
                <div className="ca-visit-what">
                  <b>
                    {v.service_name}
                    {v.attendee_name && <small className="ca-for"> for {v.attendee_name}</small>}
                  </b>
                  <span>
                    {v.staff_name ? `with ${v.staff_name}` : ""} · {money(v.price_pence)} · {v.reference}
                    {v.group_id && (
                      <>
                        {" "}
                        · <Icon name="users" size={12} /> group
                      </>
                    )}
                    {v.series_id && (
                      <>
                        {" "}
                        · <Icon name="repeat" size={12} /> standing
                      </>
                    )}
                  </span>
                </div>
                <StatusPill tone={statusLabel[v.status]?.tone ?? "note"}>{statusLabel[v.status]?.text ?? v.status}</StatusPill>
                <div className="ca-visit-actions">
                  <a className="button ghost" href={`/api/public${A}/bookings/${v.id}/calendar.ics`}>
                    <Icon name="download" size={14} /> Calendar
                  </a>
                  {v.can_manage && (
                    <>
                      <Button variant="secondary" onClick={() => setMoving(v)} data-testid="move-visit">
                        Move
                      </Button>
                      <Button variant="ghost" onClick={() => setCancelling(v)} data-testid="cancel-visit">
                        Cancel
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="ca-empty">
            <Icon name="calendar" size={28} />
            <p>No upcoming visits.</p>
            <Button onClick={() => book({})}>Book a visit</Button>
          </div>
        )}
      </section>
      <section className="ca-section" aria-labelledby="history-heading">
        <div className="sp-section-head">
          <h2 id="history-heading">History</h2>
          <p>Past visits with {me.shop.name}. Tap one to book the same again.</p>
        </div>
        {history.length ? (
          <ul className="ca-visits history" data-testid="history-list">
            {history.map((v) => (
              <li key={v.id} id={`visit-${v.id}`} className={`ca-visit ${v.review || v.can_review ? "with-review" : ""}`}>
                {(v.review || v.can_review) && (
                  <ReviewCard
                    compact
                    review={v.review ?? null}
                    canReview={!!v.can_review}
                    googleUrl={me.shop.google_review_url || ""}
                    post={async (rating, body) => {
                      return api<{ review: OwnReview; google_review_url?: string }>(`/bookings/${v.id}/review`, "POST", { rating, body });
                    }}
                  />
                )}
                <div className="ca-visit-when">
                  <b>{dateLabel(v.date)}</b>
                  <span>{time(v.start_min)}</span>
                </div>
                <div className="ca-visit-what">
                  <b>
                    {v.service_name}
                    {v.attendee_name && <small className="ca-for"> for {v.attendee_name}</small>}
                  </b>
                  <span>
                    {v.staff_name ? `with ${v.staff_name}` : ""} · {money(v.price_pence)}
                  </span>
                </div>
                <StatusPill tone={statusLabel[v.status]?.tone ?? "note"}>{statusLabel[v.status]?.text ?? v.status}</StatusPill>
                <div className="ca-visit-actions">
                  <Button variant="secondary" onClick={() => book({ service: v.service_id, staff: v.staff_id, step: 2 })} data-testid="book-again">
                    <Icon name="repeat" size={14} /> Book again
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ca-muted">No past visits yet.</p>
        )}
        {me.history.length > 6 && (
          <Button variant="ghost" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "Show fewer" : `Show all ${me.history.length}`}
          </Button>
        )}
      </section>
      {moving && <MoveDialog visit={moving} me={me} A={A} onClose={() => setMoving(null)} onDone={(msg) => { setMoving(null); onChanged(msg); }} />}
      {cancelling && <CancelDialog visit={cancelling} A={A} onClose={() => setCancelling(null)} onDone={(msg) => { setCancelling(null); onChanged(msg); }} />}
    </>
  );
}

function CancelDialog({ visit, A, onClose, onDone }: { visit: Visit; A: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ late: boolean }>(`${A}/bookings/${visit.id}/cancel`, "POST", { version: visit.version });
      onDone(r.late ? "Your visit is cancelled. This was inside the shop’s cancellation window, so the shop has been told it was a late change." : "Your visit is cancelled.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ca-dialog-scrim" role="presentation" onClick={onClose}>
      <div className="ca-dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-heading" onClick={(e) => e.stopPropagation()}>
        <h2 id="cancel-heading">Cancel this visit?</h2>
        <p>
          {visit.service_name} on {dateLabel(visit.date)} at {time(visit.start_min)}.
          {visit.late_change && ` This is inside the ${visit.cancel_hours}-hour cancellation window; the shop will see it as a late change.`}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="ca-form-actions">
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" onClick={go} disabled={busy} data-testid="confirm-cancel">
            {busy ? "Cancelling…" : "Cancel visit"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MoveDialog({ visit, me, A, onClose, onDone }: { visit: Visit; me: Me; A: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [date, setDate] = useState(visit.date >= me.shop.today ? visit.date : me.shop.today);
  const [slots, setSlots] = useState<{ start_min: number; available: boolean }[] | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setSlots(null);
    setSlot(null);
    api<{ slots: { start_min: number; available: boolean }[] }>(`${A}/bookings/${visit.id}/availability?date=${date}`)
      .then((r) => setSlots(r.slots))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load times."));
  }, [date]);
  const days = Array.from({ length: 14 }, (_, i) => datePlus(me.shop.today, i));
  async function go() {
    if (slot === null) return;
    setBusy(true);
    setError("");
    try {
      await api(`${A}/bookings/${visit.id}/reschedule`, "POST", { date, start_min: slot, version: visit.version });
      onDone("Your visit has moved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not move the visit.");
    } finally {
      setBusy(false);
    }
  }
  const open = slots?.filter((s) => s.available) ?? [];
  return (
    <div className="ca-dialog-scrim" role="presentation" onClick={onClose}>
      <div className="ca-dialog wide" role="dialog" aria-modal="true" aria-labelledby="move-heading" onClick={(e) => e.stopPropagation()}>
        <h2 id="move-heading">Move your visit</h2>
        <p>
          {visit.service_name}
          {visit.staff_name && ` with ${visit.staff_name}`} · currently {dateLabel(visit.date)} {time(visit.start_min)}.
        </p>
        <div className="ca-days" role="group" aria-label="Choose a day">
          {days.map((d) => (
            <button key={d} type="button" aria-pressed={d === date} onClick={() => setDate(d)}>
              <small>{new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })}</small>
              <b>{d.slice(8)}</b>
            </button>
          ))}
        </div>
        <div className="ca-slots" role="group" aria-label="Choose a time" aria-busy={!slots}>
          {!slots && !error && <span className="ca-muted">Loading times…</span>}
          {slots && !open.length && <span className="ca-muted">No free times that day.</span>}
          {open.map((s) => (
            <button key={s.start_min} type="button" aria-pressed={slot === s.start_min} onClick={() => setSlot(s.start_min)} data-testid="move-slot">
              {time(s.start_min)}
            </button>
          ))}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="ca-form-actions">
          <Button variant="ghost" onClick={onClose}>
            Keep current time
          </Button>
          <Button onClick={go} disabled={busy || slot === null} data-testid="confirm-move">
            {busy ? "Moving…" : slot === null ? "Choose a time" : `Move to ${time(slot)}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProfileForm({ me, A, onSaved, onDeleted }: { me: Me; A: string; onSaved: (msg: string) => void; onDeleted: () => void }) {
  const p = me.profile;
  const smsOffered = me.shop.channels ? me.shop.channels.sms : true;
  const [form, setForm] = useState({ name: p.name, email: p.email, birthday: p.birthday, preferred_staff_id: p.preferred_staff_id, marketing_opt_in: p.marketing_opt_in, contact_pref: (p.contact_pref === "EMAIL" ? "EMAIL" : "AUTO") as "AUTO" | "EMAIL", notes: p.notes });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`${A}/profile`, "PUT", { ...form, version: p.version });
      onSaved("Profile saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  async function del() {
    setBusy(true);
    try {
      await api(`${A}/delete`, "POST", { confirm: "DELETE" });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete.");
      setBusy(false);
    }
  }
  return (
    <section className="ca-section" aria-labelledby="profile-heading">
      <div className="sp-section-head">
        <h2 id="profile-heading">Your profile</h2>
        <p>Shared with {me.shop.name} only. You sign in with {p.account_email || "your email"}.</p>
      </div>
      <form className="ca-form ca-profile" onSubmit={save} data-testid="profile-form">
        <label>
          <span>Name</span>
          <input value={form.name} onChange={(e) => set("name", e.target.value)} required minLength={2} maxLength={100} data-testid="profile-name" />
        </label>
        <label>
          <span>Email</span>
          <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} maxLength={254} required />
        </label>
        <label>
          <span>Birthday (optional)</span>
          <input type="date" value={form.birthday} onChange={(e) => set("birthday", e.target.value)} />
        </label>
        <label>
          <span>Preferred barber</span>
          <select value={form.preferred_staff_id} onChange={(e) => set("preferred_staff_id", e.target.value)} data-testid="profile-barber">
            <option value="">No preference</option>
            {me.staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ca-span">
          <span>Notes for your barber</span>
          <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} maxLength={500} rows={3} placeholder="Number 2 on the sides, scissors on top…" data-testid="profile-notes" />
        </label>
        <fieldset className="ca-consent ca-span">
          <legend>Reminders &amp; messages</legend>
          {smsOffered && (
            <label className="ca-check">
              <input type="checkbox" checked={form.contact_pref === "AUTO"} onChange={(e) => set("contact_pref", e.target.checked ? "AUTO" : "EMAIL")} data-testid="profile-texts" />
              <span>Text confirmations and reminders to {p.phone}</span>
            </label>
          )}
          <label className="ca-check">
            <input type="checkbox" checked={!!form.marketing_opt_in} onChange={(e) => set("marketing_opt_in", e.target.checked ? 1 : 0)} data-testid="profile-marketing" />
            <span>Send me offers and news from {me.shop.name}</span>
          </label>
          <small className="ca-hint">Booking confirmations and reminders always come by email to {form.email || p.email || "your email"}. Notifications on this device are under Your app.</small>
        </fieldset>
        {error && (
          <p className="form-error ca-span" role="alert">
            {error}
          </p>
        )}
        <div className="ca-form-actions ca-span">
          <Button type="submit" disabled={busy} data-testid="save-profile">
            {busy ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </form>
      <div className="ca-privacy">
        <PasswordPanel me={me} A={A} onSaved={onSaved} />
        <h3>Your data</h3>
        <p>Download everything this shop holds about you, or delete your online account. Deleting removes sign-in and your account; the shop keeps its own visit records as required for its books.</p>
        <div className="ca-form-actions start">
          <a className="button secondary" href={`/api/public${A}/export`} data-testid="export-data">
            <Icon name="download" size={15} /> Download my data
          </a>
          {confirmDelete !== "arm" ? (
            <Button variant="ghost" onClick={() => setConfirmDelete("arm")} data-testid="delete-account">
              Delete my account
            </Button>
          ) : (
            <>
              <Button variant="danger" onClick={del} disabled={busy} data-testid="confirm-delete">
                Yes, delete my account
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete("")}>
                Keep it
              </Button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
