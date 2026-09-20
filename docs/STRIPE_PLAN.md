# Stripe integration plan — OLLO

Generated 2026-09-20 with Stripe's `stripe_implementation_planner` (MCP, guide
`iguide_61VR861qlKOggX04141CE9wUFm2s6`) against the live test account `acct_1UHjdYCE9wUFm2s6`
("OLLO sandbox", GB, GBP), then checked against the code in `src/server/stripe.ts`,
`payouts.ts`, `chair.ts`, `public.ts`. Companion runbook: `docs/PAYMENTS.md`.

## 1. Verdict on the existing design

| Planner question | OLLO's answer | Verdict |
|---|---|---|
| Platform type | Software for shops that serve their own customers, **but** every payment is split two ways (barber + shop) and held until a pay run | Marketplace money-flow with **separate charges and transfers** — correct. Direct charges can't reach a second account; destination charges can't hold or split. |
| Merchant of record | OLLO | Correct for this flow. Do **not** set `on_behalf_of`. |
| Pricing owner | Platform (`fees_collector: application`) | Required with separate charges. Already the case. |
| Loss liability | Platform (`losses_collector: application`) | Required. **Action:** accept loss liability once at dashboard.stripe.com/settings/connect/platform-profile before the first live account. |
| Fraud | Platform manages | **Action:** enable Radar for Platforms (Dashboard → Radar). No code. |
| Dashboard | Express + login links | Correct. Embedded components are the recommended upgrade (Phase 4). |
| Account creation | `POST /v1/accounts type=express` | **Broken.** Stripe rejects v1 creation on new platforms (probed: `Stripe no longer recommends Accounts v1…`). Fixed → `POST /v2/core/accounts`, recipient configuration only, `stripe_balance.stripe_transfers` capability. `card_payments` must **not** be requested (it forces full KYC on every barber). |
| Onboarding | Account Links | Correct; now `POST /v2/core/account_links`. |
| Capability check before transfer | `payouts_enabled` | Works (v1 read of a v2 account still reports `capabilities.transfers`). Kept. |
| Webhooks | HMAC verified, `stripe_events` dedupe, 2xx after verify | Best practice. |
| Idempotency | Deposit session, account create, transfers, reversals, refunds keyed | Good. Terminal PaymentIntent create had no key → added. |
| Treasury | Wanted | **Not now.** GB is *public preview, contact sales*, and the platform's own account isn't activated. Barbers already get Instant Payouts from the Express dashboard (Stripe fee, ~1%). Revisit when volume justifies a sales conversation. |

## 2. Phases

### Phase 0 — switch on (this commit)
- Accounts v2 creation + v2 account links; probe-verified.
- Webhook endpoint registered by API (`/api/stripe/webhook`, platform + connected events).
- Idempotency key on Terminal PaymentIntents.
- ClickSend SMS provider (user has ClickSend, not Twilio); Resend for email.
- Dashboard to-dos for the owner: accept loss liability, enable Radar for Platforms, complete
  platform business profile (test mode works without it; live mode does not).

### Phase 1 — Payments hardening (existing flows)
- Saved cards for repeat customers: `Customer` per (shop, customer) + `SetupIntent` in the
  manage page → `customers.stripe_customer_id`, `payment_methods` table. Enables no-show fees
  (`off_session` PaymentIntent with the shop's policy) and one-tap deposits.
- Apple Pay / Google Pay: Checkout already offers them once the domain is registered
  (Dashboard → Payment methods → Apple Pay → add `new-barber-system-app-p-roject.vercel.app`
  and the custom domain). No code.
- Receipts: set `payment_intent_data[receipt_email]` on Checkout; Stripe emails the receipt.
- Radar rules for platforms: block when `:card_country: != 'GB'` and amount > £150 (tune).

### Phase 2 — Billing (OLLO's own subscription)
Charged on the **platform** account, not through Connect. One `Customer` per shop
(`shops.stripe_customer_id`), tiers as Products/Prices:

| Tier | Price id (test) | Includes |
|---|---|---|
| Solo | `price_…` | 1 chair, online booking, reminders |
| Shop | `price_…` | up to 6 team, pay runs, deposits |
| Multi-site | `price_…` | per-seat over 6, multiple locations |

- 14-day trial with card on file (`trial_period_days: 14`, `payment_behavior:
  default_incomplete`, `collection_method: charge_automatically`).
- Checkout in `mode: subscription` from Settings → Plan; Customer Portal for change/cancel
  (`cancel_at_period_end`); Smart Retries + dunning emails from the Dashboard.
- Webhooks: `customer.subscription.created|updated|deleted`, `invoice.paid`,
  `invoice.payment_failed` → `shops.plan`, `plan_status`, `plan_renews_at`; a `past_due` shop
  keeps read access, loses new bookings after 7 days.
- UK VAT: Stripe Tax on the subscription Prices (`tax_behavior: exclusive`, automatic tax on
  the Checkout session). OLLO must be VAT-registered first — until then no VAT line.

### Phase 3 — Invoicing
- **Shop → customer** (weddings, corporate): `Invoice` on the platform account with
  `transfer_data`? No — invoices can't split to two accounts. Create the invoice on the
  platform, `metadata.shop_id`, and let `invoice.paid` write a ledger row like a pay link
  (`method CARD`, `stripe_payment_intent`) so the pay run splits it. Hosted invoice page,
  `collection_method: send_invoice`, `days_until_due: 7`, bank transfer enabled for B2B.
- **OLLO → shop**: Billing already emits invoices; enable *Invoice PDF* emails and set the
  footer (company number, VAT number) in Dashboard → Branding.

### Phase 4 — Terminal
- Design confirmed: server-driven readers with PaymentIntents on the platform balance are
  right for separate-charges platforms. Keep `card_present`, `capture_method: automatic`.
- Tipping on reader: turn `process_config[skip_tipping]` off and configure tip presets per
  Location (`Configuration` object). The tip lands in `amount_details.tip` on the PI →
  write it to `tip_pence` from the webhook instead of the till's typed tip.
- Tap to Pay on the shop's phone: needs the Terminal iOS/Android SDK (native wrapper) — the
  server side (`/terminal/connection-token`, `reader_id: "sdk"`) is ready.
- Embedded components (`@stripe/connect-js`): account onboarding, notification banner,
  payouts — replaces Account Links + login links with in-app UI. Requires
  `account_sessions` endpoint.

### Phase 5 — Treasury (parked)
Contact Stripe sales when: platform account is live, > ~£50k/month card volume, and barbers
ask for faster money than Instant Payouts. Alternative today: nothing to build.

## 3. Owner checklist (Dashboard, ~10 minutes)
1. Connect → Settings → Platform profile → **accept loss liability**.
2. Radar → **Radar for Platforms** on.
3. Connect → Branding → OLLO logo/colour (shows on Express onboarding).
4. Payment methods → Apple Pay → register the domains.
5. Complete the platform business profile (required before `sk_live_`).
6. Vercel → env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (from the endpoint created by
   `scripts/stripe-setup.mjs`), `CLICKSEND_USERNAME`, `CLICKSEND_API_KEY`, `RESEND_API_KEY`,
   `MAIL_FROM`.

## 4. Test-mode script
See `docs/PAYMENTS.md` → *Test-mode checklist*. Card `4242 4242 4242 4242`; UK test bank
sort code `108800`, account `00012345`; test onboarding accepts any dummy ID.
