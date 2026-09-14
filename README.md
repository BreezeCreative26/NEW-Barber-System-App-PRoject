# Barbershop OS

Multi-tenant barbershop SaaS in development: public booking, web administration, barber PWA, shop-owned payments and manual barber pay-runs.

## Current status

**Interactive design preview implemented; live business backend not yet built.** React interfaces run through the existing Hono/Cloudflare-compatible application. All people, appointments, prices and availability are fictional fixtures.

Working preview interactions:
- Admin day/agenda calendar, date/barber filters, search, appointment detail, sample team/service panels and validated booking-draft review.
- Customer service/add-on/barber/time selection, quote updates, details validation, review/edit flow and explicit payment boundary.
- Barber queue filters/details, sample earnings/profile and tip/tender calculator.
- Shared responsive components, mobile agenda, fixed mobile booking action, dialogs/focus handling and loading/empty/error/offline examples.

No real login, tenant database, saved booking, reservation, payment, notification, pay-run or installed/offline PWA exists. Forms remain only in temporary page state and do not send customer data.

## Latest design direction and next step

The user requested **clean modern visuals, teal as the secondary colour and rounded edges**. This is recorded in decision D-011 and DESIGN_SYSTEM v1.1.

Next: **WP-001-A-R1**, a focused refinement of the existing shared styles: neutral/charcoal foundation, secondary teal accents, consistent radii, readable type and less green/sage/vintage decoration. The new styling is planned, not yet applied to the running preview. After that: D1 scheduling proof, managed authentication and persistent shop/team/services/hours, then the real booking lifecycle.

## Preview URLs and routes

Temporary sandbox base: https://3000-iz3aw7n21l3edjgvt4bkj-5c13a017.sandbox.novita.ai

| URI | Current behaviour |
| --- | --- |
| `/` | Redirect to admin preview |
| `/preview/admin` | Interactive sample calendar and admin forms |
| `/preview/book` | Five-step customer booking design preview |
| `/preview/barber` | Sample queue, earnings, profile and payment calculator |
| `/api/health` | Explicit design-preview/persistence/payment capability flags |

Production `/app/*`, `/book/*`, `/barber/*`, `/platform/*` and business API routes remain planned. A temporary preview URL is not a production deployment.

## Project playbook

| Document | Purpose |
| --- | --- |
| [Session instructions](AGENTS.md) | Read/update procedure every work session |
| [Build plan](docs/BUILD_PLAN.md) | Architecture, milestones and ordered work packages |
| [Progress](docs/PROGRESS.md) | Actual state, evidence, blockers and precise next task |
| [Decisions](docs/DECISIONS.md) | Confirmed choices and unresolved policies |
| [Feature register](docs/FEATURE_REGISTER.csv) | 125 original feature IDs plus 64 supplemental requirements |
| [UI/UX contract](docs/DESIGN_SYSTEM.md) | Modern neutral/teal direction, layouts and interaction standards |
| [Quality gates](docs/QUALITY_GATES.md) | Definition of done and production acceptance catalogue |

## Data and money boundaries

Current fixtures and pure preview helpers live in `src/client/fixtures.ts`; there is no database binding or migration yet. Future authoritative data uses tenant-scoped D1; assets use R2. Managed identity and server-side permissions must precede real private shop data.

Under Model A, each shop receives customer payments through its own supported Stripe account configuration. The owner segregates money and pays barbers outside the app. The app will calculate entitlements, prepare frozen manual pay-runs and record owner-attested external payments; it will not hold a wallet, initiate bank payments or imply bank-confirmed settlement. SaaS subscription billing is separate.

## Development and tests

Project: `/home/user/webapp`, branch `main`.

```sh
cd /home/user/webapp
npm run build
# Stop any existing port-3000 service before starting/restarting.
pm2 start ecosystem.config.cjs
curl http://localhost:3000/api/health
npm run test
```

The service must be running for browser tests. For a fresh test environment, install Playwright Chromium and its system dependencies. Service name: `barbershop-preview`. Do not run multiple PM2 instances on port 3000.

Available scripts: `build`, `typecheck`, `test:unit`, `test:e2e`, `test`. The build emits the Hono Worker and bundled React assets, including a licensed self-hosted Inter font. No frontend tokens/provider secrets are used.

Evidence: 23 unit/route tests passed (rechecked during latest planning update); last recorded Playwright run has 25 passed and 0 failures. Checks cover five viewport widths, selected axe scans, keyboard flow, form recovery and honest no-payment boundaries. These do not certify production security, D1 concurrency, real devices, PWA installation or payment integration. See PROGRESS for evidence scope and screenshots.

## GitHub and deployment

Selected repository: https://github.com/BreezeCreative26/NEW-Barber-System-App-PRoject

Connection verified previously; publication paused because the repository was public. No push without private visibility or explicit public-publishing consent. Local code baseline is preserved in commit `2eebb48` and subsequent documentation commits.

Production is not deployed. Confirm Cloudflare ownership/deployment path and provision auth, storage, scheduler and provider configuration before production. Never run the generic deploy script without appropriate preparation and approval.
