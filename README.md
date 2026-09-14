# Barbershop OS

One connected barbershop platform in development: booking, shop operations, customer/barber journeys and eventually shop-owned payments, retention and SaaS administration.

## Current preview

[Open development workspace](https://3000-iz3aw7n21l3edjgvt4bkj-5c13a017.sandbox.novita.ai/workspace) · local http://localhost:3000/workspace

**Local fictional-data workspace, not a production SaaS.** Original matte forest/sage styling and saved data are retained. Existing cookies access the same test shop; new browsers create separate shops. `/preview/admin`, `/preview/book` and `/preview/barber` remain labelled fixture references, not operational customer/staff apps.

## Working features

- **Online booking (new):** Settings → Online booking sets a public address (`/book/<slug>`), an on/off switch, minimum notice and booking window. Customers pick service → barber → real date/time → details → review → confirm using the shop's live catalogue, barber rules, hours, leave, closures and the same D1 collision/quote guards as the owner. Bookings arrive tagged **Online** in the timetable, day stats and detail view.
- **Smarter time finding (new):** "First available" barber option shows every open time across eligible barbers and assigns the least-booked one per slot; a **Soonest** strip jumps straight to the next 4 bookable days; the date strip shows open/low/full indicators; times are grouped Morning/Afternoon/Evening with counts; skeleton loading; details remembered on-device for repeat customers.
- **Waitlist (new):** fully booked days offer "Join the waitlist" (name, mobile, preferred part of day; upserts per phone/date/service). Owners see a Waitlist panel above the timetable, "Book them in" prefills the booking form and links the entry as BOOKED on save; "Close" dismisses.
- **Share confirmation (new):** appointment detail → "Share confirmation with customer" generates (and rotates) a manage link and a ready-to-send message with Copy / Open in SMS / Open in WhatsApp. Nothing is sent automatically.
- **Confirmation & manage pages:** Google Calendar, Apple/Outlook `.ics`, Directions and "Text myself the link" action tiles.
- **Owner stats:** "Chair time booked" utilisation % of rostered hours replaces the plain completed count (completed shown in the footnote).
- **Customer manage link:** each online booking returns a private `/manage/<token>` page (hashed token, no account) to view, move (same barber/service, own slot excluded) or cancel, with version guards, lead-time/window limits, late-change flagging against the snapshot cancellation policy, and an `.ics` calendar download. No message is sent; the link is shown once on the confirmation screen.
- **Customers directory (new):** owner/manager/reception see every customer grouped by mobile number with visits, completed, no-shows, completed value, last/next visit and search; barbers see only their own. Opening a customer lists full visit history and links into the appointment detail.

- Connected day timetable/mobile agenda, week-date navigation, selected-day filters/search, complete paginated day reads, keyboard slot navigation, labelled buffers and saved-record statistics (not collected revenue).
- Reviewed conflict-safe bookings/walk-ins, details/contact corrections, reschedule, cancellation/check-in/start/complete/no-show, immutable commercial snapshots and append-only audit.
- **Book again:** open a visit and choose Book again. Prefills customer/contact and available original barber/service, with 3/4/6-week date shortcuts. Creates a separate new booking with current prices; old notes/add-ons are not copied and the original record stays unchanged. An unavailable barber/service requires an explicit replacement.
- **Use first available time:** selects a valid start for the currently selected barber/date, not a shop-wide search or reservation. Closed dates never receive invented slots.
- Grouped booking forms, focused review showing customer details, From/To reschedule comparison, pinned Close/Confirm controls, and return to the saved destination date. Successful booking/move clears filters so its destination is visible.
- Dirty/pending appointment action-switch protection, existing protected modal dismissal, retained drafts on errors and safe booking request replay.
- Staff/service CRUD/activity, add-ons/eligibility, barber price/duration overrides, weekly hours/breaks, full-day leave, shop closures, dated replacement shifts and saved settings.

### Try it

Create a test workspace if needed → select a future working day → New booking → choose service/barber → Use first available time → fictional customer details → Review → Confirm. Open that appointment to **Book again** or **Reschedule**. Review before saving; no payment/message is created.

Phones use a single-column form; tablets/desktops use grouped columns where space permits. Narrow resource calendars scroll internally; Agenda remains available. Representative layouts include 320/390/768/1024/1440/1920px, 844×390 landscape and CSS 200% zoom checks. Automated browser checks are not certification of every physical device or screen reader. Exact latest test results are in [PROGRESS](docs/PROGRESS.md).

## Not implemented / next

Customer accounts (customers act through a per-booking manage link, not a login), automatic confirmations/reminders (owners share by hand), deposits/payments, recurring bookings and a customer-facing barber profile/rating remain unfinished. Local owner/staff accounts exist (register, invite, roles); Accounts is honest about being a local test adapter. Holds, live providers/payments/messages, financial ledger/pay-runs, installed/offline PWA, full week/month calendars, loyalty/memberships, retail/inventory/marketing, reporting and platform subscriptions are not claimed complete.

Next connected work: wider settings/navigation draft protection, then local account/membership/permission foundations for customer and barber journeys. Build-first: brief planning, working changes, tests, short handoff and commit—not repeated long planning documents. User's modern feature brief is [here](https://www.genspark.ai/api/files/s/sRhSuhAH); it guides backlog prioritisation and is not 100 completed features. Existing 189 requirement rows and original C/B/A IDs are retained; no new production acceptance is implied.

## Entry points

| Path | Purpose |
| --- | --- |
| `/`, `/workspace` | Main local owner-test app; root redirects here in sandbox mode |
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
| `/api/sandbox/customers`, `/customers/:phone` | GET grouped directory (`q`, `limit`) and per-customer history |
| `/preview/admin`, `/preview/book`, `/preview/barber` | Fixture references |
| `/api/health` | Mode/persistence capability, `livePayments:false` |
| `/api/sandbox/session` | POST creates/reuses isolated browser-owned shop |
| `/api/sandbox/workspace` | GET setup, legacy capped snapshot, audit and independent impact warnings |
| `/api/sandbox/bookings` | GET requires `date`, optional `limit` 1–200, `staff_id`, `status`, paired `cursor_start`/`cursor_id`; POST creates reviewed idempotent booking |
| `/api/sandbox/bookings/:id` | GET authorized details; PATCH `/:id/details`, POST `/:id/reschedule` and `/:id/status` are versioned/audited |
| `/api/sandbox/availability` | GET `date`, `staff_id`, `service_id`, optional `addon_ids` and reschedule `booking_id`; no holds |
| `/api/sandbox/shop` | PUT versioned settings |
| `/api/sandbox/staff`, `/services`, `/addons`, `/holidays` | Existing sandbox-scoped CRUD; full route inventory in source/tests |
| `/api/sandbox/staff/:id/hours`, `/days-off`, `/overrides`, `/services/:serviceId` | Existing schedule, leave and eligibility/individual-price operations |

## Data, safety and local development

Hono + React + TypeScript + Vite; Cloudflare Pages-compatible Worker with **local D1**, Wrangler and PM2 on port 3000. All project code: `/home/user/webapp`, branch `main`.

D1 persists shops, hashed sandbox sessions, staff/catalogue/add-ons/rules, hours/leave/overrides/closures, bookings and immutable audit. Booking `items_json` preserves service/add-on price/duration snapshots; integer-pence prices and exact durations plus ten-minute buffer. London timezone only. Complete day reads follow cursors; legacy workspace cap and audit pagination/scalable impact work remain documented limitations.

Tenant scope is server-derived from a seven-day capability cookie (HttpOnly/Secure/SameSite=Strict), not production identity. API requires local `APP_MODE=sandbox`, D1 and matching mutation Origin. D1 transactions guard overlap, schedule/eligibility/quote and history. Only booking creation has request-key replay; inspect other interrupted writes before repeating. No real personal data, offline write queue or lost-cookie recovery.

Seven migrations now exist, including both distinct `0002_*` files; `0005_local_accounts` and `0006_public_booking` (shop slug/online flags, booking `channel`/`email`, `booking_manage_tokens`) and `0007_waitlist` (`waitlist_entries`). Next prefix 0008. For fresh local start: build, then `pm2 start ecosystem.config.cjs` after freeing port 3000. Run `npm test` against the service; never build/migrate during tests. Keep `.dev.vars` and local data ignored.

**Nothing live:** no deployment/provider activation/charges/messages/transfers/public GitHub push. Model A remains: each shop receives haircut money; owners pay barbers externally. Future manual pay-runs calculate/export/record, not hold a wallet or initiate barber transfers. SaaS subscription money is separate.

Older [build plans](docs/BUILD_PLAN.md), [decisions](docs/DECISIONS.md), [design](docs/DESIGN_SYSTEM.md), [quality gates](docs/QUALITY_GATES.md) and [feature register](docs/FEATURE_REGISTER.csv) remain references. Latest source/test state and short next-step handoff take precedence over historical pauses/counts.
