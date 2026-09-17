# OLLO product audit — 2026-09-16

Method: signed in as owner, barber and customer on the running Next + Postgres build; walked every
workspace section, completed a real online booking on a phone viewport, signed into the customer
area with the OTP, opened appointments / studios / profiles, created a blank shop, probed error
pages, cookies, headers. Read the server for what is wired vs. stubbed. Zero console errors, zero
5xx across all walks; the test gate is 133 green. **What follows is about product, not bugs.**

Legend: **P0** blocks a real shop using it · **P1** owner hits it in week one · **P2** polish.

---

## A. The front door is still a test harness — P0

`/workspace` for a signed-out visitor shows "Open the demo shop — Demo Barbershop is the single
shared project… Rebuild demo data… Sign in with owner@demo.test / Demo1234!" with the credentials
**pre-filled**, plus "Need an empty shop instead? Start a blank test shop". A real owner cannot
sign up; the only way to create a shop is "Create test workspace", and to keep it you must find
Accounts → "Secure this test shop" → "Create owner account".

- No **shop signup** (name, email, password → shop). `/register` refuses unless a test session exists.
- No **password reset**, no email verification. Copy says so in three places.
- `/auth/demo` and "Rebuild demo data" are open to anyone in production (rebuild wipes the demo shop).
- Cookie names are `barbershop_account` / `barbershop_test_session`.
- `/api/sandbox/*` is the live API path; `/me` reports `mode: "local-test"`.

**Fix:** a real `/signin` + `/signup` (shop name, your name, email, password → shop + owner +
session), `/forgot` → emailed reset link once email is wired, demo gated behind `DEMO_ENABLED`,
remove the blank-test-shop flow, rename cookies + API path.

## B. Nothing is ever sent — P0

