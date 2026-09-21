# foliyo brand assets

Source: `foliyo-logo-source.png` (supplied). Everything else is rebuilt as vector from it.

Colours: ink `#0b0b0c` · white `#ffffff` · mint `#00e8b0`.

## Vector (SVG) — use these wherever possible
| File | What | Use |
|---|---|---|
| `foliyo-wordmark.svg` | "foliyo" with mint dot + clock; letters use `currentColor` | In-app, inherits text colour |
| `foliyo-wordmark-white.svg` / `-ink.svg` | Same, colour baked | Email, dark/light backgrounds without CSS |
| `foliyo-lockup*.svg` | Wordmark + "APPOINTMENTS" tagline | Marketing, social, print |
| `foliyo-mark.svg` | The "o" clock on its own (`currentColor` ring) | Small spaces, avatars |
| `foliyo-icon.svg` | Mark on a dark rounded square | App icon |
| `../favicon.svg` | Mark, auto-switches ink/white with OS theme | Browser tab |

## Raster (PNG) — `png/`
Wordmark (white/ink @ 400/800/1600w), lockup (white/ink @ 800/1600w, plus on-black / on-white 2800w with padding), mark (ink/white @ 128/512/1024), app icon (180/192/512/1024). `og-default.png` is the 1200×630 social card.

Site files: `/favicon.ico` (16/32/48), `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`, `/site.webmanifest`.

## Rules
- Never recolour the mint accent; letters may be ink or white only.
- Minimum wordmark height 20px on screen; use the mark below that.
- Clear space around the lockup: at least the height of the "o".
