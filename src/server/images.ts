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