Every message is written to an outbox as `SKIPPED` ("No message provider connected; copy and send
by hand"). Concretely, today:

- **No booking confirmation** to the customer at all — not even queued. The confirmation page says
  "No message has been sent, so keep it somewhere safe" and offers "Text myself the link".
- **No reminders** (nothing in the codebase; no cron).
- Customer sign-in code is **printed on screen**: "No SMS provider connected yet: your code is 664626".
- Waitlist offers, review requests, cancellations, moves: outbox only; the owner is told to copy/paste.
- Owner/staff invitations: link shown on screen, "No email is sent".

**Fix:** Twilio (SMS) + Resend (email) behind the existing `notifications` outbox, a Vercel cron
that drains it and sends reminders (24h, 2h), and templates for: booked, moved, cancelled,
reminder, waitlist offer, review request, OTP, invite, password reset.

## C. No money moves — P0 for "run one shop", but the shop can start cash-only

- "Deposit policy £5 — recorded, not collected" everywhere. Deposits are a number in a column.
- Checkout records tenders (cash/card/transfer/voucher) as a **ledger only**; "card" means the shop
  used its own terminal. That's fine as a till book, but the copy says so in five places and the
  Settings field is literally labelled "Test deposit policy (£) — not collected".
- No Stripe, no card-on-file, no refunds, no receipts.

**Fix:** Stripe Checkout for deposits at booking (optional per shop), Stripe Terminal or
"pay-by-link" at checkout later; until then relabel honestly ("Deposit (not yet collected online)").

## D. Test/demo/sandbox copy still in the product — P1 (a day's work, high visible impact)

55 strings across the client. The ones a real owner will see:

- Settings: "Test deposit policy (£) — not collected"; "No payment or message is sent"; "Outbox only ·
  nothing sent"; Customer pages panel: "Passwordless sign-in… (shown on screen in this build)".
- Accounts footer: "Local identity testing only: one shop per account. No customer identity, email
  verification, recovery or live provider is enabled."
- Empty calendar: "Create a **test** booking, change the date or clear your filters."
- Signed-out notice: "No active browser session. Existing **test records** have not been deleted;
  creating a workspace starts a separate shop."
- New booking form: "Test deposit policy £5 — not collected"; review step "No payment or message will be…".
- Shop page footer: "Deposit policy £5 (not collected online in this build)".
- Booking page sidebar: "Live shop prices · no payment taken"; "Recorded, not collected".
- Notifications drawer: "No message provider is connected yet, so nothing here sends automatically."

## E. Owner day-one setup is thin — P1

A new shop gets **two fictional barbers ("Jay Carter", "Marcus Reed") and three services** it did
not ask for. There is no onboarding: nothing walks the owner through hours → barbers → services →
public address → "share your link". Specifics found:

- **Timezone is hard-coded** `Europe/London` (Settings shows it as read-only text). Shop settings
  has no currency, no country, no phone/email on the main card (they're on the Shop page card).
- **Shop hours are a single open/close + closed weekdays.** No per-day hours (Sat 9–4, Thu late).
  Barber schedules exist (Studio → Schedule) but the shop itself can't vary by day.
- Lunch break is implied ("Break" blocks at 12:45–13:15) — where is it edited? Not in Settings.
- No shop logo upload (initials avatar only); cover + gallery exist.
- Slug is chosen in Settings → Online booking, disconnected from Shop page publishing; two "Save" buttons.
- Every panel has a **"Refresh" button** in the header. Users read that as "this app doesn't update
  itself." Data should refresh on focus/interval; drop the buttons.

## F. Calendar / New booking — P1

- **New booking form time picker is a `<select>` with 36 options, most disabled** ("09:15 — Outside
  working hours", "10:00 — Time has passed"…). Should be the same slot grid the customer gets, or
  click-to-book on the calendar (drag on empty slot → prefilled form). On phone this is painful.
- Barber and service are `<select>`s too; fine, but the customer picker/typeahead only appears after
  choosing a time. Order should be: customer → service → barber → time.
- No drag-to-move / drag-to-resize on the calendar; Reschedule goes through a form.
- Week view exists; no month view / "next free slot for X" from the calendar itself.
- Walk-in: there is no one-tap "Walk-in now" (service + barber → starts now, no customer details).
- Calendar shows "Past time" label in every empty past cell — visual noise; a single shaded region
  is enough.
- No-show grace and late-cancel are recorded; there's no **"charge no-show fee"** hook (needs C).

## G. Team & payroll — P1/P2

- Barber "Pay" tab = commission % only. No hourly, no rent-a-chair, no tiered commission, no tips
  policy, no **payout summary export** (CSV per barber per period) — that is what owners actually
  do on Friday.
- Time off / days off exist; no recurring pattern (every other Saturday), no "cover" assignment.
- Barber cannot manage their own schedule or block time from the phone view (owner only).
- Roles: OWNER / MANAGER / RECEPTION / BARBER exist; barber invite is a link you paste (see B).

## H. Customers & marketing — P2

- Directory, profile, stats, tags, notes, merge, export: solid.
- No **broadcast/marketing** (SMS "quiet Tuesday, 20% off") despite collecting marketing consent.
- No birthday message, no "we miss you" for the Lapsed 60d+ segment that already exists.
- No import (CSV from Booksy/Fresha/Square) — this is the #1 onboarding blocker for switching shops.

## I. Customer-facing — P2 (this side is the strongest part of the product)

Booking flow, shop page, manage link, customer account, reviews, waitlist: all work on phone and
desktop with no errors. Small things:

- Confirmation page: "Save this private link… No message has been sent" (see B).
- Booking page hero repeats the address twice in the header on desktop.
- "Text myself the link" is an `sms:` deep link — fine on phone, dead on desktop; hide it there.
- Shop page nav "Your visits" → `/demo/me` OTP works but code is on screen (B).
- Default OG image is an SVG; several platforms (WhatsApp, LinkedIn) won't render SVG OG images — use PNG.
- No Google Reserve / Instagram "Book" button integration; slug URL is the only entry.

## J. SaaS plumbing (not needed for one shop; noted so we don't design against it)

- One shop per owner account (UNIQUE `user_id` on `shop_owners`); switching to many later means
  a join table, fine.
- No plans/billing/Stripe Billing; no super-admin view; no per-shop custom domains.
- `notifications` has no provider fields (provider_id, sent_at, error) yet.
- No rate limiting on public booking beyond origin check + throttle on auth.

## K. Things that are good and should be left alone

Availability engine + collision guards (trigger-enforced), series/standing bookings, group
bookings, waitlist with auto-offer and expiry, till ledger with commission snapshots and void,
audit trail, insights, customer directory/merge, shop page SEO/reviews/moderation/photos, A11y
(axe clean on every page tested), CSP + HttpOnly/Secure/SameSite cookies, 133 green tests.

---

## Recommended order (each line is one focused session)

1. **Front door** — real signin/signup/forgot pages; demo gated by env; blank-test-shop removed;
   cookies + `/api/sandbox` → `/api/app` renamed. Unblocks a real owner.
2. **Copy sweep** — kill all 55 harness strings; remove "Refresh" buttons (auto-refresh on focus).
3. ~~**Messages**~~ — **done 2026-09-17.** Twilio + Resend providers; lazy sweep + Vercel Cron drainer;
   confirmation, moved, cancelled, OTP, invite, waitlist offer, review request; reminders (configurable
   + 2h); owner Settings → Messages with Sent/Failed/Waiting outbox, test send, preview, resend.
   Covered by `tests/messaging.spec.ts`. Password reset email still pending (no reset flow yet).
4. **Shop setup** — onboarding checklist; per-day hours + breaks; timezone/currency pickers;
   logo; no fictional seed staff for a new shop (an "add your first barber" empty state instead).
5. **Owner booking UX** — slot grid in New booking; click-empty-slot to book; Walk-in now button;
   customer first in the form; quieter past-time shading.
6. **Deposits via Stripe Checkout** (optional per shop) + honest till labels; payout CSV per barber.
7. **CSV customer import** (Fresha/Booksy/Square shapes).
8. Then run the one shop for a week and let the owner's complaints set the next list.
