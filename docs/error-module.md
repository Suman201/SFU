# Error handling and diagnostics

Sapiovian uses one shared error UI in `apps/frontend/src/app/shared/error-center` for the website, desktop renderer and admin portal. The public code catalog is in `packages/contracts/src/errors.ts`.

## Public Error Encyclopedia

The public code reference is hosted by the **admin portal domain**:

- `/error-encyclopedia`: searchable code index, area filters and all currently emitted public codes.
- `/error-encyclopedia/NETWORK_ERROR`: permanent description of one error code (replace with any known code).
- `/errors`: the existing private incident log, still protected by admin authentication.

Each code page explains its meaning, likely causes, user recovery steps, developer debugging checks, an example and related codes. Content is authored in `apps/admin-portal/src/app/features/error-encyclopedia/error-guides.ts` and checked against the shared error catalog at compile time. It describes error types; it does not retrieve individual incidents or reference IDs. Public pages work without signing in or contacting the API, including when a stored admin session exists and the backend is unavailable.

The existing runtime error module remains useful for occurrence-specific diagnostics. Error detail dialogs link to the matching public code page. Set `adminPortalUrl` in the website's `public/env.js` to the HTTPS **admin origin**, for example `https://admin.example.com` (replace with the real domain). Local web development defaults to the admin portal at port 4300. Production websites without a configured admin origin keep the code visible without inventing a public URL.

For desktop packages pass `--admin-url https://admin.example.com` or set `SFU_DESKTOP_ADMIN_URL`. The validated origin is embedded into the renderer's runtime configuration. Documentation opens in the system browser through the existing secure external-link bridge, preserving the classroom. Production packages without an admin URL omit the link. No occurrence references, tokens or diagnostic query strings are included in documentation links.

## User experience

A failed API action has a plain-language title, an explanation, a next step and a reference ID. **View details** shows field validation messages and selectable/copyable diagnostics. Notices remain until dismissed; **Recent error** reopens the latest one. Only the last ten entries are held in memory. Nothing is written to browser storage. Changing accounts clears this history.

Network failures cannot prove whether a mutation reached the server. Recovery text asks the user to check whether the change saved before resubmitting. This module never automatically repeats requests or reloads a page. Existing feature-specific recovery logic remains in place.

Session refresh/me/logout calls do not generate separate global notices; authentication owns these outcomes. The interceptor wraps authentication so only a final failed protected operation is surfaced. `QUIET_ERROR` records background failures without interrupting a user. Calendar polling, class notices, device setup and classroom acknowledgements use this pattern; existing contextual inline messages are retained.

`EXPECTED_ERROR_STATUSES` lets a feature keep an explicitly handled fallback out of the error UI. The homepage and teacher directory use this only for missing optional CMS content; a missing requested public page still surfaces an error.

Signed-in users can **Report issue**. Unexpected page/runtime errors also send a bounded technical report while signed in. Guests can copy details. Reporting failure is shown honestly, is not retried automatically, and cannot recurse into the error interceptor. Offline state is announced without clearing errors or claiming a save succeeded.

## Server contract

The existing `success`, `message`, `errors`, `statusCode`, `path`, `timestamp` and `requestId` fields remain. New `code`, `title` and `nextStep` fields are additive. `errors` contains flattened `{field, message}` constraints; raw class-validator targets and input values are excluded. HTTP 5xx messages and error arrays never expose the original exception. Body-parser JSON/size failures retain appropriate 400/413 statuses.

Request IDs contain only 8–128 letters, numbers, underscores or hyphens; invalid IDs are replaced. The same ID is returned in the body and `x-request-id`, exposed through CORS. API request logs exclude query strings and request bodies. Structured `application_error` logs include code, request ID, method, route, exception name and file/line frames.

Unexpected HTTP 5xx failures are recorded to MongoDB `error_incidents` on a best-effort basis. Recording never delays the response. At most 50 writes are pending per node during a database outage; logs remain the fallback. If the process exits before the asynchronous write completes, the DB record may be absent. This is an incident viewer, not a replacement for durable centralized production logs. Expected 4xx failures are not automatically persisted; the user can report them when needed.

## Admin and developer workflow

Open **Admin → Error log** (`/errors`). Filter by source/status or paste the full reference. Open a record to inspect its code, HTTP status, request reference, account ID (when authenticated), safe developer frames, known failure explanations (such as database validation or an unreachable dependency) and recovery guidance. Mark it resolved or reopen it. A resolution records who changed it and when; this does not itself change the product behavior.

