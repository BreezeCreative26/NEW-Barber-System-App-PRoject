# Barbershop OS

Multi-tenant barbershop SaaS in development: customer booking, shop administration, barber PWA, shop-owned payments and manual pay-runs.

## Verified local functionality

**Local development only — not a live or complete SaaS.** D-012 preserves the matte forest/sage palette and rounded components. The planned recolouring is cancelled.

`/workspace` saves fictional test records in local Cloudflare D1:
- Browser-owned isolated shop with two example barbers, three services and empty appointments.
- Shop profile, opening hours, closed weekdays and provisional deposit/cancellation/no-show policies.
- Staff create/edit/deactivate/reactivate, weekly shifts and lunch breaks; team search/status filters.
- Services, categories, integer-pence prices and durations; catalogue search/status filters.
- Dated shop closures and warnings for affected future appointments.
- Server availability and reviewed test bookings/walk-ins, shop references and retry-safe booking submission.
- Appointment day/staff/status/search filters, contact/notes correction, atomic reschedule, cancellation, check-in, start, completion and grace-checked no-show.
- Immutable booking snapshots, reviewed service/shop version guards and append-only attributed audit.
- In-page workspace/availability retry, reconnect refresh, preserved form entries and explicit stale-editor recovery.

A successful save followed by a failed refresh is clearly distinguished from a failed save. Booking response loss can be retried with the same request key without duplication. Non-booking create operations are not yet idempotent: after an interrupted save response, refresh and inspect the saved records before repeating the create.

The original `/preview/admin`, `/preview/book` and `/preview/barber` remain separate fixture-based experiences. Their checkout and finance controls are not connected to this database.

## Latest verification — 2026-09-14

`npm run build && npm run test` passed:
- TypeScript and **36 unit/route/domain tests**.
- Direct local D1 checks: overlap and quote rejection, immutable snapshots/audit, atomic rollback, closure enforcement and elapsed no-show grace.
- **45 browser/API tests**, zero failed/skipped/flaky, including all 13 mutation endpoint origin/session boundaries, saved/reload booking regression, interrupted-response recovery and staff/service reactivation.
- Workspace/preview layouts at 320, 390, 768, 1024 and 1440px; tested axe scans had no violations. This is not full WCAG or real-device certification.
- Dependency audit reported zero vulnerabilities.

Playwright artifacts and JSON reports are isolated under `test-results/runs/<run-id>/` so one invocation cannot delete another's `.network`/`.trace` files. See [PROGRESS](docs/PROGRESS.md) for the exact report path and handoff.

## User guide

1. Open `/workspace` in the development Preview and create a test shop using fictional details.
2. Edit Team, Services, weekly hours and Settings. Changes are stored in local D1.
3. Select an appointment date, choose New booking, choose staff/service/time, enter fictional contact details, review and confirm.
4. Open the saved row to correct details, reschedule or change its service status. Inspect Audit for recorded operations.
5. If connection fails, use **Retry workspace** or **Retry availability**. Do not reload the page or repeat an already-confirmed save. A stale dialog provides **Discard edits and load latest**.

No payment, message, subscription or bank transfer is created by any of these actions.

## Routes

Local entry: `http://localhost:3000/workspace`. Production URL: **none — not deployed**. The temporary sandbox Preview is a development service.

| URI | Behaviour |
| --- | --- |
| `/` | Workspace redirect with sandbox flag; otherwise admin preview |
| `/workspace` | Persisted local test workspace |
| `/preview/admin`, `/preview/book`, `/preview/barber` | Original fixture-only interfaces |
| `/api/health` | Mode, persistence capability and `livePayments:false` |
| `POST /api/sandbox/session` | Create/reuse this browser's isolated test workspace |
| `GET /api/sandbox/workspace` | Shop, staff, services, hours, closures, latest 500 bookings and 200 audit events |
| `PUT /api/sandbox/shop` | Versioned shop settings |
| `POST /api/sandbox/staff`, `PUT /api/sandbox/staff/:id` | Staff create/edit/deactivate |
| `PUT /api/sandbox/staff/:id/hours` | Versioned seven-day schedule |
| `POST /api/sandbox/services`, `PUT /api/sandbox/services/:id` | Service create/edit/deactivate |
| `POST /api/sandbox/holidays`, `DELETE /api/sandbox/holidays/:id` | Dated closures |
| `GET /api/sandbox/availability` | `date`, `staff_id`, `service_id`, optional `booking_id`; versioned quote, no hold |
| `POST /api/sandbox/bookings` | Save/replay test booking; reviewed quote versions and request UUID required |
| `GET /api/sandbox/bookings/:id` | Tenant-scoped detail |
| `PATCH /api/sandbox/bookings/:id/details` | Versioned contact/notes correction; audit reason required |
| `POST /api/sandbox/bookings/:id/reschedule` | Versioned atomic move; reason required |
| `POST /api/sandbox/bookings/:id/status` | Validated, audited lifecycle transition |

