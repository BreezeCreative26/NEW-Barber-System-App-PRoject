# Barbershop OS — Quality gates and evidence

Version 1.3 · 2026-09-14. D-012/D-013 retain the matte styling and local-only development. Current evidence: 42 unit/route/domain tests, direct local D1 invariants and 54 browser/API cases, all passing in the unchanged-source final regression. All 21 mutation routes have Origin/session/invalid-input coverage. New tests cover add-on/service links, exact aggregate durations, price/duration overrides, disabled coverage, dated replacement shifts, snapshot preservation and selection/conflict recovery alongside the complete earlier regression. The full migration chain also passed on an empty local D1 database. See PROGRESS for exact report and screenshots. The production acceptance catalogue remains incomplete: local workspace tests do not prove managed identity, checkout holds, payments, notifications or PWA acceptance.

## 1. Status vocabulary

FEATURE_REGISTER status is one of:

- `not_started`: not implemented.
- `designing`: task/interaction contracts and composition in progress.
- `implementing`: implementation incomplete.
- `blocked`: cannot meet acceptance; named blocker in PROGRESS.
- `ready_for_test`: implementation present; proof pending.
- `verified`: required tests passed with evidence.
- `accepted`: verified and user/milestone acceptance recorded.

Treatment is separate from implementation: `retained`, `adapted`, `superseded`, `deferred`, `scope_decision`, `policy_decision`, `added`. A superseded feature is not an implemented feature. A later release is not automatically approved for the current launch.

Milestone statuses: `not_started`, `in_progress`, `blocked`, `verified`, `accepted`. Keep gate `pending` until actual acceptance. Documents delivered does not imply M0 approved by the user.

## 2. Definition of done for every feature

All applicable items must pass. Any not-applicable item needs a reason.

1. Feature and decision IDs identified; no silent scope change.
2. Complete interaction inventory for all visible controls.
3. Shared design tokens/components; correct layout and content hierarchy.
4. Loading/empty/offline/pending/error/success/forbidden behaviour.
5. Server validation, authorization and tenant isolation.
6. Correct durable storage and reload/session behaviour.
7. Idempotency or safe replay for relevant mutations.
8. Auditable side effects; appropriate provider/account context.
9. Keyboard, focus, labels, contrast and touch behaviour.
10. Responsive screenshots inspected at required sizes.
11. Domain/API/browser tests pass; no console errors or unhandled requests.
12. Tests include one realistic failure/recovery route, not only happy path.
13. Any credentials/provider/manual-device limitations explicitly recorded.
14. Feature register and PROGRESS updated with test/screenshot evidence.
15. Changes committed with a descriptive message and no secrets.

No toast-only fake actions. No client-side role switcher presented as production authorization. No mocked successful bank transfer. No fixture data labelled as real revenue. No hidden broken control to claim completion unless the feature is explicitly out of approved scope.

## 3. Test layers

| Layer | Tool / method proposed | Coverage |
| --- | --- | --- |
| Static | TypeScript, lint, dependency checks | Types, unused/dead code, unsafe patterns |
| Domain | Vitest | Pricing, rounding, policies, state transitions, slot rules |
| Database/API | Actual local D1 integration + HTTP tests | Atomic claims, constraints, auth, tenant boundaries, idempotency |
| Browser | Playwright | Complete flows, every visible control, desktop/mobile, errors |
| Accessibility | axe-core + manual keyboard/screen-reader review | Automated issues plus interaction semantics and announcements |
| Provider | Stripe sandbox and test webhooks; Twilio/Resend controlled test recipients | Real integration account contexts, delivery, retries |
| Device | Physical supported phones/tablets and reader | PWA install/push/cache, Terminal, native features if in scope |
| Operations | Reconciliation runs, fault injection, backup restoration | Recovery rather than optimistic success |

Do not substitute an in-memory SQLite mock for proof of D1 transaction behaviour. Do not mark a hardware gate passed using a simulator alone.

## 4. Risk-first acceptance catalogue

### Scheduling / booking

