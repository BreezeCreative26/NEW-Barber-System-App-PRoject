// Onboarding steps added with the full-screen flow: Brand (logo, cover, colour — with the real shop
// page as the preview) and Booking rules & terms (notice, window, cancellation, house terms).
import { useEffect, useState } from "react";
import type { WorkspaceData } from "../server/domain";
import { Button, Icon } from "./ui";
import { PhotoUpload, PhotoPreview } from "./Media";
import { ShopPageView, type PageData } from "./ShopPage";
import { shopWeekOf } from "./fixtures";
import { useBusy, useSetupDirty, useSetupUpload } from "./Setup";
import { pageFormOf } from "./WebsiteEditor";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Common = { w: WorkspaceData; api: Api; refresh: () => Promise<void>; setNotice: (s: string) => void; setError: (s: string) => void; onNext: () => Promise<void>; onSkip?: () => Promise<void> };

const HEX = /^#[0-9a-fA-F]{6}$/;
const ACCENTS: { id: string; name: string; hex: string }[] = [
  { id: "ollo", name: "Green", hex: "#3a7563" }, { id: "ink", name: "Ink", hex: "#1d1f26" }, { id: "sage", name: "Sage", hex: "#3f7d5c" },
  { id: "clay", name: "Clay", hex: "#a8552f" }, { id: "plum", name: "Plum", hex: "#6e3b7a" }, { id: "slate", name: "Slate", hex: "#4a5568" },
];
const STOCK = ["brick", "minimal", "heritage", "industrial", "terracotta", "tools"];

export function Actions({ onNext, onSkip, nextLabel = "Save and continue", busy, skipLabel = "Skip for now" }: { onNext: () => void; onSkip?: () => void; nextLabel?: string; busy?: boolean; skipLabel?: string }) {
  return (
    <div className="setup-wiz-actions">
      {onSkip && <Button variant="ghost" onClick={onSkip} disabled={busy} data-testid="setup-skip">{skipLabel}</Button>}
      <Button onClick={onNext} disabled={busy} data-testid="setup-next">{busy ? "Saving…" : nextLabel}</Button>
    </div>
  );
}

