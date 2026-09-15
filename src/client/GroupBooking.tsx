// Group booking: two to four people booked together on one day — "together" (same start, one barber
// each) or "back to back" (one barber, one after another). Every member becomes an ordinary visit
// under the same guards; partial failures are shown honestly.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PublicShop, BookingCustomer } from "./PublicBooking";
import { Avatar, Button, Icon, Notice } from "./ui";
import { dateLabel, datePlus, money, time } from "./fixtures";

type Member = { attendee: string; service: string; staff: string; addons: string[] };
type Assignment = { staff_id: string; staff_name: string; start_min: number; price_pence: number; duration_min: number };
type Option = { start_min: number; available: boolean; assignment: Assignment[] | null };
type GroupAvailability = { date: string; together: Option[]; back_to_back: Option[]; back_to_back_possible: boolean; quotes: { service_version: number; shop_version: number }[]; cancel_hours: number; deposit_pence: number };
type Saved = { group_id: string; bookings: { id: string; reference: string; date: string; start_min: number; service_name: string; staff_name: string | null; attendee_name: string; price_pence: number }[]; failed: { index: number; attendee_name: string; error: string }[]; manage_token: string | null };

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
const phoneOk = (s: string) => /^(?:\+44|0)7\d{9}$/.test(s.replace(/[\s()-]/g, ""));
const emailOk = (s: string) => !s || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const initials = (n: string) => n.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();

