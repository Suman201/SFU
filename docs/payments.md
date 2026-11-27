# Payments, commission and teacher payouts

Students pay class fees online, the platform keeps a configurable commission, and teachers withdraw their share. Collection uses **Stripe Checkout**; teacher payouts use **Stripe Connect** (Express accounts, separate charges and transfers). Card details never reach Sapiovian servers.

## Switching it on

MongoDB must run as a replica set or mongos: booking credits and payout balance changes use transactions. Provision the financial indexes before enabling payouts.

| Variable | Purpose |
| --- | --- |
| `PAYMENTS_ENABLED` | `true` makes paid classes require a verified payment. When `false`, paid classes retain the existing booking checkout and cannot self-enroll for free. |
| `PAYMENT_GATEWAY` | `stripe` (required in production) or `test` (local simulator; never moves money; rejected in production). |
| `STRIPE_SECRET_KEY` / `PAYMENTS_STRIPE_WEBHOOK_SECRET` | Secret key and webhook signing secret (`*_FILE` variants supported). Production requires live keys. |
| `STRIPE_CONNECT_ENABLED` | Teacher payouts through Connect (default `true`). |
| `PAYMENTS_WEB_URL` | Website origin for checkout return pages (defaults to `FRONTEND_URL`). |
| `PAYMENT_CHECKOUT_TTL_MINUTES` | Checkout lifetime and seat hold (30–1440, default 30). |

Stripe setup:

