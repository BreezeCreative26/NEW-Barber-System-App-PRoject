# OLLO calendar — commercial plan (Fresha/Booksy grade)

Brief from the owner (17 Sept 2026), with a Fresha screenshot as the reference:

1. Clicking an appointment lets you **edit price, service, duration** (not just name/phone/notes).
2. **Drag and drop** moves an appointment **sideways (barber) and vertically (time)**. The **top edge of the card is the booking time**; as you drag past each 15-minute line it should **snap with a "click" feel** and the target time must be obvious.
3. From the screenshot: **staff photo** in the column header; **hover shows the slot time** you're over; **overlapping appointments** sit side by side; **non-working time is greyed but still clickable**; a **"Scheduled team" control** — by default only barbers working that day are shown, a dropdown adds anyone else (greyed, but named); next to each barber a button to **edit this day's hours**, **block the day/time with a reason**, and (when blocking over existing bookings) **pick affected customers and notify them by their contact preference**.

Everything below is ordered by what sells the product first.

---

## Where we already are

| Capability | State today |
|---|---|
| Day view, one column per barber, 15-min cells (`step = 44px`) | ✅ live |
| Staff avatar + name + takings in column header | ✅ live (`Avatar` in `.staff-column-heading`) |
| Per-day hours chip → override editor (`staff_schedule_overrides`) | ✅ live |
| Drag to move (HTML5 drag, ghost card, drop → `/reschedule` with confirm) | ✅ live but: drops only on free slots, no snap feedback, no live time label, off-duty slots refuse the drop |
| Greyed non-working time (`Shop closed / Day off / Off duty / Break / Past time`) | ✅ greyed, ❌ **not clickable** (slot `disabled`) |
| Edit customer name / phone / notes | ✅ (`PATCH /bookings/:id/details`) |
| Edit service / price / duration on an existing booking | ❌ none — `items_json` is frozen after create |
| Overlapping appointments | ❌ render on top of each other |
| Hover slot-time label | ❌ |
| Scheduled-team filter | ❌ shows all active staff every day |
| Block time / block day with reason | partial — `staff_days_off` + override editor; no timed block, no reason shown on the grid, no customer notify flow |
| Notify affected customers by preference | ❌ (messaging queue + templates exist; no "block → notify" flow) |

---

## Phase 1 — "It feels like Fresha" (drag, snap, hover, greyed-but-clickable) — ✅ SHIPPED 17 Sept (commit 907cb33)

Delivered: pointer drag (top edge = start, 15-min snap, haptic/scale tick, live time pill, sideways = barber, long-press on touch, Escape cancels); hover slot time; greyed cells clickable with override notice; deliberate double-booking via `force:true` (owner channel only; public never; past time never) with a transaction-local DB flag `ollo.force_slot` (migration 0010); overlap lanes. Tests: `tests/calendar-drag.spec.ts`.

**Why first:** this is what a barber judges in the first 30 seconds of a demo. It's pure client work — no schema change — and it de-risks everything after.

1. **Replace HTML5 drag with pointer-based drag** (`pointerdown/move/up`, `setPointerCapture`). HTML5 drag can't be styled, has no touch support on iPad, and can't give tactile feedback. Pointer drag gives us:
   - card follows the finger/cursor with a **live time label pinned to the top edge** ("10:15 · Joshua")
   - **snap to 15-min lines**: quantise `y` to `step`; on each new slot fire `navigator.vibrate?.(8)` on touch and a 60 ms `transform: scale(1.01)` tick on the card — this is the "click" feel
   - **column snap** for sideways moves with the same tick
   - **long-press (250 ms) to start on touch**, so scrolling the day still works
   - Escape / drop outside grid cancels
2. **Drop anywhere**, including off-duty and break slots. Server already validates; UI shows a one-line confirm only when the target is outside hours ("Joshua isn't rostered at 08:30 — book anyway?"). Past-time stays refused.
3. **Hover slot label**: a single absolutely-positioned `<div class="slot-hover">` per column that tracks `mousemove` and shows `time(start)`. No per-slot DOM changes, so it stays cheap.
4. **Greyed-but-clickable**: drop `disabled` on off-duty/break/closed slots (keep it for past-time and inactive barber). Clicking opens the booking form with an "outside rostered hours" notice — matches Fresha exactly.
5. **Overlap layout**: for each barber/day, cluster bookings whose intervals intersect; within a cluster assign lanes greedily; card gets `left = lane/lanes`, `width = 1/lanes`. Same algorithm as Google Calendar. Overlaps arise from walk-ins on top of online bookings and from double-booking on purpose — today they're invisible, which is a real operational risk.

