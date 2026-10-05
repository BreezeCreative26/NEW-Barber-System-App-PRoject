// Shop setup wizard — /workspace/setup. Nine resumable steps onto settings that already exist,
// plus the setup-only pieces: contact verification, starter menu, invite-by-text, "send me a test".
// State is server-side (shops.setup_json) so it resumes on any device.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Shop, WorkspaceData } from "../server/domain";
import { Badge, Button, Icon } from "./ui";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export type SetupStep = "shop" | "brand" | "hours" | "services" | "team" | "messages" | "terms" | "online" | "payments";
type SetupState = { step: SetupStep; done: SetupStep[]; skipped: SetupStep[]; completed_at: number | null; started_at: number | null; dismissed: boolean };
type Progress = {
  shop: { saved: boolean; phone: string; email: string; phone_verified: boolean; email_verified: boolean };
  services: { count: number };
  team: { staff: number; invited: number; joined: number };
  messages: { sms_sender: string; providers: { email: { provider: string; from: string }; sms: { provider: string; from: string }; wa?: { provider: string; sender: string; test_sender: boolean; keyword: string } } };
  online: { slug: string; live: boolean };
  payments: { deposits_online: boolean; mode: string; connected: boolean };
  brand?: { logo: boolean; cover: boolean; accent: string };
  terms?: { text: boolean; cancel_hours: number; lead_time_min: number; booking_window_days: number };
};
type SetupData = { state: SetupState; progress: Progress; kind: "BARBER" | "HAIR" | "SALON"; bank_holidays: Record<string, string> };

const STEPS: { key: SetupStep; label: string; short: string; blurb: string }[] = [
  { key: "shop", label: "Your shop", short: "Shop", blurb: "Name, address and how customers reach you." },
  { key: "brand", label: "Your brand", short: "Brand", blurb: "Logo, photo and colour on a live preview." },
  { key: "hours", label: "Opening hours", short: "Hours", blurb: "When the doors are open." },
  { key: "services", label: "Services & prices", short: "Services", blurb: "Start from a typical menu and edit." },
  { key: "team", label: "Your team", short: "Team", blurb: "Add barbers and invite them to sign in." },
  { key: "messages", label: "Customer messages", short: "Messages", blurb: "Texts and emails in your shop's name." },
  { key: "terms", label: "Booking rules & terms", short: "Terms", blurb: "Notice, cancellations and house rules." },
  { key: "online", label: "Go live", short: "Go live", blurb: "Your web address, QR code and share link." },
  { key: "payments", label: "Deposits & payments", short: "Payments", blurb: "How customers pay." },
];
const KIND_LABEL = { BARBER: "Barbershop", HAIR: "Hairdresser", SALON: "Salon" } as const;
const clock = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const minute = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Shared guard covers step links, exit, uploads and async saves without discarding local input.
const SetupGuard = createContext<{ dirty: Set<object>; pending: number; busy: (delta: number) => void } | null>(null);
export function useSetupDirty(dirty: boolean) {
  const guard = useContext(SetupGuard);
  const key = useRef({});
  useLayoutEffect(() => {
    if (dirty) guard?.dirty.add(key.current); else guard?.dirty.delete(key.current);
    return () => { guard?.dirty.delete(key.current); };
  }, [guard, dirty]);
}
export function useSetupUpload() {
  const guard = useContext(SetupGuard);
  const [uploading, setUploading] = useState(false);
  const active = useRef(false);
  const onBusyChange = (value: boolean) => {
    if (active.current === value) return;
    active.current = value;
    guard?.busy(value ? 1 : -1);
    setUploading(value);
  };
  return { uploading, onBusyChange };
}

