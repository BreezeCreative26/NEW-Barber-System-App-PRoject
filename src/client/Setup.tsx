// Shop setup wizard — /workspace/setup. Seven optional steps onto settings that already exist,
// plus the setup-only pieces: contact verification, starter menu, invite-by-text, "send me a test".
// State is server-side (shops.setup_json) so it resumes on any device.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Shop, WorkspaceData } from "../server/domain";
import { Badge, Button, Icon } from "./ui";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export type SetupStep = "shop" | "hours" | "services" | "team" | "messages" | "online" | "payments";
type SetupState = { step: SetupStep; done: SetupStep[]; skipped: SetupStep[]; completed_at: number | null; started_at: number | null; dismissed: boolean };
type Progress = {
  shop: { saved: boolean; phone: string; email: string; phone_verified: boolean; email_verified: boolean };
  services: { count: number };
  team: { staff: number; invited: number; joined: number };
  messages: { sms_sender: string; providers: { email: { provider: string; from: string }; sms: { provider: string; from: string }; wa?: { provider: string; sender: string; test_sender: boolean; keyword: string } } };
  online: { slug: string; live: boolean };
  payments: { deposits_online: boolean; mode: string; connected: boolean };
};
type SetupData = { state: SetupState; progress: Progress; kind: "BARBER" | "HAIR" | "SALON"; bank_holidays: Record<string, string> };

const STEPS: { key: SetupStep; label: string; short: string }[] = [
  { key: "shop", label: "Your shop", short: "Shop" },
  { key: "hours", label: "Opening hours", short: "Hours" },
  { key: "services", label: "Services & prices", short: "Services" },
  { key: "team", label: "Your team", short: "Team" },
  { key: "messages", label: "Customer messages", short: "Messages" },
  { key: "online", label: "Online booking", short: "Online" },
  { key: "payments", label: "Deposits & payments", short: "Payments" },
];
const KIND_LABEL = { BARBER: "Barbershop", HAIR: "Hairdresser", SALON: "Salon" } as const;
const clock = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const minute = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function SetupWizard({ w, api, refresh, onExit, goTo }: { w: WorkspaceData; api: Api; refresh: () => Promise<void>; onExit: () => void; goTo: (tab: string) => void }) {
  const [data, setData] = useState<SetupData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [step, setStep] = useState<SetupStep>("shop");
  const load = async () => {
    const d = await api<SetupData>("/setup");
    setData(d);
    return d;
  };
  useEffect(() => {
    load().then((d) => setStep(d.state.completed_at ? "shop" : d.state.step)).catch((e) => setError(e.message));
  }, []);
  const idx = STEPS.findIndex((s) => s.key === step);
  async function mark(kind: "done" | "skipped", key: SetupStep) {
    const next = STEPS[idx + 1]?.key;
    const body: Record<string, unknown> = { [kind]: key };
    if (next) body.step = next;
    else body.complete = true;
    const r = await api<{ state: SetupState }>("/setup/state", "PUT", body);
    setData((d) => (d ? { ...d, state: r.state } : d));
    await refresh();
    await load();
    if (next) { setStep(next); setNotice(""); window.scrollTo({ top: 0, behavior: "smooth" }); }
    else setStep("payments");
  }
  async function jump(key: SetupStep) {
    setStep(key); setNotice(""); setError("");
    api("/setup/state", "PUT", { step: key }).catch(() => {});
  }
  if (error && !data) return <section className="workspace-panel setup-wiz"><p className="workspace-error" role="alert">{error}</p></section>;
  if (!data) return <section className="workspace-panel setup-wiz"><p role="status">Loading setup…</p></section>;
  const doneSet = new Set([...data.state.done]);
  const complete = !!data.state.completed_at;
  const common = { w, api, refresh, data, reload: load, setNotice, setError, goTo };
  return (
    <section className="setup-wiz" aria-labelledby="setup-wiz-heading" data-testid="setup-wizard">
      <header className="setup-wiz-head">
        <div>
          <p className="setup-wiz-kicker">{complete ? "Setup" : `Step ${idx + 1} of ${STEPS.length}`}</p>
          <h2 id="setup-wiz-heading">{complete ? `${w.shop.name} is set up` : STEPS[idx].label}</h2>
        </div>
        <button type="button" className="linklike" onClick={onExit} data-testid="setup-exit">{complete ? "Back to the calendar" : "Finish later"}</button>
      </header>
      <ol className="setup-wiz-steps" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li key={s.key} data-current={s.key === step} data-done={doneSet.has(s.key)} data-skipped={data.state.skipped.includes(s.key) && !doneSet.has(s.key)}>
            <button type="button" onClick={() => jump(s.key)} aria-current={s.key === step ? "step" : undefined}>
              <span className="setup-wiz-num" aria-hidden="true">{doneSet.has(s.key) ? <Icon name="check" size={12} /> : i + 1}</span>
              <span>{s.short}</span>
            </button>
          </li>
        ))}
      </ol>
      {notice && <p className="workspace-success" role="status">{notice}</p>}
      {error && <p className="workspace-error" role="alert">{error}</p>}
      <div className="setup-wiz-body">
        {step === "shop" && <StepShop {...common} onNext={() => mark("done", "shop")} />}
        {step === "hours" && <StepHours {...common} onNext={() => mark("done", "hours")} onSkip={() => mark("skipped", "hours")} />}
        {step === "services" && <StepServices {...common} onNext={() => mark("done", "services")} onSkip={() => mark("skipped", "services")} />}
        {step === "team" && <StepTeam {...common} onNext={() => mark("done", "team")} onSkip={() => mark("skipped", "team")} />}
        {step === "messages" && <StepMessages {...common} onNext={() => mark("done", "messages")} onSkip={() => mark("skipped", "messages")} />}
        {step === "online" && <StepOnline {...common} onNext={() => mark("done", "online")} onSkip={() => mark("skipped", "online")} />}
        {step === "payments" && <StepPayments {...common} onNext={() => mark("done", "payments")} onSkip={() => mark("skipped", "payments")} complete={complete} onExit={onExit} />}
      </div>
    </section>
  );
}