// ---- Brand ------------------------------------------------------------------------------------
type PageRec = Record<string, unknown>;
export function StepBrand({ w, api, refresh, setNotice, setError, onNext, onSkip }: Common) {
  const [page, setPage] = useState<PageRec | null>(null);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const { uploading, onBusyChange } = useSetupUpload();
  const [logo, setLogo] = useState("");
  const [cover, setCover] = useState("");
  const [accent, setAccent] = useState("ollo");
  const [primary, setPrimary] = useState("");
  const [mode, setMode] = useState("light");
  const [strap, setStrap] = useState("");
  const { busy, run } = useBusy();
  useSetupDirty(!!page && (logo !== String(page.logo_url || "") || cover !== String(page.cover_url || "") || accent !== String(page.accent || "ollo") || primary !== String(page.primary_hex || "") || strap !== String(page.strapline || "") || mode !== pageFormOf(page).theme.mode));
  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    api<{ page: PageRec }>("/shop/page").then((r) => {
      if (cancelled) return;
      setPage(r.page);
      setLogo(String(r.page.logo_url || "")); setCover(String(r.page.cover_url || "")); setAccent(String(r.page.accent || "ollo")); setPrimary(String(r.page.primary_hex || "")); setStrap(String(r.page.strapline || ""));
      try { setMode((JSON.parse(String(r.page.theme_json || "{}")) as { mode?: string }).mode || "light"); } catch { /* default */ }
    }).catch(e => { if (!cancelled) setLoadError(e.message || "Could not load your branding."); });
    return () => { cancelled = true; };
  }, [retry]);
  async function save() {
    const cur = (await api<{ page: PageRec }>("/shop/page")).page;
    if (uploading) throw new Error("Wait for your image upload to finish.");
    if (Number(cur.version ?? 0) !== Number(page?.version ?? 0)) throw new Error("Your website changed elsewhere. Reopen Brand to load the latest version before saving.");
    if (cur.draft_json) throw new Error("You have an unpublished website draft. Publish or discard it in the Website editor before changing your brand here.");
    const current = pageFormOf(cur);
    const saved = await api<{ page: PageRec }>("/shop/page", "PUT", {
      ...current, strapline: strap.trim(), cover_url: cover, logo_url: logo,
      accent, theme: { ...current.theme, mode }, primary_hex: HEX.test(primary) ? primary.toLowerCase() : "",
      secondary_hex: primary ? current.secondary_hex : "",
    });
    setPage(saved.page);
    await refresh();
  }
  const week = shopWeekOf(w.shop);
  const today = w.today;
  const day = week[new Date(`${today}T12:00:00Z`).getUTCDay()];
  const staff = (w.staff as { id: string; name: string; role: string; active?: number; colour?: string; photo_url?: string; title?: string }[]).filter((x) => x.active !== 0);
  const services = (w.services as { id: string; name: string; category?: string; duration_min: number; price_pence: number; active?: number; popular?: number }[]).filter((x) => x.active !== 0);
  const preview: PageData = {
    shop: { id: w.shop.id, name: w.shop.name, address: w.shop.address, slug: w.shop.slug || "preview", timezone: w.shop.timezone, currency: w.shop.currency, opens: day.starts, closes: day.ends, deposit_pence: w.shop.deposit_pence, cancel_hours: w.shop.cancel_hours, lead_time_min: w.shop.lead_time_min ?? 60, booking_window_days: w.shop.booking_window_days ?? 30 },
    page: { strapline: strap, about: "", cover_url: cover, logo_url: logo, gallery: [], phone: "", email: "", instagram: "", map_url: "", transport_note: "", policy_text: "", sections: ["hero", "services", "team", "hours"], accent, theme: { font: "modern", mode, corners: "soft", hero: "editorial", logo: "auto" }, primary_hex: HEX.test(primary) ? primary : "", secondary_hex: "", variants: {}, published: 1 },
    staff, services: services.map((x) => ({ ...x, category: x.category || "Services" })),
    week: week.map((d, i) => (d.enabled ? { weekday: i, open: true as const, starts: d.starts, ends: d.ends } : { weekday: i, open: false as const })),
    open_now: false, today, closures: [], soonest: [], reviews: [], rating: { count: 0, average: null },
  };
  if (loadError) return <div className="setup-wiz-card"><p role="alert" className="workspace-error">{loadError}</p><Button onClick={() => setRetry(n => n + 1)}>Retry loading brand</Button></div>;
  if (!page) return <div className="setup-wiz-card"><p role="status">Loading…</p></div>;
  return (
    <div className="setup-wiz-card setup-brand" data-testid="setup-brand">
      <p className="setup-wiz-lead">Your logo, a photo and a colour — that's a shop page customers recognise. Everything else in the website builder (fonts, layouts, gallery) can wait until later.</p>
      <div className="setup-brand-grid">
        <div className="setup-brand-form">
          <div className="workspace-field">
            <span>Logo</span>
            <div className="photo-field">
              <PhotoPreview url={logo} label="logo" onClear={() => setLogo("")} />
              <input type="text" inputMode="url" value={logo} maxLength={500} placeholder="https://…/logo.png" onChange={(e) => setLogo(e.target.value)} aria-label="Logo URL" />
              <PhotoUpload onBusyChange={onBusyChange} disabled={busy || uploading} kind="logo" label="Upload logo" testId="setup-upload-logo" onUploaded={([u]) => setLogo(u)} />
            </div>
            <small className="helper">PNG, JPEG or WebP, up to 5 MB. A transparent PNG works best for logos. We work out whether it's light or dark and place it so it always reads.</small>
          </div>
          <div className="workspace-field">
            <span>Cover photo</span>
            <div className="photo-field">
              <PhotoPreview url={cover} label="cover photo" onClear={() => setCover("")} />
              <input type="text" inputMode="url" value={cover} maxLength={500} placeholder="https://…/shopfront.jpg" onChange={(e) => setCover(e.target.value)} aria-label="Cover photo URL" />
              <PhotoUpload onBusyChange={onBusyChange} disabled={busy || uploading} kind="cover" label="Upload photo" testId="setup-upload-cover" onUploaded={([u]) => setCover(u)} />
            </div>
            <div className="stock-covers" role="group" aria-label="Choose a stock cover">
              {STOCK.map((id) => (
                <button key={id} type="button" className={`stock-cover ${cover === `/static/stock/${id}.webp` ? "selected" : ""}`} aria-pressed={cover === `/static/stock/${id}.webp`} onClick={() => setCover(`/static/stock/${id}.webp`)} data-testid={`setup-stock-${id}`}>
                  <img src={`/static/stock/${id}-thumb.webp`} alt={id} loading="lazy" />
                </button>
              ))}
            </div>
          </div>
          <label className="workspace-field">
            <span>Strapline</span>
            <input value={strap} maxLength={120} placeholder="Sharp cuts, straight talk, no fuss." onChange={(e) => setStrap(e.target.value)} data-testid="setup-strapline" />
          </label>
          <div className="workspace-field">
            <span>Colour</span>
            <div className="setup-accents" role="radiogroup" aria-label="Brand colour">
              {ACCENTS.map((a) => (
                <button key={a.id} type="button" role="radio" aria-checked={accent === a.id && !primary} aria-label={a.name} title={a.name} style={{ background: a.hex }} onClick={() => { setAccent(a.id); setPrimary(""); }} data-testid={`setup-accent-${a.id}`}>
                  {accent === a.id && !primary && <Icon name="check" size={14} />}
                </button>
              ))}
              <label className="setup-accent-custom" title="Your own colour">
                <input type="color" value={HEX.test(primary) ? primary : "#3a7563"} onChange={(e) => setPrimary(e.target.value)} aria-label="Custom brand colour" data-testid="setup-primary" />
                <span>{primary ? primary : "Custom"}</span>
              </label>
            </div>
          </div>
          <div className="workspace-field">
            <span>Look</span>
            <div className="segmented" role="group" aria-label="Look">
              {[["light", "Light"], ["dark", "Dark"]].map(([v, l]) => <button key={v} type="button" aria-pressed={mode === v} onClick={() => setMode(v)} data-testid={`setup-mode-${v}`}>{l}</button>)}
            </div>
          </div>
        </div>
        <div className="setup-brand-preview" inert data-testid="setup-brand-preview">
          <div className="shop-preview-frame phone">
            <div className="shop-preview-page" onClickCapture={(e) => e.preventDefault()}>
              <ShopPageView data={preview} me={null} mine={null} preview />
            </div>
          </div>
          <small className="helper">Brand preview on a phone. Availability is illustrative, not live.</small>
        </div>
      </div>
      <Actions busy={busy || uploading} onNext={() => run(async () => { await save(); setNotice("Brand saved."); await onNext(); }, setError)} onSkip={onSkip} />
    </div>
  );
}

