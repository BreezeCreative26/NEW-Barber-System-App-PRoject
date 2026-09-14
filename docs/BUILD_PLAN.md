# Barbershop OS — Build plan

Version: 1.2 · Updated: 2026-09-14 · Status: initial interactive preview implemented and tested; modern neutral/teal refinement planned under D-011. No live business backend yet.

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

Development tools and React/test dependencies are not installed yet; inspect the actual package versions before adding anything. Runtime code uses Cloudflare-compatible Web APIs; development scripts may use Node.

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
3. Prove an atomic D1 reservation algorithm before UI calendars depend on it. Candidate: unique barber/time-unit claims for the full interval, acquired with booking/hold writes in a transactionally atomic D1 batch. Define time precision and query/parameter limits in the spike.
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
| WP-001-A-R1 | Modern neutral/teal refinement | D-011: neutral/charcoal foundation; teal secondary accent; rounded geometry; readable type; simplify legacy styling without breaking interactions | Before/after screenshots; full regression and contrast checks; focused user feedback |
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

### Immediate next sequence after user design feedback

1. **WP-001-A-R1 — Refine the existing theme, do not rewrite screens.** Centralize neutral/charcoal/teal tokens, consistent 12/16/20 px radii, readable text and restrained visual decoration. Keep mobile agenda and fixed booking actions. Re-run tests and inspect all three surfaces. This is the next implementation task; no provider credentials needed.
2. **WP-001-B — Prove data safety.** Implement/test an atomic D1 allocation spike including intervals, buffers, expiry and simultaneous requests. Define tenant-aware schema and payment account-context contracts; do not mistake fixture helpers for real availability. Stripe execution waits only on Stripe credentials.
3. **WP-002-A/B — First persistent vertical slice: create shop -> create staff/service -> set hours -> reload and verify isolation.** Add selected managed authentication, server roles, migrations, validation, D1 persistence and audit. A provider choice is needed here; do not fake sign-in. Add real Team, Services and Settings screens using the refined components.
4. **WP-003-A — Real booking lifecycle.** Replace fixture catalogue/slots with tenant-scoped APIs, hold and booking allocation; connect customer selection and admin calendar. Add conflict feedback and atomic walk-in/reschedule operations. Pass concurrency and timezone tests before adding payments.
5. **WP-004-A/B — Shop-owned payments and delivery.** Connect shop Stripe accounts, deposits/refunds, verified webhooks and ledger postings; then durable notifications/reminders and secure customer booking access. No live mode without explicit readiness/sign-off.
6. **WP-005-A/B and WP-006-A/B — Working day, PWA and finances.** Persist visit transitions, cash/card/tips and receipts; implement actual installation/offline-cache rules; reconcile manual pay-runs and reports. Never present offline-state examples or a tip calculator as real operational persistence.
7. **WP-007-A/B — Commercial SaaS launch.** Subscription lifecycle, server entitlements, platform operations, monitoring, restore test and two-tenant pilot.

Do not ask whether to keep redesigning or start a different architecture: the user has requested this refinement and build-out. Ask only specific blocking provider/policy decisions at the point they matter. Preserve all original release-scope flags, including unresolved native launch scope.

### Build boundaries and required inputs

- Start now without provider credentials: shared design proof, local test scaffolding, D1 feasibility and API/schema contracts.
- Before WP-002-A: select/configure managed authentication. Do not use a public demo role-switcher as real login.
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
