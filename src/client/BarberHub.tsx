// Everything about ONE barber's working week, in one place, used by the Team page and the setup wizard:
//   BarberHoursPanel    weekly hours edited in place + one list of what is coming up (days off, dated
//                       hours, shop closures). Owners and managers edit; everyone else just reads.
//   BarberServicesPanel services grouped by category: tick what this barber offers (off until ticked),
//                       give them a fixed price of their own, bulk-tick a category, one Save bar.
import { useEffect, useMemo, useState } from "react";
import type { Hours, Service, Staff, WorkspaceData } from "../server/domain";
import { Badge, Button, Icon, Notice } from "./ui";
import { currencySymbol, money, shopWeekOf, time } from "./fixtures";
import { ConflictOutcome, ConflictResolver, type Decision, type Outcome, type Preview, type ScheduleChange } from "./ConflictResolver";
import { HolidayTracker, KIND_LABEL } from "./Holidays";
import { ask } from "./confirm";
import { offersService } from "./offers";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

const ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const clock = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const minute = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
const longDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** Categories in the shop's own order (created-but-empty ones included), each with its services. */
export function orderedCategories(w: Pick<WorkspaceData, "services" | "service_categories">, opts: { activeOnly?: boolean; includeEmpty?: boolean } = {}) {
  const { activeOnly = true, includeEmpty = false } = opts;
  const names = [...(w.service_categories || [])].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)).map((c) => c.name);
  for (const s of w.services) if (!names.includes(s.category)) names.push(s.category);
  return names
    .map((name) => ({
      name,
      services: w.services
        .filter((s) => s.category === name && (!activeOnly || s.active))
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    }))
    .filter((c) => includeEmpty || c.services.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------------------------
type Row = { enabled: boolean; starts: string; ends: string; hasBreak: boolean; break_start: string; break_end: string };

function rowsFrom(staff: Staff, hours: Hours[], shop: WorkspaceData["shop"]): Row[] {
  const week = shopWeekOf(shop);
  return Array.from({ length: 7 }, (_, i) => {
    const h = hours.find((x) => x.weekday === i && x.staff_id === staff.id) ?? { enabled: week[i].enabled, starts: week[i].starts, ends: week[i].ends, break_start: week[i].starts, break_end: week[i].starts };
    const hasBreak = h.break_end > h.break_start;
    return {
      enabled: !!h.enabled,
      starts: clock(h.starts),
      ends: clock(h.ends),
      hasBreak,
      break_start: clock(hasBreak ? h.break_start : Math.min(h.ends - 30, Math.max(h.starts, 12 * 60 + 45))),
      break_end: clock(hasBreak ? h.break_end : Math.min(h.ends, Math.max(h.starts, 13 * 60 + 30))),
    };
  });
}
const shopRows = (shop: WorkspaceData["shop"]): Row[] =>
  shopWeekOf(shop).map((d) => ({ enabled: !!d.enabled, starts: clock(d.starts), ends: clock(d.ends), hasBreak: false, break_start: clock(Math.min(d.ends - 30, Math.max(d.starts, 12 * 60 + 45))), break_end: clock(Math.min(d.ends, Math.max(d.starts, 13 * 60 + 30))) }));

function problem(r: Row): string {
  if (!r.enabled) return "";
  if (!r.starts || !r.ends) return "Set a start and end time.";
  if (minute(r.ends) <= minute(r.starts)) return "Finish must be after start.";
  if (r.hasBreak && (minute(r.break_end) <= minute(r.break_start) || minute(r.break_start) < minute(r.starts) || minute(r.break_end) > minute(r.ends))) return "Break must sit inside the shift.";
  return "";
}

export function summariseWeek(hours: Hours[]): string {
  const on = ORDER.filter((d) => hours.find((h) => h.weekday === d)?.enabled);
  if (!on.length) return "No working days set";
  const names = on.map((d) => DAY[d].slice(0, 3));
  const first = hours.find((h) => h.weekday === on[0])!;
  const same = on.every((d) => { const h = hours.find((x) => x.weekday === d)!; return h.starts === first.starts && h.ends === first.ends; });
  return `${names.length === 7 ? "Every day" : names.length > 2 && on.every((d, i) => i === 0 || ORDER.indexOf(d) === ORDER.indexOf(on[i - 1]) + 1) ? `${names[0]}–${names[names.length - 1]}` : names.join(", ")}${same ? ` ${time(first.starts)}–${time(first.ends)}` : ""}`;
}

export function BarberHoursPanel({
  w,
  api,
  staff,
  canEdit,
  onSaved,
  onDaysOff,
  onOverrides,
  compact = false,
}: {
  w: WorkspaceData;
  api: Api;
  staff: Staff;
  canEdit: boolean;
  onSaved: () => Promise<unknown>;
  onDaysOff?: (s: Staff) => void;
  onOverrides?: (s: Staff) => void;
  compact?: boolean;
}) {
  const mine = useMemo(() => w.hours.filter((h) => h.staff_id === staff.id), [w.hours, staff.id]);
  const serverSig = JSON.stringify([staff.version, mine.map((h) => [h.weekday, h.enabled, h.starts, h.ends, h.break_start, h.break_end]), staff.follows_shop_hours ?? 0]);
  const base = useMemo(() => rowsFrom(staff, mine, w.shop), [serverSig, w.shop.week_json]);
  const [rows, setRows] = useState<Row[]>(base);
  const [follow, setFollow] = useState(!!staff.follows_shop_hours);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [conflict, setConflict] = useState<{ change: ScheduleChange; preview: Preview } | null>(null);
  const [outcome, setOutcome] = useState<Outcome[] | null>(null);
  useEffect(() => {
    setRows(base);
    setFollow(!!staff.follows_shop_hours);
  }, [serverSig]);
  const dirty = JSON.stringify(rows) !== JSON.stringify(base) || follow !== !!staff.follows_shop_hours;
  const set = (i: number, patch: Partial<Row>) => {
    setRows((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x)));
    setFollow(false);
    setDone("");
  };
  const first = staff.name.split(" ")[0];
  const invalid = rows.map(problem);
  const anyInvalid = invalid.some(Boolean);
  const sameAsShop = JSON.stringify(rows.map((r) => [r.enabled, r.starts, r.ends])) === JSON.stringify(shopRows(w.shop).map((r) => [r.enabled, r.starts, r.ends]));

  const change = (): ScheduleChange => ({
    kind: "weekly",
    staff_id: staff.id,
    change: {
      version: staff.version,
      follow: follow ? 1 : 0,
      rows: rows.map((r, i) => {
        const starts = minute(r.starts);
        return {
          weekday: i,
          enabled: r.enabled ? 1 : 0,
          starts,
          ends: minute(r.ends),
          break_start: r.enabled && r.hasBreak ? minute(r.break_start) : starts,
          break_end: r.enabled && r.hasBreak ? minute(r.break_end) : starts,
        };
      }),
    },
  });
  async function save() {
    setBusy(true);
    setError("");
    setDone("");
    try {
      const c = change();
      const preview = await api<Preview>("/schedule/preview", "POST", c);
      if (preview.conflicts.length === 0) {
        await api("/schedule/apply", "POST", { change: c, decisions: [] });
        await onSaved();
        setDone(`${first}'s hours saved. New bookings use them straight away.`);
      } else setConflict({ change: c, preview });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save hours.");
    } finally {
      setBusy(false);
    }
  }
  async function applyConflict(decisions: Decision[]) {
    if (!conflict) return;
    const r = await api<{ outcome: Outcome[] }>("/schedule/apply", "POST", { change: conflict.change, decisions });
    setOutcome(r.outcome);
    setConflict(null);
    void onSaved();
  }

  // One list for everything coming up: days off, dated hours and shop closures.
  const coming = useMemo(() => {
    const items: { key: string; date: string; title: string; note: string; tag: string; tone?: "warn"; remove?: () => Promise<void> }[] = [];
    for (const d of w.days_off) if (d.staff_id === staff.id && d.date >= w.today)
      items.push({ key: `off-${d.id}`, date: d.date, title: "Day off", note: d.reason, tag: KIND_LABEL[d.kind ?? "HOLIDAY"] || "Day off", remove: async () => { await api(`/staff/${staff.id}/days-off/${d.id}`, "DELETE"); } });
    for (const o of w.schedule_overrides) if (o.staff_id === staff.id && o.date >= w.today)
      items.push({ key: `ov-${o.id}`, date: o.date, title: o.enabled ? `${time(o.starts)}–${time(o.ends)}` : "Not working", note: o.reason, tag: "Dated hours", remove: async () => { await api(`/staff/${staff.id}/overrides/${o.id}`, "DELETE"); } });
    for (const h of w.holidays) if (h.date >= w.today)
      items.push({ key: `hol-${h.id}`, date: h.date, title: "Shop closed", note: h.label, tag: "Shop closure", tone: "warn" });
    return items.sort((a, b) => a.date.localeCompare(b.date));
  }, [w.days_off, w.schedule_overrides, w.holidays, staff.id, w.today]);
  async function remove(item: (typeof coming)[number]) {
    if (!item.remove) return;
    if (!(await ask({ title: `Remove ${item.title.toLowerCase()} on ${longDate(item.date)}?`, body: "Their weekly hours apply again that day.", confirm: "Remove", tone: "danger" }))) return;
    try {
      await item.remove();
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove that.");
    }
  }

  if (conflict)
    return (
      <div className="barber-hub-panel" data-testid="barber-hours">
        <ConflictResolver preview={conflict.preview} title={`${first}'s new weekly hours`} onApply={applyConflict} onBack={() => setConflict(null)} />
      </div>
    );
  if (outcome)
    return (
      <div className="barber-hub-panel" data-testid="barber-hours">
        <ConflictOutcome outcome={outcome} title={`${first}'s new weekly hours`} />
        <div className="panel-actions-row"><Button onClick={() => setOutcome(null)} data-testid="hours-outcome-done">Done</Button></div>
      </div>
    );

  return (
    <div className="barber-hub-panel" data-testid="barber-hours" data-dirty={dirty ? "true" : undefined}>
      <div className="hub-head">
        <div>
          <h3>Weekly hours</h3>
          <p className="workspace-footnote">
            {canEdit ? `${first}'s regular week. Shop opening hours still cap what customers can book.` : "Set by the owner or a manager. Ask them if something needs to change."}
          </p>
        </div>
        {canEdit && (
          <div className="hub-head-actions">
            <Button variant="ghost" onClick={() => { setRows(shopRows(w.shop).map((r, i) => ({ ...r, hasBreak: rows[i].hasBreak && r.enabled, break_start: rows[i].break_start, break_end: rows[i].break_end }))); setFollow(true); setDone(""); }} data-testid="hours-same-as-shop">
              Same as shop hours
            </Button>
            <Button variant="ghost" onClick={() => { setRows((r) => r.map((x) => ({ ...r[1], enabled: x.enabled }))); setFollow(false); }} data-testid="hours-copy-monday">
              Copy Monday to all
            </Button>
          </div>
        )}
      </div>
      {follow && !dirty && <p className="hub-follow" data-testid="hours-follows"><Icon name="check" size={13} /> Works the shop's opening hours. If those change you'll be asked whether to update {first}.</p>}
      {!follow && sameAsShop && !dirty && canEdit && <p className="hub-follow muted">Currently the same as the shop. Press “Same as shop hours” and save to keep {first} in step when the shop changes.</p>}
      <ul className={`hub-week ${compact ? "compact" : ""}`}>
        {ORDER.map((i) => {
          const r = rows[i];
          const err = invalid[i];
          return (
            <li key={i} className={r.enabled ? "" : "off"} data-testid={`hours-day-${i}`}>
              <label className="hub-day">
                <input type="checkbox" checked={r.enabled} disabled={!canEdit} onChange={(e) => set(i, { enabled: e.target.checked })} aria-label={`${DAY[i]} working`} />
                <strong>{DAY[i].slice(0, 3)}</strong>
              </label>
              {r.enabled ? (
                canEdit ? (
                  <div className="hub-times">
                    <input type="time" step={900} value={r.starts} onChange={(e) => set(i, { starts: e.target.value })} aria-label={`${DAY[i]} start`} />
                    <span>–</span>
                    <input type="time" step={900} value={r.ends} onChange={(e) => set(i, { ends: e.target.value })} aria-label={`${DAY[i]} end`} />
                    <label className="hub-break">
                      <input type="checkbox" checked={r.hasBreak} onChange={(e) => set(i, { hasBreak: e.target.checked })} aria-label={`${DAY[i]} break`} /> Break
                    </label>
                    {r.hasBreak && (
                      <span className="hub-break-times">
                        <input type="time" step={900} value={r.break_start} onChange={(e) => set(i, { break_start: e.target.value })} aria-label={`${DAY[i]} break start`} />
                        <span>–</span>
                        <input type="time" step={900} value={r.break_end} onChange={(e) => set(i, { break_end: e.target.value })} aria-label={`${DAY[i]} break end`} />
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="hub-readonly">{r.starts}–{r.ends}{r.hasBreak ? ` · break ${r.break_start}` : ""}</span>
                )
              ) : (
                <span className="hub-off">Day off</span>
              )}
              {err && <small className="hub-error" role="alert">{err}</small>}
            </li>
          );
        })}
      </ul>
      {canEdit && (
        <div className="hub-savebar" data-testid="hours-savebar" data-visible={dirty ? "true" : "false"}>
          <span>{dirty ? "Unsaved changes to the weekly hours" : "Hours are up to date"}</span>
          <span className="hub-savebar-actions">
            {dirty && <Button variant="ghost" onClick={() => { setRows(base); setFollow(!!staff.follows_shop_hours); setError(""); }} data-testid="hours-discard">Discard</Button>}
            <Button disabled={!dirty || busy || anyInvalid} onClick={save} data-testid="hours-save">{busy ? "Checking…" : "Save hours"}</Button>
          </span>
        </div>
      )}
      {error && <p className="workspace-error" role="alert">{error}</p>}
      {done && <p className="workspace-success" role="status" data-testid="hours-saved">{done}</p>}

      <div className="hub-head">
        <div>
          <h3>Coming up</h3>
          <p className="workspace-footnote">Days off, one-off hours and shop closures in date order.</p>
        </div>
        {canEdit && (onDaysOff || onOverrides) && (
          <div className="hub-head-actions">
            {onDaysOff && <Button variant="secondary" onClick={() => onDaysOff(staff)} data-testid="hub-add-dayoff">Add day off</Button>}
            {onOverrides && <Button variant="ghost" onClick={() => onOverrides(staff)} data-testid="hub-dated-hours">Dated hours ({w.schedule_overrides.filter((o) => o.staff_id === staff.id && o.date >= w.today).length})</Button>}
          </div>
        )}
      </div>
      {coming.length === 0 ? (
        <p className="workspace-footnote" data-testid="hub-coming-empty">Nothing coming up.</p>
      ) : (
        <ul className="hub-coming" data-testid="hub-coming">
          {coming.map((it) => (
            <li key={it.key} className={it.tone === "warn" ? "closure" : ""}>
              <span className="hub-coming-date"><strong>{longDate(it.date)}</strong></span>
              <span className="hub-coming-main"><strong>{it.title}</strong>{it.note && <small>{it.note}</small>}</span>
              <Badge>{it.tag}</Badge>
              {canEdit && it.remove ? <button type="button" className="linklike" onClick={() => void remove(it)} aria-label={`Remove ${it.title} on ${longDate(it.date)}`}>Remove</button> : <span />}
            </li>
          ))}
        </ul>
      )}
      {!compact && <HolidayTracker w={w} staff={staff} api={api} canEdit={canEdit} onSaved={() => void onSaved()} />}
      {!compact && <Notice>Hours, leave and dated shifts feed availability immediately. Existing appointments outside new hours are flagged for review, never cancelled.</Notice>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------------
type Line = { on: boolean; price: string; dur: string };

export function BarberServicesPanel({
  w,
  api,
  staff,
  canEdit,
  onSaved,
  compact = false,
}: {
  w: WorkspaceData;
  api: Api;
  staff: Staff;
  canEdit: boolean;
  onSaved: () => Promise<unknown>;
  compact?: boolean;
}) {
  const cats = useMemo(() => orderedCategories(w), [w.services, w.service_categories]);
  const all = useMemo(() => cats.flatMap((c) => c.services), [cats]);
  const mineRules = useMemo(() => w.service_rules.filter((r) => r.staff_id === staff.id), [w.service_rules, staff.id]);
  const sig = JSON.stringify([all.map((s) => s.id), mineRules.map((r) => [r.service_id, r.enabled, r.price_pence, r.duration_min])]);
  const base = useMemo(() => {
    const m: Record<string, Line> = {};
    for (const s of all) {
      const r = mineRules.find((x) => x.service_id === s.id);
      m[s.id] = { on: !!r && !!r.enabled, price: r?.price_pence != null ? String(r.price_pence / 100) : "", dur: r?.duration_min != null ? String(r.duration_min) : "" };
    }
    return m;
  }, [sig]);
  const [draft, setDraft] = useState<Record<string, Line>>(base);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [bulk, setBulk] = useState<Record<string, string>>({});
  useEffect(() => setDraft(base), [base]);
  const changed = all.filter((s) => JSON.stringify(draft[s.id]) !== JSON.stringify(base[s.id]));
  const dirty = changed.length > 0;
  const first = staff.name.split(" ")[0];
  const put = (id: string, patch: Partial<Line>) => { setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } })); setMsg(null); };
  const offeredCount = all.filter((s) => draft[s.id]?.on).length;
  const badPrice = (l: Line) => l.price !== "" && !(Number(l.price) >= 0 && Number(l.price) <= 1000);
  const badDur = (l: Line) => l.dur !== "" && !(Number(l.dur) >= 5 && Number(l.dur) <= 240);
  const invalid = changed.some((s) => draft[s.id].on && (badPrice(draft[s.id]) || badDur(draft[s.id])));

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api("/service-rules", "PUT", {
        rules: changed.map((s) => {
          const l = draft[s.id];
          return { staff_id: staff.id, service_id: s.id, enabled: l.on ? 1 : 0, price_pence: l.on && l.price !== "" ? Math.round(Number(l.price) * 100) : null, duration_min: l.on && l.dur !== "" ? Number(l.dur) : null };
        }),
      });
      await onSaved();
      setMsg({ kind: "ok", text: `${changed.length} change${changed.length === 1 ? "" : "s"} saved. New bookings and quotes use them; saved appointments keep the price they were booked at.` });
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof Error ? e.message : "Could not save." });
    } finally {
      setBusy(false);
    }
  }

  if (all.length === 0)
    return (
      <div className="barber-hub-panel" data-testid="barber-services">
        <p className="workspace-footnote">There are no services yet. Add them under Services, then come back and tick the ones {first} does.</p>
      </div>
    );
  return (
    <div className="barber-hub-panel" data-testid="barber-services" data-dirty={dirty ? "true" : undefined}>
      <div className="hub-head">
        <div>
          <h3>What {first} offers</h3>
          <p className="workspace-footnote" data-testid="services-count">
            {offeredCount} of {all.length} services ticked. {canEdit ? "A service is off for a barber until you tick it. Give them their own price if it differs from the shop's." : "Set by the owner or a manager."}
          </p>
        </div>
        {canEdit && (
          <div className="hub-head-actions">
            <Button variant="ghost" onClick={() => setDraft((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { ...v, on: true }])))} data-testid="services-offer-all">Offer everything</Button>
            <Button variant="ghost" onClick={() => setDraft((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { ...v, on: false, price: "", dur: "" }])))} data-testid="services-offer-none">Clear all</Button>
          </div>
        )}
      </div>
      {offeredCount === 0 && !dirty && <Notice tone="warn" data-testid="barber-no-services">{first} can't be booked yet: no services are ticked.</Notice>}
      {cats.map((cat) => {
        const n = cat.services.filter((s) => draft[s.id]?.on).length;
        return (
          <section className="hub-cat" key={cat.name} aria-label={cat.name} data-testid={`services-cat-${cat.name}`}>
            <header className="hub-cat-head">
              <h4>{cat.name} <small>{n} of {cat.services.length}</small></h4>
              {canEdit && (
                <span className="hub-cat-tools">
                  <button type="button" className="linklike" onClick={() => cat.services.forEach((s) => put(s.id, { on: true }))} data-testid={`cat-all-${cat.name}`}>Offer all</button>
                  <button type="button" className="linklike" onClick={() => cat.services.forEach((s) => put(s.id, { on: false, price: "", dur: "" }))} data-testid={`cat-none-${cat.name}`}>None</button>
                  <span className="hub-bulk">
                    <span>{currencySymbol()}</span>
                    <input type="number" min={0} max={1000} step="0.01" inputMode="decimal" placeholder="Price" value={bulk[cat.name] ?? ""} onChange={(e) => setBulk({ ...bulk, [cat.name]: e.target.value })} aria-label={`Set one price for ticked ${cat.name} services`} data-testid={`cat-price-${cat.name}`} />
                    <button type="button" className="linklike" disabled={!n || !(Number(bulk[cat.name]) >= 0) || (bulk[cat.name] ?? "") === ""} onClick={() => cat.services.forEach((s) => draft[s.id]?.on && put(s.id, { price: String(bulk[cat.name]) }))} data-testid={`cat-price-apply-${cat.name}`}>Set for ticked</button>
                  </span>
                </span>
              )}
            </header>
            <ul className="hub-services">
              {cat.services.map((s) => {
                const l = draft[s.id];
                const custom = l.on && l.price !== "";
                return (
                  <li key={s.id} className={l.on ? "on" : "off"} data-testid={`service-row-${s.id}`}>
                    <label className="switch">
                      <input type="checkbox" checked={l.on} disabled={!canEdit} onChange={(e) => put(s.id, e.target.checked ? { on: true } : { on: false, price: "", dur: "" })} aria-label={`${staff.name} offers ${s.name}`} />
                      <span />
                    </label>
                    <span className="hub-service-name">
                      <strong>{s.name}</strong>
                      <small>Shop price {money(s.price_pence)} · {s.duration_min} min</small>
                    </span>
                    {l.on ? (
                      <span className="hub-service-price">
                        {canEdit ? (
                          <>
                            <span className="matrix-input">
                              <span>{currencySymbol()}</span>
                              <input type="number" min={0} max={1000} step="0.01" inputMode="decimal" placeholder={(s.price_pence / 100).toFixed(2)} value={l.price} onChange={(e) => put(s.id, { price: e.target.value })} aria-label={`${staff.name} price for ${s.name}`} aria-invalid={badPrice(l) || undefined} />
                            </span>
                            <span className="matrix-input">
                              <input type="number" min={5} max={240} step={5} inputMode="numeric" placeholder={String(s.duration_min)} value={l.dur} onChange={(e) => put(s.id, { dur: e.target.value })} aria-label={`${staff.name} duration for ${s.name}`} aria-invalid={badDur(l) || undefined} />
                              <span>min</span>
                            </span>
                          </>
                        ) : (
                          <strong>{money(l.price !== "" ? Math.round(Number(l.price) * 100) : s.price_pence)}</strong>
                        )}
                        <span className={`tag ${custom ? "good" : ""}`} data-testid={custom ? "chip-custom" : "chip-shop"}>{custom ? `Custom ${money(Math.round(Number(l.price) * 100))}` : "Shop price"}</span>
                        {canEdit && (custom || l.dur !== "") && <button type="button" className="linklike" onClick={() => put(s.id, { price: "", dur: "" })} aria-label={`Use the shop price and time for ${s.name}`}>Reset</button>}
                      </span>
                    ) : (
                      <span className="hub-service-price muted">Not offered</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {canEdit && (
        <div className="hub-savebar sticky" data-testid="services-savebar" data-visible={dirty ? "true" : "false"}>
          <span>{dirty ? `${changed.length} unsaved change${changed.length === 1 ? "" : "s"}` : "Everything is saved"}</span>
          <span className="hub-savebar-actions">
            {dirty && <Button variant="ghost" onClick={() => { setDraft(base); setMsg(null); }} data-testid="services-discard">Discard</Button>}
            <Button disabled={!dirty || busy || invalid} onClick={save} data-testid="services-save">{busy ? "Saving…" : "Save changes"}</Button>
          </span>
        </div>
      )}
      {msg && <p className={msg.kind === "ok" ? "workspace-success" : "workspace-error"} role={msg.kind === "ok" ? "status" : "alert"} data-testid="services-msg">{msg.text}</p>}
      {!compact && <p className="workspace-footnote">Turning a service off flags future appointments for review; it never cancels them.</p>}
    </div>
  );
}

/** A one-line summary used on cards and in the wizard: "6 services · from £25". */
export function offeringSummary(w: Pick<WorkspaceData, "services" | "service_rules">, staff: Staff): { count: number; label: string; services: Service[] } {
  const services = w.services.filter((s) => s.active && offersService(w.service_rules, staff.id, s.id));
  return { count: services.length, services, label: services.length ? `${services.length} service${services.length === 1 ? "" : "s"}` : "No services ticked" };
}