Only `ADMIN` and `SUPER_ADMIN` can list/read/update records. There is no public read endpoint. Authenticated client reports accept an allowlist of fields, derive the account ID from the verified session and are limited to ten reports per minute per IP. Reports are idempotent for `(source, userId, reference)` and are visibly labeled as client reports, not verified server exceptions.

No passwords, cookies, request/response bodies, form values, raw exception messages, full local file paths or URL queries are retained in incidents or copied diagnostics. Frame entries contain file basenames and line/column numbers. Production source maps, where needed, should be held privately for developers to map minified bundle coordinates. Client frames and metadata are untrusted and rendered as text. Account IDs and route paths remain operational metadata: restrict admin access and set an explicit organizational log retention policy. This module does not silently delete records or send data to an external error-reporting service.

## Deployment

The user-facing module lives in the existing frontend repository and is served from its configured public website URL. Desktop and admin import that same implementation; the encyclopedia is served publicly by the admin portal, and the incident log stays private. The current installers target localhost. A live URL needs the frontend/backend hosting environment and public domain to be configured before rebuilding deployment installers.

1. Build contracts, backend, frontend and admin portal as usual. Desktop packages compile the same shared UI.
2. Before starting a production backend with automatic indexing disabled, run `MONGODB_URI=... npm run setup:errors`. Use `-- --allow-remote` only for the reviewed remote database.
3. Deploy backend and both UIs together. No new credentials or paid service are required. Existing MongoDB/auth/logging infrastructure is reused.
4. Retain structured server logs centrally. Search `requestId` from a user reference to correlate the failure.

The module covers REST failures, uncaught Angular/browser errors, router navigation errors, device-setup failures and classroom acknowledgement failures. It does not capture native Electron main-process crashes, OS failures, service-worker startup failures, or every locally handled media/reconnect warning. Those require their own subsystem diagnostics. It cannot send reports while disconnected or before sign-in.

## Validation

Focused backend/Angular tests cover safe error envelopes, nested validation, body-parser errors, request-ID validation, blob errors, preserving typed HTTP errors, quiet polling, mutation retry prevention and report recursion prevention. The real-backend browser acceptance test uses isolated MongoDB, Redis and the existing Nest/Angular apps. It deliberately applies a temporary validator to the isolated session collection to induce a real database failure, then removes it. No HTTP response mocks or production failure endpoints are used. It also verifies offline handling, client reports, admin access control and resolution. Screenshots are captured headlessly.

Validated locally on 29 October 2026:

- 12 backend focused tests and 3 existing foundation integration checks passed.
- 22 frontend focused checks and the admin root integration check passed; the 9 error-module checks were rerun after the final grouping/dialog changes.
- Full real-backend acceptance passed in Chromium and WebKit with teacher, student, admin and shared desktop-renderer routes. Both narrow layouts were checked at 390px.
- Focused backend lint passed without warnings. The production index setup script ran successfully against the isolated MongoDB database.
- No native app or visible browser was opened.

Website, desktop renderer and admin release builds passed. Windows x64/ARM64 (combined and separate NSIS installers) and Mac Intel/Apple Silicon (DMG and ZIP) packages were rebuilt. All 14 installer/blockmap checksums passed, both DMG integrity checks passed, both ZIP CRC checks passed, and all four unpacked architectures contain the same 59 frontend files. These remain unsigned localhost development installers, not a public deployment.

## Error Encyclopedia verification

On 29 October 2026, all 20 public code pages, search/filter behavior, deep-link reloads, copy-link fallback, unknown-code handling, light/dark and 390px layouts passed in headless Chromium, Firefox and WebKit (6 acceptance checks). Public-page tests used the actual admin release build with an unavailable upstream and a stale stored admin session, and confirmed zero API requests. A real reverse-proxy connection failure produced an error whose code explanation opened on the same admin origin. The private incident log still required sign-in. No response mocks were used.

The updated shared error module passed 13 unit checks, including safe documentation URLs and desktop browser-bridge success/failure. The existing 25 desktop runtime checks passed; the added admin-origin option check and command regressions also passed. Website, admin and desktop-renderer builds succeeded. The native app and visible browsers stayed closed.

The refreshed Windows/Mac installers and blockmaps passed all 14 SHA-256 checks. Both Mac DMG integrity checks and ZIP CRC checks passed; every packaged architecture contains the same 59 frontend files, including the configured local admin-portal documentation origin. These remain unsigned development installers.

Section anchors retain the current code URL, and related-code navigation starts at the new explanation. Browser back navigation restores the reader’s position. These navigation behaviors are covered by the encyclopedia browser acceptance checks.
