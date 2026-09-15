// Public shop home page at /<slug>: the customer's front door. Booking is a section of this page
// (embedded PublicBooking); every card on the page re-targets that flow.
import { useEffect, useRef, useState } from "react";
import { PublicBooking, type BookingPreset } from "./PublicBooking";
import { Avatar, Icon } from "./ui";
import { money, time, dateLabel } from "./fixtures";

type PageData = {
  shop: { id: string; name: string; address: string; slug: string; timezone: string; opens: number; closes: number; deposit_pence: number; cancel_hours: number; lead_time_min: number; booking_window_days: number };
  page: { strapline: string; about: string; cover_url: string; gallery: string[]; phone: string; email: string; instagram: string; map_url: string; transport_note: string; policy_text: string; sections: string[]; accent: string; published: number };
  staff: { id: string; name: string; role: string; title?: string; bio?: string; colour?: string; photo_url?: string; skills?: string; instagram?: string }[];
  services: { id: string; name: string; category: string; duration_min: number; price_pence: number; description?: string; colour?: string; popular?: number }[];
  week: ({ weekday: number; open: false } | { weekday: number; open: true; starts: number; ends: number })[];
  open_now: boolean;
  today: string;
  closures: { date: string; label: string }[];
  soonest: { staff_id: string; staff_name: string; date: string; start_min: number; service_id: string; price_pence: number }[];
};
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const initials = (n: string) => n.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();

