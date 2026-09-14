import { useEffect, useState, type FormEvent } from "react";
import {
  addons,
  appointmentsFor,
  dateLabel,
  datePlus,
  money,
  quote,
  SAMPLE_DAY,
  services,
  staff,
  time,
  previewSlotReason,
  validateDetails,
  type Booking,
} from "./fixtures";
import {
  Avatar,
  Badge,
  Boundary,
  Brand,
  Button,
  Icon,
  IconButton,
  Modal,
  Notice,
  StateEnvelope,
  type Scenario,
} from "./ui";

export function BookingDetail({
  booking,
  date,
  onClose,
}: {
  booking: Booking;
  date: string;
  onClose: () => void;
}) {
  const barber = staff.find((s) => s.id === booking.barber)!;
  return (
    <Modal title="Appointment details" onClose={onClose}>
      <div className="detail-person">
        <Avatar
          initials={booking.customer
            .split(" ")
            .map((n) => n[0])
            .join("")}
          size="large"
        />
        <div>
          <h3>{booking.customer}</h3>
          <span className="muted">
            Fictional customer · {booking.id.toUpperCase()}
          </span>
        </div>
      </div>
      <div className="detail-status">
        <Badge tone={booking.status === "In chair" ? "active" : ""}>
          {booking.status}
        </Badge>
        {booking.source && <Badge tone="neutral">{booking.source}</Badge>}
      </div>
      <dl className="detail-grid">
        <div>
          <dt>Service</dt>
          <dd>{booking.service}</dd>
        </div>
        <div>
          <dt>Barber</dt>
          <dd>{barber.name}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>
            {dateLabel(date, {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </dd>
        </div>
        <div>
          <dt>Time · Europe/London</dt>
          <dd>
            {time(booking.start)}–{time(booking.start + booking.duration)}
          </dd>
        </div>
      </dl>
      <section className="payment-breakdown">
        <h3>Sample payment breakdown</h3>
        <p>
          <span>Service total</span>
          <strong>{money(booking.price)}</strong>
        </p>
        <p>
          <span>Deposit shown in fixture</span>
          <strong>−{money(booking.deposit)}</strong>
        </p>
        <p className="total">
          <span>Illustrative remainder</span>
          <strong>{money(booking.price - booking.deposit)}</strong>
        </p>
      </section>
      {booking.note && <Notice icon="message">{booking.note}</Notice>}
      <Notice>
        No real booking or payment exists. Check-in, refunds and rescheduling
        will connect to the secure booking API in later milestones.
      </Notice>
      <footer className="modal-footer">
        <Button variant="secondary" onClick={onClose}>
          Close details
        </Button>
      </footer>
    </Modal>
  );
}

export function BookingDraft({
  onClose,
  initialDate = SAMPLE_DAY,
}: {
  onClose: () => void;
  initialDate?: string;
}) {
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    notes: "",
    barber: "jay",
    service: "cut",
    date: initialDate,
    start: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reviewed, setReviewed] = useState(false);
  const q = quote(form.service, form.barber, []);
  const update = (name: string, value: string) => {
    setForm((f) => ({
      ...f,
      [name]: value,
      ...(["service", "barber", "date"].includes(name) ? { start: "" } : {}),
    }));
    setErrors({});
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = validateDetails(form);
    if (!form.start) next.start = "Choose an available sample time.";
    else if (
      previewSlotReason(form.date, form.barber, Number(form.start), q.duration)
    )
      next.start = "This sample slot is unavailable.";
    setErrors(next);
    if (Object.keys(next).length)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
    else setReviewed(true);
  };
  return (
    <Modal
      title={reviewed ? "Draft review" : "New booking preview"}
      onClose={onClose}
    >
      {reviewed ? (
        <>
          <Notice icon="check">
            <strong>Form checks passed.</strong> This is a draft preview only.
            No appointment was saved and no slot is held.
          </Notice>
          <dl className="detail-grid">
            <div>
              <dt>Customer</dt>
              <dd>{form.name}</dd>
            </div>
            <div>
              <dt>Service</dt>
              <dd>{q.service.name}</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>{dateLabel(form.date)}</dd>
            </div>
            <div>
              <dt>Sample time</dt>
              <dd>{time(Number(form.start))}</dd>
            </div>
          </dl>
          <div className="summary-total">
            <span>Sample service total</span>
            <strong>{money(q.price)}</strong>
          </div>
          <footer className="modal-footer">
            <Button variant="secondary" onClick={() => setReviewed(false)}>
              Edit draft
            </Button>
            <Button onClick={onClose}>Close preview</Button>
          </footer>
        </>
      ) : (
        <form noValidate onSubmit={submit}>
          <Notice>
            Try the form with fictional details. Nothing is sent or stored; this
            is not a live booking.
          </Notice>
          <div className="form-grid">
            <label>
              Customer name
              <input
                autoComplete="off"
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? "draft-name-error" : undefined}
                placeholder="e.g. Jamie Taylor"
              />
              {errors.name && (
                <span className="field-error" id="draft-name-error">
                  {errors.name}
                </span>
              )}
            </label>
            <label>
              Mobile number
              <input
                type="tel"
                autoComplete="off"
                value={form.phone}
                onChange={(e) => update("phone", e.target.value)}
                aria-invalid={!!errors.phone}
                aria-describedby={
                  errors.phone ? "draft-phone-error" : undefined
                }
                placeholder="07700 900123"
              />
              {errors.phone && (
                <span className="field-error" id="draft-phone-error">
                  {errors.phone}
                </span>
              )}
            </label>
            <label>
              Service
              <select
                value={form.service}
                onChange={(e) => update("service", e.target.value)}
              >
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.duration} min
                  </option>
                ))}
              </select>
            </label>
            <label>
              Barber
              <select
                value={form.barber}
                onChange={(e) => update("barber", e.target.value)}
              >
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Date
              <input
                type="date"
                min={SAMPLE_DAY}
                max="2026-10-14"
                required
                value={form.date}
                onChange={(e) => {
                  if (e.target.value) update("date", e.target.value);
                }}
              />
            </label>
            <label>
              Sample start time
              <select
                value={form.start}
                onChange={(e) => update("start", e.target.value)}
                aria-invalid={!!errors.start}
                aria-describedby={
                  errors.start ? "draft-start-error" : undefined
                }
              >
                <option value="">Choose a time</option>
                {Array.from({ length: 36 }, (_, i) => 540 + i * 15).map((m) => {
                  const reason = previewSlotReason(
                    form.date,
                    form.barber,
                    m,
                    q.duration,
                  );
                  return (
                    <option key={m} value={m} disabled={!!reason}>
                      {time(m)}
                      {reason ? ` — ${reason}` : ""}
                    </option>
                  );
                })}
              </select>
              {errors.start && (
                <span className="field-error" id="draft-start-error">
                  {errors.start}
                </span>
              )}
            </label>
          </div>
          <div className="summary-total">
            <span>Sample total · {q.duration} min</span>
            <strong>{money(q.price)}</strong>
          </div>
          <footer className="modal-footer">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">
              Review draft
              <Icon name="arrowRight" />
            </Button>
          </footer>
        </form>
      )}
    </Modal>
  );
}

