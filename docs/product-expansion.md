# English product expansion

This release adds teacher support, a CMS image library and paid teacher promotions. New screens are English-only. Existing classroom language settings remain unchanged.

## Teacher support

Teachers use `/teacher/support` to open platform tickets and follow replies. The class requests view contains only student tickets linked to a batch currently owned by that teacher. Ownership is checked again when a conversation is opened or answered, including after batch transfers. Teachers cannot see another teacher's platform ticket. Student email, browser diagnostics, assignments and staff-only notes are removed from class-teacher responses. Students can reply to their own open conversations after a lesson. Closed conversations reject new replies.

Replies compare the conversation's saved update time and append atomically. A concurrent update returns 409 and preserves the local draft; reload before retrying. Staff updates use a compare-and-set operation to avoid overwriting concurrent student or teacher replies. Platform ticket status remains staff-owned. Class teachers can mark relevant student requests in review, waiting for a student or resolved.

## CMS media

The CMS page section and item editors open the media picker. Content writers upload PNG, JPEG or WebP files up to 5 MB, edit alternative text, search, archive and restore images. Dimensions are bounded to 8000 pixels per side and 32 megapixels. MIME is derived from content rather than the supplied file extension. SVG and HTML are rejected. Optional malware scanning uses the existing upload scanner.

Files live under `PROFILE_MEDIA_LOCAL_PATH/cms-library`; persist this directory across deployments and include it in media backups. Immutable content is deduplicated with SHA-256; metadata uses revision checks. Archive hides an image from the default picker without deleting it from existing publications. Archived duplicates must be restored before reuse. Empty alternative text is supported for decorative images.

Protected preview endpoints require content access. The public image endpoint serves bytes only while the image is referenced by a currently published public/all page snapshot. Saving a draft never makes a new image public. Unpublishing removes public access. Responses disable caching so unpublished media is not served by this application after withdrawal; previously downloaded copies cannot be recalled.

## Paid promotions

Teachers use `/teacher/promotions`; administrators use `/promotion-commerce`. Legacy manually paid campaigns remain in the existing promotions queue. Content readers can view plans and campaign analytics. Finance readers can view orders and invoices. Finance writers can reconcile orders and request full refunds. Only super administrators configure prices, currencies, tax and automatic approval. A configured plan defaults to disabled and manual campaign approval. Enabling automatic approval is an explicit plan setting, captured in the immutable order snapshot and plan audit event.

Orders validate the current approved public teacher profile, saved plan revision and quoted price. Campaign dates use absolute timestamps. One open Checkout order per teacher/placement is allowed; a unique placement claim has no TTL and is released only after provider-confirmed expiry, refund or normal campaign completion. Legacy overlap is checked before purchase and again at fulfillment. Late payments, ineligible teachers and conflicting campaigns go to financial review instead of activation. The plan and schedule of a paid Checkout campaign cannot be rewritten by legacy admin actions.

Stripe hosted Checkout owns card collection and billing details. The server supplies the amount in original currency minor units; JPY is zero-decimal. Plans optionally enable Stripe automatic tax with a product tax code. Configure the merchant's tax registrations and obligations before enabling sales. The implementation does not invent a tax rate. Checkout generates the Stripe invoice. Owned invoices and confirmed refund credit notes are available from each promotion order through validated Stripe-hosted document links.

A redirect never proves payment. A signed raw-body webhook schedules reconciliation; reconciliation re-fetches the session, successful payment intent and provider refunds. Currency, amount, tax, identity and environment must match the saved order. Capture, campaign creation and platform-only ledger posting commit in one MongoDB transaction. Promotion fees never feed teacher earnings or payouts. Stripe processing fees are recorded in their actual settlement currency. Cross-currency settlement conversion and disputes still require finance reconciliation against Stripe statements; disputed campaigns pause and enter review.

