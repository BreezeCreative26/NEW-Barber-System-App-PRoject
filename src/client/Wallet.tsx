// Shop wallet drawer (owner/manager) and barber earnings view. Reads the payments ledger only.
// Model A: money never sits in the app — these are totals of what was recorded at the chair.
import { useEffect, useState } from "react";
import type { Payment, WorkspaceData } from "../server/domain";
import { Button, Icon, IconButton, KPI, StatusPill, TxRow, WalletHero } from "./ui";
import { METHODS } from "./Checkout";
import { money, time, datePlus } from "./fixtures";

export type WalletData = {
  from: string;
  to: string;
  today: string;
  till_access: "OWNER" | "ALL";
  totals: { service: number; tips: number; discounts: number; visits: number; voided: number; unpaid_value: number; unpaid_visits: number };
  by_method: Record<string, { service: number; tips: number; count: number }>;
  by_staff: { staff_id: string; service: number; tips: number; commission: number; earnings: number; visits: number }[];
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
                  { value: money(mine?.commission ?? 0), label: "Commission" },
                  { value: money(mine?.tips ?? 0), label: "Tips" },
                  { value: money(mine?.service ?? 0), label: "Services taken" },
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
        {!barberView && data && data.by_staff.length > 0 && (
          <section>
            <p className="list-label">By barber</p>
            <div className="kpi-grid wallet-staff">
              {data.by_staff
                .slice()
                .sort((a, b) => b.service - a.service)
                .map((s) => {
                  const st = w.staff.find((x) => x.id === s.staff_id);
                  return (
                    <KPI
                      key={s.staff_id}
                      icon="user"
                      label={st?.name || "Former barber"}
                      value={money(s.service + s.tips)}
                      delta={`${s.visits} visit${s.visits === 1 ? "" : "s"} · owes ${money(s.earnings)} (${st?.commission_pct ?? "–"}% + tips)`}
                    />
                  );
                })}
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
        <p className="drawer-note">Ledger of recorded payments · OLLO never holds money · local test data</p>
      </aside>
    </>
  );
}

const longDate = (d: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date(d + "T12:00:00Z"));
const shortDate = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(d + "T12:00:00Z"));
