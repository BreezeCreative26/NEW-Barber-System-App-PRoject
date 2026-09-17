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

// Browser chrome (address bar tint on phones) follows the theme too.
export function applyThemeColor(brand: Partial<ShopBrand> | null | undefined) {
  if (typeof document === "undefined") return;
  const dark = (brand?.theme?.mode || "light") === "dark";
  let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = dark ? "#0f1014" : "#ffffff";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.body.classList.toggle("theme-dark", dark);
}
