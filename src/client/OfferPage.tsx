// /offer/<token>: the waiting-list customer's reply page. One held time, two buttons. No sign-in.
import { useEffect, useState } from "react";
import { Avatar, Button, Icon, Notice } from "./ui";
import { dateLabel, money, time, setCurrency } from "./fixtures";
import { applyThemeColor, themeClass, type ShopBrand } from "./theme";

type Offer = {
  id: string; status: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "SUPERSEDED" | "LOST"; date: string; start_min: number; expires_at: number;
  staff_name: string; service_name: string; price_pence: number; duration_min: number; customer_first: string; booking_id: string | null;
  shop: { name: string; address: string; slug: string | null; timezone: string; currency?: string; cancel_hours: number; logo_url?: string; brand?: ShopBrand };
};
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
  useEffect(() => {
    api<{ offer: Offer }>(`/offer/${token}`)
      .then((r) => {
        setCurrency(r.offer.shop.currency);
        setOffer(r.offer);
      applyThemeColor(r.offer.shop.brand);
        document.title = `A time has opened up · ${r.offer.shop.name}`;
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
      <p className="boot-message" role="status">
        Opening your offer…
      </p>
    );
  const expired = offer.status === "EXPIRED" || (offer.status === "PENDING" && offer.expires_at <= Date.now());
  const minutesLeft = Math.max(0, Math.round((offer.expires_at - Date.now()) / 60000));
  return (
    <div className={themeClass(offer.shop.brand, "customer-area")} data-testid="offer-page">
      <header className="sp-nav">
        <a className="sp-brand" href={offer.shop.slug ? `/${offer.shop.slug}` : "#"}>
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
                  : left
                    ? `We won’t message you about ${dateLabel(offer.date)} again.`
                    : `We’ll message you if another time opens up on ${dateLabel(offer.date)}.`}
              </p>
              {offer.shop.slug && (
                <a className="button secondary" href={`/${offer.shop.slug}#book`}>
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
