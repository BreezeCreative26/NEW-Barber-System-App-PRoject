// /offer/<token>: the customer's reply page. One held time, two buttons.
// Every offer is confirmed by a signed-in customer, like any online booking: a cancellation-watch offer
// and a space the barber held (source HOLD) both ask them to create an account (prefilled) or sign in first.
import { Boot } from "./boot";
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { Avatar, Button, Icon, Notice } from "./ui";
import { dateLabel, money, time, setCurrency } from "./fixtures";
import { applyThemeColor, brandStyle, themeClass, type ShopBrand, shopPath } from "./theme";

type Offer = {
  id: string; status: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "SUPERSEDED" | "LOST"; date: string; start_min: number; expires_at: number;
  staff_name: string; service_name: string; price_pence: number; duration_min: number; customer_first: string; booking_id: string | null; source?: "MANUAL" | "AUTO" | "HOLD";
  shop: { name: string; address: string; slug: string | null; timezone: string; currency?: string; cancel_hours: number; logo_url?: string; brand?: ShopBrand };
};
type HoldInfo = { account: { name: string; email: string } | null; prefill: { name: string; phone: string; email: string } | null; terms: { version: number; text: string } | null };
type Accepted = { booking: { reference: string; date: string; start_min: number }; manage_token: string | null };
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

