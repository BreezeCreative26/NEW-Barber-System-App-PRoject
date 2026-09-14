import { useState } from "react";
import {
  bookings,
  dateLabel,
  money,
  SAMPLE_DAY,
  staff,
  time,
  type Booking,
} from "./fixtures";
import { BookingDetail, BookingDraft } from "./Admin";
import {
  Avatar,
  Badge,
  Boundary,
  Brand,
  Button,
  Icon,
  Modal,
  Notice,
  StateEnvelope,
  type Scenario,
} from "./ui";

function PaymentPreview({
  booking,
  onClose,
}: {
  booking: Booking;
  onClose: () => void;
}) {
  const [tip, setTip] = useState(0);
  const [custom, setCustom] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [method, setMethod] = useState("card");
  const [explained, setExplained] = useState(false);
  const customNumber = Number(customValue);
  const invalidTip =
    custom &&
    (!Number.isFinite(customNumber) ||
      customNumber < 0 ||
      customNumber > 200 ||
      !/^\d*(\.\d{0,2})?$/.test(customValue));
  const tipPence = custom
    ? invalidTip
      ? 0
      : Math.round(customNumber * 100)
    : Math.round((booking.price * tip) / 100);
  return (
    <Modal title="Payment screen preview" onClose={onClose}>
      <div className="payment-person">
        <Avatar
          initials={booking.customer
            .split(" ")
            .map((n) => n[0])
            .join("")}
        />
        <div>
          <strong>{booking.customer}</strong>
          <span>{booking.service}</span>
        </div>
        <Badge tone="neutral">Example only</Badge>
      </div>
      <section className="payment-breakdown">
        <p>
          <span>Service</span>
          <strong>{money(booking.price)}</strong>
        </p>
        <p>
          <span>Sample deposit</span>
          <strong>−{money(booking.deposit)}</strong>
        </p>
        <p className="total">
          <span>Remaining service balance</span>
          <strong>{money(booking.price - booking.deposit)}</strong>
        </p>
      </section>
      <h3>A little thank you</h3>
      <p className="muted">
        Example tips go entirely to the barber before any agreed fee policy.
      </p>
      <div className="tip-chips">
        {[0, 10, 15, 20].map((n) => (
          <button
            key={n}
            aria-pressed={!custom && tip === n}
            onClick={() => {
              setCustom(false);
              setTip(n);
              setExplained(false);
            }}
          >
            {n ? `${n}%` : "No tip"}
          </button>
        ))}
        <button
          aria-pressed={custom}
          onClick={() => {
            setCustom(true);
            setExplained(false);
          }}
        >
          Custom
        </button>
      </div>
      {custom && (
        <label className="custom-tip">
          Custom tip (£)
          <input
            type="number"
            min="0"
            max="200"
            step="0.01"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            aria-invalid={invalidTip}
            aria-describedby={invalidTip ? "tip-error" : undefined}
          />
          {invalidTip && (
            <span id="tip-error" className="field-error">
              Enter a tip between £0 and £200 with at most two decimal places.
            </span>
          )}
        </label>
      )}
      <div className="method-choices">
        <button
          aria-pressed={method === "card"}
          onClick={() => {
            setMethod("card");
            setExplained(false);
          }}
        >
          <Icon name="card" />
          Card reader
        </button>
        <button
          aria-pressed={method === "cash"}
          onClick={() => {
            setMethod("cash");
            setExplained(false);
          }}
        >
          <Icon name="wallet" />
          Cash
        </button>
      </div>
      <div className="summary-total">
        <span>Example amount including tip</span>
        <strong data-testid="payment-total">
          {money(booking.price - booking.deposit + tipPence)}
        </strong>
      </div>
      {explained ? (
        <Notice tone="warning" icon="shield">
          <strong>
            {method === "card"
              ? "No reader or payment account is connected."
              : "No cash receipt has been recorded."}
          </strong>{" "}
          This screen only demonstrates the balance, tip and tender selection.
          No money has moved and the appointment is unchanged.
        </Notice>
      ) : (
        <Notice icon="eye">
          Preview calculator only. The button below explains the next
          integration; it does not collect or record money.
        </Notice>
      )}
      <footer className="modal-footer">
        <Button variant="secondary" onClick={onClose}>
          Close preview
        </Button>
        <Button disabled={invalidTip} onClick={() => setExplained(true)}>
          {method === "card" ? "Explain card step" : "Explain cash step"}
          <Icon name="arrowRight" />
        </Button>
      </footer>
    </Modal>
  );
}

