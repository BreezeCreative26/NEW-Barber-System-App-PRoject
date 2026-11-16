// Modern date / time pickers for every <input type="date|time|datetime-local"> in the app.
// The browser's own pop-ups look dated (and differ per browser), so one small popover replaces them.
// The inputs themselves stay: forms, validation, React state and server payloads are unchanged — the
// picker writes the value with the native setter and fires input + change like a real edit.
// Desktop also gets a tidy closed field ("Tue 17 Nov 2026", "14:15") instead of the locale's
// "11/17/2026" / "02:15 PM". Phones keep their own closed field text (already readable).

type Kind = "date" | "time" | "datetime-local";
const KINDS = new Set<string>(["date", "time", "datetime-local"]);
const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const toMin = (s: string) => {
  const m = /(\d{1,2}):(\d{2})/.exec(s || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const clock = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const longDate = (d: Date) => `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
const isPicker = (t: EventTarget | null): t is HTMLInputElement => t instanceof HTMLInputElement && KINDS.has(t.type);
const usable = (el: HTMLInputElement) => !el.disabled && !el.readOnly && el.dataset.native === undefined;
const fine = () => !!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;
const narrow = () => window.innerWidth < 640;

// ---- Closed field text (desktop) ------------------------------------------------
function display(el: HTMLInputElement) {
  const v = proto.get!.call(el) as string;
  let text = "";
  if (el.type === "date") { const d = parseDate(v); text = d ? longDate(d) : "Pick a date"; }
  else if (el.type === "time") text = v ? v.slice(0, 5) : "Pick a time";
  else { const d = parseDate(v); const t = v.split("T")[1]; text = d ? `${longDate(d)}, ${(t || "").slice(0, 5)}` : "Pick a date & time"; }
  if (el.dataset.display !== text) el.dataset.display = text;
  el.classList.toggle("op-empty", !v);
}
function watch(el: HTMLInputElement) {
  if ((el as HTMLInputElement & { __op?: 1 }).__op) return;
  (el as HTMLInputElement & { __op?: 1 }).__op = 1;
  el.classList.add("op-enh", `op-${el.type}`);
  // Programmatic value changes (React state, form resets) repaint the closed text too.
  const base = Object.getOwnPropertyDescriptor(el, "value") || proto;
  try {
    Object.defineProperty(el, "value", {
      configurable: true,
      get() { return base.get!.call(this); },
      set(v) { base.set!.call(this, v); display(this as HTMLInputElement); },
    });
  } catch { /* leave it to the input/change listeners */ }
  display(el);
}
function scan(root: ParentNode) {
  root.querySelectorAll?.<HTMLInputElement>('input[type="date"],input[type="time"],input[type="datetime-local"]').forEach(watch);
}

// ---- Writing a value like a real edit ------------------------------------------------
function commit(el: HTMLInputElement, v: string) {
  proto.set!.call(el, v);
  display(el);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// ---- Popover ------------------------------------------------------------------------
let open: { el: HTMLInputElement; pop: HTMLDivElement; scrim: HTMLDivElement | null; cleanup: () => void } | null = null;

function close(refocus = true) {
  if (!open) return;
  const { el, pop, scrim, cleanup } = open;
  open = null;
  cleanup();
  pop.remove();
  scrim?.remove();
  if (refocus && fine()) el.focus({ preventScroll: true });
}

function place(el: HTMLInputElement, pop: HTMLDivElement) {
  if (pop.classList.contains("op-sheet")) return;
  const r = el.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  // Inside a transformed container (an animating dialog) "fixed" is relative to it: correct for that.
  const got = pop.getBoundingClientRect();
  if (Math.abs(got.left - left) > 1 || Math.abs(got.top - top) > 1) {
    left += left - got.left; top += top - got.top;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
}

function button(cls: string, text: string, label?: string) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  if (label) b.setAttribute("aria-label", label);
  return b;
}

// Date pane: days / months / years views.
function datePane(el: HTMLInputElement, value: string, onPick: (iso: string) => void) {
  const min = parseDate(el.min), max = parseDate(el.max);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const chosen = parseDate(value);
  let view: "days" | "months" | "years" = "days";
  let cursor = new Date((chosen || (min && min > today ? min : max && max < today ? max : today)).getTime());
  cursor.setDate(1);
  let focusIso = iso(chosen || (min && min > today ? min : today));
  const pane = document.createElement("div");
  pane.className = "op-date";
  const off = (d: Date) => (min && d < min) || (max && d > max);
  function render(focus = false) {
    pane.textContent = "";
    const head = document.createElement("div");
    head.className = "op-head";
    const prev = button("op-nav", "‹", view === "days" ? "Previous month" : view === "months" ? "Previous year" : "Earlier years");
    const next = button("op-nav", "›", view === "days" ? "Next month" : view === "months" ? "Next year" : "Later years");
    const startYear = Math.floor(cursor.getFullYear() / 20) * 20;
    const title = button("op-title", view === "days" ? `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}` : view === "months" ? String(cursor.getFullYear()) : `${startYear} – ${startYear + 19}`);
    title.setAttribute("aria-label", view === "years" ? "Years" : "Change month or year");
    title.onclick = () => { view = view === "days" ? "months" : view === "months" ? "years" : "days"; render(); };
    prev.onclick = () => { if (view === "days") cursor.setMonth(cursor.getMonth() - 1); else cursor.setFullYear(cursor.getFullYear() - (view === "months" ? 1 : 20)); render(); };
    next.onclick = () => { if (view === "days") cursor.setMonth(cursor.getMonth() + 1); else cursor.setFullYear(cursor.getFullYear() + (view === "months" ? 1 : 20)); render(); };
    head.append(prev, title, next);
    pane.append(head);
    if (view === "months") {
      const g = document.createElement("div");
      g.className = "op-grid op-months";
      MONTHS.forEach((m, i) => {
        const b = button("op-cell", m.slice(0, 3), `${m} ${cursor.getFullYear()}`);
        if (chosen && chosen.getFullYear() === cursor.getFullYear() && chosen.getMonth() === i) b.classList.add("on");
        b.onclick = () => { cursor.setMonth(i); view = "days"; render(); };
        g.append(b);
      });
      pane.append(g);
      return;
    }
    if (view === "years") {
      const g = document.createElement("div");
      g.className = "op-grid op-years";
      for (let y = startYear; y < startYear + 20; y++) {
        const b = button("op-cell", String(y));
        if (chosen && chosen.getFullYear() === y) b.classList.add("on");
        if (y === today.getFullYear()) b.classList.add("now");
        b.onclick = () => { cursor.setFullYear(y); view = "months"; render(); };
        g.append(b);
      }
      pane.append(g);
      return;
    }
    const dow = document.createElement("div");
    dow.className = "op-dow";
    DOW.forEach((d) => { const s = document.createElement("span"); s.textContent = d.slice(0, 2); dow.append(s); });
    pane.append(dow);
    const g = document.createElement("div");
    g.className = "op-grid op-days";
    g.setAttribute("role", "grid");
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(first); start.setDate(1 - lead);
    const cells = lead + new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate() > 35 ? 42 : 35;
    for (let i = 0; i < cells; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const k = iso(d);
      const b = button("op-day", String(d.getDate()), longDate(d));
      b.dataset.iso = k;
      b.tabIndex = k === focusIso ? 0 : -1;
      if (d.getMonth() !== cursor.getMonth()) b.classList.add("out");
      if (k === iso(today)) b.classList.add("now");
      if (chosen && k === iso(chosen)) { b.classList.add("on"); b.setAttribute("aria-pressed", "true"); }
      if (off(d)) b.disabled = true;
      b.onclick = () => onPick(k);
      g.append(b);
    }
    g.onkeydown = (e) => {
      const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[e.key];
      if (!step) return;
      e.preventDefault();
      const d = parseDate(focusIso)!; d.setDate(d.getDate() + step);
      focusIso = iso(d);
      if (d.getMonth() !== cursor.getMonth() || d.getFullYear() !== cursor.getFullYear()) { cursor = new Date(d.getFullYear(), d.getMonth(), 1); }
      render(true);
    };
    pane.append(g);
    if (focus) (g.querySelector<HTMLButtonElement>(`[data-iso="${focusIso}"]`))?.focus();
    const foot = document.createElement("div");
    foot.className = "op-foot";
    const quick: [string, number][] = [["Today", 0], ["Tomorrow", 1], ["+1 week", 7]];
    for (const [label, add] of quick) {
      const d = new Date(today); d.setDate(d.getDate() + add);
      const b = button("op-chip", label);
      b.disabled = !!off(d);
      b.onclick = () => onPick(iso(d));
      foot.append(b);
    }
    if (!el.required && value) {
      const c = button("op-chip op-clear", "Clear");
      c.onclick = () => onPick("");
      foot.append(c);
    }
    pane.append(foot);
  }
  render();
  return { pane, focus: () => pane.querySelector<HTMLButtonElement>('.op-day[tabindex="0"]')?.focus() };
}

// Time pane: one row per hour (at the field's step), with Morning / Afternoon / Evening jumps.
function timePane(el: HTMLInputElement, value: string, onPick: (hhmm: string) => void) {
  const stepAttr = Number(el.step || 0);
  const step = stepAttr >= 300 ? Math.round(stepAttr / 60) : 15;
  const min = toMin(el.type === "time" ? el.min : "") ?? 0;
  const max = toMin(el.type === "time" ? el.max : "") ?? 1439;
  const cur = toMin(value);
  const pane = document.createElement("div");
  pane.className = "op-time";
  const tabs = document.createElement("div");
  tabs.className = "op-tabs";
  const list = document.createElement("div");
  list.className = "op-times";
  list.style.setProperty("--op-cols", String(Math.min(4, Math.max(2, Math.round(60 / step)))));
  for (let m = 0; m < 1440; m += step) {
    const b = button("op-t", clock(m));
    b.dataset.min = String(m);
    if (m < min || m > max) b.disabled = true;
    if (cur !== null && m === cur) { b.classList.add("on"); b.setAttribute("aria-pressed", "true"); }
    if (m % 60 === 0) b.classList.add("hour");
    b.onclick = () => onPick(clock(m));
    list.append(b);
  }
  const jump = (m: number) => {
    const target = [...list.children].find((x) => Number((x as HTMLElement).dataset.min) >= m) as HTMLElement | undefined;
    if (target) list.scrollTop = target.offsetTop - list.offsetTop - 4;
  };
  for (const [label, m] of [["Morning", 360], ["Afternoon", 720], ["Evening", 1020]] as [string, number][]) {
    const b = button("op-tab", label);
    b.onclick = () => jump(m);
    tabs.append(b);
  }
  pane.append(tabs, list);
  if (cur !== null && cur % step !== 0) {
    // An odd value (typed by hand) still shows as chosen at the top.
    const keep = button("op-t on", clock(cur));
    keep.onclick = () => onPick(clock(cur));
    list.prepend(keep);
  }
  return {
    pane,
    scroll: () => {
      const on = list.querySelector<HTMLElement>(".op-t.on") || list.querySelector<HTMLElement>(`[data-min="${Math.max(min, 540)}"]`);
      if (on) list.scrollTop = on.offsetTop - list.offsetTop - list.clientHeight / 2 + on.offsetHeight / 2;
    },
    focus: () => (list.querySelector<HTMLButtonElement>(".op-t.on") || list.querySelector<HTMLButtonElement>(".op-t:not(:disabled)"))?.focus({ preventScroll: true }),
  };
}

function show(el: HTMLInputElement) {
  if (open?.el === el) return;
  close(false);
  watch(el);
  const kind = el.type as Kind;
  const host = (el.closest("dialog[open]") as HTMLElement | null) || document.body;
  const sheet = narrow() || !fine();
  const pop = document.createElement("div");
  pop.className = `op-pop op-k-${kind}${sheet ? " op-sheet" : ""}`;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", el.getAttribute("aria-label") || (kind === "time" ? "Choose a time" : "Choose a date"));
  const scrim = sheet ? document.createElement("div") : null;
  if (scrim) { scrim.className = "op-scrim"; scrim.onclick = () => close(); host.append(scrim); }
  const value = proto.get!.call(el) as string;
  let focus: () => void = () => {};
  let after: () => void = () => {};
  if (sheet) {
    const top = document.createElement("div");
    top.className = "op-sheet-head";
    const t = document.createElement("strong");
    t.textContent = pop.getAttribute("aria-label")!;
    const x = button("op-done", "Done");
    x.onclick = () => close();
    top.append(t, x);
    pop.append(top);
  }
  if (kind === "date") {
    const d = datePane(el, value, (v) => { commit(el, v); close(); });
    pop.append(d.pane); focus = d.focus;
  } else if (kind === "time") {
    const t = timePane(el, value, (v) => { commit(el, v); close(); });
    pop.append(t.pane); focus = t.focus; after = t.scroll;
  } else {
    let [dPart, tPart] = value.split("T");
    const body = document.createElement("div");
    body.className = "op-both";
    // Picking a day keeps the popover open (the time is still to choose) and redraws the month.
    const pickDay = (v: string) => {
      dPart = v;
      if (!v) { commit(el, ""); close(); return; }
      commit(el, `${v}T${(tPart || "09:00").slice(0, 5)}`);
      body.querySelector(".op-date")!.replaceWith(datePane(el, v, pickDay).pane);
    };
    const d = datePane(el, dPart || "", pickDay);
    const t = timePane(el, (tPart || "").slice(0, 5), (v) => {
      tPart = v;
      commit(el, `${dPart || iso(new Date())}T${v}`);
      close();
    });
    body.append(d.pane, t.pane);
    pop.append(body); focus = d.focus; after = t.scroll;
  }
  host.append(pop);
  place(el, pop);
  after();
  requestAnimationFrame(() => focus());
  const onDown = (e: Event) => {
    const t = e.target as Node;
    if (pop.contains(t) || t === el) return;
    close(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Tab" && !pop.contains(document.activeElement)) close(false);
  };
  const onScroll = (e: Event) => { if (!pop.contains(e.target as Node)) place(el, pop); };
  // Only a real width change closes it (phones resize the height when the address bar moves).
  const width0 = window.innerWidth;
  const onResize = () => { if (Math.abs(window.innerWidth - width0) > 40) close(false); else place(el, pop); };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  open = {
    el, pop, scrim,
    cleanup: () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    },
  };
}

export function installPickers() {
  if (typeof window === "undefined" || (window as Window & { __opInstalled?: 1 }).__opInstalled) return;
  (window as Window & { __opInstalled?: 1 }).__opInstalled = 1;
  injectStyles();
  // Closed-field text uses ::before on the input, which only Chromium renders for date/time inputs.
  // Safari and Firefox keep their own closed-field text (the popover still replaces their pop-up).
  const chromium = !!(navigator as Navigator & { userAgentData?: unknown }).userAgentData;
  if (fine() && chromium) document.documentElement.classList.add("op-fine");
  // Code that asks for the browser picker (e.g. the timetable's date chip) gets ours.
  const native = HTMLInputElement.prototype.showPicker;
  HTMLInputElement.prototype.showPicker = function (this: HTMLInputElement) {
    if (KINDS.has(this.type) && usable(this)) return show(this);
    return native?.call(this);
  };
  // Mouse / pen: open on press, and stop the browser's own pop-up.
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || !isPicker(e.target) || !usable(e.target)) return;
    e.preventDefault();
    const el = e.target;
    el.focus({ preventScroll: true });
    if (open?.el === el) close(false); else show(el);
  }, true);
  // Touch: a tap (not a scroll) opens ours; cancelling touchend stops focus + the native sheet.
  let touch: { x: number; y: number; el: HTMLInputElement } | null = null;
  document.addEventListener("touchstart", (e) => {
    touch = isPicker(e.target) && usable(e.target) ? { x: e.touches[0].clientX, y: e.touches[0].clientY, el: e.target } : null;
  }, { capture: true, passive: true });
  document.addEventListener("touchend", (e) => {
    if (!touch || e.target !== touch.el) return;
    const el = touch.el;
    touch = null;
    e.preventDefault();
    show(el);
  }, { capture: true, passive: false });
  document.addEventListener("touchmove", (e) => {
    if (touch && Math.hypot(e.touches[0].clientX - touch.x, e.touches[0].clientY - touch.y) > 10) touch = null;
  }, { capture: true, passive: true });
  document.addEventListener("click", (e) => { if (isPicker(e.target) && usable(e.target)) e.preventDefault(); }, true);
  // Keyboard: Enter / Space / Alt+Down / F4 open it; typing digits still edits the field.
  document.addEventListener("keydown", (e) => {
    if (!isPicker(e.target) || !usable(e.target)) return;
    if (e.key === "Enter" || e.key === " " || e.key === "F4" || (e.altKey && e.key === "ArrowDown")) { e.preventDefault(); show(e.target); }
  }, true);
  document.addEventListener("input", (e) => { if (isPicker(e.target)) display(e.target); }, true);
  document.addEventListener("reset", () => setTimeout(() => scan(document), 0), true);
  scan(document);
  new MutationObserver((rec) => { for (const r of rec) r.addedNodes.forEach((n) => { if (n instanceof HTMLInputElement) { if (KINDS.has(n.type)) watch(n); } else if (n instanceof Element) scan(n); }); })
    .observe(document.documentElement, { childList: true, subtree: true });
}

// ---- Styles (injected so the shop app and the workspace share them) -------------------
function injectStyles() {
  if (document.getElementById("op-styles")) return;
  const s = document.createElement("style");
  s.id = "op-styles";
  s.textContent = `
.op-pop{--op-a:var(--sp-accent,var(--accent-fill,#00c896));--op-ai:var(--sp-accent-ink,var(--accent-fill-ink,#0b0b0c));--op-soft:var(--sp-soft,var(--mint-soft,#e6fcf4));--op-bg:var(--surface,#fff);--op-ink:var(--ink,#0e0f12);--op-mut:var(--muted,#6b7280);--op-line:var(--line,#e3e5e9);
position:fixed;z-index:2147483000;background:var(--op-bg);color:var(--op-ink);border:1px solid var(--op-line);border-radius:16px;box-shadow:0 24px 60px -18px rgba(14,15,18,.35),0 2px 8px rgba(14,15,18,.06);padding:12px;font:14px/1.3 inherit;font-family:inherit;animation:op-in .14s ease-out;width:304px;box-sizing:border-box}
.op-pop *{box-sizing:border-box;font-family:inherit}
@keyframes op-in{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
.op-pop button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
.op-pop button:disabled{cursor:default;opacity:.32}
.op-pop button:focus-visible{outline:2px solid var(--op-a);outline-offset:1px}
.op-head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:0 0 8px}
.op-title{font-weight:650;font-size:15px;padding:6px 10px;border-radius:10px;letter-spacing:-.01em}
.op-title:hover{background:var(--op-soft)}
.op-nav{width:34px;height:34px;border-radius:50%;font-size:20px!important;line-height:1;display:grid;place-items:center;color:var(--op-mut)!important}
.op-nav:hover{background:var(--op-soft);color:var(--op-ink)!important}
.op-dow,.op-days{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.op-dow span{text-align:center;font-size:11px;font-weight:600;color:var(--op-mut);text-transform:uppercase;letter-spacing:.04em;padding:4px 0}
.op-day{height:38px;border-radius:50%;font-variant-numeric:tabular-nums;font-weight:500;transition:background .12s}
.op-day:hover:not(:disabled){background:var(--op-soft)}
.op-day.out{color:var(--op-mut);opacity:.55}
.op-day.now{box-shadow:inset 0 0 0 1.5px var(--op-a);font-weight:650}
.op-day.on{background:var(--op-a)!important;color:var(--op-ai)!important;font-weight:700;opacity:1}
.op-grid.op-months,.op-grid.op-years{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:4px 0}
.op-cell{height:44px;border-radius:12px;font-weight:550}
.op-cell:hover{background:var(--op-soft)}
.op-cell.now{box-shadow:inset 0 0 0 1.5px var(--op-a)}
.op-cell.on{background:var(--op-a);color:var(--op-ai)!important;font-weight:700}
.op-foot{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--op-line)}
.op-chip{padding:6px 11px;border-radius:999px;border:1px solid var(--op-line)!important;font-size:12.5px;font-weight:600}
.op-chip:hover:not(:disabled){border-color:var(--op-a)!important;background:var(--op-soft)}
.op-clear{margin-left:auto;color:var(--op-mut)!important}
.op-k-time{width:264px}
.op-tabs{display:flex;gap:4px;margin:0 0 8px;padding:3px;background:var(--surface-2,#f3f4f6);border-radius:10px}
.op-tab{flex:1;padding:6px 4px;border-radius:8px;font-size:12px;font-weight:600;color:var(--op-mut)!important}
.op-tab:hover{background:var(--op-bg);color:var(--op-ink)!important}
.op-times{display:grid;grid-template-columns:repeat(var(--op-cols,4),1fr);gap:4px;max-height:248px;overflow-y:auto;overscroll-behavior:contain;padding:2px;scrollbar-width:thin}
.op-t{height:36px;border-radius:10px;font-variant-numeric:tabular-nums;font-size:13.5px;font-weight:500;color:var(--op-mut)!important}
.op-t.hour{color:var(--op-ink)!important;font-weight:650}
.op-t:hover:not(:disabled){background:var(--op-soft);color:var(--op-ink)!important}
.op-t.on{background:var(--op-a)!important;color:var(--op-ai)!important;font-weight:700}
.op-k-datetime-local{width:auto}
.op-both{display:grid;grid-template-columns:280px 220px;gap:14px}
.op-both .op-time{border-left:1px solid var(--op-line);padding-left:14px}
.op-both .op-times{max-height:286px}
.op-scrim{position:fixed;inset:0;background:rgba(11,11,12,.32);z-index:2147482999;animation:op-fade .16s ease-out}
@keyframes op-fade{from{opacity:0}}
.op-pop.op-sheet{left:0!important;right:0;bottom:0;top:auto!important;width:100%;max-width:100%;border-radius:22px 22px 0 0;padding:10px 16px calc(16px + env(safe-area-inset-bottom));animation:op-up .22s cubic-bezier(.2,.8,.2,1);max-height:88vh;overflow:auto}
@keyframes op-up{from{transform:translateY(100%)}}
.op-sheet-head{display:flex;align-items:center;justify-content:space-between;margin:0 0 8px;padding:4px 0 8px;border-bottom:1px solid var(--op-line)}
.op-sheet-head strong{font-size:15px}
.op-done{font-weight:650!important;color:var(--accent,var(--op-ink))!important;padding:8px 4px}
.op-sheet .op-day{height:44px}
.op-sheet .op-t{height:44px;font-size:15px}
.op-sheet .op-times{max-height:46vh}
.op-sheet .op-both{grid-template-columns:1fr;gap:10px}
.op-sheet .op-both .op-time{border-left:0;padding-left:0;border-top:1px solid var(--op-line);padding-top:10px}
.op-sheet .op-both .op-times{max-height:28vh}
/* Closed field (desktop): readable text + one calm icon instead of the browser's controls. */
html.op-fine input.op-enh{position:relative;cursor:pointer}
html.op-fine input.op-enh::-webkit-datetime-edit{color:transparent}
html.op-fine input.op-enh::-webkit-calendar-picker-indicator{opacity:0;cursor:pointer}
html.op-fine input.op-enh::before{content:attr(data-display);position:absolute;inset:0;display:flex;align-items:center;padding-left:inherit;padding-right:30px;white-space:nowrap;overflow:hidden;color:var(--ink,#0e0f12);pointer-events:none;font-variant-numeric:tabular-nums}
html.op-fine input.op-enh.op-empty::before{color:var(--muted,#8a8f98)}
html.op-fine input.op-enh{background-repeat:no-repeat;background-position:right 10px center;background-size:16px}
html.op-fine input.op-date,html.op-fine input.op-datetime-local{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4' width='18' height='18' rx='3'/%3E%3Cpath d='M16 2v4M8 2v4M3 10h18'/%3E%3C/svg%3E")}
html.op-fine input.op-time{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M12 7v5l3 2'/%3E%3C/svg%3E")}
@media (prefers-reduced-motion: reduce){.op-pop,.op-scrim{animation:none!important}}
`;
  document.head.append(s);
}
