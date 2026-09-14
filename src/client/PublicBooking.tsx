import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BookingItem } from "../server/domain";
import { dateLabel, datePlus, money, time } from "./fixtures";
import { Avatar, Brand, Button, Icon, Notice } from "./ui";

// Connected customer booking for /book/:slug and /manage/:token.
// Reads and writes the same local D1 records as the owner workspace.
type PublicShop = {
  shop: {
    id: string;
    name: string;
    address: string;
    slug: string;
    timezone: string;
    opens: number;
    closes: number;
    closed_days: number[];
    deposit_pence: number;
    cancel_hours: number;
    lead_time_min: number;
    booking_window_days: number;
    version: number;
  };
  staff: { id: string; name: string; role: string }[];
  services: {
    id: string;
    name: string;
    category: string;
    duration_min: number;
    price_pence: number;
    version: number;
  }[];
  addons: { id: string; name: string; price_pence: number; duration_min: number }[];
  addon_links: { addon_id: string; service_id: string }[];
  service_rules: {
    staff_id: string;
    service_id: string;
    enabled: number;
    price_pence: number | null;
    duration_min: number | null;
  }[];
  hours: { staff_id: string; weekday: number; enabled: number }[];
  today: string;
  max_date: string;
};
type Slot = {
  start_min: number;
  available: boolean;
  reason: string;
  staff_id?: string;
  staff_name?: string;
  barbers?: number;
  price_pence?: number;
  duration_min?: number;
};
type Availability = {
  slots: Slot[];
  duration_min: number;
  price_pence: number;
  items: BookingItem[];
  overridden: boolean;
  any_barber?: boolean;
  deposit_policy_pence: number;
  cancel_hours: number;
  quote: { service_version: number; shop_version: number };
};
type DaySummary = { date: string; available: number; closed: boolean; beyond: boolean };
type CustomerBooking = {
  id: string;
  reference: string;
  status: string;
  date: string;
  start_min: number;
  start_at: number;
  end_at: number;
  duration_min: number;
  service_name: string;
  items: BookingItem[];
  price_pence: number;
  deposit_policy_pence: number;
  cancel_hours: number;
  customer_name: string;
  phone: string;
  email: string;
  notes: string;
  staff_name: string | null;
  version: number;
  shop: { name: string; address: string; slug: string | null; timezone: string };
  can_manage: boolean;
  late_change: boolean;
};
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code = "",
  ) {
    super(message);
  }
}
const friendly: Record<string, string> = {
  slot_taken: "That time has just been taken. Choose another available time; your details are kept.",
  quote_changed: "The shop updated its prices or policy. Review the refreshed total before confirming.",
  outside_booking_window: "That date is outside the shop’s online booking window.",
  service_ineligible: "This barber does not offer the selected service.",
  service_unavailable: "This service is no longer available online.",
  addon_unavailable: "An extra is no longer available. Remove it and review again.",
  record_changed: "This booking changed elsewhere. Reload to see the latest details.",
  invalid_transition: "This booking can no longer be changed online.",
  idempotency_payload_changed: "This request was already used for a different booking. Refresh and try again.",
};
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  if (!navigator.onLine)
    throw new ApiError("You are offline. Reconnect and try again.", 0);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/public${path}`, {
      method,
      credentials: "same-origin",
      signal: controller.signal,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new ApiError("Unexpected response from the shop. Try again.", response.status);
    const result = await response.json();
    if (!response.ok)
      throw new ApiError(
        friendly[result.error] || result.message || "Request failed. Try again.",
        response.status,
        result.error,
      );
    return result;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(
      method === "GET"
        ? "Unable to reach the shop right now. Check your connection and try again."
        : "The response was interrupted. Your details are kept; confirming again is safe and will not create a duplicate.",
      0,
    );
  } finally {
    window.clearTimeout(timeout);
  }
}
const initials = (name: string) =>
  name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
const colours = ["sage", "sand", "blue", "clay"];
const thumbs = ["", "fade", "beard", "combo", "junior"];
const phoneOk = (s: string) => /^(?:\+44|0)7\d{9}$/.test(s.replace(/[\s()-]/g, ""));
const emailOk = (s: string) => !s || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

const gcal = (b: { start_at: number; end_at: number; service_name: string; shop: { name: string; address: string } }) => {
  const f = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: `${b.service_name} at ${b.shop.name}`,
    dates: `${f(b.start_at)}/${f(b.end_at)}`,
    location: b.shop.address || b.shop.name,
    details: "Booked with Barbershop OS. Local test booking.",
  });
  return `https://calendar.google.com/calendar/render?${q}`;
};
const mapsUrl = (address: string) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
function ShopHeader({ name, address }: { name: string; address: string }) {
  return (
    <header className="shop-header">
      <span className="shop-brand">
        <span className="shop-emblem">{initials(name)}</span>
        <div>
          <strong>{name.toUpperCase()}</strong>
          <span>{address || "ONLINE BOOKING"}</span>
        </div>
      </span>
      <div className="shop-header-right">
        {address && (
          <span>
            <Icon name="pin" size={16} />
            {address}
          </span>
        )}
        <span className="powered-by">
          Powered by{" "}
          <strong>
            barbershop<span>OS</span>
          </strong>
        </span>
      </div>
    </header>
  );
}
function TestBanner() {
  return (
    <div className="workspace-banner public-banner">
      <span>
        <strong>LOCAL TEST BOOKING</strong> · Fictional details only
      </span>
      <span>No payment or message is sent</span>
    </div>
  );
}

