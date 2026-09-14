# Barbershop OS — Progress and next-session handoff

Updated 2026-09-14 after the 12:36 UTC final regression. **WP-LOCAL-02 is implemented and verified locally**, continuing directly from `c8abf5c`. Next: **WP-LOCAL-03 — paginated booking reads and connected customer/barber test interfaces**.

## Read this first

**D-012/D-013 control: keep the existing matte forest/sage colours, build functionality, nothing live.** No restart, production deployment, provider activation, real messages/charges/transfers or public GitHub push. This is not the completed 189-feature commercial SaaS.

`/workspace` is the authoritative local D1 test application. `/preview/admin`, `/preview/book` and `/preview/barber` remain separate fixture-only experiences, preserved by regression tests. Browser-owned sandbox capabilities are not verified production identity or staff/customer roles.

## Completed local functionality

### Existing foundation preserved

- Isolated browser-owned shop with editable example staff/services and no seeded bookings/payments.
- Shop settings, open/closed weekdays, weekly staff hours/breaks, full-day leave and shop holidays.
- Staff/service create/edit/deactivate/reactivate, search, active/inactive filters and affected-appointment warnings.
- Server availability, reviewed/idempotent bookings and walk-ins, per-shop references, day list, search/barber/status filters.
- Versioned contact/notes corrections, same-reference reschedule, check-in/in-service/completed, cancellation and grace-checked no-show. Service completion does not imply payment.
- Append-only attributable audit; optimistic conflict rejection; booking deletion forbidden.
- Network/HTML proxy failures retry in-page. Save success followed by failed read does not repeat the mutation. Lost booking responses replay safely. Stale editors can explicitly discard/load current records.

### WP-LOCAL-02 delivered in this session

1. **Persisted add-ons and service links:** create/edit/deactivate; integer-pence price, 0–120 extra minutes, explicit eligible services. New records do not disappear on reload.
2. **Barber/service rules:** enable/disable eligibility and price/duration overrides. Missing rules inherit catalogue behaviour; null restores defaults, zero price is valid. Disabled coverage blocks new selection/bookings/moves and flags affected future appointments.
3. **Itemized authoritative booking quotes:** service line plus up to ten unique add-ons; exact durations are summed rather than rounded to the start grid. Changing selections clears stale times without losing contact fields. Server quote versions require review after catalogue/rule edits.
4. **Immutable booking-item snapshots:** `bookings.items_json` persists service/add-on names, prices and durations in the same row/write as the interval allocation. Legacy bookings are backfilled to one service line. Catalogue edits, add-on withdrawal and rescheduling never reprice saved history.
5. **Partial-day dated hours:** create/edit/remove a dated replacement shift and break. Weekly hours are replaced, not intersected; shop hours/closures and full-day leave still win. Changes flag impacted appointments; deletion restores weekly hours without deleting bookings.
6. **Admin controls and booking integration:** Services → Add-ons; Team → Services & pricing / Dated hours; New booking → Optional add-ons; saved details show original item lines. Service rules save individually, one section at a time.

## Data, safety and migration contract

- Hono/React/D1 architecture retained; no new runtime dependency or framework replacement.
- `src/server/domain.ts`: strict schemas, `calculateQuote`, `effectiveHours`, London/DST conversion, interval checks and shared types.
- `src/server/sandbox.ts`: existing cookie/Origin/session boundary reused for all new routes. Tenant IDs/prices/totals cannot be supplied as authority. All functional routes require local `APP_MODE=sandbox` plus a DB binding.
- New tables: `addons`, `addon_services`, `staff_service_rules`, `staff_schedule_overrides`; existing shop/staff/schedule/booking/audit tables retained.
- `0004_catalogue_and_dated_hours.sql` is applied locally. The working database was retained. A separate empty local database successfully applied the entire five-file migration chain.
- Earlier files include two distinctly named `0002_*` migrations; do not rename already-applied files. Next migration number is `0005`.
- Add-on/link/rule edits increment `shops.version` in the same transaction. Existing service/shop quote-version checks therefore reject stale review state; no client-authoritative amount was introduced.
- SQLite triggers validate current item sums/pricing/eligibility, dated shifts, leave/closures and interval collisions inside the write. Separate availability reads are feedback, not locks. Snapshot JSON cannot be updated afterward.
- Booking replay hashes omit empty default add-on selections to preserve the earlier normalized payload contract. Only booking creation has request-key idempotency; inspect refreshed records before repeating other interrupted creates.
- No external API calls, production resources or credentials were added. `.dev.vars`, `.wrangler/` and test-results stay ignored.

## Latest verification — conclusive result

Final command: build → typecheck → unit tests → direct D1 invariants → complete Playwright suite → unchanged-source hash check → dependency audit → diff check. Exit code **0**.

