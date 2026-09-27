# Customer experience audit — 2026-09-27

Method: walked the whole customer journey as a real customer would on a fixture shop, on a phone
(390×844, touch) and a 1366×768 laptop, taking screenshots at every step (`docs/evidence/cx/`).
Zero console errors, zero page errors. Verdict per surface, then a ranked fix list. Items marked
**fixed** were fixed in the same session.

Legend: ✅ commercial grade · 🟡 good with a rough edge · ❌ needs work.

## Verdict by surface

| Surface | Verdict | Notes |
|---|---|---|
| Shop page `/<slug>` | ✅ | Strong: hero with live open/closed pill, rating, Book/Call/Directions, "Next available" per barber, services, team, reviews with shop replies, policies, footer with Your visits + legal links. Reads like the shop's own site. |
| Booking — service step | ✅ | Group-booking entry, price total sticky, "Any barber, see all times" shortcut, clear step indicator. |
| Booking — time step | 🟡 | "Soonest" tiles are excellent. **But the calendar opens on today even when today is closed** (Sunday → "0 available"), so the first thing a customer sees under the tiles is an empty day. → **fixed**: initial date jumps to the first open day with availability. |
| Booking — hero repeats on every step | 🟡 | The ~700 px "Look sharp. Feel like yourself." card sits above *every* step on phone, so the form for steps 3–5 is below the fold each time. → **fixed**: hero collapses to a compact strip after step 1 on phones. |
| Booking — details step | ✅ | Name/mobile/email, "book for someone else", contact preference, remember-me, privacy line (now on the correct step). Summary card is clear. |
| Booking — summary copy | ❌ | "Live shop prices · **no payment taken**" — leftover test-era copy (AUDIT.md §D). Reads as though the shop can't take money. → **fixed**: removed. |
| Booking — confirmation | 🟡 | Clear "BOOKED", reference, copy link, .ics, contact echo. **Raw manage URL printed in full** (ugly, 90 chars) and **no prompt to create an account** — the single best moment to convert a first-timer into a returning customer. → **fixed**: URL hidden behind Copy link; added "See all your visits" card linking to `/<slug>/me`. |
| Customer sign-in `/<slug>/me` | ✅ | Passwordless (6-digit code), explicitly says "creates a customer account for **this shop only**", delete-any-time note. Shop-scoped sessions verified in tests. |
| Account — returning customer | ✅ | "Your usual" (most-booked service + barber, cadence, price) with **Next free** one-tap rebook; Upcoming with Calendar/Move/Cancel; History with "Book again"; per-visit review form; Profile (name, email, birthday, preferred barber, marketing opt-in); export + delete. This is better than most competitors. |
| Account — first-time customer | 🟡 | Same screen with empty History reads a little bare; fine. |
| Waiting list | 🟡 | Only reachable when a **selected day is fully booked** — correct behaviour, but a customer who wants a specific barber on a specific day that's *closed* or *beyond the window* gets nothing. Acceptable for v1; noted for later. Joining, offers (`/offer/<token>`), leaving from `/me` all work. |
| Manage link `/manage/<token>` | ✅ | Move/cancel/calendar/review without an account; deposit refund rules explained. |
| Legal / privacy | ✅ | Privacy line at details step, Privacy/Terms in every footer, `/legal/*` pages. |
| Accessibility | ✅ | Axe clean on shop page, booking, group booking, account. Reduced-motion respected. |
| Performance | ✅ | Every page interactive < 1 s locally; SPA bundle 1.5 MB (323 kB gzip) — acceptable, could split later. |

## Shop-scoping check (your explicit question)

Confirmed in code and tests (`tests/customer-account.spec.ts`):
- `customer_sessions` carries `shop_id`; a token issued on shop A returns `null` on shop B.
- `customer_account_links` is `(account_id, shop_id)` → one global identity by mobile number, but
  **each shop sees only its own link and its own customer record**. Shop B never sees shop A's visits,
  notes, or even that the person has an account elsewhere.
- Export and delete are per shop. Delete removes the link and this shop's data; history stays with
  the shop as anonymised bookings (now also covered by the owner-side erase).

## Ranked fix list

| # | Fix | Size | Status |
|---|---|---|---|
| 1 | Remove "no payment taken" from the booking summary | XS | **fixed** |
| 2 | Calendar opens on the first *open* day with availability, not today when today is closed | S | **fixed** |
| 3 | Collapse the booking hero after step 1 on phones | S | **fixed** |
| 4 | Confirmation: hide the raw manage URL (keep Copy link), add "Create your account / see all your visits" card → `/<slug>/me` | S | **fixed** |
| 5 | Waiting list for closed / out-of-window days ("tell me when you open bookings for…") | M | partly — customers can now ask for **any day up to** a later date and a **time window**, so a closed day is covered by the range; a bare closed-day request is still later |
| 6 | Code-splitting: booking, shop page, customer area each as their own chunk | M | later |
| 7 | Account: show "Waiting list" section even when empty with a link to book | XS | done |
| 8 | Booking hero: allow the owner to turn it off entirely in Settings → Shop page | S | later |


## 2026-09-27 — follow-up
- Waiting list v2 shipped (delay, order/everyone, windows, ranges) — see PROGRESS.md.
- `/me` always shows the Waiting list section (empty state links to booking); range and window requests display correctly; offers show their date when it differs.
- **Themes audited**: `tests/theme-matrix.spec.ts` renders all 6 accents × 2 looks (rotating through every typeface, corner and hero choice) on the shop page and booking flow with axe colour-contrast on — zero violations, zero console errors. Every typeface × hero layout checked with and without a cover photo. A brand-new shop with no `shop_pages` row gets the default theme immediately, and the first save applies on the next load (public API is `no-store`).
- **Live preview** in Settings → Shop page: phone/desktop frame using the real theme classes; cover, logo, gallery, strapline, accent, typeface, look, corners and hero all update as you edit, before saving. Evidence: `docs/evidence/cx/shop-preview-*.png`.
