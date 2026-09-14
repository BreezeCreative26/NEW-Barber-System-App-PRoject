# Barbershop OS

Multi-tenant barbershop SaaS in development: customer booking, shop administration, barber PWA, shop-owned payments and manual pay-runs.

## Current status

**Local functionality, not a live SaaS.** D-012 preserves the existing matte forest/sage palette and rounded components. No production deployment or live provider activation.

`/workspace` saves fictional test records in local Cloudflare D1:
- Browser-owned isolated test shop, with editable example staff/services and no seeded appointments.
- Shop profile, opening hours, closed weekdays and provisional deposit/cancellation/no-show settings.
- Staff creation/editing/deactivation, search and active/inactive filters, weekly schedules and breaks.
- Dated full-day staff leave, with booking-conflict warnings and audited removal. Partial-day overrides remain unimplemented.
- Service catalogue with integer-pence prices, durations, categories and active/inactive filtering.
- Shop closures and impact warnings for existing appointments.
- Server availability; reviewed, idempotent test bookings and walk-ins; per-shop references.
- Day list, search, barber/status filters, customer-detail/notes corrections and versioned status actions.
- Atomic same-reference reschedule, cancellation, check-in, start service, completion and grace-checked no-show.
- Immutable booking price/duration/name snapshots, reviewed quote-version checks and append-only audit.
- In-page retry after network/proxy failures, preserved form inputs, explicit stale-record refresh, safe booking replay after interrupted save responses and visible modal save actions.

Original `/preview/admin`, `/preview/book` and `/preview/barber` remain separate fixture-only experiences. Their checkout and finance controls are not connected to local persistence.

## Remaining work

Persisted add-ons and booking-item snapshots, barber service eligibility and price/duration overrides, partial-day time overrides, booking pagination, public booking and customer portal integration, role-separated barber workspace, managed identity/MFA/invites, checkout holds, Stripe, notifications, cash/tips/ledger/refunds, reports/pay-runs, subscriptions/platform console and installable/offline PWA remain incomplete or unimplemented.

Next package: extend the existing catalogue/quote model with add-ons and barber-specific coverage/overrides; then connect the customer and barber surfaces to the tested shared APIs. Do not restart planning or recolour the application.

## Entry points

Development entry: `http://localhost:3000/workspace`, also available through the project's temporary Preview service. Production URL: **none**.

| URI | Behaviour |
| --- | --- |
| `/` | `/workspace` in sandbox mode; otherwise `/preview/admin` |
| `/workspace` | Persisted local test workspace |
| `/preview/admin`, `/preview/book`, `/preview/barber` | Original fixture-only design experiences |
| `/api/health` | Mode, persistence capability, `livePayments:false` |
| `POST /api/sandbox/session` | Create/reuse this browser's isolated workspace |
| `GET /api/sandbox/workspace` | Shop/setup, full-day leave, latest 500 bookings and 200 audit events |
| `PUT /api/sandbox/shop` | Versioned shop settings |
| `POST /api/sandbox/staff`, `PUT /api/sandbox/staff/:id` | Create/edit/deactivate staff |
| `PUT /api/sandbox/staff/:id/hours` | Versioned seven-day schedule |
| `POST /api/sandbox/staff/:id/days-off` | Add full-day leave with date/reason |
| `DELETE /api/sandbox/staff/:id/days-off/:leaveId` | Remove leave with retained audit |
| `POST /api/sandbox/services`, `PUT /api/sandbox/services/:id` | Create/edit/deactivate services |
| `POST /api/sandbox/holidays`, `DELETE /api/sandbox/holidays/:id` | Shop closures |
| `GET /api/sandbox/availability` | `date`, `staff_id`, `service_id`, optional `booking_id`; server quote/versions, no hold |
| `POST /api/sandbox/bookings` | Save/replay booking; quote versions and request UUID required |
| `GET /api/sandbox/bookings/:id` | Tenant-scoped booking detail |
| `PATCH /api/sandbox/bookings/:id/details` | Versioned contact/notes correction and audit reason |
| `POST /api/sandbox/bookings/:id/reschedule` | Versioned atomic move with reason |
| `POST /api/sandbox/bookings/:id/status` | Validated, audited lifecycle transition |

## Data and safety

Local D1 stores shops, sandbox_sessions, staff, staff_hours, staff_days_off, services, holidays, bookings and audit_events. Tenant-aware foreign keys and transactional SQLite triggers enforce reservation overlap, leave/closure rules, quote freshness and immutable snapshots. UI availability alone is not a lock.

Sessions use random capabilities, SHA-256 hashes in D1 and HttpOnly/Secure/SameSite=Strict cookies, expiring after seven days. **This is test workspace ownership, not verified production identity or role authorization.** Shop scope is server-derived. Mutations require matching Origin. All sandbox endpoints fail closed unless both D1 and local `APP_MODE=sandbox` are present.

`.dev.vars`, `.wrangler/` and test artifacts are ignored. The database ID is a local placeholder. No real customer data belongs here. There is no offline write queue, private offline cache or account recovery after losing the cookie.

London timezone only. DST gaps/repeated local times are rejected. Fifteen-minute starts, exact duration and ten-minute buffer apply. Settings are provisional test policies. Completion records service status, never payment.

Model A is unchanged: shops ultimately receive their own supported Stripe payments; owners segregate funds and pay barbers externally. Future pay-runs calculate/export/record, not execute transfers or hold a wallet. SaaS billing is separate.

## Local setup and tests

Project: `/home/user/webapp`, branch `main`.

1. Set `APP_MODE="sandbox"` in ignored `.dev.vars` only.
2. Run `npm run db:migrate:local`. Never use `--remote` for this work. Apply new migrations **before** building code that queries their tables.
3. Stop the old port-3000/PM2 instance, run `npm run build`, then `pm2 start ecosystem.config.cjs`.
4. Verify `curl http://localhost:3000/api/health`; open `/workspace`.
5. Create a test shop and use fictional details. Confirm bookings and inspect Audit.
6. Run `npm test` with the local service running. It runs TypeScript, unit tests, actual local D1 invariant tests and Playwright browser/API tests.

Network recovery: use **Retry workspace** or **Retry availability**, not a full page reload. If a save succeeded but the following read failed, retry the read rather than repeat the action. Interrupted booking responses can be retried with the unchanged request safely. Other interrupted mutations require checking the refreshed records before retrying. **Discard edits and load latest** explicitly refreshes a stale editor.

Playwright artifacts/reports are isolated under `test-results/runs/<run-id>/` to prevent overlapping runs deleting each other's `.network`/`.trace` files. Do not reuse a run ID for simultaneous invocations. See [PROGRESS](docs/PROGRESS.md) for the exact final test report and limitations. Screenshots are in `docs/evidence/`. Automated axe checks are not full WCAG or device certification.

## Project playbook

- [Session instructions](AGENTS.md)
- [Build plan](docs/BUILD_PLAN.md)
- [Progress and next-session handoff](docs/PROGRESS.md)
- [Decisions](docs/DECISIONS.md)
- [189-row feature register](docs/FEATURE_REGISTER.csv)
- [Design standards](docs/DESIGN_SYSTEM.md)
- [Quality gates](docs/QUALITY_GATES.md)

## Publication and deployment

No production deployment, real messages, charges or transfers. Do not provision live resources without explicit authorization.

Selected GitHub repository: https://github.com/BreezeCreative26/NEW-Barber-System-App-PRoject. Previously public/empty; no push or visibility change authorized. Recheck and obtain publication consent before syncing. Local commits and the project auto-backup preserve development work without publishing to that repository.
