# Barbershop OS

Multi-tenant barbershop SaaS in development: customer booking, shop administration, barber PWA, shop-owned payments and manual pay-runs.

## Current status

**Working local preview, not a deployed commercial SaaS.** E1 enhances the original-style calendar connected to local D1 at `/workspace`. Matte forest/sage colours, rounded components and all existing shop setup and saved booking controls are retained in one app.

Development preview: https://3000-iz3aw7n21l3edjgvt4bkj-5c13a017.sandbox.novita.ai/workspace

Local: http://localhost:3000/workspace. The HTTPS URL is temporary sandbox access, not production. Existing browser cookies retain that browser's test shop. New browsers create separate fictional shops; no saved bookings are seeded into a new workspace.

## What works now

- Original-style day timetable and mobile agenda, seven-day date strip and real selected-day statistics. Booked service value is not collected revenue.
- E1 groups date navigation, Day/Agenda, New booking and barber/status/search controls in one calendar panel. Search scope is selected-day only; Clear filters explicitly resets filters without changing date/view.
- Clearer time/name/service/status cards, consistent barber colours under filtering, labelled exact buffer bands and past/break/leave/closure states. Hidden appointment cards still occupy time.
- Keyboard slot navigation: one free-slot tab stop per barber; arrows move between free cells/barbers, Home/End jump within a barber, Enter/Space opens a draft, Tab reaches appointment buttons/exits. Untouched dialog Escape returns focus. Focus navigation never saves/reserves.
- Click a free 15-minute start cell to draft a booking. Its starting barber/date/time stays visible in the form as historical context. Service, extras and buffer are checked by the authoritative availability API; a click is not a reservation.
- Saved test bookings/walk-ins, itemized review, immutable price/duration/items, appointment details, contact corrections, reschedule, cancellation, check-in/start/complete/no-show and audit.
- Complete paginated selected-day reads instead of the old 500-record display window. Future schedule-impact warnings read independently and open off-day appointments by authorized ID.
- Staff/service create/edit/deactivate/reactivate; add-on catalogue with eligibility links; individual barber eligibility and price/duration overrides.
- Weekly shifts/breaks, full-day leave, shop closures and dated replacement shifts/breaks; saved shop settings and basic policy values.
- Pricing rules save individually without losing other drafts. Empty override inherits catalogue; zero is an explicit price.
- Workspace dialogs protect unsaved Escape/backdrop/Close and refuse close while saving. Network/proxy failures retry in place; lost booking responses replay safely; malformed workspace arrays/render failures have recovery.
- Accounts honestly describes unfinished access. It is not authentication and collects no passwords.

Original `/preview/admin`, `/preview/book` and `/preview/barber` remain **fixture-only design references**, not alternative production apps or connected customer/barber journeys.

## Try the connected workflow

1. Open the preview; create a **test workspace** if there is no browser session. Use fictional details only.
2. Choose a future working date. Desktop defaults to **Day timetable**, mobile to **Agenda**. The timetable deliberately scrolls horizontally on narrow screens.
3. Click a free cell or use keyboard slot navigation, choose service/extras, enter fictional customer details, review and confirm. The whole service plus buffer must fit.
4. Open the saved appointment to inspect, reschedule, correct details or change status. Cancellation requires a reason; no refund/payment is implied.
5. Use **Team** for profiles, pricing, weekly hours, days off and dated hours; **Services** for catalogue/add-ons; **Settings** for policies/closures; **Audit** for recorded activity.
6. Save each edited pricing rule individually, then close or explicitly discard remaining changes.

Prices are integer pence. Add-ons allow 0–120 extra minutes and up to ten unique items. Start grid is 15 minutes; occupancy is exact service duration plus ten-minute buffer. Calendar spacing is 44px per 15 minutes; five-minute cards retain a 24px minimum with full details/agenda alternatives, not a claim that every dense card meets a 44px touch target. These are local test defaults, not finalized commercial policies.

## What is not yet built

- Customer sign-up/sign-in, admin/staff accounts, memberships, invitations, real role permissions, MFA and recovery.
- Connected customer/barber operational journeys, public shop routing and verified customer portal/history.
- Checkout holds/expiry, Stripe/providers, messages/reminders, cash/tips/ledger/refunds/receipts and manual pay-runs.
- Full week/month resource calendar, drag/drop, shop-wide/date-range search and independently paginated audit UI.
- Installed/offline PWA, reviews, subscription billing/entitlements and platform-owner console.
- Production security/privacy/monitoring/restore/device acceptance.

**Next:** review E1, then E2 appointment/review/detail/reschedule clarity and wider settings/navigation draft safety. E3–E5 cover catalogue/schedules, settings/activity/performance and acceptance. See BUILD_PLAN section 14. D-018 supersedes D-017's earlier pause, not the local-only boundary.

Section 13 retains the separate WP-LOCAL-04 account/session/permission roadmap. No fake role switch or preview mock user may authorize customer/barber records. Full nested response validation, scalable impact evaluation, audit metadata and early/backdated completion policy remain outstanding.

## Entry points

