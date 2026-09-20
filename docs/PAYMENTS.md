# Payments — OLLO as a Stripe Connect platform

OLLO is the **merchant of record**. Every card payment (online deposit now; Terminal / Tap to Pay
later) is charged on OLLO's Stripe balance. Every shop and every barber holds their own **Stripe
Express account**. When a pay run is approved, OLLO **transfers** the barber's share to the barber's
account and the shop's share to the shop's, tagged with one `transfer_group`. Stripe pays each
account out to its bank on its own schedule. **Cash never enters** — the pay run shows it as a
residual to settle by hand.

```
customer card ──► OLLO platform balance ──┬─► barber Express account ──► barber's bank
                    (float covers T+3)    ├─► shop   Express account ──► shop's bank
                                          └─► OLLO application fee
```

## Money model in one table

| Flow | Who pays whom | How |
|---|---|---|
| Online deposit at booking | customer → OLLO | Stripe Checkout, `payment_intent` stored on the booking, posted to the till as `ONLINE` at checkout |
| Card at the chair | customer → OLLO | **Tap on their phone** (QR → Stripe Checkout with Apple Pay / Google Pay / card — live) or a paired Stripe reader; till row carries `stripe_payment_intent` |
| Cash / transfer / voucher at the chair | customer → whoever holds the till | recorded in the ledger only |
| Pay run approve | OLLO → barber, OLLO → shop | `transfers` rows; `pay_runs.status = TRANSFERRED` |
| Refund / void / dispute after settlement | barber & shop → OLLO | proportional `transfer reversals`; never edits |
| Cash residual | shop ↔ barber by hand | `pay_runs.cash_residual_pence`; owner marks `PAID` with a method |

Commission and tip share are snapshotted per payment row (existing behaviour), so a later terms
change never rewrites history.

## Tiers

| `shops.payout_tier` | Transfers happen | Needs |
|---|---|---|
| `STANDARD` | when the platform's **available** balance covers the run (≈ T+3 after the card charge) | nothing |
| `FAST` | immediately on approve, against the platform **float** | `platform_payments.fast_payouts = 1` and a funded float |

`shops.payrun_auto` = `OFF` / `DAILY` (yesterday, every morning) / `WEEKLY` (Monday for last
Mon–Sun) drafts, approves and transfers runs from the sweep. `payrun_reserve_bps` holds back a
percentage of the barber's card share against disputes.

## Switching it on (runbook)

1. **Stripe account** with Connect enabled (Dashboard → Connect → Get started → *Platform or
   marketplace*). Test mode first.
2. **Env** (Vercel → Settings → Environment Variables):
   - `STRIPE_SECRET_KEY` — `sk_test_…` then `sk_live_…`
   - `STRIPE_WEBHOOK_SECRET` — from step 3
   - `STRIPE_CONNECT` — leave unset (defaults on). Set `0` only for a single-shop deploy where the platform account *is* the shop.