| Test ID | Scenario | Expected |
| --- | --- | --- |
| T-SLOT-01 | Two concurrent same-slot requests within 50 ms | Exactly one reservation; other 409; no partial claims |
| T-SLOT-02 | Many concurrent overlapping starts of differing durations | No overlapping service-plus-buffer allocations |
| T-SLOT-03 | 25-minute service plus 10-minute buffer on 15-minute start grid | Exact occupancy; later start only when whole interval fits |
| T-SLOT-04 | Two workers reclaim same expired hold | One new owner; no lost active claims |
| T-SLOT-05 | Hold expires during authentication/payment | Reservation ownership rechecked; late success cannot overbook |
| T-SLOT-06 | Admin reschedules into a taken slot | Old reservation remains intact; useful conflict response |
| T-SLOT-07 | Concurrent walk-in and public booking | Shared allocator arbitrates; no admin bypass |
| T-SLOT-08 | Service override/add-on changes duration | Quote and availability both recomputed |
| T-SLOT-09 | Shop holiday or staff suspension with future bookings | Stop new slots and surface affected bookings |
| T-TIME-01 | Europe/London DST gap and repeated hour | No invalid local appointment or ambiguous duplicate identifier |
| T-TIME-02 | Exact 24h cancellation threshold | Documented policy matches both API and UI |
| T-TIME-03 | Service ends at shift edge or adjacent to break | Agreed buffer/break policy enforced consistently |
| T-BOOK-01 | Duplicate booking submit or browser back/resubmit | Same operation result; no duplicate reference/payment |
| T-BOOK-02 | Reschedule then refund | Payment allocations and audit remain connected |
| T-BOOK-03 | Reference enumeration | Reference alone never grants private access |

### Tenant / security

| Test ID | Scenario | Expected |
| --- | --- | --- |
| T-TENANT-01 | Shop A requests Shop B booking by ID | Denied without data exposure |
| T-TENANT-02 | Shop A creates booking with Shop B staff/service/customer IDs | Rejected before any durable mutation |
| T-TENANT-03 | Tamper tenant ID in filter/export/webhook metadata | Server context governs; no leak or wrong-account operation |
| T-TENANT-04 | Background job or cache contains wrong shop context | Rejected or isolated; no delivery to another shop's customer |
| T-TENANT-05 | Barber opens another barber's private earnings/refund route | Least-privilege policy enforced |
| T-AUTH-01 | Revoked invite, expired invite, repeated claim | No unauthorized membership |
| T-AUTH-02 | Suspended user with old valid-looking client cache/session | Server denies mutation; cache clearing/access guidance applies |
| T-AUTH-03 | Guest/customer enters another person's phone | No booking disclosure without verification |
| T-AUTH-04 | Admin MFA/session recovery and sensitive financial action | Correct reauthentication and audit |
| T-SEC-01 | Cross-site form/API mutation with cookie auth | CSRF/origin policy rejects |
| T-SEC-02 | Script/HTML payload in notes/reviews/search | Safe rendering and no executable content |
| T-SEC-03 | OTP/invite/hold abuse | Rate limits and abuse controls apply per relevant identity/context |
| T-SEC-04 | Upload or export malicious filename/formula content | Safe type/size/path rules and CSV formula escaping |

### Payments / ledger / manual pay-runs

| Test ID | Scenario | Expected |
| --- | --- | --- |
| T-PAY-01 | Change checkout amount in client payload | Server quote remains authoritative |
| T-PAY-02 | Deposit succeeds; browser closes before redirect | Verified event confirms valid reservation and outbox delivery |
| T-PAY-03 | Decline or SCA cancellation | Preserve form; safe retry while hold valid |
| T-PAY-04 | Network timeout after payment submission | Query existing attempt before any retry; no second charge |
| T-PAY-05 | Invalid signature, duplicate or out-of-order webhook | Reject invalid event; process valid events once with correct final state |
| T-PAY-06 | Wrong shop Stripe account context | Reject; never cross-account customer/payment/refund access |
| T-PAY-07 | Partial/full refund after service move or recorded pay-run | Correct refund state and explicit ledger reversal/adjustment |
| T-PAY-08 | Shop restricted or disconnected mid-checkout | No false success; actionable recovery issue |
| T-PAY-09 | Captured card charge void attempted | Correct refund path; do not claim uncaptured cancellation |
| T-LEDGER-01 | £40 service + £5 tip; 30% shop share; £5 deposit | Before fees shop £12 and barber £33; deposit counted once |
| T-LEDGER-02 | Remaining balance paid cash to shop vs barber | Actual custody reflected; no fake Stripe balance |
| T-LEDGER-03 | Rounding at fractional share percentages | Integer-pence total preserved with documented remainder policy |
| T-LEDGER-04 | Refund/tip/correction after earlier report | Reversal trail and report reconciliation rather than overwritten history |
| T-RUN-01 | Re-run same approved batch today or next day | Frozen membership/totals; no duplicated external-payment record |
| T-RUN-02 | Concurrent approval of overlapping periods | Same earning entitlement allocated at most once |
| T-RUN-03 | Record external payment | Clear owner attestation; no bank API call; actor/date/reference recorded |
| T-RUN-04 | Record first two items then fail/retry third | Successful items untouched; remaining item recoverable |
| T-RUN-05 | Wrong recorded amount or reference | Audited correction with authorization; original preserved |
| T-RUN-06 | No eligible earnings or uncertain bank balance | Honest empty state; no claim of verified bank funding |
| T-RUN-07 | CSV totals vs frozen batch | Exact reconciliation and restricted export access |