// ---- Booking rules & terms ------------------------------------------------------------------------
const STARTER_TERMS = (name: string, cancel: number) =>
  `Please arrive on time — if you're more than 10 minutes late we may need to shorten or rebook your appointment.\nCancel or move your booking at least ${cancel} hours ahead; later than that and any deposit is kept.\nChildren under 12 must be accompanied by an adult.\n${name} reserves the right to refuse service.`;
export function StepTerms({ w, api, refresh, setNotice, setError, onNext, onSkip }: Common) {
  const shop = w.shop as typeof w.shop & { terms_text?: string; no_show_grace?: number; payment_mode?: string };
  const [lead, setLead] = useState(shop.lead_time_min ?? 60);
  const [window_, setWindow] = useState(shop.booking_window_days ?? 42);
  const [cancel, setCancel] = useState(shop.cancel_hours ?? 24);
  const [terms, setTerms] = useState(shop.terms_text || "");
  useSetupDirty(lead !== (shop.lead_time_min ?? 60) || window_ !== (shop.booking_window_days ?? 42) || cancel !== (shop.cancel_hours ?? 24) || terms !== (shop.terms_text || ""));
  const { busy, run } = useBusy();
  async function save() {
    await api("/setup/policy", "PUT", { deposit_pence: shop.deposit_pence, cancel_hours: cancel, no_show_grace: shop.no_show_grace ?? 10, payment_mode: shop.payment_mode || "PAY_AT_VISIT", lead_time_min: lead, booking_window_days: window_, terms_text: terms.trim(), version: shop.version });
    await refresh();
  }
  return (
    <div className="setup-wiz-card" data-testid="setup-terms">
      <p className="setup-wiz-lead">The rules customers agree to when they book. Keep them short and human — they're shown at sign-up and again whenever you change them.</p>
      <div className="setup-grid-3">
        <label className="workspace-field"><span>Shortest notice</span>
          <select value={lead} onChange={(e) => setLead(Number(e.target.value))} data-testid="setup-lead"><option value={0}>Right up to the slot</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={120}>2 hours</option><option value={1440}>A day</option></select>
          <small className="helper">How close to the time someone can book online.</small>
        </label>
        <label className="workspace-field"><span>How far ahead</span>
          <select value={window_} onChange={(e) => setWindow(Number(e.target.value))} data-testid="setup-window"><option value={14}>2 weeks</option><option value={28}>4 weeks</option><option value={42}>6 weeks</option><option value={90}>3 months</option></select>
          <small className="helper">How far into the future the calendar opens.</small>
        </label>
        <label className="workspace-field"><span>Free cancellation until</span>
          <select value={cancel} onChange={(e) => setCancel(Number(e.target.value))} data-testid="setup-cancel"><option value={0}>Any time</option><option value={2}>2 hours before</option><option value={12}>12 hours before</option><option value={24}>24 hours before</option><option value={48}>48 hours before</option></select>
          <small className="helper">After this, any deposit is kept.</small>
        </label>
      </div>
      <label className="workspace-field">
        <span>Your booking terms <small className="helper" style={{ display: "inline" }}>(optional)</small></span>
        <textarea rows={6} maxLength={6000} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Lateness, cancellations, children, anything customers should know before they book." data-testid="setup-terms-text" />
        {!terms && <Button variant="ghost" onClick={() => setTerms(STARTER_TERMS(w.shop.name, cancel))} data-testid="setup-terms-starter"><Icon name="sparkles" size={14} /> Start from a template</Button>}
        <small className="helper">Customers accept these when they create an account and again the next time they book after you change the wording.</small>
      </label>
      <Actions busy={busy} onNext={() => run(async () => { await save(); setNotice("Booking rules saved."); await onNext(); }, setError)} onSkip={onSkip} />
    </div>
  );
}