export function OfferPage({ token }: { token: string }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Accepted | null>(null);
  const [left, setLeft] = useState(false);
  const [actionError, setActionError] = useState("");
  const [hold, setHold] = useState<HoldInfo | null>(null);
  const load = () =>
    api<{ offer: Offer } & Partial<HoldInfo>>(`/offer/${token}`).then((r) => {
      setOffer(r.offer);
      setHold({ account: r.account ?? null, prefill: r.prefill ?? null, terms: r.terms ?? null });
      return r;
    });
  useEffect(() => {
    load()
      .then((r) => {
        setCurrency(r.offer.shop.currency);
      applyThemeColor(r.offer.shop.brand);
        document.title = r.offer.source === "HOLD" ? `Your held time · ${r.offer.shop.name}` : `A time has opened up · ${r.offer.shop.name}`;
      })
      .catch((e) => setError(e instanceof Error ? e.message : "This link is not valid."));
  }, [token]);
  async function accept() {
    setBusy(true);
    setActionError("");
    try {
      const r = await api<Accepted & { offer: Offer }>(`/offer/${token}/accept`, "POST", {});
      setDone(r);
      setOffer(r.offer);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) { setHold((h) => (h ? { ...h, account: null } : h)); setActionError("Please sign in first."); return; }
      setActionError(err.code === "slot_taken" ? "Sorry — that time was taken just before you tapped. You are still on the list and we will offer the next one." : err.message);
      api<{ offer: Offer }>(`/offer/${token}`).then((r) => setOffer(r.offer)).catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function decline(leave: boolean) {
    setBusy(true);
    setActionError("");
    try {
      const r = await api<{ offer: Offer; left: boolean }>(`/offer/${token}/decline`, "POST", { leave });
      setOffer(r.offer);
      setLeft(r.left);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not update.");
    } finally {
      setBusy(false);
    }
  }
  if (error)
    return (
      <div className="customer-area">
        <main id="main-content" className="ca-main ca-signin">
          <div className="ca-card">
            <h1>Offer not found</h1>
            <p className="ca-lead">{error}</p>
          </div>
        </main>
      </div>
    );
  if (!offer)
    return (
      <Boot label="Opening your offer…" />
    );
  const expired = offer.status === "EXPIRED" || (offer.status === "PENDING" && offer.expires_at <= Date.now());
  const minutesLeft = Math.max(0, Math.round((offer.expires_at - Date.now()) / 60000));
  return (
    <div className={themeClass(offer.shop.brand, "customer-area")} style={brandStyle(offer.shop.brand) as CSSProperties} data-testid="offer-page">
      <header className="sp-nav">
        <a className="sp-brand" href={offer.shop.slug ? shopPath(offer.shop.slug, "/") : "#"}>
          {offer.shop.logo_url ? <img className="shop-emblem shop-logo" src={offer.shop.logo_url} alt="" /> : <span className="shop-emblem">{initials(offer.shop.name)}</span>}
          <strong>{offer.shop.name}</strong>
        </a>
      </header>
      <main id="main-content" className="ca-main ca-signin">
        <div className="ca-card offer-card">
          {done ? (
            <>
              <span className="eyebrow">BOOKED</span>
              <h1>You’re in, {offer.customer_first}.</h1>
              <p className="ca-lead">
                {offer.service_name} with {offer.staff_name.split(" ")[0]} on {dateLabel(offer.date)} at {time(offer.start_min)}. Reference <strong>{done.booking.reference}</strong>.
              </p>
              {done.manage_token && (
                <a className="button primary" href={`/manage/${done.manage_token}`} data-testid="offer-manage-link">
                  <Icon name="calendarCheck" size={16} /> View or manage this visit
                </a>
              )}
              <p className="ca-fine">Cancel or move online up to {offer.shop.cancel_hours} hours ahead. Pay in the shop.</p>
            </>
          ) : offer.status === "PENDING" && !expired && offer.source === "HOLD" && hold ? (
            <HeldTime offer={offer} hold={hold} busy={busy} minutesLeft={minutesLeft} actionError={actionError} onSignedIn={() => load().catch(() => {})} onAccept={accept} onDecline={() => decline(true)} />
          ) : offer.status === "PENDING" && !expired ? (
            <>
              <span className="eyebrow">A TIME HAS OPENED UP</span>
              <h1>{offer.customer_first}, this one’s yours if you want it.</h1>
              <div className="offer-slot" data-testid="offer-slot">
                <Avatar initials={initials(offer.staff_name)} size="large" />
                <div>
                  <b>
                    {dateLabel(offer.date)} · {time(offer.start_min)}
                  </b>
                  <span>
                    {offer.service_name} with {offer.staff_name.split(" ")[0]} · {offer.duration_min} min · {money(offer.price_pence)}
                  </span>
                </div>
              </div>
              <Notice icon="clock">
                Held for you for another <strong>{minutesLeft} minute{minutesLeft === 1 ? "" : "s"}</strong>. After that it goes to the next person waiting.
              </Notice>
              {hold && !hold.account ? (
                <AccountStep offer={offer} hold={hold} actionError={actionError} submitLabel="to take it" onSignedIn={() => load().catch(() => {})} />
              ) : (
                <>
                  {hold?.account && <p className="held-who">Booking as <strong>{hold.account.name || hold.account.email}</strong>{hold.account.email ? ` · ${hold.account.email}` : ""}</p>}
                  {actionError && (
                    <p className="form-error" role="alert">
                      {actionError}
                    </p>
                  )}
                  <div className="ca-form-actions">
                    <Button variant="ghost" onClick={() => decline(false)} disabled={busy} data-testid="offer-decline">
                      Not this time, keep me on the list
                    </Button>
                    <Button onClick={accept} disabled={busy} data-testid="offer-accept">
                      <Icon name="check" size={16} /> {busy ? "Booking…" : "Take it"}
                    </Button>
                  </div>
                </>
              )}
              <button type="button" className="ca-linkish" onClick={() => decline(true)} disabled={busy} data-testid="offer-leave">
                I’m sorted elsewhere — take me off the list
              </button>
            </>
          ) : (
            <>
              <span className="eyebrow">{offer.status === "ACCEPTED" ? "ALREADY BOOKED" : left || offer.status === "DECLINED" ? "NOTED" : "OFFER CLOSED"}</span>
              <h1>
                {offer.status === "ACCEPTED"
                  ? "This time is already booked for you."
                  : offer.source === "HOLD" && (left || offer.status === "DECLINED")
                    ? "No problem — we’ve let the shop know."
                  : left
                    ? "You’re off the list."
                    : offer.status === "DECLINED"
                      ? "No problem — you’re still on the list."
                      : expired
                        ? "This offer has expired."
                        : "This offer is no longer open."}
              </h1>
              <p className="ca-lead">
                {offer.status === "ACCEPTED"
                  ? `${offer.service_name} on ${dateLabel(offer.date)} at ${time(offer.start_min)}. Check your messages for the manage link.`
                  : offer.source === "HOLD"
                    ? "The time has been released. Book another time whenever suits you."
                  : left
                    ? `We won’t message you about ${dateLabel(offer.date)} again.`
                    : `We’ll message you if another time opens up on ${dateLabel(offer.date)}.`}
              </p>
              {offer.shop.slug && (
                <a className="button secondary" href={shopPath(offer.shop.slug, "/", "#book")}>
                  Book another time instead
                </a>
              )}
            </>
          )}
          <p className="ca-fine">Pay in the shop. Nothing is charged online.</p>
        </div>
      </main>
    </div>
  );
}

// Create an account (prefilled from the request) or sign in, then the page reloads as signed in.
function AccountStep({ offer, hold, actionError, submitLabel, onSignedIn, onDecline, busy }: { offer: Offer; hold: HoldInfo; actionError: string; submitLabel: string; onSignedIn: () => void; onDecline?: () => void; busy?: boolean }) {
  const slug = offer.shop.slug || "";
  const A = `/shops/${encodeURIComponent(slug)}/account`;
  const [mode, setMode] = useState<"register" | "login">("register");
  const [name, setName] = useState(hold.prefill?.name || "");
  const [phone, setPhone] = useState(hold.prefill?.phone || "");
  const [email, setEmail] = useState(hold.prefill?.email || "");
  const [password, setPassword] = useState("");
  const [terms, setTerms] = useState(false);
  const [err, setErr] = useState("");
  const [working, setWorking] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setWorking(true);
    setErr("");
    try {
      if (mode === "register") await api(`${A}/register`, "POST", { name: name.trim(), phone: phone.trim(), email: email.trim(), password, marketing_opt_in: 0, contact_pref: "AUTO", accept_terms_version: hold.terms && terms ? hold.terms.version : 0 });
      else await api(`${A}/login`, "POST", { email: email.trim(), password });
      onSignedIn();
    } catch (x) {
      const m = x instanceof Error ? x.message : "Could not continue.";
      setErr(m);
      if (/already an account/i.test(m)) setMode("login");
    } finally {
      setWorking(false);
    }
  }
  return (
    <form className="ca-form held-form" onSubmit={submit} data-testid="hold-account-form">
      <p className="held-why">Sign in or create a free account {submitLabel}. It takes a few seconds and keeps your booking safe.</p>
      <div className="held-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "register"} onClick={() => { setMode("register"); setErr(""); }}>I’m new here</button>
        <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => { setMode("login"); setErr(""); }}>I have an account</button>
      </div>
      {mode === "register" && (
        <>
          <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" data-testid="hold-name" /></label>
          <label><span>Mobile</span><input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required autoComplete="tel" data-testid="hold-phone" /></label>
        </>
      )}
      <label><span>Email</span><input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete={mode === "login" ? "username" : "email"} data-testid="hold-email" /></label>
      <label><span>{mode === "register" ? "Choose a password" : "Password"}</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === "register" ? 8 : 1} autoComplete={mode === "register" ? "new-password" : "current-password"} data-testid="hold-password" /></label>
      {mode === "register" && hold.terms && (
        <label className="held-terms"><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} required /> <span>I accept {offer.shop.name}’s booking terms</span></label>
      )}
      {(err || actionError) && <p className="form-error" role="alert">{err || actionError}</p>}
      <Button type="submit" disabled={working} data-testid="hold-account-submit">{working ? "One moment…" : mode === "register" ? "Create account & continue" : "Sign in & continue"} <Icon name="arrowRight" size={16} /></Button>
      {onDecline && <button type="button" className="ca-linkish" onClick={onDecline} disabled={busy} data-testid="hold-decline">I can’t make it — release this time</button>}
    </form>
  );
}

