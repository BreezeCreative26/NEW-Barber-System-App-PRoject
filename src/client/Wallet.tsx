// Shop wallet drawer (owner/manager) and barber earnings view. Reads the payments ledger only.
// Model A: money never sits in the app — these are totals of what was recorded at the chair.
import { useEffect, useState } from "react";
import type { Payment, WorkspaceData } from "../server/domain";
import { Button, Icon, IconButton, StatusPill, TxRow, WalletHero } from "./ui";
import { METHODS } from "./Checkout";
import { money, time, datePlus } from "./fixtures";

export type WalletData = {
  from: string;
  to: string;
  today: string;
  till_access: "OWNER" | "ALL";
  totals: { service: number; tips: number; discounts: number; visits: number; voided: number; unpaid_value: number; unpaid_visits: number };
  by_method: Record<string, { service: number; tips: number; count: number }>;
  by_staff: {
    staff_id: string; pay_model: string; service: number; tips: number; commission: number; tip_share: number; earnings: number; deductions: number;
    deduction_lines: { label: string; pence: number; detail: string }[]; owner_share: number; owed_to_business: number; visits: number; estimate: boolean;
    // Where the money is, and who owes whom once the barber's pay setup is applied.
    cash: number; card: number; reader: number; other: number; cash_held_by: "BARBER" | "SHOP"; cash_held_by_barber: number; owed: number;
  }[];
  payments: (Payment & { customer_name: string; service_name: string; start_min: number })[];
};

const RANGES = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

function rangeFor(key: RangeKey, today: string) {
  if (key === "today") return { from: today, to: today };
  if (key === "week") {
    const d = new Date(today + "T12:00:00Z");
    const monday = datePlus(today, -((d.getUTCDay() + 6) % 7));
    return { from: monday, to: today };
  }
  return { from: today.slice(0, 8) + "01", to: today };
}