type StepProps = { w: WorkspaceData; api: Api; refresh: () => Promise<void>; data: SetupData; reload: () => Promise<SetupData>; setNotice: (s: string) => void; setError: (s: string) => void; goTo: (tab: string) => void; onNext: () => Promise<void>; onSkip?: () => Promise<void> };

function StepActions({ onNext, onSkip, nextLabel = "Save and continue", busy, skipLabel = "Skip for now", children }: { onNext: () => void; onSkip?: () => void; nextLabel?: string; busy?: boolean; skipLabel?: string; children?: ReactNode }) {
  return (
    <div className="setup-wiz-actions">
      {children}
      {onSkip && <Button variant="ghost" onClick={onSkip} disabled={busy} data-testid="setup-skip">{skipLabel}</Button>}
      <Button onClick={onNext} disabled={busy} data-testid="setup-next">{busy ? "Saving…" : nextLabel}</Button>
    </div>
  );
}
function F({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="workspace-field">
      <span>{label}</span>
      {children}
      {hint && <small className="helper">{hint}</small>}
    </label>
  );
}
function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>, setError: (s: string) => void) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); } finally { setBusy(false); }
  };
  return { busy, run };
}

// ---- 1. Your shop ---------------------------------------------------------------------------------
function StepShop({ w, api, refresh, data, reload, setNotice, setError, onNext }: StepProps) {
  const shop = w.shop as Shop & { phone?: string; email?: string; kind?: string; phone_verified_at?: number | null; email_verified_at?: number | null };
  const [form, setForm] = useState({ name: shop.name, kind: (shop.kind || data.kind || "BARBER") as "BARBER" | "HAIR" | "SALON", phone: shop.phone || "", email: shop.email || w.account?.email || "", address: shop.address || "", timezone: shop.timezone || "Europe/London", currency: (shop.currency || "GBP") as "GBP" | "EUR" | "USD" });
  const { busy, run } = useBusy();
  // After a save the server normalises the mobile (+44…) — take its values so the form isn't "dirty".
  useEffect(() => { setForm((f) => ({ ...f, name: shop.name, phone: shop.phone || "", email: shop.email || f.email, address: shop.address || "", kind: (shop.kind || f.kind) as "BARBER" })); }, [shop.version]);
  const dirty = form.name !== shop.name || form.kind !== (shop.kind || "BARBER") || form.phone !== (shop.phone || "") || form.email !== (shop.email || "") || form.address !== (shop.address || "") || form.currency !== shop.currency;
  async function save() {
    await api("/setup/contact", "PUT", form);
    await refresh(); await reload();
  }
  return (
    <div className="setup-wiz-card">
      <p className="setup-wiz-lead">The basics customers see on every message and on your booking page. Nothing here is public until you switch online booking on.</p>
      <div className="setup-kind" role="radiogroup" aria-label="What kind of shop">
        {(["BARBER", "HAIR", "SALON"] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={form.kind === k} onClick={() => setForm({ ...form, kind: k })} data-testid={`setup-kind-${k}`}>
            <Icon name={k === "BARBER" ? "razor" : k === "HAIR" ? "scissors" : "sparkles"} />
            <strong>{KIND_LABEL[k]}</strong>
            <span>{k === "BARBER" ? "Fades, beards, walk-ins" : k === "HAIR" ? "Cuts, colour, blow-dries" : "Hair, nails, brows, skin"}</span>
          </button>
        ))}
      </div>
      <div className="setup-grid-2">
        <F label="Shop name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={100} data-testid="setup-shop-name" /></F>
        <F label="Currency"><select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value as "GBP" })}><option value="GBP">£ GBP</option><option value="EUR">€ EUR</option><option value="USD">$ USD</option></select></F>
        <F label="Shop mobile" hint="For verification codes, password resets and booking alerts. Customers don't see it unless you add it to your shop page.">
          <input type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="07700 900123" maxLength={20} data-testid="setup-shop-phone" />
        </F>
        <F label="Shop email" hint="Replies to customer emails go here.">
          <input type="email" inputMode="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={254} data-testid="setup-shop-email" />
        </F>
        <F label="Address" hint="Shown on confirmations so people can find you."><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} maxLength={300} placeholder="12 High Street, Leeds LS1 4AB" /></F>
        <F label="Timezone"><input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} maxLength={64} /></F>
      </div>
      {(shop.phone || shop.email) && !dirty && (
        <div className="setup-verify">
          {shop.phone && <VerifyRow kind="PHONE" target={shop.phone} verified={!!shop.phone_verified_at} api={api} refresh={refresh} reload={reload} setNotice={setNotice} setError={setError} />}
          {shop.email && <VerifyRow kind="EMAIL" target={shop.email} verified={!!shop.email_verified_at} api={api} refresh={refresh} reload={reload} setNotice={setNotice} setError={setError} />}
          <p className="helper">Verifying is optional — it just proves the details are yours before we send codes or alerts to them.</p>
        </div>
      )}
      <StepActions busy={busy} nextLabel={dirty ? "Save and continue" : "Continue"} onNext={() => run(async () => { if (dirty) await save(); await onNext(); }, setError)}>
        {dirty && <Button variant="secondary" disabled={busy} onClick={() => run(async () => { await save(); setNotice("Saved. Verify your number and email below if you like."); }, setError)} data-testid="setup-save-contact">Save</Button>}
      </StepActions>
    </div>
  );
}
function VerifyRow({ kind, target, verified, api, refresh, reload, setNotice, setError }: { kind: "PHONE" | "EMAIL"; target: string; verified: boolean; api: Api; refresh: () => Promise<void>; reload: () => Promise<unknown>; setNotice: (s: string) => void; setError: (s: string) => void }) {
  const [sent, setSent] = useState<{ delivery: string; sandbox_code?: string } | null>(null);
  const [code, setCode] = useState("");
  const { busy, run } = useBusy();
  if (verified) return <p className="setup-verify-row" data-testid={`verified-${kind}`}><Badge tone="good">Verified</Badge> <span>{target}</span></p>;
  return (
    <div className="setup-verify-row">
      <span><Icon name={kind === "PHONE" ? "phone" : "message"} size={14} /> {target}</span>
      {!sent ? (
        <Button variant="secondary" disabled={busy} onClick={() => run(async () => { const r = await api<{ delivery: string; sandbox_code?: string }>("/setup/verify/start", "POST", { kind }); setSent(r); }, setError)} data-testid={`verify-send-${kind}`}>
          {busy ? "Sending…" : kind === "PHONE" ? "Text me a code" : "Email me a code"}
        </Button>
      ) : (
        <form className="setup-code" onSubmit={(e) => { e.preventDefault(); run(async () => { await api("/setup/verify/confirm", "POST", { kind, code }); setNotice(`${kind === "PHONE" ? "Mobile" : "Email"} verified.`); await refresh(); await reload(); }, setError); }}>
          <input inputMode="numeric" pattern="\d{6}" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} aria-label="Verification code" data-testid={`verify-code-${kind}`} autoFocus />
          <Button type="submit" disabled={busy || code.length !== 6}>Confirm</Button>
          {sent.sandbox_code && <small className="helper">No {kind === "PHONE" ? "SMS" : "email"} provider is connected, so here's the code: <code data-testid={`sandbox-code-${kind}`}>{sent.sandbox_code}</code></small>}
          {!sent.sandbox_code && <small className="helper">Sent by {sent.delivery}. Expires in 10 minutes.</small>}
        </form>
      )}
    </div>
  );
}

