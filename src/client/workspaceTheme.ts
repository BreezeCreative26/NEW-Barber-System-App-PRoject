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
export type WorkspaceTheme = { accent: WsAccent; mode: WsMode };
export const DEFAULT_WS_THEME: WorkspaceTheme = { accent: "forest", mode: "light" };

const LS_KEY = "foliyo:ws-theme";
const isAccent = (v: unknown): v is WsAccent => WS_ACCENTS.some((a) => a.id === v);
const isMode = (v: unknown): v is WsMode => v === "light" || v === "dark";

export function parseWsTheme(v: unknown): WorkspaceTheme | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return { accent: isAccent(o.accent) ? o.accent : DEFAULT_WS_THEME.accent, mode: isMode(o.mode) ? o.mode : DEFAULT_WS_THEME.mode };
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
}
export function clearWsTheme() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const x of WS_ACCENTS) root.classList.remove(`ws-accent-${x.id}`);
  root.classList.remove("ws-dark");
  for (const k of ["--ws-accent", "--ws-accent-dark", "--ws-soft", "--ws-rail", "--ws-fill", "--ws-fill-hover", "--ws-fill-ink"]) root.style.removeProperty(k);
  root.style.colorScheme = "";
}
