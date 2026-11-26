# Payments, commission and teacher payouts

Students pay class fees online, the platform keeps a configurable commission, and teachers withdraw their share. Collection uses **Stripe Checkout**; teacher payouts use **Stripe Connect** (Express accounts, separate charges and transfers). Card details never reach Sapiovian servers.

## Switching it on

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
5. **Payouts** – the teacher connects a Stripe Express account and requests a payout up to the available balance (serialised per teacher). An admin approves (Stripe transfer with an idempotency key; safe to retry) or rejects with a reason.

## Money and currency

- Every amount is an integer of minor units plus a currency code. Currencies live in a registry (`PAYMENT_CURRENCIES` in `packages/contracts/src/payments.ts`); USD is enabled, INR is registered but disabled.
- Commission is stored in basis points (1500 = 15%), rounded half-up; the teacher receives the exact remainder.
- Refunds split commission and teacher share proportionally and cumulatively, so a full refund returns exactly the original split.
- Adding INR later: enable it in *Finance settings*, set explicit `feeCurrency: 'INR'` and `feeMinor` on batches, and add a gateway adapter (e.g. Razorpay) implementing `PaymentGateway`. Ledger, reports and UI already work per currency.

## Ledger

`ledger_entries` holds balanced double-entry journal entries. Each entry stores all its lines in one document (atomic without MongoDB transactions) and has a unique key such as `payment:<id>:captured` or `refund:<id>`, so replayed events never double count.

| Event | Lines |
| --- | --- |
| Payment captured | Dr gateway clearing; Cr platform revenue (commission); Cr teacher pending |
| Processing fee | Dr gateway fees; Cr gateway clearing |
| Earnings released | Dr teacher pending; Cr teacher available |
| Refund | Dr platform revenue; Dr teacher pending/available; Cr gateway clearing |
| Dispute opened / won / lost | Funds to/from dispute hold; teacher share frozen, returned or reversed |
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
- Tax/VAT on class fees is not calculated.

## Local merge integration

The payment branch is integrated with the existing booking, currency and staff-permission work. `/finance` keeps the booking collections report; `/finance/overview` opens the new payment-ledger overview. These reports cover their respective record types and must not be treated as one combined financial statement. Existing booking orders do not automatically create commission ledger entries or teacher payout balances.

Class charges read the explicit `feeMinor` and `feeCurrency` snapshot. A legacy fee without a known currency, or a currency unsupported by this payment gateway, is rejected rather than assumed to be USD. The new gateway currently collects USD; existing booking charge currencies remain independent. Paid self-enrollment stays blocked even when the new payments flag is disabled. Both checkout paths and administrative enrollment respect the other path's held capacity.

Managed staff use `admin:finance:read` and `admin:finance:write` for the new APIs and controls. Finance settings changes and reconciliation repair remain super-admin-only. The shared Stripe SDK stays at the version already used by bookings. Configure `PAYMENTS_STRIPE_WEBHOOK_SECRET` for the new endpoint; its legacy `STRIPE_WEBHOOK_SECRET` fallback is only suitable when that secret belongs to this endpoint.

## Production index provisioning

Production disables automatic MongoDB index creation. After building the backend, run `npm run setup:payments` with `MONGODB_URI` or `MONGODB_URI_FILE`; add `-- --allow-remote` for the reviewed remote target. This creates missing payment-ledger, idempotency and payout collections/indexes while preserving existing records. Existing duplicates fail the setup instead of silently weakening uniqueness. `npm run test:p0:setup` verifies repeatability and duplicate-payment rejection on an isolated local database.

The product CI uses synthetic provider adapters and a local SMTP sink. Hosted Stripe Checkout, deployed webhook/refund processing, approved issuer/tax/legal values and external email receipt remain deployment acceptance requirements; see [P0 release readiness](p0-release-readiness.md).
