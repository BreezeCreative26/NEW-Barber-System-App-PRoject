# Customer side — plan

Status legend: **Live** = works today · **Next** = agreed, not built · **Later** = needs a decision or a provider.

## What exists today (Live)

| Surface | URL | Notes |
|---|---|---|
| **Shop home page** | `/<slug>` | The shop's front door: hero with Open now pill, next available, services, team, embedded booking, hours, gallery, find us, house rules. Owner edits copy/contact/sections/accent in **Settings → Shop page**. Only served while online booking is on. |
| **Customer account** | `/<slug>/me` | Passwordless sign-in (6-digit code, shown on screen in the sandbox). Your usual with one-tap next free slot, upcoming visits (move/cancel/calendar), history with Book again, profile, export and delete my data. Signed-in customers get the booking details prefilled on the shop page. |
| Public booking page | `/book/<slug>` | Service → barber → time → details → confirm. Add-ons, "soonest", join waitlist when full. No account. |
| Manage link | `/manage/<token>` | From the confirmation: reschedule, cancel, add to calendar (.ics). Token is a hashed capability, expires with the visit. |
| Waitlist | inside `/book/<slug>` | Captured per day/daypart; owner books them in from the bell. |
| Customer record | admin → Customers | One record per shop + mobile; notes, tags, birthday, preferred barber, marketing opt-in, history, merge. |

Gaps a customer feels: no reminders, no reviews, no deposits; "any barber" and group bookings still to come.

---

## 1. Barbershop home page — `/<slug>` (Live — first cut shipped; SEO/JSON-LD, reviews section and R2 uploads still to come)

Every shop gets a public page that *is* their website. Owner edits it in **Settings → Online presence**; the booking flow becomes a section of it (`/<slug>/book`) with `/book/<slug>` kept as a redirect.

**Sections (each toggleable, ordered):**
1. **Hero** — shop name, strapline, cover photo (https URL), primary "Book now", secondary "Call" / "Directions".
2. **Next available** — "Soonest: Tue 14:30 with Jay" pulled live; one tap to book it.
3. **Services** — grouped by category with price/duration; each row books that service.
4. **Team** — barber cards (photo, title, skills, Instagram) → book with this barber.
5. **Opening hours** — from shop hours + closures; "Open now / Closed · opens 09:00" pill.
6. **Gallery** — up to 12 image URLs (later: R2 upload).
7. **Reviews** — shown once the review flow (§4) exists; hidden until then.
8. **Find us** — address, map link, phone, Instagram, parking/transport note.
9. **Policies** — cancellation window, deposit policy, late/no-show rules (pulled from shop settings, with owner-editable wording).
10. **Footer** — "Powered by OLLO", customer sign-in link.

**Data:** `shop_pages` (shop_id, strapline, about, cover_url, gallery_json, phone, instagram, map_url, transport_note, policy_text, sections_json[order+enabled], theme{accent, tone}, published, version).
**SEO:** server-rendered title/description/OpenGraph per shop, `sitemap.xml`, schema.org `HairSalon` JSON-LD with hours and services.
**Theme:** one accent colour + light/dark tone, constrained to our tokens so pages stay on-brand.
**Admin preview:** live preview pane in Settings → Online presence; "View as customer" link in the account menu.

## 2. Customer accounts (Live — first cut shipped; standing-booking requests and loyalty still to come)

Optional, phone-first, no passwords: **one-time code by SMS or email**. Accounts are *global* (one customer identity across shops) but every shop still keeps its own `customers` row — the account links to it by verified phone.

**Sign-in flow:** enter mobile → 6-digit code → done. Falls back to email code if no SMS provider yet. In the sandbox, codes are shown on screen and written to the audit log (never sent).

**Customer area — `/<slug>/me`:**
- **Upcoming** — next visits with reschedule/cancel (reusing manage-link rules), add to calendar.
- **Book again** — "Your usual: Signature cut with Jay · every 3 weeks" → one tap picks the next free matching slot.
- **History** — past visits with barber, service, price, and a "Book this again".
- **Profile** — name, email, birthday, preferred barber, marketing opt-in, notes for the barber ("number 2 on the sides").
- **Standing booking** — request a repeat (owner confirms), see the series.
- **Loyalty** (Later, §6) — stamps/points once the owner enables it.

