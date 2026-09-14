# Barbershop OS

Multi-tenant barbershop SaaS in development: customer booking, shop administration, barber PWA, shop-owned payments and manual pay-runs.

## Current status

**Working local preview, not a deployed commercial SaaS.** The original-style calendar is now connected to the persisted local database at `/workspace`. Matte forest/sage colours and rounded components are retained. All existing staff, services, add-ons, pricing, schedules, settings and booking controls remain available in that same app.

Development preview: https://3000-iz3aw7n21l3edjgvt4bkj-5c13a017.sandbox.novita.ai/workspace

Local: http://localhost:3000/workspace. The HTTPS URL is temporary sandbox access, not a production deployment. Existing browser cookies retain access to that browser's test shop. New browsers create separate fictional shops; no saved bookings are seeded into a new workspace.

## What works now

- Original-style day timetable and mobile agenda with a seven-day date strip, date navigation, staff/status/search filters and real selected-day statistics. Booked service value is not collected revenue.
- Click a free 15-minute timetable cell to start a booking draft with barber/time. Service, extras and buffer are checked by the authoritative availability API; a click is not a reservation.
- Saved test bookings and walk-ins, itemized review, immutable price/duration/items, appointment details, contact corrections, reschedule, cancellation, check-in/start/complete/no-show and audit.
- Complete paginated selected-day reads rather than the old 500-record display window. Future schedule-impact warnings read independently and can open off-day appointments by authorized ID.
- Staff/service create/edit/deactivate/reactivate; add-on catalogue with eligibility links; individual barber service eligibility and price/duration overrides.
- Weekly shifts/breaks, full-day leave, shop closures and dated replacement shifts/breaks; saved shop settings and basic policy values.
- Pricing rules save individually without closing the editor or losing other rows' drafts. Empty override inherits catalogue values; zero is a valid explicit price.
- Workspace dialogs protect unsaved Escape/backdrop/Close and refuse close while saving. Network/proxy failures retry in place; lost booking responses replay safely; malformed workspace arrays/render failures have recovery.
- Accounts section explicitly shows what remains unconnected. It is not a sign-in screen and collects no passwords.

Original `/preview/admin`, `/preview/book` and `/preview/barber` remain **fixture-only design references**. Customer/barber references still do not save real appointments or payments. They are not alternative production apps.

## Try the connected workflow

1. Open the development preview; create a **test workspace** if this browser has no session. Use fictional details only.
2. Select a future working date. Desktop defaults to **Day timetable**; mobile defaults to **Agenda**, with a timetable switch available.
3. Click a free cell, select the service/extras, enter fictional customer details, review and confirm. The service must fit the available interval including its buffer.
4. Click the appointment to inspect it, reschedule, correct details or change status. Cancellation requires a reason; no refund/payment is implied.
5. Open **Team** for profiles, individual services/pricing, weekly hours, days off and dated hours. Open **Services** for catalogue/add-ons; **Settings** for shop policies and closures.
6. In multi-service pricing, save each changed service. Other drafts stay open; use Close only after saving, or explicitly discard them.

Prices are integer pence. Add-ons allow 0–120 extra minutes and up to ten unique items per booking. Start grid is 15 minutes, occupancy is exact duration plus a ten-minute buffer. These are local test defaults, not finalized commercial policies.

## What is not yet built

- Customer sign-up/sign-in, admin/staff accounts, memberships, invitation lifecycle, real role permissions, MFA and recovery.
- Connected customer/barber operational journeys, public shop routing and verified customer portal/history.
- Checkout holds/expiry, Stripe/provider integrations, messages/reminders, cash/tips/ledger/refunds/receipts and manual pay-runs.
- Full week/month resource calendar, drag/drop, shop-wide/date-range search and independently paginated audit UI.
- Installed/offline PWA, reviews, subscription billing/entitlements and platform-owner console.
- Production security/privacy/monitoring/restore/device acceptance.

