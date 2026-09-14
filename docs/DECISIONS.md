# Barbershop OS — Decision log

Baseline: 2026-09-14. Confirmed means explicitly selected by the user; proposed means an engineering recommendation awaiting review. A proposal is not permission to change original release scope.

## Confirmed

### D-001 — Multi-tenant SaaS, web admin, booking and PWA

User approved selling the product to independent shops on Cloudflare with web administration, public booking and PWA experiences. All shop data must be isolated from the start. One shop/location per tenant initially; multi-location management is distinct and unresolved against the original roadmap.

### D-002 — Payment model A; shop receives customer money

User selected A and clarified that the shop owner will segregate the money.

- Each shop receives its customer payments through its own Stripe account; the exact Connect configuration must be proven with Stripe before live integration.
- The SaaS does not receive haircut funds into a platform-held wallet and then distribute them.
- The owner makes barber bank payments externally in the initial version.
- The app calculates earnings, prepares manual pay-runs, exports a statement and records owner-attested external payments.
- No automated barber Stripe payouts, nested connected-account transfers, platform custody, bank balance verification or claims of safeguarded wallets.
- Use “Shop finances”, “Barber earnings”, “Manual pay-run” and “Recorded paid”. Avoid “Withdraw wallet” or “Instant payout” for the manual workflow.
- The shop's own Stripe-to-bank payout visibility may be shown separately when supported; it is not a barber pay-run.
- Barber KYC/Connect onboarding is not automatically required for a barber paid externally. Shop onboarding gates shop payment capability. Adapt C-09/B-03/A-25 accordingly.
- Cash is not Stripe balance. Decide cash custody and fee allocation before financial formulas are finalized.

Supersedes original per-barber destination charges, per-barber automated payout execution and barber Instant Payout controls. Preserve original IDs in the feature register with `adapted` or `superseded` treatment so nothing silently disappears.

### D-003 — Pause coding; create a persistent build and quality playbook

User asked for the most effective build plan, a readable running progress record, high-end UI/UX, correct placements and working controls throughout. This session delivers planning documents, not application implementation.

The assistant cannot permanently retrain its model. Project documents and session instructions establish repeatable behaviour. Future sessions must read the files and verify the repository; never rely on an assumed hidden memory.

### D-010 — Proceed with a build-ready execution sequence

The user said to start creating the product and requested a concrete build plan. Refine the existing plan into executable work packages rather than restart discovery. The next local implementation package is WP-001-A: three representative screens and shared design foundations.

Reversible engineering defaults: working name Barbershop OS, proposed charcoal/teal direction. These are not final user-approved branding. References can refine the first preview; lack of final branding does not block a local design proof.

This instruction does not settle financial policy, native launch inclusion, provider purchases, production deployment or publication to the public GitHub repository. Obtain those decisions only before dependent work. User review of the actual visual proof still gates broad rollout.

### D-011 — Modern neutral visuals with teal as secondary colour

User explicitly requested modern, clean visuals, teal as the secondary colour and rounded edges. This supersedes the green/sage-dominated appearance of the first preview and refines D-007.

- Neutral white/cool-grey surfaces and charcoal establish the foundation; teal provides selected/focus/navigation accents rather than overwhelming large surfaces.
- Consistent rounded cards, inputs, buttons and dialogs; restrained elevation, clean typography and generous but purposeful spacing.
- Proposed implementation teal is #0F766E with pale teal #E6F4F1. Exact swatches and revised screens remain subject to visual review; do not call them separately approved.
- Next work is a focused shared-theme refinement WP-001-A-R1, preserving working flows and tests, followed by technical proof and persistent tenant setup.
- This planning update does not itself change the running CSS. Current screenshot/test evidence belongs to the initial preview, not the proposed refinement.

## Proposed architecture decisions

### D-004 — Modular monolith on Hono / D1 / R2

Proposed: React/Vite frontend over current Hono scaffold, Cloudflare D1 and R2, managed authentication, explicit provider integrations. Shared API for all clients. Current repository has a tested React/Hono design preview; it is not yet a persistent or authenticated SaaS.

Validate atomic scheduling in D1 before UI dependency. Use a tenant routing abstraction to preserve future partitioning options without premature per-tenant infrastructure.

### D-005 — Separate appointment and payment state machines

Proposed: appointment includes HELD/EXPIRED/IN_SERVICE; payment has independent collection/refund state. Walk-in is a source, not state. Completion and payment collection are related but not identical. Paid service completed with an outstanding balance must be representable.

Original “all money actions originate from webhooks” is corrected to: authorized server commands initiate provider actions; verified provider events and reconciliation establish provider outcomes. Audited cash and external-payment records do not originate from Stripe webhooks.

### D-006 — Keep booking identity during rescheduling

