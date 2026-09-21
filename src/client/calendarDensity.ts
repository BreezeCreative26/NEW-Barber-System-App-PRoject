// Calendar density: how many pixels a 15-minute cell takes, and everything that follows from it.
// One preset drives the timeline geometry (drag/resize/scroll all key off `step`), the barber
// header height and how much text an event card shows. The user's choice is saved on their
// membership (prefs_json) and mirrored to localStorage so the first paint is already right;
// the shop's default (Settings → General) fills in for users who never chose; phones start Compact.
import { useEffect, useState } from "react";

export type Density = "COMPACT" | "STANDARD" | "LARGE";
export const DENSITIES: Density[] = ["COMPACT", "STANDARD", "LARGE"];

export type DensityPreset = {
  key: Density;
  label: string;
  blurb: string;
  step: number; // px per 15 min
  headerH: number; // barber header height
  eventMin: number; // minimum event height (px)
  gutter: number; // time gutter width (px)
  gutterPhone: number;
  column: number; // min column width (px)
  columnPhone: number;
  lines: 1 | 2 | 3; // text lines an event shows when tall enough
  halfHourLabels: boolean;
};

export const DENSITY_PRESETS: Record<Density, DensityPreset> = {
  COMPACT: { key: "COMPACT", label: "Compact", blurb: "Whole day on one screen. One line per appointment.", step: 20, headerH: 40, eventMin: 18, gutter: 52, gutterPhone: 40, column: 140, columnPhone: 132, lines: 1, halfHourLabels: true },
  STANDARD: { key: "STANDARD", label: "Standard", blurb: "Most of the day at a glance. Name and service.", step: 30, headerH: 48, eventMin: 24, gutter: 56, gutterPhone: 44, column: 170, columnPhone: 150, lines: 2, halfHourLabels: false },
  LARGE: { key: "LARGE", label: "Large", blurb: "Bigger blocks, easier to read from a distance.", step: 44, headerH: 64, eventMin: 32, gutter: 64, gutterPhone: 44, column: 190, columnPhone: 150, lines: 3, halfHourLabels: false },
};

export const DEFAULT_DENSITY: Density = "STANDARD";
export const isDensity = (v: unknown): v is Density => typeof v === "string" && (DENSITIES as string[]).includes(v);

// Height of a working day at a preset — used by tests and by the settings preview.
export function dayHeight(preset: DensityPreset, beginMin: number, endMin: number): number {
  return ((endMin - beginMin) / 15) * preset.step;
}

const LS_KEY = "foliyo.prefs";
type Prefs = { calendar_density?: Density };

export function readLocalPrefs(): Prefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(LS_KEY) : null;
    const p = raw ? (JSON.parse(raw) as Prefs) : {};
    return isDensity(p.calendar_density) ? { calendar_density: p.calendar_density } : {};
  } catch {
    return {};
  }
}
export function writeLocalPrefs(patch: Prefs) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...readLocalPrefs(), ...patch }));
  } catch {
    /* private mode */
  }
}

// Resolution order: what this user chose (server prefs, or local mirror while that loads) →
// the shop default → device (phones start Compact so the day fits).
export function resolveDensity(userPref: unknown, shopDefault: unknown, phone: boolean): Density {
  if (isDensity(userPref)) return userPref;
  const local = readLocalPrefs().calendar_density;
  if (isDensity(local)) return local;
  if (isDensity(shopDefault) && shopDefault !== DEFAULT_DENSITY) return shopDefault;
  return phone ? "COMPACT" : isDensity(shopDefault) ? shopDefault : DEFAULT_DENSITY;
}

const PHONE = "(max-width: 767px)";
export function usePhone() {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const update = () => setPhone(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return phone;
}
