# Booking earnings and payouts

New individual-lesson and batch reservations share the existing teacher earnings ledger and payout workflow. They do not create shadow class-payment rows or duplicate enrollments. Historical paid bookings remain outside earnings until reviewed.

## Accounting and release

- Reservation freezes the teacher's commission rate, settings version and holding period. Later setting changes affect new reservations only.
- Verified payment, paid invoice and capture journal commit together. Capture debits gateway clearing for the gross collection and credits platform commission, teacher pending and tax payable separately. Commission applies to the invoice's net lesson fee.
- Availability requires recorded lesson completion (all remaining classes completed/cancelled for a batch, with at least one completion) and the later of booking end or payment time plus the frozen hold period. Cancelled, unfulfilled, disputed and unresolved-refund bookings do not release.
- Every journal uses an immutable source key. Replayed payment/refund events cannot create another credit. Teacher balance locks are updated inside the same Mongo transaction used for refunds and payout reservation, so concurrent requests share one balance boundary across backend instances.
- Confirmed fiscal credit-note tax is authoritative. Refunds split the credited net fee cumulatively and save the exact teacher/commission allocation and original pending/available bucket. A full refund reverses the original split exactly, including zero- and three-decimal currencies. A refund after payout can create a negative available balance; future earnings cover that debt before another payout.
- Verified same-currency provider fees are platform expenses. Unavailable fees and fees in a different settlement currency remain visible reconciliation exceptions. The system does not guess FX rates.

## Payout controls

A teacher selects a currency and requests exact minor units. Additional payout currencies need explicit minima in Finance settings. Registering a currency does not establish Stripe account or country support. The live provider can still reject an unsupported destination/currency. Three-decimal Stripe Connect transfers are blocked; their accounting is tested through the synthetic adapter.

Payout request + reservation and cancellation/rejection + return each commit atomically. Refund review, booking disputes, negative available balances and Stripe live/test mismatches block new sends. The original destination, amount, currency and environment remain fixed during retries. An uncertain provider outcome keeps the reservation. After 23 hours, finance must use **Reconcile transfer** with the original Stripe transfer ID and a reason; that operation reads and verifies provider ownership, destination, currency, amount and metadata without creating another transfer. Cumulative partial reversals return only the newly confirmed difference.

Stripe idempotency keys [can be pruned after 24 hours](https://docs.stripe.com/api/idempotent_requests), which is why an aged unknown transfer must not be blindly sent again. Connect [separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers) leave refunds and chargebacks with the platform; a refund does not automatically reverse an already-created transfer.

## Disputes and manual settlement boundary

Configure the booking endpoint `/api/v1/bookings/stripe/webhook` with its own `STRIPE_WEBHOOK_SECRET`. In addition to existing checkout/refund events, deliver `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn` and `charge.dispute.funds_reinstated`. The durable inbox retrieves the current provider object. Periodic paid-order reconciliation also checks provider disputes to recover missed events.

Verified open and lost disputes block all payouts for the affected teacher/currency and prevent that booking's release. Other currencies remain independent. A verified `won`, `warning_closed` or `prevented` result clears only that dispute. Older open snapshots cannot overwrite terminal provider state. The reconciliation screen lists affected booking IDs.

Booking dispute evidence stays in Stripe. Lost-chargeback journal allocation, any tax credit and recovery of an already-sent Connect transfer remain manual finance work. A lost booking dispute deliberately retains its hold; there is no local button that declares it won or silently releases the balance. Booking ledger reports reflect posted captures/refunds/fees and must not be treated as a fully settled provider statement while these exceptions remain. Resolve the settlement with finance before further payouts in that currency.

## Rollout and historical orders

1. Back up the target database. Deploy with payout sends disabled until reviewed. MongoDB must be a replica set or mongos.
2. Build the backend, then run `npm run setup:bookings` for the reviewed database (`-- --allow-remote` only for an approved remote target). It additively provisions booking and payment financial collections/indexes, including unique journal keys. `npm run setup:payments` remains available independently. Duplicates cause setup to fail; records are never silently discarded.
3. Configure booking and payment webhook signing secrets separately. Both adapters must use the same intended Stripe platform and live/test environment. Configure the relevant account capabilities and per-currency payout minima; do not automatically translate a USD minimum into another currency.
4. In **Finance → Ledger & reconciliation**, review historical paid bookings. A super administrator enters the agreed historical commission, hold days and reason. The server re-verifies the original provider payment, checks concurrent changes, restores capture/refund journals and records one audit event. No guessed commission is backfilled automatically. Existing confirmed refunds and enrollment state are respected.
5. Run reconciliation through all pages (1,000 bookings per page), review unfulfilled payments, missing/mismatched journals, disputes and unrecorded/foreign-currency fees. Missing entries can be restored from saved immutable financial facts; mismatches need investigation. Confirm lesson completion before release.
6. Verify hosted Checkout, signed delivery, refund credit notes and a controlled Connect transfer in the deployment acceptance environment before enabling real payouts. Repository tests substitute only the provider network and do not prove account/country availability or production credentials.

Rollback: disable payout sends and new reservations first; leave provider reconciliation running with the original secrets. Keep all journals, policies, invoices, refund allocations and idempotency keys. Do not run the previous unguarded payout code against newly credited booking balances. Prefer a forward fix; restoring a database independently of external Stripe transfers risks duplicate payments.

## Verification

`npm run test:admin:integration` includes real Mongo replica-set and Redis scenarios for capture rollback, policy snapshots, completion gating, concurrent payout limits, refund debt/recovery, exact currencies, historical adoption, dispute holds, uncertain transfers and partial reversals. `npm run test:finance:browser` verifies teacher currency balances, exact payout input, admin approval, permission-aware historical review, mobile/dark presentation and accessibility in Chromium, Firefox and WebKit. CI retains screenshots and traces under `reports/finance` and `test-results/finance`.
