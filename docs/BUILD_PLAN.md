# Barbershop OS — Build plan

Version: 1.5 · Updated: 2026-09-14 · D-018 resumes building after D-017's pause. E1 enhances the connected original-style timetable and local setup; see section 14 and PROGRESS for delivery/evidence, then review before E2. D-012/D-014 preserve matte colours, original layout and nothing live. Section 13 retains the later account/permission roadmap; customer/barber identity and operational integration remain incomplete. WP-001-A-R1 recolouring stays cancelled. Production SaaS is not complete.

**Current comprehensive enhancement plan:** [Section 12 — feature-by-feature improvements, delivery order and acceptance](#12-comprehensive-enhancement-and-modernisation-plan). Earlier sections preserve the architecture, Model A, original requirements, milestones and decisions; section 12 makes their next execution concrete rather than restarting the plan.

## 1. Mandate and sources of truth

Build a commercially credible, multi-tenant barbershop SaaS: public booking website, shop admin web panel, barber PWA, customer booking access, and a platform-owner console. Quality means correct financial and scheduling behaviour, polished accessible interfaces, observable failures, and maintainable code—not just a completed screen.

Read `PROGRESS.md` for the actual implementation state. This plan describes intended work, not shipped features.

- `DECISIONS.md`: confirmed choices, changes to the original functional map, unresolved questions.
- `FEATURE_REGISTER.csv`: all original C/B/A feature IDs plus SaaS and cross-cutting requirements.
- `DESIGN_SYSTEM.md`: visual direction, layout rules, interaction contracts, design approval process.
- `QUALITY_GATES.md`: test requirements and definition of done.
- `PROGRESS.md`: current milestone, evidence, blockers, next actions, session handoff.
- Root `AGENTS.md`: mandatory start/end-of-session workflow.

Latest explicit user decisions take precedence over older specification details. Never silently delete a feature or change its release bucket. Proposals require approval; mark superseded requirements with a decision reference.

## 2. Confirmed product boundary

- Many independent shops subscribe to the same SaaS, with isolated records and finances.
- Single location per shop initially. Independent SaaS tenants are not the same as multi-location management.
- Customer booking works in a browser without installation.
- Shop administration works on desktop/tablet with responsive access on phones.
- Barber PWA is installable on supported devices; safe offline viewing is explicitly designed.
- Payment model A: customers pay each shop directly through the shop's Stripe account.
- The app calculates barber earnings and manual bank pay-runs. The owner segregates funds and executes bank payments outside this app initially.
- No platform-held customer wallet, shop-to-barber Stripe transfers, automatic bank payment execution, or implied custody in this release.
- SaaS subscription payments to the platform are separate from haircut payments to a shop.
- Native Expo app and phone Tap-to-Pay remain separate deliverables. Their original MVP tags are not silently removed; approve launch scope at G0.
- No production financial service, authentication, provider approval, domain, or deployment currently exists.

## 3. Product surfaces and information architecture

Routes below are proposed contracts; none is implemented unless PROGRESS says otherwise.

| Surface | Proposed routes | Primary tasks |
| --- | --- | --- |
| Public marketing | `/`, `/pricing` | Understand product, choose plan, start onboarding |
| Identity | `/sign-in`, `/invite/:token`, `/onboarding` | Sign in, claim invitation, configure shop |
| Public shop booking | `/book/:shopSlug`, `/book/:shopSlug/confirmation` | Select service, barber, slot, details, deposit |
| Customer portal | `/my-bookings`, `/booking/:opaqueAccessToken` | Verify access, view bookings, receipts, review |
| Shop admin | `/app/overview`, `/app/calendar`, `/app/bookings` | Operate today's shop, search, resolve exceptions |
| Catalogue and people | `/app/services`, `/app/team`, `/app/clients` | Manage catalogue, staff, permitted customer notes |
| Finance | `/app/finances`, `/app/pay-runs`, `/app/reports` | Reconcile collections, calculate and record manual settlements |
| Settings | `/app/settings/shop`, `/app/settings/policies`, `/app/settings/billing` | Shop setup, policies, subscription |
| Barber workspace | `/barber/today`, `/barber/earnings`, `/barber/profile` | Queue, visit actions, receipts, personal earnings |
| Platform operations | `/platform/shops`, `/platform/subscriptions`, `/platform/issues` | SaaS operations with separate privileges |

PWA: web manifest, suitable icons, service worker, update experience, restricted cache policy and offline routes. Installation alone does not equal native functionality.

## 4. Technical approach

### One modular backend, not microservices

- Hono + TypeScript for API and page delivery on Cloudflare.
- React + TypeScript + Vite for interactive web interfaces; extend the existing Hono scaffold instead of replacing it with Next.js.
- D1 for authoritative relational data. No application-memory balances, reservations or production file databases.
- R2 for private uploads and explicitly public branded assets.
- Managed authentication provider, selected before M2. Real sessions, invitation lifecycle, MFA, account recovery and revocation.
- Zod or equivalent shared request validation; strict response contracts.
- Stripe Connect shop account flow, proposed direct charges. Prove account ownership, Payment Element, Terminal and refund behaviour in test mode before committing the final provider model.
- Stripe Billing for SaaS subscriptions, with separate webhook handling and entitlements.
- Twilio, Resend and web push for web delivery. Expo Push is for the future native app, not a PWA push substitute.
- Server scheduling and reliable delivery via separately configured Cloudflare scheduled Workers/Queues or an approved external scheduler. Do not rely on site visits to send reminders.
- Sentry/structured logs without customer notes, payment secrets or invitation tokens.

React, TypeScript, Zod, Vitest, Playwright, axe and Wrangler dependencies are installed. Inspect actual versions before adding packages. Runtime code uses Cloudflare-compatible Web APIs; development scripts may use Node. D-012 permits browser-owned capability sessions for isolated local testing only; managed identity remains mandatory before real private shop data.

### Deployment boundary

The user owns-account Cloudflare production path is recommended but not yet formally selected. Do not deploy or incur provider charges from this plan alone. The default hosted workflow supports the web/API and D1/R2, not arbitrary cron/queue configuration. Confirm the deployment path and activate the matching available deployment skill when deployment is requested. Never add unsupported hosted bindings to make scheduling appear implemented.

Native build/signing, Apple/Google store distribution and physical-reader certification/testing are outside the web preview.

### Tenant isolation

Every private data request resolves an authenticated principal and server-verified shop membership. `shopId` from a URL or form is not authorization. Public routes resolve a shop slug but return only an allowlisted public projection.

- Scope queries, unique constraints, relationships, jobs, object keys, exports and caches to tenant.
- Use composite tenant-aware foreign keys where appropriate; reject cross-tenant staff/service/customer references.
- A platform role is not an ordinary shop admin; privileged support access must be explicitly authorized and audited.
- Test negative access for every object/action class with at least two shops.
- Start with a shared D1 database for the controlled pilot; measure contention, storage and throughput. Design a tenant-to-database routing boundary for later partitioning, not premature per-shop databases.
- D1 shared databases do not supply application row-level authorization automatically. Enforce it centrally, and test it.

### Role and capability baseline

This matrix is a proposed server authorization contract; finalize exact staff privileges during M2. A walk-in is a booking source, not an authenticated role. Membership in more than one tenant must never merge their records.

| Capability | Shop owner/admin | Barber | Verified customer / secure guest grant | Anonymous visitor | Platform operator |
| --- | --- | --- | --- | --- | --- |
| Public catalogue and slots | Yes | Yes | Yes | Yes | Public access |
| Create customer booking | Staff flow | Authorized staff flow | Own booking | Guest flow with protected confirmation access | Not by platform privilege alone |
| Private booking detail | Current shop | Assigned scope | Own/granted booking only | No | Explicit audited support scope only |
| Change catalogue/hours | Current shop | View in MVP; own editing v1.5 | No | No | No implicit access |
| Check-in/service/payment | Current shop | Assigned scope | Online checkout only | Own checkout session only | No implicit access |
| Cancel/reschedule | Current shop with policy/audit | Only if explicitly granted | v1.5 policy actions; contact shop in MVP | No unverified private action | No implicit access |
| Refund | Authorized shop admin | No | Request only | No | No implicit access |
| Approve/record manual pay-run | Owner/explicit financial privilege | No | No | No | No implicit access |
| Earnings and reports | Shop-wide under financial privilege | Own earnings only | Own receipts only | No | Operational aggregates only by default |
| SaaS billing | Shop owner | No | No | No | Authorized subscription operations |
| Platform console | No | No | No | No | Separate privileged role |

## 5. Domain model to implement

| Module | Core records | Invariants |
| --- | --- | --- |
| Identity / tenancy | Shop, User, Membership, Invitation, Session linkage | Least privilege; hashed, expiring single-use invite tokens |
| SaaS | Plan, Subscription, Entitlement, BillingEvent | Subscription state comes from verified provider events; enforce entitlements server-side |
| Catalogue | Service, Addon, ServiceAddon, BarberService | All prices integer pence; historical snapshots never change |
| Scheduling | WeeklyShift, Break, Holiday, TimeOff, ReservationClaim | Shop timezone; no overlapping claims across any booking channel |
| Customers | Customer, ConsentRecord, PrivateNote | Stable ID; phone is normalized lookup data, not identity proof |
| Appointments | Booking, BookingItem, BookingEvent | Immutable audit; separate appointment and financial states |
| Payments | PaymentAttempt, Payment, Refund, PaymentAllocation, WebhookInbox | Provider/account identifiers scoped correctly; deduplicate retries |
| Accounting | LedgerAccount, LedgerTransaction, LedgerEntry, CashRecord | Balanced postings, no editable balance field, explicit reversals |
| Manual settlements | PayRun, PayRunItem, EarningsAllocation, ManualPaymentRecord | Frozen batch; earnings allocated once; records do not initiate bank payments |
| Notifications | NotificationOutbox, DeliveryAttempt, PushSubscription | Versioned reminders; retries and delivery status |
| Reviews | Review, Reply | One eligible review per completed booking; safe public rendering |
| Operations | AuditEvent, Issue, ReconciliationRun | No secrets in logs; actionable failures with ownership |

Avoid designing payment records around exactly two PaymentIntent columns; allow multiple attempts, refunds, and eventual split payment without destructive migrations.

## 6. Booking and availability contract

1. Calculate availability from shop hours, closures, eligible staff, staff shifts/breaks, overrides, service/add-on durations, existing appointments, holds and the buffer.
2. UI displays starts on a 15-minute grid. Resource occupancy must cover exact duration plus buffer; grid starts alone are not collision protection.
3. The local slice uses SQLite BEFORE INSERT/UPDATE overlap triggers inside the booking write transaction, plus D1 batches for audit consistency. Direct-D1 and simultaneous HTTP tests prove exact interval/buffer rejection for appointments. This replaces the earlier time-unit-claim candidate for this slice; checkout holds and expired-hold reclamation are still unimplemented.
4. Check on selection for feedback; enforce again atomically on hold acquisition/submission. Conflicting request receives `409 slot_taken`.
5. Use server-issued expiring holds and server time. Release expired claims transactionally during acquisition as well as scheduled cleanup; correctness cannot depend on cleanup timing.
6. Changing service, barber, add-ons or duration invalidates and rechecks the selected slot.
7. Admin moves and walk-ins use the same allocator. Acquire the replacement allocation before releasing the old one, atomically.
8. Prefer same booking identity on reschedule plus immutable events. Replacement booking semantics remain a decision until approved.
9. Store actual instants in UTC and shop IANA timezone. Weekly schedules use local wall time; explicitly test nonexistent and repeated DST times.
10. If payment succeeds after reservation ownership is lost, do not confirm over another booking. Record a payment-resolution issue and follow a tested refund/recovery policy.
11. Staff suspension invalidates future selection and surfaces affected pending/future appointments; never silently loses paid bookings.

Proposed appointment states: `HELD`, `CONFIRMED`, `CHECKED_IN`, `IN_SERVICE`, `COMPLETED`, `CANCELLED`, `NO_SHOW`, `EXPIRED`. Payment states are separate. Define and enforce allowed transitions with actor and reason requirements. Provider payment decline must preserve form/retry opportunity while the hold remains valid.

## 7. Model A money and manual pay-runs

### Customer collections

Proposed flow: customer -> shop-connected Stripe account -> shop bank according to Stripe payout schedule. Cloudflare records and reconciles, but does not hold funds. Confirm Connect configuration/fees/liability with Stripe; do not infer it from UI labels.

- Deposit is a part-payment of service total, not additional revenue or a second deduction from earnings.
- Choose one meaning for commission: proposed explicit `shopShareBps`; barber share is the remainder. Snapshot the rule per booking.
- Service commission excludes tips; tips are allocated 100% to the barber before any separately agreed processing-fee policy.
- Cash is recorded separately. Confirm whether shop or barber physically received it; it cannot increase Stripe available funds.
- Refunds and later adjustments generate reversals, not edits to historical postings.
- Saved-card consent and off-session no-show consent are different and versioned.
- `ChargesEnabled`, `PayoutsEnabled` and provider requirements matter; one onboarding boolean is insufficient.

### Finance presentation

Distinguish gross collections, refunds, processing fees, service earnings, cash received, outstanding barber entitlement, already recorded bank payments and shop share. Stripe available balance is not the same as profit or cash in the shop bank. Never promise the app verifies bank funds without an actual banking integration.

### Manual pay-run lifecycle

`DRAFT -> APPROVED -> PARTIALLY_RECORDED -> RECORDED_PAID`, with draft/approved cancellation rules. “Recorded paid” means an authorized owner attested an external payment; not bank-confirmed settlement.

- Choose period and eligible completed service earnings.
- Preview line items, policy snapshots, tips, cash adjustments and prior allocations.
- Freeze membership and totals on approval; unique allocation constraints prevent overlapping batches paying the same entitlement.
- Owner exports payment instructions and makes bank transfers externally.
- Owner records per-item paid date, amount, recipient and payment reference; confirmation explicitly states no bank transfer will be initiated.
- Partial recording retries cannot duplicate successful items.
- Wrong manual record is corrected with an audited reversal/adjustment; protect approved history.
- Do not collect raw bank details merely to display them. Decide safe recipient management before bank-formatted exports; the initial earnings CSV can omit bank data.
- Never reintroduce automated barber Stripe payouts without a new decision and supported integration.

Example before processing fees: £40 service + £5 tip, shop share 30% => shop £12, barber £33. A £5 deposit is included in £40; £40 remains to collect including the tip. Who absorbs fees and cash adjustments is still an explicit policy decision.

## 8. Milestones, dependencies and exit gates

Estimates are intentionally not fixed until architecture spikes and launch scope are approved. Work in testable vertical slices, not all screens followed by a backend rewrite.

| Milestone | Scope and deliverable | Dependency | Exit gate |
| --- | --- | --- | --- |
| M0 — Planning | These documents, feature register, decision log and baseline audit | None | User reviews scope/open decisions; G0 records approved next work |
| M1 — Design proof + technical spikes | Proposed tokens; customer slot selection, admin calendar and barber queue at real sizes; D1 collision proof; Stripe Model A proof; PWA capabilities matrix | M0 | G1: design direction reviewed; risk spikes have evidence, blockers documented |
| M2 — Tenant foundation + shop setup | Managed identity, shop/membership, admin MFA, invite lifecycle, audit, service/add-on CRUD, staff shifts and shop settings | M1 auth/data decisions | G2: two-shop isolation; setup survives reload; no fake login or role controls |
| M3 — Booking core | Availability, holds, customer details, immutable quote/items, public booking flow, admin calendar and walk-ins | M2 + allocator spike | G3: conflicts/buffers/DST/expiry tests; no client-authoritative totals |
| M4 — Collections + communications | Shop Connect onboarding, deposit checkout, webhooks, secure customer access, outbox/reminders, receipts, admin refunds/reschedules | M3 + provider configuration | G4: end-to-end sandbox booking/refund; delayed/duplicate events; reminder invalidation |
| M5 — Daily operations + PWA | Queue, check-in/in-service/completion/no-show, cash, tips, one Terminal flow, offline queue read, install/update flow | M4 + reader proof | G5: simulated working day, supported physical device tests, cache privacy checks |
| M6 — Finances + reports | Ledger reconciliation, manual pay-runs/CSV/payment records, reports, review eligibility and notifications, operational issues | M4–M5 financial events | G6: every amount traceable; overlapping/retried batches safe; no implied bank execution |
| M7 — SaaS commercial readiness | Subscription onboarding, entitlements, platform console, support processes, exports/retention, monitoring and restore drill | M2; integration alongside M3–M6 allowed | G7: billing lifecycle, isolation audit, recovery, provider readiness and security review |
| M8 — Controlled pilot + release | One-shop pilot, then second independent tenant; observe live workflows; close blockers | G1–G7 | G8: approved release checklist, no critical/high unresolved defects, production sign-off |
| M9 — Native scope if retained for launch | Expo, native auth/session handling, PaymentSheet, push, offline cache, supported Tap-to-Pay | Early M1 feasibility, stable APIs | Separate mobile gate: real-device and store requirements; not replaced by PWA |

M9 numbering does not authorize moving original native MVP requirements out of launch. G0 must resolve whether native is launch-blocking. Likewise full month/week calendar, instant payouts and self-service controls keep their original tags with explicit adaptations/conflicts in the register.

### M1 initial work package (implemented as preview; not final visual acceptance)

1. Begin with the reversible working name Barbershop OS and proposed charcoal/teal direction. References may refine it; do not block the first local design proof on final branding. User visual approval still required before broad rollout. No paid image generation without consent.
2. Produce a static, clearly labelled reference implementation of three representative screens—not the entire product. Use realistic fixtures, not production claims.
3. Review desktop admin (1440 px), tablet calendar (1024/768 px), phone customer and barber flows (390 px and 320 px).
4. Define shared component/interaction contracts and log approval before propagating layouts.
5. Run isolated allocator and Stripe account-context feasibility spikes. If credentials are unavailable, mark the Stripe spike blocked, not passed.
6. Turn results into the M2 task list; reject approaches that require major rework later.

### Execution sequence — build-ready work packages (v1.2)

User requested starting the build and a concrete execution plan. Do not produce another planning reset or require a blanket approval to begin the first local work package. This does not approve unresolved financial policy, native scope, paid services, public GitHub publication or production deployment.

| Package | Deliverable the user can inspect | Work included | Exit evidence |
| --- | --- | --- | --- |
| WP-001-A | Three-screen local design preview | Admin day calendar; customer service/barber/date selection; barber Today; shared visual components and preview state controls | Actual screenshots at required sizes; UI controls tested; labelled fixtures; no fake auth or payment |
| WP-001-A-R1 | Cancelled by D-012 | Keep the current matte forest/sage palette | Do not execute recolouring |
| WP-LOCAL-01 | Persisted local shop and appointment workflow | Browser-owned test sessions; local D1; staff/services/settings/hours/closures; availability; bookings; status and reschedule; audit | Domain, direct-D1, API isolation/concurrency and browser tests; no production identity or provider calls |
| WP-LOCAL-02 | Verified local catalogue and dated-hours slice | Add-on/service links, immutable booking items, barber coverage/price/duration rules, dated replacement shifts/breaks | 42 unit/route tests, direct D1 guards, 54 browser/API tests; clean migrations and unchanged-source full regression |
| WP-LOCAL-03A | Next: original-style admin UI and persisted calendar (D-014) | Reuse original shell/navigation/resource calendar/mobile agenda with saved booking actions; integrate setup/team/catalogue; fix AUD-01/02/03/05 reads and recovery | Original-layout screenshots, calendar create/reload/move/status flows, >500 records, cross-shop denial, complete warnings, preserved drafts and render recovery |
| WP-LOCAL-03B | Connected customer/barber test journeys | Shared catalogue/quote/availability, minimal projections and explicit local test grants; customer → owner → assigned barber workflow | No owner-wide records exposed to role-specific screens; complete persisted journey, reload/conflict/recovery tests; production identity still gated |
| WP-LOCAL-03C | Checkout reservation proof | Expiring server holds and atomic reclamation across booking channels; delayed/duplicate confirmation handling | Concurrent acquisition/reclamation, expiry boundaries, lost-response recovery; no provider activation |
| WP-001-B | Technical risk results | D1 interval allocation and expired-hold proof; Stripe Model A account-context checklist/proof when credentials available | Concurrency test evidence; explicit provider blockers; no architecture assumption marked proven |
| WP-002-A | Private shop setup | Auth provider adapter; owner membership; tenant authorization; shop setup; first services and staff; reload persistence | Two-shop isolation tests and working setup flow |
| WP-002-B | Complete scheduling setup | Service/add-on CRUD; barber coverage/price/duration; weekly shifts; breaks; time off; holiday handling; audit | Validated forms plus API tests; history preserved |
| WP-003-A | Book without payment in a controlled test workflow | Public catalogue; validated quote; server slot engine; hold; customer details; reference; admin calendar; walk-in | Reservation and DST tests; test workflow explicitly not live checkout |
| WP-004-A | Real sandbox deposit booking | Shop Stripe onboarding; Payment Element; payment attempts/inbox; confirmation; customer access | Decline/retry/late-success/account-context tests; no real charges |
| WP-004-B | Complete change-and-notify lifecycle | Reminders/outbox; confirmation delivery; admin cancel/refund/reschedule; customer receipts/history | Provider delivery and retry evidence; no stale reminder or stranded payment |
| WP-005-A | A functioning barber working day | Queue; check-in; start service; completion; no-show; cash; tips; supported internet reader | End-to-end working-day simulation plus physical-reader evidence for advertised support |
| WP-005-B | Installable and safely offline PWA | Manifest/icons; install/update UX; restricted cached queue; offline/reauth/logout; supported web push | Real-device capability matrix; offline and cache isolation tests |
| WP-006-A | Reconciled finances and manual pay-runs | Financial ledger integrated incrementally from WP-004-A; earnings; frozen batches; export; externally paid records; reports | Reconciled figures and duplicate/overlap/correction tests; no bank execution claims |
| WP-006-B | Reviews and operational recovery | Verified review eligibility; permitted review display; notifications; actionable error inbox | Review and failed-payment/refund/delivery recovery tests |
| WP-007-A | SaaS commercial controls | Shop subscriptions; trial/grace/entitlements; owner billing; platform console; tenant suspension/support | Billing event lifecycle and server entitlement tests |
| WP-007-B | Release candidate and pilot | Privacy/accessibility/security review; monitoring; restore drill; one then two independent shop pilots | Gate checklist; resolved blockers; explicit production approval |

These are implementation slices inside the existing milestones, not a deletion of week/month calendar or other original requirements. Use the feature register for all remaining milestone coverage. Native M9 is a separate branch of work if retained for launch; do not imply PWA implements native features.

### First implementation checklist — WP-001-A

Evidence for the initial preview is recorded in PROGRESS. Checked items refer to the first working implementation, not the D-011 theme refinement or production features. Browser zoom-equivalent reflow was tested; full actual-zoom/device acceptance remains separate.

- [x] E-001 Inspect actual Hono/Vite packages and renderer; add only the React/client build and test dependencies needed while preserving Cloudflare compatibility.
- [x] E-002 Create reusable typography/spacing/colour tokens, buttons, inputs, status badges, sheets, alerts, empty states and safe-area layout.
- [x] E-003 Provide explicitly labelled `/preview/admin`, `/preview/book` and `/preview/barber` routes. Preview navigation cannot impersonate authenticated roles.
- [x] E-004 Admin proof: date navigation, barber filter, calendar event details and create-booking form interaction. Display fixtures honestly; no claim that an appointment has been saved.
- [x] E-005 Customer proof: choose service and extras, choose barber, choose date/time, validate contact form and review summary. Stop at a clear sandbox-payment integration boundary; never show paid confirmation.
- [x] E-006 Barber proof: chronological fixture queue, appointment detail, contextual action layout and finance breakdown. State previews are labelled examples; no actual charge or manual payment attestation is simulated as real.
- [x] E-007 Add deliberate loading, empty, error and offline preview scenarios; each visible control either performs its stated preview action or explains the integration boundary before interaction.
- [ ] E-008 Verify keyboard navigation, focus return, modal dismissal, disabled reasons, long names, 200% zoom and 320/390/768/1024/1440 px layouts.
- [x] E-009 Build and run the local preview using the mandated PM2/port-3000 workflow; inspect actual browser screenshots and console/network output.
- [ ] E-010 Share a working preview with limitations, update evidence/status and commit. Record visual feedback before expanding the design.

Related feature IDs: A-02/A-03/A-12, C-01/C-03/C-06/C-10/C-11/C-16..C-19, B-09..B-11, X-01..X-04. Their business-function status remains not_started until the actual production-contract implementation starts; preview-only progress belongs to E-001..E-010.

### Current functionality-first sequence (D-012)

1. **WP-LOCAL-01 — Local persisted foundation, now implemented.** Retain the matte appearance. `/workspace` connects local D1 setup, weekly schedules, closures, appointments, audited transitions and conflict-safe rescheduling. These are test-owner capabilities, not production roles. Full-day staff leave is now persisted with availability and write-time guards. WP-LOCAL-02 now adds persisted add-ons/item snapshots, barber eligibility/price/duration rules and dated replacement shifts/breaks. The whole-app audit reproduced incomplete lists/impact warnings and unsafe dirty-form dismissal. Next WP-LOCAL-03A fixes these and workspace render recovery, followed by connected customer/barber test surfaces and a separate hold/expiry proof.
2. **WP-001-B — Prove data safety.** Implement/test an atomic D1 allocation spike including intervals, buffers, expiry and simultaneous requests. Define tenant-aware schema and payment account-context contracts; do not mistake fixture helpers for real availability. Stripe execution waits only on Stripe credentials.
3. **WP-002-A/B — Complete setup and production identity separately.** Basic saved shop/staff/services/hours screens exist in WP-LOCAL-01. Full-day leave, add-ons, staff service rules and dated partial-day shifts are implemented/tested locally. These do not satisfy production identity or all public-interface acceptance conditions. Managed authentication, memberships, MFA and invitation lifecycle remain explicit production gates; provider selection does not block local functional work.
4. **WP-003-A — Real booking lifecycle.** Replace fixture catalogue/slots with tenant-scoped APIs, hold and booking allocation; connect customer selection and admin calendar. Add conflict feedback and atomic walk-in/reschedule operations. Pass concurrency and timezone tests before adding payments.
5. **WP-004-A/B — Shop-owned payments and delivery.** Connect shop Stripe accounts, deposits/refunds, verified webhooks and ledger postings; then durable notifications/reminders and secure customer booking access. No live mode without explicit readiness/sign-off.
6. **WP-005-A/B and WP-006-A/B — Working day, PWA and finances.** Persist visit transitions, cash/card/tips and receipts; implement actual installation/offline-cache rules; reconcile manual pay-runs and reports. Never present offline-state examples or a tip calculator as real operational persistence.
7. **WP-007-A/B — Commercial SaaS launch.** Subscription lifecycle, server entitlements, platform operations, monitoring, restore test and two-tenant pilot.

Do not ask whether to redesign or restart architecture. The user has cancelled recolouring and requested functional build-out with nothing live. Ask only blocking provider/policy decisions at the point they matter. Preserve original release-scope flags and keep all local examples clearly separated from production capabilities.

### D-014 — build on the original preview, not a replacement workspace

The user explicitly prefers the original preview layout, calendar, navigation and interactions. The functional backend is valuable, but the alternate workspace interface is not the product direction. WP-LOCAL-03A must deliver visible consolidation: original-style admin shell/calendar backed by saved appointments, with existing setup/catalogue/team/schedule features integrated into its navigation. Reuse original presentation and the tested API/domain/mutation layers; do not discard either or simply redirect the user to fixtures. Customer and barber surfaces follow the same original-design continuity in WP-LOCAL-03B. Keep one coherent main application and clearly isolated fixture-only test scenarios.

UI/UX refinements are welcome within that original layout and matte forest/sage/teal baseline. No new palette is specified by the user's mention of colour ways; the cancelled recolouring is not reinstated. This is a direction decision, not implemented runtime consolidation. No deployment or provider activation.

### Whole-app audit priorities — 2026-09-14

This refines the existing execution order; it is not a planning restart or approval to expand launch scope. Detailed reproductions AUD-01 through AUD-05 and inspected gaps AUD-06 through AUD-08 are in PROGRESS. Runtime baseline is c1350a4; all findings remain open until a tested implementation closes them.

**Recommended build order:**

1. **Original UI plus reliable saved calendar (WP-LOCAL-03A, D-014).** Bring the original admin shell/calendar into the persisted app with existing booking actions and integrated setup navigation. Complete server-side booking queries, summaries/impact warnings and audit pagination; safe drafts and render recovery are part of that integration. Reuse original presentation and existing backend, not a rewrite or another competing screen set.
2. **One connected working day (WP-LOCAL-03B).** Public-style test booking → persisted owner calendar/day view → assigned-barber queue → visit completion. Use least-data projections and explicit test grants. Define real membership/permission/customer-grant contracts alongside this work so test owner access never becomes production role authorization by accident.
3. **Reservation and policy proof (WP-LOCAL-03C / WP-001-B).** Holds, expiry, races and failed/late confirmation. Agree O-09 lifecycle timing/booking horizon and privileged correction rules. Resolve deposit/commission/fee/cash policy before money code. Preserve same-booking snapshot defaults unless explicitly changed.
4. **Payment and accounting lifecycle together (WP-004-A/B).** Once separately authorized/configured, shop-account test-mode charges, verified webhook inbox, ledger postings, refunds and reconciliation; durable notification outbox with a reliable scheduler. Design receipt/balance/earnings models at first collection, not after checkout is finished. Until provider activation is approved, use clearly labelled contract/fault tests, never claim integration success.
5. **Daily close and transparent owner-paid earnings (WP-005/006).** Cash recipient, tips, remaining balance, receipts, reconciled close-of-day and frozen manual pay-runs. Trace each amount back to visits/collections/reversals. Owner-attested external payment remains distinct from bank confirmation.
6. **Safe PWA and commercial operations (WP-005-B / WP-007).** Restricted cache/install/update/device proof; production identity/MFA/revocation complete before real access; tenant subscriptions/entitlements/support, exports/retention, observability and restore. Run a whole-shop simulation before any explicitly approved pilot, then prove second-tenant isolation. No launch from passing local UI tests alone.

Production identity, privacy, migrations and observability are cross-cutting work, not cleanup left until launch. Provider decisions should not block the allowed local slices. Week/month calendar, remaining original features and native decisions retain their register scope.

#### Market gaps to validate, not silently add

Official vendor pages inspected on 2026-09-14:

- [SQUIRE Wait List](https://getsquire.com/features/wait-list): advertises automatic opening notifications and first-confirmed booking.
- [Booksy features](https://biz.booksy.com/features): advertises automated waitlists, booking lead-time rules, family/friend appointments, client histories, reminders, reporting and calendar/client import.
- [Fresha scheduling](https://www.fresha.com/for-business/features/scheduling): advertises waitlist matching, resource scheduling, group appointments, deposits, client profiles and team scheduling.

These are vendor claims and feature descriptions, not independently tested quality, country/plan eligibility, pricing or market-share evidence. Do not copy vendor payout assumptions into Model A. We have not established that Barbershop OS beats these products.

| Candidate | Why it matters | Dependency / approval boundary |
| --- | --- | --- |
| P-01 Cancellation waitlist and fair offer expiry | Recover unused chair time; conspicuous omission from the current feature register | Hold allocator + durable notifications + customer consent; distinct from the unresolved in-shop queue display. Define who receives offers and how one winner is allocated. |
| P-02 Rebook last visit / repeat-visit convenience | Reduce friction for regular haircut customers | Stable customer identity and current-price review; recurring series needs its own conflict/cancellation rules, not blind duplication. |
| P-03 Assisted migration/onboarding | Shops need to bring clients, future appointments and opening balances without duplicates | Validated import preview, dry-run, per-row errors, deduplication and rollback strategy; never guess historical consent/payment outcomes. |
| P-04 Family/dependent booking | Parent/contact may book several people sharing a phone | Model booker separately from service recipient; consent/access/privacy rules and explicit scope approval. |
| P-05 Operational exception centre | Owners need to act on failures, not hunt through screens | Extend existing planned S-14: affected appointments, failed delivery/refund, unbalanced close, restricted payment account; action owner, status and retry history. |
| P-06 Cash close and clear earnings statements | Strong fit for Model A and owner trust | Extend planned cash/ledger/report coverage with counted cash versus expected, variance reasons, fee/refund adjustments and external-payment attestation. |

P-01..P-04 are proposals outside the existing register, not new accepted requirements. P-05/P-06 sharpen planned capabilities, not delivered features. Keep the 189 rows unchanged until scope decisions are recorded. Prefer validated barber needs over broad salon inventory, multi-location, automated payouts or AI features that conflict with existing boundaries.

#### Measure quality instead of claiming “best”

Proposed acceptance targets (not measured achievements or approved SLAs):

- Test with at least five representative owners/barbers and five customers; target >=90% unassisted success on core booking/visit/close tasks. Observe failures and time-on-task; do not treat a tiny sample as market proof.
- Mobile booking target under 90 seconds excluding payment authentication; returning-client rebooking under 30 seconds; basic walk-in under 30 seconds. Use the same tasks/data/device conditions when comparing alternatives.
- Core Web Vitals targets at the 75th percentile on supported mobile devices: LCP <=2.5s, INP <=200ms, CLS <=0.1. Define API p95/load budgets with measured D1 data and expected shop concurrency before setting an SLA.
- Demonstrate complete daily views and issue queries at 10,000 appointments per test shop and multiple tenants; test stable pagination under ties and inserts. Passing a 503-row reproduction is not a capacity benchmark.
- Zero accepted overlap/duplicate-collection/duplicate-earnings-allocation outcomes across the agreed adversarial tests; every amount reconciles and every failed operation has recoverable state. This is a test acceptance condition, not a promise that software can never fail.
- Manual screen-reader/keyboard/zoom checks plus Safari/Firefox/Chromium and physical iOS/Android PWA/shared-device testing. Automated axe and Chromium alone are insufficient.
- Define recovery-point/recovery-time objectives with the owner; pass an isolated restore drill including relationships and financial totals before pilot. Establish error/outbox/webhook alerts, PII scrubbing, provider-cost/usage visibility and incident ownership.

### Build boundaries and required inputs

- Continue without provider credentials: local persisted vertical slices and tested database invariants, retaining current matte styling.
- Before production identity in WP-002-A: select/configure managed authentication. Browser-owned sandbox capabilities are not real login or staff roles; APP_MODE is enabled only in ignored local .dev.vars.
- Before booking policy finalization: resolve deposit, commission meaning, exact time/buffer/no-show rules. Show provisional fixture values as examples only.
- Before WP-004-A: securely configured Stripe sandbox and approved shop account model. Never request secrets in chat.
- Before WP-004-B: scheduler and controlled notification credentials/recipients.
- Before WP-005-A reader acceptance: supported physical device and shop-account Terminal proof.
- Before WP-006-A approval: fee/cash allocation, eligibility cutoffs and external-payment recording policy.
- Before WP-007-A billing: plans, pricing, limits and subscription grace rules.
- Before public launch: selected Cloudflare deployment path, domain, operational checks and explicit sign-off. GitHub upload remains blocked until private visibility or explicit public publication is confirmed.

### Delivery rhythm

At the start of each package: state the IDs, deliverable and gate. At the end: report what works, show preview/evidence, list known limitations, update PROGRESS and commit. Keep one package active; run financial architecture work early enough to avoid rewriting already-shipped collections. Do not promise calendar dates until the technical spikes and external setup are measured.

## 9. Release buckets and scope control

The original 125 numbered features remain in FEATURE_REGISTER with original scope. Milestones organize implementation, not permission to cut features. Additional SaaS and quality requirements have S/X IDs. Version 1.5/2 features are planned but not built by default.

Conflicts to resolve include fixed vs per-service deposit, self-service shortcuts vs deferred cancellation, staff-editable hours vs admin-only MVP, native launch requirements, direct shop collections vs barber Connect payouts, review display without reviews, multi-location out-of-scope vs roadmap, and calendar two-way sync newly appearing in the roadmap.

Original out-of-scope boundaries: PAYE payroll; barbers across shops; chat/SMS cancellation bot; metered walk-in display; loyalty combined with retail; custom service-by-barber commission. Multi-location/queue display conflict with later roadmap and need explicit decisions.

## 10. Security, privacy, accessibility and operations

- Tenant-scoped authorization, object reference tests, CSRF/origin controls where cookie sessions are used, session rotation/revocation, rate limits for OTP/holds/search/invites.
- Short PIN is a local/device convenience, never sole remote authentication. Invitation credentials are not staff profiles.
- UK phone parsing supports valid inputs without equating phone ownership to identity. Handle shared/recycled numbers deliberately.
- Health-related notes can be sensitive data: collect minimally, restrict roles, define retention and consent/lawful basis with appropriate review.
- Booking audit retention and account erasure are reconciled through minimization/pseudonymization, not a promise to retain all personal data forever.
- Hosted route access and application record permissions are distinct; use platform access tools if that deployment path is selected.
- WCAG 2.2 AA target; semantic elements, keyboard/focus tests, readable errors, reduced motion and non-colour status cues.
- Outbox and webhook inbox are durable. Reconciliation jobs recover dropped external callbacks; delivery retries have limits and dead-letter visibility.
- Backups are not verified until restore is tested. Establish recovery objectives before pilot.
- No analytics session replay on checkout, customer notes, invitation tokens or private payment screens by default.
- Performance budgets in DESIGN_SYSTEM are measured targets, not claims of current performance.

## 11. Efficient execution rules

- One active work package, with explicit feature IDs, gate, smallest testable slice and remaining blockers.
- Reuse components and domain functions; never implement mobile and admin pricing separately.
- Define mutation contracts before wiring buttons. Do not add a visible control without a behaviour and permission contract.
- Use fixtures only in tests/design previews, visibly labelled. Never return fake provider success to simulate completion.
- Make migrations explicit and reversible/recoverable; do not mutate production schema ad hoc.
- Install only needed dependencies. Assess calendar resource-view licensing before selecting a library.
- Automate repeatable checks; run affected tests per change and full smoke suite per milestone.
- Review screenshots after changes to shared layout, typography, components or navigation.
- Update tracker and progress in the same commit as delivered work; keep sessions small and traceable.
- User approval of visuals does not override failed functional or security gates.

## 12. Comprehensive enhancement and modernisation plan

Requested 2026-09-14; continuation of D-014, not a rebuild. This section is an actionable proposal for enhancing every existing area and completing the wider product. Plan approval does not mark features implemented or authorize providers/deployment. Work starts from the original interface and current tested backend; changes are delivered and reviewed in small, complete slices.

### 12.1 Honest starting point

Revision checked: 9a1a416; application baseline c1350a4. The current app has two disconnected UI layers: the preferred original fixture preview and a simpler persisted owner-test workspace. Consolidating them is the first user-visible outcome, not optional polish.

| Register area | Total | Implementing (partial) | Not started |
| --- | ---: | ---: | ---: |
| Customer | 46 | 12 | 34 |
| Barber | 32 | 6 | 26 |
| Admin | 47 | 23 | 24 |
| SaaS | 20 | 3 | 17 |
| Acceptance, quality, notifications, integrations, roadmap | 44 | 9 | 35 |
| **Total** | **189** | **53** | **136** |

There are zero production verified/accepted feature rows. These counts are not a completion percentage. Original scope tags include 125 MVP rows across all areas, 25 v1.5, 34 added and 5 v2; this is separate from the 125 original customer/barber/admin IDs. Superseded and deferred rows remain visible but are not necessarily work to implement unchanged.

Previous verification: 42 unit/route/domain tests, direct local D1 checks and 54 browser/API tests passed. The audit also reproduced open defects outside those test cases (AUD-01..05). No new tests, feature delivery, device acceptance or visual fixes are claimed by this planning update.

### 12.2 Modernise the experience, not replace the design

Keep the original sidebar/header, resource calendar, mobile agenda, customer steps and barber bottom navigation. Use existing matte forest/sage/teal, consistent white surfaces and rounded geometry. Modernisation means clearer hierarchy, readable density, faster actions, progressive disclosure, reliable state and fewer surprises. No blanket dark-mode/theme-builder, new colour palette or visual framework is required.

Proposed admin destinations, within the original shell: Calendar, Appointments, Team, Services & add-ons, Clients, Shop finances, Reports, Settings; add action-required issues where they are relevant. Destinations become normal navigation only when useful persisted functionality exists. Do not ship decorative empty sections, invented KPIs or finance samples as operational data. Keep a clearly marked test-mode banner, but remove fixture scenario controls from the eventual main workflow. Customer, barber and platform experiences have separate task/permission contexts, not an owner-data role toggle.

Detailed placement rules live in DESIGN_SYSTEM's enhancement checklist. Quality is checked on real rendered pages, with long labels/content, dense calendars, no results, failures, mobile keyboards, zoom and focus—not just attractive default screenshots.

### 12.3 Every existing feature: retain, connect, enhance

All rows below describe planned improvements, not new completion claims. Feature IDs point to existing register obligations; later-scope features retain their existing tags.

| Existing area / IDs | What is actually built | Enhancement and completion work | Acceptance evidence |
| --- | --- | --- | --- |
| App shell/navigation — X-01..04, D-014 | Original fixture shell; separate workspace | Reuse original shell, one obvious main entry, consistent active section/breadcrumbs, retained date/filter/back state, responsive navigation and render recovery | User can find calendar/setup without changing previews; keyboard and five-width screenshots; reload/deep-link recovery |
| Calendar/agenda — A-02/A-11/A-12 | Fixture day resource calendar; persisted day list | Bind original calendar to complete date-scoped API; fixed time/staff headers, readable short events, breaks/closures/leave overlays, current-time line, staff filter, safe detail drawer. Complete week/month in a separate follow-on, not in the first merge | >500-record completeness and stable ordering; no clipping at high density; keyboard creation/move equivalent; week/month remains open until tested |
| Appointments and walk-ins — A-03..08, B-12..15, C-26/C-29 | Reviewed create, snapshots, status and atomic moves | Consistent drawer with visit summary, original service/add-on items and history; explicit reschedule review; policy-aware next action; visible unsaved/pending state; clearer conflict alternatives and read-after-save recovery | Create/reload/move/status/cancel using original UI; same reference/snapshot; conflict retains old slot; no duplicate retry |
| Search, filters, pagination — A-10/A-12/C-04 | Client-side limited-list search/filter | Tenant-scoped server queries; date range/staff/status, clear-all chips, result counts, no-match guidance and stable cursors. Do not put customer names/phones in URLs or analytics | Near/past/future records found outside first page; cross-shop search denied; rapid typing cancels obsolete requests |
| Services/categories — A-17/A-18/C-01/C-05 | Persisted service fields and activity | Original-style directory with consistent price/duration columns, category grouping, active/inactive state, field-level validation and accessible edit sheet; add real description/popular/image fields when implementing their acceptance | Historical bookings unchanged; retained filter after edit; licensed/owner images with safe fallback; no fake popular/rating badges |
| Add-ons — A-21/C-03 | Catalogue, eligibility links, price and duration | Searchable eligibility selection, compact linked-service summary, exact extra time/price, deliberate deactivation feedback; customer add-ons never preselected to increase spend | Eligibility enforced by API; aggregate duration rechecks slots; review lists each item; zero-minute/free values handled |
| Barber coverage/rates — A-19/A-20/C-02 | Individual versioned rules | Searchable service rule panels or accessible table; obvious inherited/custom/disabled states; reset-to-default explanation; keep other edited rows when saving one | AUD-02 fixed; stale row cannot overwrite newer values; £0 stays distinct from inherit; moving bookings does not silently reprice |
| Staff directory — A-23/A-24/A-26/B-04 | Local profile text, active/inactive, search | Original team cards/detail sections, clear service coverage/schedule tabs; complete avatar/invite/suspended/access states alongside real identity; deactivation shows affected visits | Deactivation preserves records and stops selection; production deactivation also revokes membership/session; invite states not faked |
| Weekly hours/breaks — A-15/A-28 | Weekly shift and one break per day | Clear weekly grid, closed-state controls, time ordering validation, day-copy convenience with explicit review, timezone and buffer explanation | Identical UI/API boundaries; keyboard time entry; copy only mutates on explicit save; no hidden overlap |
| Leave, closures, dated hours — A-13/A-14/A-28 | Full-day leave, holidays, replacement shift/break | Unified availability section; clear weekly versus dated precedence; affected-booking list before confirmation and after save; linked appointments, restore-weekly action | Complete impact list beyond cap; race-time recheck; no silent cancellation; scoped to correct barber/date |
| Shop settings/policies — A-41..45 | Name/address/London hours/default policy values | Group profile, opening hours and booking policy; validation with example summary; disclose which values affect new versus historical bookings; add validated logo and complete service-deposit policy after decision | Saved/reloaded values and immutable snapshots match; no unsupported timezones; payments shown as unconnected until verified |
| Audit/recovery — A-09/S-14/X-01 | Append-only events, retries, stale conflict handling | Paginated history, actor/time/reason and privacy-safe changed fields; actionable issue links; correct loading/offline/error/forbidden state; dirty-form confirmation and render boundary | AUD-01/03/05 fixed; no falsely successful mutation; raw personal data/secrets absent from logs |
| Customer booking — C-01..19/C-25..34 | Original fixture journey; shared quote/slot APIs | Connect original service/barber/date/details/review sequence; real eligibility/next availability, plain-language price breakdown, no forced installation, preserve inputs on back/conflict. Add holds before checkout | Customer test booking appears in owner calendar; no fixture slot/price authority; selected unavailable time gets useful alternatives |
| Barber working day — B-08..18/S-20 | Original fixture queue; owner-test visit APIs | Connect original Today/earnings/profile layout with assigned-booking-only API; current/next/upcoming grouping, clear check-in/start/complete controls, allowed notes/history and last-refreshed state | Two barbers cannot read each other's restricted records; actions update owner view; service state never implies a card collection |

UI convenience proposals such as copy-day hours or an optional density setting should be implemented only as small, validated improvements within these packages, not as new speculative systems. Drag/drop rescheduling, if added, needs touch/keyboard alternatives and confirmed server success; never optimistically label a conflicted move saved.

### 12.4 Complete the missing product capabilities

| Capability / register coverage | Functional deliverable | Required dependencies and failure handling |
| --- | --- | --- |
| Identity and shop onboarding — S-01..03/S-18, A-24/A-47, B-01/B-02 | Owner setup, managed sign-in, memberships, MFA, invitations/revocation/recovery; barber and customer authorization | Provider selection is separate from local contract tests. Test two shops, stale sessions, invitations and least privilege. Do not postpone permission design until after connecting private surfaces |
| Public shop entry and customer access — S-08, C-18/C-33..37, A-30 | Shop slug/public projection, optional email, verified guest/customer grants, upcoming/past/cancelled visits, legitimate notes/history boundaries | Stable customer ID, consent and retention; expiring/revocable grants, no reference/phone-only disclosure. Self-service cancel/reschedule C-38..40 remains v1.5 unless approved |
| Reservation lifecycle — C-27, X-05/X-06/X-14 | Server holds with truthful expiry, bounded acquisition/release/reclaim and safe confirmation | Existing allocation extended transactionally; simultaneous channels, stale quote, expiry, abuse and delayed confirmation tested. No success after reservation loss |
| Shop-owned customer payments — C-20..24/C-28, A-25/A-34/A-35/A-45, X-07 | Approved shop Stripe account context, test checkout/deposit, saved-card consent, verified webhook inbox, refunds and reconciliation | Resolve deposits/fees/account model; protect signatures and account context; duplicate/out-of-order/late events, restricted accounts, browser close and refund failure tests |
| Cash/tips/receipts — B-17..24, AC-06 | Authoritative remaining balance, payment attempts, cash recipient, tips and receipt/delivery | Ledger from first collection; distinguish appointment/payment/refund state; payment-source totals reconcile. Terminal needs real supported hardware proof; native Tap-to-Pay not implied |
| Earnings/manual pay-runs — A-27/A-31/A-32/A-39, B-25/B-26/B-28, S-11..13 | Agreed share snapshots, eligible earnings, frozen allocations, export and owner-attested external-payment records | Resolve share/fees/cash/recipient policy; overlapping/repeated batches and post-run refunds/corrections safe. No money moved by the app |
| Reporting — A-01/A-36..39, B-08/B-30 | Accurate collected/earned/refunded/cash/occupancy/no-show/service-mix measures and drill-down/export | Written metric definitions, shop-local periods, reconciled historical amounts, authorized/formula-safe CSV; absence of data shown honestly |
| Communications — C-30/C-31/A-44, N/X-08 | Outbox, confirmations/reminders/change notices, channel settings, delivery attempts and retries | Agreed scheduler/provider path, consent/short-notice rules, booking-version invalidation and exhausted-delivery issues; no scheduled trigger assumed on unsupported hosted deployment |
| Reviews — C-41/B-30/B-31 | One eligible completed-visit review, genuine ratings/counts, reporting/moderation policy | Verified access, safe text rendering, deletion/edit policy; no fabricated five-star social proof. Barber replies keep v1.5 scope |
| PWA — S-09/S-10/B-16/AC-07 | Install/help/update flow, restricted previously synced queue and supported push | Real-device tests; expiry and logout/shop-switch purge; no private broad cache, background sync promise or offline payment/booking confirmation |
| SaaS platform — S-04..07/S-16 | Shop subscription onboarding, plan/trial/grace entitlements, owner billing and audited platform operations | SaaS funds separate from haircut funds; verified events, tenant-safe suspension/restore and usage-cost limits; platform role has no automatic client-note access |
| Operational readiness — S-15/S-17, X-11/X-12, I-01..04 | Secure storage/export/retention, support, structured monitoring, data restore, maps and privacy-safe analytics | No secrets/PII in logs; file validation and least-privilege R2; restore drill and incident ownership. Analytics/identity/provider activation needs separate permission |

Existing v1.5/v2 items (loyalty, customer memberships, gift cards, favourites, self-service changes, tax summaries, integrations and others) remain in the feature register. Native, multi-location, public queue display and ambiguous roadmap terms still need explicit scope decisions. Comprehensive planning does not mean launching every later feature at once.

### 12.5 Modern, useful additions worth validating

The prior official SQUIRE/Booksy/Fresha comparison in section 8 supports treating waitlists, dependable reminders, customer history, checkout and reporting as competitive basics, not novel differentiators. No new market scan or vendor usability benchmark was run for this update.

Prioritize P-01 cancellation waitlist, P-02 quick rebooking and P-03 safe migration/import once their foundations exist. P-04 family/dependent appointments is valuable if target shops need it. P-05 exception handling and P-06 cash close/transparent earnings strengthen already planned scope. Explicit consent, expiry, fair allocation, current-price review and import validation matter more than a slick button.

Optional ideas to user-test, not committed features: “next suitable slot” suggestions when a booking conflicts; quick command/search access for busy admins with a discoverable non-keyboard equivalent; a simple setup checklist; a concise end-of-day task list. Avoid packing every convenience into the first calendar merge.

AI is not a prerequisite for a modern app. If later desired, start with permission-scoped explanations of already reconciled reports or draft communications requiring review. Do not allow an AI feature to autonomously change bookings, quote financial entitlements, send messages, charge customers or infer sensitive customer traits. Provider costs/privacy and evaluation would be separate gates.

### 12.6 Execution order: small deliveries inside the existing milestones

These are substeps, not extra parallel projects. Each implementation must include relevant schema/API/UI/tests together; UI polish ships with each feature rather than as a giant final reskin.

| Order / existing package | Visible delivery | Exit condition / main dependency |
| --- | --- | --- |
| 1a — WP-LOCAL-03A query foundation | Complete date/staff/status/search reads usable by calendar and list | AUD-01 regression at >500 records, deterministic cursors, independent impact summaries, two-shop isolation; old endpoints retained during migration |
| 1b — WP-LOCAL-03A original calendar integration | Original shell/calendar/mobile agenda showing saved bookings; existing create/detail/move/status controls | Create/reload/reschedule from original-style calendar; existing data untouched; compare original/current screenshots; one main entry, no redirect to fake fixture data |
| 1c — WP-LOCAL-03A existing-feature polish | Team/services/add-ons/rates/hours/settings integrated into original navigation; consistent forms | All existing CRUD remains discoverable; AUD-02/03/05 tests; drafts and pending actions protected; five-width review. Close 03A only when all three substeps pass |
| 2a — WP-LOCAL-03B connected customer path | Original booking steps use shared catalogue/quote/slots; test confirmation visible to owner | Public projection and explicit test grant; no owner cookie/data reused as customer authentication; back/reload/conflict recovery |
| 2b — WP-LOCAL-03B connected barber day | Assigned test queue performs allowed visit actions and refreshes correctly | Least-data server authorization; end-to-end customer → admin → barber scenario; no fixture earnings/charges |
| 3 — WP-LOCAL-03C plus WP-002/003 completion | Holds, final time policies, customer-access and managed identity contracts; finish calendar scope in focused follow-on | Roles/privacy/expiry correctness before real private usage; native/week/month/provider decisions remain explicit rather than silently deferred |
| 4 — WP-004 | Collections/refunds plus ledger foundation and durable communications | Approved test-provider activation; full failure/retry/reconciliation proof, no live money/messages |
| 5 — WP-005/006 | Cash/tips/receipts, working-day close, manual pay-runs/reports/reviews; supported PWA | Money traceability and correction tests; scoped offline/device proof; finance policy and hardware dependencies |
| 6 — WP-007 / M8 release gates | Subscription/platform operations, observability/privacy/restore and controlled pilot | Existing WP-007-B covers release work and M8 pilot acceptance. No production until explicit approval and all applicable gates pass |

Identity authorization, migration safety, accessibility, logging and performance accompany every phase. Do not build the whole customer/barber UI around owner-only authorization and retrofit security later. No calendar-date estimates until 1a/1b establish measured delivery capacity; report small/medium/large scope and actual test findings per slice rather than promise “all features” in a few days.

### 12.7 Improvement acceptance and release discipline

For each delivered slice record: original requirement IDs; prior defect or user task; changed components/API/schema; test results; before/after screenshots; known limitations; next exact action; commit. Keep visual, local-functional and production-acceptance evidence distinct even when attached to the same feature row. Do not raise the register to verified simply because a page renders.

- **Visual:** original layout identity retained, consistent spacing/type/colour/controls, visible actions without clipped text or overlapping sticky areas at 320/390/768/1024/1440 widths, landscape and 200% zoom. Test dense and empty data, 100-character names, long service labels and the on-screen keyboard.
- **Interaction:** all visible controls have real outcomes and understandable disabled states; loading/error/offline/conflict/session-expired states recover; back/dismiss/reload behaviour is explicit. Avoid blanket autosave for financial/policy changes and no blind retry of ambiguous mutations.
- **Data:** saved appointments and historical price/items survive consolidation; no hidden cap, cross-tenant leaks, double bookings or destructive history rewrite. Concurrency and negative API tests protect every new data path.
- **Finance:** balances and reports reconcile to immutable movements; no duplicate charges/allocations; refunds and external-payment corrections remain traceable; Model A terminology is enforced.
- **Accessibility and performance:** automated axe plus manual keyboard/screen-reader/device checks; 44px touch-target design aim, readable focus/status; measured LCP/INP/CLS/API budgets per DESIGN_SYSTEM. Performance targets are not achieved merely by specifying them.
- **User enjoyment:** test representative book, change appointment, walk-in, staff-hours and day-close tasks with owners/barbers/customers; measure unassisted completion, time, errors and friction. Refine based on observed behaviour, not preference assumptions alone.
- **Operations:** valid migrations, isolated restore rehearsal, failure monitoring, secret/PII protection, support procedures and explicit pilot/release approval.

### 12.8 Decisions only when they block dependent work

No decision is needed to preserve the original shell, fix capped reads, protect drafts or improve spacing/accessibility. Before dependent features ask only the relevant question: fixed/configurable/service-level deposit (O-05); share meaning and card-fee/cash custody (O-03/O-04); booking horizon/lead-time/early completion and correction policy (O-09); auth/customer-grant and note privacy (O-07/O-10); reminder channels/scheduler (O-12/O-15); native/Terminal launch scope (O-02/O-06); SaaS pricing/limits (O-11); recipients/exports (O-14). New P-01..04 features need scope approval rather than silent insertion into the 189-row register.

**Delivery update:** the connected calendar slice below now implements selected-day reads and the original-style timetable with saved actions. Continue from the current code, not from an unimplemented 1a/1b plan. Remaining work is explicit below.

## 13. Active delivery and account/permission build sequence

Latest user instruction: stop planning-only cycles; make progress visible in the running development preview. Requested customer sign-up/sign-in, shop setup, barbers/services/prices, staff/admin accounts and permissions, timetable slot creation/moving/scheduling/cancellation and richer settings. “Live preview” means the local development service, not authorization for production deployment or provider activation.

### Delivered in the connected calendar slice

- Original-style forest sidebar and familiar heading/stats/calendar treatment, with all existing Team, Services, individual pricing, schedules, Settings and Audit actions reachable in the same `/workspace` app.
- Day timetable and agenda, week-date strip, date/staff/status/search controls, real selected-day counts and booked service value explicitly not collected revenue.
- Click a 15-minute cell to start a draft with barber/time selected; authoritative availability checks service/extras/buffer. Existing appointment opens details, reschedule and status/cancellation flows; saved history persists. Blocks mark off-duty, breaks, closures and leave; cancelled/no-show items appear separately and release time.
- `GET /api/sandbox/bookings` supplies scoped date reads with deterministic `(start_at,id)` pagination, optional staff/status filters and strict query validation. Main calendar reads all selected-day pages instead of the legacy 500 snapshot. Impact warnings query future active appointments independently.
- Multi-service pricing saves keep the dialog and other drafts open. Dialog Escape/backdrop/close protects dirty forms and refuses closing during a pending save. Workspace malformed responses and rendering exceptions have recovery instead of blank content.
- Accounts section accurately explains current browser-only test access and the three unfinished account experiences. It does not collect passwords or pretend to authenticate staff/customers.

Remaining 03A items: shop-wide/date-range search, independently paginated audit UI, scalable/paginated impact evaluation, more comprehensive response schemas, wider dismissal/navigation tests and deeper original-layout refinement. Current calendar is day/agenda plus week date navigation, not a full week/month resource view. No drag/drop or implemented customer/staff account is implied.

### Next: WP-LOCAL-04 — working test accounts and permissions, not login mockups

This is a prioritized implementation specification prompted by the user's latest request, not delivered functionality. Use a genuine sandbox-only identity adapter for local account tests if managed-provider configuration remains paused. Production managed identity/MFA/provider approval remains a separate gate. Do not use Genspark preview mock identity as customer/barber authorization.

| Delivery | Data/API/UI work | Required proof |
| --- | --- | --- |
| 04A Owner account and session lifecycle | Local fictional account sign-up/sign-in/sign-out; securely hashed/salted test credentials or approved managed-provider test adapter; expiring server sessions, rotation, byte limits and login abuse controls; honest unverified/local-only labels. Persist user-to-shop membership; let the existing browser capability claim only its own test workspace through an explicit migration action | No plaintext passwords/tokens in DB/logs/client bundle; wrong credentials generic error, session fixation/expiry/revocation tests; existing bookings retained; cannot claim an arbitrary shop ID; not yet production authentication certification |
| 04B Staff invitations and permission enforcement | Link staff profile to membership without treating profile role text as authorization. Owner issues hashed single-use expiring/revocable test invitation; local copyable link while no messages enabled. Staff signs in to own account, sees assigned calendar; owner controls permissions. Define protected owner/admin/barber scopes centrally | Cross-shop/other-barber denial on every read/mutation including existing sandbox routes; replay/revoked invite rejected; last owner cannot be removed; suspended staff session loses access; UI hiding never substitutes for API checks |
| 04C Customer account and booking ownership | Separate customer/account records, own-booking sign-in view and optional secure guest grant; add server-derived customer ID to new bookings. Do not auto-claim historical appointments by matching phone/email. Customer role never receives owner-wide workspace payloads | Customer A cannot read/cancel/move Customer B records; reference/phone alone never grants access; session expiry preserves safe recovery; original booking screen integrated with appropriate test grants |
| 04D Settings and account management | Owner settings for staff access/invites/session revoke; staff personal account view; customer account/contact preferences; distinct shop policies versus personal settings; auditable changes and verified contact-change/recovery design | Stale-version/conflict recovery, privilege escalation denied, credentials/contact data protected, sign-out clears approved private client state. Recovery requiring message delivery remains gated until provider activation |

Proposed initial authorization matrix, to confirm before implementation (do not invent elevated roles from arbitrary text):

| Action | Owner | Authorized admin | Barber | Customer |
| --- | --- | --- | --- | --- |
| Shop profile/policies/catalogue/pricing | Yes | Explicit grant | View assigned context only | Public projection only |
| Staff invite/role change/session revoke | Yes | Only explicitly delegated, never beyond own grant | No | No |
| Shop timetable and appointment operations | Yes | Explicit grant | Assigned scope and allowed transitions | Own/granted details; self-service change scope still explicit |
| Private notes/customer history | Purpose-limited | Explicit grant | Minimum needed for assignment | Own permitted projection, never internal staff notes |
| Refunds/finance/pay-runs/subscriptions | Yes under relevant privilege | Separate financial grant; no implicit owner powers | Own earnings/recorded payments only | Own receipts/payment attempts only |

04A and 04B should be separate tested deliveries, not a single giant auth rewrite. Apply authorization to legacy endpoints too; never leave an owner-capability bypass reachable by a lower-privilege session. Add immutable actor identity to audit while preserving historical sandbox actors. Use the next migration prefix 0005; do not rename the two existing 0002 files.

### Follow-on timetable and settings completion

1. Connect the original customer and barber task layouts using 04's real test memberships/grants; prove customer booking → owner timetable → assigned barber action in different browser sessions. Shop setup gets a short completion checklist with actionable links, not invented onboarding completion.
2. Complete week/month view in a bounded package, maintain selected staff/date/filter state, add safe direct-date lookup and full search. Any drag/drop is an optional convenience over the same reschedule API with keyboard/form alternative, review and conflict rollback.
3. Expand booking policy settings only after defining deposit rules, lead time/horizon, early/backdated completion, cancellation and privilege overrides. Individual price/duration/eligibility remains server-authoritative with historical snapshots.
4. Then reservation holds/expiry, approved provider test integrations, ledger/cash/tips/receipts, messages, finance/pay-runs, PWA and SaaS gates from sections 8/12. Do not fake delivery or financial success to make everything look available.

**Efficient session contract:** each authorized build turn begins with a narrow visible outcome, modifies the actual app, runs focused/full checks appropriate to risk, shares the running preview and ends with a commit plus next actionable package. Only blockers require questions; provider inactivity must not be used to postpone permitted local UI/data/permission work. Update this plan with delivered facts rather than reauthor it every session. D-017 below pauses further implementation while the user reviews enhancements to the existing app.

## 14. Existing-app enhancement pass — review before building (D-017)

User requested a comprehensive plan **before building anything further**, focused on enhancing what already exists. This section takes precedence over starting the account roadmap. Application baseline remains d6cb261; no runtime changes are part of this planning turn. Original-style connected calendar and settings already work locally; prior passed tests and screenshots are evidence of that baseline, not acceptance of the proposals below.

### Objective and boundaries

Make the current owner-test application feel coherent, readable, efficient and dependable. Preserve the original layout identity, matte forest/sage/teal palette, saved records, endpoint authorization, pricing snapshots and allocation guards. Extend current interactions only where they reduce friction or complete existing behaviour. No new design system/framework, database reset or starter app.

Not included: customer/admin/staff authentication, new membership/permission systems, payments, reminders, pay-runs, PWA, full week/month resource views, drag/drop, waitlists or new commercial modules. Those remain in sections 12/13 and are not cancelled. The Accounts page must remain clearly unfinished; the customer/barber references remain labelled samples, not production paths. D-012 continues to prohibit deployment/provider activation and real data.

### Existing-feature enhancement matrix

Each proposed change has a visible outcome and a testable finish. These are recommendations, not defects newly reproduced in this planning turn.

| Area | Enhancements to the existing feature | Completion test |
| --- | --- | --- |
| Main shell and navigation | Preserve forest sidebar and original visual identity; make Calendar/Appointments naming consistent, active location obvious, section headings consistent and content widths deliberate. Keep one main entry; reduce repetitive instructional text without hiding test-mode limits | A new user can locate booking, team, pricing, schedules and settings without switching previews; keyboard/mobile navigation remains accessible |
| Toolbar and calendar hierarchy | Consolidate date picker, previous/next, Today, view switch and staff/filter controls into a compact responsive hierarchy. Avoid multiple tall rows competing above the timetable; retain all existing controls and meaning | At 390px the first useful appointment/action is not buried beneath redundant controls; at 1440px controls align without unexplained gaps or collision |
| Calendar event readability | Standardise name/service/time/status hierarchy; show complete details on activation; distinguish staff colouring from visit status; label breaks, leave, closed hours and buffers with a small legend | Long names, 5/15/30/60-minute appointments, many barbers and empty/closed days remain understandable; colour is not the sole status signal |
| Selecting a slot | Make selected cell/barber/date obvious and retain a summary in the draft. Label the distinction between free chair time and service-specific availability. Consider a service selector before highlighting valid starts, or continue explicit service checking in the draft without calling a cell guaranteed available | A non-fitting service explains why and offers a valid alternative; no click reserves time or bypasses the backend. Existing buffered/concurrent rejection tests continue passing |
| Timetable keyboard/touch access | Keep agenda and form alternatives; reduce excessive tab stops through the grid using a tested keyboard-navigation pattern if introduced; larger operational targets and visible focus; clear contained horizontal scroll for many staff | Full add/open/move flow works without drag or pointer; phone users can choose agenda instead of a squeezed grid; no keyboard trap or hidden focus |
| Agenda | Stable time/customer/service/status hierarchy, comparable numeric alignment, clearly separated cancelled/no-show history and readable empty/filter states | Dense day and 100-character names do not hide the next action; tapping a row only opens details, never changes status |
| Booking form and review | Group service/barber, date/time and customer details; show exact duration plus buffer, service/extras and total consistently. Preserve inputs on selection changes and conflicts; focus validation errors; review makes what will be saved explicit | The clicked slot is carried forward only when valid; back/change/retry never loses contact fields or produces duplicate bookings; no payment/hold claim |
| Appointment detail and reschedule | Consistent drawer/sheet hierarchy with contextual actions. Reschedule displays original versus proposed barber/date/time and unchanged commercial snapshot. Return to the same calendar context after closing | Failed move keeps original allocation; successful move appears at destination after read; original price/items/reference unchanged; long note text wraps |
| Cancellation and statuses | Explain the consequence and reason requirement directly beside the action. Keep cancellation/no-show/completion distinct from refund/payment. Define the unresolved early/backdated completion policy before enforcing a new rule | Correct allowed transitions, grace boundary and audit reason; no accidental destructive default action or inferred money movement |
| Service catalogue | Consistent price/duration/category alignment; readable active/inactive labels, useful search/no-match/clear states; retain filter and scroll position after editing | Create/edit/deactivate/reactivate survives reload; inactive service does not enter a new booking; historical service names/prices unchanged |
| Add-ons | Compact price/time display, visible linked-service summary, searchable eligibility choices when lists grow; clearer deactivation consequences. No prechecked revenue-increasing extras | Exact aggregate duration and price in review; a withdrawn or incompatible add-on is rejected with inputs preserved |
| Barber service rules | Show inherited/custom/disabled states explicitly; display current catalogue default beside override. Add unmistakable per-row unsaved/saved/error feedback and reset-to-default explanation while retaining recent multi-row safety fix | Editing two rules and saving one preserves the other; a later edit clears stale saved feedback; £0 differs from inheritance; stale-version rejection does not overwrite |
| Team directory | More consistent card layouts and action grouping; name/role/activity prominent, services/schedule controls discoverable. Do not style profile-role text as if it grants access | All existing staff operations reachable on phone/desktop; deactivation retains bookings, disables new selection and exposes affected visits |
| Weekly and dated hours | Group weekly template, days off and dated overrides clearly; show precedence and whether an override replaces the shift. Explain equal break times/no break and buffer at boundaries. Show a compact week summary before opening long forms | Editing one day does not unexpectedly affect another; closure/full-day leave/dated/weekly precedence still enforced; invalid time order gets field-level guidance |
| Change-impact review | Turn long warning lists into a concise action-required summary with expandable affected visits. Show the impact of a proposed closure/leave/rule change before confirmation where practical; recheck on write and refresh afterward | Affected visits outside the selected day and beyond the legacy 500 snapshot remain discoverable; no silently cancelled records or assertion that a precheck is a lock |
| Shop settings | Group current fields into Shop details, Opening hours, Booking policies and Closures. Add concise help/examples and a summary of saved values; clarify new-booking versus historical effects. Keep unconnected account/payment settings explicit | Saved values match API after refresh; invalid settings retain input and focus error; no unsupported timezone/deposit policy silently enabled |
| Save and navigation safety | Extend existing protected modal close to settings tab changes and nested editor switches. Show explicit dirty/pending/saved states, preserve drafts after failed saves and offer deliberate discard. Browser reload protection where supported, without promising private local draft persistence | Save/cancel/back/tab/reload failure matrix tested; no blind retry after ambiguous mutation and no stale success message |
| Search, filters and audit | Label search as selected-day while that is its scope; retain useful filters and clear them predictably. Improve existing audit readability and add scoped pagination rather than implying 200 events is full history. Cross-date search is separately sized before inclusion | Counts and results match their declared scope; ties/pages contain no wrong-shop data; actor/time/reason readable. No customer search values in URL/analytics |
| Metrics and feedback | Keep existing selected-day metrics; label filtering scope and cancellations clearly. Do not add fabricated trend graphs, occupancy or collected revenue. Standardise useful loading, empty, offline, conflict, forbidden and retry presentations | Statistics reconcile to displayed data and labels; loading does not flash false zero; failures do not look like a successfully empty calendar |
| Performance and maintainability | Measure before changing: calendar render and API timing at increasing staff/record counts. Avoid unnecessary full setup refreshes, use narrowly scoped reads and stale-response cancellation; index/optimise complete future-impact reads after measurement. Extract shared UI/API helpers incrementally | Same correctness under rapid date/filter changes and concurrent updates; test dataset/environment/timings recorded; no framework rewrite or hidden result cap |

### Visual rules for the pass

- Existing matte tokens only, with accessible semantic warning/error colours. Use one consistent typography, spacing, border, radius and control-height scale; keep card/header/form alignment deliberate.
- Primary operational targets aim for 44px touch areas. Dense timetable cells need accessible equivalent controls rather than pretending every tiny cell meets that target.
- Keep content at task-appropriate width: calendar can fill space, settings/forms should not stretch into unreadable long rows.
- Long names, multiline notes, prices and status labels must wrap/truncate deliberately without hiding essential meaning. Full information remains available through accessible details, not hover alone.
- Sticky headers/footers must not cover content, errors, focus or the on-screen keyboard. Use safe-area padding and sufficient scroll clearance.
- Test 320/390/768/1024/1440 widths, landscape, 200% zoom and reduced motion. Do not use global recolouring or excessive animation as a substitute for hierarchy.
- Refine fixture customer/barber styling only if a shared component changes; do not spend this pass producing more unconnected sample features. Their functional integration remains later scope.

### Proposed delivery order after review

| Pass | Small visible deliverable | Scope guard and acceptance |
| --- | --- | --- |
| E1 Calendar and shell polish | Compact controls, readable events/legend, clearer selected slot and mobile agenda | Before/after original-style screenshots; booking/move/cancel regression; no new view mode or reskin |
| E2 Appointment workflow and save safety | Clearer draft/review/detail/reschedule; consistent validation; protected settings/navigation drafts | Full create/edit/move/cancel/error/retry path; preserved snapshots and historical data; resolve timing-policy question only if changing that behaviour |
| E3 Team, catalogue and scheduling | Consistent staff/service/add-on/rule presentation and structured schedule/impact review | Existing CRUD, inheritance, eligibility and precedence all tested; no staff-role system claimed |
| E4 Settings, activity and measured performance | Grouped existing settings, clearer metrics/audit pages, targeted slow-path work | Data matches labels and pages; measured performance comparison; no blanket backend rewrite |
| E5 Whole-app acceptance | Realistic fictional working-day walkthrough and final cross-device interaction sweep | No known high-severity regression, all relevant automated tests green, manual keyboard/visual checks and focused user approval |

Treat these as bounded passes within the current product, not new parallel projects. Start each with the exact screen/task, finish with visible evidence and a commit. Stop to review after E1 before propagating any new presentation pattern. Do not promise dates/number of coding sessions before sizing the selected pass; estimate from actual changes rather than from the whole 189-row register.

### Final acceptance for enhancement work

A shop operator should be able to set hours, adjust a barber price, book from the timetable, locate a visit, move it, cancel another and inspect the audit without getting lost, losing unsaved inputs or misunderstanding money/status. Run this against saved fictional records, not just fixtures.

For every affected screen capture: original and revised view, five-size layout checks as appropriate, dense/long/empty/error states, keyboard path, actual persisted outcome, relevant API/DB tests and remaining limitations. Keep prior 42-unit/direct-D1/60-browser baseline green; add focused regression for each changed behaviour. Automated axe alone is not WCAG certification or proof of user enjoyment.

Success is improved task completion and fewer mistakes—not more cards or controls. Use a small representative owner/barber usability review, record friction/time/errors and prioritize observed blockers. Any task-time target is provisional until measured; no market-leading performance is asserted.

**D-018 supersedes the planning pause above:** the user has authorized building. E1 is implemented in the same connected workspace; current evidence and limitations are recorded in PROGRESS. Review this visible result before extending its patterns to E2. No account/payment/provider work is included in E1.

### E1 delivery — integrated calendar enhancement (2026-09-14)

- Consolidated the separate toolbar/date/view rows into one calendar panel. Retained date picker, Previous/Next/Today, week-date strip, barber/status/search, Day/Agenda and New booking. Added selected-day search scope/result count and Clear filters; date/view changes keep filters until explicitly cleared.
- Increased timeline cell spacing to 44px per 15 minutes; time/name then service/status hierarchy is now readable on 15/30/60-minute cards. Five-minute visits retain a 24px minimum and full accessible name/details/agenda alternative, rather than falsely claiming physical-duration-sized touch targets. Barber colours no longer change when filtering.
- Labelled exact buffer bands independently of card filters, and explained free chair time versus service-specific availability. Hidden appointments still block cells. Break/leave/closure/outside/past-time labels describe presentation only; the unchanged server is the authority.
- One free-slot tab stop per barber; arrows navigate free slots/barbers, Home/End jump within a barber, Enter opens the existing draft, Escape returns focus and Tab exits to appointment buttons. No incomplete ARIA grid or pointer-only feature. Starting barber/date/time is retained in a clearly historical draft summary, distinct from edited selections.
- Eight additional browser cases cover keyboard traversal and no mutation, filter/colour/occupancy continuity, unavailable states and populated 320/390/768/1024/1440 layouts including 5/15/30/60-minute cards, long names, axe and CSS 200% zoom reflow. Full unchanged-source regression is recorded in PROGRESS.
- Independent inspections and read-only verification ran in parallel; automated full-suite cases use two workers and isolated fictional tenants. Shared UI edits/builds were coordinated; no schema/API changes, conflicting build during tests, divergent app or coding subagents.

Remaining: E2 workflow/navigation draft safety, E3 directories/schedules, E4 settings/audit/performance and E5 acceptance. Physical touch devices, screen-reader usability and final user acceptance remain outstanding. Agenda/form are still the better narrow-screen alternatives to a horizontally scrolling resource grid. No full week/month, drag/drop, authentication, payments or PWA implied.
