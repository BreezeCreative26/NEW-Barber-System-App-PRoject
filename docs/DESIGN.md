# OLLO design system

Source of truth for how every screen looks and behaves. Reference renders: `docs/mockups/shell-wallet.html` (shop device / admin, 1440) and `docs/mockups/barber-mobile.html` (staff phone, 390). Tokens and shared components: `public/static/design.css`. React primitives: `src/client/ui.tsx`.

Enforced by `npm run test:design` (tokens only in design.css, no emoji in `src/`, stylesheet inventory, legacy `style.css` frozen) and `npm run test:visual` (screenshot baselines in `tests/__screenshots__/`).

## Principles

1. **One product, two devices.** Owner/admin is designed at 1440 first (top bar + icon rail + right drawers). Staff is designed at 390 first (top greeting + cards + bottom tab bar). Shared surfaces (appointment view, checkout) get both variants before build.
2. **Chrome stays out of the way.** 56 px top bar, 64 px rail; content gets the rest. One primary action per surface.
3. **Glanceable money.** Wallet chip in the top bar; hero card on staff Today; column heads show takings. All amounts via `money()`.
4. **Icons, never emoji.** Lucide line icons through `<Icon name>` only. Sizes: 18 default, 15 chip, 12 inline strip.
5. **Records, not balances.** Wallet views are ledgers derived from recorded payments. Copy must never imply OLLO holds or moves money.
6. **Tokens only.** No raw hex/rgb outside `:root`. New styling goes in `design.css`; `style.css` is legacy and may only shrink.
7. **Stable hooks.** Interactive elements that tests or later screens rely on carry `data-testid`.

## Tokens (design.css `:root`)

| Group | Tokens |
|---|---|
| Brand | `--ollo` periwinkle mark, `--ollo-soft` tint, `--accent` primary, `--accent-dark` hover/text on tint, `--accent-grad` hero gradient, `--cream` |
| Neutrals | `--ink`, `--ink-2`, `--muted`, `--muted-2`, `--line`, `--line-2`, `--canvas`, `--surface`, `--rail`, `--rail-fg`, `--rail-fg-on`, `--on-accent` |
| Semantic | `--good/--good-bg` done/paid, `--warn/--warn-bg` no-show/owed, `--note/--note-bg` in-service, `--blocked-*` blocked time, `--presence` |
| Shape | `--r-sm 8`, `--r 12`, `--r-lg 14`, `--r-xl 18`, `--r-pill` |
| Space | `--s-1..6` = 4 / 8 / 12 / 16 / 20 / 28 |
| Type | `--fs-11..34`; `--font` Inter |
| Shell | `--topbar-h 56`, `--rail-w 64`, `--tabbar-h 78` |

Calendar identity colours (sage / sand / blue / clay / plum / slate) and status badge tones are fixed and carry meaning; they are not restyled by theme changes.

## Components

| Component | CSS | React | Use |
|---|---|---|---|
| Top bar | `.topbar`, `.topbar-search`, `.wallet-chip`, `.topbar-iconbtn`, `.count-badge`, `.account-pill` | `TopBar` | Every owner/staff screen. Search · env pill · wallet chip · bell · account |
| Icon rail | `.rail` | `Rail` | Desktop ≥768. Tooltip on hover; `aria-current` on active |
| Tab bar | `.tabbar`, `.tab-fab` | `TabBar` | Phone <768. 4 tabs + centre FAB |
| Toolbar | `.toolbar` | — | One-row control strip (Today ‹ date › · filters · view · Add) |
| Wallet hero | `.wallet-hero` | `WalletHero` | Gradient card: label, amount, 3–4 stats, optional progress |
| KPI tile | `.kpi`, `.kpi-grid` | `KPI` | Icon label, value, delta |
| Method tile | `.method-tile`, `.method-grid` | — | Card / Cash / Transfer / Voucher breakdown; payment picker |
| Transaction row | `.tx-row`, `.list-label` | `TxRow` | Icon · title/caption · amount (+tip) |
| Status pill | `.status-pill` (`good`, `next`, `paid`, `warn`, `note`) | `StatusPill` | Booked / Next / Paid / No-show / In service |
| Block icons | `.block-icons` | `BlockIcons` | heart regular · repeat series · cloud online · footprints walk-in · badge-check paid |
| Blocked time | `.blocked-fill` | — | Hatched calendar object |
| Card | `.card` | — | White surface, 18 px radius, `h3` title + small caption |
| Right drawer | `.drawer-right` | — | Wallet, notifications; 440 px, under the top bar |

## Screen patterns

**Owner / shop device (1440)** — `TopBar` → `Rail` + main. Calendar: one-row `toolbar`; column heads = avatar, name, takings · visits; blocks carry `BlockIcons`. Wallet chip opens the shop-wallet drawer (hero, method tiles, barber balances, latest, Day summary / Close till).

**Staff phone (390)** — greeting row with bell + search; `WalletHero` (today, week pill, progress vs usual); **Up next** card (time, customer, flags, Call / Check in); today list rows with `StatusPill`; `TabBar` Today · Diary · + · Wallet · Me. Wallet tab: period tabs, hero with commission pill, pay-run card, `KPI` grid, dated `TxRow` lists.

**Customer (public)** — unchanged structure; uses the same tokens and icons.

## Definition of done for a UI slice

- [ ] Composed from the components above (new primitives added to `ui.tsx` + `design.css` first).
- [ ] Tokens only; `npm run test:design` passes.
- [ ] Lucide icons via `<Icon>`; no emoji.
- [ ] One primary action per surface; `data-testid` on new interactive elements.
- [ ] Works at 390 and 1440 (and 768 for shared surfaces); axe clean; no horizontal overflow.
- [ ] Matches the reference pattern; if it changes a reference screen, `npm run test:visual -- --update-snapshots` is run deliberately and the diff reviewed.
- [ ] New areas get a 20-minute static mock in `docs/mockups/` and approval before build.
