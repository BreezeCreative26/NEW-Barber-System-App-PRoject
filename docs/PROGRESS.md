# Barbershop OS — Progress and next-session handoff

Updated 2026-09-14 with the **comprehensive enhancement plan (D-015)**, continuing the original-interface direction D-014 from 9a1a416. **WP-LOCAL-02 remains implemented and verified locally.** Next visible deliverable: **WP-LOCAL-03A — original-style admin shell/calendar connected to saved bookings**, including complete reads and interaction recovery. This is planning only; no UI consolidation, audit fix or new runtime feature is claimed.

## Read this first

**D-014 controls UI continuity: build on the original preview layout/calendar, not the stripped-down workspace. D-012/D-013 retain matte forest/sage colours, persisted functionality and nothing live.** No restart, production deployment, provider activation, real messages/charges/transfers or public GitHub push. This is not the completed 189-feature commercial SaaS.

Runtime is still split: `/workspace` is the local D1 test application; `/preview/admin`, `/preview/book` and `/preview/barber` are fixture-only. The user finds this confusing and explicitly prefers the original preview's layout and interactions. That original UI is now the confirmed product foundation, to be connected to the existing backend rather than demoted to a separate reference. Do not merely redirect to fixtures and claim restoration is complete. Browser-owned sandbox capabilities are not production identity or staff/customer roles.

## Latest session — comprehensive enhancement planning, D-015

User asked to enhance/modernise every created feature, ensure correct visual placement and enjoyable customer/admin experiences, explain current feature progress, identify improvements and produce a comprehensive plan. No runtime changes were requested/executed as part of this planning deliverable.

- Rechecked revision/clean tree, original Admin fixture imports, current docs and feature register. Counts unchanged: 189 unique requirements, 53 implementing / 136 not_started; zero production verified/accepted. Re-inspected original committed admin desktop, customer phone and barber phone screenshots for layout continuity; no new screenshots or UI fixes generated.
- **BUILD_PLAN section 12** now contains the current-state matrix, enhancement coverage for every existing area, missing product capabilities, market-informed proposals, sequenced 03A/03B substeps and acceptance/decision dependencies. Earlier architecture, financial model and milestones retained; no new register rows or release-scope changes.
- **DESIGN_SYSTEM** adds an enhancement checklist covering shell/calendar/drawers/directories/forms/customer steps/barber queue/colour/feedback, including dense/empty/error/mobile cases.
- **QUALITY_GATES** adds pending T-ENH-01..11 integration contracts for original-layout continuity, complete calendar reads, saved lifecycle, multi-row drafts, dirty/pending dismissal, render recovery, setup, customer-to-barber flow, time policy, placement/accessibility and performance. These are not executed tests.
- **DECISIONS D-015 and README** reflect this plan and the unchanged runtime split. The original layout remains the product foundation, not the list-only replacement. Keep matte baseline; no new palette, live service, deployment or external publication authorized.
- Immediate execution order: **03A/1a complete queries → 03A/1b original calendar integration → 03A/1c integrated setup/form polish**. Then original customer/barber connected test journeys, holds and gated identity/payment/communications/finance/PWA/SaaS work. Do not respond to the next build instruction with another planning reset.
- Validation for this planning turn: document diff/requirement-ID checks and unchanged runtime files only. Prior 42/54 regression evidence below remains the latest runtime run; no new full suite claimed. AUD-01..08 remain open as documented.

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

## Overall-product audit — 2026-09-14, baseline c1350a4

User requested an honest whole-app assessment and improvements towards a market-leading product. Scope: code, all 189 feature rows, migrations/test architecture, focused local API/browser experiments, actual 390/1440 screenshots and a limited official-vendor feature comparison. No application code, schema, feature status or approved commercial policy changed. This is not a security certification, production load benchmark or competitive usability study.

### Readiness by product area

| Area | Actual position | Main gap |
| --- | --- | --- |
| Owner setup/catalogue | Persisted local CRUD, eligibility, exact pricing, weekly/dated hours | Production membership/permissions, complete setup/onboarding, images, final policy |
| Booking engine | Strong local write-time guards, snapshots, replay, reschedules/status | Complete reads/issues, holds/expiry, public integration, final time policies |
| Owner daily UI | Persisted day list and controls; fixture resource-calendar proof | Connected day/week/month calendar, safe drafts, full search/issue navigation |
| Customer journey | Fixture preview plus shared backend capabilities | Public shop links, persisted end-to-end flow, secure customer identity/history |
| Barber journey | Fixture queue plus owner-operated status APIs | Assigned-role access, connected queue, customer history, checkout/earnings |
| Payments/finances | Model A design only; no money collected | Test-provider account proof, collections/refunds, ledger, cash/tips, receipts and manual pay-runs |
| Communications/reviews | Planned | Durable outbox, real scheduler, delivery recovery, consent and verified reviews |
| PWA | Responsive browser UI only | Manifest/install/update, restricted offline cache, logout purge and device/push tests |
| SaaS/security/operations | Local capability isolation tested | Managed identity, MFA/invites/revocation, subscriptions/entitlements, platform console, privacy and restore/monitoring |

