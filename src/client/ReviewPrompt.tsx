// One-time pop-ups for a signed-in customer, remembered on their account (once per person, any device):
// 1) a message from their barber asking for a review of their latest visit — gone for good once they
//    have reviewed; "Not now" hides it until their next visit;
// 2) the "add the app to your home screen" message — shown once per account.
// Only one shows at a time: the review first, the app message on a later visit/page.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Avatar, Button, Icon } from "./ui";
import { brandStyle, serverBrand, themeClass, type ShopBrand } from "./theme";
import { InstallPrompt } from "./InstallPrompt";
import { reviewMessage } from "../server/domain";

type ReviewAsk = { id: string; service_name: string; date: string; start_min: number; staff_name: string | null; staff_photo: string; staff_colour: string; review_message?: string; google_review_url: string };
type Prompts = { install_seen: boolean; first_name?: string; review: ReviewAsk | null };

const base = (slug: string) => `/api/public/shops/${encodeURIComponent(slug)}/account`;
const send = (slug: string, path: string, body: unknown) =>
  fetch(`${base(slug)}${path}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const dayOf = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const initialsOf = (n: string) => n.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();

export function CustomerPrompts({ slug, shopName, signedIn, brand, review = true }: { slug: string; shopName: string; signedIn: boolean; brand?: Partial<ShopBrand> | null; review?: boolean }) {
  const [p, setP] = useState<Prompts | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  useEffect(() => {
    if (!signedIn) { setP(null); return; }
    let live = true;
    fetch(`${base(slug)}/prompts`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Prompts | null) => { if (!live || !d) return; if (!review) d = { ...d, review: null }; setP(d); setReviewOpen(!!d.review); })
      .catch(() => {});
    return () => { live = false; };
  }, [slug, signedIn, review]);
  if (!signedIn || !p) return null;
  if (reviewOpen && p.review)
    return <ReviewPrompt slug={slug} shopName={shopName} brand={brand} ask={p.review} firstName={p.first_name || ""} onClose={() => setReviewOpen(false)} />;
  // Don't stack the app message straight after the review pop-up; it shows next time.
  if (p.review) return null;
  return <InstallPrompt slug={slug} shopName={shopName} signedIn brand={brand} seen={p.install_seen} onSeen={() => { void send(slug, "/prompts", { install: true }).catch(() => {}); }} />;
}

const labels = ["", "Not good", "Could be better", "Fine", "Good", "Brilliant"];
function ReviewPrompt({ slug, shopName, brand, ask, firstName, onClose }: { slug: string; shopName: string; brand?: Partial<ShopBrand> | null; ask: ReviewAsk; firstName: string; onClose: () => void }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ google: string } | null>(null);
  const look = brand || serverBrand()?.brand || null;
  const barber = (ask.staff_name || shopName).trim();
  const barberFirst = ask.staff_name ? barber.split(" ")[0] : shopName;
  const later = () => { void send(slug, "/prompts", { review_dismissed: ask.id }).catch(() => {}); onClose(); };
  const submit = async () => {
    if (!rating) { setError("Tap a star to rate your visit."); return; }
    setBusy(true); setError("");
    try {
      const r = await send(slug, `/bookings/${encodeURIComponent(ask.id)}/review`, { rating, body: body.trim() });
      const j = (await r.json().catch(() => ({}))) as { google_review_url?: string; message?: string };
      if (!r.ok) throw new Error(j.message || "Couldn't send your review. Please try again.");
      setDone({ google: j.google_review_url || (rating >= 4 ? ask.google_review_url : "") });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send your review.");
    } finally { setBusy(false); }
  };
  return (
    <div className={themeClass(look, "install-pop-backdrop")} style={brandStyle(look) as CSSProperties | undefined} role="presentation">
      <section className="install-pop review-pop" role="dialog" aria-modal="true" aria-labelledby="review-pop-title" data-testid="review-popup">
        <div className="review-pop-from">
          <Avatar initials={initialsOf(barber)} colour={ask.staff_colour} src={ask.staff_photo || undefined} size="large" />
        </div>
        {done ? (
          <>
            <h2 id="review-pop-title">Thank you{firstName ? `, ${firstName}` : ""}!</h2>
            <p>Your review means a lot. — {barberFirst}</p>
            {done.google && rating >= 4 && (
              <p className="review-pop-google">If you have 30 seconds, the same review on Google really helps other people find us.</p>
            )}
            <div className="install-pop-actions">
              {done.google && rating >= 4 && (
                <a className="button primary" href={done.google} target="_blank" rel="noreferrer" data-testid="review-popup-google"><Icon name="external" size={15} /> Review on Google</a>
              )}
              <button type="button" className="install-pop-later" onClick={onClose} data-testid="review-popup-close">Close</button>
            </div>
          </>
        ) : (
          <>
            <h2 id="review-pop-title">How did I do?</h2>
            <p className="review-pop-msg">
              {reviewMessage(ask.review_message, { first_name: firstName, service: ask.service_name, date: dayOf(ask.date), shop: shopName, barber: barberFirst })}
              <span className="review-pop-sign">— {barberFirst}{ask.staff_name ? `, ${shopName}` : ""}</span>
            </p>
            <div className="star-input review-pop-stars" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? "s" : ""} – ${labels[n]}`} className={n <= (hover || rating) ? "on" : ""}
                  onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(0)} onClick={() => { setRating(n); setError(""); }} data-testid={`review-popup-star-${n}`}>
                  <Icon name="star" size={30} />
                </button>
              ))}
            </div>
            <div className="review-pop-label">{labels[hover || rating] || "\u00a0"}</div>
            {rating > 0 && (
              <textarea className="review-pop-text" rows={3} maxLength={1000} placeholder="Anything you'd like to add? (optional)" value={body} onChange={(e) => setBody(e.target.value)} data-testid="review-popup-text" />
            )}
            {error && <p className="review-pop-error" role="alert">{error}</p>}
            <div className="install-pop-actions">
              <Button onClick={submit} disabled={busy} data-testid="review-popup-send">{busy ? "Sending…" : "Send review"}</Button>
              <button type="button" className="install-pop-later" onClick={later} data-testid="review-popup-later">Not now</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
