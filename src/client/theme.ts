// Shop brand → class stack. Every customer-facing surface (shop page, booking, manage a visit,
// customer account, waiting-list offer) wraps itself in `.shop-page <themeClass>` so it renders in
// the owner's chosen style; shop-theme.css does the rest through --sp-* tokens.
export type ShopTheme = { font: string; mode: string; corners: string; hero: string; logo?: string };
export type ShopBrand = { logo_url: string; accent: string; theme: ShopTheme; logo_tone?: "light" | "dark" | "colour" | ""; primary_hex?: string; secondary_hex?: string };

export const DEFAULT_THEME: ShopTheme = { font: "modern", mode: "light", corners: "soft", hero: "editorial", logo: "auto" };
export const DEFAULT_BRAND: ShopBrand = { logo_url: "", accent: "ollo", theme: DEFAULT_THEME };

export function themeClass(brand: Partial<ShopBrand> | null | undefined, extra = ""): string {
  const t = { ...DEFAULT_THEME, ...(brand?.theme || {}) };
  // Measured logo tone (set at upload) decides how the mark is placed: a light logo is never
  // inverted and gets a dark plate on light surfaces; a dark logo inverts to white on dark surfaces;
  // a colour logo is left alone. Without a measurement the theme's manual switch applies.
  const tone = brand?.logo_tone || "";
  const flip = tone ? (tone === "dark" ? " logo-flip" : "") : t.logo !== "original" ? " logo-flip" : "";
  const toneClass = tone ? ` logo-${tone}` : "";
  const custom = HEX.test(brand?.primary_hex || "") ? " custom-accent" : "";
  return `shop-page accent-${brand?.accent || "ollo"} font-${t.font} mode-${t.mode} corners-${t.corners} hero-${t.hero}${flip}${toneClass}${custom}${extra ? ` ${extra}` : ""}`.trim();
}

// Custom brand colours (website builder). Emitted as inline CSS variables on the themed root so
// every --sp-* consumer follows them; the named accent stays as the fallback class.
const HEX = /^#[0-9a-fA-F]{6}$/;
function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function luminance(hex: string): number {
  const [r, g, b] = hexRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function inkOn(hex: string): string {
  return luminance(hex) > 0.45 ? "#14151a" : "#ffffff";
}
function shade(hex: string, amount: number): string {
  // amount < 0 darkens, > 0 lightens (mix towards black / white)
  const [r, g, b] = hexRgb(hex);
  const mix = (v: number) => Math.round(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount);
  return `#${[mix(r), mix(g), mix(b)].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}
export function brandStyle(brand: Partial<ShopBrand> | null | undefined): Record<string, string> | undefined {
  const p = brand?.primary_hex || "";
  if (!HEX.test(p)) return undefined;
  const dark = (brand?.theme?.mode || "light") === "dark";
  // On dark surfaces very dark primaries vanish; lift them so buttons and links still read.
  const primary = dark && luminance(p) < 0.08 ? shade(p, 0.55) : p;
  const [r, g, b] = hexRgb(primary);
  const s = brand?.secondary_hex || "";
  const vars: Record<string, string> = {
    "--sp-accent": primary,
    "--sp-accent-dark": dark ? shade(primary, 0.18) : shade(primary, -0.18),
    "--sp-accent-ink": inkOn(primary),
    "--sp-soft": `rgba(${r}, ${g}, ${b}, ${dark ? 0.16 : 0.12})`,
  };
  if (HEX.test(s)) {
    const [sr, sg, sb] = hexRgb(s);
    vars["--sp-accent-2"] = s;
    vars["--sp-accent-2-ink"] = inkOn(s);
    vars["--sp-soft-2"] = `rgba(${sr}, ${sg}, ${sb}, ${dark ? 0.18 : 0.14})`;
  }
  return vars;
}

// Browser chrome follows the theme too: the status bar / Dynamic Island area, the address bar tint
// and the overscroll canvas all take the shop's surface colour so the top bar looks like it runs
// edge to edge on a phone. The two values mirror --sp-surface in shop-theme.css.
export const SHOP_SURFACE = { light: "#ffffff", dark: "#17181e" } as const;
export function applyThemeColor(brand: Partial<ShopBrand> | null | undefined) {
  if (typeof document === "undefined") return;
  const dark = (brand?.theme?.mode || "light") === "dark";
  const surface = dark ? SHOP_SURFACE.dark : SHOP_SURFACE.light;
  let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = surface;
  const root = document.documentElement;
  root.style.colorScheme = dark ? "dark" : "light";
  root.style.setProperty("--shell-bg", surface);
  root.style.backgroundColor = surface;
  document.body.style.backgroundColor = surface;
  document.body.classList.toggle("theme-dark", dark);
}

// Shop URLs from the browser. On the shop's own host (<slug>.foliyo.co.uk) the short paths are
// used; on the platform host (local dev, legacy links) the path form. Detection: the current host
// has more labels than the root and its first label is the slug.
export function onShopHost(slug: string): boolean {
  // The server tags shells served on a shop's host; that is the source of truth (works for
  // northline.foliyo.co.uk and northline.localhost alike).
  const tagged = typeof document !== "undefined" ? document.querySelector<HTMLMetaElement>('meta[name="foliyo-shop"]')?.content : "";
  return !!tagged && tagged.toLowerCase() === slug.toLowerCase();
}
export function shopPath(slug: string, path: "" | "/" | "/book" | "/me", suffix = ""): string {
  if (onShopHost(slug)) return `${path === "" ? "/" : path}${suffix}`;
  if (path === "" || path === "/") return `/${slug}${suffix}`;
  if (path === "/book") return `/book/${slug}${suffix}`;
  return `/${slug}${path}${suffix}`;
}

// The brand the server embedded in the shell (see brandScript in src/index.tsx). Read once; lets
// every customer screen render themed on its very first frame instead of after a fetch.
export type ServerBrand = { name: string; slug: string; brand: ShopBrand; channels?: { sms: boolean; email: boolean }; terms?: { text: string; version: number } | null };
let embedded: ServerBrand | null | undefined;
export function serverBrand(): ServerBrand | null {
  if (embedded !== undefined) return embedded;
  try {
    const el = typeof document !== "undefined" ? document.getElementById("foliyo-brand") : null;
    embedded = el?.textContent ? (JSON.parse(el.textContent) as ServerBrand) : null;
  } catch {
    embedded = null;
  }
  return embedded;
}