*Effort:* ~2 days. *Tests:* rewrite drag tests for pointer events; add overlap-lane unit test; hover label test.

## Phase 2 — Edit the appointment itself (service, price, duration) — ✅ SHIPPED 18 Sept (commit e975c5c)

Delivered: `PATCH /bookings/:id/items`, inline panel editor (service, add-ons, £ per line, 5-min stepper, live total, refund warning, reason), `booking_adjustments` table, deposit over-payment refunded (Stripe partial refund when live) and charged as an automatic negative adjustment on the barber's next pay run (preview/create/auto runs claim it once). Tests: `tests/edit-items.spec.ts`.

## Payment modes — ✅ SHIPPED 18 Sept

`shops.payment_mode` (PREPAY / DEPOSIT / PAY_AT_VISIT), `services.payment_mode` override (NULL = inherit), `bookings.payment_mode` snapshot; `dueAtBooking()` + DB `ollo_due_at_booking()` keep app and trigger in step (migration 0012). Settings → Payments → Policy has the picker; Services → edit has the per-service override; public booking summary, manage page and Checkout copy follow the mode (PREPAY shows "Pay now", Checkout shows "Paid in full by card at booking", PAY_AT_VISIT hides the up-front line). Stripe Checkout session titles say Payment vs Deposit.

**Why:** "customer came in for a skin fade but we did a cut & beard" happens every day. Today the only route is cancel + rebook, which destroys history and the deposit link.

