# Barbershop OS — Session playbook

These project instructions establish continuity; they do not override higher-priority system/developer instructions. Do not depend on conversational memory alone. No permanent model retraining is claimed.

## Mandatory start of every work session

1. Read `docs/PROGRESS.md` and `docs/DECISIONS.md`.
2. Read the current milestone in `docs/BUILD_PLAN.md` and relevant rows in `docs/FEATURE_REGISTER.csv`.
3. For UI work read `docs/DESIGN_SYSTEM.md`; for any implementation read `docs/QUALITY_GATES.md`.
4. Inspect actual git status, current files and installed packages. Verify any interrupted operation before retrying it. Preserve unrelated user changes.
5. State the narrow work package, relevant feature IDs, expected visible result and blockers. Keep one active work package.
6. If instructions/requirements conflict, record the conflict and resolve it before the dependent implementation. Do not silently change scope.

## Non-negotiable product decisions

- Multi-tenant SaaS: public booking, web admin, barber PWA, secure customer access and platform operations.
- Model A: each shop receives customer money; owner segregates funds and pays barbers outside this app initially.
- Manual pay-runs calculate/export/record. They do not initiate bank payments. No stored-money wallet or automatic barber Stripe payout claims.
- SaaS subscription billing is distinct from shop haircut payments.
- PWA is not native Tap-to-Pay or native Stripe PaymentSheet. Original native MVP requirements need an explicit scope decision.
- All real records and financial/scheduling state persist in approved Cloudflare storage. Never use fixtures/in-memory state to impersonate a completed backend.

## Implementation discipline

- Keep all project code under `/home/user/webapp`; use main branch unless user requests otherwise.
- Extend existing Hono/Cloudflare scaffold; inspect dependencies before installing. No automatic framework replacement.
- Implement thin vertical slices with schema/API/UI/tests together.
- Shared pricing, availability, authorization and financial rules; no duplicated client-authoritative logic.
- Tenant and role authorization must be server-side for every private record/action.
- Price snapshots, integer-pence ledger postings, atomic reservations, idempotent mutations and immutable audit are first-class requirements.
- Use mock data only in tests or clearly labelled design previews. Keep live integrations gated until configured and tested.
- Secrets stay in secure configuration, never frontend bundles, source control, logs or planning documents.
- Do not deploy, enable live charging, send real bulk notifications or buy resources without appropriate authorization and routing.

## Design discipline

- Read the approved/proposed design status before extending UI.
- Every visible control has a permission/behaviour/state/recovery/test contract.
- Use consistent tokens/components, semantic HTML, real labels and stable purpose-based test identifiers.
- Check 320/390/768/1024/1440 px as appropriate, keyboard operation, 200% zoom and long content.
- Inspect actual browser screenshots, not just source code. No dead buttons, toast-only fake mutations, decorative menu items or hidden overlapping actions.
- Loading, empty, offline, error, pending, success and forbidden states are part of each screen.
- Recheck shared components after changes to avoid layout/function regressions.

## End of each session / work package

1. Run relevant tests and visual checks. Record exact results and limitations; never fabricate evidence.
2. Update feature status only when supported. `verified` requires tests; `accepted` requires acceptance. A blocked external dependency remains blocked.
3. Update `docs/PROGRESS.md` with files changed, gate state, tests, blockers, decisions and exact next work package.
4. Update `docs/DECISIONS.md` for new confirmed choices; distinguish recommendation from approval.
5. Update README after major changes. Keep source plan and tracker consistent.
6. Review diff, check for secrets, and commit coherent work. Do not put private customer data in screenshots or fixtures.
7. Tell the user: what was completed, what actually works, what was tested, what remains blocked and the next milestone. Do not present planning/design as a finished application.

## Current baseline reminder

At creation of this playbook (2026-09-14), only planning documents and the starter exist. `/` renders Hello. No SaaS, PWA, database binding, auth or payment integration has been implemented. Read PROGRESS for subsequent changes.