3. **Webhook** → `https://<app>/api/stripe/webhook`. Select events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`,
   `account.updated`, `transfer.created`, `transfer.reversed`,
   `payout.created`, `payout.updated`, `payout.paid`, `payout.failed`, `payout.canceled`,
   `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.refunded`,
   `payment_intent.succeeded` (card at the chair).
   **Tick "Listen to events on Connected accounts"** as well — payouts arrive from the connected accounts.
4. **Platform fee** — `UPDATE platform_payments SET fee_bps = 150, fee_fixed_pence = 0` (1.5 %). Set
   `fast_payouts = 0` to disable FAST for everyone; `float_alert_pence` for the low-float warning.
5. **Float** (for FAST): Dashboard → Balances → *Add to balance*, or `POST /v1/topups` via
   `topUp()` in `stripe.ts`. Size it at ~3 working days of expected card volume.
6. **Shop**: Settings → Payments → *Set up shop payouts* (owner). Express onboarding, ~5 minutes.
7. **Barbers**: Settings → Payments → each barber → *Set up payouts*, or the barber does it themself
   from Team → their card → Pay → *Set up payouts*. They need name, DOB, bank details, ID.
8. **Deposits**: Settings → Payments → *Take the deposit by card at booking*.
9. **Pay runs**: leave `payrun_auto` OFF for the first week and approve by hand; watch the
   transfers list on each run; then switch to DAILY or WEEKLY.

## Test-mode checklist (before real money)

- Card `4242 4242 4242 4242` books with a deposit → manage page shows *Deposit paid* → confirmation
  message goes out → till shows the deposit credit at checkout.
- Cancel outside the window → `deposit_status = REFUNDED`, audit `DEPOSIT_REFUNDED`.
- Cancel inside the window → deposit kept, audit says so.
- Let a Checkout session expire (`expires_at` is the hold) → booking `CANCELLED`, `EXPIRED`, slot free.
- Onboard a test barber (Stripe's test onboarding accepts `000000000` SSN-style dummies; UK uses
  test sort code `108800`, account `00012345`).
- Approve a run with card money → `transfers` rows, `status TRANSFERRED`, barber's Express
  dashboard shows the balance.
- Void a settled payment → reversal rows; `charge.dispute.created` via the Dashboard's test dispute
  → reversal + `DISPUTE_OPENED` audit.
- `STANDARD` tier with an empty available balance → approve returns
  *Waiting for card settlement*, run stays `APPROVED`, *Send card money now* retries later.

## Where things live

| Piece | File |
|---|---|
| Stripe REST client, Express accounts, transfers, reversals, balance, top-ups, webhook verify | `src/server/stripe.ts` |
| Onboarding, account state, card/cash split, settlement maths, `executeRun`, reversals, wallet, scheduled runs, Connect webhook events | `src/server/payouts.ts` |
| Owner routes (`/shop/payments`, connect, accounts, wallet, balance, pay-run transfer) | `src/server/sandbox.ts` |
| Deposit flow (hold, Checkout, confirm, refund) | `src/server/public.ts`, `src/server/stripe.ts` |
| Webhook entry | `src/index.tsx` → `/api/stripe/webhook` |
| Settings → Payments, barber payout card | `src/client/Payouts.tsx` |
| Pay run settlement view + transfer actions | `src/client/Pay.tsx` |
| Schema | `src/db/migrations/0007_deposits.sql`, `0008_connect_payouts.sql` |
| Tests (preview mode) | `tests/payouts.spec.ts`, `tests/pay.spec.ts`, `tests/payments.spec.ts` |

## Card at the chair

Two ways, both charging the platform so the pay run treats them as card money:

- **Pay link / QR** — Checkout → *Take by card* → *Pay link / QR*. A QR appears on the shop device;
  the customer scans and pays on their own phone, or the shop texts/emails the link (shop-branded
  `pay_link` message). Valid 30 minutes. Lands on `/pay/<id>` afterwards. No hardware needed.
- **Reader** — pair a Stripe reader (WisePOS E, or Tap to Pay on a phone) in Settings → Payments →
  Card readers with the code it displays. At checkout choose the reader; the amount appears and the
  customer taps. Server-driven (`process_payment_intent`); the till polls until paid.

Both write the ledger row (`method CARD`, `stripe_payment_intent`, `stripe_charge`,
`stripe_fee_pence`, `platform_fee_pence`), move the visit to IN_SERVICE / COMPLETED, and audit. The
webhook (`payment_intent.succeeded`, `checkout.session.completed` with `payment_request_id`
metadata) is the guaranteed path; polling is the fast path. Open requests expire via the sweep.

Card recorded **by hand** (no Stripe ref) is still treated as cash in the pay-run split — because it
is: the money went to whoever held the machine.

## Not built yet

- Tap to Pay driven from OLLO's own screen (needs the Terminal JS SDK + a native wrapper; the
  server side — `/terminal/connection-token`, `reader_id: "sdk"` — is ready for it).
- Instant Payouts upsell (barbers can already trigger them from their Express dashboard; the fee
  is Stripe's).
- Platform-admin screen for `platform_payments` and top-ups (SQL for now).
- Stripe Billing for the shop's OLLO subscription.

## Tap at the chair (live)

Checkout → **Card** → **Tap on their phone**. OLLO creates a Stripe Checkout Session for the
service + tip and shows a QR that encodes the short `/pay/:id?go=1` URL (dense Stripe URLs scan
badly). The customer scans it with their camera, lands straight on Stripe Checkout and pays with
Apple Pay / Google Pay if their phone has it, or types a card. `checkout.session.completed` →
webhook → `payments` row (`method=CARD`, `stripe_payment_intent`), visit completed, barber's share
queued for the next pay run. The till polls `/payment-requests/:id` every 3 s and flips to "Paid".

Verified end-to-end on production (test mode) 2026-09-20 on `ollo-test`: £28 + £2 tip, card
4242, webhook landed, booking COMPLETED, ledger row present.

Apple Pay needs the domain registered once per Stripe account:
`STRIPE_SECRET_KEY=sk_… node scripts/stripe-setup.mjs https://new-barber-system-app-p-roject.vercel.app`
(registers the payment-method domain; the association file is served at
`/.well-known/apple-developer-merchantid-domain-association`). Google Pay and Link need no setup.

True Tap to Pay on the *barber's* phone (customer taps their card on the barber's iPhone/Android)
needs Stripe's native Terminal SDK inside an app shell (Capacitor) plus Apple's Tap-to-Pay
entitlement — the server side (`reader_id: "sdk"`, `/terminal/connection-token`) is already in
place for it.
