# Admin operations

The admin portal includes saved-whiteboard review and recovery, searchable booking operations, staff access profiles, automatic session renewal, and original-currency booking cash reporting.

## Deployment preparation

Build contracts and the backend, then run the additive index setup against the intended database:

```sh
npm run build -w @native-sfu/contracts
npm run build -w @native-sfu/backend
MONGODB_URI_FILE=/path/to/database-uri npm run setup:admin-operations
```

A remote database additionally requires `-- --allow-remote`. The setup creates missing collections and indexes; it does not rewrite user access, delete data, or drop indexes. MongoDB must support transactions (replica set or mongos). The browser screens use the normal admin build and API configuration. Bookings retain their existing Stripe, webhook, worker and email configuration; no live payment credentials are required merely to review saved boards or manage staff profiles.

## Whiteboards

`/whiteboards` searches saved boards by lesson, page title, topic, class/batch reference and teacher ID. Review uses the existing shared whiteboard renderer with editing, page management, imports and clear actions disabled. Up to 100 recent checkpoints can be previewed. PNG and PDF exports render the displayed snapshot locally; JSON exports retrieve the selected persisted snapshot through the authorized API. Review does not join the media room or mutate the board.

Recovery requires a separate restore permission, a reason, confirmation and the exact snapshot/operation sequence that was reviewed. A transaction locks the class record, rejects live classes or changed boards, saves the current board as a backup checkpoint, and writes the restored checkpoint and state atomically. Audit metadata records the source, backup, resulting checkpoint and reason. Recovery does not publish a board to students or change existing publication settings. Classroom snapshot retention continues to follow the existing classroom policy; a recovery backup is a checkpoint rather than an indefinite archival guarantee.

## Booking operations

`/bookings` has URL-backed search, status, kind, currency, creation-date and refund-status filters, stable pagination and filtered CSV export. Dates use UTC. Page sizes are 10, 25, 50 and 100; pagination can reach older records beyond the former 100-order limit. CSV exports include minor-unit amounts plus currency, escape spreadsheet formulas and require filters to match at most 10,000 records.

Managing an order exposes verified payment references, paid invoice and confirmed credit-note downloads where permitted. **Recheck provider** retrieves current Checkout/payment/refund truth; it cannot manually mark a payment paid or override the agreed amount, currency, student or live/test mode. An unresolved mismatch stays under review for provider investigation.

A failed refund can be retried as a new, linked request after a reason and confirmation. The original failure stays in history. Pending requests retain their original provider idempotency key. The server prevents multiple active or successful retries for the same failed intent, even if separate tabs submit different request IDs. Actual refund completion and credit notes still require verified provider success. Historical failed attempts with a queued, pending or successful retry are excluded from current unresolved-failure counts.

## Staff access

Only super admins can create/edit/deactivate/delete managed access roles or assign them to existing administrator accounts at `/staff`. Staff profile changes are audited, use current-version/current-assignment checks, and take effect on the next authenticated HTTP request, including requests with previously issued tokens. System and super-admin roles cannot be assigned or modified through this screen. Assigned profiles cannot be deleted until their accounts have been reassigned.

Existing administrators without a profile retain default administrator access. Removing a profile assignment deliberately restores that default access and has a prominent confirmation. A missing or inactive assigned profile grants no admin permissions. Action permissions require the corresponding view permission. Managed profiles have no implicit access to unclassified legacy APIs; shared self-service authentication/profile/notification/desktop endpoints retain their own checks. Older enrollment, assignment and whiteboard APIs are also permission checked. Managed staff must use the controlled whiteboard recovery API for mutations. Navigation and direct routes use the same module permissions, while the backend remains authoritative. Managed staff cannot establish classroom administrator sockets. Already connected non-super administrators are reauthenticated before subsequent socket packets, so assigning a bounded profile also removes that legacy bypass. Teacher, student and super-admin socket paths retain their existing behavior.

## Session renewal

Expired tokens are renewed through the existing rotating refresh-token endpoint. Concurrent requests in a tab share one renewal; an API 401 gets one authenticated retry. Remembered sessions preserve local storage, while other sessions remain in session storage. Logout or a newer login wins over late renewal responses. Credentials are never attached to unrelated origins. Temporary network/provider errors preserve renewal credentials so the user can retry; definitive authentication rejection clears the session. Separate tabs still use the server's existing refresh-rotation rules.

## Financial overview

`/finance` reports up to 366 UTC days, separately for each original currency. Collections use verified booking `paidAt` and the agreed tax-inclusive total. Confirmed refunds use the actual credit-note creation date and amount, including refunds of earlier payments. Net collected is collections less refunds. Processor fees, settlement timing, FX conversion and accounting revenue recognition are excluded. Draft/manual invoices are not booking collections.

Booking creation, paid-booking and cancellation trends use their respective event dates. Pending refund balances, unresolved failed-refund intents and payment reviews are explicitly current operational figures, independent of the selected date range. No mixed-currency monetary grand total is produced. Daily chart/table data and CSV preserve original currency and integer minor units.

## Repeatable validation

Use the isolated local test Mongo replica set on port 27124 (`booking-tests`) and Redis on port 6395. Fixtures refuse other destinations, create `booking_acceptance_*` databases and remove only their own database. Build the backend and admin app before acceptance tests; do not rebuild the backend while a fixture is running.

```sh
npm run test:admin-operations
npm run test:bookings
npm run build -w @native-sfu/admin-portal
npm run test:browser -- tests/browser/admin-completion.spec.ts --project=chromium --project=webkit
```

`ADMIN_COMPLETION_OUTPUT` selects an absolute screenshot folder. Acceptance runs against the real Nest HTTP API, Mongo transactions and Redis. Only the external Stripe network boundary is replaced with a deterministic test adapter; this does not establish live merchant-account or email-delivery readiness. Browser tests run headlessly and exercise token renewal, role creation/assignment and forbidden routes, whiteboard version preview/exports/recovery, booking filtering/pagination/CSV/refund retry, and currency-separated reporting across desktop, tablet and mobile layouts.

Validated locally on 25 November 2026: contracts, backend, frontend and admin builds; 66 focused backend tests; nine headless admin auth/root tests; eight admin operations and 15 payment integration scenarios; existing admin route regression checks; and the complete real-backend admin workflow in Chromium and WebKit. Screenshots cover 1440px desktop, 820px tablet and 390px mobile layouts, including light and dark views. A failed financial date-range request also clears prior results and disables their export. These checks do not replace production configuration, live Stripe merchant-account, SMTP delivery or deployment signoff.

The remaining permission-aware controls and automated checks are implemented in [Admin permissions and CI](admin-ci.md). Older write forms, optional lookups and cross-module links now follow staff access profiles; GitHub Actions runs the repeatable admin checks on pull requests and main pushes.
