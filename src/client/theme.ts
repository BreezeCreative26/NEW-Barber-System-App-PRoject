// Shop brand → class stack. Every customer-facing surface (shop page, booking, manage a visit,
// customer account, waiting-list offer) wraps itself in `.shop-page <themeClass>` so it renders in
// the owner's chosen style; shop-theme.css does the rest through --sp-* tokens.
export type ShopTheme = { font: string; mode: string; corners: string; hero: string; logo?: string };
export type ShopBrand = { logo_url: string; accent: string; theme: ShopTheme };

export const DEFAULT_THEME: ShopTheme = { font: "modern", mode: "light", corners: "soft", hero: "editorial", logo: "auto" };
export const DEFAULT_BRAND: ShopBrand = { logo_url: "", accent: "ollo", theme: DEFAULT_THEME };

export function themeClass(brand: Partial<ShopBrand> | null | undefined, extra = ""): string {
  const t = { ...DEFAULT_THEME, ...(brand?.theme || {}) };
  const flip = t.logo !== "original" ? " logo-flip" : "";
  return `shop-page accent-${brand?.accent || "ollo"} font-${t.font} mode-${t.mode} corners-${t.corners} hero-${t.hero}${flip}${extra ? ` ${extra}` : ""}`.trim();
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