export function ShopPage({ slug }: { slug: string }) {
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState("");
  const [preset, setPreset] = useState<BookingPreset | null>(null);
  const bookRef = useRef<HTMLElement>(null);
  useEffect(() => {
    fetch(`/api/public/shops/${encodeURIComponent(slug)}/page`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || "This shop page is not available.");
        return r.json() as Promise<PageData>;
      })
      .then((d) => {
        setData(d);
        document.title = `${d.shop.name} · Book online`;
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load this shop."));
  }, [slug]);
  function book(p: BookingPreset = {}) {
    setPreset({ ...p, nonce: Date.now() });
    requestAnimationFrame(() => bookRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  if (error)
    return (
      <main className="state-card">
        <h1>Shop not found</h1>
        <p>{error}</p>
      </main>
    );
  if (!data)
    return (
      <p className="boot-message" role="status">
        Loading shop…
      </p>
    );
  const { shop, page } = data;
  const has = (k: string) => page.sections.includes(k);
  const todayHours = data.week[new Date(data.today + "T12:00:00Z").getUTCDay()];
  const nextOpen = (() => {
    for (let i = 1; i <= 7; i++) {
      const wd = (new Date(data.today + "T12:00:00Z").getUTCDay() + i) % 7;
      const h = data.week[wd];
      if (h.open) return `${i === 1 ? "tomorrow" : DAYS[wd]} ${time(h.starts)}`;
    }
    return "";
  })();
  const categories = [...new Set(data.services.map((s) => s.category))];
  const mapHref = page.map_url || (shop.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(shop.address)}` : "");
  return (
    <div className={`shop-page accent-${page.accent}`} data-testid="shop-page">
      <a className="skip-link" href="#book">
        Skip to booking
      </a>
      <header className="sp-nav">
        <a className="sp-brand" href={`/${shop.slug}`}>
          <span className="shop-emblem">{initials(shop.name)}</span>
          <strong>{shop.name}</strong>
        </a>
        <nav aria-label="Page sections">
          {has("services") && <a href="#services">Services</a>}
          {has("team") && <a href="#team">Team</a>}
          {has("hours") && <a href="#hours">Hours</a>}
          {has("find") && <a href="#find">Find us</a>}
        </nav>
        <button type="button" className="button primary sp-book-btn" onClick={() => book()} data-testid="nav-book">
          Book now
        </button>
      </header>

      <main id="main-content">
        {has("hero") && (
          <section className={`sp-hero ${page.cover_url ? "has-cover" : ""}`} style={page.cover_url ? { backgroundImage: `url("${page.cover_url}")` } : undefined}>
            <div className="sp-hero-inner">
              <span className={`sp-open ${data.open_now ? "open" : ""}`} data-testid="open-now">
                <i aria-hidden="true" />
                {data.open_now ? `Open now · until ${time((todayHours as { ends: number }).ends)}` : todayHours.open && nextOpen ? `Closed · opens ${nextOpen}` : nextOpen ? `Closed today · opens ${nextOpen}` : "Closed"}
              </span>
              <h1>{shop.name}</h1>
              <p className="sp-strap">{page.strapline || "Book your next visit online in under a minute."}</p>
              <div className="sp-hero-actions">
                <button type="button" className="button primary" onClick={() => book()} data-testid="hero-book">
                  <Icon name="calendar" size={16} /> Book now
                </button>
                {page.phone && (
                  <a className="button secondary" href={`tel:${page.phone.replace(/\s/g, "")}`}>
                    <Icon name="call" size={16} /> Call
                  </a>
                )}
                {mapHref && (
                  <a className="button secondary" href={mapHref} target="_blank" rel="noreferrer">
                    <Icon name="pin" size={16} /> Directions
                  </a>
                )}
              </div>
              <ul className="sp-facts">
                <li>
                  <Icon name="scissors" size={14} /> {data.staff.length} barber{data.staff.length === 1 ? "" : "s"}
                </li>
                <li>
                  <Icon name="clock" size={14} /> {time(shop.opens)}–{time(shop.closes)}
                </li>
                {shop.address && (
                  <li>
                    <Icon name="pin" size={14} /> {shop.address}
                  </li>
                )}
              </ul>
            </div>
          </section>
        )}

        {has("next") && data.soonest.length > 0 && (
          <section className="sp-section sp-next" aria-labelledby="sp-next-heading">
            <div className="sp-section-head">
              <h2 id="sp-next-heading">Next available</h2>
              <p>{data.services[0]?.name} · tap to book that time</p>
            </div>
            <ul className="sp-next-list">
              {data.soonest.map((n) => (
                <li key={n.staff_id}>
                  <button type="button" onClick={() => book({ service: n.service_id, staff: n.staff_id, date: n.date, start: n.start_min, step: 2 })} data-testid="soonest">
                    <Avatar initials={initials(n.staff_name)} colour={data.staff.find((s) => s.id === n.staff_id)?.colour || "sage"} />
                    <span>
                      <b>
                        {n.date === data.today ? "Today" : dateLabel(n.date, { weekday: "short", day: "numeric", month: "short" })} · {time(n.start_min)}
                      </b>
                      <small>
                        with {n.staff_name.split(" ")[0]} · {money(n.price_pence)}
                      </small>
                    </span>
                    <Icon name="right" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {page.about && (
          <section className="sp-section sp-about">
            <p>{page.about}</p>
          </section>
        )}

        {has("services") && (
          <section className="sp-section" id="services" aria-labelledby="sp-services-heading">
            <div className="sp-section-head">
              <h2 id="sp-services-heading">Services</h2>
              <p>Prices shown are the shop's live prices; some barbers price differently.</p>
            </div>
            {categories.map((cat) => (
              <div className="sp-cat" key={cat}>
                <h3>{cat}</h3>
                <ul className="sp-services">
                  {data.services
                    .filter((s) => s.category === cat)
                    .map((s) => (
                      <li key={s.id}>
                        <button type="button" onClick={() => book({ service: s.id, step: 1 })} data-testid="service-book">
                          <span className="sp-service-text">
                            <b>
                              {s.name}
                              {s.popular ? <em className="sp-popular">Popular</em> : null}
                            </b>
                            {s.description && <small>{s.description}</small>}
                          </span>
                          <span className="sp-service-meta">
                            <b>{money(s.price_pence)}</b>
                            <small>{s.duration_min} min</small>
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </section>
        )}

        {has("team") && (
          <section className="sp-section" id="team" aria-labelledby="sp-team-heading">
            <div className="sp-section-head">
              <h2 id="sp-team-heading">The team</h2>
              <p>Pick who you want; the booking remembers.</p>
            </div>
            <ul className="sp-team">
              {data.staff.map((b) => (
                <li key={b.id} className="sp-barber">
                  {b.photo_url ? <img src={b.photo_url} alt="" className={`sp-photo ${b.colour || ""}`} /> : <Avatar initials={initials(b.name)} colour={b.colour || "sage"} size="large" />}
                  <div className="sp-barber-text">
                    <b>{b.name}</b>
                    <small>{b.title || b.role}</small>
                    {b.bio && <p>{b.bio}</p>}
                    {b.skills && JSON.parse(b.skills).length > 0 && (
                      <span className="sp-skills">
                        {(JSON.parse(b.skills) as string[]).map((k) => (
                          <em key={k}>{k}</em>
                        ))}
                      </span>
                    )}
                  </div>
                  <div className="sp-barber-actions">
                    <button type="button" className="button secondary" onClick={() => book({ staff: b.id, step: 0 })} data-testid="barber-book">
                      Book with {b.name.split(" ")[0]}
                    </button>
                    {b.instagram && (
                      <a href={`https://instagram.com/${b.instagram}`} target="_blank" rel="noreferrer" className="sp-ig">
                        @{b.instagram}
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="sp-section sp-booking" id="book" ref={bookRef} aria-labelledby="sp-book-heading">
          <div className="sp-section-head">
            <h2 id="sp-book-heading">Book a visit</h2>
            <p>Choose a service, a barber and a time. You'll get a link to move or cancel it.</p>
          </div>
          <PublicBooking slug={slug} embedded preset={preset} />
        </section>

        {(has("hours") || has("find")) && (
          <div className="sp-two">
            {has("hours") && (
              <section className="sp-section" id="hours" aria-labelledby="sp-hours-heading">
                <h2 id="sp-hours-heading">Opening hours</h2>
                <dl className="sp-hours">
                  {[1, 2, 3, 4, 5, 6, 0].map((wd) => {
                    const h = data.week[wd];
                    const isToday = wd === new Date(data.today + "T12:00:00Z").getUTCDay();
                    return (
                      <div key={wd} className={isToday ? "today" : ""}>
                        <dt>{DAYS[wd]}</dt>
                        <dd>{h.open ? `${time(h.starts)} – ${time(h.ends)}` : "Closed"}</dd>
                      </div>
                    );
                  })}
                </dl>
                {data.closures.length > 0 && (
                  <p className="sp-closures">
                    <Icon name="calendar" size={14} /> Closed{" "}
                    {data.closures.map((c) => `${dateLabel(c.date, { day: "numeric", month: "short" })}${c.label ? ` (${c.label})` : ""}`).join(", ")}
                  </p>
                )}
              </section>
            )}
            {has("find") && (
              <section className="sp-section" id="find" aria-labelledby="sp-find-heading">
                <h2 id="sp-find-heading">Find us</h2>
                <address className="sp-address">
                  {shop.address && (
                    <p>
                      <Icon name="pin" size={16} /> {shop.address}
                    </p>
                  )}
                  {page.phone && (
                    <p>
                      <Icon name="call" size={16} /> <a href={`tel:${page.phone.replace(/\s/g, "")}`}>{page.phone}</a>
                    </p>
                  )}
                  {page.email && (
                    <p>
                      <Icon name="message" size={16} /> <a href={`mailto:${page.email}`}>{page.email}</a>
                    </p>
                  )}
                  {page.instagram && (
                    <p>
                      <Icon name="heart" size={16} />{" "}
                      <a href={`https://instagram.com/${page.instagram}`} target="_blank" rel="noreferrer">
                        @{page.instagram}
                      </a>
                    </p>
                  )}
                  {page.transport_note && <p className="sp-transport">{page.transport_note}</p>}
                </address>
                {mapHref && (
                  <a className="button secondary" href={mapHref} target="_blank" rel="noreferrer">
                    <Icon name="external" size={15} /> Open in maps
                  </a>
                )}
              </section>
            )}
          </div>
        )}

        {has("gallery") && page.gallery.length > 0 && (
          <section className="sp-section" aria-label="Gallery">
            <ul className="sp-gallery">
              {page.gallery.map((u, i) => (
                <li key={i}>
                  <img src={u} alt="" loading="lazy" />
                </li>
              ))}
            </ul>
          </section>
        )}

        {has("policies") && (
          <section className="sp-section sp-policies" aria-labelledby="sp-policies-heading">
            <h2 id="sp-policies-heading">Good to know</h2>
            <ul>
              <li>
                <Icon name="clock" size={15} /> Please cancel or move at least {shop.cancel_hours} hours ahead.
              </li>
              <li>
                <Icon name="calendar" size={15} /> Online bookings need {shop.lead_time_min >= 60 ? `${Math.round(shop.lead_time_min / 60)} hour${shop.lead_time_min >= 120 ? "s" : ""}` : `${shop.lead_time_min} minutes`}' notice and open up to {shop.booking_window_days} days ahead.
              </li>
              {shop.deposit_pence > 0 && (
                <li>
                  <Icon name="wallet" size={15} /> Deposit policy {money(shop.deposit_pence)} (not collected online in this build).
                </li>
              )}
              {page.policy_text && <li className="sp-policy-text">{page.policy_text}</li>}
            </ul>
          </section>
        )}
      </main>
      <footer className="sp-footer">
        <span>
          {shop.name}
          {shop.address ? ` · ${shop.address}` : ""}
        </span>
        <span className="powered-by">
          Powered by{" "}
          <strong>
            <img src="/static/brand/ollo-mark.svg" alt="" width={14} height={14} />
            OLLO
          </strong>
        </span>
      </footer>
    </div>
  );
}
