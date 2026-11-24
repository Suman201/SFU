# Multi-currency pricing

Prices have two separate concerns: the original price currency and the customer's preferred display currency. Changing the display preference never rewrites prices, promotion receipts or issued invoices.

## Money and supported currencies

`packages/contracts/src/money.ts` defines the supported ISO 4217 codes, accounting decimal places, exact decimal parsing, bounded integer minor units, formatting and reference conversion. EUR, GBP, USD, INR, AUD, CAD, NZD, CHF, SEK, NOK, DKK, PLN, CZK, HUF, RON, AED, SAR, SGD, HKD, CNY, BRL, MXN and ZAR have two decimals; JPY and KRW have zero; KWD and BHD have three. This is an accounting model, not a promise that every payment method or payout provider supports these currencies. Provider-specific amount rules must be enforced in the future gateway adapter.

## Batch prices and existing records

Canonical batch prices are `feeMinor` plus `feeCurrency`. `feeAmount` remains a major-unit compatibility field. The backend accepts either representation, rejects excess precision and inconsistent representations, and computes the compatibility field from the canonical amount. New paid prices require an explicit currency. Free batches can remain currency-free.

Historical batch records have no reliable currency. Their amounts remain unchanged and are displayed with “currency not set”. They are never converted by guessing a currency, including from invoice settings, locale or DEFAULT_CURRENCY. An administrator can open the batch editor and explicitly select its actual original currency. Saving that choice identifies the existing price without FX conversion. Unrelated edits preserve unknown legacy prices. Once a currency is known, changing it requires an explicit new price.

`DEFAULT_CURRENCY` (EUR by default, validated at startup) is a new-editor/display fallback. It is not a bulk migration setting. A migration must identify the historical currencies from business records before assigning them.

## Display preference and exchange rates

The shared header exposes an accessible display currency selector. Guests keep a device preference. Signed-in preferences are stored on the authenticated user and cached separately per account on that device. Preference updates never accept a target user ID. Failed account sync is reported while retaining the device preference. Pending choices are retried when that account is restored, without allowing an older server read to overwrite the pending device choice.

Public API:

- `GET /api/v1/currencies`: supported currencies, default and current reference snapshot.
- `GET /api/v1/currencies/quote?amountMinor=1500&currency=EUR&target=INR`: an explicitly indicative server quote including both original and converted money, reference date and expiry. This is not an order or payment quote.
- Authenticated `GET/PATCH /api/v1/currencies/preference`, PATCH body `{ "currency": "INR" }`.

The backend fetches Frankfurter v2 reference rates over HTTPS, with a five-second timeout, one in-flight refresh per process, an hourly Redis/process cache and failure backoff. Rates expire after 12 hours and references older than seven days are excluded, allowing normal weekends and holidays. Missing, malformed, expired or unavailable pairs fall back to the original currency. No fabricated fallback rates are shipped. Reference conversions use integer rational arithmetic and round half-up once to the destination minor unit. The frontend uses the same calculation with the server-owned snapshot; converted prices show an approximation sign alongside their original price.

Frankfurter publishes reference rates, not executable live market prices: https://frankfurter.dev/ . Accounting units and gateway-specific differences: https://docs.stripe.com/currencies .

## Invoices, promotions and payment boundary

Invoices support the shared currencies. Editors, PDF generation and emails respect each currency's decimal scale. Issued invoice snapshots and stored PDF bytes remain immutable. Changing invoice currency changes a draft's unit of account; it does not run an FX transaction.

Promotion prices remain the existing EUR price schedule; reference equivalents can be displayed without changing the payable EUR amount. Promotion confirmation remains an administrator's record of an external payment.

[Real bookings](booking-preview.md) use published server-owned prices and expiring reservations. The original amount, currency, billing details and tax treatment are frozen on the order. Verified provider payments create enrollment and invoices; confirmed refunds create credit notes in the original currency. Display currency changes only indicative equivalents. Client reference conversions are never authorized charge or refund amounts.

## Verification

Focused backend suites: money arithmetic, currency HTTP validation/authentication, provider cache/outage behavior, batch legacy migration, and existing invoice/profile/batch/enrollment regressions. Browser coverage exercises the selector, guest persistence, live price changes, original-currency fallback, mobile layout and invoice decimal precision. Run browser checks headlessly.

The real-backend browser suite is `tests/browser/multi-currency-runtime.spec.ts`. It creates and drops a uniquely named local MongoDB database and uses an isolated Redis instance on port 6394. It seeds synthetic reference rates and sends no customer emails. For example, with local MongoDB on port 27018:

```sh
docker run --rm -d --name sfu-currency-test-redis -p 127.0.0.1:6394:6379 redis:7-alpine
MONGODB_URI=mongodb://127.0.0.1:27018/unused REDIS_URL=redis://127.0.0.1:6394 npm run test:browser -- tests/browser/multi-currency-runtime.spec.ts --project=chromium --project=webkit
docker stop sfu-currency-test-redis
```