Register recount: customer 12 implementing / 34 not_started; barber 6 / 26; admin 23 / 24; SaaS 3 / 17; other acceptance/quality/notification/roadmap/integration rows 9 / 35. Total 53 / 136. Do not convert this into a completion percentage: implementing is partial, requirements differ in size, and some share the same foundation. No production verified/accepted rows. Preserve all original scope decisions.

### Reproduced findings — OPEN, not fixed by this audit

| ID / priority | Evidence and impact | Required improvement |
| --- | --- | --- |
| AUD-01 / high, next slice | `sandbox.ts:294–338`: 503 valid API-created appointments in a new isolated shop returned only 500. Earliest appointment disappeared from list AND leave-impact warnings, but direct detail still returned it. Availability correctly returned day-off. This is read/operational visibility failure, not deletion or demonstrated overbooking. | Server-side date/status/staff/search queries with deterministic cursor `(start_at,id)`; separate complete impact/summary queries; independently paginated audit history. Never merely increase LIMIT. |
| AUD-02 / medium, next slice | Browser: edit Signature cut to £33 and Skin fade to £39; save Signature cut. Dialog closes; reopening shows £33 retained, Skin fade blank. Named save is correct for one record but silently discards another dirty section. | Keep dialog open and preserve other drafts after per-section save, or deliberately implement atomic save-all; test multi-section and stale-version behaviour. |
| AUD-03 / medium, next slice | Browser: edit Skin fade to £41, press Escape, reopen: blank without confirmation. `ui.tsx:262–276` also wires backdrop/Close directly to dismissal; only Escape was reproduced. | Shared dirty-state confirmation for Escape/Close/backdrop/navigation, plus pending-mutation dismissal policy. Do not blindly persist private drafts to localStorage. |
| AUD-04 / policy risk, before finance | API: appointment on 2026-10-05 passed CHECKED_IN → IN_SERVICE → COMPLETED on 2026-09-14, without an override reason. No-show alone has a time guard. | Agree permitted early/backdated transitions and privileged corrections; enforce server-side and audit reason. Do not arbitrarily ban legitimate early arrivals. Completion must not make premature pay-run eligibility. |
| AUD-05 / medium, next slice | Synthetic response fault: replacing workspace `staff` with null produced `Cannot read properties of null (reading 'filter')`, empty root and no recovery UI. `main.tsx:75–76` renders Workspace outside the preview error boundary. No actual corrupt D1 response was observed or created. | Workspace-specific render boundary and validated response shape; preserve honest ambiguous-save wording and offer recovery without claiming nothing was saved. |

**AUD-01 reproduction details:** POST `/session`; use the default 30-minute service and two staff; create 503 future bookings across non-Sundays, starting two days ahead, at 540/585/630/675/720/810/855/900/945/990/1035 local minutes, with fresh request IDs and current quote versions. Add day off for the first booking's barber/date, GET workspace, GET first booking by ID, GET availability. Confirm 500 list entries, first ID absent from list/issues, detail exists, slot reason day off. Successful audit shop `73bd29b7-fad5-4fe7-9528-dd4831fc3903`, first booking `9c6e5640-1e96-49b9-8c74-9e5aa69bcaaf`, date 2026-09-16. An initial 501-row attempt did not establish omission of the chosen ID because two staff shared the earliest start; 503 removed that tie ambiguity. Both fictional shops remain locally; no triggers disabled or existing shops altered. Future regression should use an injected/fixed clock where applicable and assert desired complete results, not codify this defect.

AUD-02/03 screenshots: `test-results/audit-rules-390.png` and `test-results/audit-rules-1440.png`, generated and visually inspected. Matte styling remains coherent, labels readable, no observed horizontal clipping in these views. The long multi-service dialog is scroll-heavy; separate per-rule saves are easy to misunderstand. These ignored screenshots and inline audit probes are not new permanent passing regression tests. Normal UI probe had zero page errors; AUD-05 intentionally triggered one. Add permanent tests when fixing each issue.

### Code-inspected engineering/release gaps