| Check | Result / evidence |
| --- | --- |
| Build / TypeScript | Passed |
| Unit/route/domain | **42 passed**: 23 preview and 19 domain/boundary tests |
| Direct local D1 | Passed raw-write overlap, quote/item totals, add-on/rule eligibility, partial-day shift, immutable history, batch rollback, leave/closure and no-show checks |
| Full browser/API suite | **54 passed; 0 failed/skipped/flaky**, `test-results/runs/1789389389665-42361/results.json`; start 2026-09-14 12:36:29 UTC; 80.44 seconds |
| Stable source | Source/assets/tests/migrations had identical aggregate SHA-256 before/after final build and full regression; command printed `VERIFIED: final source remained unchanged through full regression.` |
| Mutation coverage | All **21** POST/PUT/PATCH/DELETE routes included in source-derived inventory; Origin/session/invalid-input checks passed |
| Catalogue persistence / history | Add-ons, service links, overrides, rules, booking items and edits survive reads/reloads; old itemized commercial values retained |
| Conflicts | Six simultaneous aggregate-duration bookings: one winner, five conflicts; buffer boundary, stale quote, disabled coverage, reschedule rejection/rollback and partial-day limits tested |
| Recovery regression | Existing initial-load/proxy/read-after-save/lost-booking-response/stale-editor tests passed; new add-on slot/price conflict recovery preserves contact fields |
| Accessibility/layout | Existing five viewport regressions passed; new forms passed axe scans at 390/1440 px. New mobile add-on/rules and desktop dated-hours screenshots inspected: readable/no clipping or overlap |
| Migration bootstrap | All five migrations passed on separate empty local DB; no remote operations |
| Dependency audit | Zero reported vulnerabilities |
| Secret exclusion | Local vars, databases and generated traces ignored |

New tests: `tests/catalogue.spec.ts` (7 API/browser/visual cases); expanded `tests/domain.test.ts`, `tests/d1-invariants.mjs` and mutation inventory in `tests/sandbox.spec.ts`. Original preview and saved/reload workflows remain covered.

Resolved test issues, not hidden failures:
- A raw stale-quote test also had an active closure and depended on SQLite trigger ordering. The test now removes the closure before isolating quote rejection; both guards still have independent assertions.
- Playwright's option-enabled matcher reported an explicitly disabled native `<option>` as enabled. The test now asserts its actual DOM `disabled` property; server conflict checks remain independently tested.

Screenshots committed under `docs/evidence/catalogue-{addon-form,barber-rules,dated-hours}-{390,1440}.png`. Per-run screenshots/traces remain isolated under test-results. Do not build/migrate or reuse artifact run IDs during a running suite. Automated axe/Chromium checks are not real-device or full WCAG certification.

## Feature and milestone tracking

All **189 rows and 125 original C/B/A IDs remain intact**. **53 rows are `implementing`**, not production `verified`/`accepted`; 136 remain `not_started`. Current additions: C-02/C-03/A-19/A-20/A-21, with shared availability/buffer/A-28 work extended. A-14 now correctly reflects previously implemented local full-day leave. Native/v1.5 scope is not silently changed; B-06/B-07 remain deferred role-specific work.

M1/M2/M3/M5 are in progress: local persistence, catalogue, allocator and service transitions have evidence, but production identity, public/customer/barber integration, holds, payments and PWA gates remain incomplete. M4/M6/M7/M8/M9 are not delivered by this slice.

## Exact next work package: WP-LOCAL-03

1. Add tenant-scoped server date/status/barber/search/cursor booking queries and matching admin pagination. Prove correctness beyond 500 records; separate dashboard summaries/issues from a limited list.
2. Connect customer and assigned-barber **test** interfaces to shared catalogue/quote/availability/booking APIs while maintaining honest test-ownership labels. Do not repurpose fixture previews as authenticated roles.
3. Add deliberately designed checkout holds/expiry with concurrent, expiration and late-confirmation tests before any payment-dependent flow.
4. Production identity, memberships/invites/MFA and customer verification remain explicit provider/design gates. Keep provider activation and deployment paused.
5. Continue persistent handoffs and focused/full tests; do not reset planning or recolour the app.

## Limits and operations

- London timezone; exact duration + ten-minute buffer; one dated shift/break per barber/date. Multiple split shifts, overnight work and arbitrary multi-zone support are not implemented.
- Add-ons/service rules are owner-test controls, not production staff self-management. Rules save per service. Deleted dated overrides retain audit, not a restorable version-history UI.
- Workspace still loads latest 500 bookings and 200 audit events. Availability reads authoritative scoped database records independently, but display/issue pagination is next.
- Seven-day capability session, no account recovery/logout management or automatic old-test cleanup. Use fictional records only; no private offline cache/write queue.
- No customer portal, public shop routing, financial ledger/cash/tips/refunds/receipts/pay-runs, reviews, messaging, subscriptions/platform console or installed/offline PWA.
- Model A unchanged: shop receives customer money; owners segregate and pay barbers externally. No wallet, bank transfer execution or live payment claims.

## Service and continuity

PM2 `barbershop-preview`, port 3000, `http://localhost:3000/workspace`; health reports local-sandbox/persistence true/livePayments false. Temporary development Preview only; no production URL.

Selected GitHub repository remains https://github.com/BreezeCreative26/NEW-Barber-System-App-PRoject, previously public/empty. No push or visibility change authorized/performed. Recheck and obtain publication consent before syncing. Preserve local/genspark history.

Next session: read AGENTS, this handoff, DECISIONS, actual schema/tests and git status. Continue from this tested slice. No production action unless the user explicitly changes the instruction.
