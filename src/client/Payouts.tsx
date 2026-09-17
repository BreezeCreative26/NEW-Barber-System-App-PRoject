// Payments: OLLO is the Stripe platform. Settings → Payments (owner) shows provider status, the
// shop's Stripe account, every barber's account, deposit + payout policy and 30-day money moved.
// BarberPayoutCard (Team → barber → Pay) lets a barber be set up and see their own wallet.
import { useEffect, useState } from "react";
import type React from "react";
import { Button, Icon, Notice, StatusPill } from "./ui";
import { money } from "./fixtures";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type AcctState = { key: "none" | "onboarding" | "restricted" | "active"; label: string };
type BarberRow = { id: string; name: string; role: string; active: number; account: { id: string; email: string; payout_schedule: string; details_submitted: number; payouts_enabled: number } | null; state: AcctState };
export type PaymentsData = {
  stripe: { provider: "stripe" | "none"; mode: "live" | "test" | "preview"; connect: boolean; webhook: boolean };
  platform: { fee_bps: number; fee_fixed_pence: number; fast_payouts: number };
  settings: { deposits_online: number; deposit_hold_min: number; deposit_pence: number; payout_tier: "STANDARD" | "FAST"; payrun_auto: "OFF" | "DAILY" | "WEEKLY"; payrun_reserve_bps: number };
  shop_account: ({ id: string; payout_schedule: string; details_submitted: number; payouts_enabled: number; state: AcctState }) | null;
  barbers: BarberRow[];
  active: boolean;
  payouts_ready: boolean;
  totals_30d: { deposits_pence: number; deposits: number; refunded: number; expired: number; pending: number; to_barbers: number; to_shop: number; reversed: number };
};
const tone = (k: AcctState["key"]) => (k === "active" ? "good" : k === "none" ? "note" : k === "onboarding" ? "next" : "warn");