// ---- 2. Hours ------------------------------------------------------------------------------------
function StepHours({ w, api, refresh, data, setError, onNext, onSkip }: StepProps) {
  const week = useMemo(() => { try { return JSON.parse(w.shop.week_json) as { enabled: 0 | 1; starts: number; ends: number }[]; } catch { return DAYS.map((_, i) => ({ enabled: i === 0 ? 0 : 1, starts: 540, ends: 1080 })) as { enabled: 0 | 1; starts: number; ends: number }[]; } }, [w.shop.week_json]);
  const [days, setDays] = useState(week);
  const [closeBank, setCloseBank] = useState(true);
  const { busy, run } = useBusy();
  const order = [1, 2, 3, 4, 5, 6, 0];
  const upcoming = Object.entries(data.bank_holidays).filter(([d]) => d >= w.today).slice(0, 8);
  const already = new Set(w.holidays.map((h) => h.date));
  async function save() {
    await api("/shop", "PUT", {
      name: w.shop.name, address: w.shop.address, timezone: w.shop.timezone, currency: w.shop.currency,
      week: days.map((d) => ({ enabled: d.enabled, starts: d.starts, ends: d.ends })),
      deposit_pence: w.shop.deposit_pence, cancel_hours: w.shop.cancel_hours, no_show_grace: w.shop.no_show_grace, till_access: w.shop.till_access, version: w.shop.version,
    });
    if (closeBank) for (const [date, name] of upcoming) if (!already.has(date)) await api("/holidays", "POST", { date, label: name }).catch(() => {});
    await refresh();
  }
  return (
    <div className="setup-wiz-card">
      <p className="setup-wiz-lead">When the shop is open. Each barber gets these hours to start with; change theirs individually from Team.</p>
      <div className="setup-hours">
        {order.map((i) => {
          const d = days[i];
          return (
            <div className="setup-hours-row" key={i} data-off={!d.enabled}>
              <label className="setup-hours-day"><input type="checkbox" checked={!!d.enabled} onChange={(e) => setDays(days.map((x, j) => (j === i ? { ...x, enabled: e.target.checked ? 1 : 0 } : x)))} /> {DAYS[i]}</label>
              {d.enabled ? (
                <span className="setup-hours-times">
                  <input type="time" value={clock(d.starts)} step={900} onChange={(e) => setDays(days.map((x, j) => (j === i ? { ...x, starts: minute(e.target.value) } : x)))} aria-label={`${DAYS[i]} opens`} />
                  <span>to</span>
                  <input type="time" value={clock(d.ends)} step={900} onChange={(e) => setDays(days.map((x, j) => (j === i ? { ...x, ends: minute(e.target.value) } : x)))} aria-label={`${DAYS[i]} closes`} />
                </span>
              ) : <span className="setup-hours-times muted">Closed</span>}
            </div>
          );
        })}
        <div className="setup-hours-quick">
          <button type="button" className="linklike" onClick={() => setDays(days.map((d, i) => ({ ...d, enabled: i === 0 ? 0 : 1, starts: 540, ends: 1080 })))}>Mon–Sat 9–6</button>
          <button type="button" className="linklike" onClick={() => setDays(days.map((d, i) => ({ ...d, enabled: i === 0 || i === 1 ? 0 : 1, starts: 600, ends: 1140 })))}>Tue–Sat 10–7</button>
          <button type="button" className="linklike" onClick={() => setDays(days.map((d) => ({ ...d, enabled: 1, starts: 540, ends: 1200 })))}>Every day 9–8</button>
        </div>
      </div>
      {upcoming.length > 0 && (
        <label className="setup-check">
          <input type="checkbox" checked={closeBank} onChange={(e) => setCloseBank(e.target.checked)} />
          <span>Close on bank holidays <small className="helper">{upcoming.map(([, n]) => n).slice(0, 3).join(", ")}{upcoming.length > 3 ? ` and ${upcoming.length - 3} more` : ""}. You can reopen any of them in Settings → Shop closures.</small></span>
        </label>
      )}
      <StepActions busy={busy} onNext={() => run(async () => { await save(); await onNext(); }, setError)} onSkip={onSkip} />
    </div>
  );
}