## Data and access boundaries

All authoritative test records use local D1. Entities: shops, sandbox_sessions, staff, staff_hours, services, holidays, bookings and audit_events. Tenant composite foreign keys, transactional interval triggers and immutable snapshots protect writes; availability feedback alone is not a reservation lock.

Random capability tokens are hashed in D1 and carried in HttpOnly, Secure, SameSite=Strict cookies with seven-day expiry. This is **browser-owned test access, not verified production identity**. Tenant/actor scope comes from the server session; supplied tenant/price fields are rejected. Mutations require matching Origin. All functional endpoints fail closed unless a D1 binding and `APP_MODE=sandbox` exist.

`.dev.vars`, `.wrangler/` and test artifacts are ignored. The database ID is a local placeholder, not a provisioned production resource. No real customer information belongs here. No offline writes, private offline cache or account recovery after losing the test cookie are implemented.

London timezone only; DST gaps/folds rejected. Fifteen-minute starts, exact duration and ten-minute buffer apply. Financial/time policy values remain provisional.

Model A: shops ultimately receive their own supported Stripe payments. Owners segregate funds and pay barbers externally. Future pay-runs calculate/export/record, never initiate bank transfers or hold a wallet. SaaS billing is separate.

## Local setup

Project: `/home/user/webapp`, branch `main`.
1. Set `APP_MODE="sandbox"` in ignored `.dev.vars` for local development only.
2. Run `npm run db:migrate:local`; never `--remote` for this work.
3. Stop the existing port-3000/PM2 service, run `npm run build`, then `pm2 start ecosystem.config.cjs`.
4. Check `curl http://localhost:3000/api/health`.
5. Run `npm run test` with the service running. Tests create isolated fictional shops.

Scripts: `build`, `typecheck`, `db:migrate:local`, `test:unit`, `test:db`, `test:e2e`, `test`. Playwright requires Chromium and its system dependencies. PM2 service remains `barbershop-preview` for continuity.

## Remaining work / next slice

Persisted add-ons and booking items, barber service eligibility/price/duration overrides, dated staff time off, paginated history and customer/barber interface integration are next. Checkout holds/expiry require a separate allocator extension; current availability explicitly reports `holds:false`.

Production identity/memberships/MFA/invites, verified customer portal, Stripe, notifications, ledger/cash/tips/refunds, reports/pay-runs, subscriptions/platform console, R2 assets and installable/offline PWA remain incomplete or unimplemented. Completing a service never implies payment. Preserve all 189 registered requirements; do not mark this local slice as the full product.

## Project playbook

[Session instructions](AGENTS.md) · [Build plan](docs/BUILD_PLAN.md) · [Progress](docs/PROGRESS.md) · [Decisions](docs/DECISIONS.md) · [Feature register](docs/FEATURE_REGISTER.csv) · [Design standards](docs/DESIGN_SYSTEM.md) · [Quality gates](docs/QUALITY_GATES.md)

## Publication

No production deployment, live provider configuration or bank execution. Do not provision live resources.

Selected GitHub repository: https://github.com/BreezeCreative26/NEW-Barber-System-App-PRoject. Previously public/empty; no push or visibility change authorized. Recheck visibility and obtain publication consent before syncing. Local commits and project auto-backup do not authorize publishing commercial source to that repository.
