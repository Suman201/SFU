# Booking, payments and refunds

The sample checkout has been replaced. `/booking` points customers to teachers; `/teachers/:teacherId/book` reads an approved teacher’s published offers and actual UTC availability. Teachers manage offers and timezone-aware availability at `/teacher/bookings/availability`. Students review reservations and documents at `/bookings`; staff review refunds in the admin portal’s **Bookings and refunds** page.

## Enable payment collection

1. Use a MongoDB replica set or mongos. Financial changes use snapshot transactions with majority writes; standalone MongoDB cannot run this module.
2. Build contracts and backend, then run `npm run setup:bookings` with the intended `MONGODB_URI` or `MONGODB_URI_FILE`. For a nonlocal target, explicitly add `-- --allow-remote`. This creates required collections and indexes without deleting records. Resolve any existing duplicate data before enabling bookings. Soft-deletion partial indexes use MongoDB-supported null equality (matching missing/null), rather than unsupported `$exists: false`.
3. Set the invoice issuer through the admin invoice settings, including real legal name, email, address and applicable tax registration. The sample issuer must be replaced and saved. Configure `BOOKING_TAX_RATE_BPS` explicitly and `BOOKING_TAX_NOTE` for the applicable treatment. Zero tax requires an explanation. These settings are merchant supplied; this module does not determine international tax obligations or perform automatic tax calculation.
4. Configure `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `FRONTEND_URL`, and `BOOKING_CHARGE_CURRENCIES` for the intended Stripe account. Enable only currencies supported by that account. Start with test keys. Configure a Stripe webhook to `POST /api/v1/bookings/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `refund.created`, `refund.updated`, `refund.failed`, and `charge.refunded`.
5. Set `BOOKINGS_ENABLED=true`, restart, and publish teacher offers and times. Confirm `BOOKING_CANCELLATION_NOTICE_HOURS` (default 24) before accepting orders. Perform a Stripe test checkout, signed webhook delivery, invoice download and refund in the intended deployment before switching to live keys. Live activation and deployment are separate operator steps.

Bookings are disabled by default. Payment reconciliation continues when Stripe credentials remain configured even if new reservations are disabled. Keep credentials and the worker available until outstanding payments and refunds settle.

## Financial and scheduling rules

- The server reads prices, taxes, currency and availability. Client totals and offer versions confirm customer consent; they cannot set a charge. The billing email comes from the authenticated purchaser’s account.
- Reservations hold a teacher slot or batch capacity for 45 minutes. Checkout begins during the first 14 minutes, leaving Stripe’s required minimum session lifetime. An unpaid reservation is released only after any potentially created checkout is recovered and closed. Repeated reservation, payment-session and refund requests reuse idempotency keys.
- Checkout redirects to Stripe’s hosted page. Card information never enters the app. The return URL cannot confirm payment: the backend retrieves the authoritative session and successful PaymentIntent, checks exact amount, currency, customer/order metadata and test/live environment, then grants enrollment exactly once.
- A verified individual lesson creates a private batch and class session using existing classroom enrollment permissions. Private batches are excluded from public discovery. Paid batch self-enrollment cannot bypass checkout; free enrollment remains available. Administrative complimentary enrollment respects held capacity.
- Teacher and student locks prevent overlapping individual bookings. Published availability is checked against existing planned and rescheduled classes. Private lessons must be cancelled through their booking. Resolve active purchases/holds before structural batch cancellation or schedule changes.
- Prices, issuer, billing details, taxes and cancellation deadline are snapshotted on the order. Display-currency equivalents are indicative; checkout and refunds retain the original charge currency. No exchange conversion is submitted as a payable amount.
- A durable signed webhook inbox and leased workers recover duplicates, missing webhooks, restarts and lost provider responses. A mismatched payment enters `payment_review` without granting new access. Staff must investigate that state through the provider and order records; it is never shown as paid based on client input.
- Verified payment creates one numbered paid invoice and retained PDF. Existing paid-invoice email delivery is reused. Later issuer or offer edits cannot change issued documents.
- Customers may cancel before their saved deadline for the remaining full refund. Teachers and administrators may authorize exceptions. Administrators may issue partial refunds, which preserve access. A requested full refund cancels access; provider confirmation determines the final refunded balance. A failed refund retains its record and requires a new authorized refund request after investigation.
- Successful refunds create numbered credit notes with proportional tax allocation; all partial credits together reconcile exactly to the original totals. They never alter the original paid invoice. Credit PDFs remain downloadable and are emailed through the existing SMTP service when enabled. Provider-side refunds are reconciled too. End a live lesson before initiating a full refund in the app; a provider-side refund records financial truth and revokes future access without forcibly terminating existing media.

The implementation does not add teacher payouts, chargeback handling, subscriptions, tax jurisdiction determination or automatic foreign-exchange charging.

## Verification

Build `@native-sfu/contracts`, `@native-sfu/backend`, `@native-sfu/frontend` and `@native-sfu/admin-portal` before acceptance tests.

Create dedicated temporary test services before running acceptance (the example ports must be free):

```sh
docker run --rm -d --name sfu-booking-mongo -p 127.0.0.1:27124:27017 mongo:7 --replSet booking-tests --bind_ip_all
docker exec sfu-booking-mongo mongosh --quiet --eval 'rs.initiate({_id:"booking-tests",members:[{_id:0,host:"127.0.0.1:27017"}]})'
docker run --rm -d --name sfu-booking-redis -p 127.0.0.1:6395:6379 redis:7-alpine
npm run test:bookings
# After all integration/browser checks finish:
docker stop sfu-booking-mongo sfu-booking-redis
```

The financial integration suite uses isolated MongoDB 7 on `127.0.0.1:27124`, replica set `booking-tests`, and isolated Redis on `127.0.0.1:6395`. The Mongo connection uses `directConnection=true&replicaSet=booking-tests`. Run `node --test tests/integration/booking-payments.test.cjs`. It creates and drops only uniquely named `booking_acceptance_*` databases. Do not point these tests at an application database.

Run `npm run test:browser -- tests/browser/booking-reservations.spec.ts --project=chromium --project=webkit`. Set `BOOKING_UI_OUTPUT` to save screenshots. Tests use the actual built UI, Nest HTTP/authentication, MongoDB indexes and transactions. Only Stripe network calls are substituted with a test-only provider in `tests/browser/helpers/booking-stack.cjs`; webhook signatures still use the official SDK. This is local integration evidence, not proof of merchant credentials, live settlement or delivered external email. No real card is charged by these tests.
