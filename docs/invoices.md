# Admin invoices

Open **Admin → Invoices**. The module uses the existing backend, MongoDB, admin authentication, audit logs and SMTP transport. The supplied business/customer defaults are fictional development information and can be replaced in Invoice settings and the draft editor.

## Workflow

1. Set legal business name, full address, country code, billing email, tax/registration numbers, default currency and payment instructions in **Invoice settings**.
2. Create an invoice with customer details, invoice/due/supply dates, service descriptions, quantities, prices excluding tax, tax rates and any tax explanation.
3. Save a draft. Drafts can be edited and downloaded, but cannot be emailed as issued invoices.
4. Issue the invoice. The backend assigns `INV-YYYY-NNNNNN`, snapshots the seller details and generates the PDF. Issued billing details, amounts and the original PDF are fixed.
5. Download or send the invoice PDF to the saved customer email. Delivery state is recorded; failed manual sends can be retried. An SMTP-disabled result is never displayed as sent.
6. Record a full payment received outside the portal using its date and reference. The payment update atomically queues the invoice email. The worker sends the invoice automatically and retries failures. This operation does not collect money or grant class enrollment.

Unpaid invoices can be voided with a reason. Their number is retained and subsequent PDF downloads are marked VOID. Paid invoices cannot be voided; credit notes, partial payments and refunds are outside this module. The payment gateway and real booking backend remain separate work. A future verified gateway event must create/issue the corresponding invoice idempotently and invoke the payment workflow; the current static checkout never does so.

## Amounts and tax

Supported currencies use two decimal places. Unit amounts are stored as integer minor units, quantities as thousandths and tax rates as basis points. The backend recalculates totals and rounds half-up per line. The document includes a tax breakdown by rate. Up to 50 line items are supported and long PDFs paginate with repeated table headings.

Tax is entered by the administrator. A seller tax/VAT number is required before a non-zero tax amount can be issued, and zero-tax items require an explanation. No tax rate, exemption, reverse-charge eligibility or VAT number validity is determined automatically. The invoice fields follow the common information described in the [European Commission invoicing guidance](https://taxation-customs.ec.europa.eu/taxation/vat/vat-businesses/invoicing_en); market-specific tax treatment and structured electronic-invoice requirements still need the appropriate accounting configuration. A PDF is not a country-specific electronic-invoicing integration.

## Setup and delivery

Run `npm run setup:invoices` with the intended `MONGODB_URI` or `MONGODB_URI_FILE`. This creates the invoice indexes without deleting records; it is needed before deployment when Mongoose automatic index creation is disabled. A remote database requires the explicit `--allow-remote` flag. The number counter uses atomic database increments across API processes. Interrupted or competing issue attempts can consume a number; numbers are never reused.

Configure SMTP using [the existing email setup](notifications-email-push-setup.md). Emails use the configured sender and the saved business billing email as Reply-To. Customer billing documents are attached as PDF rather than exposed by a public URL.

The automatic payment email queue is durable in MongoDB. With SMTP enabled, workers claim due work using database leases and make up to six attempts with exponential backoff starting at 30 seconds. `INVOICE_EMAIL_POLL_MS` defaults to 30000. With SMTP disabled, automatic mail remains queued. After exhausted retries, the admin can correct email configuration and use Send email. The detail screen refreshes queued delivery status automatically. Payment remains recorded when email delivery fails.

Email sends are idempotent for the supplied request UUID and use a two-minute lease shared across processes. Retries after a crash immediately following SMTP acceptance may deliver a duplicate; this is at-least-once delivery, not an exactly-once guarantee. Issued PDFs, invoice settings, counters and pending deliveries are included in normal MongoDB backups. No new public asset directory or separate invoice-file backup is needed. Docker includes the approved brand artwork, Unicode fonts and their redistributable font license.

## Validation

Validated locally on 28 October 2026: shared-contract, backend and admin builds passed; 16 focused unit tests passed; real-backend acceptance passed in Chromium and WebKit. A final Chromium run also verified automatic delivery status updates and the dark-mode list.

The real-backend browser acceptance is `tests/browser/invoices-acceptance.spec.ts`. It starts two Nest processes, isolated MongoDB/Redis and a local SMTP server, and uses the built admin UI. It checks role restrictions, draft/issue transitions, server-calculated totals, immutable seller/PDF snapshots, original PDF bytes in the email attachment, manual email failure/retry, invoice numbering across processes, void restrictions, a 40-item PDF, payment recording and automatic email failure/retry. All people and business information used in the acceptance run are synthetic; no external customer receives test mail.

Unit coverage includes fractional quantities, tax-rate grouping, exact repeated small amounts and rejection of invalid prices. PDF QA renders the generated documents and verifies accents, Greek/Cyrillic text, the first/last items, totals and pagination. Browser screenshots cover settings, creating, issuing, delivery, list and mobile layouts. Production environment and external SMTP delivery are not claimed by the local acceptance.
