# OLLO

![OLLO](public/static/brand/ollo-logo.png)

OLLO is one connected barbershop platform in development: booking, shop operations, customer/barber journeys and eventually shop-owned payments, retention and SaaS administration.

## Current preview

[Open development workspace](https://3000-iz3aw7n21l3edjgvt4bkj-5c13a017.sandbox.novita.ai/workspace) · local http://localhost:3000/workspace

**Local fictional-data workspace, not a production SaaS.** **Brand:** OLLO periwinkle (`#6985e8` mark / `#4a5fd9` accent) on navy ink (`#181b2a`) with a cool canvas; assets in `public/static/brand/` (`ollo-mark.svg`, `ollo-logo.png`, transparent variant). Legacy CSS token names (`--accent`, `--forest`, `--sage`) are kept but now map to the OLLO palette; service/barber calendar colours (sage/sand/blue/clay/plum/slate) and semantic status greens/reds are unchanged. Saved data is retained. **One project, every view:** the entry screen at `/workspace` is a hub for the single shared *Demo Barbershop* — Owner/admin, Barber (Jay's scoped view), Customer booking (`/book/demo`) and the customer manage link — all running against the same saved data. The old static `/preview/*` fixture pages have been removed. A blank isolated test shop is still available behind "Start a blank test shop".

**Demo account (standard test login):** the entry screen offers **Open as owner** / **Open as barber** for the seeded *Demo Barbershop* (`/book/demo`). Fixed credentials: `owner@demo.test` or `jay@demo.test`, password `Demo1234!`. **Rebuild demo** resets it to the deterministic seed (3 barbers with profiles, 8 services, 4 add-ons, ~126 appointments −70…+14 days, standing series, waitlist, leave). API: `POST /api/sandbox/auth/demo {rebuild?, as?: "owner"|"barber"}`.

**Sign-in behind the preview proxy:** the sandbox proxy rewrites the request scheme, so the browser's `Origin` (`https://…`) never matched the worker's view (`http://…`) and every write returned 403 "origin". `sameOrigin` now compares hosts (request host, `Host`, `X-Forwarded-Host`), trusts `Sec-Fetch-Site: same-origin/same-site`, falls back to the `Referer` host when `Origin` is absent, and honours an `ALLOWED_ORIGINS` allowlist; foreign origins still get 403. `GET /api/origin-check` echoes what the worker sees for diagnosis.

## Design system

`docs/DESIGN.md` is the source of truth (tokens, components, screen patterns, definition of done); `public/static/design.css` + `src/client/ui.tsx` implement it; `docs/mockups/` hold the approved reference renders. Enforced by `npm run test:design` (tokens only, no emoji, frozen legacy sheet) and `npm run test:visual` (screenshot baselines). Shell: top bar (search · wallet chip · bell · account), icon rail on desktop, tab bar with centre **+** on phones.

## Working features

- **Service studio (new):** Services tab is a two-pane studio — searchable category groups of colour-coded service cards (Popular / In shop only / Inactive badges, price · minutes · barbers offering · upcoming count) with an inline editor: Details (name, category, description shown online, duration, price, order, calendar colour, Bookable online / Popular / Active switches), **Barbers & pricing** (one matrix of every active barber: offers on/off, price and duration overrides, Reset, single **Save barber rules** through `PUT /service-rules`), and Add-ons linked to the service. Add-on chips open the existing add-on editor. Non-online services never appear on `/book/<slug>` or in public availability; owners can still book them.
- **Barber studio (new):** Team tab shows profile cards (photo or coloured initials, title, skills, today's load, next visit, Hidden online / Inactive) with an inline editor: **Profile** (name, job title, internal role, start date, bio, skills tags with suggestions, https-only photo URL, Instagram handle, calendar colour, Show on online booking, Active, timetable order), **Schedule** (weekly hours strip + Edit weekly hours / Days off / Dated hours editors), **Services & pricing** (the same matrix from the barber side), **Performance** (7/30/90-day appointments, completed value, no-shows from `/insights`) and **Upcoming** (next 14 days, opens the appointment panel). Hidden barbers vanish from the public page and public slot assignment. Barber accounts read their own profile; owners/managers edit.
- **Studio safeguards:** editors mark unsaved changes; switching tab or closing asks *Discard changes and continue* / *Keep editing*. A version conflict shows *Discard edits and load latest*. If a save succeeds but the re-read fails, the editor locks with a clear "do not save again" message and Retry workspace recovers.
- **Appointment panel (new):** clicking an appointment opens a right-hand drawer on desktop (≥900px) or a bottom sheet on phones with status-aware actions (check in, start, complete, no-show, reschedule, cancel, book again, edit details, share, open customer), an inline note, the visit timeline (`GET /bookings/:id/timeline`) and, for standing bookings, *Cancel remaining* / *Move remaining* (`POST /series/:id/cancel|reschedule`, optional `from_booking_id`). Legacy controls remain under "More".
- **Customers (new):** first-class `customers` table linked to bookings (`customer_id`, auto-linked by phone via trigger). Directory filters (all / new / regulars / lapsed / no-shows / upcoming), sorts (recent / next / spend / visits / name), search; profile shows visits, completed spend, no-show rate, favourite barber and service, average gap, full history, notes, tags, contact details, and **Merge into** another record (bookings move; old record points at the new one). New booking has a **customer picker**: search existing, pick, or add new (duplicate-number warning); the chosen `customer_id` is sent with the booking.
- **Week view:** Appointments → Week shows Monday–Sunday with per-day appointment count and chair-load %, one row per active barber, colour-coded cards (↻ marks a standing booking, "online" marks web bookings) and hatched cells for days off. Click a day head to drill into that day's timetable; click a card to open the appointment. Reads `/bookings/range` (≤31 days, barber-scoped for barber accounts).
- **Standing bookings (new):** in New booking tick "Repeat this appointment at the same time", choose every 1–12 weeks and 2–26 visits. Review shows every date with Available / reason; unavailable dates must be ticked "Skip" before "Confirm standing booking (N dates)". Each visit is saved as its own appointment through the same D1 guards under one `series_id`; the result reports created/failed and the calendar lands on the first visit. Repeat controls never appear on reschedules.
- **Insights:** period-scoped (7d/30d/90d/Year) cards — appointments, completed value, no-show rate, booked online, customers seen/new, upcoming value + open waitlist — plus busiest hour/weekday bars, top services, per-barber table and a daily trend. Saved appointment records only; value is booked service price, not collected payment. Barbers see their own figures only.
- **Online booking:** Settings → Online booking sets a public address (`/book/<slug>`), an on/off switch, minimum notice and booking window. Customers pick service → barber → real date/time → details → review → confirm using the shop's live catalogue, barber rules, hours, leave, closures and the same D1 collision/quote guards as the owner. Bookings arrive tagged **Online** in the timetable, day stats and detail view.
- **Smarter time finding (new):** "First available" barber option shows every open time across eligible barbers and assigns the least-booked one per slot; a **Soonest** strip jumps straight to the next 4 bookable days; the date strip shows open/low/full indicators; times are grouped Morning/Afternoon/Evening with counts; skeleton loading; details remembered on-device for repeat customers.
- **Waitlist (new):** fully booked days offer "Join the waitlist" (name, mobile, preferred part of day; upserts per phone/date/service). Owners see a Waitlist panel above the timetable, "Book them in" prefills the booking form and links the entry as BOOKED on save; "Close" dismisses.
- **Share confirmation (new):** appointment detail → "Share confirmation with customer" generates (and rotates) a manage link and a ready-to-send message with Copy / Open in SMS / Open in WhatsApp. Nothing is sent automatically.
- **Confirmation & manage pages:** Google Calendar, Apple/Outlook `.ics`, Directions and "Text myself the link" action tiles.
- **Owner stats:** "Chair time booked" utilisation % of rostered hours replaces the plain completed count (completed shown in the footnote).
- **Customer manage link:** each online booking returns a private `/manage/<token>` page (hashed token, no account) to view, move (same barber/service, own slot excluded) or cancel, with version guards, lead-time/window limits, late-change flagging against the snapshot cancellation policy, and an `.ics` calendar download. No message is sent; the link is shown once on the confirmation screen.
- **Public catalogue presentation:** `/book/<slug>` shows service descriptions, a Popular pill, colour thumbs, barber photos/titles/bios/skills; ordered by popular → sort order.

- Connected day timetable/mobile agenda, week-date navigation, selected-day filters/search, complete paginated day reads, keyboard slot navigation, labelled buffers and saved-record statistics (not collected revenue).
- Reviewed conflict-safe bookings/walk-ins, details/contact corrections, reschedule, cancellation/check-in/start/complete/no-show, immutable commercial snapshots and append-only audit.
- **Book again:** open a visit and choose Book again. Prefills customer/contact and available original barber/service, with 3/4/6-week date shortcuts. Creates a separate new booking with current prices; old notes/add-ons are not copied and the original record stays unchanged. An unavailable barber/service requires an explicit replacement.
- **Use first available time:** selects a valid start for the currently selected barber/date, not a shop-wide search or reservation. Closed dates never receive invented slots.
- Grouped booking forms, focused review showing customer details, From/To reschedule comparison, pinned Close/Confirm controls, and return to the saved destination date. Successful booking/move clears filters so its destination is visible.
- Dirty/pending appointment action-switch protection, existing protected modal dismissal, retained drafts on errors and safe booking request replay.
- Staff/service CRUD/activity, add-ons/eligibility, barber price/duration overrides, weekly hours/breaks, full-day leave, shop closures, dated replacement shifts and saved settings (now reached through the studios).

### Try it

Fastest: **Open as owner** on the entry screen (demo shop, full history). Or create a test workspace → select a future working day → New booking → choose service/barber → Use first available time → fictional customer details → Review → Confirm. Open that appointment to **Book again** or **Reschedule**. Review before saving; no payment/message is created.

Phones use a single-column form; tablets/desktops use grouped columns where space permits. Narrow resource calendars scroll internally; Agenda remains available. Representative layouts include 320/390/768/1024/1440/1920px, 844×390 landscape and CSS 200% zoom checks. Automated browser checks are not certification of every physical device or screen reader. Exact latest test results are in [PROGRESS](docs/PROGRESS.md).

## Not implemented / next

Customer accounts (customers act through a per-booking manage link, not a login), automatic confirmations/reminders (owners share by hand), deposits/payments, photo uploads (profiles accept an https URL only), drag-to-reorder of barbers/services (numeric order fields instead), customer ratings/reviews and per-customer marketing consent remain unfinished. Local owner/staff accounts exist (register, invite, roles); Accounts is honest about being a local test adapter. Holds, live providers/payments/messages, financial ledger/pay-runs, installed/offline PWA, full week/month calendars, loyalty/memberships, retail/inventory/marketing, reporting and platform subscriptions are not claimed complete.

Next connected work: wider settings/navigation draft protection, then local account/membership/permission foundations for customer and barber journeys. Build-first: brief planning, working changes, tests, short handoff and commit—not repeated long planning documents. User's modern feature brief is [here](https://www.genspark.ai/api/files/s/sRhSuhAH); it guides backlog prioritisation and is not 100 completed features. Existing 189 requirement rows and original C/B/A IDs are retained; no new production acceptance is implied.

## Entry points

| Path | Purpose |
| --- | --- |
| `/`, `/workspace` | The app. Root always redirects here; the entry hub opens the demo shop as owner or barber and links to the customer pages |
| `/book/:slug` | Public customer booking for a shop with online booking enabled |
| `/manage/:token` | Customer self-service: view, move, cancel, calendar export |
| `/api/public/shops/:slug` | GET public catalogue, active barbers, rules, hours, window |
| `/api/public/shops/:slug/days`, `/availability`, `/next` | GET 14-day open counts / one day's slots / soonest slots. `staff_id` may be `any` (each open slot carries the assigned `staff_id`/`staff_name`); slot holders are never revealed |
| `/api/public/shops/:slug/waitlist` | POST join waitlist for a full day (`daypart` ANY/MORNING/AFTERNOON/EVENING); throttled per phone |
| `/api/sandbox/waitlist`, `/waitlist/:id/status` | GET open/booked/closed entries (barber-scoped); POST versioned status with optional `booking_id` |
| `/api/sandbox/bookings/:id/manage-link` | POST issues a fresh customer manage link (revokes the previous one) |
| `/api/public/shops/:slug/bookings` | POST idempotent online booking (`request_id`), returns `manage_token` once; throttled per shop/IP and per phone |
| `/api/public/manage/:token` | GET view; `/availability`, POST `/cancel`, `/reschedule` (versioned); `/calendar.ics` |
| `/api/sandbox/shop/online` | PUT slug/online flag/lead time/window (owner/manager) |
| `/api/sandbox/bookings/range` | GET `from`/`to` (≤31 days) compact bookings incl. `series_id`; barber-scoped |
| `/api/sandbox/insights` | GET `days` 7–365 aggregates (status/channel, services, barbers, hours, weekdays, daily, customers, upcoming, open waitlist) |
| `/api/sandbox/series/preview`, `/series` | POST dry-run per-date availability with `skip_dates`; POST creates a `booking_series` and every occurrence through `createBooking` (409 if <2 bookable or unresolved conflicts) |
| `/api/sandbox/auth/demo` | POST opens/creates the demo shop (`rebuild`, `as`); `/auth/login` with the fixed demo credentials |
| `/api/origin-check` | GET/POST diagnostic: what Origin/Host/Referer/Sec-Fetch-Site the worker receives |
| `/api/sandbox/customers` | GET directory (`q`, `filter` all/new/regulars/lapsed/no_shows/upcoming, `sort` recent/next/spend/visits/name, `limit`); POST create |
| `/api/sandbox/customers/:id` | GET profile + stats + history by id or phone (merged records resolve to their target); PUT versioned edit (name, phone, email, notes, tags) |
| `/api/sandbox/customers/:id/merge` | POST `{into}` moves bookings, points the old record at the target |
| `/api/sandbox/bookings/:id/timeline` | GET audit-derived timeline for one visit |
| `/api/sandbox/series/:id/cancel`, `/series/:id/reschedule` | POST remaining occurrences (optional `from_booking_id`), each through the shared guards |
| `/api/sandbox/service-rules` | PUT `{rules:[{staff_id,service_id,enabled,price_pence\|null,duration_min\|null}]}` — batch matrix; default rows delete the override, others upsert; one audit entry |
| `/api/health` | Mode/persistence capability, `livePayments:false` |
| `/api/sandbox/session` | POST creates/reuses isolated browser-owned shop |
| `/api/sandbox/workspace` | GET setup, legacy capped snapshot, audit and independent impact warnings |
| `/api/sandbox/bookings` | GET requires `date`, optional `limit` 1–200, `staff_id`, `status`, paired `cursor_start`/`cursor_id`; POST creates reviewed idempotent booking |
| `/api/sandbox/bookings/:id` | GET authorized details; PATCH `/:id/details`, POST `/:id/reschedule` and `/:id/status` are versioned/audited |
| `/api/sandbox/availability` | GET `date`, `staff_id`, `service_id`, optional `addon_ids` and reschedule `booking_id`; no holds |
| `/api/sandbox/shop` | PUT versioned settings |
| `/api/sandbox/staff`, `/services`, `/addons`, `/holidays` | Sandbox-scoped CRUD. Staff accept `title, bio, colour, photo_url (https), online_visible, skills[], instagram, start_date, sort_order`; services accept `description, colour, online_bookable, popular, sort_order`. Full route inventory in source/tests |
| `/api/sandbox/staff/:id/hours`, `/days-off`, `/overrides`, `/services/:serviceId` | Existing schedule, leave and eligibility/individual-price operations |

## Data, safety and local development

Hono + React + TypeScript + Vite; Cloudflare Pages-compatible Worker with **local D1**, Wrangler and PM2 on port 3000. All project code: `/home/user/webapp`, branch `main`.

D1 persists shops, hashed sandbox sessions, staff/catalogue/add-ons/rules, hours/leave/overrides/closures, bookings and immutable audit. Booking `items_json` preserves service/add-on price/duration snapshots; integer-pence prices and exact durations plus ten-minute buffer. London timezone only. Complete day reads follow cursors; legacy workspace cap and audit pagination/scalable impact work remain documented limitations.

Tenant scope is server-derived from a seven-day capability cookie (HttpOnly/Secure/SameSite=Strict), not production identity. API requires local `APP_MODE=sandbox`, D1 and matching mutation Origin. D1 transactions guard overlap, schedule/eligibility/quote and history. Only booking creation has request-key replay; inspect other interrupted writes before repeating. No real personal data, offline write queue or lost-cookie recovery.

Ten migrations now exist, including both distinct `0002_*` files; `0005_local_accounts`, `0006_public_booking` (shop slug/online flags, booking `channel`/`email`, `booking_manage_tokens`), `0007_waitlist` (`waitlist_entries`), `0008_booking_series` (`bookings.series_id` + immutable trigger, `booking_series_lookup` index, `booking_series` table), `0009_customers` (`customers` table, `bookings.customer_id`, auto-link trigger, `merged_into`) and `0010_catalogue_profiles` (staff profile columns, service presentation columns, colour enum). Next prefix **0011**. For fresh local start: build, then `pm2 start ecosystem.config.cjs` after freeing port 3000. Run `npm test` against the service; never build/migrate during tests. Keep `.dev.vars` and local data ignored.

**Nothing live:** no deployment/provider activation/charges/messages/transfers/public GitHub push. Model A remains: each shop receives haircut money; owners pay barbers externally. Future manual pay-runs calculate/export/record, not hold a wallet or initiate barber transfers. SaaS subscription money is separate.

Older [build plans](docs/BUILD_PLAN.md), [decisions](docs/DECISIONS.md), [design](docs/DESIGN_SYSTEM.md), [quality gates](docs/QUALITY_GATES.md) and [feature register](docs/FEATURE_REGISTER.csv) remain references. Latest source/test state and short next-step handoff take precedence over historical pauses/counts.

