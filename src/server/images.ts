// Server-side image optimisation for uploads. Runs on Node (Vercel/Next); sharp is already part of
// the Next runtime. Covers and gallery photos become WebP at a sane width; logos keep transparency.
import type { mediaKinds } from "./presence";
type UploadKind = (typeof mediaKinds)[number];

export type Optimised = { bytes: Uint8Array; type: "image/jpeg" | "image/png" | "image/webp"; width: number | null; height: number | null };

const LIMITS: Record<string, { width: number; height?: number; quality: number }> = {
  cover: { width: 1920, quality: 82 },
  gallery: { width: 1600, quality: 82 },
  staff: { width: 800, height: 800, quality: 84 },
  logo: { width: 640, height: 640, quality: 90 },
};

export async function optimiseImage(input: Uint8Array, kind: UploadKind, sniffed: "image/jpeg" | "image/png" | "image/webp"): Promise<Optimised> {
  const limit = LIMITS[kind] || LIMITS.gallery;
  let sharp: (typeof import("sharp"))["default"];
  try {
    const mod = await import("sharp");
    sharp = (mod.default ?? (mod as unknown)) as typeof sharp;
  } catch {
    return { bytes: input, type: sniffed, width: null, height: null };
  }
  const img = sharp(Buffer.from(input), { failOn: "none" }).rotate();
  const meta = await img.metadata();
  const hasAlpha = !!meta.hasAlpha;
  const resized = img.resize({ width: limit.width, height: limit.height, fit: "inside", withoutEnlargement: true });
  // Logos keep alpha and avoid lossy edges; everything else is WebP.
  const out = kind === "logo" && hasAlpha ? await resized.png({ compressionLevel: 9, palette: false }).toBuffer({ resolveWithObject: true }) : await resized.webp({ quality: limit.quality, alphaQuality: 100, effort: 4 }).toBuffer({ resolveWithObject: true });
  const type = out.info.format === "png" ? "image/png" : "image/webp";
  // Never ship a larger file than we were given.
  if (out.data.byteLength >= input.byteLength && out.info.width === meta.width) return { bytes: input, type: sniffed, width: meta.width ?? null, height: meta.height ?? null };
  return { bytes: new Uint8Array(out.data), type, width: out.info.width, height: out.info.height };
}

// Which way a logo leans. Looks only at pixels that are actually painted (alpha > 40%), so a white
// mark on a transparent PNG reads as "light" rather than being averaged with its background.
//   light  → mostly pale/white: never invert; needs a dark plate on light surfaces.
//   dark   → mostly ink/near-black, low saturation: invert to white on dark surfaces.
//   colour → anything else (full-colour marks, mid-tones): leave exactly as uploaded.
// Returns "" when the image cannot be read (sharp missing, corrupt file) so callers fall back to
// the old behaviour instead of guessing.
export type LogoTone = "light" | "dark" | "colour" | "";
export async function logoTone(input: Uint8Array): Promise<LogoTone> {
  let sharp: (typeof import("sharp"))["default"];
  try {
    const mod = await import("sharp");
    sharp = (mod.default ?? (mod as unknown)) as typeof sharp;
  } catch {
    return "";
  }
  try {
    const { data, info } = await sharp(Buffer.from(input), { failOn: "none" }).resize({ width: 96, height: 96, fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let n = 0, lum = 0, sat = 0, light = 0, dark = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const a = data[i + 3];
      if (a < 102) continue; // < 40% opaque: background / anti-aliasing
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      n++; lum += l; sat += mx ? (mx - mn) / mx : 0;
      if (l > 0.72) light++; else if (l < 0.35) dark++;
    }
    if (n < 16) return "";
    const meanSat = sat / n;
    // A flat JPEG/PNG with an opaque white background: the mark itself is what is *not* light.
    const lightShare = light / n, darkShare = dark / n;
    if (meanSat > 0.28) return "colour";
    if (lightShare > 0.6 && darkShare < 0.15) return "light";
    if (darkShare > 0.6 && lightShare < 0.15) return "dark";
    // Opaque background + ink mark: the white is the plate, the ink is the logo → treat as dark.
    if (lightShare > 0.5 && darkShare > 0.15 && meanSat < 0.12) return "dark";
    return "colour";
  } catch {
    return "";
  }
}

// Home-screen icon for a shop's installed app: the logo centred on a solid background with safe
// padding (maskable icons get cropped to a circle/squircle by the launcher), or a two-letter
// monogram when the shop has no logo yet. Always PNG, always square.
export async function shopIcon(size: 192 | 512, logo: Uint8Array | null, name: string, bg: string, ink: string): Promise<Uint8Array> {
  const initials = name.split(/\s+/).map((w) => w[0]).filter(Boolean).join("").slice(0, 2).toUpperCase() || "•";
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
  const monogram = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${bg}"/><text x="50%" y="50%" dy="0.36em" text-anchor="middle" font-family="-apple-system, Inter, Arial, sans-serif" font-weight="700" font-size="${Math.round(size * 0.42)}" fill="${ink}">${esc(initials)}</text></svg>`;
  let sharp: (typeof import("sharp"))["default"];
  try {
    const mod = await import("sharp");
    sharp = (mod.default ?? (mod as unknown)) as typeof sharp;
  } catch {
    return new TextEncoder().encode(monogram);
  }
  if (!logo) return new Uint8Array(await sharp(Buffer.from(monogram)).png().toBuffer());
  try {
    const inner = Math.round(size * 0.62); // 19% padding each side keeps the logo inside the maskable safe zone
    const logoBuf = await sharp(Buffer.from(logo), { failOn: "none" }).resize({ width: inner, height: inner, fit: "inside", withoutEnlargement: false }).png().toBuffer({ resolveWithObject: true });
    const left = Math.round((size - logoBuf.info.width) / 2), top = Math.round((size - logoBuf.info.height) / 2);
    const out = await sharp({ create: { width: size, height: size, channels: 4, background: bg } }).composite([{ input: logoBuf.data, left, top }]).png().toBuffer();
    return new Uint8Array(out);
  } catch {
    return new Uint8Array(await sharp(Buffer.from(monogram)).png().toBuffer());
  }
}
