// Website editor — full-screen. The real shop page fills the canvas; click anything on it to
// select it. The inspector on the right shows the selected element's colours and its section's
// layout choices; the left rail lists sections (show/hide, reorder) and the design system
// (brand colours, type, look). Edits autosave as a draft; Publish makes them live.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { PAGE_COPY_DEFAULTS, type PageCopy, type PageCopyKey, type WorkspaceData } from "../server/domain";
import { Button, Icon } from "./ui";
import { PhotoUpload } from "./Media";
import { ShopPageView, type PageData, type SectionVariants, type ElementStyles } from "./ShopPage";
import { shopWeekOf } from "./fixtures";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type ThemeForm = { font: string; mode: string; corners: string; hero: string; logo: string };
export type PageForm = {
  strapline: string; about: string; cover_url: string; logo_url: string; gallery: string[]; phone: string; email: string; instagram: string; map_url: string; transport_note: string; policy_text: string;
  sections: string[]; accent: string; theme: ThemeForm; primary_hex: string; secondary_hex: string; variants: SectionVariants; element_styles: ElementStyles; copy: PageCopy; google_review_url: string; published: number; version: number;
};
const HEX = /^#[0-9a-fA-F]{6}$/;
const FONTS: { id: string; name: string; note: string }[] = [
  { id: "modern", name: "Modern", note: "Inter" }, { id: "editorial", name: "Editorial", note: "Fraunces" }, { id: "grotesk", name: "Grotesk", note: "Space Grotesk" },
  { id: "heritage", name: "Heritage", note: "Playfair" }, { id: "condensed", name: "Condensed", note: "Bebas Neue" }, { id: "soft", name: "Soft", note: "DM Sans" },
];
const ACCENTS: { id: string; hex: string; name: string }[] = [
  { id: "ollo", hex: "#3a7563", name: "Green" }, { id: "ink", hex: "#1d1f26", name: "Ink" }, { id: "sage", hex: "#3f7d5c", name: "Sage" },
  { id: "clay", hex: "#a8552f", name: "Clay" }, { id: "plum", hex: "#6e3b7a", name: "Plum" }, { id: "slate", hex: "#4a5568", name: "Slate" },
];
const STOCK = ["brick", "minimal", "heritage", "industrial", "terracotta", "tools"];
export const SECTIONS: { key: string; label: string; icon: string; fixed?: boolean; layouts?: [string, string][] }[] = [
  { key: "nav", label: "Top bar", icon: "menu", fixed: true },
  { key: "hero", label: "Hero", icon: "image", layouts: [["editorial", "Editorial"], ["centred", "Centred"], ["split", "Split"], ["cover", "Full cover"], ["minimal", "Minimal"]] },
  { key: "next", label: "Next available", icon: "clock", layouts: [["strip", "Tiles"], ["card", "List"]] },
  { key: "services", label: "Services", icon: "scissors", layouts: [["menu", "Menu"], ["cards", "Cards"], ["grid", "Grid"], ["tabs", "Tabs"]] },
  { key: "team", label: "Team", icon: "users", layouts: [["cards", "Cards"], ["list", "List"], ["portraits", "Portraits"], ["compact", "Compact"]] },
  { key: "cta", label: "Book a visit", icon: "calendar", fixed: true, layouts: [["band", "Colour band"], ["card", "Quiet card"]] },
  { key: "hours", label: "Opening hours", icon: "clock", layouts: [["table", "Table"], ["chips", "Chips"]] },
  { key: "find", label: "Find us", icon: "pin", layouts: [["card", "Address"], ["map", "Map"]] },
  { key: "gallery", label: "Gallery", icon: "image", layouts: [["grid", "Grid"], ["masonry", "Masonry"], ["strip", "Strip"]] },
  { key: "reviews", label: "Reviews", icon: "star", layouts: [["cards", "Cards"], ["wall", "Wall"], ["carousel", "Carousel"], ["quote", "Pull quote"]] },
  { key: "policies", label: "Good to know", icon: "shield", layouts: [["plain", "Plain"], ["panel", "Panel"]] },
  { key: "footer", label: "Footer", icon: "more", fixed: true, layouts: [["simple", "Simple"], ["columns", "Columns"]] },
];
const EL_LABEL: Record<string, string> = {
  "page.bg": "Page background", "page.surface": "Cards & surfaces", "page.text": "Text",
  nav: "Top bar", "nav.button": "Book now button",
  hero: "Hero", "hero.title": "Shop name", "hero.strap": "Strapline", "hero.button": "Book button", "hero.button2": "Call / Directions", "hero.open": "Open now badge",
  "next.card": "Time tile", "next.time": "Time",
  "services.card": "Service row", "services.price": "Price", "services.tag": "Popular tag",
  "team.card": "Barber card", "team.button": "Book with… button", "team.pill": "Next free pill",
  cta: "Booking band", "cta.button": "Start booking button",
  "hours.card": "Hours card", "hours.today": "Today row",
  "find.card": "Find us card", gallery: "Gallery", "reviews.card": "Review card", "reviews.stars": "Stars", policies: "Good to know", footer: "Footer", "footer.link": "Footer text & links",
  "next.title": "Heading", "next.sub": "Sub-line", "services.title": "Heading", "services.sub": "Sub-line", "team.title": "Heading", "team.sub": "Sub-line",
  "cta.title": "Heading", "cta.sub": "Sub-line", "hours.title": "Heading", "find.title": "Heading", "reviews.title": "Heading", "policies.title": "Heading",
};
// Text-only elements: the inspector shows the wording field first and only a text colour.
const EL_TEXT: Record<string, PageCopyKey> = {
  "nav.button": "nav.button", "hero.button": "hero.button", "cta.button": "cta.button",
  "next.title": "next.title", "next.sub": "next.sub", "services.title": "services.title", "services.sub": "services.sub", "team.title": "team.title", "team.sub": "team.sub",
  "cta.title": "cta.title", "cta.sub": "cta.sub", "hours.title": "hours.title", "find.title": "find.title", "reviews.title": "reviews.title", "policies.title": "policies.title",
};
// Wording each section owns, shown in the inspector whenever anything in that section is selected.
const SEC_COPY: Record<string, PageCopyKey[]> = {
  nav: ["nav.button"], hero: ["hero.button", "hero.call", "hero.directions"], next: ["next.title", "next.sub"], services: ["services.title", "services.sub"],
  team: ["team.title", "team.sub"], cta: ["cta.title", "cta.sub", "cta.button"], hours: ["hours.title"], find: ["find.title"], gallery: [], reviews: ["reviews.title"], policies: ["policies.title"],
};
const COPY_LABEL: Record<PageCopyKey, string> = {
  "nav.button": "Top bar button", "hero.button": "Book button", "hero.call": "Call button", "hero.directions": "Directions button",
  "next.title": "Heading", "next.sub": "Sub-line", "services.title": "Heading", "services.sub": "Sub-line", "team.title": "Heading", "team.sub": "Sub-line",
  "cta.title": "Heading", "cta.sub": "Sub-line", "cta.button": "Button", "hours.title": "Heading", "find.title": "Heading", "gallery.title": "Heading", "reviews.title": "Heading", "policies.title": "Heading",
};
const EL_HAS: Record<string, ("bg" | "fg")[]> = {
  "page.bg": ["bg"], "page.surface": ["bg"], "page.text": ["fg"],
  "hero.title": ["fg"], "hero.strap": ["fg"], "next.time": ["fg"], "services.price": ["fg"], "reviews.stars": ["fg"], "footer.link": ["fg"],
  "next.title": ["fg"], "next.sub": ["fg"], "services.title": ["fg"], "services.sub": ["fg"], "team.title": ["fg"], "team.sub": ["fg"],
  "cta.title": ["fg"], "cta.sub": ["fg"], "hours.title": ["fg"], "find.title": ["fg"], "reviews.title": ["fg"], "policies.title": ["fg"],
};
export function pageFormOf(p: Record<string, unknown>): PageForm {
  const j = <T,>(v: unknown, d: T): T => { try { return JSON.parse(String(v || "")) as T; } catch { return d; } };
  const t = j<Partial<ThemeForm>>(p.theme_json, {});
  return {
    strapline: String(p.strapline || ""), about: String(p.about || ""), cover_url: String(p.cover_url || ""), logo_url: String(p.logo_url || ""), gallery: j<string[]>(p.gallery_json, []),
    phone: String(p.phone || ""), email: String(p.email || ""), instagram: String(p.instagram || ""), map_url: String(p.map_url || ""), transport_note: String(p.transport_note || ""), policy_text: String(p.policy_text || ""),
    sections: j<string[]>(p.sections_json, ["hero", "next", "services", "team", "hours", "gallery", "reviews", "find", "policies"]), accent: String(p.accent || "ollo"),
    theme: { font: t.font || "modern", mode: t.mode || "light", corners: t.corners || "soft", hero: t.hero || "editorial", logo: t.logo || "auto" },
    primary_hex: String(p.primary_hex || ""), secondary_hex: String(p.secondary_hex || ""), variants: j<SectionVariants>(p.variants_json, {}), element_styles: j<ElementStyles>(p.element_styles_json, {}), copy: j<PageCopy>(p.copy_json, {}),
    google_review_url: String(p.google_review_url || ""), published: Number(p.published ?? 1), version: Number(p.version ?? 0),
  };
}
const inkOn = (hex: string) => { const n = parseInt(hex.slice(1), 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#14151a" : "#ffffff"; };

export function WebsiteEditor({ w, api, onClose, onPublished }: { w: WorkspaceData; api: Api; onClose: () => void; onPublished: () => void }) {
  const [form, setForm] = useState<PageForm | null>(null);
  const [live, setLive] = useState<PageForm | null>(null);
  const [history, setHistory] = useState<PageForm[]>([]);
  const [future, setFuture] = useState<PageForm[]>([]);
  const [device, setDevice] = useState<"phone" | "tablet" | "desktop">("desktop");
  const [selected, setSelected] = useState<{ el: string; sec: string } | null>(null);
  const [panel, setPanel] = useState<"sections" | "design" | "content">("sections");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [action, setAction] = useState<"publish" | "discard" | "close" | "reload" | null>(null);
  const [error, setError] = useState("");
  const [draftError, setDraftError] = useState("");
  const [conflict, setConflict] = useState(false);
  const conflicted = useRef(false);
  const serverDraftAt = useRef<number | null>(null);
  const [hadDraft, setHadDraft] = useState(false);
  const [uploadCount, setUploadCount] = useState(0);
  const [reload, setReload] = useState(0);
  const saveTimer = useRef(0);
  const inspector = useRef<HTMLElement>(null);
  const inspecting = !!selected;
  useEffect(() => {
    if (!inspecting) return;
    const launch = document.activeElement as HTMLElement | null;
    if (!inspector.current?.contains(launch)) inspector.current?.focus();
    return () => { if (launch?.isConnected) launch.focus(); };
  }, [inspecting]);
  const mounted = useRef(true);
  const current = useRef<PageForm | null>(null);
  const past = useRef<PageForm[]>([]);
  const ahead = useRef<PageForm[]>([]);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const actionLock = useRef(false);
  const uploads = useRef(0);
  const shortcuts = useRef({ undo: () => {}, redo: () => {}, save: () => {} });
  const blocked = !!action || uploadCount > 0;

  useEffect(() => {
    let cancelled = false;
    setError("");
    api<{ page: Record<string, unknown> }>("/shop/page").then((r) => {
      if (cancelled) return;
      adoptPage(r.page);
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the page."); });
    return () => { cancelled = true; };
  }, [reload]);
  useEffect(() => {
    mounted.current = true;
    document.body.classList.add("editor-open");
    const key = (e: KeyboardEvent) => {
      if (actionLock.current || uploads.current) return;
      if (e.key === "Escape") setSelected(null);
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "s") { e.preventDefault(); shortcuts.current.save(); }
      // Native text undo belongs to the input, not the whole-page history.
      if (e.key.toLowerCase() === "z" && !(e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable="true"]'))) {
        e.preventDefault(); if (e.shiftKey) shortcuts.current.redo(); else shortcuts.current.undo();
      }
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (revision.current !== savedRevision.current || uploads.current || actionLock.current || conflicted.current) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("keydown", key);
    window.addEventListener("beforeunload", unload);
    return () => {
      mounted.current = false;
      window.clearTimeout(saveTimer.current);
      document.body.classList.remove("editor-open");
      window.removeEventListener("keydown", key);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);

  const dirty = !!form && !!live && JSON.stringify({ ...form, version: 0 }) !== JSON.stringify({ ...live, version: 0 });
  const clean = (f: PageForm) => ({ ...f, gallery: f.gallery.filter(Boolean), primary_hex: HEX.test(f.primary_hex) ? f.primary_hex.toLowerCase() : "", secondary_hex: HEX.test(f.primary_hex) && HEX.test(f.secondary_hex) ? f.secondary_hex.toLowerCase() : "", element_styles: Object.fromEntries(Object.entries(f.element_styles).filter(([, v]) => v && (v.bg || v.fg))), copy: Object.fromEntries(Object.entries(f.copy || {}).filter(([, v]) => !!v && String(v).trim())) });
  function setCurrent(f: PageForm) { current.current = f; setForm(f); }
  function historyChanged() { setHistory([...past.current]); setFuture([...ahead.current]); }
  function update(patch: Partial<PageForm> | ((f: PageForm) => Partial<PageForm>)) {
    const f = current.current;
    if (!f || actionLock.current) return;
    const next = { ...f, ...(typeof patch === "function" ? patch(f) : patch) };
    if (JSON.stringify(next) === JSON.stringify(f)) return;
    past.current = [...past.current.slice(-49), f]; ahead.current = [];
    historyChanged(); setCurrent(next); scheduleDraft(next);
  }
  function undo() {
    if (actionLock.current || uploads.current || !current.current || !past.current.length) return;
    const prev = past.current.pop()!;
    ahead.current.unshift(current.current); historyChanged(); setCurrent(prev); scheduleDraft(prev);
  }
  function redo() {
    if (actionLock.current || uploads.current || !current.current || !ahead.current.length) return;
    const next = ahead.current.shift()!;
    past.current.push(current.current); historyChanged(); setCurrent(next); scheduleDraft(next);
  }
  function adoptPage(page: Record<string, unknown>) {
    const l = pageFormOf(page);
    let f = l;
    if (page.draft_json) {
      try { f = { ...l, ...JSON.parse(String(page.draft_json)), version: l.version }; } catch { /* keep live page */ }
    }
    serverDraftAt.current = page.draft_updated_at == null ? null : Number(page.draft_updated_at);
    resetTo(l);
    setCurrent(f); setHadDraft(!!page.draft_json); setSelected(null);
  }
  function markConflict(e: unknown) {
    if (typeof e !== "object" || e === null || !("status" in e) || e.status !== 409) return false;
    conflicted.current = true; setConflict(true);
    window.clearTimeout(saveTimer.current); setSaveState("error");
    return true;
  }
  const conflictMessage = "This website changed in another editor. Autosave is paused and your local edits are still here. Download a copy if needed, then load the latest draft to continue.";
  function assertNoConflict() { if (conflicted.current) throw new Error(conflictMessage); }
  function downloadDraft() {
    if (!current.current || uploads.current) return;
    try {
      const blob = new Blob([JSON.stringify({ shop_id: w.shop.id, exported_at: new Date().toISOString(), page: clean(current.current) }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `website_draft_${(w.shop.slug || "shop").replace(/[^a-z0-9_-]/gi, "_")}.json`;
      link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError("Could not download your draft. Your edits are still here."); }
  }
  async function loadLatest() {
    if (actionLock.current || uploads.current || !window.confirm("Replace this editor's local changes with the latest saved draft? Download a copy first if you want to keep them.")) return;
    if (!begin("reload")) return;
    try {
      await writes.current;
      const r = await api<{ page: Record<string, unknown> }>("/shop/page");
      adoptPage(r.page); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load the latest draft. Your edits are still here."); }
    finally { finish(); }
  }
  function persist(f: PageForm, rev: number) {
    const write = writes.current.then(async () => {
      if (!mounted.current || rev !== revision.current || savedRevision.current === rev) return;
      assertNoConflict();
      try {
        const r = await api<{ draft_updated_at: number }>("/shop/page/draft", "PUT", { ...clean(f), expected_draft_at: serverDraftAt.current });
        serverDraftAt.current = r.draft_updated_at;
        savedRevision.current = rev;
        if (mounted.current && revision.current === rev) { setSaveState("saved"); setDraftError(""); setHadDraft(true); }
      } catch (e) {
        if (mounted.current) markConflict(e);
        if (mounted.current && revision.current === rev) { setSaveState("error"); setDraftError(e instanceof Error ? e.message : "Could not save your draft."); }
        throw e;
      }
    });
    // One write at a time; a failed request must not poison subsequent retries.
    writes.current = write.catch(() => {});
    return write;
  }
  function scheduleDraft(f: PageForm) {
    const rev = ++revision.current;
    window.clearTimeout(saveTimer.current);
    if (conflicted.current) { setSaveState("error"); return; }
    setSaveState("saving"); setDraftError("");
    saveTimer.current = window.setTimeout(() => { void persist(f, rev).catch(() => {}); }, 700);
  }
  async function flushDraft() {
    window.clearTimeout(saveTimer.current);
    await writes.current;
    assertNoConflict();
    if (current.current && revision.current !== savedRevision.current) {
      setSaveState("saving");
      await persist(current.current, revision.current);
    }
  }
  async function retryDraft() {
    if (actionLock.current || uploads.current || conflicted.current) return;
    setError("");
    try { await flushDraft(); } catch { /* error and retry stay visible */ }
  }
  shortcuts.current = { undo, redo, save: () => { void retryDraft(); } };
  function uploadBusy(busy: boolean) {
    uploads.current = Math.max(0, uploads.current + (busy ? 1 : -1));
    setUploadCount(uploads.current);
  }
  function begin(next: "publish" | "discard" | "close" | "reload") {
    if (actionLock.current || uploads.current || (conflicted.current && next !== "reload")) return false;
    actionLock.current = true; setAction(next); setError("");
    window.clearTimeout(saveTimer.current);
    return true;
  }
  function finish() { actionLock.current = false; if (mounted.current) setAction(null); }
  function resetTo(f: PageForm) {
    conflicted.current = false; setConflict(false);
    setLive(f); setCurrent(f); past.current = []; ahead.current = []; historyChanged();
    savedRevision.current = ++revision.current;
    setHadDraft(false); setSaveState("idle"); setDraftError("");
  }
  async function publish() {
    if (!current.current || !begin("publish")) return;
    try {
      await writes.current;
      assertNoConflict();
      const r = await api<{ page: Record<string, unknown> }>("/shop/page", "PUT", { ...clean(current.current), expected_draft_at: serverDraftAt.current });
      adoptPage(r.page); onPublished();
    } catch (e) {
      markConflict(e);
      setError(e instanceof Error ? e.message : "Could not publish. Your changes are kept here.");
      if (revision.current !== savedRevision.current) setSaveState("error");
    }
    finally { finish(); }
  }
  async function discard() {
    if (!live || actionLock.current || uploads.current || !window.confirm("Discard your unpublished changes and restore the saved page?")) return;
    if (!begin("discard")) return;
    try {
      await writes.current;
      assertNoConflict();
      const r = await api<{ page: Record<string, unknown> }>("/shop/page/draft", "DELETE", { version: live.version, expected_draft_at: serverDraftAt.current });
      adoptPage(r.page);
    } catch (e) {
      markConflict(e);
      setError(e instanceof Error ? e.message : "Could not discard. Your changes are kept here.");
      if (revision.current !== savedRevision.current) setSaveState("error");
    }
    finally { finish(); }
  }
  async function close() {
    if (!begin("close")) return;
    try { await flushDraft(); onClose(); }
    catch { setError("Your latest changes could not be saved. Retry saving, or explicitly discard them before leaving."); }
    finally { finish(); }
  }

  // Preview data: the real page fed with the draft + the shop's real staff/services.
  const data: PageData | null = useMemo(() => {
    if (!form) return null;
    const today = w.today;
    const week = shopWeekOf(w.shop);
    const day = week[new Date(`${today}T12:00:00Z`).getUTCDay()];
    const staff = (w.staff as { id: string; name: string; role: string; active?: number; online_visible?: number; title?: string; bio?: string; colour?: string; photo_url?: string; skills?: string; instagram?: string }[]).filter((x) => x.active !== 0 && x.online_visible !== 0);
    const services = (w.services as { id: string; name: string; category?: string; duration_min: number; price_pence: number; description?: string; colour?: string; popular?: number; active?: number; online_bookable?: number }[]).filter((x) => x.active !== 0 && x.online_bookable !== 0);
    return {
      shop: { id: w.shop.id, name: w.shop.name, address: w.shop.address, slug: w.shop.slug || "preview", timezone: w.shop.timezone, currency: w.shop.currency, opens: day.starts, closes: day.ends, deposit_pence: w.shop.deposit_pence, cancel_hours: w.shop.cancel_hours, lead_time_min: w.shop.lead_time_min ?? 60, booking_window_days: w.shop.booking_window_days ?? 30 },
      page: { ...form, gallery: form.gallery.filter(Boolean), logo_tone: form.logo_url === w.logo_url ? ((w as { logo_tone?: "light" | "dark" | "colour" | "" }).logo_tone || "") : "" },
      staff, services: services.map((x) => ({ ...x, category: x.category || "Services" })),
      week: week.map((d, i) => (d.enabled ? { weekday: i, open: true as const, starts: d.starts, ends: d.ends } : { weekday: i, open: false as const })),
      open_now: true, today, closures: [],
      soonest: staff.slice(0, 4).map((st, i) => ({ staff_id: st.id, staff_name: st.name, date: today, start_min: 600 + i * 30, service_id: services[0]?.id || "", price_pence: services[0]?.price_pence || 0 })),
      reviews: [
        { id: "p1", rating: 5, body: "Best fade I've had in years. Booked online in a minute, in and out on time.", display_name: "Jordan", reply: "", reply_at: null, created_at: Date.now() - 864e5 * 9, service_name: services[0]?.name || "Cut", staff_name: staff[0]?.name || null },
        { id: "p2", rating: 5, body: "Proper attention to detail. Will be back.", display_name: "Sam", reply: "Thanks Sam, see you next month.", reply_at: Date.now(), created_at: Date.now() - 864e5 * 30, service_name: services[1]?.name || services[0]?.name || "Cut", staff_name: staff[1]?.name || staff[0]?.name || null },
        { id: "p3", rating: 4, body: "Great cut, easy to book.", display_name: "Alex", reply: "", reply_at: null, created_at: Date.now() - 864e5 * 60, service_name: services[0]?.name || "Cut", staff_name: null },
      ],
      rating: { count: 3, average: 4.7 },
    };
  }, [form, w]);

  if (error && !form) return <div className="wed wed-error"><p className="workspace-error" role="alert">{error}</p><Button onClick={() => setReload(n => n + 1)}>Retry loading page</Button><Button onClick={onClose}>Back</Button></div>;
  if (!form || !data) return <div className="wed wed-loading" data-testid="website-editor"><p role="status">Opening the editor…</p></div>;

  const sec = selected ? SECTIONS.find((s) => s.key === selected.sec) : null;
  const elStyle = selected ? form.element_styles[selected.el] || {} : {};
  const has = (k: string) => form.sections.includes(k);
  const setEl = (k: "bg" | "fg", v: string) => selected && update((f) => ({ element_styles: { ...f.element_styles, [selected.el]: { ...(f.element_styles[selected.el] || {}), [k]: v } } }));
  // Live colour of an element on the canvas (what the palette is currently painting it).
  const liveColour = (el: string, k: "bg" | "fg"): string | undefined => {
    const n = document.querySelector<HTMLElement>(`#sp-editor-scope [data-el="${el}"]`) || (el === "page.bg" ? document.querySelector<HTMLElement>("#sp-editor-scope") : null);
    if (!n) return undefined;
    const v = getComputedStyle(n)[k === "bg" ? "backgroundColor" : "color"];
    const m = v.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return undefined;
    if (/rgba\(.*,\s*0\)$/.test(v)) return undefined;
    return "#" + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("");
  };
  const clearEl = () => selected && update((f) => { const n = { ...f.element_styles }; delete n[selected.el]; return { element_styles: n }; });
  // Palette tokens live in element_styles under page.* / hero so the public page needs no new field.
  const setTok = (el: string, k: "bg" | "fg", v: string) => update((f) => { const cur = { ...(f.element_styles[el] || {}) }; if (v) cur[k] = v; else delete cur[k]; const n = { ...f.element_styles }; if (cur.bg || cur.fg) n[el] = cur; else delete n[el]; return { element_styles: n }; });
  const TOKENS = new Set(["page.bg", "page.surface", "page.text", "hero"]);
  const overrides = Object.entries(form.element_styles).filter(([k, v]) => !TOKENS.has(k) && v && (v.bg || v.fg)) as [string, { bg?: string; fg?: string }][];
  const move = (k: string, dir: -1 | 1) => update((f) => { const arr = [...f.sections]; const i = arr.indexOf(k); const j = i + dir; if (i < 0 || j < 0 || j >= arr.length) return {}; [arr[i], arr[j]] = [arr[j], arr[i]]; return { sections: arr }; });
  const shown = SECTIONS.filter((s) => s.fixed || has(s.key)).sort((a, b) => (a.key === "nav" ? -1 : b.key === "nav" ? 1 : a.key === "footer" ? 1 : b.key === "footer" ? -1 : a.key === "cta" ? 0 : form.sections.indexOf(a.key) - form.sections.indexOf(b.key)));
  const hidden = SECTIONS.filter((s) => !s.fixed && !has(s.key));
  const primary = HEX.test(form.primary_hex) ? form.primary_hex : ACCENTS.find((a) => a.id === form.accent)?.hex || "#3a7563";

  return (
    <div className={`wed device-${device}`} data-testid="website-editor" role="region" aria-label="Website editor" aria-busy={!!action || uploadCount > 0}>
      <header className="wed-top">
        <div className="wed-top-left">
          <button type="button" className="wed-iconbtn" onClick={close} disabled={blocked || conflict} aria-label="Close editor" data-testid="wed-close"><Icon name="left" size={18} /></button>
          <span className="wed-title"><b>{w.shop.name}</b><small>Website</small></span>
          <span className={`wed-save s-${saveState}`} role="status" data-testid="wed-save">{uploadCount ? "Uploading image…" : action === "reload" ? "Loading latest draft…" : conflict ? "Draft conflict · paused" : action === "close" ? "Saving before closing…" : action === "discard" ? "Discarding…" : action === "publish" ? "Publishing…" : saveState === "error" ? "Draft not saved" : saveState === "saving" ? "Saving draft…" : dirty || hadDraft ? "Draft saved · not live" : live?.published ? "Published" : "Page hidden"}</span>
        </div>
        <div className="wed-top-mid">
          <div className="wed-history">
            <button type="button" className="wed-iconbtn" onClick={undo} disabled={blocked || !history.length} aria-label="Undo" data-testid="wed-undo"><Icon name="undo" size={16} /></button>
            <button type="button" className="wed-iconbtn" onClick={redo} disabled={blocked || !future.length} aria-label="Redo"><Icon name="redo" size={16} /></button>
          </div>
          <div className="wed-devices" role="group" aria-label="Preview size">
            {(["phone", "tablet", "desktop"] as const).map((d) => (
              <button key={d} type="button" aria-pressed={device === d} onClick={() => setDevice(d)} aria-label={d} title={d[0].toUpperCase() + d.slice(1)} data-testid={`wed-device-${d}`}>
                <Icon name={d === "phone" ? "phone" : d === "tablet" ? "tablet" : "monitor"} size={17} />
              </button>
            ))}
          </div>
        </div>
        <div className="wed-top-right">
          {w.shop.slug && <a className="button ghost" href={`/${w.shop.slug}`} target="_blank" rel="noreferrer"><Icon name="external" size={14} /> View live</a>}
          {(dirty || hadDraft) && <Button disabled={blocked || conflict} variant="ghost" onClick={discard} data-testid="wed-discard">Discard</Button>}
          <Button onClick={publish} disabled={blocked || conflict || !dirty} data-testid="wed-publish">{action === "publish" ? "Publishing…" : dirty ? form.published ? "Publish" : "Save hidden page" : live?.published ? "Published" : "Page hidden"}</Button>
        </div>
      </header>
      {(conflict || error || draftError) && <div className="wed-toast" role="alert" data-testid="wed-feedback">
        <span>{conflict ? conflictMessage : error || draftError}</span>
        {conflict ? <>
          {error && <small>{error}</small>}
          <Button variant="secondary" disabled={blocked} onClick={downloadDraft}>Download my draft</Button>
          <Button variant="secondary" disabled={blocked} onClick={loadLatest}>Load latest draft</Button>
        </> : saveState === "error" && <Button variant="secondary" disabled={blocked} onClick={retryDraft}>Retry saving draft</Button>}
      </div>}

      <aside className="wed-left" aria-label="Page" inert={blocked}>
        <div className="wed-tabs" role="tablist" aria-label="Editor panels" onKeyDown={e => {
          const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
          const next = e.key === "ArrowRight" ? (index + 1) % tabs.length : e.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
          if (next >= 0) { e.preventDefault(); tabs[next].click(); tabs[next].focus(); }
        }}>
          {([["sections", "Sections"], ["design", "Design"], ["content", "Content"]] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" id={`wed-tab-${k}`} aria-controls={panel === k ? `wed-panel-${k}` : undefined} tabIndex={panel === k ? 0 : -1} aria-selected={panel === k} onClick={() => setPanel(k)} data-testid={`wed-panel-${k}`}>{l}</button>
          ))}
        </div>
        {panel === "sections" && (
          <div className="wed-panel" data-testid="wed-sections" id="wed-panel-sections" role="tabpanel" aria-labelledby="wed-tab-sections">
            <ol className="wed-seclist">
              {shown.map((s) => {
                const i = form.sections.indexOf(s.key);
                return (
                  <li key={s.key} data-active={selected?.sec === s.key}>
                    <button type="button" className="wed-secbtn" onClick={() => { setSelected({ el: s.key === "nav" ? "nav" : s.key === "hero" ? "hero" : s.key === "cta" ? "cta" : s.key === "footer" ? "footer" : s.key === "hours" ? "hours.card" : s.key === "find" ? "find.card" : s.key === "gallery" ? "gallery" : s.key === "policies" ? "policies" : `${s.key}.card`, sec: s.key }); document.querySelector(`#sp-editor-scope [data-sec="${s.key}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }} data-testid={`wed-sec-${s.key}`}>
                      <Icon name={s.icon as "menu"} size={15} /> <span>{s.label}</span>
                    </button>
                    {!s.fixed && (
                      <span className="wed-secactions">
                        <button type="button" className="wed-mini" onClick={() => move(s.key, -1)} disabled={i <= 0} aria-label={`Move ${s.label} up`}><Icon name="up" size={13} /></button>
                        <button type="button" className="wed-mini" onClick={() => move(s.key, 1)} disabled={i < 0 || i >= form.sections.length - 1} aria-label={`Move ${s.label} down`}><Icon name="down" size={13} /></button>
                        <button type="button" className="wed-mini" onClick={() => update((f) => ({ sections: f.sections.filter((k) => k !== s.key) }))} aria-label={`Hide ${s.label}`} title="Hide"><Icon name="eyeOff" size={13} /></button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            {hidden.length > 0 && (
              <div className="wed-hidden">
                <p className="wed-label">Add a section</p>
                {hidden.map((s) => (
                  <button key={s.key} type="button" className="wed-addsec" onClick={() => update((f) => ({ sections: [...f.sections, s.key] }))} data-testid={`wed-add-${s.key}`}><Icon name="plus" size={14} /> {s.label}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {panel === "design" && (
          <div className="wed-panel" data-testid="wed-design" id="wed-panel-design" role="tabpanel" aria-labelledby="wed-tab-design">
            <p className="wed-intro">Your palette sets every colour on the page. Click any element on the canvas to override just that one.</p>
            <p className="wed-label">Palette</p>
            <div className="wed-palette">
              <ColourRow label="Brand" hint="Buttons, links, the booking band" value={HEX.test(form.primary_hex) ? form.primary_hex : primary} onChange={(v) => update({ primary_hex: v })} onClear={form.primary_hex ? () => update({ primary_hex: "", secondary_hex: "" }) : undefined} testId="wed-primary-hex" />
              <ColourRow label="Highlight" hint="Tags, stars, small accents" value={HEX.test(form.secondary_hex) ? form.secondary_hex : ""} current={liveColour("services.tag", "fg") || primary} onChange={(v) => update({ secondary_hex: v, primary_hex: HEX.test(form.primary_hex) ? form.primary_hex : primary })} onClear={form.secondary_hex ? () => update({ secondary_hex: "" }) : undefined} testId="wed-secondary-hex" />
              <ColourRow label="Page" hint="Behind everything" value={form.element_styles["page.bg"]?.bg || ""} current={liveColour("page.bg", "bg")} onChange={(v) => setTok("page.bg", "bg", v)} onClear={form.element_styles["page.bg"]?.bg ? () => setTok("page.bg", "bg", "") : undefined} testId="wed-tok-page" />
              <ColourRow label="Cards" hint="Top bar, footer, tiles, rows" value={form.element_styles["page.surface"]?.bg || ""} current={liveColour("nav", "bg")} onChange={(v) => setTok("page.surface", "bg", v)} onClear={form.element_styles["page.surface"]?.bg ? () => setTok("page.surface", "bg", "") : undefined} testId="wed-tok-surface" />
              <ColourRow label="Text" hint="Headings and body" value={form.element_styles["page.text"]?.fg || ""} current={liveColour("services.title", "fg") || liveColour("page.bg", "fg")} onChange={(v) => setTok("page.text", "fg", v)} onClear={form.element_styles["page.text"]?.fg ? () => setTok("page.text", "fg", "") : undefined} testId="wed-tok-text" />
              <ColourRow label="Hero" hint="Behind the cover photo / big title" value={form.element_styles.hero?.bg || ""} current={liveColour("hero", "bg")} onChange={(v) => setTok("hero", "bg", v)} onClear={form.element_styles.hero?.bg ? () => setTok("hero", "bg", "") : undefined} testId="wed-tok-hero" />
            </div>
            <div className="wed-presets">
              <span className="wed-presets-label">Quick brand picks</span>
              <div className="wed-swatches" role="radiogroup" aria-label="Brand colour">
                {ACCENTS.map((a) => (
                  <button key={a.id} type="button" role="radio" aria-checked={form.accent === a.id && !form.primary_hex} title={a.name} aria-label={a.name} style={{ background: a.hex }} onClick={() => update({ accent: a.id, primary_hex: "", secondary_hex: "" })} data-testid={`wed-accent-${a.id}`}>{form.accent === a.id && !form.primary_hex && <Icon name="check" size={14} />}</button>
                ))}
                <label className="wed-custom" title="Custom colour">
                  <input type="color" value={HEX.test(form.primary_hex) ? form.primary_hex : primary} onChange={(e) => update({ primary_hex: e.target.value })} aria-label="Custom brand colour" data-testid="wed-primary" />
                  <span style={{ background: HEX.test(form.primary_hex) ? form.primary_hex : "transparent" }}>{form.primary_hex ? "" : <Icon name="plus" size={14} />}</span>
                </label>
              </div>
            </div>
            <p className="wed-label">Base</p>
            <div className="segmented" role="group" aria-label="Look">
              {[["light", "Light"], ["dark", "Dark"]].map(([v, l]) => <button key={v} type="button" aria-pressed={form.theme.mode === v} onClick={() => update((x) => ({ theme: { ...x.theme, mode: v } }))} data-testid={`wed-mode-${v}`}>{l}</button>)}
            </div>
            <p className="wed-hint">Light or dark sets the starting page, card and text colours. Anything you set in the palette above sits on top of it.</p>
            <p className="wed-label">Type</p>
            <div className="wed-fonts">
              {FONTS.map((f) => (
                <button key={f.id} type="button" className={`wed-font font-${f.id}`} aria-pressed={form.theme.font === f.id} onClick={() => update((x) => ({ theme: { ...x.theme, font: f.id } }))} data-testid={`wed-font-${f.id}`}>
                  <b>Aa</b><span><strong>{f.name}</strong><small>{f.note}</small></span>
                </button>
              ))}
            </div>
            <p className="wed-label">Corners</p>
            <div className="segmented" role="group" aria-label="Corners">
              {[["soft", "Soft"], ["sharp", "Sharp"]].map(([v, l]) => <button key={v} type="button" aria-pressed={form.theme.corners === v} onClick={() => update((x) => ({ theme: { ...x.theme, corners: v } }))}>{l}</button>)}
            </div>
            {form.logo_url && (
              <>
                <p className="wed-label">Logo on dark</p>
                <div className="segmented" role="group" aria-label="Logo on dark backgrounds">
                  {[["auto", "Auto"], ["original", "Keep colours"]].map(([v, l]) => <button key={v} type="button" aria-pressed={form.theme.logo === v} onClick={() => update((x) => ({ theme: { ...x.theme, logo: v } }))}>{l}</button>)}
                </div>
              </>
            )}
            {overrides.length > 0 && (
              <div className="wed-overrides" data-testid="wed-overrides">
                <p className="wed-label">Element overrides ({overrides.length})</p>
                <ul>
                  {overrides.map(([k, v]) => (
                    <li key={k}>
                      <button type="button" className="wed-ovr-name" onClick={() => { setSelected({ el: k, sec: k.split(".")[0] }); document.querySelector(`#sp-editor-scope [data-el="${k}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }}>{EL_LABEL[k] || k}</button>
                      <span className="wed-ovr-chips">{v.bg && <i style={{ background: v.bg }} title={`Background ${v.bg}`} />}{v.fg && <i style={{ background: v.fg }} title={`Text ${v.fg}`} />}</span>
                      <button type="button" className="wed-mini" aria-label={`Remove override on ${EL_LABEL[k] || k}`} onClick={() => update((f) => { const n = { ...f.element_styles }; delete n[k]; return { element_styles: n }; })}><Icon name="close" size={12} /></button>
                    </li>
                  ))}
                </ul>
                <Button variant="ghost" onClick={() => update(f => ({ element_styles: Object.fromEntries(Object.entries(f.element_styles).filter(([key]) => TOKENS.has(key))) }))} data-testid="wed-reset-elements"><Icon name="undo" size={14} /> Remove all overrides</Button>
              </div>
            )}
          </div>
        )}
        {panel === "content" && (
          <div className="wed-panel wed-content" data-testid="wed-content" id="wed-panel-content" role="tabpanel" aria-labelledby="wed-tab-content">
            <ImageField onBusyChange={uploadBusy} label="Logo" value={form.logo_url} kind="logo" onChange={(v) => update({ logo_url: v })} hint="PNG, JPEG or WebP · 5 MB max" testId="wed-logo" />
            <ImageField onBusyChange={uploadBusy} label="Cover photo" value={form.cover_url} kind="cover" onChange={(v) => update({ cover_url: v })} stock testId="wed-cover" />
            <label className="wed-field"><span>Strapline</span><input value={form.strapline} maxLength={120} placeholder="Sharp cuts, straight talk, no fuss." onChange={(e) => update({ strapline: e.target.value })} data-testid="wed-strapline" /></label>
            <label className="wed-field"><span>About</span><textarea rows={4} maxLength={1200} value={form.about} onChange={(e) => update({ about: e.target.value })} /></label>
            <div className="wed-grid2">
              <label className="wed-field"><span>Phone</span><input value={form.phone} maxLength={20} onChange={(e) => update({ phone: e.target.value })} data-testid="wed-phone" /></label>
              <label className="wed-field"><span>Email</span><input type="email" value={form.email} maxLength={254} onChange={(e) => update({ email: e.target.value })} /></label>
              <label className="wed-field"><span>Instagram</span><input value={form.instagram} maxLength={40} placeholder="@handle" onChange={(e) => update({ instagram: e.target.value })} /></label>
              <label className="wed-field"><span>Map link</span><input type="url" value={form.map_url} maxLength={500} placeholder="Optional" onChange={(e) => update({ map_url: e.target.value })} /></label>
            </div>
            <label className="wed-field"><span>Getting here</span><input value={form.transport_note} maxLength={300} placeholder="Parking, buses, trains" onChange={(e) => update({ transport_note: e.target.value })} /></label>
            <label className="wed-field"><span>House rules</span><textarea rows={3} maxLength={1200} value={form.policy_text} onChange={(e) => update({ policy_text: e.target.value })} /></label>
            <div className="wed-field">
              <span>Gallery <small>{form.gallery.filter(Boolean).length}/12</small></span>
              <div className="wed-gallery">
                {form.gallery.filter(Boolean).map((u, i) => (
                  <figure key={u + i}><img src={u} alt="" loading="lazy" /><button type="button" aria-label="Remove photo" onClick={() => update((f) => ({ gallery: f.gallery.filter((x) => x !== u) }))}><Icon name="close" size={12} /></button></figure>
                ))}
                {form.gallery.filter(Boolean).length < 12 && <PhotoUpload maxFiles={12 - form.gallery.filter(Boolean).length} onBusyChange={uploadBusy} kind="gallery" multiple label="Add photos" testId="wed-gallery-upload" onUploaded={(urls) => update((f) => ({ gallery: [...f.gallery.filter(Boolean), ...urls].slice(0, 12) }))} />}
              </div>
            </div>
            <label className="wed-field"><span>Google review link</span><input type="url" value={form.google_review_url} maxLength={500} placeholder="https://g.page/r/…/review" onChange={(e) => update({ google_review_url: e.target.value })} /></label>
            <label className="wed-switch"><input type="checkbox" checked={!!form.published} onChange={(e) => update({ published: e.target.checked ? 1 : 0 })} /><span><b>Page is public</b><small>Off hides the page; booking at /book still works.</small></span></label>
          </div>
        )}
      </aside>

      <main className="wed-canvas" aria-label="Preview" inert={blocked}>
        <p className="wed-preview-note">Design preview · availability and reviews are samples, not live data.</p>
        <div className={`wed-frame ${device}`} data-testid="wed-frame">
          <div className="wed-page" style={selected ? ({ "--wed-sel": `[data-el="${selected.el}"]` } as CSSProperties) : undefined}>
            <ShopPageView data={data} me={null} mine={null} preview onSelect={(el, s) => { setSelected({ el, sec: s }); }} selected={selected?.el} />
          </div>
        </div>
      </main>

      <aside ref={inspector} tabIndex={-1} className={`wed-right ${selected ? "open" : ""}`} aria-label="Inspector" data-testid="wed-inspector" inert={blocked || !selected}>
        {!selected ? (
          <div className="wed-empty">
            <Icon name="pointer" size={22} />
            <p><b>Click anything on the page</b> to change its colour or layout.</p>
          </div>
        ) : (
          <>
            <header className="wed-insp-head">
              <span>
                <small>{sec?.label || selected.sec}</small>
                <b>{EL_LABEL[selected.el] || selected.el}</b>
                {(() => {
                  const node = document.querySelector<HTMLElement>(`#sp-editor-scope [data-el="${selected.el}"]`);
                  const up = node?.parentElement?.closest<HTMLElement>("[data-el]")?.dataset.el;
                  return up && up !== selected.el ? (
                    <button type="button" className="wed-insp-up" onClick={() => setSelected({ el: up, sec: up === "page.bg" ? "page" : selected.sec })} data-testid="wed-select-parent">
                      <Icon name="up" size={11} /> {EL_LABEL[up] || up}
                    </button>
                  ) : null;
                })()}
              </span>
              <button type="button" className="wed-iconbtn" onClick={() => setSelected(null)} aria-label="Deselect"><Icon name="close" size={16} /></button>
            </header>
            <div className="wed-insp-body">
              <p className="wed-hint wed-insp-hint">{elStyle.bg || elStyle.fg ? "This element has its own colours. Clear them to follow the palette again." : "Following your palette. Set a colour here to override just this element."}</p>
              {(EL_HAS[selected.el] || ["bg", "fg"]).includes("bg") && <ColourRow label={selected.el === "page.bg" ? "Background" : selected.el === "page.surface" ? "Surface colour" : "Background"} value={elStyle.bg || ""} current={liveColour(selected.el, "bg")} onChange={(v) => setEl("bg", v)} onClear={elStyle.bg ? () => setEl("bg", "") : undefined} testId="wed-el-bg" />}
              {(EL_HAS[selected.el] || ["bg", "fg"]).includes("fg") && <ColourRow label="Text" value={elStyle.fg || ""} current={liveColour(selected.el, "fg")} onChange={(v) => setEl("fg", v)} onClear={elStyle.fg ? () => setEl("fg", "") : undefined} testId="wed-el-fg" />}
              {elStyle.bg && !elStyle.fg && (EL_HAS[selected.el] || ["bg", "fg"]).includes("fg") && (
                <button type="button" className="wed-suggest" onClick={() => setEl("fg", inkOn(elStyle.bg!))}><Icon name="sparkles" size={13} /> Use readable text ({inkOn(elStyle.bg) === "#ffffff" ? "white" : "dark"})</button>
              )}
              {(elStyle.bg || elStyle.fg) && <Button variant="ghost" onClick={clearEl} data-testid="wed-el-reset"><Icon name="undo" size={14} /> Back to theme colour</Button>}
              <div className="wed-quick">
                <p className="wed-label">Quick colours</p>
                <div className="wed-quickrow">
                  {[primary, HEX.test(form.secondary_hex) ? form.secondary_hex : null, "#14151a", "#ffffff", "#f5f6fb", "#e6f0eb"].filter(Boolean).map((c) => (
                    <button key={c as string} type="button" style={{ background: c as string }} aria-label={`Use ${c}`} onClick={() => setEl((EL_HAS[selected.el] || ["bg"])[0], c as string)} />
                  ))}
                </div>
              </div>
              {(() => {
                const focus = EL_TEXT[selected.el];
                const keys = [...(focus ? [focus] : []), ...(SEC_COPY[selected.sec] || []).filter((k) => k !== focus)];
                if (!keys.length) return null;
                return (
                  <div className="wed-copy" data-testid="wed-copy">
                    <p className="wed-label">Wording</p>
                    {keys.map((k) => {
                      const val = form.copy?.[k] ?? "";
                      const long = k.endsWith(".sub");
                      const set = (v: string) => update((f) => ({ copy: { ...(f.copy || {}), [k]: v } }));
                      return (
                        <label key={k} className={`wed-field ${k === focus ? "wed-focus" : ""}`}>
                          <span>{COPY_LABEL[k]}{val && <button type="button" className="wed-copy-reset" onClick={() => set("")} aria-label={`Reset ${COPY_LABEL[k]} to default`}>Reset</button>}</span>
                          {long
                            ? <textarea rows={2} maxLength={200} value={val} placeholder={PAGE_COPY_DEFAULTS[k]} onChange={(e) => set(e.target.value)} autoFocus={k === focus} data-testid={`wed-copy-${k}`} />
                            : <input value={val} maxLength={k.endsWith(".button") || k.startsWith("hero.") ? 30 : 60} placeholder={PAGE_COPY_DEFAULTS[k]} onChange={(e) => set(e.target.value)} autoFocus={k === focus} data-testid={`wed-copy-${k}`} />}
                        </label>
                      );
                    })}
                  </div>
                );
              })()}
              {sec?.layouts && (
                <div className="wed-layouts">
                  <p className="wed-label">{sec.label} layout</p>
                  <div className="wed-layoutgrid">
                    {sec.layouts.map(([v, l]) => {
                      const cur = (form.variants as Record<string, string | undefined>)[sec.key] || (sec.key === "hero" ? form.theme.hero : sec.layouts![0][0]);
                      return (
                        <button key={v} type="button" className={`wed-layout lay-${sec.key}-${v}`} aria-pressed={cur === v} onClick={() => update((f) => ({ variants: { ...f.variants, [sec.key]: v }, theme: sec.key === "hero" && ["editorial", "centred", "split"].includes(v) ? { ...f.theme, hero: v } : f.theme }))} data-testid={`wed-layout-${sec.key}-${v}`}>
                          <LayoutThumb section={sec.key} variant={v} />
                          <span>{l}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {selected.sec === "hero" && (
                <div className="wed-insp-content">
                  <ImageField onBusyChange={uploadBusy} label="Cover photo" value={form.cover_url} kind="cover" onChange={(v) => update({ cover_url: v })} stock compact />
                  <label className="wed-field"><span>Strapline</span><input value={form.strapline} maxLength={120} onChange={(e) => update({ strapline: e.target.value })} /></label>
                </div>
              )}
              {selected.sec === "nav" && <div className="wed-insp-content"><ImageField onBusyChange={uploadBusy} label="Logo" value={form.logo_url} kind="logo" onChange={(v) => update({ logo_url: v })} compact /></div>}
              {selected.sec === "gallery" && <p className="helper">Add or remove photos under <button type="button" className="linklike" onClick={() => { setPanel("content"); setSelected(null); }}>Content</button>.</p>}
              {selected.sec === "policies" && <div className="wed-insp-content"><label className="wed-field"><span>House rules</span><textarea rows={4} maxLength={1200} value={form.policy_text} onChange={(e) => update({ policy_text: e.target.value })} /></label></div>}
              {(selected.sec === "services" || selected.sec === "team") && <p className="helper">{selected.sec === "services" ? "Services and prices" : "Barbers and their photos"} are managed under {selected.sec === "services" ? "Services" : "Team"} — this page always shows the current ones.</p>}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function ColourRow({ label, hint, value, onChange, onClear, testId, current }: { label: string; hint?: string; value: string; onChange: (v: string) => void; onClear?: () => void; testId?: string; current?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  // With no override the swatch shows what the palette is currently painting, so the owner sees
  // the colour they are about to replace rather than a blank grey.
  const shown = HEX.test(value) ? value : HEX.test(current || "") ? current! : "#888888";
  return (
    <div className={`wed-colour ${HEX.test(value) ? "is-set" : "is-inherited"}`}>
      <span className="wed-colour-label">{label}{hint && <small>{hint}</small>}</span>
      <span className="wed-colour-ctl">
        <input type="color" value={shown} onChange={(e) => onChange(e.target.value)} aria-label={`${label} colour`} data-testid={testId} title={HEX.test(value) ? value : current ? `Palette: ${current}` : "Palette"} />
        <input type="text" value={text} maxLength={7} placeholder="Palette" onChange={(e) => { setText(e.target.value); if (HEX.test(e.target.value)) onChange(e.target.value.toLowerCase()); }} onBlur={() => { if (!HEX.test(text)) setText(value); }} aria-label={`${label} hex`} data-testid={testId ? `${testId}-text` : undefined} />
        {onClear && <button type="button" className="wed-mini" onClick={onClear} aria-label={`Clear ${label}`}><Icon name="close" size={12} /></button>}
      </span>
    </div>
  );
}
function ImageField({ label, value, kind, onChange, onBusyChange, hint, stock, compact, testId }: { onBusyChange: (busy: boolean) => void; label: string; value: string; kind: "logo" | "cover"; onChange: (v: string) => void; hint?: string; stock?: boolean; compact?: boolean; testId?: string }) {
  return (
    <div className={`wed-field wed-image ${compact ? "compact" : ""}`} data-testid={testId}>
      <span>{label}{hint && <small>{hint}</small>}</span>
      <div className={`wed-image-box ${kind}`}>
        {value ? <img src={value} alt="" /> : <span className="wed-image-empty"><Icon name="image" size={20} /></span>}
        <div className="wed-image-actions">
          <PhotoUpload onBusyChange={onBusyChange} kind={kind} label={value ? "Replace" : "Upload"} testId={testId ? `${testId}-upload` : undefined} onUploaded={([u]) => onChange(u)} />
          {value && <button type="button" className="wed-mini" onClick={() => onChange("")} aria-label={`Remove ${label}`}><Icon name="close" size={12} /></button>}
        </div>
      </div>
      {stock && (
        <div className="wed-stock" role="group" aria-label="Stock covers">
          {STOCK.map((id) => <button key={id} type="button" aria-pressed={value === `/static/stock/${id}.webp`} onClick={() => onChange(`/static/stock/${id}.webp`)} data-testid={`wed-stock-${id}`}><img src={`/static/stock/${id}-thumb.webp`} alt={id} loading="lazy" /></button>)}
        </div>
      )}
    </div>
  );
}
// Tiny schematic drawings of each layout so the choice reads visually, not as a word.
function LayoutThumb({ section, variant }: { section: string; variant: string }) {
  const k = `${section}:${variant}`;
  const R = (x: number, y: number, w: number, h: number, c = "b", r = 1.5) => <rect key={`${x}${y}${w}${h}`} x={x} y={y} width={w} height={h} rx={r} className={c} />;
  const items: React.ReactNode[] = [];
  switch (k) {
    case "hero:editorial": items.push(R(0, 0, 64, 40, "img"), R(4, 24, 30, 5, "a"), R(4, 31, 18, 3), R(4, 36, 10, 3, "a")); break;
    case "hero:centred": items.push(R(0, 0, 64, 40, "img"), R(20, 14, 24, 5, "a"), R(24, 21, 16, 3), R(27, 27, 10, 3, "a")); break;
    case "hero:split": items.push(R(0, 0, 32, 40, "s"), R(34, 0, 30, 40, "img"), R(4, 12, 22, 5, "a"), R(4, 19, 16, 3), R(4, 25, 10, 3, "a")); break;
    case "hero:cover": items.push(R(0, 0, 64, 40, "img"), R(4, 28, 36, 6, "a"), R(4, 36, 10, 3, "a")); break;
    case "hero:minimal": items.push(R(0, 0, 64, 40, "s"), R(4, 12, 26, 5, "a"), R(4, 19, 16, 3), R(4, 25, 10, 3, "a")); break;
    case "services:menu": [0, 1, 2].forEach((i) => items.push(R(2, 2 + i * 12, 60, 10), R(5, 5 + i * 12, 22, 3, "a"), R(50, 5 + i * 12, 9, 3, "a"))); break;
    case "services:cards": [0, 1, 2].forEach((i) => items.push(R(2 + i * 21, 2, 19, 36), R(5 + i * 21, 6, 8, 4, "a"), R(5 + i * 21, 13, 12, 3))); break;
    case "services:grid": [0, 1, 2, 3].forEach((i) => items.push(R(2 + (i % 4) * 15.5, 4, 14, 32), R(4 + (i % 4) * 15.5, 8, 10, 3, "a"))); break;
    case "services:tabs": items.push(R(2, 2, 14, 5, "a"), R(18, 2, 14, 5), R(34, 2, 14, 5), R(2, 10, 60, 28)); [0, 1, 2].forEach((i) => items.push(R(5, 13 + i * 8, 26, 3, "a"))); break;
    case "team:cards": [0, 1].forEach((i) => items.push(R(2 + i * 31, 2, 29, 36), R(5 + i * 31, 5, 10, 10, "a", 3), R(17 + i * 31, 6, 12, 3), R(5 + i * 31, 30, 23, 5, "a"))); break;
    case "team:list": [0, 1, 2].forEach((i) => items.push(R(2, 2 + i * 12, 60, 10), R(4, 4 + i * 12, 6, 6, "a", 3), R(13, 5 + i * 12, 18, 3), R(48, 4 + i * 12, 12, 6, "a"))); break;
    case "team:portraits": [0, 1, 2].forEach((i) => items.push(R(2 + i * 21, 2, 19, 24, "img"), R(2 + i * 21, 27, 19, 11), R(5 + i * 21, 30, 12, 3, "a"))); break;
    case "team:compact": [0, 1, 2, 3].forEach((i) => items.push(R(2 + i * 15.5, 4, 14, 32), R(6 + i * 15.5, 8, 6, 6, "a", 3), R(4 + i * 15.5, 18, 10, 2))); break;
    case "reviews:cards": [0, 1, 2].forEach((i) => items.push(R(2 + i * 21, 2, 19, 36), R(5 + i * 21, 6, 10, 2, "a"), R(5 + i * 21, 11, 12, 2), R(5 + i * 21, 15, 12, 2))); break;
    case "reviews:wall": items.push(R(2, 2, 19, 20), R(2, 24, 19, 14), R(23, 2, 19, 30), R(44, 2, 18, 14), R(44, 18, 18, 20)); break;
    case "reviews:carousel": items.push(R(2, 4, 34, 32), R(38, 4, 34, 32), R(5, 8, 10, 2, "a"), R(41, 8, 10, 2, "a")); break;
    case "reviews:quote": items.push(R(2, 2, 60, 22, "s"), R(6, 6, 30, 3, "a"), R(6, 11, 44, 2), R(6, 15, 36, 2), [0, 1, 2].map((i) => R(2 + i * 21, 27, 19, 11))); break;
    case "gallery:grid": [0, 1, 2, 3, 4, 5].forEach((i) => items.push(R(2 + (i % 3) * 21, 2 + Math.floor(i / 3) * 19, 19, 17, "img"))); break;
    case "gallery:masonry": items.push(R(2, 2, 19, 22, "img"), R(2, 26, 19, 12, "img"), R(23, 2, 19, 14, "img"), R(23, 18, 19, 20, "img"), R(44, 2, 18, 26, "img"), R(44, 30, 18, 8, "img")); break;
    case "gallery:strip": items.push(R(2, 4, 26, 32, "img"), R(30, 4, 26, 32, "img"), R(58, 4, 6, 32, "img")); break;
    case "hours:table": [0, 1, 2, 3].forEach((i) => items.push(R(4, 4 + i * 9, 20, 3), R(40, 4 + i * 9, 20, 3, i === 1 ? "a" : "b"))); break;
    case "hours:chips": items.push(R(2, 2, 60, 12, "a"), [0, 1, 2, 3].map((i) => R(2 + i * 15.5, 18, 14, 18))); break;
    case "find:card": items.push(R(2, 2, 60, 36), R(6, 8, 30, 3, "a"), R(6, 14, 24, 2), R(6, 19, 24, 2), R(6, 28, 18, 6, "a")); break;
    case "find:map": items.push(R(2, 2, 60, 22, "img"), R(6, 28, 30, 3, "a"), R(6, 33, 24, 2)); break;
    case "next:strip": [0, 1, 2].forEach((i) => items.push(R(2 + i * 21, 8, 19, 24), R(5 + i * 21, 12, 6, 6, "a", 3), R(13 + i * 21, 24, 6, 4, "a"))); break;
    case "next:card": items.push(R(2, 4, 60, 32), [0, 1, 2].map((i) => R(5, 8 + i * 9, 54, 6))); break;
    case "cta:band": items.push(R(2, 8, 60, 24, "a"), R(6, 14, 26, 4, "s"), R(46, 14, 12, 8, "s")); break;
    case "cta:card": items.push(R(2, 8, 60, 24), R(6, 14, 26, 4, "b2"), R(46, 14, 12, 8, "a")); break;
    case "policies:plain": [0, 1, 2].forEach((i) => items.push(R(4, 8 + i * 9, 3, 3, "a"), R(10, 8 + i * 9, 40, 3))); break;
    case "policies:panel": items.push(R(2, 2, 60, 36), [0, 1, 2].map((i) => R(8, 9 + i * 9, 3, 3, "a")), [0, 1, 2].map((i) => R(14, 9 + i * 9, 36, 3))); break;
    case "footer:simple": items.push(R(2, 14, 20, 6, "a"), R(30, 16, 10, 3), R(42, 16, 10, 3), R(54, 16, 8, 3)); break;
    case "footer:columns": items.push(R(2, 6, 20, 6, "a"), R(46, 6, 14, 3), R(46, 12, 14, 3), R(46, 18, 14, 3), R(2, 30, 60, 1, "b2")); break;
    default: items.push(R(2, 2, 60, 36));
  }
  return <svg viewBox="0 0 64 40" className="wed-thumb" aria-hidden="true">{items}</svg>;
}
