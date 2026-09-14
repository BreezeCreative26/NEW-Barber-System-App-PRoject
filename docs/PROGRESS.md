# Barbershop OS — Progress and next-session handoff

Updated 2026-09-14. Current package: **WP-LOCAL-01 — local persistent functionality**. Next: **WP-LOCAL-02 — catalogue completeness and scheduling overrides**.

## Read this first

**D-012 controls: keep the current matte colours and rounded components. Cancel WP-001-A-R1 recolouring. Functionality first; nothing live.** Do not restart design/discovery. No production deployment, live payments, real messages, bank transfers or public GitHub push has occurred.

The application is no longer only a design preview. `/workspace` now uses local D1 for saved test shop setup and appointment operations. This is a narrow functional slice, **not all 189 requirements or a production-ready SaaS**. The existing `/preview/admin`, `/preview/book` and `/preview/barber` remain separate fixture-only experiences.

## What actually works locally

- Isolated browser-owned test workspace creation: two editable example barbers, three services, weekly schedules, no seeded appointments/payments.
- Shop name/address, Europe/London timezone, opening/closing hours, closed weekdays, provisional deposit/cancellation/no-show settings.
- Staff creation/editing/deactivation, active status, seven-day schedules and valid lunch breaks.
- Service creation/editing/deactivation, category, integer-pence price and exact duration.
- Dated shop closures, removal with audit retained, future-appointment impact warnings after closure/hours/deactivation changes.
- Server-calculated availability: active staff/service, shop hours, staff hours, breaks, holidays, elapsed time, existing booking intervals and ten-minute buffer.
- Reviewed test bookings and walk-ins persisted in D1; shop-specific sequential references; payload-bound request-key replay.
- Day appointment list with date navigation, staff filter, name/phone/reference search and detail.
- Same-identity reschedule with reason, preserving original appointment on conflict and commercial snapshots on success.
- Check-in -> in service -> completed; cancellation/no-show require reason; no-show grace checked by server. Service completion never implies payment.
- Append-only attributed audit, optimistic version rejection and no booking deletion.
- Validated forms, pending states, server error recovery, preserved inputs, mobile layouts and keyboard/focus handling.
- Subsequent local hardening includes reviewed service/shop quote versions and audited/versioned customer-detail corrections; see current router and tests for the exact contract.

## Architecture and safety evidence

- `src/server/domain.ts`: strict Zod schemas, types, London wall-time conversion, DST gap/fold rejection, slot evaluation.
- `src/server/sandbox.ts`: session boundary, tenant-scoped APIs, transactional mutations, idempotency, snapshots and audit.
- `migrations/`: foundation, immutable snapshot protection and quote-version guards. All applied locally; no production resources created. Inspect migration filenames before adding the next one (two existing files share the 0002 prefix and have distinct tracked names).
- Interval locking is enforced by SQLite BEFORE INSERT/UPDATE triggers inside the same write transaction, not an application SELECT followed by an unprotected INSERT.
- Direct-D1 tests deliberately bypass API availability checks: conflicting insert rejected, conflicting move and preceding audit rolled back, holiday revalidated, snapshot/history edits rejected.
- Eight simultaneous overlapping requests yielded one saved booking and seven conflicts. Concurrent identical request replay yielded one record. Cross-shop entity operations are denied.
- Customer financial fields are server-derived. Staff/service changes never rewrite booking price/name/duration snapshots. Reviewed quote version changes require a refreshed review.
- Browser capability is random; only SHA-256 hash is stored in D1. Cookie is HttpOnly, Secure, SameSite=Strict, seven-day lifetime. Secure session creation was also checked through the existing HTTPS development proxy.
- Server resolves shop/actor from the session; client-supplied tenant/price fields are rejected. Matching Origin required for mutations.
- All functional endpoints fail closed without both local `APP_MODE=sandbox` and D1 binding. Flag is only in ignored `.dev.vars`, never production vars.
- These capabilities are **test workspace ownership, not managed identity, production staff roles or customer verification**.

