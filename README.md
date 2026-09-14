# Barbershop OS

Multi-tenant barbershop SaaS in development: customer booking, shop administration, barber PWA, shop-owned payments and manual pay-runs.

## Current status

**Local functionality, not a live SaaS.** Continuing from `c8abf5c`; no restart, recolouring or deployment. The current matte forest/sage palette and rounded components are unchanged.

`/workspace` saves fictional test records in local Cloudflare D1:
- Isolated browser-owned shop with editable example staff/services; no seeded appointments or payments.
- Shop settings, opening hours, closures, weekly staff shifts/breaks and full-day leave.
- **Add-on catalogue:** create/edit/deactivate, price, extra minutes and eligible service links.
- **Barber service rules:** enable/disable coverage and override price/duration; blank overrides inherit catalogue defaults.
- **Dated hours:** create/edit/remove a partial-day shift and break, replacing that day's weekly template. Closures and full-day leave still win.
- Authoritative itemized quotes; add-ons recheck exact total duration and clear stale slot selections. Catalogue/rule changes invalidate old quote versions.
- Reviewed/idempotent test bookings and walk-ins, day lists, search/status filters and contact/notes corrections.
- Atomic reschedule, cancellation, check-in, in-service, completion and grace-checked no-show; affected-booking warnings and append-only audit.
- Immutable service/add-on item snapshots, stored atomically with the booking. History is not repriced on edits or moves.
- In-page network/proxy retry, preserved draft inputs, stale-editor refresh and duplicate-safe booking replay after interrupted responses.

Original `/preview/admin`, `/preview/book` and `/preview/barber` remain separate fixture-only screens. Their checkout and finance controls are not connected to this database.

## Using the new controls

1. **Services → Add add-on:** set the price and extra minutes, select eligible services and save.
2. **Team → Services & pricing:** configure one service at a time. Each named Save button saves that service's rule and closes the dialog. Unset rules allow the service at catalogue values; blank price/duration overrides restore defaults.
3. **Team → Dated hours:** choose a date and replacement shift/break. Equal break times mean no break. Edit or remove a saved override from the same list.
4. **Appointments → New booking:** select barber/service and optional add-ons, then choose a newly checked slot. Review itemized prices and confirm. Existing booking details retain the original line items after catalogue changes.

Prices are integer pence; add-on durations are 0–120 minutes, with at most ten unique add-ons per booking. Start times are on a 15-minute grid; durations are summed exactly, not rounded. A ten-minute buffer follows the entire appointment. Zero price overrides are allowed. These are local test policies, not final commercial financial terms.

## Remaining work

Server-paginated booking/admin queries, connected customer and assigned-barber test interfaces, managed identity/MFA/invites, public shop routing and customer portal, checkout holds/expiry, Stripe, notifications, cash/tips/ledger/refunds, reports/pay-runs, subscriptions/platform console and installable/offline PWA remain incomplete or unimplemented. No production roles or payment outcomes are implied by this slice.

Next package: remove the latest-500 booking display limitation through tenant-scoped paginated/day queries, then connect customer/barber test surfaces to the same authoritative APIs. Add checkout holds only with concurrency/expiry/late-confirmation tests. Do not deploy or activate providers.

## Entry points

Local: `http://localhost:3000/workspace`, also available through the project's temporary development Preview. Production URL: **none**.

| URI | Behaviour |
| --- | --- |
| `/` | `/workspace` in sandbox mode; otherwise `/preview/admin` |
| `/workspace` | Persisted local test workspace |
| `/preview/admin`, `/preview/book`, `/preview/barber` | Fixture-only design experiences |
| `/api/health` | Mode, persistence capability, `livePayments:false` |
| `POST /api/sandbox/session` | Create/reuse browser-owned workspace |
| `GET /api/sandbox/workspace` | Shop/setup/catalogue/rules/overrides, latest 500 bookings and 200 audit events |
| `PUT /api/sandbox/shop` | Versioned settings |
| `POST /api/sandbox/staff`, `PUT /api/sandbox/staff/:id` | Create/edit/deactivate staff |
| `PUT /api/sandbox/staff/:id/hours` | Seven-day schedule |
| `POST /api/sandbox/staff/:id/days-off`, `DELETE /api/sandbox/staff/:id/days-off/:leaveId` | Full-day leave |
| `PUT /api/sandbox/staff/:id/services/:serviceId` | Eligibility and price/duration rule; version 0 creates, current version updates |
| `POST /api/sandbox/staff/:id/overrides` | Create dated replacement hours |
| `PUT /api/sandbox/staff/:id/overrides/:overrideId`, `DELETE /api/sandbox/staff/:id/overrides/:overrideId` | Edit/remove dated hours |
| `POST /api/sandbox/services`, `PUT /api/sandbox/services/:id` | Create/edit/deactivate services |
| `POST /api/sandbox/addons`, `PUT /api/sandbox/addons/:id` | Create/edit/deactivate add-on with `service_ids` links |
| `POST /api/sandbox/holidays`, `DELETE /api/sandbox/holidays/:id` | Shop closures |
| `GET /api/sandbox/availability` | `date`, `staff_id`, `service_id`, optional comma-separated `addon_ids`, optional `booking_id` for original snapshot quote; `holds:false` |
| `POST /api/sandbox/bookings` | Save/replay; request UUID, quote versions and optional unique `addon_ids` array |
| `GET /api/sandbox/bookings/:id` | Tenant-scoped detail with immutable `items_json` |
| `PATCH /api/sandbox/bookings/:id/details` | Versioned contact/notes correction, reason required |
| `POST /api/sandbox/bookings/:id/reschedule`, `POST /api/sandbox/bookings/:id/status` | Versioned/audited lifecycle operations |

