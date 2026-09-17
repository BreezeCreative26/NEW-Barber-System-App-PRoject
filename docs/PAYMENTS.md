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
| Card at the chair | customer → OLLO | Terminal / Tap to Pay (not yet built); till row carries `stripe_payment_intent` |
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
   `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.refunded`.
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

## Not built yet

- Stripe Terminal / Tap to Pay at the chair (card takings still recorded by hand as `CARD` without a
  Stripe ref → treated as cash in the split).
- Instant Payouts upsell (barbers can already trigger them from their Express dashboard; the fee
  is Stripe's).
- Platform-admin screen for `platform_payments` and top-ups (SQL for now).
- Stripe Billing for the shop's OLLO subscription.