Proposed: atomic move of the reservation with an appended event, retaining payments on the same booking. If replacement bookings are required, explicit lineage and payment allocation are mandatory. User approval needed for this change to the original archived/replacement model.

### D-007 — Premium utilitarian visual direction

Initial proposal: warm neutrals and restrained teal. The first implementation leaned forest green/sage. D-011 now governs the next pass: clean modern neutral/charcoal foundations, teal secondary accent and consistent rounded geometry. Precise typography and useful density remain required; final revised screens await user review.

### D-008 — Web-first release sequence and native scope

Web-first is the proposed efficient build order. The user confirmed PWA, not explicitly removal of all native MVP functions. PWA supports web checkout, restricted caching, supported web push and an internet reader integration. Native Stripe PaymentSheet and phone Tap-to-Pay require a separate native implementation.

Gate G0: decide whether native features block the first commercial release. Preserve original MVP tags until approved. WisePOS E is internet connected, not Bluetooth; use supported server-driven flow subject to account proof and real-device testing.

### D-009 — Production deployment ownership

Own-account Cloudflare deployment is recommended for commercial infrastructure control; user has not explicitly selected the deployment path. No deployment authorization in this planning turn. Confirm path before deployment tooling. Cron/queues require separate infrastructure; managed hosted deployment is not a promise to configure them automatically.

## Open decisions (do not ask everything at once)

| ID | Question / proposed default | Needed before | Owner / effect |
| --- | --- | --- | --- |
| O-01 | Working name remains Barbershop OS; D-011 confirms modern/teal/rounded direction. Final product name and revised screen review remain open; references optional | M1 visual approval | User; final branding and screen acceptance |
| O-02 | Native customer/barber features launch-blocking or explicitly deferred? Proposed web/PWA pilot first | G0 release scope | User; original C-21/B-20 and native push/clipboard |
| O-03 | Shop share or barber share meaning of commission? Proposed explicit shop share in basis points | M2 schema | User; every earnings formula |
| O-04 | Who absorbs card fees and who physically receives cash? | M4–M6 money implementation | User/accountant; entitlement adjustments |
| O-05 | Always £5 deposit or shop default with service override? Proposed override model with £5 default | M3 quote rules | User; C-23 vs A-22/A-43 |
| O-06 | Shop account/Connect charge model; saved cards account context; Terminal compatibility | M1/M4 Stripe spike | Stripe confirmation; no live payment assumption |
| O-07 | Auth provider, MFA, guest secure links, customer verification | M2 identity | User/engineering; credentials and commercial fit |
| O-08 | Same booking on reschedule or replacement lineage? Proposed D-006 | M3 schema | User; payment allocation |
| O-09 | No-show grace period, buffer at shift edges, cancellation boundary, add-on durations, future booking horizon | M3 scheduling | User; explicit test cases |
| O-10 | Finite retention/access rules for sensitive client notes; consent and deletion policy | Before real customer data | User/legal reviewer |
| O-11 | Pricing plans, trial/grace periods, entitlements, SMS usage/overage rules | M7 billing | User; costs and subscriptions |
| O-12 | Production Cloudflare path, region constraints, domains, notification providers | Before deploy | User; separate secrets/configuration |
| O-13 | Multi-location and queue-display roadmap vs “out of scope for any version” | Roadmap approval | User; preserve contradiction until resolved |
| O-14 | Secure bank recipient handling or earnings-only CSV initially | M6 exports | User; sensitive bank data minimization |
| O-15 | Reminder for bookings made inside 24h window; email fallback vs simultaneous channels | M4 notification rules | User; avoid duplicate or stale reminders |
| O-16 | Weekly/month views launch priority; commercial calendar library license budget | M1 component proof | User; no unapproved dependency cost |
| O-17 | Review moderation/reporting and edits; service-price adjustments at settlement | M6 reviews/finance | User; audit and public safety |

## First decisions to request next session

WP-001-A initial preview is built and tested. Next apply WP-001-A-R1 under D-011, without asking the user to repeat the modern/teal direction. O-01 stays open only for final branding and revised visual review. Resolve O-02/O-03/O-05 and O-07 before dependent native/policy/auth work; do not restart planning or block the theme pass on provider credentials.

## Payment reference checked during planning

- https://docs.stripe.com/connect/separate-charges-and-transfers — platform charges and outgoing transfers are a distinct model from direct shop collection. Not selected for initial Model A.
- https://docs.stripe.com/connect/destination-charges — fee cap, refund and platform liability implications; original barber-destination assumption is superseded.
- https://docs.stripe.com/terminal/readers/bbpos-wisepos-e — internet reader and server-driven recommendation.

Re-check provider documentation during the implementation spike; links are architecture references, not evidence our integration works.

## Change log

- 2026-09-14: Captured user-approved SaaS/PWA and Model A decisions; established proposed architecture and unresolved launch scope; no implementation claims.
