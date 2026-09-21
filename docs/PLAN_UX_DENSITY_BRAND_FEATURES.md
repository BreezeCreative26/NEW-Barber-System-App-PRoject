# foliyo — UX density, branding, out-of-hours, feature toggles, gift cards, migration

Audit + build plan for the requests numbered 4–10. Written against `5366c23` (pay runs v2 live).
Everything here was checked against the running code and screenshots at 390 / 820 / 1366 / 1920 px.

Legend: ✅ exists and works · 🟡 exists, partial or rough · ❌ missing.

---

## 0. The principle (goes in COMMERCIAL_PLAN.md §UX and in every review)

> **foliyo prioritises information density without sacrificing readability.** A barber should see
> as much of their working day as possible at a glance, with minimal scrolling and minimal clicking.
> Every screen is judged first by *how much useful information fits above the fold on a phone and on
> a 13" laptop*, and second by how many taps the common action costs.

Concrete rules derived from it (applied in §1 and §2 below, then used as the yardstick for every
later screen):

1. **Chrome is a fixed cost, not a share.** Toolbars, headings and stat strips take the minimum
   height they need; the content area takes everything else (`flex: 1; min-height: 0`), never a
   `max-height` cap that leaves the bottom of the viewport empty.
2. **One toolbar row on ≥1024px.** Controls wrap to a second row only below that.
3. **The working day fits.** With a 09:00–18:00 day on a 768-px-tall laptop, Standard density
   must show ≥ 7 hours without scrolling; Compact must show the whole day.
4. **Density is a user preference, not a breakpoint.** Phone gets a smaller *default*, not a
   locked layout.
5. **No dead columns.** Barber columns share the width; the timeline never renders narrower than
   its container on desktop.

---

## 1. Calendar view & scrolling — audit

### What the screenshots show (laptop 1366×768, 2 barbers, 09:30–18:00 day)

| Finding | Evidence | Impact |
|---|---|---|
| 🟡 **Vertical scale is 44 px per 15 min = 176 px/hour.** 8.5 h day = 1 496 px. | `Calendar.tsx:266 const step = 44` | Only **≈ 2.3 hours** visible in the board; user scrolls ~4 screens to see the day. |
| 🟡 **Board height is capped, not fluid.** `.connected-scroll { max-height: min(640px, calc(100vh − 300px)) }` | `design.css:710`; at 768 px tall the board is 468 px | Wastes vertical space on tall screens; on 768 px the cap plus 300 px of chrome leaves a 2-hour window. |
| 🟡 **Toolbar wraps to two rows at 1366 px** (New booking drops down). | audit-cal-laptop.png | +48 px of chrome; looks broken. Desktop 1920 fits on one row. |
| 🟡 **Three stacked header strips** above the board: toolbar, stats strip ("3 matching appointments · £88 …"), week-day strip, then per-barber header (72 px). | screenshot: 285 px from topbar to first slot | Stats strip and day-strip are useful but tall; barber header repeats hours already in the ⋯ menu. |
| 🟡 **Barber header is 72 px** (avatar 32 + two text lines + hours pill). | `.calendar-staff-header` | Could be 44 px with name + pill inline. |
| 🟡 **Event card padding**: 12 px each side; 3 text lines even for 30-min slots. | `.calendar-event` | Fine at Standard; at Compact must collapse to 1–2 lines. |
| 🟡 **Gutter 64 px** labels every hour only; 15-min gridlines are drawn but unlabeled. | `gutter = compact ? 44 : 64` | OK, but at Compact the half-hour label helps readability. |
| ✅ Phone (390 px) is already using a 44 px gutter and 150 px columns; 2 barbers fit with horizontal scroll. | audit-cal-phone.png | Keep; density will help more here than anywhere. |
| ✅ Auto-scrolls to first appointment/opening time on mount. | `Calendar.tsx:285` | Keep. |
| ✅ Week view is compact already (cards, not a timeline). | audit-cal-week-laptop.png | Only needs the toolbar/heading fixes. |
| ✅ Drag/resize engine uses `step` as the single geometry constant. | `locate()`, `style={{ top: … * step }}` | Density = change `step`; engine follows. |
| ❌ No density preference; nothing persisted. | — | — |
| ❌ Empty-space legend row ("Free · Break · Blocked · Buffer · How the timetable works") sits *below* the board and pushes it up on 1920. | audit-cal-desktop.png | Move into the "How the timetable works" popover. |