- **AUD-06 — production access and abuse boundary:** current seven-day browser capability is intentionally owner-only. No managed memberships, logout/revocation/recovery or rate limiter. Input has a 16,384-character check, but only after reading the full body; add byte/stream limits before expensive parsing plus endpoint-specific abuse controls before public exposure. Existing Origin, tenant scoping, hashed cookie and CSP protections are real but not production authentication.
- **AUD-07 — maintainability/performance:** Workspace is 2,229 lines, sandbox router 1,193. Extract API/recovery, queries and feature editors incrementally; retain shared domain rules and DB guards. All preview components are eagerly imported into the same client entry. Consider route splitting and measured payload/API budgets before growth, not a framework rewrite. Local timings are not edge-load evidence.
- **AUD-08 — traceability and recovery:** audits are append-only but generic catalogue edits do not retain reconstructable before/after values. Add privacy-safe changed-field metadata and correlation IDs, export/pagination and operational issue ownership. Only booking creates have payload-bound replay: add idempotency systematically before introducing financial/delivery side effects. A health endpoint showing configured persistence is not a DB restore or readiness test.
- Customer identity should use stable customer IDs and consent/access grants before portal/history; do not interpret shared phone numbers as unique persons. This does not silently pull the deferred full CRM-merge UI into MVP.
- Sensitive notes need minimization/retention/access review, including how immutable historical records support lawful pseudonymization. Never load owner-wide data into a barber/customer UI and hide fields client-side.
- No actual provider, Safari/Firefox, physical device, load, screen-reader, penetration or restore acceptance was performed. Region-specific Stripe/Terminal availability and native/PWA promises remain separate gates.

### Market/quality assessment

A limited check of official SQUIRE, Booksy and Fresha pages found waitlists, reminders/no-show protection, connected checkout, client history and reporting promoted as mainstream capabilities. See BUILD_PLAN audit section for dated links and proposed additions. This is advertised feature evidence, not a tested ranking or verification of vendor performance claims. Our opportunity is a fast, dependable barber-specific working day and exceptionally clear Model A finances—not simply more screens or AI-labelled controls. No new scope or financial model approved by this comparison.

### Audit verification

The prior audit completed `npm test` and `npm audit --audit-level=high` successfully: 42 unit/route/domain tests, direct D1 checks, 54 browser/API tests, zero reported dependency vulnerabilities. Report `test-results/runs/1789390332489-47050/results.json`, started 2026-09-14 12:52:12 UTC, duration 80.27 seconds, zero failed/skipped/flaky; report re-read during this clarification turn. `npm run build` also passed after the suite. Runtime sources/migrations/tests remained at c1350a4; audit notes were auto-backed up in 05599ae before this clarification. No new runtime tests or migrations were run for this documentation-only direction change. Earlier migration bootstrap evidence belongs to WP-LOCAL-02.

## Exact next work package: WP-LOCAL-03A — original UI, saved calendar

0. **D-014 visible goal:** reuse the original admin shell, navigation, resource calendar, date/barber controls and mobile agenda, connecting them to persisted appointments and existing create/detail/reschedule/status APIs. Integrate setup/catalogue/team/schedule functionality into that same interface. Preserve backend/data/tests; no second replacement design or cosmetic redirect to fixture-only screens. Compare actual before/after screenshots at desktop/tablet/phone sizes before calling the consolidation complete.
1. Fix AUD-01 with tenant-scoped server date/status/barber/search/cursor reads and admin pagination; separate complete impact/summary reads and paginate audit. Prove >500 records, tied timestamps, no cross-shop access and no disappearing near-term appointments.
2. Fix AUD-02/03/05: preserve multi-section drafts, confirm dirty dismissal, define pending-save closure, and add workspace render recovery/response validation. Reproduce failures first as focused tests; retain all existing regression cases.
3. Extract only the query/API/editor boundaries needed for those fixes. No broad refactor, recolour or new framework.
4. Follow with WP-LOCAL-03B: connect customer and assigned-barber **test** journeys through least-data shared APIs with explicit local test grants/labels, not owner-cookie role impersonation or reused fixture authority. Include customer → owner → barber → completed visit and failure/reload workflows.
5. Follow with separately bounded WP-LOCAL-03C holds/expiry/late-confirmation proof before payment-dependent flows. Resolve AUD-04/O-09 time policy before financial eligibility.
6. Production identity, memberships/invites/MFA and customer verification remain explicit gates; develop their authorization contracts alongside test surfaces. Provider activation and deployment stay paused. Keep the persistent handoff; do not restart planning.

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