export function WalletDrawer({
  w,
  api,
  onClose,
  onOpenBooking,
}: {
  w: WorkspaceData;
  api: <T>(path: string) => Promise<T>;
  onClose: () => void;
  onOpenBooking: (id: string) => void;
}) {
  const [range, setRange] = useState<RangeKey>("today");
  const [data, setData] = useState<WalletData | null>(null);
  const [error, setError] = useState("");
  const barberView = w.account?.role === "BARBER";
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const r = rangeFor(range, w.today);
    setError("");
    api<WalletData>(`/wallet?from=${r.from}&to=${r.to}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not load the wallet."));
    return () => {
      cancelled = true;
    };
  }, [range, w.now, w.payments.length]);

  const t = data?.totals;
  const mine = barberView ? data?.by_staff.find((s) => s.staff_id === w.account?.staff_id) : null;
  const headline = barberView ? (mine?.earnings ?? 0) : (t ? t.service + t.tips : 0);
  const label = RANGES.find((r) => r.key === range)!.label.toLowerCase();

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer-right wallet-drawer" aria-label={barberView ? "My earnings" : "Shop wallet"} data-testid="wallet-drawer">
        <h2>
          {barberView ? "My earnings" : "Shop wallet"}
          <small>{data ? (data.from === data.to ? longDate(data.from) : `${shortDate(data.from)} – ${shortDate(data.to)}`) : "Loading…"}</small>
          <IconButton name="close" label="Close wallet" onClick={onClose} />
        </h2>
        <div className="segmented wallet-range" aria-label="Wallet period">
          {RANGES.map((r) => (
            <button key={r.key} type="button" aria-pressed={range === r.key} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        {error && (
          <p className="workspace-error" role="alert">
            {error}
          </p>
        )}
        <WalletHero
          label={barberView ? `Earned ${label}` : `Taken ${label}`}
          pill={data ? `${t!.visits} paid visit${t!.visits === 1 ? "" : "s"}` : undefined}
          amount={money(headline)}
          stats={
            barberView
              ? [
                  { value: money(mine?.commission ?? 0), label: mine?.pay_model === "CHAIR_RENT" ? "Your takings" : mine?.pay_model === "COMMISSION" ? "Commission" : "Pay" },
                  { value: money(mine?.tip_share ?? 0), label: "Tips" },
                  { value: money(mine?.deductions ?? 0), label: "Rent & deductions" },
                ]
              : [
                  { value: money(t?.service ?? 0), label: "Services" },
                  { value: money(t?.tips ?? 0), label: "Tips" },
                  { value: money(t?.unpaid_value ?? 0), label: `Booked, unpaid (${t?.unpaid_visits ?? 0})` },
                ]
          }
        />
        {!barberView && (
          <div className="method-grid" aria-label="By payment method">
            {METHODS.map((m) => (
              <div className="method-tile" key={m.key}>
                <Icon name={m.icon} size={18} />
                <b>{money((data?.by_method[m.key]?.service ?? 0) + (data?.by_method[m.key]?.tips ?? 0))}</b>
                {m.label}
              </div>
            ))}
          </div>
        )}
        {barberView && mine && <BarberMoney s={mine} name="You" self />}
        {!barberView && data && data.by_staff.length > 0 && (
          <section>
            <p className="list-label">By barber</p>
            <div className="wallet-barbers" data-testid="wallet-barbers">
              {data.by_staff
                .slice()
                .sort((a, b) => b.service + b.tips - (a.service + a.tips) || Math.abs(b.owed) - Math.abs(a.owed))
                .map((s) => (
                  <BarberMoney key={s.staff_id} s={s} name={w.staff.find((x) => x.id === s.staff_id)?.name || "Former barber"} terms={payLine(w.staff.find((x) => x.id === s.staff_id))} />
                ))}
            </div>
          </section>
        )}
        <section>
          <p className="list-label">Recent payments</p>
          {data && data.payments.length === 0 && <p className="drawer-note left">Nothing recorded {label} yet. Take payment from an appointment to add the first row.</p>}
          {data?.payments.slice(0, 40).map((p) => (
            <TxRow
              key={p.id}
              icon={METHODS.find((m) => m.key === p.method)?.icon || "card"}
              title={p.customer_name}
              caption={`${time(p.start_min)} · ${p.service_name}${p.voided_at ? " · VOIDED" : ""}${!barberView ? ` · ${w.staff.find((s) => s.id === p.staff_id)?.name.split(" ")[0] || ""}` : ""}`}
              amount={money(p.service_pence)}
              sub={p.tip_pence ? `+${money(p.tip_pence)} tip` : undefined}
              onClick={() => onOpenBooking(p.booking_id)}
            />
          ))}
        </section>
        {t && t.voided > 0 && (
          <StatusPill tone="warn">
            {t.voided} voided row{t.voided === 1 ? "" : "s"} excluded from totals
          </StatusPill>
        )}
        <div className="drawer-foot">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
        <p className="drawer-note">Ledger of recorded payments · foliyo never holds money</p>
      </aside>
    </>
  );
}

// One barber's money for the period: what was taken and how (cash / card / card reader), what their
// pay setup gives them, and who owes whom. Uses the same engine as pay runs.
type StaffMoney = WalletData["by_staff"][number];
function BarberMoney({ s, name, terms, self }: { s: StaffMoney; name: string; terms?: string; self?: boolean }) {
  const first = self ? "You" : name.split(" ")[0];
  const owedLine =
    s.owed === 0
      ? "Square — nothing owed either way"
      : s.owed > 0
        ? self ? `The shop owes you ${money(s.owed)}` : `Shop owes ${first} ${money(s.owed)}`
        : self ? `You owe the shop ${money(-s.owed)}` : `${first} owes the shop ${money(-s.owed)}`;
  return (
    <article className="wallet-barber" data-testid="wallet-barber" data-staff={s.staff_id}>
      <header>
        <strong>{name}</strong>
        <span>{money(s.service + s.tips)} taken · {s.visits} visit{s.visits === 1 ? "" : "s"}</span>
      </header>
      {terms && <small className="muted">{terms}</small>}
      <dl className="wallet-barber-split">
        <div><dt><Icon name="banknote" size={13} /> Cash</dt><dd data-testid="wb-cash">{money(s.cash)}</dd></div>
        <div><dt><Icon name="card" size={13} /> Card reader</dt><dd data-testid="wb-reader">{money(s.reader)}</dd></div>
        <div><dt><Icon name="globe" size={13} /> Card online</dt><dd data-testid="wb-card">{money(s.card)}</dd></div>
        {s.other > 0 && <div><dt><Icon name="receipt" size={13} /> Transfer / other</dt><dd data-testid="wb-other">{money(s.other)}</dd></div>}
      </dl>
      <dl className="wallet-barber-calc">
        <div><dt>{s.pay_model === "CHAIR_RENT" ? `${first === "You" ? "Your" : `${first}'s`} takings` : s.pay_model === "COMMISSION" ? "Commission" : "Pay"}</dt><dd>{money(s.commission)}</dd></div>
        {s.tip_share > 0 && <div><dt>Tips</dt><dd>+ {money(s.tip_share)}</dd></div>}
        {s.deduction_lines.filter((d) => d.pence).map((d, i) => <div key={i}><dt>{d.label}<small> · {d.detail}</small></dt><dd>− {money(d.pence)}</dd></div>)}
        <div className="strong"><dt>Earned{s.estimate ? " (so far)" : ""}</dt><dd data-testid="wb-earned">{money(s.earnings)}</dd></div>
        {s.cash_held_by_barber > 0 && <div><dt>Already kept in cash</dt><dd>− {money(s.cash_held_by_barber)}</dd></div>}
      </dl>
      <p className={`wallet-barber-owed ${s.owed < 0 ? "owes-shop" : s.owed > 0 ? "owed" : ""}`} data-testid="wb-owed">{owedLine}</p>
    </article>
  );
}
function payLine(st?: WorkspaceData["staff"][number]) {
  if (!st) return "";
  const rent = (() => { try { return (JSON.parse(st.deductions_json || "[]") as { label: string; kind: string; amount_pence: number; cadence: string; active: number }[]).filter((d) => d.active && d.kind === "FIXED").map((d) => `${d.label.toLowerCase()} ${money(d.amount_pence)}/${d.cadence === "DAILY" ? "day" : d.cadence === "WEEKLY" ? "week" : d.cadence === "MONTHLY" ? "month" : "run"}`); } catch { return []; } })();
  const tiers = (() => { try { return (JSON.parse(st.commission_tiers || "[]") as { from_pence: number; pct: number }[]).sort((a, b) => a.from_pence - b.from_pence); } catch { return []; } })();
  const commission = tiers.length ? tiers.map((t, i) => (i === 0 && t.from_pence === 0 ? `${t.pct}%` : `${t.pct}% above ${money(t.from_pence)}`)).join(", ") + " commission" : `${st.commission_pct}% commission`;
  const main = st.pay_model === "CHAIR_RENT" ? "Chair rent · keeps takings" : st.pay_model === "COMMISSION" ? commission : st.pay_model === "HOURLY" ? `${money(st.hourly_pence)}/hour` : st.pay_model === "SALARY" ? `${money(st.base_pence)} salary` : `${money(st.base_pence)} + ${st.commission_pct}%`;
  return [main, ...rent, `tips ${st.tip_share_pct}%`].join(" · ");
}
const longDate = (d: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date(d + "T12:00:00Z"));
const shortDate = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(d + "T12:00:00Z"));
