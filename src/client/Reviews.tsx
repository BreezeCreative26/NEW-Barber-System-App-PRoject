// Reviews: the customer's "How was it?" card (manage page, /me history) and the public list
// on the shop page. Owner moderation lives in Workspace (ReviewsPanel).
import { useState } from "react";
import { Button, Icon, Notice } from "./ui";

export type OwnReview = { id: string; rating: number; body: string; status: "PUBLISHED" | "HIDDEN"; reply: string; created_at: number } | null;
export type PublicReview = { id: string; rating: number; body: string; display_name: string; reply: string; reply_at: number | null; created_at: number; service_name: string; staff_name: string | null };

export function Stars({ value, size = 16, label }: { value: number; size?: number; label?: string }) {
  return (
    <span className="stars" role="img" aria-label={label ?? `${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Icon key={n} name="star" size={size} className={n <= Math.round(value) ? "on" : "off"} />
      ))}
    </span>
  );
}

const monthOf = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { month: "short", year: "numeric" });

// Posts to `post(rating, body)` which the host wires to the right endpoint.
export function ReviewCard({ review, canReview, post, compact = false }: { review: OwnReview; canReview: boolean; post: (rating: number, body: string) => Promise<OwnReview>; compact?: boolean }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<OwnReview>(review);
  const current = saved ?? review;
  if (current)
    return (
      <section className={`review-card done ${compact ? "compact" : ""}`} data-testid="review-card" aria-label="Your review">
        <header>
          <Stars value={current.rating} label={`You gave ${current.rating} out of 5`} />
          <span className="review-when">{monthOf(current.created_at)}</span>
        </header>
        {current.body && <p className="review-body">{current.body}</p>}
        {current.status === "HIDDEN" && <p className="review-note">Thanks for the feedback. The shop has chosen not to show this one on their page.</p>}
        {current.reply && (
          <p className="review-reply">
            <strong>Reply from the shop</strong>
            {current.reply}
          </p>
        )}
      </section>
    );
  if (!canReview) return null;
  const labels = ["", "Not good", "Could be better", "Fine", "Good", "Brilliant"];
  return (
    <section className={`review-card ${compact ? "compact" : ""}`} data-testid="review-card" aria-labelledby="review-heading">
      <h3 id="review-heading">How was it?</h3>
      <p className="review-hint">Your rating shows on the shop page with your first name only. It helps the shop and the next customer.</p>
      <div className="star-input" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} star${n > 1 ? "s" : ""} – ${labels[n]}`}
            className={n <= (hover || rating) ? "on" : ""}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            onClick={() => setRating(n)}
            data-testid={`star-${n}`}
          >
            <Icon name="star" size={compact ? 24 : 30} />
          </button>
        ))}
        <span className="star-label" aria-live="polite">
          {labels[hover || rating]}
        </span>
      </div>
      <label className="review-text">
        <span>Anything to add? (optional)</span>
        <textarea value={body} maxLength={600} rows={3} onChange={(e) => setBody(e.target.value)} placeholder="What stood out?" data-testid="review-body" />
      </label>
      {error && <Notice tone="warning">{error}</Notice>}
      <div className="review-actions">
        <Button
          variant="primary"
          disabled={!rating || busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              setSaved(await post(rating, body.trim()));
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not save your review.");
            } finally {
              setBusy(false);
            }
          }}
          data-testid="review-submit"
        >
          <Icon name="check" size={16} /> Send review
        </Button>
      </div>
    </section>
  );
}

export function PublicReviews({ reviews, rating }: { reviews: PublicReview[]; rating: { count: number; average: number | null } }) {
  if (!reviews.length) return null;
  return (
    <section className="sp-section sp-reviews" id="reviews" aria-labelledby="sp-reviews-heading" data-testid="reviews-section">
      <div className="sp-section-head">
        <h2 id="sp-reviews-heading">Reviews</h2>
        {rating.average !== null && (
          <p className="sp-rating-line">
            <Stars value={rating.average} label={`${rating.average} out of 5`} /> <strong>{rating.average}</strong> · {rating.count} verified review{rating.count === 1 ? "" : "s"}
          </p>
        )}
      </div>
      <ul className="sp-review-list">
        {reviews.map((r) => (
          <li key={r.id} className="sp-review" data-testid="public-review">
            <header>
              <Stars value={r.rating} size={14} />
              <strong>{r.display_name}</strong>
              <span>
                {r.service_name}
                {r.staff_name ? ` · ${r.staff_name.split(" ")[0]}` : ""} · {monthOf(r.created_at)}
              </span>
            </header>
            {r.body && <p>{r.body}</p>}
            {r.reply && (
              <p className="sp-review-reply">
                <Icon name="messageReply" size={14} /> <strong>Shop reply</strong> {r.reply}
              </p>
            )}
          </li>
        ))}
      </ul>
      <p className="sp-review-note">
        <Icon name="shield" size={13} /> Only people who had a booked visit can leave a review.
      </p>
    </section>
  );
}