const steps = ["Service", "Barber", "Date & time", "Your details", "Review"];
type NextSlot = {
  date: string;
  start_min: number;
  staff_id: string;
  staff_name: string;
  price_pence: number;
  duration_min: number;
};
const ANY = "any";
export function PublicBooking({ slug }: { slug: string }) {
  const [shop, setShop] = useState<PublicShop | null>(null);
  const [loadError, setLoadError] = useState("");
  const [step, setStep] = useState(0);
  const [service, setService] = useState("");
  const [barber, setBarber] = useState("");
  const [extraIds, setExtraIds] = useState<string[]>([]);
  const [category, setCategory] = useState("All services");
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [date, setDate] = useState("");
  const [days, setDays] = useState<DaySummary[] | null>(null);
  const [next, setNext] = useState<NextSlot[] | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [slotError, setSlotError] = useState("");
  const [slot, setSlot] = useState<number | null>(null);
  const [assigned, setAssigned] = useState<{ id: string; name: string } | null>(null);
  const [daypart, setDaypart] = useState("All times");
  const [details, setDetails] = useState({ name: "", phone: "", email: "", notes: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [waitlist, setWaitlist] = useState<"idle" | "open" | "done">("idle");
  const [waitDaypart, setWaitDaypart] = useState("ANY");
  const [confirmed, setConfirmed] = useState<{
    booking: CustomerBooking;
    manage_token: string | null;
  } | null>(null);
  const request = useRef({ key: crypto.randomUUID(), payload: "" });
  const heading = useRef<HTMLHeadingElement>(null);
  const load = async () => {
    setLoadError("");
    try {
      const s = await api<PublicShop>(`/shops/${encodeURIComponent(slug)}`);
      setShop(s);
      setFrom((f) => f || s.today);
      setDate((d) => d || s.today);
      setService((v) => v || s.services[0]?.id || "");
      setBarber((b) => b || (s.staff.length > 1 ? ANY : s.staff[0]?.id || ""));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this shop.");
    }
  };
  useEffect(() => {
    load();
  }, [slug]);
  useEffect(() => {
    // Remember contact details on this device only; nothing is sent anywhere.
    try {
      const saved = localStorage.getItem("barbershop-os:customer");
      if (saved) setDetails((d) => ({ ...d, ...JSON.parse(saved), notes: "" }));
    } catch {
      /* private mode */
    }
  }, []);
  const eligible = (staffId: string, serviceId: string) =>
    !shop?.service_rules.some(
      (r) => r.staff_id === staffId && r.service_id === serviceId && !r.enabled,
    );
  const barbers = shop?.staff.filter((s) => eligible(s.id, service)) || [];
  useEffect(() => {
    if (!shop) return;
    if (barber && barber !== ANY && !eligible(barber, service)) setBarber(barbers.length > 1 ? ANY : barbers[0]?.id || "");
    if (barber === ANY && barbers.length === 1) setBarber(barbers[0].id);
  }, [service, shop]);
  const anyBarber = barber === ANY;
  const chosenService = shop?.services.find((s) => s.id === service);
  const chosenBarber = shop?.staff.find((b) => b.id === barber);
  const serviceAddons =
    shop?.addons.filter((a) =>
      shop.addon_links.some((l) => l.addon_id === a.id && l.service_id === service),
    ) || [];
  useEffect(() => {
    setExtraIds((ids) => ids.filter((id) => serviceAddons.some((a) => a.id === id)));
  }, [service]);
  const estimate = (staffId: string) => {
    if (!chosenService) return { price: 0, duration: 0, overridden: false };
    const rule = shop?.service_rules.find(
      (r) => r.staff_id === staffId && r.service_id === service,
    );
    const extras = serviceAddons.filter((a) => extraIds.includes(a.id));
    return {
      price:
        (rule?.price_pence ?? chosenService.price_pence) +
        extras.reduce((n, a) => n + a.price_pence, 0),
      duration:
        (rule?.duration_min ?? chosenService.duration_min) +
        extras.reduce((n, a) => n + a.duration_min, 0),
      overridden: rule?.price_pence != null || rule?.duration_min != null,
    };
  };
  const anyEstimate = () => {
    const list = barbers.map((b) => estimate(b.id));
    if (!list.length) return { price: 0, priceTo: 0, duration: 0 };
    return {
      price: Math.min(...list.map((e) => e.price)),
      priceTo: Math.max(...list.map((e) => e.price)),
      duration: Math.min(...list.map((e) => e.duration)),
    };
  };
  const addonQuery = extraIds.length ? `&addon_ids=${[...extraIds].sort().join(",")}` : "";
  const quoteKey = `${barber}|${service}|${[...extraIds].sort().join(",")}`;
  useEffect(() => {
    if (!shop || !barber || !service || step !== 2) return;
    let cancelled = false;
    setDays(null);
    api<{ days: DaySummary[] }>(
      `/shops/${encodeURIComponent(slug)}/days?staff_id=${barber}&service_id=${service}&from=${from}${addonQuery}`,
    )
      .then((r) => !cancelled && setDays(r.days))
      .catch(() => !cancelled && setDays([]));
    return () => {
      cancelled = true;
    };
  }, [quoteKey, from, step, shop]);
  useEffect(() => {
    if (!shop || !barber || !service || step !== 2) return;
    let cancelled = false;
    setNext(null);
    api<{ next: NextSlot[] }>(
      `/shops/${encodeURIComponent(slug)}/next?staff_id=${barber}&service_id=${service}&limit=4${addonQuery}`,
    )
      .then((r) => !cancelled && setNext(r.next))
      .catch(() => !cancelled && setNext([]));
    return () => {
      cancelled = true;
    };
  }, [quoteKey, step, shop]);
  useEffect(() => {
    if (!shop || !barber || !service || !date || step !== 2) return;
    let cancelled = false;
    setAvailability(null);
    setSlotError("");
    setWaitlist("idle");
    api<Availability>(
      `/shops/${encodeURIComponent(slug)}/availability?date=${date}&staff_id=${barber}&service_id=${service}${addonQuery}`,
    )
      .then((r) => {
        if (cancelled) return;
        setAvailability(r);
        setSlot((s) => {
          const keep = s !== null ? r.slots.find((x) => x.start_min === s && x.available) : null;
          setAssigned(keep?.staff_id ? { id: keep.staff_id, name: keep.staff_name! } : null);
          return keep ? s : null;
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setAvailability(null);
        setSlotError(e instanceof Error ? e.message : "Could not load times.");
      });
    return () => {
      cancelled = true;
    };
  }, [quoteKey, date, step, shop]);
  const go = (next: number) => {
    setStep(next);
    setSaveError("");
    requestAnimationFrame(() => {
      heading.current?.focus({ preventScroll: true });
      heading.current?.scrollIntoView({ behavior: "instant", block: "start" });
    });
  };
  const pickSlot = (s: Slot) => {
    setSlot(s.start_min);
    setAssigned(s.staff_id ? { id: s.staff_id, name: s.staff_name! } : null);
  };
  const jumpTo = (n: NextSlot) => {
    setFrom(n.date < from || n.date > datePlus(from, 6) ? n.date : from);
    setDate(n.date);
    setSlot(n.start_min);
    setAssigned({ id: n.staff_id, name: n.staff_name });
  };
  const submitDetails = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (details.name.trim().length < 2) next.name = "Enter your name";
    if (!phoneOk(details.phone)) next.phone = "Enter a valid UK mobile number";
    if (!emailOk(details.email)) next.email = "Enter a valid email address";
    setErrors(next);
    if (Object.keys(next).length)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
    else go(4);
  };
  const bookingStaff = anyBarber ? assigned?.id || "" : barber;
  const bookingStaffName = anyBarber ? assigned?.name : chosenBarber?.name;
  async function confirm() {
    if (!availability || slot === null || busy || !bookingStaff) return;
    const payload = {
      staff_id: bookingStaff,
      service_id: service,
      customer_name: details.name.trim(),
      phone: details.phone,
      email: details.email.trim(),
      notes: details.notes.trim(),
      date,
      start_min: slot,
      addon_ids: [...extraIds].sort(),
      quote: availability.quote,
    };
    const serialised = JSON.stringify(payload);
    // A changed payload gets a fresh request key; an unchanged retry replays safely.
    if (request.current.payload !== serialised)
      request.current = { key: crypto.randomUUID(), payload: serialised };
    setBusy(true);
    setSaveError("");
    try {
      const r = await api<{ booking: CustomerBooking; manage_token: string | null }>(
        `/shops/${encodeURIComponent(slug)}/bookings`,
        "POST",
        { request_id: request.current.key, ...payload },
      );
      try {
        localStorage.setItem(
          "barbershop-os:customer",
          JSON.stringify({ name: details.name.trim(), phone: details.phone, email: details.email.trim() }),
        );
      } catch {
        /* ignore */
      }
      setConfirmed(r);
    } catch (e) {
      const err = e as ApiError;
      setSaveError(err.message);
      if (["slot_taken", "quote_changed", "outside_booking_window"].includes(err.code)) {
        setSlot(null);
        go(2);
      }
    } finally {
      setBusy(false);
    }
  }
  async function joinWaitlist(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") || "").trim(),
      phone = String(f.get("phone") || "");
    const nextErrors: Record<string, string> = {};
    if (name.length < 2) nextErrors.wname = "Enter your name";
    if (!phoneOk(phone)) nextErrors.wphone = "Enter a valid UK mobile number";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setBusy(true);
    setSaveError("");
    try {
      await api(`/shops/${encodeURIComponent(slug)}/waitlist`, "POST", {
        staff_id: anyBarber ? null : barber,
        service_id: service,
        customer_name: name,
        phone,
        email: String(f.get("email") || "").trim(),
        date,
        daypart: waitDaypart,
        notes: "",
      });
      setDetails((d) => ({ ...d, name, phone }));
      setWaitlist("done");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not join the waitlist.");
    } finally {
      setBusy(false);
    }
  }
  if (loadError)
    return (
      <div className="booking-app">
        <TestBanner />
        <main className="state-card">
          <h1>Online booking is not available</h1>
          <p>{loadError}</p>
          <Button onClick={load}>Try again</Button>
        </main>
      </div>
    );
  if (!shop)
    return (
      <div className="booking-app">
        <TestBanner />
        <p className="boot-message" role="status">
          Loading shop…
        </p>
      </div>
    );
  if (confirmed)
    return (
      <div className="booking-app">
        <TestBanner />
        <ShopHeader name={shop.shop.name} address={shop.shop.address} />
        <main id="main-content" className="booking-body">
          <ConfirmationCard booking={confirmed.booking} token={confirmed.manage_token} slug={slug} />
        </main>
      </div>
    );
  const categories = ["All services", ...new Set(shop.services.map((s) => s.category))];
  const shownServices = shop.services.filter(
    (s) =>
      (category === "All services" || s.category === category) &&
      `${s.name} ${s.category}`.toLowerCase().includes(query.toLowerCase()),
  );
  const est = anyBarber ? { ...anyEstimate(), overridden: false } : { ...estimate(barber), priceTo: estimate(barber).price };
  const chosenSlot = availability?.slots.find((x) => x.start_min === slot && x.available);
  const price = chosenSlot?.price_pence ?? (anyBarber ? est.price : availability?.price_pence ?? est.price);
  const priceTo = chosenSlot?.price_pence ?? (anyBarber ? est.priceTo : price);
  const duration = chosenSlot?.duration_min ?? availability?.duration_min ?? est.duration;
  const deposit = Math.min(shop.shop.deposit_pence, price);
  const priceLabel = price === priceTo ? money(price) : `${money(price)}–${money(priceTo)}`;
  const openSlots = (availability?.slots || []).filter((s) => s.available);
  const inDaypart = (m: number, part: string) =>
    part === "All times" ||
    (part === "Morning" && m < 720) ||
    (part === "Afternoon" && m >= 720 && m < 1020) ||
    (part === "Evening" && m >= 1020);
  const groups = (["Morning", "Afternoon", "Evening"] as const)
    .filter((g) => daypart === "All times" || daypart === g)
    .map((g) => ({ label: g, slots: openSlots.filter((s) => inDaypart(s.start_min, g)) }))
    .filter((g) => g.slots.length);
  const openCount = openSlots.length;
  const weekDays = Array.from({ length: 7 }, (_, i) => datePlus(from, i));
  const dayInfo = (d: string) => days?.find((x) => x.date === d);
  const dayFull = !!availability && openCount === 0 && !!dayInfo(date) && !dayInfo(date)!.closed;
  const nextElsewhere = next?.filter((n) => n.date !== date) || [];
  return (
    <div className="booking-app">
      <TestBanner />
      <ShopHeader name={shop.shop.name} address={shop.shop.address} />
      <main id="main-content">
        <section className="booking-hero public-hero">
          <div className="hero-copy">
            <span className="eyebrow">BOOK ONLINE</span>
            <h1>
              Look sharp.
              <br />
              Feel like yourself.
            </h1>
            <p>
              Choose your service, your barber and a time that suits you.
              <br className="desktop-only" /> Prices and availability are the shop’s
              live records.
            </p>
            <div className="hero-details">
              <span>
                <Icon name="scissors" size={16} />
                {shop.staff.length} barber{shop.staff.length === 1 ? "" : "s"}
              </span>
              <span>
                <Icon name="clock" size={16} />
                {time(shop.shop.opens)}–{time(shop.shop.closes)} · {shop.shop.timezone}
              </span>
              {shop.shop.address && (
                <a
                  className="hero-link"
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(shop.shop.address)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon name="pin" size={16} />
                  Directions
                </a>
              )}
            </div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-orbit orbit-three" />
            <div className="hero-seal">
              <span>BOOK IN SECONDS</span>
              <strong>{initials(shop.shop.name)}</strong>
              <div className="seal-rule" />
              <span>{shop.shop.name.toUpperCase().slice(0, 24)}</span>
            </div>
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
                <span>{i < step ? <Icon name="check" size={14} /> : i + 1}</span>
                <strong>{label}</strong>
                {i < 4 && <i />}
              </button>
            ))}
          </nav>
          <div className="booking-layout">
            <section className="booking-flow">
              <header className="step-heading">
                <span className="eyebrow">STEP {String(step + 1).padStart(2, "0")} OF 05</span>
                <h2 ref={heading} tabIndex={-1}>
                  {
                    [
                      "What are we doing today?",
                      "Find your kind of barber.",
                      "A time that works for you.",
                      "Let’s get to know you.",
                      "Check and confirm.",
                    ][step]
                  }
                </h2>
                <p>
                  {
                    [
                      "Pick your service and any extras.",
                      "Choose a barber, or let us find the first free chair.",
                      `Times are shown in ${shop.shop.timezone}. Online bookings need at least ${shop.shop.lead_time_min} minutes’ notice.`,
                      "Use fictional details for this local test. Nothing is sent.",
                      "Review your visit. Confirming saves it to the shop’s diary; no payment is taken.",
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
                      placeholder="Search services…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  {categories.length > 2 && (
                    <div className="filter-chips" role="group" aria-label="Service categories">
                      {categories.map((c) => (
                        <button key={c} aria-pressed={category === c} onClick={() => setCategory(c)}>
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="service-cards" role="group" aria-label="Choose a service">
                    {shownServices.map((s, i) => (
                      <button
                        key={s.id}
                        className={`service-choice ${service === s.id ? "chosen" : ""}`}
                        aria-pressed={service === s.id}
                        onClick={() => {
                          setService(s.id);
                          setSlot(null);
                        }}
                      >
                        <span className={`service-thumb ${thumbs[i % thumbs.length]}`}>
                          <Icon name="scissors" size={25} />
                        </span>
                        <span className="service-copy">
                          <strong>{s.name}</strong>
                          <span>{s.category}</span>
                          <small>
                            <Icon name="clock" size={12} />
                            {s.duration_min} min
                          </small>
                        </span>
                        <span className="choice-end">
                          <strong>{money(s.price_pence)}</strong>
                          <span className="choice-radio">
                            {service === s.id && <Icon name="check" size={12} />}
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
                  {serviceAddons.length > 0 && (
                    <>
                      <div className="addon-heading">
                        <h3>The finishing touches</h3>
                        <span>Optional extras</span>
                      </div>
                      <div className="addons">
                        {serviceAddons.map((a) => (
                          <label
                            className={`addon-choice ${extraIds.includes(a.id) ? "chosen" : ""}`}
                            key={a.id}
                          >
                            <input
                              type="checkbox"
                              checked={extraIds.includes(a.id)}
                              onChange={() => {
                                setExtraIds((ids) =>
                                  ids.includes(a.id) ? ids.filter((v) => v !== a.id) : [...ids, a.id],
                                );
                                setSlot(null);
                              }}
                            />
                            <span>
                              <strong>{a.name}</strong>
                              <small>+{a.duration_min} minutes</small>
                            </span>
                            <strong>+{money(a.price_pence)}</strong>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
              {step === 1 && (
                <div className="barber-choices" role="group" aria-label="Choose your barber">
                  {barbers.length > 1 && (
                    <button
                      className={`barber-choice any-barber ${anyBarber ? "chosen" : ""}`}
                      aria-pressed={anyBarber}
                      onClick={() => {
                        setBarber(ANY);
                        setSlot(null);
                      }}
                    >
                      <div className="barber-portrait forest">
                        <span className="any-mark">
                          <Icon name="sparkles" size={30} />
                        </span>
                        <span className="portrait-selected">
                          <Icon name={anyBarber ? "check" : "plus"} size={16} />
                        </span>
                      </div>
                      <span className="barber-choice-name">
                        <strong>First available</strong>
                      </span>
                      <span className="barber-role">Any of {barbers.length} barbers</span>
                      <span className="barber-description">
                        See every open time. We’ll assign whoever is free.
                      </span>
                      <span className="barber-rate">
                        {(() => {
                          const e = anyEstimate();
                          return e.price === e.priceTo ? money(e.price) : `${money(e.price)}–${money(e.priceTo)}`;
                        })()}
                        <span>Most choice · from {anyEstimate().duration} min</span>
                      </span>
                    </button>
                  )}
                  {barbers.map((b, i) => {
                    const e = estimate(b.id);
                    return (
                      <button
                        className={`barber-choice ${barber === b.id ? "chosen" : ""}`}
                        key={b.id}
                        aria-pressed={barber === b.id}
                        onClick={() => {
                          setBarber(b.id);
                          setSlot(null);
                        }}
                      >
                        <div className={`barber-portrait ${colours[i % colours.length]}`}>
                          <span>{initials(b.name)}</span>
                          <Icon name="scissors" size={38} />
                          <span className="portrait-selected">
                            <Icon name={barber === b.id ? "check" : "plus"} size={16} />
                          </span>
                        </div>
                        <span className="barber-choice-name">
                          <strong>{b.name}</strong>
                        </span>
                        <span className="barber-role">{b.role}</span>
                        <span className="barber-rate">
                          {money(e.price)}
                          <span>
                            {e.overridden ? `${b.name.split(" ")[0]}’s rate` : "Service + extras"} ·{" "}
                            {e.duration} min
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {!barbers.length && (
                    <Notice tone="warning" icon="users">
                      No barber currently offers this service online. Choose another service.
                    </Notice>
                  )}
                </div>
              )}
              {step === 2 && (
                <>
                  {next && nextElsewhere.length > 0 && (
                    <section className="next-available" aria-label="Soonest open times">
                      <span className="eyebrow">SOONEST</span>
                      <div className="next-chips">
                        {next.slice(0, 4).map((n) => (
                          <button
                            key={`${n.date}-${n.start_min}`}
                            className={`next-chip ${slot === n.start_min && date === n.date ? "chosen" : ""}`}
                            onClick={() => jumpTo(n)}
                            aria-pressed={slot === n.start_min && date === n.date}
                          >
                            <strong>
                              {n.date === shop.today
                                ? "Today"
                                : n.date === datePlus(shop.today, 1)
                                  ? "Tomorrow"
                                  : dateLabel(n.date, { weekday: "short", day: "numeric", month: "short" })}
                            </strong>
                            <span>
                              {time(n.start_min)}
                              {anyBarber ? ` · ${n.staff_name.split(" ")[0]}` : ""}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                  <div className="booking-date-toolbar">
                    <h3>{dateLabel(from, { month: "long", year: "numeric" })}</h3>
                    <div className="small-toggles">
                      <button
                        aria-label="Previous week"
                        disabled={from <= shop.today}
                        onClick={() => setFrom(datePlus(from, -7) < shop.today ? shop.today : datePlus(from, -7))}
                      >
                        <Icon name="left" size={14} /> Earlier
                      </button>
                      <button
                        aria-label="Next week"
                        disabled={datePlus(from, 7) > shop.max_date}
                        onClick={() => setFrom(datePlus(from, 7))}
                      >
                        Later <Icon name="right" size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="booking-dates" aria-label="Choose date">
                    {weekDays.map((d) => {
                      const info = dayInfo(d);
                      const beyond = d > shop.max_date;
                      const disabled = beyond || (info ? info.closed : false);
                      const level = !info || beyond ? "" : info.closed ? "closed" : info.available === 0 ? "full" : info.available < 6 ? "low" : "open";
                      return (
                        <button
                          key={d}
                          className={`${date === d ? "chosen" : ""} ${level}`}
                          disabled={disabled}
                          onClick={() => {
                            setDate(d);
                            setSlot(null);
                          }}
                          aria-pressed={date === d}
                          aria-label={`${dateLabel(d)}, ${
                            !info ? "checking" : beyond ? "not yet open" : info.closed ? "closed" : info.available === 0 ? "fully booked" : `${info.available} times`
                          }`}
                        >
                          <span>{d === shop.today ? "Today" : dateLabel(d, { weekday: "short" })}</span>
                          <strong>{dateLabel(d, { day: "2-digit" })}</strong>
                          <small>
                            {!info
                              ? "…"
                              : beyond
                                ? "Not yet"
                                : info.closed
                                  ? "Closed"
                                  : info.available
                                    ? `${info.available} times`
                                    : "Full"}
                          </small>
                        </button>
                      );
                    })}
                  </div>
                  <div className="slot-heading">
                    <h3>{dateLabel(date, { weekday: "long", day: "numeric", month: "long" })}</h3>
                    <span>
                      <span className="available-dot" />
                      {availability ? `${openCount} available` : "Checking…"}
                    </span>
                  </div>
                  <div className="filter-chips dayparts" role="group" aria-label="Part of the day">
                    {["All times", "Morning", "Afternoon", "Evening"].map((d) => (
                      <button key={d} aria-pressed={daypart === d} onClick={() => setDaypart(d)}>
                        {d}
                      </button>
                    ))}
                  </div>
                  {slotError && (
                    <Notice tone="warning" icon="calendar">
                      {slotError}
                    </Notice>
                  )}
                  <div
                    className="time-groups"
                    role="group"
                    aria-label="Choose an appointment time"
                    aria-busy={!availability && !slotError}
                  >
                    {!availability && !slotError && <div className="time-slots skeleton-slots" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <span key={i} />)}</div>}
                    {groups.map((g) => (
                      <div className="time-group" key={g.label}>
                        <h4>
                          {g.label} <small>{g.slots.length}</small>
                        </h4>
                        <div className="time-slots">
                          {g.slots.map((s) => (
                            <button
                              key={s.start_min}
                              title={`${s.duration_min ?? duration}-minute appointment${anyBarber && s.staff_name ? ` with ${s.staff_name}` : ""}`}
                              aria-label={`${time(s.start_min)}, available${anyBarber && s.staff_name ? ` with ${s.staff_name}` : ""}`}
                              aria-pressed={slot === s.start_min}
                              onClick={() => pickSlot(s)}
                              className={slot === s.start_min ? "chosen" : ""}
                            >
                              {time(s.start_min)}
                              {anyBarber && s.staff_name && <small>{s.staff_name.split(" ")[0]}</small>}
                              {slot === s.start_min && <Icon name="check" size={14} />}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  {availability && openCount > 0 && groups.length === 0 && (
                    <Notice icon="clock">No {daypart.toLowerCase()} times left on this day. Try another part of the day.</Notice>
                  )}
                  {dayFull && waitlist !== "done" && (
                    <section className="waitlist-card" aria-labelledby="waitlist-heading">
                      <div>
                        <h4 id="waitlist-heading">This day is fully booked</h4>
                        <p>
                          {nextElsewhere.length
                            ? `Pick a soonest time above, or ask the shop to contact you if a space opens on ${dateLabel(date, { weekday: "long", day: "numeric", month: "long" })}.`
                            : "Ask the shop to contact you if a space opens."}
                        </p>
                      </div>
                      {waitlist === "idle" ? (
                        <Button variant="secondary" onClick={() => setWaitlist("open")}>
                          <Icon name="bell" /> Join the waitlist
                        </Button>
                      ) : (
                        <form className="waitlist-form" onSubmit={joinWaitlist} noValidate>
                          <div className="customer-fields compact">
                            <label>
                              <span id="waitlist-name">Your name</span>
                              <input name="name" aria-labelledby="waitlist-name" defaultValue={details.name} required aria-invalid={!!errors.wname} />
                              {errors.wname && <span className="field-error">{errors.wname}</span>}
                            </label>
                            <label>
                              <span id="waitlist-phone">Mobile number</span>
                              <input name="phone" type="tel" aria-labelledby="waitlist-phone" defaultValue={details.phone} required aria-invalid={!!errors.wphone} />
                              {errors.wphone && <span className="field-error">{errors.wphone}</span>}
                            </label>
                            <label>
                              <span id="waitlist-email">Email (optional)</span>
                              <input name="email" type="email" aria-labelledby="waitlist-email" defaultValue={details.email} />
                            </label>
                          </div>
                          <div className="filter-chips" role="group" aria-label="Preferred part of the day">
                            {[
                              ["ANY", "Any time"],
                              ["MORNING", "Morning"],
                              ["AFTERNOON", "Afternoon"],
                              ["EVENING", "Evening"],
                            ].map(([v, l]) => (
                              <button type="button" key={v} aria-pressed={waitDaypart === v} onClick={() => setWaitDaypart(v)}>
                                {l}
                              </button>
                            ))}
                          </div>
                          {saveError && (
                            <p className="workspace-error" role="alert">
                              {saveError}
                            </p>
                          )}
                          <div className="waitlist-actions">
                            <Button type="button" variant="ghost" onClick={() => setWaitlist("idle")} disabled={busy}>
                              Not now
                            </Button>
                            <Button type="submit" disabled={busy}>
                              {busy ? "Saving…" : "Ask the shop to contact me"}
                            </Button>
                          </div>
                        </form>
                      )}
                    </section>
                  )}
                  {waitlist === "done" && (
                    <Notice icon="check">
                      <strong>You’re on the list.</strong> The shop can see your request for{" "}
                      {dateLabel(date, { weekday: "long", day: "numeric", month: "long" })} and will contact you by hand if a
                      space opens. Nothing is reserved yet.
                    </Notice>
                  )}
                  <p className="slot-note">
                    <Icon name="clock" size={14} />
                    {duration} minutes, with a 10-minute buffer between visits.
                    {anyBarber && assigned && slot !== null && (
                      <>
                        {" "}
                        · <strong>{assigned.name}</strong> is free at {time(slot)}.
                      </>
                    )}
                  </p>
                </>
              )}
              {step === 3 && (
                <form id="customer-details" noValidate onSubmit={submitDetails}>
                  <div className="customer-fields">
                    {[
                      { id: "name", label: "Your name", placeholder: "Jamie Taylor", type: "text", auto: "name" },
                      { id: "phone", label: "Mobile number", placeholder: "07700 900123", type: "tel", auto: "tel" },
                      {
                        id: "email",
                        label: "Email address (optional)",
                        placeholder: "jamie@example.com",
                        type: "email",
                        auto: "email",
                      },
                    ].map((field) => (
                      <label key={field.id}>
                        <span id={`booking-${field.id}-label`}>{field.label}</span>
                        <input
                          aria-labelledby={`booking-${field.id}-label`}
                          required={field.id !== "email"}
                          type={field.type}
                          name={field.id}
                          autoComplete={field.auto}
                          value={details[field.id as keyof typeof details]}
                          placeholder={field.placeholder}
                          onChange={(e) => {
                            setDetails((d) => ({ ...d, [field.id]: e.target.value }));
                            setErrors((c) => ({ ...c, [field.id]: "" }));
                          }}
                          aria-invalid={!!errors[field.id]}
                          aria-describedby={errors[field.id] ? `booking-${field.id}-error` : undefined}
                        />
                        {errors[field.id] && (
                          <span className="field-error" id={`booking-${field.id}-error`}>
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
                        name="notes"
                        onChange={(e) => setDetails((d) => ({ ...d, notes: e.target.value }))}
                      />
                      <span className="field-help">{details.notes.length}/500 characters</span>
                    </label>
                  </div>
                  <Notice icon="shield">
                    Your details are saved with this booking only so the shop can find your visit, and remembered on this
                    device to speed up next time. Use fictional details in this local test.
                  </Notice>
                </form>
              )}
              {step === 4 && (
                <>
                  <div className="review-appointment">
                    <div className="review-icon">
                      <Icon name="calendarCheck" size={32} />
                    </div>
                    <span className="eyebrow">YOUR VISIT</span>
                    <h3>{dateLabel(date)}</h3>
                    <p>
                      {slot !== null ? time(slot) : "No time selected"} · {duration} minutes ·{" "}
                      {shop.shop.timezone}
                    </p>
                    <div className="review-barber">
                      {bookingStaffName && <Avatar initials={initials(bookingStaffName)} />}
                      <span>
                        {chosenService?.name}
                        {bookingStaffName && (
                          <>
                            {" "}
                            with <strong>{bookingStaffName.split(" ")[0]}</strong>
                          </>
                        )}
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
                  <Notice icon="shield">
                    <strong>Plans change.</strong> Cancel or move online at least{" "}
                    {availability?.cancel_hours ?? shop.shop.cancel_hours} hours ahead. You’ll get a
                    manage link after confirming. Deposit policy {money(deposit)} is recorded, not
                    collected.
                  </Notice>
                  {saveError && (
                    <p className="workspace-error" role="alert">
                      {saveError}
                    </p>
                  )}
                </>
              )}
              {saveError && step !== 4 && waitlist !== "open" && (
                <p className="workspace-error" role="alert">
                  {saveError}
                </p>
              )}
              <footer className="booking-actions">
                {step === 0 && (
                  <span className="mobile-checkout-total">
                    <strong>{priceLabel}</strong>
                    <small>Total</small>
                  </span>
                )}
                {step > 0 ? (
                  <Button variant="secondary" onClick={() => go(step - 1)} disabled={busy}>
                    <Icon name="arrowLeft" />
                    Back
                  </Button>
                ) : (
                  <span className="secure-note">
                    <Icon name="shield" size={15} />A little care in every detail
                  </span>
                )}
                {step === 3 ? (
                  <Button key="submit-details" type="submit" form="customer-details">
                    Review booking
                    <Icon name="arrowRight" />
                  </Button>
                ) : step === 4 ? (
                  <Button key="confirm" onClick={confirm} disabled={busy || slot === null || !availability || !bookingStaff} aria-busy={busy}>
                    {busy ? "Confirming…" : "Confirm booking"}
                    <Icon name="check" />
                  </Button>
                ) : (
                  <Button
                    key={`next-${step}`}
                    disabled={
                      (step === 0 && !service) ||
                      (step === 1 && !barber) ||
                      (step === 2 && (slot === null || !availability || !bookingStaff))
                    }
                    onClick={() => go(step + 1)}
                  >
                    {["Choose your barber", "Find a time", "Your details"][step]}
                    <Icon name="arrowRight" />
                  </Button>
                )}
              </footer>
              {step === 2 && slot === null && (
                <p className="field-help">Select an available time to continue.</p>
              )}
            </section>
            <aside className="booking-summary" aria-label="Your visit summary">
              <div className="summary-shop">
                <span className="mini-shop-emblem">{initials(shop.shop.name)}</span>
                <div>
                  <strong>Your time, well spent.</strong>
                  <span>{shop.shop.name}</span>
                </div>
              </div>
              <h3>Your visit</h3>
              {chosenService && (
                <div className="summary-service">
                  <span className="summary-service-icon">
                    <Icon name="scissors" size={23} />
                  </span>
                  <div>
                    <strong>{chosenService.name}</strong>
                    <span>
                      {(chosenSlot?.duration_min ?? availability?.items[0]?.duration_min ?? chosenService.duration_min) -
                        serviceAddons.filter((a) => extraIds.includes(a.id)).reduce((n, a) => n + a.duration_min, 0)}{" "}
                      minutes
                      {!anyBarber && (availability?.overridden ?? est.overridden) && chosenBarber
                        ? ` · ${chosenBarber.name.split(" ")[0]}’s rate`
                        : ""}
                    </span>
                  </div>
                  <strong>
                    {(() => {
                      const extras = serviceAddons.filter((a) => extraIds.includes(a.id)).reduce((n, a) => n + a.price_pence, 0);
                      const base = price - extras, baseTo = priceTo - extras;
                      return base === baseTo ? money(base) : `${money(base)}–${money(baseTo)}`;
                    })()}
                  </strong>
                </div>
              )}
              {serviceAddons
                .filter((a) => extraIds.includes(a.id))
                .map((a) => (
                  <p className="summary-addon" key={a.id}>
                    <span>
                      <Icon name="plus" size={12} />
                      {a.name}
                    </span>
                    <strong>{money(a.price_pence)}</strong>
                  </p>
                ))}
              <div className="summary-appointment">
                <p>
                  <Icon name="user" />
                  <span>
                    {bookingStaffName
                      ? bookingStaffName
                      : anyBarber
                        ? "First available barber"
                        : "Choose your barber"}
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
                  <span>{duration} minutes</span>
                </p>
              </div>
              <div className="summary-price">
                <p>
                  <span>Total</span>
                  <strong>{priceLabel}</strong>
                </p>
                <p className="deposit-line">
                  <span>
                    Deposit policy<small>Recorded, not collected</small>
                  </span>
                  <strong>{money(deposit)}</strong>
                </p>
                <p className="remaining-line">
                  <span>Pay in the shop</span>
                  <strong>{priceLabel}</strong>
                </p>
              </div>
              <div className="cancellation-note">
                <Icon name="shield" size={19} />
                <p>
                  <strong>Plans change. We get it.</strong>Cancel or move online up to{" "}
                  {shop.shop.cancel_hours} hours ahead using your manage link.
                </p>
              </div>
              <div className="preview-summary-note">
                <Icon name="eye" size={14} />
                Live shop prices · no payment taken
              </div>
            </aside>
          </div>
          <footer className="booking-footer">
            <Brand />
            <span>Good hair. Good company.</span>
            <span>Local test booking</span>
          </footer>
        </div>
      </main>
    </div>
  );
}

function ConfirmationCard({
  booking,
  token,
  slug,
}: {
  booking: CustomerBooking;
  token: string | null;
  slug: string;
}) {
  const link = token ? `${location.origin}/manage/${token}` : "";
  const [copied, setCopied] = useState("");
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(`${label} copied`);
    } catch {
      setCopied("Copy is not available here. Select the text to copy it.");
    }
  }
  return (
    <section className="public-confirmation" aria-labelledby="confirmation-heading">
      <div className="review-appointment">
        <div className="review-icon">
          <Icon name="calendarCheck" size={32} />
        </div>
        <span className="eyebrow">BOOKED</span>
        <h1 id="confirmation-heading">{dateLabel(booking.date)}</h1>
        <p>
          {time(booking.start_min)} · {booking.duration_min} minutes · {booking.shop.timezone}
        </p>
        <div className="review-barber">
          {booking.staff_name && <Avatar initials={initials(booking.staff_name)} />}
          <span>
            {booking.service_name}
            {booking.staff_name && (
              <>
                {" "}
                with <strong>{booking.staff_name.split(" ")[0]}</strong>
              </>
            )}
          </span>
        </div>
      </div>
      <section className="review-customer">
        <div>
          <h3>Reference</h3>
          <Button variant="ghost" onClick={() => copy(booking.reference, "Reference")}>
            Copy
          </Button>
        </div>
        <strong className="public-reference">{booking.reference}</strong>
        <p>
          {booking.customer_name} · {booking.phone}
          {booking.email && ` · ${booking.email}`}
        </p>
        <p>
          Total {money(booking.price_pence)} · pay in the shop. Deposit policy{" "}
          {money(booking.deposit_policy_pence)} recorded, not collected.
        </p>
      </section>
      {link ? (
        <section className="review-customer">
          <div>
            <h3>Manage this booking</h3>
            <Button variant="ghost" onClick={() => copy(link, "Manage link")}>
              Copy link
            </Button>
          </div>
          <p>
            Save this private link to view, move or cancel your visit. No message has been sent,
            so keep it somewhere safe.
          </p>
          <a className="public-manage-link" href={`/manage/${token}`}>
            {link}
          </a>
        </section>
      ) : (
        <Notice icon="shield">
          This booking was already confirmed earlier. Use the manage link you saved then.
        </Notice>
      )}
      {copied && <p role="status">{copied}</p>}
      <div className="confirmation-actions">
        <a className="action-tile" href={gcal(booking)} target="_blank" rel="noreferrer">
          <Icon name="calendar" /> <span>Google Calendar</span>
        </a>
        {token && (
          <a className="action-tile" href={`/api/public/manage/${token}/calendar.ics`}>
            <Icon name="arrowDown" /> <span>Apple / Outlook (.ics)</span>
          </a>
        )}
        {booking.shop.address && (
          <a className="action-tile" href={mapsUrl(booking.shop.address)} target="_blank" rel="noreferrer">
            <Icon name="pin" /> <span>Directions</span>
          </a>
        )}
        {link && (
          <a
            className="action-tile"
            href={`sms:?&body=${encodeURIComponent(`${booking.service_name} at ${booking.shop.name}, ${dateLabel(booking.date, { weekday: "short", day: "numeric", month: "short" })} ${time(booking.start_min)}. Manage: ${link}`)}`}
          >
            <Icon name="message" /> <span>Text myself the link</span>
          </a>
        )}
      </div>
      <footer className="booking-actions">
        <a className="button primary" href={`/book/${slug}`}>
          Book another visit
        </a>
      </footer>
    </section>
  );
}

export function ManageBooking({ token }: { token: string }) {
  const [booking, setBooking] = useState<CustomerBooking | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"view" | "move" | "cancel">("view");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [meta, setMeta] = useState({ today: "", max_date: "" });
  async function load() {
    setError("");
    try {
      const r = await api<{ booking: CustomerBooking }>(`/manage/${token}`);
      setBooking(r.booking);
      setDate((d) => d || r.booking.date);
    } catch (e) {
      setError(e instanceof Error ? e.message : "This link could not be opened.");
    }
  }
  useEffect(() => {
    load();
  }, [token]);
  useEffect(() => {
    if (mode !== "move" || !date) return;
    let cancelled = false;
    setSlots(null);
    setActionError("");
    api<{ slots: Slot[]; today: string; max_date: string }>(
      `/manage/${token}/availability?date=${date}`,
    )
      .then((r) => {
        if (cancelled) return;
        setSlots(r.slots);
        setMeta({ today: r.today, max_date: r.max_date });
      })
      .catch((e) => !cancelled && setActionError(e.message));
    return () => {
      cancelled = true;
    };
  }, [mode, date]);
  async function act(path: string, body: unknown) {
    if (!booking) return;
    setBusy(true);
    setActionError("");
    try {
      const r = await api<{ booking: CustomerBooking; late?: boolean }>(
        `/manage/${token}/${path}`,
        "POST",
        body,
      );
      setBooking(r.booking);
      setMode("view");
      setSlot(null);
      setNotice(
        path === "cancel"
          ? r.late
            ? "Your booking is cancelled. This was inside the shop’s cancellation window, so the shop has been told it was a late change."
            : "Your booking is cancelled."
          : "Your booking has moved.",
      );
    } catch (e) {
      const err = e as ApiError;
      setActionError(err.message);
      if (err.code === "record_changed" || err.code === "invalid_transition") load();
      if (err.code === "slot_taken") setSlot(null);
    } finally {
      setBusy(false);
    }
  }
  if (error)
    return (
      <div className="booking-app">
        <TestBanner />
        <main className="state-card">
          <h1>Booking not found</h1>
          <p>{error}</p>
          <Button onClick={load}>Try again</Button>
        </main>
      </div>
    );
  if (!booking)
    return (
      <div className="booking-app">
        <TestBanner />
        <p className="boot-message" role="status">
          Opening your booking…
        </p>
      </div>
    );
  const statusLabel: Record<string, string> = {
    CONFIRMED: "Confirmed",
    CHECKED_IN: "Checked in",
    IN_SERVICE: "In the chair",
    COMPLETED: "Completed",
    CANCELLED: "Cancelled",
    NO_SHOW: "Missed",
  };
  const week = Array.from({ length: 7 }, (_, i) => datePlus(date, i - 3)).filter(
    (d) => !meta.today || d >= meta.today,
  );
  return (
    <div className="booking-app">
      <TestBanner />
      <ShopHeader name={booking.shop.name} address={booking.shop.address} />
      <main id="main-content" className="booking-body">
        <section className="public-confirmation" aria-labelledby="manage-heading">
          <div className="review-appointment">
            <div className="review-icon">
              <Icon name={booking.status === "CANCELLED" ? "close" : "calendarCheck"} size={32} />
            </div>
            <span className="eyebrow">{statusLabel[booking.status]?.toUpperCase()}</span>
            <h1 id="manage-heading">{dateLabel(booking.date)}</h1>
            <p>
              {time(booking.start_min)} · {booking.duration_min} minutes · {booking.shop.timezone}
            </p>
            <div className="review-barber">
              {booking.staff_name && <Avatar initials={initials(booking.staff_name)} />}
              <span>
                {booking.service_name}
                {booking.staff_name && (
                  <>
                    {" "}
                    with <strong>{booking.staff_name.split(" ")[0]}</strong>
                  </>
                )}
              </span>
            </div>
          </div>
          {notice && (
            <Notice icon="check">
              <span role="status">{notice}</span>
            </Notice>
          )}
          <section className="review-customer">
            <div>
              <h3>Reference {booking.reference}</h3>
            </div>
            <strong>{booking.customer_name}</strong>
            <p>
              {booking.phone}
              {booking.email && ` · ${booking.email}`}
            </p>
            {booking.items.map((i) => (
              <p key={i.id} className="summary-addon">
                <span>{i.name}</span>
                <strong>{money(i.price_pence)}</strong>
              </p>
            ))}
            <p>
              Total {money(booking.price_pence)} · pay in the shop. Cancellation policy{" "}
              {booking.cancel_hours} hours.
            </p>
          </section>
          {mode === "view" && (
            <>
              {!booking.can_manage && booking.status === "CONFIRMED" && (
                <Notice tone="warning" icon="clock">
                  This visit is too close to change online. Contact the shop directly.
                </Notice>
              )}
              {booking.can_manage && booking.late_change && (
                <Notice tone="warning" icon="clock">
                  You are inside the {booking.cancel_hours}-hour cancellation window. Changes are
                  still possible online but the shop will see them as late.
                </Notice>
              )}
              {booking.status === "CONFIRMED" && (
                <div className="confirmation-actions">
                  <a className="action-tile" href={gcal(booking)} target="_blank" rel="noreferrer">
                    <Icon name="calendar" /> <span>Google Calendar</span>
                  </a>
                  <a className="action-tile" href={`/api/public/manage/${token}/calendar.ics`}>
                    <Icon name="arrowDown" /> <span>Apple / Outlook (.ics)</span>
                  </a>
                  {booking.shop.address && (
                    <a className="action-tile" href={mapsUrl(booking.shop.address)} target="_blank" rel="noreferrer">
                      <Icon name="pin" /> <span>Directions</span>
                    </a>
                  )}
                </div>
              )}
              <footer className="booking-actions">
                {booking.can_manage && (
                  <>
                    <Button variant="secondary" onClick={() => setMode("move")}>
                      Move booking
                    </Button>
                    <Button variant="danger" onClick={() => setMode("cancel")}>
                      Cancel booking
                    </Button>
                  </>
                )}
                {booking.shop.slug && (
                  <a className="button primary" href={`/book/${booking.shop.slug}`}>
                    Book again
                  </a>
                )}
              </footer>
            </>
          )}
          {mode === "cancel" && (
            <section className="review-customer" aria-labelledby="cancel-heading">
              <div>
                <h3 id="cancel-heading">Cancel this booking?</h3>
              </div>
              <p>
                {booking.late_change
                  ? `This is inside the shop’s ${booking.cancel_hours}-hour cancellation window and will be recorded as a late cancellation.`
                  : "Your time will be released for other customers. This cannot be undone online."}
              </p>
              {actionError && (
                <p className="workspace-error" role="alert">
                  {actionError}
                </p>
              )}
              <footer className="booking-actions">
                <Button variant="secondary" onClick={() => setMode("view")} disabled={busy}>
                  Keep booking
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => act("cancel", { version: booking.version })}
                >
                  {busy ? "Cancelling…" : "Yes, cancel"}
                </Button>
              </footer>
            </section>
          )}
          {mode === "move" && (
            <section className="review-customer" aria-labelledby="move-heading">
              <div>
                <h3 id="move-heading">Choose a new time</h3>
              </div>
              <p>
                Same service and barber, {booking.duration_min} minutes. Currently{" "}
                {dateLabel(booking.date, { weekday: "short", day: "numeric", month: "short" })} ·{" "}
                {time(booking.start_min)}.
              </p>
              <div className="booking-dates" aria-label="Choose date">
                {week.map((d) => (
                  <button
                    key={d}
                    className={date === d ? "chosen" : ""}
                    aria-pressed={date === d}
                    disabled={!!meta.max_date && d > meta.max_date}
                    onClick={() => {
                      setDate(d);
                      setSlot(null);
                    }}
                  >
                    <span>{dateLabel(d, { weekday: "short" })}</span>
                    <strong>{dateLabel(d, { day: "2-digit" })}</strong>
                    <small>{dateLabel(d, { month: "short" })}</small>
                  </button>
                ))}
              </div>
              {actionError && (
                <p className="workspace-error" role="alert">
                  {actionError}
                </p>
              )}
              <div className="time-slots" role="group" aria-label="Choose a new time" aria-busy={!slots}>
                {(slots || []).map((s) => (
                  <button
                    key={s.start_min}
                    disabled={!s.available}
                    aria-pressed={slot === s.start_min}
                    aria-label={`${time(s.start_min)}${s.available ? ", available" : `, ${s.reason}`}`}
                    className={slot === s.start_min ? "chosen" : ""}
                    onClick={() => setSlot(s.start_min)}
                  >
                    {time(s.start_min)}
                    {slot === s.start_min && <Icon name="check" size={14} />}
                  </button>
                ))}
              </div>
              {slots && !slots.some((s) => s.available) && (
                <Notice icon="calendar" tone="warning">
                  No times left on this date. Try another day.
                </Notice>
              )}
              <footer className="booking-actions">
                <Button variant="secondary" onClick={() => setMode("view")} disabled={busy}>
                  Back
                </Button>
                <Button
                  disabled={busy || slot === null}
                  onClick={() =>
                    act("reschedule", { date, start_min: slot, version: booking.version })
                  }
                >
                  {busy ? "Moving…" : `Move to ${slot !== null ? time(slot) : "…"}`}
                </Button>
              </footer>
            </section>
          )}
        </section>
        <footer className="booking-footer">
          <Brand />
          <span>Good hair. Good company.</span>
          <span>Local test booking</span>
        </footer>
      </main>
    </div>
  );
}