1. Enable Connect (Express) in the Stripe dashboard.
2. Add a webhook endpoint `https://<api-host>/api/v1/payments/webhooks/stripe` with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.payment_failed`, `refund.created`, `refund.updated`, `refund.failed`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `account.updated`, `transfer.reversed`. Also enable "Listen to events on Connected accounts" for `account.updated`.
3. Locally: `stripe listen --forward-to localhost:3000/api/v1/payments/webhooks/stripe` and set `PAYMENTS_STRIPE_WEBHOOK_SECRET` to the printed `whsec_` secret. This endpoint and the booking webhook require their respective signing secrets.

## Flow

1. **Checkout** – the student chooses *Pay & enroll*. The server rechecks the class, price, enrollment and capacity, holds a seat for the checkout lifetime, records a `pending` payment with the commission rate in force, and returns a Stripe Checkout URL. A second click reuses the open checkout; only one open or paid payment per student and class can exist (unique `activeKey`).
2. **Verification** – access is granted only from a signed webhook, never from the browser redirect. Webhooks are verified on the raw body, stored once by event id (`payment_gateway_events`), acknowledged immediately and applied by a worker with retries and backoff.
3. **Settlement** (idempotent, re-runnable): mark paid and assign `RCPT-YYYY-NNNNNN`; post the ledger capture; record the Stripe processing fee (borne by the platform); grant enrollment. If the class filled up or closed, the payment is refunded automatically.
4. **Holding period** – the teacher share stays *pending* for `holdDays`, then becomes *available*. Disputed payments are not released.
5. **Payouts** – the teacher connects a Stripe Express account and requests a payout up to the available balance. Reservation, cancellation and financial adjustments share a database transaction lock per teacher. Approval sends the original idempotent Stripe transfer. Unknown outcomes keep funds reserved; after 23 hours another send is blocked until finance verifies the original transfer ID. Partial transfer reversals return only the newly confirmed amount.

## Money and currency

- Every amount is an integer of minor units plus a currency code. The finance registry shares all 27 product currency codes and their zero-, two- or three-decimal precision. Existing class checkout collection remains USD-only; booking collection keeps its separate `BOOKING_CHARGE_CURRENCIES` configuration. A registered currency alone does not enable collection or payouts.
- Commission is stored in basis points (1500 = 15%), rounded half-up; the teacher receives the exact remainder.
- Refunds split commission and teacher share proportionally and cumulatively, so a full refund returns exactly the original split.
- Finance settings require an explicit payout minimum for each additional currency. Payout support is checked separately from checkout support. The Stripe Connect adapter accepts registered zero- and two-decimal currencies subject to the actual platform/connected-account capabilities; three-decimal transfers stay blocked. The synthetic test adapter supports them to verify accounting precision. No internal FX conversion or cross-currency balance netting occurs.

## Ledger

`ledger_entries` holds balanced double-entry journal entries. Each entry stores all its lines in one document. Booking settlement, fiscal records and payout reservations also use MongoDB replica-set transactions and has a unique key such as `payment:<id>:captured` or `refund:<id>`, so replayed events never double count.

| Event | Lines |
| --- | --- |
| Payment captured | Dr gateway clearing; Cr platform revenue (commission); Cr teacher pending |
| Processing fee | Dr gateway fees; Cr gateway clearing |
| Earnings released | Dr teacher pending; Cr teacher available |
| Refund | Dr platform revenue; Dr teacher pending/available; Cr gateway clearing |
| Class-payment dispute opened / won / lost | Funds to/from dispute hold; teacher share frozen, returned or reversed |
| Booking payment captured / refunded | Commission and teacher share use net lesson fees; tax credits/debits stay in tax payable |
| Payout requested / returned / paid / reversed | Teacher available ↔ reserved; reserved → gateway clearing |

*Admin → Finance → Ledger & reconciliation* checks that every entry balances, every paid payment has a capture entry with the right teacher share, access was granted, and no gateway event failed. Super admins can re-run settlement for flagged payments.

## Roles

| Area | Roles |
| --- | --- |
| Pay, history, receipts | Student (own payments only) |
| Earnings, payout requests, payout account | Teacher (own balance only) |
| Payments, refunds, disputes, payouts, reports, ledger | Admin, Super Admin |
| Commission, holding period, minimum payout, currencies, overrides; reconciliation repair | Super Admin only |

All changes are written to the audit log.

## Local development

```sh
PAYMENTS_ENABLED=true PAYMENT_GATEWAY=test npm run dev:backend
```

The test gateway opens `/payments/test-checkout/:id` instead of Stripe, with *Pay with test card* and *Simulate declined card*. Admins can simulate disputes on a payment's detail page. Events run through the same pipeline as Stripe webhooks.

## Not covered yet

- Recurring (monthly) billing per batch: fees are one-time per batch.
- Teacher promotion fees retain their existing manually confirmed payment flow. Individual and batch bookings retain the implemented reservation, Stripe verification, invoice and credit-note flow described in [booking payments](booking-preview.md).
- Responding to disputes with evidence happens in the Stripe dashboard.
- Tax/VAT on the separate class-payment checkout is not calculated; bookings retain their existing invoice tax snapshot.
- Booking dispute evidence, lost-chargeback accounting, tax treatment and any recovery of an already-sent transfer require manual finance review. Verified open or lost booking disputes block further payouts in that teacher/currency; a provider-confirmed win or closed inquiry clears that dispute hold. See [booking earnings](booking-earnings.md).

## Local merge integration

New booking reservations now snapshot commission and holding policy and post to the same earnings ledger as class payments. `/finance/overview` and teacher earnings include all posted booking and class-payment journals. `/finance` remains the booking cash report, including historical orders that have not been adopted into earnings. Historical paid bookings require a super administrator to verify the original provider payment and approve a commission policy. Do not add these reports together. Payment-list CSV exports still cover the separate class-payment records; booking exports remain in booking operations. See [booking earnings rollout and reconciliation](booking-earnings.md).

Class charges read the explicit `feeMinor` and `feeCurrency` snapshot. A legacy fee without a known currency, or a currency unsupported by this payment gateway, is rejected rather than assumed to be USD. The new gateway currently collects USD; existing booking charge currencies remain independent. Paid self-enrollment stays blocked even when the new payments flag is disabled. Both checkout paths and administrative enrollment respect the other path's held capacity.

Managed staff use `admin:finance:read` and `admin:finance:write` for the new APIs and controls. Finance settings changes and reconciliation repair remain super-admin-only. The shared Stripe SDK stays at the version already used by bookings. Configure `PAYMENTS_STRIPE_WEBHOOK_SECRET` for the new endpoint; its legacy `STRIPE_WEBHOOK_SECRET` fallback is only suitable when that secret belongs to this endpoint.

## Production index provisioning

Production disables automatic MongoDB index creation. After building the backend, run `npm run setup:payments` with `MONGODB_URI` or `MONGODB_URI_FILE`; add `-- --allow-remote` for the reviewed remote target. This creates missing payment-ledger, idempotency and payout collections/indexes while preserving existing records. Existing duplicates fail the setup instead of silently weakening uniqueness. `npm run test:p0:setup` verifies repeatability and duplicate-payment rejection on an isolated local database.

The product CI uses synthetic provider adapters and a local SMTP sink. Hosted Stripe Checkout, deployed webhook/refund processing, approved issuer/tax/legal values and external email receipt remain deployment acceptance requirements; see [P0 release readiness](p0-release-readiness.md).
