// The installed app's home-screen icon is the shop's own logo (not foliyo's, not a placeholder).
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { shopIcon } from "../src/server/images";

const px = async (png: Uint8Array, x: number, y: number) => {
  const { data, info } = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * info.channels;
  return [data[o], data[o + 1], data[o + 2]];
};
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 14);
// A wide gold wordmark with transparent margins around it.
const wide = async () => new Uint8Array(await sharp({ create: { width: 800, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await sharp({ create: { width: 400, height: 120, channels: 3, background: "#c9a24b" } }).png().toBuffer(), left: 200, top: 90 }]).png().toBuffer());

describe("shop app icon", () => {
  it("shows the shop's logo, large, on a plate", async () => {
    const out = await shopIcon(192, await wide(), "Northline Barbers", "#ffffff", "#ffffff");
    const m = await sharp(Buffer.from(out)).metadata();
    expect([m.width, m.height]).toEqual([192, 192]);
    expect(near(await px(out, 96, 96), [0xc9, 0xa2, 0x4b])).toBe(true); // the logo, dead centre
    expect(near(await px(out, 6, 6), [255, 255, 255])).toBe(true); // the plate
    // trimmed: the mark spans most of the safe area rather than a third of it
    expect(near(await px(out, 96 - 55, 96), [0xc9, 0xa2, 0x4b])).toBe(true);
  });
  it("without a logo it is the shop's initials in the shop colour, never foliyo's", async () => {
    const out = await shopIcon(192, null, "Northline Barbers", "#a0522d", "#ffffff");
    expect(near(await px(out, 4, 4), [0xa0, 0x52, 0x2d])).toBe(true);
  });
  it("a logo that cannot be read falls back to the initials instead of failing", async () => {
    const out = await shopIcon(192, new Uint8Array([1, 2, 3]), "Northline Barbers", "#a0522d", "#ffffff");
    expect((await sharp(Buffer.from(out)).metadata()).width).toBe(192);
  });
});
