import { useEffect, useMemo, useState } from "react";
import { Icon } from "./ui";
import { SENDER_MAX, checkSender, suggestSenders } from "./smsSenderRules";
export { SENDER_MAX, checkSender, suggestSenders };

// Alphanumeric SMS sender ("alpha tag"): the name at the top of every text a shop sends.
// One field, used in onboarding and Settings → Messages, that does the thinking for the owner:
// suggests good options from the shop name, validates against carrier rules as they type, and
// shows the text exactly as a customer will see it on a phone.

export function SmsSenderField({
  value,
  onChange,
  shopName,
  sampleBody,
  testId = "sms-sender",
}: {
  value: string;
  onChange: (v: string) => void;
  shopName: string;
  sampleBody: string;
  testId?: string;
}) {
  const suggestions = useMemo(() => suggestSenders(shopName), [shopName]);
  const check = checkSender(value);
  const shown = value.trim() || suggestions[0] || "foliyo";
  return (
    <div className="sender-field" data-testid={`${testId}-field`}>
      <div className="sender-form">
        <label className="sender-label" htmlFor={testId}>
          Text sender name <small>{value.trim().length}/{SENDER_MAX}</small>
        </label>
        <input
          id={testId}
          value={value}
          maxLength={SENDER_MAX}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value.replace(/[^A-Za-z0-9 ]/g, "").replace(/\s{2,}/g, " ").slice(0, SENDER_MAX))}
          placeholder={suggestions[0] || "Your shop"}
          aria-describedby={`${testId}-note`}
          aria-invalid={!check.ok}
          data-testid={testId}
        />
        <p id={`${testId}-note`} className={`sender-note ${check.level}`} role={check.level === "bad" ? "alert" : undefined} data-testid={`${testId}-note`}>
          <Icon name={check.level === "good" ? "check" : check.level === "warn" ? "info" : "alert"} size={14} /> {check.note}
        </p>
        {suggestions.length > 0 && (
          <div className="sender-suggest" aria-label="Suggested sender names">
            {suggestions.map((s) => (
              <button key={s} type="button" className={`sender-chip${s === value.trim() ? " on" : ""}`} onClick={() => onChange(s)} data-testid={`${testId}-suggest`}>
                {s}
              </button>
            ))}
          </div>
        )}
        <ul className="sender-rules">
          <li>Shown instead of a number on UK phones. Customers can’t reply to it — replies come to our shared number and reach you in the inbox.</li>
          <li>Keep it recognisable: the name on your door beats an abbreviation.</li>
        </ul>
      </div>
      <div className="sender-phone" aria-hidden="true">
        <div className="sender-phone-bar">
          <span className="sender-phone-avatar">{shown.slice(0, 1).toUpperCase()}</span>
          <b>{shown}</b>
        </div>
        <div className="sender-phone-time">Today 10:02</div>
        <div className="sender-phone-bubble">{sampleBody}</div>
      </div>
    </div>
  );
}

/** Texts are billed per message: the owner ticks this once before texts go on. */
export function SmsBillingAck({
  unitPence,
  acknowledgedAt,
  checked,
  onChange,
  testId = "sms-billing-ack",
}: {
  unitPence: number;
  acknowledgedAt: number | null;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) {
  const price = `${unitPence}p`;
  if (acknowledgedAt) {
    return (
      <p className="sms-bill-note" data-testid={`${testId}-done`}>
        <Icon name="check" size={14} /> Texts are billed at <strong>{price} each</strong>, itemised on your monthly invoice. Accepted {new Date(acknowledgedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.
      </p>
    );
  }
  return (
    <label className={`sms-bill-ack${checked ? " on" : ""}`} data-testid={testId}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>Texts cost {price} each</strong>
        <small>Every text we send for you (confirmations, reminders, codes) is added to your invoice the same day, with the date and who it went to. A busy chair sends roughly 60–80 texts a month — about £5–£6. Emails are free.</small>
      </span>
    </label>
  );
}

type SeatInfo = { plan: { monthly_pence: number; included_seats: number; seat_pence: number; name: string }; seats: { used: number; included: number } };
const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;

/** Says, before the click, whether adding a barber adds a monthly charge and what the new total is. */
export function SeatChargeNote({ api, adding = 1, testId = "seat-charge" }: { api: <T>(path: string, method?: string, body?: unknown) => Promise<T>; adding?: number; testId?: string }) {
  const [info, setInfo] = useState<SeatInfo | null>(null);
  useEffect(() => { api<{ entitlements: SeatInfo }>("/billing").then((r) => setInfo(r.entitlements)).catch(() => setInfo(null)); }, []);
  if (!info) return null;
  const { plan, seats } = info;
  const extra = Math.max(0, seats.used + adding - plan.included_seats) - Math.max(0, seats.used - plan.included_seats);
  const total = plan.monthly_pence + Math.max(0, seats.used + adding - plan.included_seats) * plan.seat_pence;
  return (
    <p className={`seat-charge${extra > 0 ? " charged" : ""}`} data-testid={testId}>
      <Icon name={extra > 0 ? "alert" : "check"} size={14} />
      <span>
      {extra > 0
        ? <>Your plan includes {plan.included_seats} barber{plan.included_seats === 1 ? "" : "s"}. Adding this barber adds <strong>{gbp(plan.seat_pence * extra)} a month</strong>, charged pro rata from today. Your new monthly total is <strong>{gbp(total)}</strong>.</>
        : <>This barber is included in your plan at no extra cost. Each barber after {plan.included_seats} adds {gbp(plan.seat_pence)} a month.</>}
      </span>
    </p>
  );
}
