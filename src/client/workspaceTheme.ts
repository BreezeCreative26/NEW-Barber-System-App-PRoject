// Workspace look: a personal choice (per signed-in user, not per shop) for the admin side only.
// Customers never see it — the shop page has its own theme. Kept deliberately small: one accent
// from a curated palette and light / dark canvas. Applied as classes on <html> so every token in
// design.css swaps in one place; persisted in localStorage (instant on next load) and in
// app_memberships.prefs_json (follows the user across devices).
// Ids are stored in prefs and validated server-side, so they never change; names and colours may.
// `fill` is the primary-button colour and `fillInk` the text on it (mint needs ink, the rest white).
export const WS_ACCENTS = [
  { id: "forest", name: "Foliyo", accent: "#00805c", dark: "#006b4d", soft: "#e3fbf3", rail: "#0b0b0c", fill: "#00e8b0", fillHover: "#00d39f", fillInk: "#0b0b0c" },
  { id: "ink", name: "Ink", accent: "#18181b", dark: "#000000", soft: "#ececef", rail: "#0b0b0c", fill: "#18181b", fillHover: "#000000", fillInk: "#ffffff" },
  { id: "ocean", name: "Ocean", accent: "#1d5fd6", dark: "#174cad", soft: "#e6efff", rail: "#0a1530", fill: "#2b6ef2", fillHover: "#1d5fd6", fillInk: "#ffffff" },
  { id: "clay", name: "Ember", accent: "#c2410c", dark: "#9a330a", soft: "#fff0e8", rail: "#1c0f0a", fill: "#ea580c", fillHover: "#c2410c", fillInk: "#ffffff" },
  { id: "plum", name: "Violet", accent: "#6d3fe0", dark: "#5530b8", soft: "#f0ebff", rail: "#130c26", fill: "#7c5cff", fillHover: "#6d3fe0", fillInk: "#ffffff" },
  { id: "slate", name: "Slate", accent: "#3f4b5e", dark: "#2c3646", soft: "#ebeef3", rail: "#0f141c", fill: "#3f4b5e", fillHover: "#2c3646", fillInk: "#ffffff" },
] as const;
export type WsAccent = (typeof WS_ACCENTS)[number]["id"];
export type WsMode = "light" | "dark";

// Side bar finish. "classic" is the original flat black. The others follow a "lit black" look:
// near-black base, a soft light glow falling from the top corner and a faint diagonal beam, like a
// studio light across dark glass. Tinted versions colour only the light, never the base, so white
// labels stay crisp. One string per finish, used by both the side bar and the picker swatch.
const lit = (glow: string, beam: string) =>
  `radial-gradient(130% 55% at 100% 0%, ${glow} 0%, rgba(0,0,0,0) 62%), ` +
  `linear-gradient(118deg, rgba(0,0,0,0) 34%, ${beam} 46%, rgba(0,0,0,0) 60%), ` +
  `radial-gradient(90% 40% at 0% 100%, rgba(255,255,255,.035) 0%, rgba(0,0,0,0) 70%), #050506`;
// `glow` is the light colour (r,g,b) — the main buttons pick it up as a faint halo so they match.
export const WS_RAILS = [
  { id: "classic", name: "Black", bg: "#0b0b0c", glow: "" },
  { id: "beam", name: "Spotlight", bg: lit("rgba(255,255,255,.16)", "rgba(255,255,255,.055)"), glow: "255,255,255" },
  { id: "beam-mint", name: "Mint glow", bg: lit("rgba(0,232,176,.22)", "rgba(0,232,176,.06)"), glow: "0,232,176" },
  { id: "beam-violet", name: "Violet glow", bg: lit("rgba(139,92,246,.28)", "rgba(139,92,246,.07)"), glow: "139,92,246" },
  { id: "beam-blue", name: "Blue glow", bg: lit("rgba(59,130,246,.26)", "rgba(59,130,246,.07)"), glow: "59,130,246" },
  { id: "beam-ember", name: "Ember glow", bg: lit("rgba(249,115,22,.22)", "rgba(249,115,22,.06)"), glow: "249,115,22" },
] as const;
export type WsRail = (typeof WS_RAILS)[number]["id"];

export type WorkspaceTheme = { accent: WsAccent; mode: WsMode; rail?: WsRail };
export const DEFAULT_WS_THEME: WorkspaceTheme = { accent: "forest", mode: "light", rail: "classic" };

const LS_KEY = "foliyo:ws-theme";
const isAccent = (v: unknown): v is WsAccent => WS_ACCENTS.some((a) => a.id === v);
const isMode = (v: unknown): v is WsMode => v === "light" || v === "dark";
const isRail = (v: unknown): v is WsRail => WS_RAILS.some((r) => r.id === v);

export function parseWsTheme(v: unknown): WorkspaceTheme | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return { accent: isAccent(o.accent) ? o.accent : DEFAULT_WS_THEME.accent, mode: isMode(o.mode) ? o.mode : DEFAULT_WS_THEME.mode, rail: isRail(o.rail) ? o.rail : "classic" };
}
export function readLocalWsTheme(): WorkspaceTheme | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(LS_KEY) : null;
    return raw ? parseWsTheme(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
export function writeLocalWsTheme(t: WorkspaceTheme) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(t));
  } catch {
    /* private mode */
  }
}
// Sets classes + inline tokens on <html>. Idempotent; safe to call on every render of the shell.
export function applyWsTheme(t: WorkspaceTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const a = WS_ACCENTS.find((x) => x.id === t.accent) ?? WS_ACCENTS[0];
  for (const x of WS_ACCENTS) root.classList.remove(`ws-accent-${x.id}`);
  root.classList.add(`ws-accent-${a.id}`);
  // Dark canvas is parked until every admin surface reads tokens (many still hard-code white).
  root.classList.remove("ws-dark");
  root.style.setProperty("--ws-accent", a.accent);
  root.style.setProperty("--ws-accent-dark", a.dark);
  root.style.setProperty("--ws-soft", a.soft);
  root.style.setProperty("--ws-rail", a.rail);
  root.style.setProperty("--ws-fill", a.fill);
  root.style.setProperty("--ws-fill-hover", a.fillHover);
  root.style.setProperty("--ws-fill-ink", a.fillInk);
  const r = WS_RAILS.find((x) => x.id === t.rail) ?? WS_RAILS[0];
  if (r.id === "classic") {
    root.classList.remove("ws-rail-lit", "ws-rail-metal");
    root.style.removeProperty("--ws-rail-bg");
    root.style.removeProperty("--ws-glow");
  } else {
    root.classList.add("ws-rail-lit");
    root.style.setProperty("--ws-rail-bg", r.bg);
    root.style.setProperty("--ws-glow", r.glow);
  }
  root.dataset.wsRail = r.id;
}
export function clearWsTheme() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const x of WS_ACCENTS) root.classList.remove(`ws-accent-${x.id}`);
  root.classList.remove("ws-dark", "ws-rail-lit", "ws-rail-metal");
  delete root.dataset.wsRail;
  for (const k of ["--ws-rail-bg", "--ws-glow", "--ws-accent", "--ws-accent-dark", "--ws-soft", "--ws-rail", "--ws-fill", "--ws-fill-hover", "--ws-fill-ink"]) root.style.removeProperty(k);
  root.style.colorScheme = "";
}