Only full refunds are offered in this release. A persistent request pauses the campaign before contacting Stripe. Stable idempotency keys, leases and provider state recovery prevent repeated charges/refunds. Confirmed refunds reverse the original net revenue and tax exactly once, cancel the campaign, and create the provider credit note. Credit-note issuance is retried independently of the confirmed financial reversal. External partial/pending refunds and ambiguous attempts older than 23 hours enter review; inspect Stripe before any manual repair. Do not delete placement claims or change saved payment facts to clear a queue.

The general account billing centre combines lesson, class and promotion purchases, per-currency totals, refunds and owned invoice/credit-note access. Promotion documents use fresh Stripe-hosted links. The promotion workspace remains available for campaign management, while authorized finance staff continue to process refunds through the existing workflow. See [customer billing](customer-billing.md).

## Analytics

Sponsored labels identify paid placements. Public listings/profile badges issue purpose-specific HMAC tokens for actual paid, approved, active campaigns. Tokens expire after 15 minutes. An impression requires at least 50% visibility for one second; profile and booking clicks are explicitly tagged. The collector checks the current campaign/teacher again, rate-limits requests and deduplicates each token/event pair. A click includes its corresponding impression. Daily aggregates and date-range totals are owner-scoped for teachers and content-permission scoped for admins. No IP addresses, user agents or private chat content are stored by analytics. Event deduplication records expire after one day.

These are approximate event counts, not unique people, guaranteed bookings or billable delivery measurements. Refreshing a listing can issue a new token. Campaign date ranges are limited to 366 days per report. Lesson-payment conversion attribution is not claimed.

## Provisioning and activation

1. Build contracts and backend. Back up MongoDB and persisted media. Use a replica set or mongos.
2. Review the target database; run `npm run setup:cms` and `npm run setup:promotions` with `MONGODB_URI`/`MONGODB_URI_FILE`. For an explicitly reviewed remote target append `-- --allow-remote`. Both scripts are repeatable and preserve existing documents.
3. Keep `PROMOTIONS_ENABLED=false` until the following steps are complete. Set `STRIPE_SECRET_KEY` (or its secret file), the exact `FRONTEND_URL` origin and `PROMOTION_CHARGE_CURRENCIES`. Production requires HTTPS and a live key. No key is committed.
4. Register `/api/v1/promotion-commerce/stripe/webhook` with a dedicated `PROMOTIONS_STRIPE_WEBHOOK_SECRET` or `_FILE`. Subscribe to Checkout completion/expiry, refund changes and charge dispute changes. Keep the existing lesson/class payment webhook endpoints unchanged. All backend nodes must share the same JWT access secret for analytics tokens.
5. Configure merchant invoice/tax details in Stripe and create a disabled plan in the admin workspace. Test in Stripe test mode in a non-production environment, including expiry, invoice, full refund, credit note and worker restart. Enable the reviewed plan and `PROMOTIONS_ENABLED=true` only after merchant acceptance.
6. The background reconciler polls at `PROMOTION_WORKER_POLL_MS` (1000–60000 ms, default 60000). Keep existing reconciliation and document credentials configured if new purchases are later disabled.

Official integration references: [Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment), [signed webhooks](https://docs.stripe.com/webhooks), [credit notes](https://docs.stripe.com/api/credit_notes/create), and [currency minor units](https://docs.stripe.com/currencies).

## Verification and rollback

`npm run test:admin:integration` includes real MongoDB/Redis expansion acceptance with a synthetic Stripe adapter. `npm run test:expansion:browser` exercises the English teacher/admin screens headlessly in Chromium, Firefox and WebKit, produces actual screenshots under `reports/expansion`, and checks accessibility and narrow-screen overflow. Gateway unit tests verify Stripe request construction, raw signatures and hosted-link restrictions. These local tests do not prove live merchant configuration or move real funds.

Disable new promotion purchases first if rolling back. Keep workers/webhooks that understand existing orders running until paid/pending/refund attempts are reconciled. Retain the additive collections, unique indexes, published snapshots, media files and platform ledger entries. Never restore a build that can treat Checkout campaigns as manually paid or replay provider operations with new idempotency keys. Use paused campaigns for content moderation; use the finance workspace for refund/cancel actions.
