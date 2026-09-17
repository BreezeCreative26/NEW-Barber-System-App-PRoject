// Customer account area at /<slug>/me: passwordless sign-in (one-time code), upcoming visits with
// move/cancel, "your usual" one-tap rebook, history, profile and privacy controls. Talks only to
// /api/public/shops/:slug/account/*; the shop never sees another shop's history.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Avatar, Button, Icon, Notice, StatusPill } from "./ui";
import { dateLabel, datePlus, money, time, setCurrency } from "./fixtures";
import { ReviewCard, type OwnReview } from "./Reviews";
import { applyThemeColor, themeClass, type ShopBrand } from "./theme";

type Profile = { id: string; phone: string; name: string; email: string; birthday: string; preferred_staff_id: string; marketing_opt_in: number; notes: string; version: number; member_since: number };
type Visit = {
  review?: OwnReview;
  can_review?: boolean;
  id: string; reference: string; status: string; date: string; start_min: number; start_at: number; duration_min: number; service_name: string; service_id: string; staff_id: string; staff_name: string | null;
  price_pence: number; cancel_hours: number; version: number; can_manage: boolean; late_change: boolean; series_id: string | null; attendee_name?: string; group_id?: string | null; items: { id: string; name: string; price_pence: number }[];
};
type Me = {
  shop: { name: string; slug: string; address: string; timezone: string; currency?: string; cancel_hours: number; lead_time_min: number; today: string; logo_url?: string; brand?: ShopBrand };
  profile: Profile;
  upcoming: Visit[];
  history: Visit[];
  usual: null | { service_id: string; service_name: string; staff_id: string; staff_name: string | null; gap_weeks: number | null; price_pence: number; count: number };
  next_usual: null | { date: string; start_min: number; price_pence: number };
  staff: { id: string; name: string }[];
  stats: { visits: number; spent_pence: number; first_visit: string | null };
  waiting: { id: string; date: string; daypart: string; status: "OPEN" | "OFFERED"; version: number; service_name: string; staff_name: string | null; offer_start_min: number | null; offer_expires_at: number | null; offer_staff_name: string | null }[];
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
  const [tab, setTab] = useState<"visits" | "profile">("visits");
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
  if (!me)
    return (
      <p className="boot-message" role="status">
        Opening your visits…
      </p>
    );
  const first = me.profile.name.split(" ")[0] || "there";
  return (
    <div className={themeClass(me.shop.brand, "customer-area")} data-testid="customer-area">
      <header className="sp-nav">
        <a className="sp-brand" href={`/${me.shop.slug}`}>
          {me.shop.logo_url ? <img className="shop-emblem shop-logo" src={me.shop.logo_url} alt="" /> : <span className="shop-emblem">{initials(me.shop.name)}</span>}
          <strong>{me.shop.name}</strong>
        </a>
        <nav aria-label="Account">
          <a href={`/${me.shop.slug}#book`}>Book</a>
        </nav>
        <button type="button" className="button secondary" onClick={signOut} data-testid="sign-out">
          <Icon name="logout" size={15} /> Sign out
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
        <span className="sp-powered">Powered by OLLO</span>
      </footer>
    </div>
  );
}

function SignIn({ slug, A, onDone }: { slug: string; A: string; onDone: () => void }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"phone" | "code">("phone");
  const [shownCode, setShownCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shopName, setShopName] = useState("");
  const [shopBrand, setShopBrand] = useState<(ShopBrand & { logo_url: string }) | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
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
  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ sandbox_code?: string; delivery: "sms" | "on_screen" }>(`${A}/start`, "POST", { phone });
      setShownCode(r.delivery === "sms" ? "" : r.sandbox_code || "");
      setStage("code");
      setTimeout(() => codeRef.current?.focus(), 30);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send a code.");
    } finally {
      setBusy(false);
    }
  }
  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`${A}/verify`, "POST", { phone, code });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify the code.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={themeClass(shopBrand, "customer-area")} data-testid="customer-signin">
      <header className="sp-nav">
        <a className="sp-brand" href={`/${slug}`}>
          {shopBrand?.logo_url ? <img className="shop-emblem shop-logo" src={shopBrand.logo_url} alt="" /> : <span className="shop-emblem">{shopName ? initials(shopName) : "··"}</span>}
          <strong>{shopName || "Back to the shop"}</strong>
        </a>
      </header>
      <main id="main-content" className="ca-main ca-signin">
        <div className="ca-card">
          <span className="eyebrow">YOUR VISITS</span>
          <h1>{stage === "phone" ? "Sign in with your mobile." : "Enter your code."}</h1>
          <p className="ca-lead">
            {stage === "phone"
              ? "No password. We send a 6-digit code to your mobile; enter it and you are in. See upcoming visits, move or cancel them, and rebook your usual in one tap."
              : `Code for ${phone}. It lasts ten minutes.`}
          </p>
          {stage === "phone" ? (
            <form onSubmit={start} className="ca-form">
              <label>
                <span>Mobile number</span>
                <input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07700 900123" required data-testid="signin-phone" />
              </label>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={busy} data-testid="signin-send">
                {busy ? "Sending…" : "Send code"} <Icon name="arrowRight" size={16} />
              </Button>
            </form>
          ) : (
            <form onSubmit={verify} className="ca-form">
              {shownCode ? (
                <Notice icon="shield" tone="info">
                  <strong>Preview mode:</strong> your code is <code data-testid="shown-code">{shownCode}</code>.
                </Notice>
              ) : (
                <Notice icon="message" tone="info">
                  We've texted a 6-digit code to <strong>{phone}</strong>. It expires in 10 minutes.
                </Notice>
              )}
              <label>
                <span>6-digit code</span>
                <input ref={codeRef} type="text" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required data-testid="signin-code" />
              </label>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <div className="ca-form-actions">
                <Button variant="ghost" onClick={() => { setStage("phone"); setCode(""); setError(""); }}>
                  Different number
                </Button>
                <Button type="submit" disabled={busy || code.length !== 6} data-testid="signin-verify">
                  {busy ? "Checking…" : "Sign in"}
                </Button>
              </div>
            </form>
          )}
          <p className="ca-fine">Signing in creates a customer account for this shop only. Delete it any time from your profile.</p>
        </div>
      </main>
    </div>
  );
}

