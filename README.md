# Barbershop OS

Multi-tenant barbershop SaaS in development: customer booking, shop administration, barber PWA, shop-owned payments and manual pay-runs.

## Current status

**Functionality-first local development, not a live SaaS.** D-012 keeps the existing matte forest/sage palette and rounded components. The planned recolouring is cancelled.

`/workspace` now saves fictional test records in local Cloudflare D1:
- Browser-owned isolated test shop, with an editable example catalogue and empty appointment list.
- Shop profile, opening times, closed weekdays and provisional deposit/cancellation/no-show settings.
- Staff creation/editing/deactivation, weekly hours and lunch breaks.
- Services, categories, integer-pence prices, durations and active status.
- Dated shop closures and warnings for affected future appointments.
- Server availability, reviewed test bookings and walk-ins, per-shop references and idempotent submission.
- Booking detail, rescheduling, cancellation, check-in, start service, completion and grace-checked no-show actions.
- Append-only attributed audit; existing service/price/duration snapshots preserved.
- Responsive day list, search/filter, form validation, failure recovery and explicit offline limitations.

The original `/preview/*` screens remain fixture-based and separate. Their customer checkout and barber finance controls are **not** connected to this database.

## Not implemented yet

Production authentication/memberships/MFA, public customer booking integration and portal, complete staff-specific service coverage/overrides/add-ons, dated staff time off, checkout holds, Stripe, real notifications, ledger/cash/tips/refunds, reports/pay-runs, subscriptions/platform console and installable/offline PWA remain incomplete or unimplemented. No financial operation is performed by completing a service.

Next slice: persisted add-ons and booking items, barber service eligibility/price/duration overrides, dated staff time off, then connect the customer and barber interfaces to shared tested APIs. Do not restart planning or redesign.

## Routes

Local entry: `http://localhost:3000/workspace` (the project development Preview uses the same service).

Production URL: **none — not deployed**. The sandbox's temporary Preview is a development service, not a production release.

| URI | Behaviour |
| --- | --- |
| `/` | Redirect to `/workspace` with local sandbox flag; otherwise `/preview/admin` |
| `/workspace` | Persisted local test workspace |
| `/preview/admin` | Original fixture calendar and admin design preview |
| `/preview/book` | Original customer design preview; no saved checkout |
| `/preview/barber` | Original barber design preview; no payment execution |
| `/api/health` | Mode, local persistence capability and `livePayments:false` |
| `POST /api/sandbox/session` | Create/reuse this browser's isolated test workspace |
| `GET /api/sandbox/workspace` | Current shop, staff, services, hours, closures, latest 500 bookings and 200 audit events |
| `PUT /api/sandbox/shop` | Versioned shop settings |
| `POST /api/sandbox/staff`, `PUT /api/sandbox/staff/:id` | Staff create/edit/deactivate |
| `PUT /api/sandbox/staff/:id/hours` | Versioned seven-day schedule |
| `POST /api/sandbox/services`, `PUT /api/sandbox/services/:id` | Service create/edit/deactivate |
| `POST /api/sandbox/holidays`, `DELETE /api/sandbox/holidays/:id` | Dated closures |
| `GET /api/sandbox/availability` | `date`, `staff_id`, `service_id`, optional `booking_id`; no checkout hold |
| `POST /api/sandbox/bookings`, `GET /api/sandbox/bookings/:id` | Save/replay and read a tenant-scoped test booking |
| `PATCH /api/sandbox/bookings/:id/details` | Versioned customer-detail/notes correction with audit reason |
| `POST /api/sandbox/bookings/:id/reschedule` | Versioned atomic move, reason required |
| `POST /api/sandbox/bookings/:id/status` | Validated, audited lifecycle transition |

## Data and access boundaries

All authoritative test records use local D1; migrations are in `migrations/`. Main entities: shops, sandbox_sessions, staff, staff_hours, services, holidays, bookings and audit_events. Composite tenant foreign keys, interval-overlap triggers, snapshot guards and D1 transactions protect writes. Availability feedback alone is not the reservation lock.

Random session capabilities are hashed in D1 and supplied using an HttpOnly, Secure, SameSite=Strict browser cookie. They expire after seven days. **This is local test ownership, not verified production customer/staff identity.** The server derives shop scope from the capability, never a supplied shop ID. Mutations require matching Origin. Every sandbox endpoint fails closed without both a DB binding and `APP_MODE=sandbox`.

`.dev.vars` and `.wrangler/` are ignored. The Wrangler database ID is a local placeholder, not a provisioned production resource. No real customer information belongs in this environment. There is no offline write queue or recovery/account transfer after losing the test cookie.

London timezone only in this slice. DST gaps/folds are rejected rather than guessed. Fifteen-minute starts, exact service duration and ten-minute buffer apply. Some policy values are provisional test settings, not approved production financial terms.

Model A remains unchanged: each shop ultimately receives its own supported Stripe payments; owners segregate funds and pay barbers externally. The app will calculate/export/record manual pay-runs, not initiate bank transfers or hold a wallet. SaaS subscriptions are separate.

## Local setup and verification

Project `/home/user/webapp`, branch `main`.

1. In an ignored `.dev.vars`, set `APP_MODE="sandbox"` for local development only.
2. Run `npm run db:migrate:local` (never `--remote` for this work).
3. Stop any existing port-3000/PM2 instance, run `npm run build`, then `pm2 start ecosystem.config.cjs`.
4. Check `curl http://localhost:3000/api/health`.
5. Open `/workspace`, create a test shop, edit setup and book using fictional details. Confirm, reload, and inspect Audit.
6. Run `npm run test` with the local service running. Tests create additional isolated fictional workspaces.

Scripts: `build`, `typecheck`, `db:migrate:local`, `test:unit`, `test:db`, `test:e2e`, `test`. `test:db` uses actual local Wrangler D1 and deliberately bypasses API pre-checks to exercise database triggers. Playwright needs Chromium and system dependencies. Service name remains `barbershop-preview` for continuity.

See [progress](docs/PROGRESS.md) for exact latest results, evidence and limitations. Automated accessibility checks are not full WCAG or real-device certification.

## Project playbook

- [Session instructions](AGENTS.md)
- [Master build plan](docs/BUILD_PLAN.md)
- [Progress / next-session handoff](docs/PROGRESS.md)
- [Decisions](docs/DECISIONS.md)
- [189-row feature register](docs/FEATURE_REGISTER.csv)
- [Matte design and interaction standards](docs/DESIGN_SYSTEM.md)
- [Quality gates](docs/QUALITY_GATES.md)

## Publication and deployment

Nothing is deployed to production; no live Stripe, messaging or banking credentials are configured. Do not invoke deploy or provision live resources.

Selected GitHub repository: https://github.com/BreezeCreative26/NEW-Barber-System-App-PRoject. Previously public/empty; no push or visibility change authorized. Recheck visibility and obtain publication consent before syncing. Local work is versioned without publishing to that repository.