### Design

**Density presets** (single source of truth, `src/client/calendarDensity.ts`):

| Preset | `step` (px / 15 min) | px / hour | Barber header | Event min height | Event text | 09–18 day height | Fits in 468 px board? |
|---|---|---|---|---|---|---|---|
| **Compact** | 20 | 80 | 40 | 18 | 1 line: `13:30 Ada · Sig cut` | 720 px | with fluid board on 768-tall laptop (board ≈ 560 px) → **≈ 7 h**; on 1080 → whole day |
| **Standard** (new default) | 30 | 120 | 48 | 24 | 2 lines | 1 080 px | ≈ 4.7 h at 768; ≈ 7 h at 1080 |
| **Large** | 44 (today's value) | 176 | 72 | 32 | 3 lines | 1 584 px | as today |

Phone default = Compact (already `useCompact()` for gutter/column). Laptop/desktop default = Standard.
The old 44 px look survives as "Large" so nobody loses what they have.

**Readability at Compact** — rules, not hopes:
- Event card shows `HH:MM Name · Service` on one line, ellipsised; status shown as a 6 px left bar
  colour (already there) and a dot; hover/long-press shows the full card (existing popover).
- Gridlines: every 15 min at 1 px `--line-2`, every hour at `--line`; hour labels 11 px + half-hour
  labels 10 px muted.
- Events < 15 min keep the existing 18 px minimum and `compact-event` class.
- Overlapping lanes keep working (geometry is proportional).
- Minimum touch target on phone stays ≥ 32 px: for Compact on touch devices, tap opens the detail
  panel (already the behaviour), and drag needs a long-press (already the behaviour), so 20 px rows
  are fine for *reading*; hit-testing uses the whole card.

**Fluid board height**: replace the `max-height: min(640px, calc(100vh − 300px))` cap with a flex
column: `.calendar-page { display:flex; flex-direction:column; height: calc(100dvh − topbar) }`;
board `flex:1; min-height:0; overflow:auto`. On phone the same with `− tabbar`.

**Chrome diet (all views)**:
- One toolbar row ≥ 1024 px: `Today ‹ date › | barbers | team | filters | ····· | Day/Week/Agenda | Walk-in | New booking`; below 1024 wrap as today.
- Stats strip → merge into the date button's dropdown *and* keep a one-line 24 px strip only when
  Large; at Standard/Compact render it as small text right-aligned in the toolbar row 2 slot only if
  there's room, else hidden behind the date dropdown.
- Barber header: avatar 24 px, name, hours pill and ⋯ on one 40/48 px row; "£60 · 2 visits" moves to
  the ⋯ menu header and the hover tooltip.
- Legend row → inside "How the timetable works".
- The workspace heading (`<h1>Appointments</h1>` + blurb) is already hidden on the calendar tab; keep.

**Density control**: a small `⋯ view` menu in the toolbar (icon `rows`) with three radio items
Compact / Standard / Large + "Applies on this device" hint. Also in Settings → General → Calendar
for the *shop default* (owner) — user choice always wins.

**Persistence**: per-user in `app_memberships.prefs_json` (new column, JSON, ≤ 2 KB) via
`PUT /me/prefs {calendar_density}`; mirrored to `localStorage["foliyo.prefs"]` for instant paint
and offline. Shop default `shops.calendar_density_default` (`COMPACT|STANDARD|LARGE`, default
STANDARD). Resolution: user pref → shop default → device (phone → Compact).

### Work

| # | Item | Files |
|---|---|---|
| 1.1 | `calendarDensity.ts` presets + `useDensity()` hook (reads prefs, localStorage, matchMedia) | new |
| 1.2 | Replace `const step = 44` + gutter/column constants with preset values; header/event classes `density-compact/standard/large` | `Calendar.tsx` |
| 1.3 | Fluid board: flex layout, remove max-height caps (`design.css:710, 828`) | `design.css` |
| 1.4 | Toolbar one-row at ≥1024; move stats into date dropdown; legend into help popover; slim barber header | `Workspace.tsx` calendar toolbar, `Calendar.tsx`, `design.css` |
| 1.5 | View menu (density radios) + Settings → General → Calendar default | `Workspace.tsx`, `Settings` general tab |
| 1.6 | Migration 0024: `app_memberships.prefs_json`, `shops.calendar_density_default`; `GET/PUT /me/prefs` | `migrations/`, `sandbox.ts` |
| 1.7 | Tests: unit (preset geometry → day height), e2e: pick Compact, reload → persists; whole 09–18 day visible at 1366×768 Compact with no vertical scroll (`scrollHeight <= clientHeight`) | `tests/calendar-density.spec.ts` |

---

## 2. Whole-app responsive audit (390 / 820 / 1366 / 1920)

Checked: Appointments (day/week), Team → barber → Pay, Pay runs, Settings (General, Payments),
Customers, Shifts, public shop page, booking flow, appointment panel + checkout.

| Screen | Finding | Fix |
|---|---|---|
| Workspace heading | `<h1>` 36 px + blurb + 24 px padding + rule = **≈ 110 px** of chrome on every non-calendar tab; on phone ≈ 90 px. | Heading 24 px, blurb 13 px muted on the same row (right) on ≥1024, hidden on phone (rail label already says where you are). Saves ~60 px everywhere. |
| Settings | Left sub-nav card (232 px) + 40 px gap + form. Fields are full-width 1-column at 1366 → form is 900 px wide with 46 px-tall inputs → **Opening hours = 7 rows × 62 px**. | Two-column form grid at ≥1024 for short fields (name/timezone/currency); opening hours as a compact 7-row table (40 px rows) with copy-to-all; inputs 40 px (`--ctl-h`). |
| Team → barber editor | Fixed-width 440 px column on the left (list), editor takes the rest; on 1366 the editor is only ~740 px so the pay-deduction row wraps to 2 lines. | On ≥1280 collapse the list to 280 px when an editor is open (name + avatar only). Deduction row uses `grid-template-columns: repeat(auto-fit, minmax(120px, 1fr))`. |
| Pay runs table | OK on ≥1024; on phone horizontal scroll (acceptable) but the rail label "Pay runs" is behind More. | Add to phone "More"; fine. Consider card layout < 640. |
| Appointment panel | 480 px drawer: good. Checkout section starts **below the fold** at 768 px (needs a scroll before the first payment button). | Make the customer stat tiles a single 32 px line; collapse Notes to one line with "Edit"; put Checkout header sticky when in view. |
| Public booking (phone) | Hero is 340 px tall before the first actionable element; step tabs another 90 px. **First service card is 3 screens down.** | Hero 200 px on phone (shop name, one line, CTA "Start booking" that scrolls to step 1); step tabs sticky 48 px. |
| Public booking (laptop) | Centre column 720 px in a 1366 canvas; fine, brand-first. | Leave. |
| Topbar | 56 px, fine everywhere. Search 380 px wide on 1366 crowds the wallet/waitlist chips. | Search `max-width: 320px` below 1440. |
| Rail | 64 px, fine; phone tab bar fine. | — |
| Modals/dialogs | `.palette max-height:70vh` fine; BlockDialog 358 lines untested on 390 px — check bottom actions visible. | Bottom actions sticky in dialogs < 600 px tall. |
| Typography | Body 14 px, small 11 px — good for density. | Introduce `--fs-10` for compact gutter labels only. |

Implementation: one CSS pass (`design.css`) + small JSX changes in Workspace heading and Settings
general form. Tests: `tests/responsive.spec.ts` snapshots of the five key screens at four viewports
asserting (a) no horizontal overflow on the document, (b) primary action visible without scroll.

---

## 3. Business branding & colour theme — audit

| Finding | State |
|---|---|
| Shop brand model `{logo_url, accent, theme:{font,mode,corners,hero,logo}}` on `shops` (`accent` enum of 6 named colours; `theme` fields). Applied through `.shop-page.accent-*` class stack → `--sp-accent/--sp-accent-dark/--sp-soft/--sp-accent-ink` tokens in `shop-theme.css`. | ✅ solid foundation, customer side only |
| Accent picker in Settings → Shop page (6 swatches). | ✅ |
| Logo upload (Media) and "logo-flip" for dark mode. | ✅ |
| **Workspace** (owner/staff side) is hard-coded foliyo green (`--accent #3a7563` in `design.css`). Calendar, buttons, rail, active states are all foliyo, not the shop. | ❌ |
| Arbitrary hex colours / secondary colour. | ❌ (enum only) |
| Palette suggestion from logo. | ❌ |
| Live preview before applying. | 🟡 (Shop page tab shows the page below; no side-by-side, no workspace preview) |
| Contrast safety (text on accent). | 🟡 `--sp-accent-ink` set per named accent by hand; no computation |

### Design

**Data**: replace the enum with a brand object on `shops.brand_json` (new, migration 0025):

```json
{ "primary": "#1f4f8f", "secondary": "#e8b04b", "mode": "light",
  "palette_source": "logo|preset|manual", "preset": "ocean", "logo_palette": ["#1f4f8f","#e8b04b","#f4f4f0","#101820"],
  "apply_workspace": true }
```
Keep `accent` for backwards-compat (mapped on read: `accent → primary` from the existing table).

**Colour maths** (`src/shared/colour.ts`, pure, unit-tested):
- `derive(primary, secondary, mode)` → tokens: `accent`, `accent-dark` (−12 % L), `accent-soft`
  (primary at 10–14 % alpha over surface), `on-accent` (black or white by WCAG contrast ≥ 4.5),
  `secondary`, `on-secondary`, `focus-ring`, `link` (primary darkened until ≥ 4.5 on surface), and a
  12-step tint ramp for calendar/staff colours.
- **Guardrails**: if the chosen primary fails 3:1 against the surface for UI elements we auto-shift
  lightness and show "adjusted for readability" with the original swatch beside it. Never silently.
- **Palette from logo**: client-side (canvas) — downsample to 64×64, k-means k=5 in OKLab, drop
  near-white/near-black/low-chroma unless nothing else, rank by (area × chroma). Suggest primary =
  most saturated dominant, secondary = most distant hue with area ≥ 5 %. No server round-trip, works
  on the existing uploaded logo URL (same-origin R2/Vercel blob → `crossOrigin="anonymous"`).
- 12 curated presets (ocean, forest, ink, clay, plum, gold, rose, slate, midnight, olive, coral, mono)
  each defining primary + secondary + recommended mode.

**Where the colours go**:

| Surface | Today | After |
|---|---|---|
| Shop page, booking, manage visit, customer account, offer page | `--sp-*` from enum | `--sp-*` from `brand_json` (inline `<style>` on `:root` or `.shop-page` with the derived tokens; class stack stays for font/corners/hero) |
| Workspace (calendar today marker, selected day, primary buttons, rail active, segmented, links, focus) | foliyo green | `--accent*` overridden on `.workspace` from brand when `apply_workspace` (default on). Rail/topbar stay ink so the shell is still recognisably foliyo; the *actions* take the brand. |
| Staff colours (sage/sand/…) | fixed 12 | unchanged (they are per-barber identity, must stay distinct) |
| Emails / SMS | none | `primary` on the email button + header rule (lifecycle + booking emails already template-driven) |
| Printable invoice/pay statement | foliyo | shop primary on the rule and totals |
| PWA `theme-color` | light/dark constant | primary (light) / surface (dark) |

**UI — Settings → Branding (new tab; the Shop page tab keeps layout/sections)**:
1. Logo (existing uploader) → "Suggest colours from logo" → 5 swatches with "use as primary /
   secondary" chips.
2. Presets grid.
3. Primary / Secondary: swatch + hex input + native `<input type=color>`; contrast badge (AA/AAA/adjusted).
4. Mode: Light / Dark / Follow device.
5. "Use brand colours inside the workspace too" toggle.
6. **Preview** — side-by-side cards rendered with the *draft* tokens (not saved): mini booking
   page (hero, step tabs, service card, CTA), mini calendar (today pill, event, primary button),
   a text-message bubble and an email header. Toggle phone/laptop frame. "Apply" saves;
   "Revert" restores.

**Work**

| # | Item |
|---|---|
| 3.1 | Migration 0025 `shops.brand_json`; read-model maps legacy `accent`; zod `brandSchema` |
| 3.2 | `src/shared/colour.ts` (parse, OKLab, contrast, derive, ramp, k-means) + 20 unit tests |
| 3.3 | `applyBrand(brand, scope)` writes CSS vars; used by `themeClass` consumers and `.workspace` root |
| 3.4 | Branding settings tab with preview; logo palette extraction |
| 3.5 | Emails/printables pick up primary |
| 3.6 | e2e: set primary → booking page button computed colour = primary; workspace primary button follows when toggle on; contrast-adjust path; preview does not persist until Apply |

---

## 4. Booking outside scheduled hours — audit

| Finding | State |
|---|---|
| Server: owner/manager can `force:true` on create/reschedule/repricing; `overridable()` includes `outside_hours`, `staff_day_off`, `slot_taken`, `shop_closed`. DB trigger enforces for customers (channel ONLINE) and honours force via the sandbox path. | ✅ |
| Calendar drag/drop already passes `force` when dropping outside (`draft.outside`) and records reason "over: outside hours". | ✅ |
| New-booking drawer: `override` flag exists (`Workspace.tsx:6468`) — shows a confirm when the slot is unavailable. | ✅ |
| **Visual indication on the card afterwards**: none — an out-of-hours booking looks identical. | ❌ |
| Booking row records that it was forced (`override_reason`?) — no column; only the audit log knows. | ❌ |
| Barber's hours unchanged by a forced booking. | ✅ (no write to schedule) |
| Counts in earnings/pay runs. | ✅ (ledger-based) |
| Feature toggle. | ❌ |

### Design
- Migration 0024: `bookings.outside_hours INTEGER NOT NULL DEFAULT 0` set by `createBooking`/reschedule
  when the accepted reason was `outside_hours`/`shop_closed` (computed, not user-entered); backfill
  from audit where cheap, else 0.
- Calendar card: hatched top-left corner + moon icon + tooltip "Outside Jay's hours (09:30–18:00)";
  agenda/week: "· out of hours" suffix. Appointment panel: notice line with the barber's normal hours
  and a link "Open extra hours for this day" (→ §5) or "Just this once" (default).
- New-booking drawer: when the picked time is outside hours, show inline (not a modal) "Outside
  Jay's hours — book anyway" checkbox with the rule text; barbers (BARBER role) can do this for
  themselves only when `shops.ooh_staff_can_book=1`.
- Toggle `shops.ooh_bookings` (default ON for owner/manager). OFF → force refused with a clear
  message pointing at Settings → Booking.

---

## 5. Out-of-hours surcharge / extended hours — audit

| Finding | State |
|---|---|
| Per-day hours overrides (`staff_schedule_overrides`: enabled/starts/ends/break/reason) — "Hours for a day" from the barber ⋯ menu. Extending 18:00→20:00 for one day already **opens online booking** for that window. | ✅ |
| Price on a booking: `price_pence` + quoted versions; pricing engine in `quote()`; add-ons; deposit maths; Stripe line items. | ✅ |
| Surcharge concept. | ❌ |
| Customer-visible price breakdown in booking flow. | 🟡 (service + add-ons + total; no "surcharge" line) |

### Design
- **Extended-hours windows are explicit**, not inferred: migration 0024 adds
  `staff_extra_hours (id, shop_id, staff_id, date, starts, ends, surcharge_kind FIXED|PERCENT|NONE, surcharge_value, online INTEGER, note, created_by, created_at)`.
  Created from the barber ⋯ menu ("Open extra hours…"), from the Shifts page, and from the
  out-of-hours booking notice. Repeats (e.g. "every Thursday to 20:00 in December") handled by the
  same `rules` pattern planned for recurring blocks (§ PLAN_BLOCKS_PAY_HOLIDAY §1).
- Shop-level defaults `shops.ooh_surcharge_kind/value` (e.g. PERCENT 20) pre-fill new windows; a
  window can override. Toggle `shops.ooh_surcharge` (default OFF).
- **Availability**: `slotReason` treats an extra-hours window as working time (like an override) so
  online customers can see and book it when `online=1`. Rostered hours untouched.
- **Pricing**: `quote()` returns `surcharge_pence` when *start* falls inside a window with a
  surcharge; stored on the booking (`bookings.surcharge_pence`, `surcharge_label`) and included in
  `price_pence`; quoted-version hash includes the window id so a later change to the window
  re-quotes (existing `quote_changed` path). Deposit policy applies to the total. Payments ledger
  line shows "Out-of-hours +£8" so pay runs and the staff share include it (owner can choose in
  the pay terms whether surcharge is split like sales or goes 100 % to barber — `staff.surcharge_to_staff_pct`, default same as split).
- **Customer flow**: on the time picker, out-of-hours slots carry a badge "+£8 out of hours" (or
  "+20 %"); the review step shows `Signature cut £28 · Out-of-hours (after 18:00) +£5.60 · Total
  £33.60` before confirm; confirmation email/SMS repeat it. Manage-visit page shows it.
- **Workspace**: calendar shades extra-hours windows differently from rostered time (lighter, with a
  "+£" tag in the column header for that day); appointment panel shows the surcharge line;
  checkout carries it through.

---

## 6. Feature toggles — audit

| Finding | State |
|---|---|
| Ad-hoc flags exist: `online_booking`, `waitlist_auto_offer`, `msg_sms/email/reminders`, `deposits_online`, `payrun_auto`, `pay_show_owner_share`, page `sections_json` (reviews section). | 🟡 scattered across tabs, different shapes |
| A single "Features" surface. | ❌ |
| Hide-not-delete semantics. | 🟡 (online_booking behaves that way; others vary) |

### Design
- Migration 0024: `shops.features_json TEXT NOT NULL DEFAULT '{}'` — sparse map of `key → 0|1`,
  read through `features(shop)` which merges with defaults so new features get a sane default
  without a migration. Existing dedicated columns stay as the source of truth for their feature and
  are surfaced in the same UI (adapter list), so nothing moves and no data changes.
- Registry (`src/shared/features.ts`): `{ key, label, blurb, default, area: "Team|Booking|Money|Customers|Brand", settingsPath, requires?: key[] }`.

  Initial keys: `holidays`, `holiday_approval` (requires holidays), `ooh_bookings`,
  `ooh_surcharge` (requires ooh_bookings), `reviews` (customer feedback requests + page section),
  `chair_rent` (deductions editor), `commission_splits` (pay model chooser beyond "keeps all"),
  `branding`, `gift_cards`, `waitlist`, `group_bookings`, `pay_runs`, `products` (already gated by
  plan), `blocks_recurring`.
- **Settings → Features** tab: grouped switches with the state word ("On"/"Off") next to each, one
  line of explanation, and "Open settings →" to the feature's own tab. Dependent toggles disable
  with "needs Holidays on".
- **Effect of OFF** (uniform contract, enforced in one helper `featureOn(c, key)` server-side and
  `useFeature(key)` client-side):
  - Navigation items, tabs, menu entries, calendar affordances, settings sections → hidden.
  - Server routes → `409 feature_off` (never 404, so the client can explain).
  - Data → untouched. Calculations that *consume* the data (e.g. pay run deductions) keep working
    for existing records; new records can't be created. Existing approved leave still blocks the
    calendar when `holidays` is off (safety), but the request UI disappears.
  - Turning back ON → everything reappears with the previous settings (they were never deleted).
- Plan gating stays separate (`plan.ts`); a feature can be "available on Pro" (locked) vs "off".
- Tests: for each key, OFF hides nav + route returns 409; ON restores; data survives round-trip.

---

## 7. Gift cards — audit

| Finding | State |
|---|---|
| Payments ledger has a `VOUCHER` method (a manual tender, no balance). Checkout supports **split tenders** already (`split: Tender[]`, "Split payment so far"). | 🟡 |
| Customer account area (`CustomerArea.tsx`) shows visits/next appointment; no wallet. | ❌ |
| Gift card issuing, balance, redemption, transaction history. | ❌ |
| Stripe: gift card purchase online would be a normal PaymentIntent through the shop's connected account. | ✅ plumbing exists |

### Design
- Migration 0026:
  - `gift_cards (id, shop_id, code UNIQUE (12 chars, Crockford base32, no vowels), initial_pence, balance_pence, currency, customer_id NULL, purchaser_name, purchaser_contact, recipient_name, message, status ACTIVE|REDEEMED|VOID|EXPIRED, expires_at (default +24 months; UK guidance), issued_by, issued_channel SHOP|ONLINE, stripe_payment_intent, created_at, version)`.
  - `gift_card_transactions (id, shop_id, gift_card_id, kind ISSUE|REDEEM|REFUND|ADJUST|VOID|EXPIRE, pence (signed), balance_after, booking_id NULL, payment_id NULL, actor, note, created_at)` — append-only, the balance is derived and checked by a trigger (`balance_after` must equal previous + pence, never < 0).
  - `payments.method` CHECK gains `GIFT_CARD`; `payments.gift_card_id`. The `VOUCHER` method stays for paper vouchers.
  - Shop settings in `features_json`/columns: `gift_card_presets_json` (default `[1000,2000,5000,10000]`), `gift_card_custom_min/max`, `gift_card_expiry_months`, `gift_cards_online INTEGER` (sell on shop page).
- **Wallet model**: a gift card *assigned to a customer* (`customer_id`) is that customer's wallet
  balance; the customer can hold several (gifts). `GET /api/customer/wallet` (customer area) →
  cards + balance + transactions. Owner sees the same on the customer profile ("Wallet £25.00 · 1
  gift card") with "Apply at checkout" and "Adjust" (reason required, audited).
- **Issue** (workspace → Gift cards tab): pick preset or custom amount → optional recipient/message →
  assign to a customer (search) or leave unassigned (code only) → take payment via the normal
  tender picker (cash / card / transfer; **not** gift card) → prints/SMS/emails the card (code,
  balance, expiry, shop brand colours from §3). Online: shop page section "Gift cards" → Stripe
  Checkout → card emailed to purchaser, or assigned to recipient if they have a foliyo account
  with that phone.
- **Redeem at checkout**: tender picker gains **Gift card** (icon gift): shows the customer's
  wallet cards if the booking has a customer, or a code field; amount defaults to
  `min(balance, remaining)`; adds a tender line; remaining recalculated live (the split UI already
  does this: e.g. £40 total → gift £25 → remaining £15 → Cash). Server `POST /bookings/:id/pay`
  accepts `tenders[]` incl. `{method:"GIFT_CARD", gift_card_id, pence}` and, in one transaction,
  inserts the payment row(s), the REDEEM transaction and decrements the balance (optimistic
  `version`). Voiding a payment reverses with a REFUND transaction.
- **Pay runs**: gift-card tenders are sales for commission purposes (money was taken when the card
  was sold) — the ledger `service_pence` is unchanged; settlement treats GIFT_CARD like CASH (already
  in shop's hands). Insights: "Gift card liability" KPI (outstanding balances) + "sold / redeemed
  this period".
- **Customer**: wallet card on the account home + "Use at your next visit"; balance and history;
  SMS on issue and on redemption ("£25 used at Northline · £0 left").
- Roles: barbers can *redeem* (till access rule) but only owner/manager can issue/adjust/void.
- Tests: issue → redeem split → balance/ledger/pay-run consistency; void reverses; negative
  balance impossible (trigger); barber can't issue; feature OFF hides tab and 409s issue.

---

## 8. Client import & seamless migration — audit

| Finding | State |
|---|---|
| CSV import with header detection, phone normalisation, duplicate detection by mobile, preview → commit, "fill blanks only" on existing, barber blocked. e2e covered (`tests/import.spec.ts`). | ✅ |
| **Booking history import.** | ❌ |
| Vendor presets (Fresha / Booksy / Square / Treatwell / Vagaro / Timely / Phorm / Nearcut exports have known column names). | ❌ |
| Duplicate by email when phone missing; fuzzy name+email. | 🟡 (phone only) |
| Post-import "we've moved" SMS with booking link. | ❌ (broadcasts exist for admins; shop-level SMS templates exist for waitlist) |
| Add-to-home-screen guide. | ❌ (manifest + icons exist, so "install" works; no instructions) |

### Design
- **Import wizard v2** (Customers → Import):
  1. Choose source: Fresha, Booksy, Square, Treatwell, Vagaro, Timely, Phorm, Nearcut, "Other
     CSV/XLSX". Each preset = column aliases + date formats + notes on how to export from that
     system (one screenshot-free paragraph each). XLSX parsed client-side (SheetJS via CDN,
     lazy-loaded) into CSV so the server API is unchanged.
  2. Map columns (auto from preset; manual fallback exists). New optional fields: `last_visit`,
     `total_visits`, `total_spend`, `notes`, `tags`, `birthday`, `preferred_staff` (name-matched),
     `marketing_opt_in`.
  3. **History**: a second file (appointments export) or the same file with per-visit rows →
     imported into `customer_history_imports (id, shop_id, customer_id, date, service_name, staff_name, price_pence, source)`. Shown on the customer profile as "Before foliyo" (greyed, not
     editable), feeds `last_visit`/`visits`/`spend` stats and "book again" defaults; **not** in the
     payments ledger, so pay runs and insights aren't polluted.
  4. Dedupe: phone (normalised) → else email (lower) → else exact name + birthday. Preview shows
     `create / update / skip (duplicate) / invalid` counts and a downloadable "skipped rows" CSV.
  5. Commit is idempotent per file hash (`imports` table records file hash, counts, actor) so a
     re-upload can't double-create.
- **Migration message**: after commit, a "Tell your customers" step: pre-filled SMS
  `Hi {first}, {shop} now takes bookings on foliyo. Book your next visit: {short_link}` +
  optional email; audience = imported customers with a mobile and no opt-out; preview count and
  estimated SMS cost from the plan; sends via the existing messaging pipeline, throttled (existing
  sweep) and logged as a campaign (`campaigns` table: id, shop, kind MIGRATION, audience_n, sent_n,
  failed_n, created_at). One-tap link = `/s/:slug?src=migrate` (already the booking entry) with
  `utm` recorded on the booking (`bookings.source_tag`) so the owner sees "23 bookings from the
  move message" in Insights. Requires `msg_sms` on and marketing consent respected
  (`marketing_opt_in` or transactional basis — the move notice is transactional; opt-out link
  included regardless).
- **Add-to-home-screen guide**: public page `/s/:slug/install` (also linked from the SMS follow-up,
  the booking confirmation footer, and a "Save to your phone" button on the shop page that appears
  on mobile and hides when `display-mode: standalone`). Two tabs auto-selected by UA: **iPhone**
  (Safari → Share → Add to Home Screen → Add, with the note that it must be Safari) and **Android**
  (Chrome → ⋮ → Add to Home screen / Install app → Add). Plain words, 3 steps each, large
  illustrations (SVG, brand-coloured), the shop's icon shown as the result. Where
  `beforeinstallprompt` fires (Android Chrome) show a real "Install" button. Owner can print a
  counter card version (`/s/:slug/install?print=1`) with a QR to the booking page.
- Tests: preset mapping for 3 vendors from fixture CSVs; history import shows on profile and
  not in ledger; idempotent commit; message audience excludes opt-outs and counts; install page
  renders both guides and the standalone media query hides the button.

---

## 9. Sequencing & estimates

Order chosen so every step ships alone, and so later features land on the toggle and brand
foundations rather than being retrofitted.

| Step | Scope | Size |
|---|---|---|
| **A** | UX principle in docs; **calendar density** (§1) + fluid board + toolbar diet; prefs API (0024 part 1) | M |
| **B** | Responsive pass (§2): heading, settings form grid, team editor width, appointment panel fold, booking hero; `responsive.spec.ts` | M |
| **C** | **Feature toggles** framework + Settings → Features (§6) wired to existing flags | S–M |
| **D** | **Out-of-hours booking** marker + inline confirm + toggle (§4) | S |
| **E** | **Extended hours + surcharge** (§5): table, availability, quote, customer breakdown, calendar shading, pay share | L |
| **F** | **Branding** (§3): brand_json, colour maths, workspace theming, Branding tab with preview + logo palette | L |
| **G** | **Gift cards** (§7): schema, issue/redeem/split, wallet, customer area, insights | L |
| **H** | **Migration** (§8): presets, XLSX, history, dedupe v2, move message, install guide | L |
| — | Still queued from the previous plan: **Staff holiday** (leave model + UI) and **recurring blocks** — Holiday is a toggle key here, so C lands first, then Holiday slots in after D. | L |

Migrations: 0024 (prefs, density default, features_json, bookings.outside_hours, staff_extra_hours,
bookings.surcharge_*), 0025 (brand_json), 0026 (gift cards), 0027 (imports/history/campaigns).
Each is additive and applied to Supabase right after its step's tests pass, as before.

## 10. Acceptance checks (the ones we will actually run)

- 1366×768, owner, 2 barbers, 09:30–18:00: **Compact shows the full day with no vertical scroll**;
  Standard shows ≥ 4.5 h; density persists across reload and devices for the same user.
- Phone 390: calendar toolbar ≤ 2 rows; first appointment visible without scrolling; no page
  horizontal overflow on any workspace tab.
- Owner sets primary `#1f4f8f`: booking CTA, calendar today pill and primary buttons compute to
  that colour; text on it passes 4.5:1; preview shows before Apply; Revert restores.
- Owner books 19:00 for a barber who finishes 18:00 → card carries the out-of-hours marker, the
  barber's hours are unchanged, the visit shows in the pay run.
- Owner opens 18:00–20:00 on Thursday with +20 %: customer sees `£28 + £5.60 = £33.60` before
  confirming; the ledger and statement carry the surcharge.
- Every feature key: OFF hides the UI and returns 409 on its routes; ON restores; data intact.
- £40 visit paid £25 gift card + £15 cash: two ledger rows, card balance 0, customer wallet shows
  history, pay run includes £40 sales.
- Fresha export (fixture) → 200 customers + history imported once, no dupes on re-upload; move
  message previews the right audience; `/s/:slug/install` shows the right guide per device.