### Notifications / PWA / SaaS

| Test ID | Scenario | Expected |
| --- | --- | --- |
| T-NOTIFY-01 | Provider transient failure then recovery | Bounded retries without duplicate customer confirmation |
| T-NOTIFY-02 | Cancel or move booking after reminder scheduled | Old reminder suppressed by booking version/status |
| T-NOTIFY-03 | Booking less than 24h before start | Agreed short-notice rule; no past-due spam |
| T-NOTIFY-04 | Permanent SMS failure | Visible delivery issue and agreed email fallback |
| T-PWA-01 | Install on supported iOS and Android paths | Correct name/icon/start URL and truthful platform instructions |
| T-PWA-02 | Previously synced last-24h queue; network disabled | Navigate cached permitted records; timestamp and offline banner |
| T-PWA-03 | Fresh install offline with no data | Honest empty offline state; not fabricated queue |
| T-PWA-04 | Logout or shop switch on shared device | Old private caches removed; no cross-user read |
| T-PWA-05 | Service worker update during checkout | No forced refresh or loss of pending-payment context |
| T-PWA-06 | Unsupported push or denied permission | Usable non-push fallback and no repeated coercive prompts |
| T-SaaS-01 | Subscription trial upgrade downgrade cancel and payment failure | Provider-verified entitlement/grace behaviour |
| T-SaaS-02 | Billing webhook references another tenant/account | No wrong-shop subscription mutation |
| T-SaaS-03 | Platform support entry | Explicit scope and auditable privilege; no accidental tenant impersonation |
| T-OPS-01 | Restore database/uploads to isolated environment | Demonstrated recovery and checked referential/financial integrity |
| T-OPS-02 | Webhook/outbox backlog or failed refund | Actionable monitoring without sensitive payload leakage |

## 5. Visual and interaction test matrix

Required browser viewports: 320x800, 390x844, 768x1024, 1024x768, 1440x900. Also use landscape, 200% zoom, long names, large currency values, empty lists and pagination.

For every affected screen:

- No unintended page overflow, clipping, overlapping labels or obscured sticky actions.
- Layout hierarchy, typography, spacing and alignment match approved design.
- Tap targets, keyboard focus order and visible focus work.
- Menus/drawers/dialogs close predictably and return focus.
- Form errors preserve input and move focus appropriately.
- Search, filters, dates, tabs, pagination and back navigation produce the correct data/state.
- Financial actions show actual pending/outcome states.
- Each visible link/button has a test or a documented manual result.
- Console has no unexpected errors and network responses are handled.

Use deterministic fixtures with a frozen clock for visual snapshots, but also test real persisted workflows. Store selected evidence under `docs/evidence/` only when generated; avoid committing private data or enormous screenshot collections. Snapshot diffs require human inspection; do not auto-accept just to make CI green.

## 6. Evidence format

In PROGRESS, each test entry records:

`Test ID | feature IDs | command/method | environment/fixture | result | evidence path | limitations`

Example structure only (not an executed test):

`T-SLOT-01 | C-12 AC-01 | concurrent HTTP test | local D1 / two clients | pending | none | allocator not built`

Evidence should name the tested commit or work package. Do not invent test filenames, screenshots, deployment URLs or provider results.

## 7. Gate policy

- G0: user reviews planning scope and approves next work package.
- G1: representative design reviewed and architecture spikes evidenced. A blocked provider spike remains an explicit dependency.
- G2: tenant/auth/setup tests and migration checks pass.
- G3: concurrency/time/hold invariant tests pass.
- G4: provider sandbox, refund, webhook and notification recovery tests pass.
- G5: daily operation and PWA checks pass; actual reader/device checks for advertised support.
- G6: ledger, reports and manual pay-run tests pass.
- G7: SaaS billing, privacy/security review, monitoring and restore evidence.
- G8: pilot user acceptance, no unresolved critical/high defects, explicit production sign-off.
- Native gate: actual-device and store requirements whenever native features are launch scope.

