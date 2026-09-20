# Unit economics — what one shop costs OLLO to run

Reference shop: **3 barbers, 6 days/week, ~10 cuts each per day ≈ 780 bookings/month**, 70% booked
online or by phone (the rest walk in). Rates are the providers' published UK/US list prices as of
September 2026, converted at £0.76/$. Recheck quarterly; Meta and ElevenLabs move prices.

## 1. Variable cost per shop (scales with their bookings)

| Line | Assumption | Unit rate | £/month |
|---|---|---|---|
| **Messaging — all text** | 546 online bookings × 2.15 msgs (confirm, reminder, ~15% moves/cancels, codes) = ~1,170 msgs | ClickSend UK £0.0427/SMS | **£50** |
| **Messaging — half WhatsApp** | same volume, 50% WA | Meta utility £0.0128 + Infobip ~£0.005 = £0.018/WA | **£35** |
| **Messaging — mostly WhatsApp** (80% WA) | same volume | | **£27** |
| **AI receptionist** | 6 calls/day × 2.5 min ≈ 390 min/month | ElevenLabs $0.08/min + LLM ~$0.02/min + Twilio UK number $1.15/mo + $0.014/min | **£35** |
| **Stripe Connect** | 3 Express accounts, weekly payouts | $2/active account/mo + 0.25% + 25¢ per payout | **£15** |
| Email | confirmations, owner alerts, summaries | Resend — inside the shared plan | ~£0 |

Card processing (1.5% + 20p on deposits/prepayments) is **not** OLLO's cost — it's deducted from the
shop's payment before payout, the same as every competitor. At 40% of bookings taking a £10 deposit
that's ~£110/month flowing through, ~£3,100 in deposits.

## 2. Fixed platform cost (shared across every shop)

| Service | Plan | $/month |
|---|---|---|
| Vercel Pro | 1 seat | 20 |
| Supabase Pro | Postgres, backups | 25 |
| Resend Pro | 50k emails | 20 |
| ElevenLabs Pro | 1,238 agent-minutes pooled, $0.08/min after | 99 |
| Stripe, ClickSend, Infobip | pay-as-you-go | 0 |
| **Total** | | **$164 ≈ £125** |

| Shops on the platform | Fixed cost per shop |
|---|---|
| 10 | £12.50 |
| 50 | £2.50 |
| 200 | £0.60 |

## 3. Cost per 3-barber shop, all in

| Scenario | Variable | + fixed @50 shops | **Cost** |
|---|---|---|---|
| Text only, no phone agent, no card payments | £50 | £2.50 | **~£53** |
| Text + WhatsApp mix, no phone agent | £35 | £2.50 | **~£38** |
| Everything on (WhatsApp mix, AI receptionist, Stripe Connect) | £35 + £35 + £15 = £85 | £2.50 | **~£88** |
| Everything on, heavy text users (all SMS) | £50 + £35 + £15 = £100 | £2.50 | **~£103** |

Sensitivity: **SMS is the swing line.** Every 10 points of bookings moved from text to WhatsApp saves
~£3/shop/month; nudging customers to WhatsApp at checkout (already the default picker) is worth doing.
A shop that turns reminders off halves its messaging cost; a shop that adds a 4th barber adds ~£30.

## 4. Guide price

Market: Fresha "free" but 20% marketplace fee + 1.29%+20p processing + SMS bundles; Booksy ~£30–40 base
+ £10/staff; Squire from ~£70; Vagaro ~£25–£60 by staff count; Treatwell 35% commission on new clients.
The mockup's promise is **one fixed fee, no per-booking or per-staff creep, everything included**, so
price the *bundle*, not the seats.

| Tier | Includes | Price | Cost (3-barber ref) | Gross margin |
|---|---|---|---|---|
| **Studio** — 1–2 chairs | Booking, calendar, text+WhatsApp+email, deposits, pay runs | **£49/mo** | ~£25 | ~50% |
| **Shop** — up to 5 chairs (the reference) | Everything in Studio + AI receptionist + reports | **£89/mo** | ~£85–£100 | ~0–5% at heavy use → **too thin** |
| **Shop** at **£119/mo** | same | **£119/mo** | ~£85–£100 | **~20–30%** |
| **Salon** — up to 10 chairs, multi-location | + locations, priority support | **£199/mo** | ~£170 | ~15–25% |

**Recommendation: £119/month for the 3–5 chair shop, £49 for the solo/duo tier, £199 for 6–10 chairs.**
Add a **fair-use line** in the terms rather than metering: e.g. "includes 1,500 messages and 400 call
minutes a month; beyond that 5p/text, 2p/WhatsApp, 10p/minute" — 95% of shops never hit it, and it
protects you from the one shop that turns on every reminder for 12 barbers. Offer **14-day free trial,
no card**, and **10% off annual** (pays for the trial churn).

At £119, a 3-barber shop paying you £1,428/year costs you £1,020–£1,200 to serve — the margin is real
but not lavish, which is why the WhatsApp push and the pooled ElevenLabs minutes matter. The margin
improves sharply with scale (fixed cost per shop drops to pennies) and with any shop that doesn't turn
the receptionist on.

## 5. What to watch
- **ElevenLabs minutes**: Pro pools 1,238 min across all shops. At 390 min/shop, four receptionist-heavy
  shops exhaust it; the overage is $0.08/min (~£24 per shop-month) which is what the model above assumes.
  Move to Scale ($299, 3,738 min) once ~8 shops use it.
- **ClickSend tiers**: top-ups from $500 drop the per-SMS rate ~30%; buy credit in bulk once volume justifies it.
- **WhatsApp**: the OLLO sender needs Meta business verification before the £0.018 rate applies; until
  then WA falls back to text and costs the SMS rate.
- **Stripe active-account fee** only bills for accounts that received a payout that month — barbers on
  "pay in shop" cost nothing.
