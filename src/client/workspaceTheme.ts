// Workspace look: a personal choice (per signed-in user, not per shop) for the admin side only.
// Customers never see it — the shop page has its own theme. Kept deliberately small: one accent
// from a curated palette and light / dark canvas. Applied as classes on <html> so every token in
// design.css swaps in one place; persisted in localStorage (instant on next load) and in
// app_memberships.prefs_json (follows the user across devices).
export const WS_ACCENTS = [
  { id: "forest", name: "Foliyo mint", accent: "#00785f", dark: "#005743", soft: "#e4fff6", rail: "#0b0b0c" },
  { id: "ink", name: "Ink", accent: "#1d1f26", dark: "#000000", soft: "#e9e9ee", rail: "#0f1014" },
  { id: "ocean", name: "Ocean", accent: "#1254d9", dark: "#103f9f", soft: "#eaf1ff", rail: "#0b0b0c" },
  { id: "clay", name: "Clay", accent: "#b84308", dark: "#853000", soft: "#fff1e8", rail: "#0b0b0c" },
  { id: "plum", name: "Plum", accent: "#7132c4", dark: "#50218f", soft: "#f3ecff", rail: "#0b0b0c" },
  { id: "slate", name: "Slate", accent: "#4a5568", dark: "#364152", soft: "#e8ebf0", rail: "#12161d" },
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
}
export function clearWsTheme() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const x of WS_ACCENTS) root.classList.remove(`ws-accent-${x.id}`);
  root.classList.remove("ws-dark");
  for (const k of ["--ws-accent", "--ws-accent-dark", "--ws-soft", "--ws-rail"]) root.style.removeProperty(k);
  root.style.colorScheme = "";
}
