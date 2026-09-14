# Barbershop OS

Multi-tenant barbershop SaaS planned for Cloudflare: public booking, web administration, barber PWA, shop-owned payments and manual barber pay-runs.

## Current status

**Planning baseline only.** The application remains the Hono starter. `/` renders `Hello!`. No business feature, authentication, PWA, database binding, Stripe integration or production deployment is implemented yet. No application tests or visual reviews are claimed.

The user requested a persistent build plan before implementation. Start with [Progress and handoff](docs/PROGRESS.md).

## Project playbook

| Document | Purpose |
| --- | --- |
| [Session instructions](AGENTS.md) | Read/update procedure every work session |
| [Build plan](docs/BUILD_PLAN.md) | Architecture, screens, domain model, milestones and dependencies |
| [Progress](docs/PROGRESS.md) | Actual state, gate board, evidence, blockers and exact next work |
| [Decisions](docs/DECISIONS.md) | User-confirmed Model A and SaaS scope; open questions |
| [Feature register](docs/FEATURE_REGISTER.csv) | All 125 original C/B/A IDs plus SaaS and cross-cutting requirements |
| [UI/UX contract](docs/DESIGN_SYSTEM.md) | Proposed tokens, layouts, responsive rules and control behaviours |
| [Quality gates](docs/QUALITY_GATES.md) | Definition of done, test catalogue and evidence requirements |

## Confirmed money model

Each shop receives its customers' payments into its own Stripe account under the final supported account configuration. The owner segregates money and pays barbers through their bank outside the app initially.

The app will calculate entitlement, prepare a frozen manual pay-run, export a statement and record externally made payments. It will not hold a shop wallet, initiate barber bank payments, or label an owner-attested payment as bank-confirmed. SaaS subscription billing is separate.

## Intended architecture

- Existing Hono + TypeScript Cloudflare scaffold; React/Vite interactive web frontend proposed.
- D1 authoritative shop-scoped relational data; R2 uploads.
- Managed identity and server-enforced tenant/role permissions.
- Stripe shop payments and separate Stripe Billing for SaaS.
- Twilio, Resend and supported web push; separately configured server scheduling/retries.
- Expo native delivery only according to the explicit launch-scope decision; PWA is not native Tap-to-Pay.

Storage services, provider credentials and production configuration are not provisioned. Proposed data model is in BUILD_PLAN; no migrations exist yet.

## Existing functional entry points

| URI | Current behaviour |
| --- | --- |
| `/` | Starter `Hello!` page |

All `/app/*`, `/book/*`, `/barber/*`, `/platform/*` and API paths in the plan are proposed, not currently functional.

## Using the plan

1. Read PROGRESS and DECISIONS.
2. Review the current milestone and related feature IDs.
3. Implement one approved work package with tests and visual inspection.
4. Update feature statuses and evidence; record blockers and next step.
5. Commit the work. Never describe a design preview as a completed production feature.

Next proposed milestone: M1, three reference screens (admin calendar, customer slot selection, barber queue), design review and scheduling/payment feasibility spikes.

## Development and deployment

- Project location: `/home/user/webapp`.
- Branch: `main`.
- Existing build command: `npm run build` (not run as part of planning-only work).
- Future sandbox preview: build, then PM2-managed Wrangler on port 3000 after a PM2 configuration is created.
- Production URL: none.
- Preview URL: none started in this planning session.
- Deployment status: not deployed. Confirm own-account vs managed deployment before deployment tooling; scheduling/queues are separate infrastructure requirements.
- Do not run the starter deploy script without explicit deployment preparation and authorization.

## Not implemented / next steps

Every application feature is not started. Immediate next step is review of the planning baseline and visual direction. Provider choice, commission/fee/cash rules, deposit policy and native launch scope must be resolved before their dependent milestones. Track precise questions in DECISIONS rather than inventing defaults.