Next requested build: **WP-LOCAL-04 — working local test accounts and server-enforced permissions**, beginning with owner account/session lifecycle and migration of the existing browser-owned shop, then staff invitations/assigned accounts and customer ownership. See [BUILD_PLAN section 13](docs/BUILD_PLAN.md#13-active-delivery-and-accountpermission-build-sequence). No fake role switch or preview mock user may authorize customer/barber records.

Remaining quality work includes full nested response validation, settings/navigation draft protection, scalable impact evaluation, detailed audit metadata and final early/backdated completion policy. Do not infer all audit findings are closed from the calendar delivery.

## Entry points

| URI | Behaviour |
| --- | --- |
| `/` | Redirects to `/workspace` in sandbox mode; otherwise fixture admin |
| `/workspace` | Connected local owner-test calendar and shop setup |
| `/preview/admin`, `/preview/book`, `/preview/barber` | Fixture-only design references |
| `/api/health` | Configured mode/persistence capability; `livePayments:false` |
| `POST /api/sandbox/session` | Create/reuse browser-owned test shop |
| `GET /api/sandbox/workspace` | Setup/catalogue, legacy 500-booking snapshot, 200 audit events and independently evaluated future impact warnings |
| `GET /api/sandbox/bookings` | Required `date`; optional `limit` (1–200), `staff_id`, `status`; paired `cursor_start` and `cursor_id`. Returns `bookings` and `next_cursor` |
| `PUT /api/sandbox/shop` | Versioned shop/settings update |
| `POST /api/sandbox/staff`, `PUT /api/sandbox/staff/:id` | Staff create/edit/activity |
| `PUT /api/sandbox/staff/:id/hours` | Weekly schedule |
| `POST /api/sandbox/staff/:id/days-off`, `DELETE /api/sandbox/staff/:id/days-off/:leaveId` | Full-day leave |
| `PUT /api/sandbox/staff/:id/services/:serviceId` | Versioned eligibility and price/duration override |
| `POST /api/sandbox/staff/:id/overrides`, `PUT /api/sandbox/staff/:id/overrides/:overrideId`, `DELETE /api/sandbox/staff/:id/overrides/:overrideId` | Dated replacement shifts |
| `POST /api/sandbox/services`, `PUT /api/sandbox/services/:id` | Catalogue create/edit/activity |
| `POST /api/sandbox/addons`, `PUT /api/sandbox/addons/:id` | Add-ons and `service_ids` eligibility links |
| `POST /api/sandbox/holidays`, `DELETE /api/sandbox/holidays/:id` | Shop closures |
| `GET /api/sandbox/availability` | `date`, `staff_id`, `service_id`, optional comma-separated `addon_ids`, optional `booking_id` for reschedule snapshot; `holds:false` |
| `POST /api/sandbox/bookings` | Payload-bound request UUID, quote versions and optional unique add-on IDs |
| `GET /api/sandbox/bookings/:id` | Tenant-scoped detail |
| `PATCH /api/sandbox/bookings/:id/details` | Versioned correction with reason |
| `POST /api/sandbox/bookings/:id/reschedule`, `POST /api/sandbox/bookings/:id/status` | Versioned/audited appointment operations |

Day read cursors provide deterministic ordering, not an immutable cross-page snapshot under concurrent edits. Refresh rechecks current records. The legacy workspace booking cap is retained for compatibility but is not the main calendar data source. Future impact evaluation is complete for current records but still needs measured scale optimization.

## Data and security

Stack: Hono/React/TypeScript/Vite, local Cloudflare D1, Wrangler and PM2. No new dependency or schema migration in the connected-calendar slice.

D1 tables: shops, sandbox_sessions, staff, staff_hours, staff_days_off, staff_schedule_overrides, services, addons, addon_services, staff_service_rules, holidays, bookings and audit_events. Booking `items_json` contains immutable service/add-on snapshots. Existing five migration files remain applied; the next migration prefix is 0005. Do not rename the two distinct 0002 files.

Shop scope comes from a hashed random capability with HttpOnly/Secure/SameSite=Strict cookie and seven-day expiry. Every API fails closed without local `APP_MODE=sandbox` and DB binding; mutation Origin must match. This is **not production identity or staff/customer role authorization**. SQLite write-time guards protect overlaps, hours, eligibility, quote/item values and historical snapshots. Only booking creation has request-key replay; check records before repeating other interrupted creates.

London timezone only. Offline views are not a private cache or write queue. No recovery after losing the current browser cookie exists yet. Do not enter real personal/sensitive data.

Model A: each shop ultimately receives customer money; owners pay barbers externally. The app will calculate/export/record manual pay-runs, not hold a wallet or initiate bank transfers. SaaS subscription money is separate.

## Local development and verification

Project: `/home/user/webapp`, branch `main`.

1. Keep `APP_MODE="sandbox"` in ignored `.dev.vars` only.
2. Apply local migrations when needed: `npm run db:migrate:local` (never remote for this work).
3. For a fresh service start: stop the old PM2/port-3000 process, run `npm run build`, then `pm2 start ecosystem.config.cjs`.
4. Verify `/api/health`; run `npm test` with the local service available.

Connected calendar verification: build, 42 unit/route/domain tests, direct D1 checks and 60 browser/API cases passed in the final unchanged-source regression; dependency audit reported zero vulnerabilities. The exact 13:24 UTC report is recorded in [PROGRESS](docs/PROGRESS.md). New coverage includes 503 records, cursor ties/tenant boundaries, timetable create/reload/move/cancel, multi-row drafts and response recovery. Existing five-size layout and fixture preview tests remain. Automated Chromium/axe checks are not full real-device/WCAG/security certification.

Build/migration must not run during tests. Artifacts use unique `test-results/runs/<run-id>/` directories. `.dev.vars`, local databases, dependencies and generated traces remain ignored.

## Project records

[Build plan](docs/BUILD_PLAN.md) · [Progress/handoff](docs/PROGRESS.md) · [Decisions](docs/DECISIONS.md) · [Feature register](docs/FEATURE_REGISTER.csv) · [Design](docs/DESIGN_SYSTEM.md) · [Quality gates](docs/QUALITY_GATES.md) · [Session instructions](AGENTS.md)

All 189 requirements and 125 original C/B/A IDs remain. Local calendar progress does not mark the production SaaS complete.

## Deployment

No production deployment, provider activation, real charges/messages/transfers or public GitHub push. Selected GitHub repo remains https://github.com/BreezeCreative26/NEW-Barber-System-App-PRoject; publication/visibility must be checked and authorized before pushing. Local commits and project backup preserve the work.