## Data and safety

D1 tables: shops, sandbox_sessions, staff, staff_hours, staff_days_off, staff_schedule_overrides, services, addons, addon_services, staff_service_rules, bookings and audit_events. The `0004_catalogue_and_dated_hours.sql` migration preserves existing bookings as one service item; new bookings store all item snapshots in the same row/write as their interval allocation.

Tenant-aware foreign keys, strict input schemas and transactional SQLite triggers enforce overlap, hours/leave/closures, eligibility, quote freshness, item sums and immutable snapshots. Add-on/link/rule edits increment the shop quote version in the same transaction. UI availability alone is not the booking lock. Rescheduling preserves the original itemized commercial terms but checks current staff eligibility and schedule.

Sessions use random capabilities, SHA-256 hashes in D1 and HttpOnly/Secure/SameSite=Strict cookies, expiring after seven days. **Test workspace ownership is not verified production identity or role authorization.** Shop scope is server-derived; matching Origin is required for mutations. Every sandbox endpoint fails closed without D1 and local `APP_MODE=sandbox`.

`.dev.vars`, `.wrangler/` and test artifacts are ignored. The database ID is a local placeholder. No real customer information belongs here. There is no offline write queue, private offline cache or recovery after losing the cookie. Only booking creation has payload-bound request-key idempotency; inspect refreshed records before retrying other interrupted creates.

London timezone only; DST gaps/repeated local times are rejected. Completion records service status, never payment. Model A is unchanged: shops ultimately collect customer payments directly; owners pay barbers externally. Future pay-runs calculate/export/record, not execute bank transfers or hold a wallet. SaaS billing is separate.

## Local setup and verification

Project `/home/user/webapp`, branch `main`.

1. Set `APP_MODE="sandbox"` in ignored `.dev.vars` only.
2. Run `npm run db:migrate:local` before building code that uses new tables. Never `--remote` for this work.
3. Stop the old port-3000/PM2 instance, run `npm run build`, then `pm2 start ecosystem.config.cjs`.
4. Verify `curl http://localhost:3000/api/health` and open `/workspace`.
5. Use fictional data. Run `npm test` with the service running: TypeScript, unit/route tests, direct local D1 invariants and Playwright API/browser tests.

Latest gate: **42 unit/route/domain tests, direct-D1 guards and 54 browser/API tests passed**, including the original recovery/regression suite and all 21 mutation route boundaries. Fresh local migration bootstrap also passed; dependency audit reported zero vulnerabilities. See [PROGRESS](docs/PROGRESS.md) for the exact report, screenshot evidence and limitations.

Network errors recover through **Retry workspace** / **Retry availability**. A successful save followed by a failed read must retry the read, not the saved operation. **Discard edits and load latest** explicitly replaces stale form contents. Test artifacts live under `test-results/runs/<run-id>/`; never share a run ID between concurrent invocations or migrate/build while tests run. Automated axe scans are not complete WCAG/device certification.

## Project playbook

[Session instructions](AGENTS.md) · [Build plan](docs/BUILD_PLAN.md) · [Progress](docs/PROGRESS.md) · [Decisions](docs/DECISIONS.md) · [189-row register](docs/FEATURE_REGISTER.csv) · [Design standards](docs/DESIGN_SYSTEM.md) · [Quality gates](docs/QUALITY_GATES.md)

## Publication and deployment

No production deployment, live credentials, real messages, charges or transfers. Selected GitHub repository: https://github.com/BreezeCreative26/NEW-Barber-System-App-PRoject. Previously public/empty; no push or visibility change authorized. Recheck and obtain publication consent before syncing. Local commits and project auto-backup preserve work without publishing to that repository.