export function PaymentsPanel({ api, canEdit, isOwner }: { api: Api; canEdit: boolean; isOwner: boolean }) {
  const [data, setData] = useState<PaymentsData | null>(null);
  const [form, setForm] = useState<PaymentsData["settings"] | null>(null);
  const [balance, setBalance] = useState<{ available_pence: number; pending_pence: number; live: boolean } | null>(null);
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" | "error"; text: string }>({ kind: "idle", text: "" });
  const [busy, setBusy] = useState("");
  const load = () =>
    api<PaymentsData>("/shop/payments")
      .then((d) => {
        setData(d);
        setForm((f) => f ?? d.settings);
      })
      .catch((e) => setState({ kind: "error", text: e instanceof Error ? e.message : "Could not load." }));
  useEffect(() => {
    load();
    if (canEdit) api<{ available_pence: number; pending_pence: number; live: boolean }>("/payments/balance").then(setBalance).catch(() => null);
  }, []);
  // Back from Stripe onboarding: refresh the account that was being set up.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("stripe") !== "return" || !data) return;
    const who = q.get("for");
    const acct = who === "shop" ? data.shop_account?.id : data.barbers.find((b) => b.id === who)?.account?.id;
    history.replaceState(null, "", location.pathname);
    if (acct) api(`/payments/accounts/${acct}/refresh`, "POST", {}).then(load).catch(() => null);
  }, [data?.shop_account?.id]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setState({ kind: "idle", text: "" });
    try {
      await fn();
      await load();
    } catch (e) {
      setState({ kind: "error", text: e instanceof Error ? e.message : "Could not save." });
    } finally {
      setBusy("");
    }
  }
  async function save() {
    if (!form) return;
    setState({ kind: "saving", text: "" });
    try {
      const { deposit_pence: _ro, ...body } = form;
      void _ro;
      await api("/shop/payments", "PUT", body);
      setState({ kind: "saved", text: "Saved." });
      await load();
    } catch (e) {
      setState({ kind: "error", text: e instanceof Error ? e.message : "Could not save." });
    }
  }
  async function connect(path: string) {
    const r = await api<{ url: string }>(path, "POST", {});
    window.location.assign(r.url);
  }
  async function dashboard(accountId: string) {
    const r = await api<{ url: string }>(`/payments/accounts/${accountId}/dashboard`, "POST", {});
    window.open(r.url, "_blank", "noopener");
  }

  const live = data?.stripe.provider === "stripe";
  return (
    <section className="workspace-panel" aria-labelledby="payments-heading" data-testid="payments-panel">
      <div className="workspace-section-heading">
        <div>
          <h2 id="payments-heading">Payments</h2>
          <p className="workspace-footnote">Card money is taken by OLLO and paid straight to each barber's and the shop's own Stripe account when a pay run is approved. Cash never leaves the chair — the pay run shows what to settle by hand.</p>
        </div>
        {data && (
          <StatusPill tone={live ? "good" : "note"} data-testid="payments-status">
            {live ? `Card payments ${data.stripe.mode === "test" ? "· test mode" : "live"}` : "Card payments not switched on yet"}
          </StatusPill>
        )}
      </div>
      {data && !live && (
        <Notice icon="card">
          <span>
            <strong>Everything below is ready.</strong> Once OLLO's Stripe keys are added, deposits can be taken at booking and pay runs move money to each barber automatically. Until then deposits are payable in the shop and pay runs are settled by hand.
          </span>
        </Notice>
      )}

      {data && (
        <div className="payments-grid">
          {/* Shop account */}
          <section className="panel-card payments-card" aria-label="Shop Stripe account">
            <h3>
              <Icon name="landmark" size={15} /> Shop account
            </h3>
            <p className="workspace-footnote">Where the shop's share of card takings lands. Pays out to the shop's bank on Stripe's schedule.</p>
            <StatusPill tone={tone(data.shop_account?.state.key ?? "none")} data-testid="shop-account-state">
              {data.shop_account?.state.label ?? "Not connected"}
            </StatusPill>
            <div className="panel-actions-row">
              {isOwner && (!data.shop_account || data.shop_account.state.key !== "active") && (
                <Button disabled={!live || !!busy} data-testid="connect-shop" onClick={() => run("shop", () => connect("/shop/payments/connect"))}>
                  <Icon name="link" size={15} /> {data.shop_account ? "Continue setup" : "Set up shop payouts"}
                </Button>
              )}
              {data.shop_account && canEdit && (
                <>
                  <Button variant="ghost" disabled={!live || !!busy} onClick={() => run("dash", () => dashboard(data.shop_account!.id))}>
                    <Icon name="globe" size={15} /> Stripe dashboard
                  </Button>
                  <Button variant="ghost" disabled={!live || !!busy} onClick={() => run("refresh", () => api(`/payments/accounts/${data.shop_account!.id}/refresh`, "POST", {}))}>
                    Refresh
                  </Button>
                </>
              )}
            </div>
          </section>

          {/* Float / balance */}
          {canEdit && (
            <section className="panel-card payments-card" aria-label="Platform balance">
              <h3>
                <Icon name="wallet" size={15} /> OLLO balance
              </h3>
              <p className="workspace-footnote">Card money sits here between the customer paying and the pay run sending it on. “Available” is what can move today.</p>
              <dl className="payments-figures">
                <div>
                  <dt>Available</dt>
                  <dd data-testid="balance-available">{balance?.live ? money(balance.available_pence) : "—"}</dd>
                </div>
                <div>
                  <dt>Settling</dt>
                  <dd>{balance?.live ? money(balance.pending_pence) : "—"}</dd>
                </div>
                <div>
                  <dt>OLLO fee</dt>
                  <dd>
                    {(data.platform.fee_bps / 100).toFixed(2)}%{data.platform.fee_fixed_pence ? ` + ${money(data.platform.fee_fixed_pence)}` : ""}
                  </dd>
                </div>
              </dl>
            </section>
          )}

          {/* 30 days */}
          <section className="panel-card payments-card" aria-label="Last 30 days">
            <h3>
              <Icon name="chart" size={15} /> Last 30 days
            </h3>
            <dl className="payments-figures">
              <div>
                <dt>Deposits taken</dt>
                <dd data-testid="deposits-30d">{money(data.totals_30d.deposits_pence)}</dd>
              </div>
              <div>
                <dt>Sent to barbers</dt>
                <dd data-testid="to-barbers-30d">{money(data.totals_30d.to_barbers)}</dd>
              </div>
              <div>
                <dt>Sent to shop</dt>
                <dd>{money(data.totals_30d.to_shop)}</dd>
              </div>
              {data.totals_30d.reversed > 0 && (
                <div>
                  <dt>Clawed back</dt>
                  <dd>{money(data.totals_30d.reversed)}</dd>
                </div>
              )}
            </dl>
          </section>
        </div>
      )}

      {/* Barbers */}
      {data && data.barbers.length > 0 && (
        <section className="payments-barbers" aria-label="Barber payout accounts">
          <h3>Barber payouts</h3>
          <p className="workspace-footnote">Each barber gets their own Stripe account so their share never sits in the shop's. Setup takes about five minutes on their phone: name, date of birth, bank details, ID.</p>
          <ul className="payments-barber-list">
            {data.barbers.map((b) => (
              <li key={b.id} data-testid="barber-payout-row" data-state={b.state.key}>
                <div>
                  <strong>{b.name}</strong>
                  <small>{b.role.toLowerCase()}{!b.active ? " · inactive" : ""}{b.account?.email ? ` · ${b.account.email}` : ""}</small>
                </div>
                <StatusPill tone={tone(b.state.key)}>{b.state.label}</StatusPill>
                {canEdit && (
                  <div className="row-actions">
                    {b.state.key !== "active" && (
                      <Button variant="secondary" disabled={!live || !!busy} data-testid="connect-barber" onClick={() => run(b.id, () => connect(`/staff/${b.id}/payments/connect`))}>
                        {b.account ? "Continue setup" : "Set up payouts"}
                      </Button>
                    )}
                    {b.account && (
                      <Button variant="ghost" disabled={!live || !!busy} onClick={() => run(`r-${b.id}`, () => api(`/payments/accounts/${b.account!.id}/refresh`, "POST", {}))}>
                        Refresh
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Card readers */}
      {data && canEdit && <ReadersCard api={api} live={live} />}

      {/* Policy */}
      {form && canEdit && (
        <form
          className="workspace-form payments-form"
          data-testid="payments-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <h3>Policy</h3>
          <div className="workspace-form-grid">
            <label className="workspace-toggle">
              <input type="checkbox" data-testid="deposits-online" checked={form.deposits_online === 1} disabled={!live} onChange={(e) => setForm({ ...form, deposits_online: e.target.checked ? 1 : 0 })} />
              <span>
                <strong>Take the deposit by card at booking</strong>
                <small>{money(data!.settings.deposit_pence)} from Settings → Shop. Refunded automatically if the customer cancels in time; kept if they don't.</small>
              </span>
            </label>
            <label className="workspace-field narrow">
              <span>Hold the slot for (minutes)</span>
              <input type="number" min={5} max={120} data-testid="deposit-hold" value={form.deposit_hold_min} onChange={(e) => setForm({ ...form, deposit_hold_min: Number(e.target.value) || 15 })} />
            </label>
            <label className="workspace-field">
              <span>Payout speed</span>
              <select data-testid="payout-tier" value={form.payout_tier} onChange={(e) => setForm({ ...form, payout_tier: e.target.value as "STANDARD" | "FAST" })}>
                <option value="STANDARD">Standard — after card settlement (about 3 working days)</option>
                <option value="FAST" disabled={!data!.platform.fast_payouts}>Fast — same day the run is approved</option>
              </select>
            </label>
            <label className="workspace-field">
              <span>Automatic pay runs</span>
              <select data-testid="payrun-auto" value={form.payrun_auto} onChange={(e) => setForm({ ...form, payrun_auto: e.target.value as "OFF" | "DAILY" | "WEEKLY" })}>
                <option value="OFF">Off — I approve each run</option>
                <option value="DAILY">Daily — yesterday's card money, every morning</option>
                <option value="WEEKLY">Weekly — Monday for last Mon–Sun</option>
              </select>
            </label>
            <label className="workspace-field narrow">
              <span>Hold back against disputes (%)</span>
              <input type="number" min={0} max={50} step="0.5" data-testid="reserve-pct" value={form.payrun_reserve_bps / 100} onChange={(e) => setForm({ ...form, payrun_reserve_bps: Math.round((Number(e.target.value) || 0) * 100) })} />
            </label>
          </div>
          {state.text && (
            <p className={state.kind === "error" ? "workspace-error" : "workspace-success"} role={state.kind === "error" ? "alert" : "status"}>
              {state.text}
            </p>
          )}
          <div className="workspace-form-actions">
            <Button type="submit" disabled={state.kind === "saving"} data-testid="save-payments">
              {state.kind === "saving" ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      )}
      {state.kind === "error" && !form && (
        <p className="workspace-error" role="alert">
          {state.text}
        </p>
      )}
    </section>
  );
}

// Barber-facing: set up payouts, see the four honest lines, open the Stripe dashboard.
type Wallet = {
  account: { id: string; payout_schedule: string; payouts_enabled: number } | null;
  state: AcctState;
  transferred_pence: number;
  paid_out_pence: number;
  in_transit_pence: number;
  transfers: { id: string; kind: string; amount_pence: number; created_at: number; period_from?: string; period_to?: string; status: string }[];
};
export function BarberPayoutCard({ api, staffId, staffName, canEdit, from, to, earned, cash }: { api: Api; staffId: string; staffName: string; canEdit: boolean; from: string; to: string; earned: number; cash: number }) {
  const [w, setW] = useState<Wallet | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => api<Wallet>(`/payments/wallet?owner=STAFF&id=${staffId}&from=${from}&to=${to}`).then(setW).catch((e) => setError(e instanceof Error ? e.message : "Could not load."));
  useEffect(() => {
    load();
    api<PaymentsData>("/shop/payments").then((d) => setLive(d.stripe.provider === "stripe")).catch(() => null);
  }, [staffId, from, to]);
  async function go(fn: () => Promise<{ url: string }>, newTab = false) {
    setBusy(true);
    setError("");
    try {
      const r = await fn();
      if (newTab) window.open(r.url, "_blank", "noopener");
      else window.location.assign(r.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open Stripe.");
    } finally {
      setBusy(false);
    }
  }
  const first = staffName.split(" ")[0];
  return (
    <section className="panel-card barber-payout" aria-label={`${first}'s payouts`} data-testid="barber-payout">
      <header className="checkout-head">
        <strong>
          <Icon name="wallet" size={16} /> {first}'s payouts
        </strong>
        {w && <StatusPill tone={tone(w.state.key)} data-testid="barber-payout-state">{w.state.label}</StatusPill>}
      </header>
      <dl className="wallet-lines">
        <div>
          <dt>Earned (ledger)</dt>
          <dd>{money(earned)}</dd>
        </div>
        <div>
          <dt>Sent to {first}'s Stripe</dt>
          <dd data-testid="wallet-transferred">{money(w?.transferred_pence ?? 0)}</dd>
        </div>
        <div>
          <dt>Reached the bank</dt>
          <dd data-testid="wallet-paid-out">
            {money(w?.paid_out_pence ?? 0)}
            {w && w.in_transit_pence > 0 && <small> · {money(w.in_transit_pence)} on its way</small>}
          </dd>
        </div>
        <div>
          <dt>Taken in cash</dt>
          <dd>{money(cash)}</dd>
        </div>
      </dl>
      {error && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}
      <div className="panel-actions-row">
        {w && w.state.key !== "active" && (
          <Button disabled={!live || busy} data-testid="barber-connect" onClick={() => go(() => api(`/staff/${staffId}/payments/connect`, "POST", {}))}>
            <Icon name="link" size={15} /> {w.account ? "Continue Stripe setup" : "Set up payouts"}
          </Button>
        )}
        {w?.account && (
          <Button variant="ghost" disabled={!live || busy} onClick={() => go(() => api(`/payments/accounts/${w.account!.id}/dashboard`, "POST", {}), true)}>
            <Icon name="globe" size={15} /> Balance & payouts
          </Button>
        )}
        {w?.account && canEdit && (
          <label className="workspace-field narrow inline">
            <span>Pays out</span>
            <select
              value={w.account.payout_schedule}
              disabled={!live || busy}
              onChange={(e) => api(`/payments/accounts/${w.account!.id}/schedule`, "PUT", { interval: e.target.value }).then(load).catch((err) => setError(err instanceof Error ? err.message : "Could not change."))}
            >
              <option value="daily">daily</option>
              <option value="weekly">weekly (Fridays)</option>
              <option value="monthly">monthly</option>
            </select>
          </label>
        )}
      </div>
      {!live && <p className="workspace-footnote">Card payouts switch on when OLLO's Stripe keys are added. Nothing for {first} to do yet.</p>}
      {w && w.transfers.length > 0 && (
        <details className="pay-history">
          <summary>
            <Icon name="list" size={14} /> Stripe transfers ({w.transfers.length})
          </summary>
          <ul className="transfer-list">
            {w.transfers.map((t) => (
              <li key={t.id}>
                <span>
                  {t.kind === "REVERSAL" ? "Clawed back" : "Sent"}
                  {t.period_from ? ` · ${t.period_from} – ${t.period_to}` : ""}
                </span>
                <strong>{t.amount_pence < 0 ? "−" : ""}{money(Math.abs(t.amount_pence))}</strong>
                <small>{t.status.toLowerCase()}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// Terminal readers paired to the shop (WisePOS / Tap to Pay registers as a reader).
function ReadersCard({ api, live }: { api: Api; live: boolean }) {
  const [readers, setReaders] = useState<{ id: string; label: string; device_type: string; status: string }[]>([]);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api<{ readers: typeof readers }>("/terminal/readers").then((r) => setReaders(r.readers)).catch(() => null);
  useEffect(() => { load(); }, []);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await api("/terminal/readers", "POST", { code: code.trim(), label: label.trim() }); setCode(""); setLabel(""); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not add the reader."); }
    finally { setBusy(false); }
  }
  return (
    <section className="payments-barbers" aria-label="Card readers" data-testid="readers-card">
      <h3>Card readers</h3>
      <p className="workspace-footnote">Pair a Stripe reader (WisePOS E, or Tap to Pay on a phone) by typing the code it shows. At checkout the amount goes to the reader and the customer taps. No reader? Use <strong>Pay link / QR</strong> at checkout — works on any phone.</p>
      {readers.length > 0 && (
        <ul className="payments-barber-list">
          {readers.map((r) => (
            <li key={r.id}>
              <div><strong>{r.label}</strong><small>{r.device_type || "reader"} · {r.id}</small></div>
              <StatusPill tone={r.status === "online" ? "good" : "note"}>{r.status}</StatusPill>
              <div className="row-actions">
                <Button variant="ghost" disabled={!live || busy} onClick={() => api(`/terminal/readers/${r.id}/refresh`, "POST", {}).then(load).catch(() => null)}>Refresh</Button>
                <Button variant="ghost" disabled={busy} onClick={() => { if (confirm(`Remove ${r.label}?`)) api(`/terminal/readers/${r.id}`, "DELETE").then(load).catch(() => null); }}>Remove</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="reader-add" onSubmit={add} data-testid="reader-form">
        <label className="workspace-field narrow"><span>Pairing code</span><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. sepia-cerulean-orynx" disabled={!live} data-testid="reader-code" /></label>
        <label className="workspace-field narrow"><span>Name</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Front desk" disabled={!live} data-testid="reader-label" /></label>
        <Button type="submit" variant="secondary" disabled={!live || busy || !code.trim() || !label.trim()} data-testid="reader-add">Add reader</Button>
      </form>
      {error && <p className="workspace-error" role="alert">{error}</p>}
    </section>
  );
}