## Routes and service

- Local service: `http://localhost:3000`, PM2 name `barbershop-preview`, configuration `ecosystem.config.cjs`.
- `/` redirects to `/workspace` when sandbox mode is enabled; otherwise retains `/preview/admin` redirect.
- `/workspace`: local persisted test workflow.
- `/api/sandbox/*`: session, shop, staff, services, weekly hours, holidays, availability, bookings, detail correction, reschedule and status APIs. README lists entry contracts; current schemas are authoritative.
- `/api/health`: local mode returns `mode:local-sandbox`, `persistence:true`, `livePayments:false`.
- `/preview/*`: original fixture experiences unchanged in function and palette. No customer checkout or barber finance integration is implied.
- The existing temporary sandbox Preview continues to serve development code. **No production URL or deployment exists.**

## Latest verification

| Check | Result / scope | Evidence |
| --- | --- | --- |
| Build | Passed, Hono Worker plus React assets | `npm run build` |
| TypeScript | Passed on latest inspected source | `npm run typecheck` |
| Unit/route/domain | 36 passed: 23 preview + 13 local boundary/time/schema tests | `tests/fixtures.test.ts`, `tests/domain.test.ts` |
| Direct local D1 invariants | Passed independently of API pre-checks | `npm run test:db`, `tests/d1-invariants.mjs` |
| Full browser/API suite | Latest inspected full report: 38 passed, 0 failed/skipped/flaky | `test-results/runs/1789387470837-20621/results.json`, start 2026-09-14 12:04:30 UTC |
| Prior full regression | 37 passed before the additional quote/detail test | Full `npm run test` output from this package |
| Persisted UI workflow | Create staff/service/hours/settings/closure, reload, book, move, check in/start/complete, audit | `tests/workspace.spec.ts` |
| Tenant/API/concurrency | Cross-shop reads/mutations, strict payloads, stale versions, idempotency, rollback, status/no-show, schedule impacts | `tests/sandbox.spec.ts` |
| Responsive | 320/390/768/1024/1440 widths, all workspace sections, no page overflow | Workspace Playwright cases |
| Accessibility | Zero violations in tested workspace/booking-dialog axe scans and original preview scans; dialog Escape/focus return passed | Browser suite; not full WCAG certification |
| Failure recovery | Forced server error keeps service inputs; retry saves; offline notice makes no queued-save claim | Workspace recovery test |
| Visual inspection | Desktop and phone workspace plus phone booking dialog inspected; no clipping/overlap found; matte palette retained | `docs/evidence/workspace-1440.png`, `workspace-390.png`, `workspace-booking-390.png` |
| Dependency audit | Zero reported vulnerabilities in package audit | `npm audit --audit-level=high` |
| Secret exclusion | `.dev.vars` ignored; local DB/artifacts ignored | `git check-ignore .dev.vars` |

Resolved during this package: stable form labels needed for exact accessible selection; forced Secure cookie for HTTPS development proxy; overlapping Playwright runs initially collided on artifact cleanup (ENOENT). Current Playwright config isolates run output under `test-results/runs/<run-id>/`; that infrastructure failure was not a saved-workflow failure. Never run overlapping suites against a shared artifact path.

New screenshots: `docs/evidence/workspace-{320,390,768,1024,1440}.png` and `workspace-booking-{320,390,768,1024,1440}.png`. Old preview evidence remains historical; no recolouring was applied.

## Feature/milestone tracking

All 189 rows and 125 original C/B/A IDs remain. 47 touched requirements are marked `implementing`, not production `verified`/`accepted`. This records shared local building blocks, not complete customer/barber/owner authorization or every original acceptance condition.