function Visits({ me, A, onChanged }: { me: Me; A: string; onChanged: (msg: string) => void }) {
  const [moving, setMoving] = useState<Visit | null>(null);
  const [cancelling, setCancelling] = useState<Visit | null>(null);
  const [showAll, setShowAll] = useState(false);
  const book = (q: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") params.set(k, String(v));
    location.href = `/${me.shop.slug}?${params.toString()}#book`;
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
      {me.waiting?.length > 0 && (
        <section className="ca-section" aria-labelledby="waiting-heading" data-testid="waiting-list">
          <div className="sp-section-head">
            <h2 id="waiting-heading">Waiting list</h2>
            <p>Days you asked to be told about. When a time opens we message you a link to take it.</p>
          </div>
          <ul className="ca-visits">
            {me.waiting.map((wt) => (
              <li key={wt.id} className="ca-visit">
                <div className="ca-visit-when">
                  <b>{dateLabel(wt.date)}</b>
                  <span>{{ ANY: "any time", MORNING: "morning", AFTERNOON: "afternoon", EVENING: "evening" }[wt.daypart]}</span>
                </div>
                <div className="ca-visit-what">
                  <b>{wt.service_name}</b>
                  <span>
                    {wt.staff_name ? `with ${wt.staff_name}` : "any barber"}
                    {wt.status === "OFFERED" && wt.offer_start_min != null && ` · offered ${time(wt.offer_start_min)}${wt.offer_staff_name ? ` with ${wt.offer_staff_name.split(" ")[0]}` : ""} — check your messages`}
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
        </section>
      )}
      <section className="ca-section" aria-labelledby="upcoming-heading">
        <div className="sp-section-head">
          <h2 id="upcoming-heading">Upcoming</h2>
          <p>{me.upcoming.length ? "Move or cancel online up to " + me.shop.cancel_hours + " hours ahead." : "Nothing booked yet."}</p>
        </div>
        {me.upcoming.length ? (
          <ul className="ca-visits" data-testid="upcoming-list">
            {me.upcoming.map((v) => (
              <li key={v.id} className="ca-visit">
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
              <li key={v.id} className={`ca-visit ${v.review || v.can_review ? "with-review" : ""}`}>
                {(v.review || v.can_review) && (
                  <ReviewCard
                    compact
                    review={v.review ?? null}
                    canReview={!!v.can_review}
                    post={async (rating, body) => {
                      const r = await api<{ review: OwnReview }>(`/bookings/${v.id}/review`, "POST", { rating, body });
                      return r.review;
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
  const [form, setForm] = useState({ name: p.name, email: p.email, birthday: p.birthday, preferred_staff_id: p.preferred_staff_id, marketing_opt_in: p.marketing_opt_in, notes: p.notes });
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
        <p>Shared with {me.shop.name} only. Your mobile ({p.phone}) is how you sign in.</p>
      </div>
      <form className="ca-form ca-profile" onSubmit={save} data-testid="profile-form">
        <label>
          <span>Name</span>
          <input value={form.name} onChange={(e) => set("name", e.target.value)} required minLength={2} maxLength={100} data-testid="profile-name" />
        </label>
        <label>
          <span>Email (optional)</span>
          <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} maxLength={254} />
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
        <label className="ca-check ca-span">
          <input type="checkbox" checked={!!form.marketing_opt_in} onChange={(e) => set("marketing_opt_in", e.target.checked ? 1 : 0)} />
          <span>Send me offers and news from {me.shop.name}</span>
        </label>
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
