// Owner/manager reviews: every barber listed (even with no reviews yet); tap one to see only theirs.
// Used in the top-bar Reviews drawer and, scoped to one barber, on that barber's page (Reviews tab).
// Hide keeps a review but takes it off the website; the customer's words are never edited.
import { useEffect, useState } from "react";
import type { WorkspaceData } from "../server/domain";
import { Avatar, Button, Icon, Notice } from "./ui";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export type ReviewRowView = { id: string; staff_id: string | null; rating: number; body: string; display_name: string; status: "PUBLISHED" | "HIDDEN"; reply: string; reply_at: number | null; reply_staff_id?: string | null; version: number; created_at: number; service_name: string; staff_name: string | null; visit_date: string };
type ReviewsData = { reviews: ReviewRowView[]; summary: { count: number; average: number | null; hidden: number }; by_staff?: { staff_id: string; name: string; count: number; average: number; low: number }[]; scope?: "all" | "own" };

const avg = (list: ReviewRowView[]) => (list.length ? Math.round((list.reduce((n, r) => n + r.rating, 0) / list.length) * 10) / 10 : null);

export function ReviewsPanel({ w, api, staffId }: { w: WorkspaceData; api: Api; staffId?: string }) {
  const [data, setData] = useState<ReviewsData | null>(null);
  const [who, setWho] = useState(staffId || "");
  const [error, setError] = useState("");
  const [replying, setReplying] = useState<{ id: string; text: string } | null>(null);
  const [filter, setFilter] = useState<"ALL" | "PUBLISHED" | "HIDDEN">("ALL");
  const canModerate = !w.account || ["OWNER", "MANAGER"].includes(w.account.role);
  // Barbers reply to reviews of their own appointments; the reply shows with their photo on the website.
  const myStaff = w.account?.staff_id || null;
  const canReply = (r: { staff_id: string | null }) => canModerate || (!!myStaff && r.staff_id === myStaff) || !!(w.account?.perms as { setup?: boolean } | undefined)?.setup;
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
  const scopeAvg = avg(shownScoped);
  // How the shown reviews spread across 5..1 stars, for the summary bars.
  const spread = [5, 4, 3, 2, 1].map((n) => ({ n, count: shownScoped.filter((r) => r.rating === n).length }));
  const stars = (n: number, size = 14) => (
    <span className="stars" role="img" aria-label={`${n} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Icon key={i} name="star" size={size} className={i <= Math.round(n) ? "on" : "off"} />
      ))}
    </span>
  );
  const photoOf = (id: string | null) => (id ? w.staff.find((s) => s.id === id)?.photo_url || undefined : undefined);
  const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join("") || "?";
  const thisYear = new Date().getFullYear();
  const when = (d: string) => {
    const t = new Date(`${d}T12:00:00Z`);
    if (Number.isNaN(t.getTime())) return d;
    return t.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(t.getUTCFullYear() !== thisYear ? { year: "numeric" } : {}) });
  };
  const headingId = `reviews-panel-heading${staffId ? "-" + staffId : ""}`;
  return (
    <section className="workspace-card reviews-panel rv2" data-testid="reviews-panel" aria-labelledby={headingId}>
      <header className="rv2-head">
        <h2 id={headingId}>{staffId ? `${person?.name.split(" ")[0] || "Their"} reviews` : "Reviews"}</h2>
        <p>{staffId ? "From this barber's own visits. Hidden reviews stay here but are taken off your website." : "Only customers with a booked visit can leave a review. Hiding one takes it off your website; words are never edited."}</p>
      </header>
      {error && <Notice tone="warning">{error}</Notice>}
      {data && (
        <div className="rv2-summary" data-testid="reviews-summary-card">
          <div className="rv2-score">
            <b data-testid="reviews-summary">{scopeAvg ?? "–"}</b>
            {stars(scopeAvg ?? 0, 16)}
            <small>
              {shownScoped.length} review{shownScoped.length === 1 ? "" : "s"}
              {scoped.length - shownScoped.length > 0 ? ` · ${scoped.length - shownScoped.length} hidden` : ""}
            </small>
          </div>
          <ul className="rv2-bars" aria-label="Rating breakdown">
            {spread.map((b) => (
              <li key={b.n}>
                <span>{b.n}</span>
                <Icon name="star" size={11} className="on" />
                <i><em style={{ width: `${shownScoped.length ? (b.count / shownScoped.length) * 100 : 0}%` }} /></i>
                <small>{b.count}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data && !staffId && data.scope !== "own" && people.length > 0 && (
        <div className="rv2-people" data-testid="review-people" role="group" aria-label="Reviews by barber">
          <button type="button" aria-pressed={!who} onClick={() => setWho("")} data-testid="review-person-all">
            <span className="rv2-all-ic"><Icon name="users" size={14} /></span>
            <span>Everyone</span>
            <b>{data.summary.average ?? "–"}</b>
          </button>
          {people.map((p) => (
            <button type="button" key={p.id} aria-pressed={who === p.id} onClick={() => setWho(who === p.id ? "" : p.id)} data-testid="review-person" data-staff={p.id} title={`${p.count} shown${p.hidden ? `, ${p.hidden} hidden` : ""}`}>
              <Avatar initials={initials(p.name)} src={photoOf(p.id)} size="xs" />
              <span>{p.name.split(" ")[0]}</span>
              <b>{p.average ?? "–"}</b>
            </button>
          ))}
        </div>
      )}
      <div className="rv2-filter" role="group" aria-label="Filter reviews">
        {(["ALL", "PUBLISHED", "HIDDEN"] as const).map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === "ALL" ? "All" : f === "PUBLISHED" ? "On website" : "Hidden"}
            <small>{f === "ALL" ? scoped.length : f === "PUBLISHED" ? shownScoped.length : scoped.length - shownScoped.length}</small>
          </button>
        ))}
      </div>
      {!data ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rv2-empty" data-testid="reviews-empty">
          <Icon name="star" size={24} />
          {who
            ? `No ${filter === "HIDDEN" ? "hidden " : filter === "PUBLISHED" ? "shown " : ""}reviews for ${person?.name.split(" ")[0] || "this barber"} yet.`
            : "No reviews yet. Customers are asked for one after each completed visit. Turn this on or off in Settings → Reviews & Google."}
        </p>
      ) : (
        <ul className="rv2-list review-admin-list">
          {rows.map((r) => (
            <li key={r.id} className={`rv2-card review-admin ${r.status === "HIDDEN" ? "hidden" : ""}`} data-testid="review-row" data-staff={r.staff_id || ""}>
              <header>
                <span className="rv2-avatar" aria-hidden="true">{initials(r.display_name)}</span>
                <div className="rv2-who">
                  <strong>{r.display_name}</strong>
                  <span className="rv2-meta">
                    {stars(r.rating, 13)}
                    <time dateTime={r.visit_date}>{when(r.visit_date)}</time>
                  </span>
                </div>
                {r.status === "HIDDEN" && <span className="rv2-hidden"><Icon name="eyeOff" size={12} /> Hidden</span>}
              </header>
              {r.body ? <p className="rv2-body">{r.body}</p> : <p className="rv2-body muted">No comment, just stars.</p>}
              <div className="rv2-tags">
                <span>{r.service_name}</span>
                {r.staff_name && !staffId && (
                  <span className="rv2-barber">
                    <Avatar initials={initials(r.staff_name)} src={photoOf(r.staff_id)} size="xs" />
                    {r.staff_name.split(" ")[0]}
                  </span>
                )}
              </div>
              {r.reply && replying?.id !== r.id && (
                <div className={`rv2-reply review-reply ${r.reply_staff_id ? "by-barber" : ""}`}>
                  <strong>
                    {r.reply_staff_id && <Avatar initials={initials(w.staff.find((s) => s.id === r.reply_staff_id)?.name || "?")} src={photoOf(r.reply_staff_id)} size="xs" />}
                    {r.reply_staff_id ? (r.reply_staff_id === myStaff ? "Your reply" : `${(w.staff.find((s) => s.id === r.reply_staff_id)?.name || "Barber").split(" ")[0]} replied`) : canModerate ? "Your reply" : "Shop reply"}
                  </strong>
                  <p>{r.reply}</p>
                </div>
              )}
              {replying?.id === r.id && (
                <div className="rv2-reply-form review-reply-form">
                  <textarea rows={3} maxLength={400} value={replying.text} onChange={(e) => setReplying({ id: r.id, text: e.target.value })} aria-label="Reply" placeholder="Thanks for coming in…" data-testid="reply-text" autoFocus />
                  <div className="review-actions">
                    <small>{replying.text.length}/400</small>
                    <Button variant="ghost" onClick={() => setReplying(null)}>Cancel</Button>
                    <Button variant="primary" onClick={() => act(r.id, "reply", { reply: replying.text.trim(), version: r.version })} data-testid="reply-save">
                      {r.reply ? "Update reply" : "Post reply"}
                    </Button>
                  </div>
                </div>
              )}
              {canReply(r) && replying?.id !== r.id && (
                <div className="rv2-actions review-admin-actions">
                  <button type="button" onClick={() => setReplying({ id: r.id, text: r.reply })} data-testid="review-reply">
                    <Icon name="messageReply" size={14} /> {r.reply ? "Edit reply" : "Reply"}
                  </button>
                  {canModerate && (
                    <button type="button" onClick={() => act(r.id, "status", { status: r.status === "HIDDEN" ? "PUBLISHED" : "HIDDEN", version: r.version })} data-testid="review-toggle">
                      <Icon name={r.status === "HIDDEN" ? "eye" : "eyeOff"} size={14} /> {r.status === "HIDDEN" ? "Show on website" : "Hide"}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