Touched groups: C-06/C-11..C-14/C-16/C-17/C-19/C-26/C-29; B-09/B-10/B-12..B-15; A-02..A-09/A-12/A-13/A-15/A-17/A-18/A-23/A-26/A-28/A-41..A-43; S-01/S-02/S-20; AC-01/AC-05; X-01..X-05/X-12/X-15.

| Milestone | State | Remaining gate |
| --- | --- | --- |
| M0 Planning | verified | Existing feature register/playbook preserved |
| M1 Design + spikes | in_progress | Matte direction retained; local appointment concurrency proven; hold/provider proof still open |
| M2 Tenant setup | in_progress | Local setup persists; managed identities/memberships/MFA/invites and complete catalogue still missing |
| M3 Booking core | in_progress | Local booking/atomic move works; public workflow, add-ons/overrides, holds still missing |
| M4 Collections/communication | not_started | No Stripe/messages/customer verified access |
| M5 Daily operations/PWA | in_progress | Local service transitions work; barber role scope, payments and actual PWA missing |
| M6 Finance/reports | not_started | No ledger, pay-runs, reports or reviews |
| M7 SaaS readiness | not_started | No subscriptions/platform console/restore/monitoring |
| M8 Pilot/release | not_started | Explicitly no live release |
| M9 Native | not_started | Scope unresolved; PWA is not native Tap-to-Pay |

## Exact next work package: WP-LOCAL-02

Continue the same local database and matte UI. Do not rebuild the shell.

1. Add persisted add-on catalogue, service/add-on eligibility and immutable booking-item snapshots.
2. Add barber/service coverage, price/duration overrides and server quote recomputation; recheck availability whenever total duration changes.
3. Add dated staff day-off/time overrides with affected-booking review, alongside weekly hours.
4. Expand tests: 25-minute services, varying add-on durations, coverage disabled between review and write, dated overrides, stale quotes and cross-shop references.
5. Improve saved booking views/pagination and operational form coverage, then connect customer/barber interfaces to the shared authoritative APIs without pretending test sessions are production roles.
6. Implement checkout holds and expiry only as a deliberate next allocator extension, with late-confirmation tests. Current availability truthfully reports `holds:false`.
7. Update this log, feature register and evidence after each tested slice; commit incrementally.

## Explicit limitations / blockers

- Test session lasts seven days. No account recovery, logout/session-management UI or automatic old-test-data cleanup. Do not enter real personal data or expose this as commercial authentication.
- Workspace loads latest 500 bookings/200 audit events; pagination is still needed. Availability uses scoped database records independently of this display cap.
- London-only schedules; no full multi-zone support. Buffer/grace/deposit/cancellation are provisional local settings; final production policy decisions remain open.
- No role-separated staff/customer/private-note authorization, production abuse controls or verified customer history.
- No financial ledger/cash/tips/refunds/receipts, pay-runs or implied bank execution. Model A remains shop collection plus owner-paid external transfers.
- No real notification providers, subscriptions, platform console, uploads/R2, installed PWA/service worker, offline writes or safe offline private cache.
- No hold/expiry, public booking slug, add-on/override/time-off completeness or full calendar week/month.
- Production auth/provider/policy choices gate their dependent work only; they do not block the next local slice.

## GitHub / continuity

Selected repository: https://github.com/BreezeCreative26/NEW-Barber-System-App-PRoject. Last checked public/empty. No push or visibility change. Recheck and obtain private/public publication consent before syncing. Keep local and genspark history; do not overwrite another session's changes.

Earlier commits: `ff7c504` planning, `26a7790` publication pause, `858cf6f` execution sequence, `2eebb48` implemented previews, `ba94463` D-011 proposal. D-012 now supersedes the recolouring proposal. This package continues, rather than restarts, that work.

## Required next-session start

Read AGENTS, this file, DECISIONS and current schemas/tests. Verify git state and any running builds/tests before launching another runner. Preserve interrupted/concurrent work. State the narrow package, implement one vertical slice, run functional and visual checks, and update evidence honestly. Nothing live unless the user explicitly changes that instruction.