A missing integration cannot be replaced by a success toast to pass a gate. A narrow demo can be shared with disclosed limitations but must not be called production-ready.

## 8. Severity and regression policy

- Critical: money duplication/loss, tenant leakage, exposed credentials, unsafe reservation integrity. Stop release; fix first.
- High: core booking/payment inaccessible, destructive action wrong, lost records, broken access revocation. Release blocker.
- Medium: degraded noncritical workflow, recoverable stale display, important responsive/accessibility issue. Resolve before acceptance unless explicit limited-pilot exception.
- Low: cosmetic inconsistency without task obstruction. Track and fix; never silently abandon.

After a bug: reproduce, add regression test, fix root cause, re-run neighbouring workflows, update evidence. Test impacted features after shared component/domain changes.

## Enhancement integration gates — D-014/D-015

The existing passing suite does not prove the original UI is connected or close audit defects. The following are **pending acceptance contracts**, not tests already implemented or passed. Add them to the relevant API/browser tests while implementing the named slice.

| Contract | Features / finding | Required evidence |
| --- | --- | --- |
| T-ENH-01 Main interface continuity | A-02/A-12/X-02..04, D-014 | Original-style sidebar/header/calendar and mobile agenda; one obvious main entry; no saved-looking fixture data; compare before/after five-width screenshots |
| T-ENH-02 Complete calendar data | A-02/A-09/A-10, AUD-01 | >500 records, tied timestamps, past/near/future queries, cursor boundaries, concurrent insertion behaviour and complete independent issue/summary queries; two-shop denial |
| T-ENH-03 Original-UI saved lifecycle | A-03..08/B-12/C-26 | Create on selected date/barber, reload, inspect original items, move, status/cancel; failure retains original allocation and idempotent retries do not duplicate |
| T-ENH-04 Multi-row save safety | A-19/A-20, AUD-02 | Edit two service rules, save one: other draft preserved or explicit atomic save-all; stale-version rejection and reset-to-inherit keep zero distinct |
| T-ENH-05 Dirty and pending dismissal | X-01/X-02, AUD-03 | Escape/Close/backdrop/in-app navigation warn when dirty; pending mutation policy prevents ambiguous repeat; explicit discard and save both tested |
| T-ENH-06 Render and response recovery | X-01/X-12, AUD-05 | Fault-injected response/render error yields actionable workspace recovery, not empty root; no claim that a pending operation could not have saved |
| T-ENH-07 Complete setup availability | A-13..21/A-28 | Existing setup CRUD remains reachable in original navigation; weekly/dated/full-day precedence, affected-booking warnings, quote refresh and preserved historical items |
| T-ENH-08 Customer-to-barber journey | C-01..19/B-09/B-13/S-02/S-03 | Persisted customer-test booking appears for owner and assigned barber; role-specific APIs expose minimum fields and reject other users/shops; no owner-data role switch |
| T-ENH-09 Policy-safe visit status | A-07/A-08/S-20, AUD-04/O-09 | Approved early/backdated/override rules enforced at server with audit; no premature financial eligibility; keep tests pending until policy chosen |
| T-ENH-10 Placement and accessibility | X-03/X-04 | Five widths, landscape, 200% zoom, mobile keyboard, long names, large totals, dense/empty data; no clipping/overlap; keyboard and screen-reader checks plus axe |
| T-ENH-11 Measured task performance | X-13, D-015 | Report environment/dataset and lab or field status for payload/API/Web Vitals and booking/walk-in task times; do not mark target values as measured outcomes |

At closure of WP-LOCAL-03A rerun the complete regression on unchanged source, inspect screenshots and demonstrate retained saved records. Production role/provider/device acceptance remains separate. Planning review only validates document consistency, requirement preservation and evidence references; it is not a new runtime regression.

## 9. Automation roadmap

Automation includes `typecheck`, `test:unit`, `test:db`, `test:e2e` and combined `test`. Local D1/API tests now prove appointment conflicts, snapshot/audit guards, transaction rollback, tenant-negative operations, versions and replay. Browser tests require PM2 and local migrations. Playwright artifacts use a unique run directory to prevent concurrent cleanup collisions; do not launch overlapping tests unnecessarily. Dedicated lint/CI and production identity/provider/device tests remain to implement. Secrets stay in ignored local vars or deployment secret stores; all current test data is fictional.

Per work package: affected fast tests plus a browser smoke pass. Per milestone: full relevant suite, screenshot review, tenant-negative tests and recorded gate decision. Before production: clean build, smoke checks on final URL, backups/restore proof, external integration checks and owner approval.