export function Barber({
  scenario,
  setScenario,
}: {
  scenario: Scenario;
  setScenario: (s: Scenario) => void;
}) {
  const [tab, setTab] = useState("today");
  const [filter, setFilter] = useState("Upcoming");
  const [selected, setSelected] = useState<Booking | null>(null);
  const [payment, setPayment] = useState(false);
  const [newBooking, setNewBooking] = useState(false);
  const [boundary, setBoundary] = useState<string | null>(null);
  const jay = staff[0];
  const queue = bookings.filter((b) => b.barber === jay.id);
  const current = queue.find((b) => b.status === "In chair")!;
  const upcoming = queue.filter(
    (b) => b.status !== "Completed" && b.status !== "In chair",
  );
  const shown =
    filter === "All visits"
      ? queue
      : filter === "Completed"
        ? queue.filter((b) => b.status === "Completed")
        : upcoming;
  const earnings = Math.round(queue.reduce((sum, b) => sum + b.price, 0) * 0.7);
  return (
    <div className="barber-app">
      <header className="barber-header">
        <a href="/preview/admin" aria-label="Open admin preview">
          <Brand />
        </a>
        <div className="barber-shop-tag">
          <Icon name="store" size={16} />
          <span>North & Co.</span>
          <span className="barber-header-avatar">
            <Avatar initials={jay.initials} colour={jay.colour} />
          </span>
        </div>
      </header>
      <div
        className="barber-desktop-nav"
        aria-label="Barber workspace sections"
      >
        {[
          ["today", "calendar", "Today"],
          ["earnings", "wallet", "Earnings"],
          ["profile", "user", "Profile"],
        ].map(([id, icon, label]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            <Icon name={icon} />
            {label}
          </button>
        ))}
      </div>
      <main id="main-content" className="barber-main">
        <StateEnvelope
          scenario={scenario}
          onReset={() => setScenario("normal")}
        >
          {tab === "today" && (
            <>
              <div className="barber-greeting">
                <div>
                  <span className="eyebrow">
                    {dateLabel(SAMPLE_DAY).toUpperCase()} · SAMPLE DAY
                  </span>
                  <h1>
                    Morning, Jay<span className="accent-period">.</span>
                  </h1>
                  <p>Good cuts. Good company. Let’s get into it.</p>
                </div>
                <Button variant="secondary" onClick={() => setNewBooking(true)}>
                  <Icon name="plus" />
                  Walk-in preview
                </Button>
              </div>
              <section className="barber-stats" aria-label="Your sample day">
                <article>
                  <span>
                    <Icon name="calendarCheck" />
                    Appointments
                  </span>
                  <strong>
                    {queue.length}
                    <small>on your chair</small>
                  </strong>
                </article>
                <article>
                  <span>
                    <Icon name="wallet" />
                    Expected service sales
                  </span>
                  <strong>
                    {money(queue.reduce((sum, b) => sum + b.price, 0))}
                    <small>sample, not collected</small>
                  </strong>
                </article>
                <article>
                  <span>
                    <Icon name="checks" />
                    Completed
                  </span>
                  <strong>
                    {queue.filter((b) => b.status === "Completed").length}
                    <small>in this fixture</small>
                  </strong>
                </article>
              </section>
              <div className="barber-day-layout">
                <div>
                  <section className="in-chair-card">
                    <div className="in-chair-top">
                      <Badge tone="on-dark">IN YOUR CHAIR</Badge>
                      <span>
                        <Icon name="clock" size={15} />
                        {time(current.start)}–
                        {time(current.start + current.duration)}
                      </span>
                    </div>
                    <div className="current-customer">
                      <Avatar initials="DT" colour="sand" size="large" />
                      <div>
                        <h2>{current.customer}</h2>
                        <p>
                          {current.service} · {current.duration} minutes
                        </p>
                      </div>
                    </div>
                    <div className="current-note">
                      <Icon name="message" size={16} />
                      <span>
                        Prefers a natural finish. <small>Sample note</small>
                      </span>
                    </div>
                    <div className="current-payment">
                      <span>
                        Illustrative remaining balance
                        <strong>
                          {money(current.price - current.deposit)}
                        </strong>
                      </span>
                      <span>
                        Sample deposit<strong>{money(current.deposit)}</strong>
                      </span>
                    </div>
                    <Button
                      className="light-button"
                      onClick={() => setPayment(true)}
                    >
                      Explore payment screen
                      <Icon name="arrowRight" />
                    </Button>
                    <span className="in-chair-disclaimer">
                      Preview only · No payment collected
                    </span>
                  </section>
                  <section className="queue-section">
                    <header className="queue-header">
                      <h2>
                        The rest of your day<span>{upcoming.length}</span>
                      </h2>
                      <button
                        className="text-button"
                        onClick={() => {
                          setFilter("Upcoming");
                          setScenario("normal");
                        }}
                      >
                        <Icon name="refresh" size={14} />
                        Reset view
                      </button>
                    </header>
                    <div className="filter-chips queue-filters">
                      {["Upcoming", "All visits", "Completed"].map((f) => (
                        <button
                          key={f}
                          aria-pressed={filter === f}
                          onClick={() => setFilter(f)}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                    <div className="queue-list">
                      {shown.map((b) => (
                        <button
                          className="queue-row"
                          key={b.id}
                          onClick={() => setSelected(b)}
                        >
                          <span className="queue-time">
                            <strong>{time(b.start)}</strong>
                            <span>{b.duration} min</span>
                          </span>
                          <span className="queue-rule" />
                          <span className="queue-customer">
                            <strong>{b.customer}</strong>
                            <span>{b.service}</span>
                            <Badge
                              tone={b.status === "Completed" ? "neutral" : ""}
                            >
                              {b.source || b.status}
                            </Badge>
                          </span>
                          <span className="queue-price">
                            {money(b.price)}
                            <Icon name="right" size={17} />
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
                <aside className="day-side">
                  <section className="day-note">
                    <span className="eyebrow">A MOMENT TO RESET</span>
                    <div className="break-illustration" aria-hidden="true">
                      <Icon name="clock" size={48} />
                      <span />
                    </div>
                    <h3>Your break is yours.</h3>
                    <p>12:45 – 13:30</p>
                    <span className="muted">
                      A little breathing room between great haircuts.
                    </span>
                  </section>
                  <section className="barber-plan">
                    <Icon name="sparkles" size={22} />
                    <h3>Your day, simplified.</h3>
                    <p>
                      In the finished app, your queue and earnings will stay
                      connected to the shop’s live bookings.
                    </p>
                    <button
                      className="text-button"
                      onClick={() =>
                        setBoundary(
                          "This preview shows the planned daily workflow. Check-in, start-service, completion and no-show actions need authenticated permissions and the persistent booking API. They cannot change appointments here.",
                        )
                      }
                    >
                      What connects next
                      <Icon name="arrowUp" size={15} />
                    </button>
                  </section>
                  <div className="sample-sync">
                    <Icon name="eye" size={14} />
                    Fixture clock: 10:30 BST
                    <br />
                    Not a live or offline-synced queue.
                  </div>
                </aside>
              </div>
            </>
          )}
          {tab === "earnings" && (
            <>
              <div className="barber-greeting">
                <div>
                  <span className="eyebrow">CLARITY IN EVERY CUT</span>
                  <h1>
                    Your earnings<span className="accent-period">.</span>
                  </h1>
                  <p>A considered preview of how your work adds up.</p>
                </div>
              </div>
              <Notice tone="warning">
                Illustrative policy: 30% shop share, 70% barber share, before
                fees. This is not an agreed commission policy or a payable
                balance.
              </Notice>
              <section className="earnings-hero">
                <span>Example service entitlement for this sample day</span>
                <strong>{money(earnings)}</strong>
                <p>
                  Before tips, fees, cash adjustments and eligibility checks.
                </p>
              </section>
              <section className="earnings-list">
                <h2>A clear breakdown</h2>
                {queue.map((b) => (
                  <article key={b.id}>
                    <span>
                      <strong>{b.customer}</strong>
                      <small>
                        {b.service} · {time(b.start)}
                      </small>
                    </span>
                    <span>
                      <strong>{money(Math.round(b.price * 0.7))}</strong>
                      <small>70% example share</small>
                    </span>
                  </article>
                ))}
              </section>
              <Notice icon="wallet">
                <strong>Your shop owner pays you directly.</strong> The future
                app will prepare manual pay-runs and display owner-recorded bank
                payments. It will not hold a wallet or send money automatically.
              </Notice>
              <Button
                variant="secondary"
                onClick={() =>
                  setBoundary(
                    "Manual pay-runs will list eligible earnings, freeze approved totals and record the owner’s external bank payment reference. No actual pay-run, bank account or settlement record exists in this preview.",
                  )
                }
              >
                How manual pay-runs work
                <Icon name="arrowRight" />
              </Button>
            </>
          )}
          {tab === "profile" && (
            <>
              <div className="barber-greeting">
                <div>
                  <span className="eyebrow">THE PERSON BEHIND THE CHAIR</span>
                  <h1>
                    Your profile<span className="accent-period">.</span>
                  </h1>
                  <p>A sample staff profile, not an authenticated account.</p>
                </div>
              </div>
              <section className="profile-card">
                <div className="profile-identity">
                  <Avatar
                    initials={jay.initials}
                    size="huge"
                    colour={jay.colour}
                  />
                  <h2>{jay.name}</h2>
                  <Badge>{jay.role}</Badge>
                  <p>{jay.description}</p>
                </div>
                <dl className="detail-grid">
                  <div>
                    <dt>Shop</dt>
                    <dd>North & Co.</dd>
                  </div>
                  <div>
                    <dt>Location</dt>
                    <dd>Ancoats, Manchester</dd>
                  </div>
                  <div>
                    <dt>Sample hours</dt>
                    <dd>Mon–Sat · 09:00–18:00</dd>
                  </div>
                  <div>
                    <dt>Sample break</dt>
                    <dd>12:45–13:30</dd>
                  </div>
                </dl>
                <Notice>
                  Hours, services and permissions will be managed by the shop
                  owner. Secure staff invitations and identity verification are
                  not connected yet.
                </Notice>
              </section>
            </>
          )}
        </StateEnvelope>
        <footer className="barber-footer">
          <Icon name="shield" size={14} />
          <span>Sample workspace. Your real day comes next.</span>
        </footer>
      </main>
      <nav className="barber-bottom-nav" aria-label="Barber mobile navigation">
        {[
          ["today", "calendar", "Today"],
          ["earnings", "wallet", "Earnings"],
          ["profile", "user", "Profile"],
        ].map(([id, icon, label]) => (
          <button
            key={id}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => {
              setTab(id);
              window.scrollTo({ top: 0, behavior: "instant" });
            }}
          >
            <Icon name={icon} size={22} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      {selected && (
        <BookingDetail
          booking={selected}
          date={SAMPLE_DAY}
          onClose={() => setSelected(null)}
        />
      )}
      {payment && (
        <PaymentPreview booking={current} onClose={() => setPayment(false)} />
      )}
      {newBooking && <BookingDraft onClose={() => setNewBooking(false)} />}
      {boundary && (
        <Boundary
          title="What connects next"
          text={boundary}
          onClose={() => setBoundary(null)}
        />
      )}
    </div>
  );
}