export function GroupBooking({ shop, slug, customer, onExit }: { shop: PublicShop; slug: string; customer?: BookingCustomer | null; onExit: () => void }) {
  const first = shop.services[0]?.id || "";
  const [members, setMembers] = useState<Member[]>([
    { attendee: customer?.name || "", service: first, staff: "any", addons: [] },
    { attendee: "", service: first, staff: "any", addons: [] },
  ]);
  const [mode, setMode] = useState<"together" | "back_to_back">("together");
  const [date, setDate] = useState(shop.today);
  const [from, setFrom] = useState(shop.today);
  const [avail, setAvail] = useState<GroupAvailability | null>(null);
  const [loadError, setLoadError] = useState("");
  const [start, setStart] = useState<number | null>(null);
  const [step, setStep] = useState(0);
  const [details, setDetails] = useState({ name: customer?.name || "", phone: customer?.phone || "", email: customer?.email || "", notes: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState<Saved | null>(null);
  const request = useRef({ key: crypto.randomUUID(), payload: "" });
  const heading = useRef<HTMLHeadingElement>(null);

  const eligible = (staffId: string, serviceId: string) => !shop.service_rules.some((r) => r.staff_id === staffId && r.service_id === serviceId && !r.enabled);
  const barbersFor = (serviceId: string) => shop.staff.filter((s) => eligible(s.id, serviceId));
  const key = members.map((m) => `${m.service}:${m.staff}:${[...m.addons].sort().join(",")}`).join(";");
  useEffect(() => {
    if (step !== 1) return;
    let cancelled = false;
    setAvail(null);
    setLoadError("");
    api<GroupAvailability>(`/shops/${encodeURIComponent(slug)}/group-availability?date=${date}&members=${encodeURIComponent(key)}`)
      .then((r) => {
        if (cancelled) return;
        setAvail(r);
        setStart((s) => (s !== null && (r[mode] ?? []).find((o) => o.start_min === s && o.available) ? s : null));
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "Could not load times."));
    return () => {
      cancelled = true;
    };
  }, [key, date, step]);
  useEffect(() => {
    setStart(null);
  }, [mode]);
  const go = (n: number) => {
    setStep(n);
    setSaveError("");
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  };
  const update = (i: number, patch: Partial<Member>) =>
    setMembers((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch, ...(patch.service && patch.service !== m.service ? { addons: [], staff: m.staff !== "any" && !eligible(m.staff, patch.service) ? "any" : m.staff } : {}) } : m)));
  const options = avail ? avail[mode] : [];
  const chosen = start !== null ? options.find((o) => o.start_min === start) : null;
  const total = chosen?.assignment?.reduce((n, a) => n + a.price_pence, 0) ?? 0;
  const serviceOf = (id: string) => shop.services.find((s) => s.id === id);
  const membersReady = members.every((m) => m.service && (m.attendee.trim().length >= 2 || members.indexOf(m) === 0));
  const week = Array.from({ length: 7 }, (_, i) => datePlus(from, i)).filter((d) => d <= shop.max_date);

  function submitDetails(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (details.name.trim().length < 2) next.name = "Enter your name";
    if (!phoneOk(details.phone)) next.phone = "Enter a valid UK mobile number";
    if (!emailOk(details.email)) next.email = "Enter a valid email address";
    setErrors(next);
    if (!Object.keys(next).length) go(3);
  }
  async function confirm() {
    if (!chosen?.assignment || !avail || busy) return;
    const payload = {
      customer_name: details.name.trim(),
      phone: details.phone,
      email: details.email.trim(),
      notes: details.notes.trim(),
      date,
      members: members.map((m, i) => ({
        attendee_name: i === 0 && m.attendee.trim() === details.name.trim() ? "" : m.attendee.trim(),
        staff_id: chosen.assignment![i].staff_id,
        service_id: m.service,
        addon_ids: [...m.addons].sort(),
        start_min: chosen.assignment![i].start_min,
        quote: avail.quotes[i],
      })),
    };
    const serialised = JSON.stringify(payload);
    if (request.current.payload !== serialised) request.current = { key: crypto.randomUUID(), payload: serialised };
    setBusy(true);
    setSaveError("");
    try {
      const r = await api<Saved>(`/shops/${encodeURIComponent(slug)}/group-bookings`, "POST", { request_id: request.current.key, ...payload });
      setSaved(r);
      requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    } catch (e) {
      const err = e as ApiError;
      setSaveError(err.code === "slot_taken" ? "One of those chairs has just been taken. Pick another time; your party is kept." : err.message);
      if (err.code === "slot_taken") {
        setStart(null);
        go(1);
      }
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    const link = saved.manage_token ? `${location.origin}/manage/${saved.manage_token}` : "";
    return (
      <section className="group-booking" data-testid="group-confirmed" aria-labelledby="group-done-heading">
        <div className="review-appointment">
          <div className="review-icon">
            <Icon name="users" size={32} />
          </div>
          <span className="eyebrow">{saved.failed.length ? "PARTLY BOOKED" : "GROUP BOOKED"}</span>
          <h2 id="group-done-heading" ref={heading} tabIndex={-1}>
            {dateLabel(saved.bookings[0]?.date || date)}
          </h2>
          <p>
            {saved.bookings.length} of {saved.bookings.length + saved.failed.length} visits saved · {shop.shop.name}
          </p>
        </div>
        <ul className="group-summary" data-testid="group-summary">
          {saved.bookings.map((b) => (
            <li key={b.id}>
              <Avatar initials={initials(b.attendee_name || details.name)} />
              <div>
                <b>{b.attendee_name || details.name}</b>
                <span>
                  {time(b.start_min)} · {b.service_name}
                  {b.staff_name && ` with ${b.staff_name.split(" ")[0]}`} · {money(b.price_pence)} · {b.reference}
                </span>
              </div>
            </li>
          ))}
          {saved.failed.map((f) => (
            <li key={f.index} className="failed">
              <Avatar initials={initials(f.attendee_name)} />
              <div>
                <b>{f.attendee_name}</b>
                <span>Not booked — {f.error === "slot_taken" ? "that chair was taken as we saved. Book them separately or call the shop." : f.error}</span>
              </div>
            </li>
          ))}
        </ul>
        {link && (
          <Notice icon="key">
            Your manage link (for the first visit): <a className="public-manage-link" href={`/manage/${saved.manage_token}`}>{link}</a>
            <br />
            <small>Signed-in customers can manage every visit from “Your visits”.</small>
          </Notice>
        )}
        <div className="group-actions">
          <Button variant="secondary" onClick={onExit}>
            Done
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="group-booking" data-testid="group-booking" aria-labelledby="group-heading">
      <header className="step-heading">
        <span className="eyebrow">GROUP BOOKING · STEP {step + 1} OF 4</span>
        <h2 id="group-heading" ref={heading} tabIndex={-1}>
          {["Who’s coming?", "Pick a day and time.", "Your details.", "Check and confirm."][step]}
        </h2>
        <p>{["Two to four people. Each picks a service; barbers can be chosen or left to us.", "Together means one chair each at the same time. Back to back means one barber, one after another.", "One contact for the whole party.", "Every visit is saved separately so each can be moved or cancelled on its own."][step]}</p>
      </header>

      {step === 0 && (
        <div className="group-members">
          {members.map((m, i) => (
            <fieldset key={i} className="group-member" data-testid="group-member">
              <legend>
                {i === 0 ? "You (or the first person)" : `Person ${i + 1}`}
                {members.length > 2 && (
                  <Button variant="ghost" aria-label={`Remove person ${i + 1}`} onClick={() => setMembers((ms) => ms.filter((_, j) => j !== i))}>
                    <Icon name="close" size={14} />
                  </Button>
                )}
              </legend>
              <label>
                <span>Name</span>
                <input value={m.attendee} onChange={(e) => update(i, { attendee: e.target.value })} placeholder={i === 0 ? "Your name" : "Their name"} maxLength={100} required={i > 0} data-testid="member-name" />
              </label>
              <label>
                <span>Service</span>
                <select value={m.service} onChange={(e) => update(i, { service: e.target.value })} data-testid="member-service">
                  {shop.services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {money(s.price_pence)} · {s.duration_min} min
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Barber</span>
                <select value={m.staff} onChange={(e) => update(i, { staff: e.target.value })} data-testid="member-barber">
                  <option value="any">Any available</option>
                  {barbersFor(m.service).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
          ))}
          {members.length < 4 && (
            <Button variant="secondary" onClick={() => setMembers((ms) => [...ms, { attendee: "", service: first, staff: "any", addons: [] }])} data-testid="add-member">
              <Icon name="plus" size={15} /> Add another person
            </Button>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="group-time">
          <div className="group-mode" role="group" aria-label="How to seat the party">
            <button type="button" aria-pressed={mode === "together"} onClick={() => setMode("together")} data-testid="mode-together">
              <Icon name="users" size={15} /> Together
              <small>Same time, a chair each</small>
            </button>
            <button type="button" aria-pressed={mode === "back_to_back"} onClick={() => setMode("back_to_back")} disabled={avail ? !avail.back_to_back_possible : false} data-testid="mode-back-to-back">
              <Icon name="repeat" size={15} /> Back to back
              <small>One barber, one after another</small>
            </button>
          </div>
          <div className="group-days" role="group" aria-label="Choose a day">
            <Button variant="ghost" aria-label="Previous week" disabled={from <= shop.today} onClick={() => setFrom((f) => (datePlus(f, -7) < shop.today ? shop.today : datePlus(f, -7)))}>
              <Icon name="left" size={16} />
            </Button>
            {week.map((d) => (
              <button key={d} type="button" aria-pressed={d === date} onClick={() => setDate(d)}>
                <small>{new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })}</small>
                <b>{d.slice(8)}</b>
              </button>
            ))}
            <Button variant="ghost" aria-label="Next week" disabled={datePlus(from, 7) > shop.max_date} onClick={() => setFrom((f) => datePlus(f, 7))}>
              <Icon name="right" size={16} />
            </Button>
          </div>
          <div className="group-slots" role="group" aria-label="Choose a start time" aria-busy={!avail && !loadError}>
            {loadError && (
              <p className="workspace-error" role="alert">
                {loadError}
              </p>
            )}
            {avail && !options.some((o) => o.available) && <p className="ca-muted">No {mode === "together" ? "time seats everyone together" : "single barber can take everyone in a row"} on {dateLabel(date)}. Try another day{mode === "together" ? " or back to back" : " or together"}.</p>}
            {options
              .filter((o) => o.available)
              .map((o) => (
                <button key={o.start_min} type="button" aria-pressed={start === o.start_min} onClick={() => setStart(o.start_min)} data-testid="group-slot">
                  {time(o.start_min)}
                  {mode === "back_to_back" && o.assignment && <small>to {time(o.assignment.at(-1)!.start_min + o.assignment.at(-1)!.duration_min)}</small>}
                </button>
              ))}
          </div>
          {chosen?.assignment && (
            <ul className="group-plan" data-testid="group-plan">
              {chosen.assignment.map((a, i) => (
                <li key={i}>
                  <Avatar initials={initials(a.staff_name)} />
                  <span>
                    <b>{members[i].attendee || details.name || `Person ${i + 1}`}</b> · {serviceOf(members[i].service)?.name} · {time(a.start_min)} with {a.staff_name.split(" ")[0]} · {money(a.price_pence)}
                  </span>
                </li>
              ))}
              <li className="group-total">
                Total <b>{money(total)}</b> · pay in the shop
              </li>
            </ul>
          )}
        </div>
      )}

      {step === 2 && (
        <form id="group-details" noValidate onSubmit={submitDetails} className="customer-fields">
          {customer && (
            <Notice icon="userRound">
              Signed in as <strong>{customer.name}</strong> — contact details filled in for you.
            </Notice>
          )}
          {(
            [
              ["name", "Your name", "text", "name"],
              ["phone", "Mobile number", "tel", "tel"],
              ["email", "Email address (optional)", "email", "email"],
            ] as const
          ).map(([id, label, type, auto]) => (
            <label key={id}>
              <span id={`group-${id}-label`}>{label}</span>
              <input aria-labelledby={`group-${id}-label`} required={id !== "email"} type={type} name={id} autoComplete={auto} value={details[id]} onChange={(e) => { setDetails((d) => ({ ...d, [id]: e.target.value })); setErrors((c) => ({ ...c, [id]: "" })); }} aria-invalid={!!errors[id]} aria-describedby={errors[id] ? `group-${id}-error` : undefined} />
              {errors[id] && (
                <span className="field-error" id={`group-${id}-error`}>
                  {errors[id]}
                </span>
              )}
            </label>
          ))}
          <label>
            Anything we should know? (optional)
            <textarea value={details.notes} maxLength={500} name="notes" onChange={(e) => setDetails((d) => ({ ...d, notes: e.target.value }))} />
          </label>
        </form>
      )}

      {step === 3 && chosen?.assignment && (
        <>
          <div className="review-appointment">
            <div className="review-icon">
              <Icon name="users" size={32} />
            </div>
            <span className="eyebrow">YOUR PARTY</span>
            <h3>{dateLabel(date)}</h3>
            <p>
              {members.length} people · {mode === "together" ? `all at ${time(start!)}` : `${time(start!)} onwards with ${chosen.assignment[0].staff_name.split(" ")[0]}`}
            </p>
          </div>
          <ul className="group-plan">
            {chosen.assignment.map((a, i) => (
              <li key={i}>
                <Avatar initials={initials(a.staff_name)} />
                <span>
                  <b>{members[i].attendee || details.name}</b> · {serviceOf(members[i].service)?.name} · {time(a.start_min)} with {a.staff_name.split(" ")[0]} · {money(a.price_pence)}
                </span>
              </li>
            ))}
            <li className="group-total">
              Total <b>{money(total)}</b> · pay in the shop
            </li>
          </ul>
          <section className="review-customer">
            <div>
              <h3>Contact</h3>
              <Button variant="ghost" onClick={() => go(2)}>
                Edit <Icon name="arrowUp" size={14} />
              </Button>
            </div>
            <strong>{details.name}</strong>
            <p>
              {details.phone}
              {details.email && ` · ${details.email}`}
            </p>
          </section>
          <Notice icon="shield">
            <strong>Plans change.</strong> Each visit gets its own reference and can be moved or cancelled online at least {avail?.cancel_hours ?? shop.shop.cancel_hours} hours ahead. Deposit policy {money(Math.min(avail?.deposit_pence ?? shop.shop.deposit_pence, total))} is recorded, not collected.
          </Notice>
        </>
      )}
      {saveError && (
        <p className="workspace-error" role="alert">
          {saveError}
        </p>
      )}
      <footer className="group-actions">
        <Button variant="ghost" onClick={step === 0 ? onExit : () => go(step - 1)} disabled={busy}>
          <Icon name="arrowLeft" size={16} /> {step === 0 ? "Book for one person" : "Back"}
        </Button>
        {step === 0 && (
          <Button onClick={() => go(1)} disabled={!membersReady} data-testid="group-next">
            Find a time <Icon name="arrowRight" size={16} />
          </Button>
        )}
        {step === 1 && (
          <Button onClick={() => go(2)} disabled={start === null} data-testid="group-next">
            Your details <Icon name="arrowRight" size={16} />
          </Button>
        )}
        {step === 2 && (
          <Button type="submit" form="group-details" data-testid="group-next">
            Review <Icon name="arrowRight" size={16} />
          </Button>
        )}
        {step === 3 && (
          <Button onClick={confirm} disabled={busy} data-testid="group-confirm">
            {busy ? "Booking…" : `Confirm ${members.length} visits`}
          </Button>
        )}
      </footer>
    </section>
  );
}