// Held for you: who/when, then account (create or sign in), then a single Confirm button.
function HeldTime({ offer, hold, busy, minutesLeft, actionError, onSignedIn, onAccept, onDecline }: { offer: Offer; hold: HoldInfo; busy: boolean; minutesLeft: number; actionError: string; onSignedIn: () => void; onAccept: () => void; onDecline: () => void }) {
  const left = minutesLeft >= 120 ? `${Math.round(minutesLeft / 60)} hours` : `${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}`;
  return (
    <div className="held-time" data-testid="held-time">
      <span className="eyebrow">HELD FOR YOU</span>
      <h1>{offer.customer_first}, {offer.staff_name.split(" ")[0]} is holding this time for you.</h1>
      <div className="offer-slot" data-testid="offer-slot">
        <Avatar initials={initials(offer.staff_name)} size="large" />
        <div>
          <b>{dateLabel(offer.date)} · {time(offer.start_min)}</b>
          <span>{offer.service_name} with {offer.staff_name.split(" ")[0]} · {offer.duration_min} min · {money(offer.price_pence)}</span>
        </div>
      </div>
      <ol className="held-steps" aria-label="Steps">
        <li className={hold.account ? "done" : "on"}><span>1</span>{hold.account ? "Signed in" : "Your account"}</li>
        <li className={hold.account ? "on" : ""}><span>2</span>Confirm</li>
      </ol>
      {hold.account ? (
        <>
          <p className="held-who">Booking as <strong>{hold.account.name || hold.account.email}</strong>{hold.account.email ? ` · ${hold.account.email}` : ""}</p>
          {actionError && <p className="form-error" role="alert">{actionError}</p>}
          <div className="ca-form-actions">
            <Button variant="ghost" onClick={onDecline} disabled={busy} data-testid="hold-decline">I can’t make it</Button>
            <Button onClick={onAccept} disabled={busy} data-testid="hold-confirm"><Icon name="check" size={16} /> {busy ? "Booking…" : "Confirm my booking"}</Button>
          </div>
        </>
      ) : (
        <AccountStep offer={offer} hold={hold} actionError={actionError} submitLabel="to confirm" onSignedIn={onSignedIn} onDecline={onDecline} busy={busy} />
      )}
      <Notice icon="clock">Held for another <strong>{left}</strong>. After that the time is released.</Notice>
    </div>
  );
}
