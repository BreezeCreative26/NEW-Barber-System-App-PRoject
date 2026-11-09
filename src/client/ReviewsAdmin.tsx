// Owner/manager reviews: every barber listed (even with no reviews yet); tap one to see only theirs.
// Used in the top-bar Reviews drawer and, scoped to one barber, on that barber's page (Reviews tab).
// Hide keeps a review but takes it off the website; the customer's words are never edited.
import { useEffect, useState } from "react";
import type { WorkspaceData } from "../server/domain";
import { Button, Icon, Notice, StatusPill } from "./ui";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export type ReviewRowView = { id: string; staff_id: string | null; rating: number; body: string; display_name: string; status: "PUBLISHED" | "HIDDEN"; reply: string; reply_at: number | null; version: number; created_at: number; service_name: string; staff_name: string | null; visit_date: string };
type ReviewsData = { reviews: ReviewRowView[]; summary: { count: number; average: number | null; hidden: number }; by_staff?: { staff_id: string; name: string; count: number; average: number; low: number }[]; scope?: "all" | "own" };

const avg = (list: ReviewRowView[]) => (list.length ? Math.round((list.reduce((n, r) => n + r.rating, 0) / list.length) * 10) / 10 : null);

export function ReviewsPanel({ w, api, staffId }: { w: WorkspaceData; api: Api; staffId?: string }) {
  const [data, setData] = useState<ReviewsData | null>(null);
  const [who, setWho] = useState(staffId || "");
  const [error, setError] = useState("");
  const [replying, setReplying] = useState<{ id: string; text: string } | null>(null);
  const [filter, setFilter] = useState<"ALL" | "PUBLISHED" | "HIDDEN">("ALL");
  const canModerate = !w.account || ["OWNER", "MANAGER"].includes(w.account.role);
  const load = () =>
    api<ReviewsData>("/reviews")
      .then((r) => {
        setData(r);
        setError("");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load reviews."));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (staffId) setWho(staffId);
  }, [staffId]);
  async function act(id: string, path: string, body: unknown) {
    try {
      await api(`/reviews/${id}/${path}`, "POST", body);
      setReplying(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That change did not save.");
      if ((e as { status?: number }).status === 409) load();
    }
  }
  const all = data?.reviews || [];
  // Every active barber gets a button (plus anyone who has reviews but has since left).
  const people = (() => {
    const ids = new Set<string>();
    const list: { id: string; name: string }[] = [];
    for (const s of w.staff.filter((x) => x.active)) {
      ids.add(s.id);
      list.push({ id: s.id, name: s.name });
    }
    for (const r of all) if (r.staff_id && !ids.has(r.staff_id)) { ids.add(r.staff_id); list.push({ id: r.staff_id, name: r.staff_name || "Former barber" }); }
    return list.map((p) => {
      const mine = all.filter((r) => r.staff_id === p.id);
      const shown = mine.filter((r) => r.status === "PUBLISHED");
      return { ...p, count: shown.length, hidden: mine.length - shown.length, average: avg(shown) };
    });
  })();
  const scoped = who ? all.filter((r) => r.staff_id === who) : all;
  const rows = scoped.filter((r) => filter === "ALL" || r.status === filter);
  const shownScoped = scoped.filter((r) => r.status === "PUBLISHED");
  const person = people.find((p) => p.id === who);
  const stars = (n: number) => (
    <span className="stars" role="img" aria-label={`${n} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Icon key={i} name="star" size={14} className={i <= n ? "on" : "off"} />
      ))}
    </span>
  );
  return (
    <section className="workspace-card reviews-panel" data-testid="reviews-panel" aria-labelledby={`reviews-panel-heading${staffId ? "-" + staffId : ""}`}>
      <header className="workspace-card-head">
        <div>
          <h2 id={`reviews-panel-heading${staffId ? "-" + staffId : ""}`}>{staffId ? `${person?.name.split(" ")[0] || "Their"} reviews` : "Reviews"}</h2>
          <p>
            {staffId
              ? "Reviews from this barber's own visits. They show under their name on your website; hide any you don't want shown."
              : "Only people who had a booked visit can leave one. Tap a barber to see only their reviews. Hide takes a review off the website; the customer's words are never edited."}
            {data && shownScoped.length > 0 && (
              <>
                {" "}
                <strong data-testid="reviews-summary">
                  {avg(shownScoped)} · {shownScoped.length} shown
                </strong>
                {scoped.length - shownScoped.length > 0 && ` · ${scoped.length - shownScoped.length} hidden`}
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
      {data && !staffId && data.scope !== "own" && people.length > 0 && (
        <div className="review-people" data-testid="review-people" role="group" aria-label="Reviews by barber">
          <button type="button" aria-pressed={!who} onClick={() => setWho("")} data-testid="review-person-all">
            <b>{data.summary.average ?? "–"}</b>
            <span>Everyone · {data.summary.count}</span>
          </button>
          {people.map((p) => (
            <button type="button" key={p.id} aria-pressed={who === p.id} onClick={() => setWho(who === p.id ? "" : p.id)} data-testid="review-person" data-staff={p.id}>
              <b>{p.average ?? "–"}</b>
              <span>
                {p.name.split(" ")[0]} · {p.count}
                {p.hidden ? ` (+${p.hidden} hidden)` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      {!data ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted" data-testid="reviews-empty">
          {who
            ? `No ${filter === "HIDDEN" ? "hidden " : filter === "PUBLISHED" ? "shown " : ""}reviews for ${person?.name.split(" ")[0] || "this barber"} yet.`
            : "No reviews yet. Customers are asked for one after each completed visit. Turn this on or off in Settings → Reviews & Google."}
        </p>
      ) : (
        <ul className="review-admin-list">
          {rows.map((r) => (
            <li key={r.id} className={`review-admin ${r.status === "HIDDEN" ? "hidden" : ""}`} data-testid="review-row" data-staff={r.staff_id || ""}>
              <header>
                <div className="review-admin-who">
                  <strong>{r.display_name}</strong>
                  {stars(r.rating)}
                  {r.status === "HIDDEN" && <StatusPill tone="note">Hidden from website</StatusPill>}
                </div>
                <span className="review-admin-meta">
                  {r.service_name}
                  {r.staff_name && !staffId ? ` · ${r.staff_name.split(" ")[0]}` : ""} · {r.visit_date}
                </span>
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
                    <Icon name={r.status === "HIDDEN" ? "eye" : "eyeOff"} size={14} /> {r.status === "HIDDEN" ? "Show on website" : "Hide from website"}
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
