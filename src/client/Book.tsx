import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  addons,
  dateLabel,
  datePlus,
  money,
  previewSlotReason,
  quote,
  SAMPLE_DAY,
  services,
  staff,
  time,
  validateDetails,
} from "./fixtures";
import {
  Avatar,
  Boundary,
  Brand,
  Button,
  Icon,
  Notice,
  StateEnvelope,
  type Scenario,
} from "./ui";

const steps = ["Service", "Barber", "Date & time", "Your details", "Review"];
export function Book({
  scenario,
  setScenario,
}: {
  scenario: Scenario;
  setScenario: (s: Scenario) => void;
}) {
  const [step, setStep] = useState(0);
  const [service, setService] = useState("cut");
  const [barber, setBarber] = useState("jay");
  const [extraIds, setExtraIds] = useState<string[]>([]);
  const [date, setDate] = useState(SAMPLE_DAY);
  const [slot, setSlot] = useState<number | null>(null);
  const [category, setCategory] = useState("All services");
  const [query, setQuery] = useState("");
  const [daypart, setDaypart] = useState("All times");
  const [details, setDetails] = useState({
    name: "",
    phone: "",
    email: "",
    notes: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [boundary, setBoundary] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const q = quote(service, barber, extraIds);
  const chosenBarber = staff.find((b) => b.id === barber)!;
  const shownServices = services.filter(
    (s) =>
      (category === "All services" ||
        category === s.category ||
        (category === "Popular" && s.popular)) &&
      `${s.name} ${s.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  const availableCount = (d: string) =>
    Array.from({ length: 36 }, (_, i) => 540 + i * 15).filter(
      (m) => !previewSlotReason(d, barber, m, q.duration),
    ).length;
  const times = Array.from({ length: 36 }, (_, i) => 540 + i * 15).filter(
    (m) =>
      daypart === "All times" ||
      (daypart === "Morning" && m < 720) ||
      (daypart === "Afternoon" && m >= 720 && m < 1020) ||
      (daypart === "Evening" && m >= 1020),
  );
  const selectExtra = (id: string) => {
    setExtraIds((ids) =>
      ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id],
    );
    setSlot(null);
  };
  const go = (next: number) => {
    setStep(next);
    requestAnimationFrame(() => {
      heading.current?.focus({ preventScroll: true });
      heading.current?.scrollIntoView({ behavior: "instant", block: "start" });
    });
  };
  useEffect(() => {
    if (slot !== null && previewSlotReason(date, barber, slot, q.duration))
      setSlot(null);
  }, [date, barber, slot, q.duration]);
  const submitDetails = (e: FormEvent) => {
    e.preventDefault();
    const next = validateDetails(details);
    setErrors(next);
    if (Object.keys(next).length)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
    else go(4);
  };
  return (
    <div className="booking-app">
      <header className="shop-header">
        <a
          href="/preview/book"
          className="shop-brand"
          aria-label="North and Co booking home"
        >
          <span className="shop-emblem">
            N<span>&</span>
          </span>
          <div>
            <strong>NORTH & CO.</strong>
            <span>BARBERS OF ANCOATS</span>
          </div>
        </a>
        <div className="shop-header-right">
          <span>
            <Icon name="pin" size={16} />
            Ancoats, Manchester
          </span>
          <a href="/preview/admin" className="powered-by">
            Powered by{" "}
            <strong>
              <img src="/static/brand/ollo-mark.svg" alt="" width={14} height={14} />
              OLLO
            </strong>
          </a>
        </div>
      </header>
      <main id="main-content">
        <section className="booking-hero">
          <div className="hero-copy">
            <span className="eyebrow">GOOD PEOPLE. GREAT HAIRCUTS.</span>
            <h1>
              Look sharp.
              <br />
              Feel like yourself.
            </h1>
            <p>
              A little time in the chair. A fresh start to your day.
              <br className="desktop-only" /> Find your barber and make yourself
              at home.
            </p>
            <div className="hero-details">
              <span>
                <Icon name="scissors" size={16} />4 expert barbers
              </span>
              <span>
                <Icon name="clock" size={16} />
                Mon–Sat, 9am–6pm
              </span>
            </div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-orbit orbit-three" />
            <div className="hero-seal">
              <span>CRAFT OVER CONVENTION</span>
              <strong>
                N<span>&</span>CO.
              </strong>
              <div className="seal-rule" />
              <span>ANCOATS · MANCHESTER</span>
            </div>
            <span className="art-spark one">
              <Icon name="sparkles" size={23} />
            </span>
            <span className="art-spark two">+</span>
          </div>
        </section>
        <div className="booking-body">
          <nav className="booking-progress" aria-label="Booking steps">
            {steps.map((label, i) => (
              <button
                key={label}
                disabled={i > step}
                onClick={() => go(i)}
                aria-current={i === step ? "step" : undefined}
                className={i < step ? "done" : ""}
              >
                <span>
                  {i < step ? <Icon name="check" size={14} /> : i + 1}
                </span>
                <strong>{label}</strong>
                {i < 4 && <i />}
              </button>
            ))}
          </nav>
          <StateEnvelope
            scenario={scenario}
            onReset={() => setScenario("normal")}
          >
            <div className="booking-layout">
              <section className="booking-flow">
                <header className="step-heading">
                  <span className="eyebrow">
                    STEP {String(step + 1).padStart(2, "0")} OF 05
                  </span>
                  <h2 ref={heading} tabIndex={-1}>
                    {
                      [
                        "What are we doing today?",
                        "Find your kind of barber.",
                        "A time that works for you.",
                        "Let’s get to know you.",
                        "Your next good hair day.",
                      ][step]
                    }
                  </h2>
                  <p>
                    {
                      [
                        "Good grooming starts here. Pick your service and make it yours.",
                        "Different styles. The same attention to detail.",
                        "All times are shown in the shop’s timezone: Europe/London.",
                        "Use fictional details for this preview. Nothing is sent or saved.",
                        "Take a moment to check the details. No booking has been made.",
                      ][step]
                    }
                  </p>
                </header>
                {step === 0 && (
                  <>
                    <label className="service-search">
                      <Icon name="search" />
                      <input
                        aria-label="Search services"
                        placeholder="Find your next fresh start…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                    <div
                      className="filter-chips"
                      aria-label="Service categories"
                    >
                      {[
                        "All services",
                        "Popular",
                        "Hair",
                        "Beard",
                        "Packages",
                      ].map((c) => (
                        <button
                          key={c}
                          aria-pressed={category === c}
                          onClick={() => setCategory(c)}
                        >
                          {c === "Popular" && (
                            <Icon name="sparkles" size={14} />
                          )}{" "}
                          {c}
                        </button>
                      ))}
                    </div>
                    <div
                      className="service-cards"
                      role="group"
                      aria-label="Choose a service"
                    >
                      {shownServices.map((s) => (
                        <button
                          key={s.id}
                          className={`service-choice ${service === s.id ? "chosen" : ""}`}
                          aria-pressed={service === s.id}
                          onClick={() => {
                            setService(s.id);
                            setSlot(null);
                          }}
                        >
                          <span className={`service-thumb ${s.id}`}>
                            <Icon name={s.icon} size={25} />
                          </span>
                          <span className="service-copy">
                            <strong>
                              {s.name}
                              {s.popular && (
                                <span className="popular-tag">POPULAR</span>
                              )}
                            </strong>
                            <span>{s.description}</span>
                            <small>
                              <Icon name="clock" size={12} />
                              {s.duration} min
                            </small>
                          </span>
                          <span className="choice-end">
                            <strong>{money(s.price)}</strong>
                            <span className="choice-radio">
                              {service === s.id && (
                                <Icon name="check" size={12} />
                              )}
                            </span>
                          </span>
                        </button>
                      ))}
                      {!shownServices.length && (
                        <div className="inline-empty">
                          <Icon name="search" />
                          <h3>No services found</h3>
                          <p>Try another search or category.</p>
                          <Button
                            variant="secondary"
                            onClick={() => {
                              setQuery("");
                              setCategory("All services");
                            }}
                          >
                            Clear filters
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="addon-heading">
                      <h3>The finishing touches</h3>
                      <span>Optional extras</span>
                    </div>
                    <div className="addons">
                      {addons.map((a) => (
                        <label
                          className={`addon-choice ${extraIds.includes(a.id) ? "chosen" : ""}`}
                          key={a.id}
                        >
                          <input
                            type="checkbox"
                            checked={extraIds.includes(a.id)}
                            onChange={() => selectExtra(a.id)}
                          />
                          <span>
                            <strong>{a.name}</strong>
                            <small>+{a.duration} minutes of you-time</small>
                          </span>
                          <strong>+{money(a.price)}</strong>
                        </label>
                      ))}
                    </div>
                  </>
                )}
                {step === 1 && (
                  <div
                    className="barber-choices"
                    role="group"
                    aria-label="Choose your barber"
                  >
                    {staff.map((b) => (
                      <button
                        className={`barber-choice ${barber === b.id ? "chosen" : ""}`}
                        key={b.id}
                        aria-pressed={barber === b.id}
                        onClick={() => {
                          setBarber(b.id);
                          setSlot(null);
                        }}
                      >
                        <div className={`barber-portrait ${b.colour}`}>
                          <span>{b.initials}</span>
                          <Icon name="scissors" size={38} />
                          <span className="portrait-selected">
                            {barber === b.id ? (
                              <Icon name="check" size={16} />
                            ) : (
                              <Icon name="plus" size={16} />
                            )}
                          </span>
                        </div>
                        <span className="barber-choice-name">
                          <strong>{b.name}</strong>
                          <span>
                            <Icon name="star" size={13} />
                            {b.rating}
                            <small>sample</small>
                          </span>
                        </span>
                        <span className="barber-role">{b.role}</span>
                        <span className="barber-description">
                          {b.description}
                        </span>
                        <span className="barber-rate">
                          {money(quote(service, b.id, extraIds).price)}
                          <span>
                            {b.id === "jay" && service === "fade"
                              ? "Jay’s rate · +£3"
                              : "Service + selected extras"}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {step === 2 && (
                  <>
                    <Notice icon="calendar">
                      Sample week: 14–20 September 2026. Times illustrate the
                      interface only; no live availability or holds.
                    </Notice>
                    <div className="booking-date-toolbar">
                      <h3>September 2026</h3>
                      <div className="small-toggles">
                        <button
                          aria-pressed={date === SAMPLE_DAY}
                          onClick={() => {
                            setDate(SAMPLE_DAY);
                            setSlot(null);
                          }}
                        >
                          Sample today
                        </button>
                        <button
                          aria-pressed={date === datePlus(SAMPLE_DAY, 1)}
                          onClick={() => {
                            setDate(datePlus(SAMPLE_DAY, 1));
                            setSlot(null);
                          }}
                        >
                          Tomorrow
                        </button>
                      </div>
                    </div>
                    <div className="booking-dates" aria-label="Choose date">
                      {Array.from({ length: 7 }, (_, i) =>
                        datePlus(SAMPLE_DAY, i),
                      ).map((d) => (
                        <button
                          key={d}
                          className={date === d ? "chosen" : ""}
                          onClick={() => {
                            setDate(d);
                            setSlot(null);
                          }}
                          aria-pressed={date === d}
                          aria-label={`${dateLabel(d)}, ${availableCount(d)} sample times`}
                        >
                          <span>{dateLabel(d, { weekday: "short" })}</span>
                          <strong>{dateLabel(d, { day: "2-digit" })}</strong>
                          <small>
                            {availableCount(d)
                              ? `${availableCount(d)} slots`
                              : "Closed"}
                          </small>
                        </button>
                      ))}
                    </div>
                    <div className="slot-heading">
                      <h3>Pick your time</h3>
                      <span>
                        <span className="available-dot" />
                        Sample availability
                      </span>
                    </div>
                    <div className="filter-chips dayparts">
                      {["All times", "Morning", "Afternoon", "Evening"].map(
                        (d) => (
                          <button
                            key={d}
                            aria-pressed={daypart === d}
                            onClick={() => setDaypart(d)}
                          >
                            {d}
                          </button>
                        ),
                      )}
                    </div>
                    <div
                      className="time-slots"
                      role="group"
                      aria-label="Choose a sample appointment time"
                    >
                      {times.map((m) => {
                        const reason = previewSlotReason(
                          date,
                          barber,
                          m,
                          q.duration,
                        );
                        return (
                          <button
                            key={m}
                            disabled={!!reason}
                            title={reason || `${q.duration}-minute appointment`}
                            aria-label={`${time(m)}${reason ? `, ${reason}` : ", available sample time"}`}
                            aria-pressed={slot === m}
                            onClick={() => setSlot(m)}
                            className={slot === m ? "chosen" : ""}
                          >
                            {time(m)}
                            {slot === m && <Icon name="check" size={14} />}
                          </button>
                        );
                      })}
                    </div>
                    {!availableCount(date) && (
                      <Notice icon="calendar" tone="warning">
                        No sample slots on this date. Try another day.
                      </Notice>
                    )}
                    <p className="slot-note">
                      <Icon name="clock" size={14} />
                      {q.duration} minutes, with a 10-minute buffer between
                      visits.
                    </p>
                  </>
                )}
                {step === 3 && (
                  <form
                    id="customer-details"
                    noValidate
                    onSubmit={submitDetails}
                  >
                    <div className="customer-fields">
                      {[
                        {
                          id: "name",
                          label: "Your name",
                          placeholder: "Jamie Taylor",
                          type: "text",
                        },
                        {
                          id: "phone",
                          label: "Mobile number",
                          placeholder: "07700 900123",
                          type: "tel",
                        },
                        {
                          id: "email",
                          label: "Email address (optional)",
                          placeholder: "jamie@example.com",
                          type: "email",
                        },
                      ].map((field) => (
                        <label key={field.id}>
                          <span id={`booking-${field.id}-label`}>
                            {field.label}
                          </span>
                          <input
                            aria-labelledby={`booking-${field.id}-label`}
                            required={field.id !== "email"}
                            type={field.type}
                            value={details[field.id as keyof typeof details]}
                            autoComplete="off"
                            placeholder={field.placeholder}
                            onChange={(e) => {
                              setDetails((d) => ({
                                ...d,
                                [field.id]: e.target.value,
                              }));
                              setErrors((current) => ({
                                ...current,
                                [field.id]: "",
                              }));
                            }}
                            aria-invalid={!!errors[field.id]}
                            aria-describedby={
                              errors[field.id]
                                ? `booking-${field.id}-error`
                                : undefined
                            }
                          />
                          {errors[field.id] && (
                            <span
                              className="field-error"
                              id={`booking-${field.id}-error`}
                            >
                              {errors[field.id]}
                            </span>
                          )}
                        </label>
                      ))}
                      <label>
                        Anything you’d like us to know? (optional)
                        <textarea
                          value={details.notes}
                          maxLength={500}
                          placeholder="For the preview, please don’t enter sensitive information."
                          onChange={(e) =>
                            setDetails((d) => ({ ...d, notes: e.target.value }))
                          }
                        />
                        <span className="field-help">
                          {details.notes.length}/500 characters · Preview only
                        </span>
                      </label>
                    </div>
                    <Notice icon="shield">
                      Your details stay in this page’s temporary state.
                      Refreshing or leaving clears them.
                    </Notice>
                  </form>
                )}
                {step === 4 && (
                  <>
                    <div className="review-appointment">
                      <div className="review-icon">
                        <Icon name="calendarCheck" size={32} />
                      </div>
                      <span className="eyebrow">APPOINTMENT PREVIEW</span>
                      <h3>{dateLabel(date)}</h3>
                      <p>
                        {slot !== null ? time(slot) : "No time selected"} ·{" "}
                        {q.duration} minutes · Europe/London
                      </p>
                      <div className="review-barber">
                        <Avatar
                          initials={chosenBarber.initials}
                          colour={chosenBarber.colour}
                        />
                        <span>
                          {q.service.name} with{" "}
                          <strong>{chosenBarber.name.split(" ")[0]}</strong>
                        </span>
                      </div>
                    </div>
                    <section className="review-customer">
                      <div>
                        <h3>Your details</h3>
                        <Button variant="ghost" onClick={() => go(3)}>
                          Edit
                          <Icon name="arrowUp" size={14} />
                        </Button>
                      </div>
                      <strong>{details.name}</strong>
                      <p>
                        {details.phone}
                        {details.email && ` · ${details.email}`}
                      </p>
                      {details.notes && <p>{details.notes}</p>}
                    </section>
                    <label className="consent-control">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      <span>
                        <strong>Save my card for next time</strong>
                        <small>
                          Example preference only. No card is collected and no
                          consent is saved.
                        </small>
                      </span>
                    </label>
                    <Notice tone="warning" icon="card">
                      <strong>Payments are not connected.</strong> No
                      appointment has been created. The next milestone will
                      securely collect the deposit into the shop’s Stripe
                      account.
                    </Notice>
                  </>
                )}
                <footer className="booking-actions">
                  {step === 0 && (
                    <span className="mobile-checkout-total">
                      <strong>{money(q.price)}</strong>
                      <small>Example total</small>
                    </span>
                  )}
                  {step > 0 ? (
                    <Button variant="secondary" onClick={() => go(step - 1)}>
                      <Icon name="arrowLeft" />
                      Back
                    </Button>
                  ) : (
                    <span className="secure-note">
                      <Icon name="shield" size={15} />A little care in every
                      detail
                    </span>
                  )}
                  {step === 3 ? (
                    <Button type="submit" form="customer-details">
                      Review appointment
                      <Icon name="arrowRight" />
                    </Button>
                  ) : step === 4 ? (
                    <Button onClick={() => setBoundary(true)}>
                      View payment next step
                      <Icon name="arrowRight" />
                    </Button>
                  ) : (
                    <Button
                      disabled={step === 2 && slot === null}
                      onClick={() => go(step + 1)}
                    >
                      {
                        ["Choose your barber", "Find a time", "Your details"][
                          step
                        ]
                      }
                      <Icon name="arrowRight" />
                    </Button>
                  )}
                </footer>
                {step === 2 && slot === null && (
                  <p className="field-help">
                    Select an available sample time to continue.
                  </p>
                )}
              </section>
              <aside
                className="booking-summary"
                aria-label="Your visit summary"
              >
                <div className="summary-shop">
                  <span className="mini-shop-emblem">N&</span>
                  <div>
                    <strong>Your time, well spent.</strong>
                    <span>North & Co. · Ancoats</span>
                  </div>
                </div>
                <h3>Your visit</h3>
                <div className="summary-service">
                  <span className="summary-service-icon">
                    <Icon name={q.service.icon} size={23} />
                  </span>
                  <div>
                    <strong>{q.service.name}</strong>
                    <span>
                      {q.service.duration} minutes
                      {q.override ? " · Jay’s rate" : ""}
                    </span>
                  </div>
                  <strong>{money(q.service.price + q.override)}</strong>
                </div>
                {q.extras.map((a) => (
                  <p className="summary-addon" key={a.id}>
                    <span>
                      <Icon name="plus" size={12} />
                      {a.name}
                    </span>
                    <strong>{money(a.price)}</strong>
                  </p>
                ))}
                <div className="summary-appointment">
                  <p>
                    <Icon name="user" />
                    <span>
                      {step >= 1 ? chosenBarber.name : "Choose your barber"}
                    </span>
                  </p>
                  <p>
                    <Icon name="calendar" />
                    <span>
                      {slot !== null
                        ? `${dateLabel(date, { weekday: "short", day: "numeric", month: "short" })} · ${time(slot)}`
                        : "Choose your date & time"}
                    </span>
                  </p>
                  <p>
                    <Icon name="clock" />
                    <span>{q.duration} minutes of a fresh start</span>
                  </p>
                </div>
                <div className="summary-price">
                  <p>
                    <span>Total</span>
                    <strong>{money(q.price)}</strong>
                  </p>
                  <p className="deposit-line">
                    <span>
                      Deposit due today<small>Example policy</small>
                    </span>
                    <strong>{money(q.deposit)}</strong>
                  </p>
                  <p className="remaining-line">
                    <span>Remaining in the shop</span>
                    <strong>{money(q.price - q.deposit)}</strong>
                  </p>
                </div>
                <div className="cancellation-note">
                  <Icon name="shield" size={19} />
                  <p>
                    <strong>Plans change. We get it.</strong>Example policy:
                    cancel at least 24 hours ahead for a deposit refund. Contact
                    the shop to make a change.
                  </p>
                </div>
                <div className="preview-summary-note">
                  <Icon name="eye" size={14} />
                  Preview prices · no charge or reservation
                </div>
              </aside>
            </div>
          </StateEnvelope>
          <footer className="booking-footer">
            <Brand />
            <span>Good hair. Good company.</span>
            <span>Fictional shop · Design preview</span>
          </footer>
        </div>
      </main>
      {boundary && (
        <Boundary
          title="Secure checkout comes next"
          text={`Your example visit totals ${money(q.price)}, with ${money(q.deposit)} as a part-payment and ${money(q.price - q.deposit)} remaining at the shop. Stripe is not connected, so this preview cannot collect a card, hold a slot or create a booking. Your form remains available when you close this message.`}
          onClose={() => setBoundary(false)}
        />
      )}
    </div>
  );
}