**Data:** `customer_accounts` (id, phone, email, name, created_at), `customer_account_links` (account_id, shop_id, customer_id), `customer_otp` (hash, target, expires, attempts), `customer_sessions` (hash, account_id, expires). Bookings made while signed in carry `customer_id` automatically; the "details" step is pre-filled.

**Privacy:** a customer only ever sees their own rows for the shop they're on; a shop never sees another shop's history. Delete/export my data from the profile.

## 3. Booking flow improvements (Partly live)

- ~~**Remember me**~~ — shipped with accounts (signed-in prefill + device memory).
- ~~**Any barber**~~ — shipped: "Any barber, see all times" jumps from the service step straight to every open time; each slot shows who is free.
- ~~**Book for someone else**~~ — shipped: "This visit is for someone else" on the details step; `attendee_name` on the visit, contact and customer record stay the booker's; shown on confirmation, manage link, /me, calendar and appointment panel.
- ~~**Group booking**~~ — shipped: 2–4 people on one day, **together** (distinct barbers, same start) or **back to back** (one barber, consecutive); each visit its own row under every guard, shared `group_id`, partial failures reported.
- **Deposit step** — shown when policy > £0; collects card via Stripe Checkout (Later, provider).
- **Confirmation** — page + email/SMS with manage link; add to Apple/Google calendar.
- **Reminders** — 24h and 2h before, with confirm/reschedule/cancel links (Later, provider). Queue table built now; sends stubbed.
- **Running late / on my way** — customer taps from reminder; shows in the barber's Today queue.

## 4. Reviews (Next, after §2)

After a completed visit the customer gets a "How was it?" link (from the reminder channel or the /me page). 1–5 stars + short text, per barber. Owner moderates (publish/hide, reply) in admin → Customers → Reviews; published reviews appear on the home page and barber cards. Average feeds Insights.

## 5. Owner controls in admin

**Settings → Online presence** (new tab, replaces the current Online Booking panel):
- Public address (slug) + QR code + copy link.
- Home page editor (sections, text, images, theme) with live preview.
- Booking rules: lead time, window, any-barber, group size, cancel window, deposit, policy wording.
- Customer accounts: on/off, sign-in method (SMS/email), what customers can self-serve.
- Reminders: on/off, timings, templates (sends require a provider).
- Reviews: on/off, auto-publish or moderate.

**Customers tab additions:** "Has account" badge, sign-in method, last seen; review list; "Send sign-in link".

## 6. Later / provider-dependent

- **SMS/email** — Twilio or MessageBird (SMS), Resend (email). Everything queues locally until keys are added.
- **Card deposits / prepay / no-show fees** — Stripe Checkout + saved card on file.
- **Loyalty** — stamp card (every Nth cut free) or points; redeem at checkout.
- **Gift vouchers** — buy online, redeem as VOUCHER tender (already a tender type).
- **Image uploads** — R2 bucket for covers/gallery/barber photos instead of URLs.
- **Custom domain** per shop (`bookings.theirshop.co.uk` → `/<slug>`).
- **Multi-language** — page copy in en-GB first; structure allows more.

## Build order

1. ~~**Shop home page + editor + admin links**~~ — shipped (`/<slug>`, Settings → Shop page).
2. ~~**Customer accounts (OTP, sandbox-shown codes) + /me area + remember-me in booking.**~~ — shipped (`/<slug>/me`).
3. ~~**Booking flow: any barber, book for someone else, group.**~~ — shipped.
4. **Reminder queue + review flow (sends stubbed until provider).**
5. Provider decisions → SMS/email live, Stripe deposits, loyalty, vouchers, uploads.

Each slice ships with tests, screenshots in `docs/evidence/`, and an entry here moving items from Next → Live.