// ---- 3. Services ---------------------------------------------------------------------------------
type Starter = { name: string; category: string; duration_min: number; price_pence: number; popular?: boolean };
function StepServices({ w, api, refresh, data, setNotice, setError, goTo, onNext, onSkip }: StepProps) {
  const kind = ((w.shop as { kind?: string }).kind || data.kind || "BARBER") as "BARBER" | "HAIR" | "SALON";
  const [menu, setMenu] = useState<Starter[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<Record<number, Partial<Starter>>>({});
  const { busy, run } = useBusy();
  useEffect(() => {
    api<{ menu: Starter[] }>(`/setup/starter?kind=${kind}`).then((r) => { setMenu(r.menu); setPicked(new Set(r.menu.map((_, i) => i).filter((i) => r.menu[i].popular || w.services.length === 0))); }).catch((e) => setError(e.message));
  }, [kind]);
  const existing = new Set(w.services.map((s) => s.name.toLowerCase()));
  const rows = menu.map((m, i) => ({ ...m, ...edits[i], i, have: existing.has((edits[i]?.name || m.name).toLowerCase()) }));
  const chosen = rows.filter((r) => picked.has(r.i) && !r.have);
  return (
    <div className="setup-wiz-card">
      <p className="setup-wiz-lead">
        {w.services.length ? `You have ${w.services.length} service${w.services.length === 1 ? "" : "s"} already. ` : ""}
        Tick the ones you offer and fix the prices — typical {KIND_LABEL[kind].toLowerCase()} figures to start from. Add-ons, per-barber prices and photos live in Services.
      </p>
      <ul className="setup-menu" data-testid="setup-starter-menu">
        {rows.map((r) => (
          <li key={r.i} data-have={r.have} data-picked={picked.has(r.i)}>
            <label className="setup-menu-pick"><input type="checkbox" checked={picked.has(r.i) || r.have} disabled={r.have} onChange={(e) => { const n = new Set(picked); e.target.checked ? n.add(r.i) : n.delete(r.i); setPicked(n); }} /><span className="sr-only">{r.name}</span></label>
            <input className="setup-menu-name" value={r.name} disabled={r.have} onChange={(e) => setEdits({ ...edits, [r.i]: { ...edits[r.i], name: e.target.value } })} aria-label="Service name" />
            <span className="setup-menu-cat">{r.category}</span>
            <label className="setup-menu-num"><input type="number" min={5} step={5} value={r.duration_min} disabled={r.have} onChange={(e) => setEdits({ ...edits, [r.i]: { ...edits[r.i], duration_min: Number(e.target.value) } })} aria-label="Minutes" /><span>min</span></label>
            <label className="setup-menu-num"><span>£</span><input type="number" min={0} step={0.5} value={(r.price_pence / 100).toFixed(2)} disabled={r.have} onChange={(e) => setEdits({ ...edits, [r.i]: { ...edits[r.i], price_pence: Math.round(Number(e.target.value) * 100) } })} aria-label="Price" /></label>
            {r.have && <Badge tone="good">Added</Badge>}
          </li>
        ))}
      </ul>
      <p className="helper">Something missing? <button type="button" className="linklike" onClick={() => goTo("Services")}>Add it in Services</button> — this page will still be here.</p>
      <StepActions busy={busy} nextLabel={chosen.length ? `Add ${chosen.length} and continue` : "Continue"} onNext={() => run(async () => {
        if (chosen.length) {
          const r = await api<{ added: number }>("/setup/starter", "POST", { services: chosen.map(({ name, category, duration_min, price_pence, popular }) => ({ name, category, duration_min, price_pence, popular: !!popular })) });
          setNotice(`${r.added} service${r.added === 1 ? "" : "s"} added.`);
          await refresh();
        }
        await onNext();
      }, setError)} onSkip={onSkip} />
    </div>
  );
}

// Steps 4–7 live in Setup2.tsx (same props); the shared bits below are what it imports.
import { StepTeam, StepMessages, StepOnline, StepPayments } from "./Setup2";
export type { StepProps, Api, SetupData, Starter };
export { F, StepActions, useBusy, KIND_LABEL, VerifyRow };