| URI | Behaviour |
| --- | --- |
| `/` | Redirects to `/workspace` in sandbox mode; otherwise fixture admin |
| `/workspace` | Connected local owner-test calendar and shop setup |
| `/preview/admin`, `/preview/book`, `/preview/barber` | Fixture-only references |
| `/api/health` | Mode/persistence capability; `livePayments:false` |
| `POST /api/sandbox/session` | Create/reuse browser-owned test shop |
| `GET /api/sandbox/workspace` | Setup/catalogue, legacy 500-booking snapshot, 200 audit events and independent future impact warnings |
| `GET /api/sandbox/bookings` | Required `date`; optional `limit` (1–200), `staff_id`, `status`; paired `cursor_start`/`cursor_id`; returns `bookings` and `next_cursor` |
| `PUT /api/sandbox/shop` | Versioned settings |
| `POST /api/sandbox/staff`, `PUT /api/sandbox/staff/:id` | Staff create/edit/activity |
| `PUT /api/sandbox/staff/:id/hours` | Weekly schedule |
| `POST /api/sandbox/staff/:id/days-off`, `DELETE /api/sandbox/staff/:id/days-off/:leaveId` | Full-day leave |
| `PUT /api/sandbox/staff/:id/services/:serviceId` | Eligibility/price/duration override |
| `POST /api/sandbox/staff/:id/overrides`, `PUT /api/sandbox/staff/:id/overrides/:overrideId`, `DELETE /api/sandbox/staff/:id/overrides/:overrideId` | Dated replacement shifts |
| `POST /api/sandbox/services`, `PUT /api/sandbox/services/:id` | Service catalogue |
| `POST /api/sandbox/addons`, `PUT /api/sandbox/addons/:id` | Add-ons and `service_ids` eligibility links |
| `POST /api/sandbox/holidays`, `DELETE /api/sandbox/holidays/:id` | Shop closures |
| `GET /api/sandbox/availability` | `date`, `staff_id`, `service_id`, optional comma-separated `addon_ids`, optional `booking_id` for reschedule; `holds:false` |
| `POST /api/sandbox/bookings` | Payload-bound request UUID, quote versions, optional unique add-on IDs |
| `GET /api/sandbox/bookings/:id` | Tenant-scoped detail |
| `PATCH /api/sandbox/bookings/:id/details` | Versioned correction with reason |
| `POST /api/sandbox/bookings/:id/reschedule`, `POST /api/sandbox/bookings/:id/status` | Versioned/audited operations |

Day cursors give deterministic ordering, not an immutable concurrent snapshot. Refresh rechecks records. Legacy workspace cap remains for compatibility but is not the main calendar source. Future impact evaluation is complete but needs measured scale optimization.

## Data and security

Stack: Hono/React/TypeScript/Vite, local Cloudflare D1, Wrangler and PM2. E1 adds no dependencies, API/schema changes or migrations.

D1 tables: shops, sandbox_sessions, staff, staff_hours, staff_days_off, staff_schedule_overrides, services, addons, addon_services, staff_service_rules, holidays, bookings and audit_events. Booking `items_json` holds immutable service/add-on snapshots. Five migrations remain applied; next prefix is 0005. Do not rename the two distinct 0002 files.

Shop scope comes from a hashed random capability with HttpOnly/Secure/SameSite=Strict cookie and seven-day expiry. API fails closed without local `APP_MODE=sandbox` and DB binding; mutation Origin must match. This is **not production identity or staff/customer authorization**. D1 write-time guards protect overlaps, schedules, eligibility, quote/items and historical snapshots. Only booking creation supports request-key replay; inspect records before repeating other interrupted creates.

London timezone only. No private offline cache/write queue or lost-cookie recovery. Do not enter real personal/sensitive data.

Model A: each shop ultimately receives haircut money; owners pay barbers externally. Future manual pay-runs calculate/export/record, not hold a wallet or initiate bank transfers. SaaS subscription money is separate.

## Local development and verification

Project: `/home/user/webapp`, branch `main`.

1. Keep `APP_MODE="sandbox"` in ignored `.dev.vars` only.
2. Apply local migrations when needed: `npm run db:migrate:local` (never remote for this work).
3. For a fresh service start: stop old PM2/port-3000 process, run `npm run build`, then `pm2 start ecosystem.config.cjs`.
4. Verify `/api/health`; run `npm test` with the local service available.

**E1 final verification (2026-09-14):** build/typecheck, 42 unit/route/domain tests, direct D1 checks and **68 browser/API cases passed on unchanged source**, zero failed/skipped/flaky. Dependency audit: zero reported vulnerabilities. Report `test-results/runs/1789394389773-60993/results.json`, 13:59:49.778 UTC. Eight new cases cover keyboard/focus/no mutation, filters/colour/hidden occupancy, unavailable states and populated five-width layouts with short/long cards, axe and CSS 200% zoom. Earlier 503-record, booking lifecycle, recovery, fixture and tenant regressions remain green.

Actual final-source desktop/mobile screenshots inspected and preserved in `docs/evidence/e1-*`; prior `connected-*` images retained for comparison. HTTPS preview creation, calendar controls and booking dialog also browser-tested without page errors. Automated Chromium/axe/CSS zoom checks are not physical-device, screen-reader, WCAG or production security certification.

Do not build/migrate during tests. Independent inspection and verification may run in parallel; shared source changes require coordinated integration. Artifacts use unique `test-results/runs/<run-id>/` directories. Vars/databases/dependencies/traces remain ignored.

## Project records

[Build plan](docs/BUILD_PLAN.md) · [Progress](docs/PROGRESS.md) · [Decisions](docs/DECISIONS.md) · [Feature register](docs/FEATURE_REGISTER.csv) · [Design](docs/DESIGN_SYSTEM.md) · [Quality gates](docs/QUALITY_GATES.md) · [Session instructions](AGENTS.md)

189 unique requirements: 53 implementing, 136 not_started; original 125 C/B/A IDs retained. No production-verified/accepted features are claimed; partial requirements are not a completion percentage.

## Deployment

No production deployment, live providers, real charges/messages/transfers or public GitHub push. Selected GitHub repo remains https://github.com/BreezeCreative26/NEW-Barber-System-App-PRoject; publication/visibility must be authorized before pushing. Local commits and project backup preserve work.
