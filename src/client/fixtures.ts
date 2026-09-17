// Shared formatting helpers (money, time, dates). No fixture data lives here any more.
// Display currency for the shop on this page. Every page shows exactly one shop, so the loader sets it
// once from the shop payload and every money() call picks it up. Prices are always stored in minor units.
let currentCurrency = "GBP";
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF"]);
export const setCurrency = (code: string | undefined | null) => {
  if (code && /^[A-Z]{3}$/.test(code)) currentCurrency = code;
};
export const currency = () => currentCurrency;
export const currencySymbol = (code = currentCurrency) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
    .formatToParts(0)
    .find((p) => p.type === "currency")?.value ?? code;
export const money = (pence: number, code = currentCurrency) => {
  const zero = ZERO_DECIMAL.has(code);
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: code,
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: zero ? 0 : pence % 100 ? 2 : 0,
  }).format(zero ? pence : pence / 100);
};
export const time = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export const datePlus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const dateLabel = (
  date: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: "long",
    day: "numeric",
    month: "long",
  },
) =>
  new Intl.DateTimeFormat("en-GB", {
    ...options,
    timeZone: "Europe/London",
  }).format(new Date(`${date}T12:00:00Z`));

// Per-weekday shop hours for the client (mirrors server shopWeek; legacy fallback to opens/closes).
export type ShopDayLite = { enabled: 0 | 1; starts: number; ends: number };
export function shopWeekOf(shop: { opens: number; closes: number; closed_days: string; week_json?: string }): ShopDayLite[] {
  try {
    const parsed = shop.week_json ? (JSON.parse(shop.week_json) as ShopDayLite[]) : null;
    if (parsed && parsed.length === 7) return parsed;
  } catch {
    /* legacy */
  }
  const closed = new Set<number>(JSON.parse(shop.closed_days || "[]"));
  return Array.from({ length: 7 }, (_, i) => ({ enabled: closed.has(i) ? 0 : 1, starts: shop.opens, ends: shop.closes }));
}
export const shopDayOf = (shop: Parameters<typeof shopWeekOf>[0], date: string): ShopDayLite =>
  shopWeekOf(shop)[new Date(date + "T12:00:00Z").getUTCDay()];