export function SetupWizard({ w, api, refresh, onExit, goTo }: { w: WorkspaceData; api: Api; refresh: () => Promise<void>; onExit: () => void; goTo: (tab: string) => void }) {
  const [pending, setPending] = useState(0);
  const navigationLock = useRef(false);
  const guard = useMemo(() => ({ dirty: new Set<object>(), pending: 0, busy(delta: number) {
    this.pending = Math.max(0, this.pending + delta); setPending(this.pending);
  } }), []);
  function canLeave() {
    if (guard.pending) { setError("Please wait for the save or upload to finish."); return false; }
    return !guard.dirty.size || window.confirm("Discard unsaved changes on this step?");
  }
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => { if (guard.pending || guard.dirty.size) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [guard]);
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
    if (navigationLock.current || ((kind === "skipped" || guard.pending === 0) && !canLeave())) return;
    navigationLock.current = true;
    guard.busy(1);
    try {
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
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save setup progress."); }
    finally { navigationLock.current = false; guard.busy(-1); }
  }
  async function jump(key: SetupStep) {
    if (key === step || navigationLock.current || !canLeave()) return;
    navigationLock.current = true; guard.busy(1); setError("");
    try {
      await api("/setup/state", "PUT", { step: key });
      setStep(key); setNotice("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save setup progress."); }
    finally { navigationLock.current = false; guard.busy(-1); }
  }
  if (error && !data) return <section className="workspace-panel setup-wiz"><p className="workspace-error" role="alert">{error}</p><Button onClick={() => { setError(""); load().then(d => setStep(d.state.step)).catch(e => setError(e.message)); }}>Retry</Button></section>;
  if (!data) return <section className="workspace-panel setup-wiz"><p role="status">Loading setup…</p></section>;
  const doneSet = new Set([...data.state.done]);
  const complete = !!data.state.completed_at;
  const exit = () => { if (canLeave()) onExit(); };
  const common = { w, api, refresh, data, reload: load, setNotice, setError, goTo: (tab: string) => { if (canLeave()) goTo(tab); } };
  return (
    <SetupGuard.Provider value={guard}><section className="setup-wiz setup-flow" aria-labelledby="setup-wiz-heading" data-testid="setup-wizard">
      <header className="setup-flow-top">
        <span className="setup-flow-brand"><Icon name="scissors" size={16} /> {w.shop.name}</span>
        <div className="setup-flow-progress" role="progressbar" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={doneSet.size} aria-label="Setup progress">
          <i style={{ width: `${Math.round((doneSet.size / STEPS.length) * 100)}%` }} />
        </div>
        <button type="button" className="linklike" disabled={pending > 0} onClick={exit} data-testid="setup-exit">{complete ? "Back to the calendar" : "Finish later"}</button>
      </header>
      <div className="setup-flow-body">
        <ol className="setup-wiz-steps setup-flow-rail" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li key={s.key} data-current={s.key === step} data-done={doneSet.has(s.key)} data-skipped={data.state.skipped.includes(s.key) && !doneSet.has(s.key)}>
              <button type="button" aria-label={s.short} disabled={pending > 0} onClick={() => jump(s.key)} aria-current={s.key === step ? "step" : undefined}>
                <span className="setup-wiz-num" aria-hidden="true">{doneSet.has(s.key) ? <Icon name="check" size={12} /> : i + 1}</span>
                <span className="setup-flow-step-text"><span>{s.short}</span><small>{s.blurb}</small></span>
              </button>
            </li>
          ))}
        </ol>
        <div className="setup-flow-main">
          <header className="setup-wiz-head">
            <div>
              <p className="setup-wiz-kicker">{complete ? "Setup" : `Step ${idx + 1} of ${STEPS.length}`}</p>
              <h2 id="setup-wiz-heading">{complete ? `${w.shop.name} is set up` : STEPS[idx].label}</h2>
            </div>
          </header>
      {notice && <p className="workspace-success" role="status">{notice}</p>}
      {error && <p className="workspace-error" role="alert">{error}</p>}
      <fieldset className="setup-wiz-body" disabled={pending > 0} aria-busy={pending > 0} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {step === "shop" && <StepShop {...common} onNext={() => mark("done", "shop")} />}
        {step === "brand" && <StepBrand {...common} onNext={() => mark("done", "brand")} onSkip={() => mark("skipped", "brand")} />}
        {step === "terms" && <StepTerms {...common} onNext={() => mark("done", "terms")} onSkip={() => mark("skipped", "terms")} />}
        {step === "hours" && <StepHours {...common} onNext={() => mark("done", "hours")} onSkip={() => mark("skipped", "hours")} />}
        {step === "services" && <StepServices {...common} onNext={() => mark("done", "services")} onSkip={() => mark("skipped", "services")} />}
        {step === "team" && <StepTeam {...common} onNext={() => mark("done", "team")} onSkip={() => mark("skipped", "team")} />}
        {step === "messages" && <StepMessages {...common} onNext={() => mark("done", "messages")} onSkip={() => mark("skipped", "messages")} />}
        {step === "online" && <StepOnline {...common} onNext={() => mark("done", "online")} onSkip={() => mark("skipped", "online")} />}
        {step === "payments" && <StepPayments {...common} onNext={() => mark("done", "payments")} onSkip={() => mark("skipped", "payments")} complete={complete} onExit={exit} />}
      </fieldset>
        </div>
      </div>
    </section></SetupGuard.Provider>
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
  const locked = useRef(false);
  const guard = useContext(SetupGuard);
  const run = async (fn: () => Promise<void>, setError: (s: string) => void) => {
    if (locked.current) return;
    locked.current = true; guard?.busy(1); setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); }
    finally { locked.current = false; guard?.busy(-1); setBusy(false); }
  };
  return { busy, run };
}