1. **Schema:** none — `items_json` already carries `{service_id, name, price_pence, duration_min, addons[]}` per line. Add `price_overridden INTEGER` per item for reporting.
2. **API:** `PATCH /bookings/:id/items` `{items, version, reason}` → recompute `duration_min` from items, run the **same collision check as reschedule** (same barber, new end time), bump `version`, audit `ITEMS_UPDATED` with before/after. Refuse if `status ∈ {COMPLETED, CANCELLED, NO_SHOW}` or a payment row exists (then it's a refund/adjustment, not an edit). Deposit stays attached; if new total < deposit, surface it.
3. **UI:** in `AppointmentPanel` the services block gets an **Edit** affordance (like Notes has). Opens an inline editor: service picker (barber-priced), add-ons, **duration stepper in 5-min steps**, **price field pre-filled and editable** with a "price changed from £28" pill after save. Save → panel refreshes; calendar card resizes live.
4. **Checkout reads the edited items**, so the fix-at-the-chair case is: click → Edit → Checkout · £new.

*Effort:* ~2 days. *Tests:* items edit lifecycle, collision refusal, version conflict, audit row, checkout total follows edit.

## Phase 3 — Scheduled team + per-barber day controls

**Why:** a 6-barber shop with 3 in today shouldn't scroll through 6 columns. And the day-of "Marcus is off sick" flow needs to be two taps, not a trip to Team → Schedule.

1. **Scheduled team control** in the calendar toolbar (replaces plain "All barbers"): default shows barbers with rostered hours today (weekly hours + overrides − days off). Dropdown lists the rest with "Off today" tags; ticking one adds their column, fully greyed (still clickable per Phase 1). Persist the choice per device in `localStorage` per date.
2. **Per-barber column menu** (⋯ next to the hours chip):
   - **Edit today's hours** → existing override editor (done)
   - **Block time** → new: pick from/to (defaults to the clicked slot), reason (Lunch / Training / Personal / Sick / Other + free text), *optional* repeat for the rest of the week
   - **Block the whole day** → `staff_days_off` with reason
   - **Add walk-in here** (shortcut)
3. **Schema:** `staff_blocks (id, shop_id, staff_id, date, start_min, end_min, reason, created_by, created_at)`. Blocks render as **grey cards with the reason** (like Fresha's "Blocked time"), are droppable-over with confirm, and count as unavailable in public availability.
4. **Blocking over existing bookings → notify flow:** the block dialog lists every booking it collides with, each pre-ticked, with the customer's preferred channel shown (SMS/email/none — captured at sign-up in `customers.contact_pref`, add if missing). Choose **Move** (opens reschedule with "next free with any barber"), **Cancel & refund deposit**, or **Keep** per row. Confirm → cancels/moves run through existing endpoints, and a `schedule_change` notification is queued per customer in their channel using the existing messaging queue and templates. Barber's own app copy gets a push/email too.

*Effort:* ~3 days. *Tests:* scheduled-team default set, block create/render/availability, block-over-booking notify queue rows per preference.

## Phase 4 — Polish that closes deals

- **Resize by dragging the bottom edge** of a card (duration change → Phase 2 endpoint).
- **Week view drag** between days.
- **Current-time line** across all columns (Fresha's purple "11:15am").
- **Card icons** (Fresha shows ♥ repeat client, ● paid, ☁ online): we have `BlockIcons`; add *repeat client* and *deposit paid*.
- **Keyboard**: `M` to move focused appointment with arrows; `[`/`]` to change duration.
- **Undo toast** after any move/block ("Moved Liam to 10:30 · Undo").

*Effort:* ~2 days.

---

## Sequencing and effort

| Phase | Ships | Working days | Cumulative |
|---|---|---|---|
| 1 | Snap-drag, hover time, greyed-clickable, overlaps | 2 | 2 |
| 2 | Edit service/price/duration | 2 | 4 |
| 3 | Scheduled team, block time/day, notify customers | 3 | 7 |
| 4 | Resize, week-drag, now-line, undo | 2 | 9 |

Plus ~1 day to rewrite the 7 legacy Playwright tests already flagged in `PROGRESS.md`. Every phase is independently shippable and behind no flag — the calendar stays usable throughout.

## Why this order commercially

- **Phase 1 is the demo.** Barbers switching from Fresha compare the drag feel first. Nothing else lands if this feels cheap.
- **Phase 2 is retention.** The first time a shop can't fix a price without cancelling, they email support. It's also what makes **Checkout** trustworthy — the number on the button must be editable before you charge it.
- **Phase 3 is the upsell to multi-chair shops.** Solo barbers don't need scheduled team; 4+ chair shops won't sign without it. Block-and-notify is the "wow" for owners because Fresha makes you do that by hand.
- **Phase 4 is what keeps us ahead** once we're at parity.

## Positioning against Fresha / Booksy

| | Fresha | Booksy | OLLO after this plan |
|---|---|---|---|
| Drag-move with snap | ✅ | ✅ | ✅ + haptic tick on iPad/phone |
| Edit price/service in place | ✅ | ✅ | ✅ with audit trail and deposit reconciliation |
| Block time → notify affected customers by *their* preference | manual | manual | **✅ automatic, one dialog** |
| Barber gets paid from card takings | payouts to shop only | shop only | **✅ per-barber Stripe account, auto pay runs** (already built) |
| Pricing | free + 20% new-client fee | £29.99+/mo + marketplace fees | flat per-chair, no new-client commission (**our headline**) |

## Data model additions (all Phase 3)

```sql
CREATE TABLE staff_blocks (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, staff_id TEXT NOT NULL,
  date TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '', created_by TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_staff_blocks_day ON staff_blocks(shop_id, date, staff_id);
ALTER TABLE customers ADD COLUMN contact_pref TEXT NOT NULL DEFAULT 'SMS'; -- SMS | EMAIL | NONE
```

## New endpoints

- `PATCH /bookings/:id/items` (Phase 2)
- `GET/POST/DELETE /staff/:id/blocks?date=` (Phase 3)
- `POST /staff/:id/blocks/preview` → colliding bookings with each customer's channel (Phase 3)
- `GET /calendar/scheduled?date=` → staff ids rostered that day (Phase 3; cheap, derived)

## Owner decisions (17 Sept 2026) — locked

1. **Barbers can block their own time and trigger customer notifications.**
2. Price edited **below a paid deposit → auto-refund the difference**, and the refunded amount is **charged against that barber's wallet** in the next pay run (`payouts.ts` → `walletFor` / `settlementFor` gets a `deposit_refunds_pence` line).
3. **Deliberate double-booking allowed from the calendar, Fresha-style** (shipped in Phase 1). Public booking keeps the guard.
4. **Payment modes are a first-class setting**: `PREPAY` (full amount at booking), `DEPOSIT` (existing flow), `PAY_AT_VISIT`. Shop default in Settings → Payments → Policy, with a per-service override on the service editor (e.g. colour work = prepay, kids cut = pay at visit). Public booking reads the effective mode: PREPAY creates a Checkout session for the full price and holds the slot like a deposit; PAY_AT_VISIT skips Stripe entirely. Checkout ceremony shows "Paid online · £X" and only collects tips/extras when prepaid. Schema: `shops.payment_mode TEXT DEFAULT 'DEPOSIT'`, `services.payment_mode TEXT NULL` (null = inherit), `bookings.prepaid_pence INTEGER DEFAULT 0`.

## Next session — start here

Order now: **Phase 3 (scheduled team, `staff_blocks`, block → notify) → Phase 4 → fix the 11 failing tests** (7 legacy tests driving removed controls + 3 E1 calendar tests asserting greyed cells are disabled + 1 phone visual snapshot; all expected changes, update the assertions to the new behaviour). No further decisions are needed from the owner. Not yet tested end-to-end: a public PREPAY booking in Stripe test mode (needs keys) — the code path is the deposit path with amount = price.

## Status — 2026-09-18 (Phase 3 shipped, commits 8da2423 and earlier)
- **Server**: migration 0013 `staff_blocks` + `customers.contact_pref`; `slotReason` returns "Blocked time" (overridable by the shop with `force`, hidden as "Unavailable" in the public API); routes `GET/POST /staff/:id/blocks`, `POST /staff/:id/blocks/preview` (affected visits + each customer's channel + next-free suggestion), `DELETE /staff/:id/blocks/:blockId`. Resolutions per booking: KEEP / MOVE / CANCEL (deposit auto-refunded, charged to the barber's pay run), `notify` per row through the customer's preferred channel.
- **Client**: grey hatched block cards with reason (hover × to remove), "Blocked" as a soft (clickable) cell reason, per-barber ⋯ menu (Edit today's hours / Block time… / Day off / Add walk-in), right-click a cell → block from that time, `BlockDialog` (when → who's affected → outcome), "Scheduled team · n/N" picker (rostered by default, add others; persisted in localStorage `ollo.team`).
- **Tests**: `tests/blocks.spec.ts` (API + browser) passing; `calendar-drag`, `edit-items` still green.

## Next session — start here
1. Phase 4: resize by dragging the bottom edge (→ `/items` duration), undo toast after move/block, repeat-client / deposit-paid card icons.
2. Walk-in from the ⋯ menu passes `staffId` in the editor but `WalkInForm` does not preselect it yet.
3. Test debt (11 known failures, update assertions not behaviour): calendar.spec.ts:119/:313/:383/:432/:621/:679, catalogue.spec.ts:403, public.spec.ts:610, workspace.spec.ts:75/:348, visual owner-calendar-phone snapshot. Phase 3 may add: `.staff-column-heading` count assertions on non-rostered days (scheduled team hides them now).
4. Run the full gate detached, fix, commit, push.

## Status — 2026-09-18 (Phase 4 shipped; all phases done)
- Resize (bottom edge → items duration, live label), Undo (20 s, move + resize), returning-customer /
  deposit icons, walk-in preselect from ⋯. `tests/calendar-resize.spec.ts` green.
- Test debt cleared: legacy panel assertions rewritten; full gate run recorded in PROGRESS.md.

## Later (not scheduled)
- Undo for block creation (currently: remove the block card; moved/cancelled visits stay as decided).
- Touch resize handle is small (8 px); consider a long-press grip on phones.
- Repeat-client detection uses the workspace snapshot (500 rows); switch to a server flag if shops outgrow it.

## Full gate 2026-09-18 (after Phases 3+4 and test-debt fixes): 154/161
Remaining 7 — none are calendar regressions; investigate next session:
- `tests/sandbox.spec.ts:157` endpoint registry — FIXED in this commit (added `/staff/:id/blocks*`, `PATCH /bookings/:id/items`); not yet re-run.
- `tests/messaging.spec.ts:54` (0 messages queued on booking create) and `:89` (409 slot_taken → fixture slot collision). `:54` fails in isolation too, so it is not parallel interference — check `enqueue` on `POST /bookings` (did the payment-mode / `dueAtBooking` change alter the confirmation-queue path or `msgShop` channel flags for the fixture shop?).
- `tests/waitlist.spec.ts:35` and `:209` expect messages `SENT`; same messaging root cause most likely.
- `tests/visual.spec.ts` owner-calendar-phone + owner-calendar-tablet: intentional UI change (⋯ menus, Scheduled team button, block legend). Refresh snapshots: `npx playwright test tests/visual.spec.ts --update-snapshots`, eyeball, commit.