export function Admin({
  scenario,
  setScenario,
}: {
  scenario: Scenario;
  setScenario: (s: Scenario) => void;
}) {
  const [date, setDate] = useState(SAMPLE_DAY);
  const [barber, setBarber] = useState("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState(() =>
    window.matchMedia("(max-width: 740px)").matches ? "agenda" : "day",
  );
  const [selected, setSelected] = useState<Booking | null>(null);
  const [panel, setPanel] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
    const focusables = () =>
      Array.from(
        sidebar.querySelectorAll<HTMLElement>("a,button:not(:disabled)"),
      );
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
      }
      if (e.key === "Tab") {
        const nodes = focusables();
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [menuOpen]);
  const day = appointmentsFor(date);
  const filtered = day.filter(
    (b) =>
      (barber === "all" || b.barber === barber) &&
      `${b.customer} ${b.service}`.toLowerCase().includes(search.toLowerCase()),
  );
  const visibleStaff = staff.filter((s) => barber === "all" || s.id === barber);
  const completed = day.filter((b) => b.status === "Completed").length;
  const count = day.length;
  const navPanel = (name: string) => {
    setPanel(name);
    setMenuOpen(false);
  };
  return (
    <div className="admin-shell">
      {menuOpen && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside
        className={`sidebar ${menuOpen ? "open" : ""}`}
        aria-label="Shop navigation"
      >
        <a className="brand-link" href="/preview/admin">
          <Brand light />
        </a>
        <button
          className="nav-close-button"
          aria-label="Close navigation panel"
          onClick={() => setMenuOpen(false)}
        >
          <Icon name="close" />
        </button>
        <div className="shop-switch">
          <span className="shop-monogram">
            N<span>&</span>
          </span>
          <div>
            <strong>North & Co.</strong>
            <span>Ancoats, Manchester</span>
          </div>
          <Badge tone="sidebar-badge">Demo</Badge>
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="Admin navigation">
          <button
            className="nav-item selected"
            onClick={() => {
              setMenuOpen(false);
              setDate(SAMPLE_DAY);
              setSearch("");
              setBarber("all");
              setView(
                window.matchMedia("(max-width: 740px)").matches
                  ? "agenda"
                  : "day",
              );
            }}
            aria-current="page"
          >
            <Icon name="calendar" />
            Calendar<span className="nav-count">{count}</span>
          </button>
          <button className="nav-item" onClick={() => navPanel("team")}>
            <Icon name="users" />
            Team directory<span className="nav-small">4</span>
          </button>
          <button className="nav-item" onClick={() => navPanel("services")}>
            <Icon name="scissors" />
            Service menu
          </button>
        </nav>
        <span className="nav-label explore-label">EXPLORE THE PREVIEW</span>
        <nav aria-label="Other preview experiences">
          <a className="nav-item" href="/preview/book">
            <Icon name="external" />
            Booking page
            <Icon name="arrowUp" size={15} />
          </a>
          <a className="nav-item" href="/preview/barber">
            <Icon name="phone" />
            Barber workspace
            <Icon name="arrowUp" size={15} />
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="foundation-card">
            <span className="foundation-icon">
              <Icon name="sparkles" />
            </span>
            <strong>A better day in the chair.</strong>
            <p>Your shop, thoughtfully connected.</p>
            <button onClick={() => navPanel("guide")}>
              About this preview
              <Icon name="arrowRight" size={14} />
            </button>
          </div>
          <div className="owner-card">
            <Avatar initials="NC" colour="sand" />
            <div>
              <strong>Shop owner</strong>
              <span>Sample workspace · no login</span>
            </div>
            <button
              className="sidebar-help"
              aria-label="Preview information"
              onClick={() => navPanel("guide")}
            >
              <Icon name="help" />
            </button>
          </div>
        </div>
      </aside>
      <div className="admin-body">
        <header className="workspace-header">
          <div className="header-context">
            <span className="mobile-menu">
              <IconButton
                name="menu"
                label="Open navigation"
                onClick={() => setMenuOpen(!menuOpen)}
                aria-expanded={menuOpen}
              />
            </span>
            <span className="header-breadcrumb">
              Workspace
              <Icon name="right" size={14} />
              <strong>Calendar</strong>
            </span>
          </div>
          <div className="header-tools">
            <label className="search-box">
              <Icon name="search" size={17} />
              <input
                aria-label="Search sample appointments"
                placeholder="Find an appointment…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  aria-label="Clear appointment search"
                  onClick={() => setSearch("")}
                >
                  <Icon name="close" size={15} />
                </button>
              )}
            </label>
            <span className="header-divider" />
            <IconButton
              name="help"
              label="About this preview"
              onClick={() => setPanel("guide")}
            />
            <Avatar initials="NC" colour="sage" />
          </div>
        </header>
        <main id="main-content" className="admin-main">
          <div className="page-heading">
            <div>
              <span className="eyebrow">LET’S MAKE IT A GOOD ONE</span>
              <h1>
                Your day, at a glance<span className="accent-period">.</span>
              </h1>
              <p>Keep the chairs moving. We’ll keep the day organised.</p>
            </div>
            <Button onClick={() => setPanel("new")}>
              <Icon name="plus" />
              New booking
            </Button>
          </div>
          <StateEnvelope
            scenario={scenario}
            onReset={() => setScenario("normal")}
          >
            <section className="stats-grid" aria-label="Sample day statistics">
              {[
                {
                  label: "Appointments",
                  value: String(count).padStart(2, "0"),
                  icon: "calendarCheck",
                  foot: "Across 4 barbers",
                  detail: `${completed} completed`,
                  bars: [36, 58, 44, 74, 65, 88, 70],
                },
                {
                  label: "Expected service sales",
                  value: money(day.reduce((sum, b) => sum + b.price, 0)),
                  icon: "wallet",
                  foot: "Sample values · not collected",
                  detail: "",
                  bars: [25, 38, 50, 41, 65, 55, 80],
                },
                {
                  label: "Chair occupancy",
                  value: `${count ? Math.round((day.reduce((sum, b) => sum + b.duration, 0) / (4 * (540 - 45))) * 100) : 0}%`,
                  icon: "users",
                  foot: "Service time ÷ staffed time",
                  detail: "",
                  bars: [32, 50, 38, 62, 54, 70, 62],
                },
                {
                  label: "Walk-ins",
                  value: String(day.filter((b) => b.source).length).padStart(
                    2,
                    "0",
                  ),
                  icon: "user",
                  foot: "Included in appointments",
                  detail: "",
                  bars: [15, 27, 15, 38, 22, 48, 35],
                },
              ].map((s) => (
                <article className="stat-card" key={s.label}>
                  <div className="stat-label">
                    {s.label}
                    <Icon name={s.icon} size={17} />
                  </div>
                  <div className="stat-value">
                    {s.value}
                    <div className="spark-bars" aria-hidden="true">
                      {s.bars.map((h, i) => (
                        <span key={i} style={{ height: `${h}%` }} />
                      ))}
                    </div>
                  </div>
                  <div className="stat-foot">
                    {s.detail && (
                      <span className="stat-detail">{s.detail}</span>
                    )}
                    {s.foot}
                  </div>
                </article>
              ))}
            </section>
            <section
              className="calendar-card"
              aria-label="Appointment calendar"
            >
              <header className="calendar-toolbar">
                <div className="date-controls">
                  <IconButton
                    name="left"
                    label="Previous day"
                    onClick={() => setDate(datePlus(date, -1))}
                  />
                  <IconButton
                    name="right"
                    label="Next day"
                    onClick={() => setDate(datePlus(date, 1))}
                  />
                  <h2>
                    {dateLabel(date, {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    })}
                  </h2>
                  <button
                    className="today-button"
                    onClick={() => setDate(SAMPLE_DAY)}
                  >
                    Sample today
                  </button>
                </div>
                <div className="calendar-options">
                  <label className="select-with-icon">
                    <Icon name="users" size={16} />
                    <select
                      aria-label="Filter calendar by barber"
                      value={barber}
                      onChange={(e) => setBarber(e.target.value)}
                    >
                      <option value="all">All barbers</option>
                      {staff.map((s) => (
                        <option value={s.id} key={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="segmented" aria-label="Calendar view">
                    <button
                      aria-pressed={view === "day"}
                      onClick={() => setView("day")}
                    >
                      <Icon name="calendar" size={15} />
                      Day
                    </button>
                    <button
                      aria-pressed={view === "agenda"}
                      onClick={() => setView("agenda")}
                    >
                      <Icon name="list" size={15} />
                      Agenda
                    </button>
                  </div>
                </div>
              </header>
              <div className="week-strip" aria-label="Sample week dates">
                {Array.from({ length: 7 }, (_, i) =>
                  datePlus(
                    datePlus(
                      date,
                      -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7),
                    ),
                    i,
                  ),
                ).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDate(d)}
                    aria-pressed={date === d}
                    aria-label={dateLabel(d)}
                  >
                    <span>{dateLabel(d, { weekday: "short" })}</span>
                    <strong>{dateLabel(d, { day: "2-digit" })}</strong>
                    <span
                      className={`day-dot ${appointmentsFor(d).length ? "" : "closed"}`}
                    />
                  </button>
                ))}
              </div>
              {!filtered.length ? (
                <div className="calendar-empty">
                  <Icon name={search ? "search" : "calendar"} size={32} />
                  <h3>
                    {search ? "No matching appointments" : "A clear calendar"}
                  </h3>
                  <p>
                    {search
                      ? "Try a different name or service."
                      : "There are no sample appointments on this day."}
                  </p>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setDate(SAMPLE_DAY);
                      setSearch("");
                      setBarber("all");
                    }}
                  >
                    Reset calendar
                  </Button>
                </div>
              ) : view === "day" ? (
                <div className="calendar-scroll">
                  <div
                    className="calendar-board"
                    style={
                      {
                        "--columns": visibleStaff.length,
                        minWidth: `${Math.max(280, visibleStaff.length * 155 + 64)}px`,
                      } as React.CSSProperties
                    }
                  >
                    <div className="calendar-staff-header">
                      <div className="timezone-label">
                        BST<span>UTC+1</span>
                      </div>
                      {visibleStaff.map((s) => (
                        <div className="staff-column-heading" key={s.id}>
                          <Avatar initials={s.initials} colour={s.colour} />
                          <div>
                            <strong>{s.name}</strong>
                            <span>
                              {filtered.filter((b) => b.barber === s.id).length}{" "}
                              appointments
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="calendar-timeline">
                      <div className="time-gutter">
                        {Array.from({ length: 10 }, (_, i) => (
                          <span key={i} style={{ top: `${i * 88}px` }}>
                            {time(540 + i * 60)}
                          </span>
                        ))}
                      </div>
                      {visibleStaff.map((s) => (
                        <div className="barber-column" key={s.id}>
                          <div
                            className="lunch-block"
                            style={{
                              top: `${(225 / 60) * 88}px`,
                              height: "66px",
                            }}
                          >
                            <Icon name="clock" size={13} />
                            <span>Lunch break</span>
                          </div>
                          {filtered
                            .filter((b) => b.barber === s.id)
                            .map((b) => (
                              <button
                                key={b.id}
                                className={`calendar-event ${s.colour} ${b.status === "Completed" ? "finished" : ""}`}
                                style={{
                                  top: `${((b.start - 540) / 60) * 88}px`,
                                  height: `${(b.duration / 60) * 88 - 3}px`,
                                }}
                                onClick={() => setSelected(b)}
                                aria-label={`${b.customer}, ${b.service}, ${time(b.start)}, ${b.status}`}
                              >
                                <div className="event-top">
                                  <strong>{b.customer}</strong>
                                  {b.status === "Completed" ? (
                                    <Icon name="checks" size={13} />
                                  ) : b.status === "In chair" ? (
                                    <span className="chair-dot" />
                                  ) : null}
                                </div>
                                <span className="event-sub">{b.service}</span>
                                {b.duration >= 45 && (
                                  <span className="event-time">
                                    {time(b.start)} –{" "}
                                    {time(b.start + b.duration)}
                                    <span>{money(b.price)}</span>
                                  </span>
                                )}
                              </button>
                            ))}
                        </div>
                      ))}
                      {date === SAMPLE_DAY && (
                        <div
                          className="sample-time-line"
                          style={{ top: "132px" }}
                        >
                          <span>10:30</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="agenda-list">
                  {[...filtered]
                    .sort((a, b) => a.start - b.start)
                    .map((b) => (
                      <button
                        className="agenda-row"
                        key={b.id}
                        onClick={() => setSelected(b)}
                      >
                        <strong className="agenda-time">{time(b.start)}</strong>
                        <Avatar
                          initials={b.customer
                            .split(" ")
                            .map((s) => s[0])
                            .join("")}
                        />
                        <span className="agenda-person">
                          <strong>{b.customer}</strong>
                          <span>
                            {b.service} ·{" "}
                            {staff.find((s) => s.id === b.barber)?.name}
                          </span>
                        </span>
                        <Badge tone={b.status === "In chair" ? "active" : ""}>
                          {b.status}
                        </Badge>
                        <strong>{money(b.price)}</strong>
                        <Icon name="right" size={16} />
                      </button>
                    ))}
                </div>
              )}
              <footer className="calendar-footer">
                <span>
                  <i className="legend-dot" />
                  Confirmed
                </span>
                <span>
                  <i className="legend-dot active" />
                  In chair
                </span>
                <span>
                  <Icon name="checks" size={14} />
                  Completed
                </span>
                <span className="calendar-footnote">
                  Fictional schedule · Europe/London · 10-minute buffer
                </span>
              </footer>
            </section>
            <footer className="workspace-footnote">
              <span>
                <Icon name="shield" size={14} />
                Designed around your day. Built with care.
              </span>
              <span>North & Co. is a fictional demo shop.</span>
            </footer>
          </StateEnvelope>
        </main>
      </div>
      {selected && (
        <BookingDetail
          booking={selected}
          date={date}
          onClose={() => setSelected(null)}
        />
      )}
      {panel === "new" && (
        <BookingDraft
          initialDate={date < SAMPLE_DAY ? SAMPLE_DAY : date}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "team" && (
        <Modal title="Meet the sample team" onClose={() => setPanel(null)}>
          <p className="muted">
            Four fictional barbers, one shared workspace. Staff editing and
            invitations connect in the tenant-setup milestone.
          </p>
          <div className="directory-list">
            {staff.map((s) => (
              <article key={s.id}>
                <Avatar initials={s.initials} colour={s.colour} size="large" />
                <div>
                  <h3>{s.name}</h3>
                  <p>{s.role} · 09:00–18:00</p>
                  <span className="muted">{s.description}</span>
                </div>
              </article>
            ))}
          </div>
        </Modal>
      )}
      {panel === "services" && (
        <Modal title="The sample service menu" onClose={() => setPanel(null)}>
          <p className="muted">
            Illustrative prices and durations. Catalogue editing comes with
            persistent shop setup.
          </p>
          <div className="service-menu">
            {services.map((s) => (
              <article key={s.id}>
                <Icon name={s.icon} />
                <div>
                  <h3>{s.name}</h3>
                  <span>
                    {s.duration} minutes · {s.category}
                  </span>
                </div>
                <strong>{money(s.price)}</strong>
              </article>
            ))}
          </div>
          <h3>A little extra</h3>
          {addons.map((a) => (
            <p className="menu-extra" key={a.id}>
              <span>
                {a.name} · {a.duration} min
              </span>
              <strong>+{money(a.price)}</strong>
            </p>
          ))}
        </Modal>
      )}
      {panel === "guide" && (
        <Boundary
          title="Built around a better working day"
          text="This first milestone explores the admin calendar, customer booking and barber workspace. Dates, filters, forms and preview navigation work. All people, availability and amounts are fictional. Secure accounts, persistent bookings, payments, notifications and installable PWA functionality are later milestones."
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}