// ---- 1. Your shop ---------------------------------------------------------------------------------
function StepShop({ w, api, refresh, data, reload, setNotice, setError, onNext }: StepProps) {
  const shop = w.shop as Shop & { phone?: string; email?: string; kind?: string; phone_verified_at?: number | null; email_verified_at?: number | null };
  const [form, setForm] = useState({ name: shop.name, kind: (shop.kind || data.kind || "BARBER") as "BARBER" | "HAIR" | "SALON", phone: shop.phone || "", email: shop.email || w.account?.email || "", address: shop.address || "", timezone: shop.timezone || "Europe/London", currency: (shop.currency || "GBP") as "GBP" | "EUR" | "USD" });
  const { busy, run } = useBusy();
  // After a save the server normalises the mobile (+44…) — take its values so the form isn't "dirty".
  useEffect(() => { setForm((f) => ({ ...f, name: shop.name, phone: shop.phone || "", email: shop.email || f.email, address: shop.address || "", timezone: shop.timezone, currency: shop.currency as "GBP", kind: (shop.kind || f.kind) as "BARBER" })); }, [shop.version]);
  const dirty = form.name !== shop.name || form.kind !== (shop.kind || "BARBER") || form.phone !== (shop.phone || "") || form.email !== (shop.email || "") || form.address !== (shop.address || "") || form.currency !== shop.currency || form.timezone !== shop.timezone;
  useSetupDirty(dirty);
  async function save() {
    if (form.name.trim().length < 2) throw new Error("Enter a shop name of at least 2 characters.");
    await api("/setup/contact", "PUT", form);
    await refresh(); await reload();
  }
  return (
    <div className="setup-wiz-card">
      <p className="setup-wiz-lead">The basics customers see on every message and on your booking page. Check these details carefully; your address and shop name appear on customer-facing pages and messages.</p>
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
          {shop.phone && <VerifyRow key={`PHONE:${shop.phone}`} kind="PHONE" target={shop.phone} verified={!!shop.phone_verified_at} api={api} refresh={refresh} reload={reload} setNotice={setNotice} setError={setError} />}
          {shop.email && <VerifyRow key={`EMAIL:${shop.email}`} kind="EMAIL" target={shop.email} verified={!!shop.email_verified_at} api={api} refresh={refresh} reload={reload} setNotice={setNotice} setError={setError} />}
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
  const [closeBank, setCloseBank] = useState(false);
  useSetupDirty(JSON.stringify(days) !== JSON.stringify(week) || closeBank);
  const { busy, run } = useBusy();
  const order = [1, 2, 3, 4, 5, 6, 0];
  const upcoming = Object.entries(data.bank_holidays).filter(([d]) => d >= w.today).slice(0, 8);
  const already = new Set(w.holidays.map((h) => h.date));
  async function save() {
    await api("/shop", "PUT", {
      name: w.shop.name, address: w.shop.address, timezone: w.shop.timezone, currency: w.shop.currency,
      week: days.map((d) => ({ enabled: d.enabled, starts: d.starts, ends: d.ends })),
      deposit_pence: w.shop.deposit_pence, cancel_hours: w.shop.cancel_hours, no_show_grace: w.shop.no_show_grace, till_access: w.shop.till_access, buffer_min: w.shop.buffer_min, card_colour: w.shop.card_colour, calendar_density: w.shop.calendar_density, version: w.shop.version,
    });
    try {
      if (closeBank) for (const [date, name] of upcoming) if (!already.has(date)) {
        await api("/holidays", "POST", { date, label: name });
        already.add(date);
      }
    } finally { await refresh(); }
  }
  return (
    <div className="setup-wiz-card">
      <p className="setup-wiz-lead">When the shop is open. Existing barber shifts are kept unchanged. Review each person's availability in Shifts; newly added barbers start with the shop's hours.</p>
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
          <span>Close on England & Wales bank holidays <small className="helper">{upcoming.map(([, n]) => n).slice(0, 3).join(", ")}{upcoming.length > 3 ? ` and ${upcoming.length - 3} more` : ""}. You can reopen any of them in Settings → Shop closures.</small></span>
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
  useSetupDirty(Object.keys(edits).length > 0);
  return (
    <div className="setup-wiz-card">
      <p className="setup-wiz-lead">
        {w.services.length ? `You have ${w.services.length} service${w.services.length === 1 ? "" : "s"} already. ` : ""}
        Tick the ones you offer and fix the prices — typical {KIND_LABEL[kind].toLowerCase()} figures to start from. Add-ons and per-barber prices live in Services. These are starter prices, not currency-converted recommendations.
      </p>
      <ul className="setup-menu" data-testid="setup-starter-menu">
        {rows.map((r) => (
          <li key={r.i} data-have={r.have} data-picked={picked.has(r.i)}>
            <label className="setup-menu-pick"><input type="checkbox" checked={picked.has(r.i) || r.have} disabled={r.have} onChange={(e) => { const n = new Set(picked); e.target.checked ? n.add(r.i) : n.delete(r.i); setPicked(n); }} /><span className="sr-only">{r.name}</span></label>
            <input className="setup-menu-name" value={r.name} disabled={r.have} onChange={(e) => setEdits({ ...edits, [r.i]: { ...edits[r.i], name: e.target.value } })} aria-label="Service name" />
            <span className="setup-menu-cat">{r.category}</span>
            <label className="setup-menu-num"><input type="number" min={5} step={5} value={r.duration_min} disabled={r.have} onChange={(e) => setEdits({ ...edits, [r.i]: { ...edits[r.i], duration_min: Number(e.target.value) } })} aria-label="Minutes" /><span>min</span></label>
            <label className="setup-menu-num"><span>{w.shop.currency === "EUR" ? "€" : w.shop.currency === "USD" ? "$" : "£"}</span><input type="number" min={0} step={0.5} value={(r.price_pence / 100).toFixed(2)} disabled={r.have} onChange={(e) => setEdits({ ...edits, [r.i]: { ...edits[r.i], price_pence: Math.round(Number(e.target.value) * 100) } })} aria-label="Price" /></label>
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
import { StepBrand, StepTerms } from "./Setup3";
export type { StepProps, Api, SetupData, Starter };
export { F, StepActions, useBusy, KIND_LABEL, VerifyRow };
