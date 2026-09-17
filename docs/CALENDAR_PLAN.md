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

## Phase 1 — "It feels like Fresha" (drag, snap, hover, greyed-but-clickable)

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

## Phase 2 — Edit the appointment itself (service, price, duration)

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

## Open questions for the owner

1. Should a **barber** (not owner) be able to block their own time and trigger customer notifications, or is that owner/manager only?
2. When a price is edited **below the deposit already paid**, refund the difference automatically or leave as credit?
3. Overlaps: allow deliberate double-booking from the calendar (Fresha does), or keep the collision guard and only render overlaps that arrive via walk-ins/imports?
