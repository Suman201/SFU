# Static booking and payment preview

Open `/booking` for a standalone sample, or choose **Preview booking** on a public teacher profile (`/teachers/:teacherId/book`). The teacher-specific route reads the existing public profile and preserves that teacher on refresh. It shows an error rather than substituting a sample teacher if the profile is unavailable.

The preview offers a 25-minute introduction and a 50-minute lesson, example EUR prices, two weeks of generated sample availability, timezone conversion, optional learning goals and an order summary. Changing timezone preserves the same selected instant. Changing the selected day clears the time and blocks payment until a new time is chosen.

Payment uses read-only sample card details, editable sample billing fields, a successful/declined card selector, a processing state, decline/retry handling and an explicit preview completion screen. The downloadable text summary identifies itself as a preview and excludes card/billing details. All booking/payment state remains in component memory. No booking, enrollment, payment, email or billing-data API write is made. Reloading starts a new preview.

The displayed lesson options, prices, availability and zero booking fee are sample data, including when a real teacher name is shown. Existing class enrollment is unchanged. This preview does not add a one-to-one scheduling backend, hold a time, charge money, or create a classroom entitlement.

## Verification

Build with `npm run build:frontend`. Run `npm run test:browser -- tests/browser/booking-preview.spec.ts --project=chromium --project=firefox --project=webkit`.

Validated on 28 October 2026: the production frontend build passed and all 12 browser checks passed across Chromium, Firefox and WebKit. Screenshots cover lesson selection, date/time, payment, completion and mobile dark mode.

The browser tests serve the built website statically. They exercise the flow, timezone conversion, date edits, payment decline/retry, billing validation, download, responsive/dark UI, and absence of booking/payment writes or billing data in browser storage. The teacher-link test explicitly stubs public profile/catalogue reads; these are static UI tests, not gateway or real booking-backend acceptance. Set `BOOKING_UI_OUTPUT` to save screenshots to a chosen directory.

## Gateway integration later

Replace sample offers and slots with server-owned prices, currency, availability and expiring reservations. Create orders and payment sessions on the server, use gateway-hosted/tokenised card fields, verify signed provider webhooks, and grant enrollment exactly once after verified payment. Add failed/expired/cancelled order recovery, refunds, receipts and teacher earnings before enabling real paid bookings. Never activate enrollment based on this client-side preview's completion state.
