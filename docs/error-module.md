# Error codes and diagnostics

Sapiovian uses one registry in `packages/contracts/src/errors.ts` and one shared error UI in `apps/frontend/src/app/shared/error-center` for the website, desktop renderer and admin portal.

## Public numbered codes

The numbered code identifies a failure type. The semantic `reason` identifies that type in source code and developer diagnostics. The `requestId` (shown as **Reference**) identifies one occurrence. HTTP `statusCode` keeps its usual protocol meaning. Never renumber or reuse a published SAP identifier.

| Public code | Developer reason |
| --- | --- |
| `SAP1001` | `VALIDATION_FAILED` |
| `SAP1002` | `INVALID_REQUEST` |
| `SAP1003` | `REQUEST_TOO_LARGE` |
| `SAP1004` | `UNSUPPORTED_FILE_TYPE` |
| `SAP1005` | `CONFLICT` |
| `SAP2001` | `INVALID_CREDENTIALS` |
| `SAP2002` | `AUTHENTICATION_REQUIRED` |
| `SAP2003` | `ACCESS_DENIED` |
| `SAP2004` | `RESOURCE_NOT_FOUND` |
| `SAP3001` | `NETWORK_ERROR` |
| `SAP3002` | `REQUEST_TIMEOUT` |
| `SAP3003` | `SERVICE_UNAVAILABLE` |
| `SAP3004` | `RATE_LIMITED` |
| `SAP4001` | `INTERNAL_ERROR` |
| `SAP4002` | `INVALID_RESPONSE` |
| `SAP4003` | `CLIENT_ERROR` |
| `SAP5001` | `DEVICE_PERMISSION_DENIED` |
| `SAP5002` | `DEVICE_NOT_FOUND` |
| `SAP5003` | `DEVICE_BUSY` |
| `SAP5004` | `CLASSROOM_ERROR` |

The registry is authoritative. A compile-time check requires an authored public guide for every reason. Contract tests protect the published mapping and uniqueness.

## API response

The global Nest exception filter returns the same numbered `code` that appears in the error notice, copied diagnostics, incident API and public guide. For example, an invalid sign-in returns HTTP 401 with:

```json
{
  "success": false,
  "code": "SAP2001",
  "reason": "INVALID_CREDENTIALS",
  "title": "Check your sign-in details",
  "message": "The email or password is incorrect.",
  "nextStep": "Check your email and password, or reset your password.",
  "errors": [],
  "statusCode": 401,
  "path": "/api/v1/auth/login",
  "timestamp": "2026-10-29T10:00:00.000Z",
  "requestId": "example-reference-123"
}
```

`x-error-code` repeats the numbered code; `x-request-id` repeats the occurrence reference. Both response headers are exposed through CORS. Download requests whose error body is a Blob can still read the exact code from the header. Successful responses retain their existing contracts. Media range responses, OAuth return pages and operational endpoints with their own non-JSON protocols are outside this JSON exception envelope.

For an explicit business classification, declare the semantic name in a Nest exception:

```ts
throw new BadRequestException({
  code: 'UNSUPPORTED_FILE_TYPE',
  message: 'Choose a supported file type.',
});
```

The filter normalizes this to `code: SAP1004`, `reason: UNSUPPORTED_FILE_TYPE`. It also accepts a registered numbered declaration. Otherwise, it maps the HTTP status to a registered fallback. Unknown values cannot create undocumented codes. HTTP 5xx responses always use the safe catalog message, including when an explicit code was declared. Validation constraints are flattened into `{field, message}` entries without class-validator target/value objects. Body-parser failures retain HTTP 400/413.

Request IDs accept only 8–128 letters, numbers, underscores and hyphens. Invalid IDs are replaced. Response paths exclude queries and fragments. Error responses use `Cache-Control: no-store`.

## Classroom acknowledgments

Socket acknowledgments carry the same numbered classification in `error.publicCode`, its semantic `error.reason` and a per-failure `error.requestId`. The existing signaling `error.code` discriminator (for example `ROOM_REDIRECT` or `ForbiddenException`) and typed recovery `details` remain intact for existing redirect and permission logic. This protocol discriminator is separate from the public Sapiovian code.

The shared socket client carries the numbered code and server reference into recent errors, diagnostics and submitted reports. It accepts numbered codes, older semantic public codes and older servers without public metadata; unclassified failures use `SAP5004`. Missing acknowledgments use `SAP3002` and never cause automatic mutation retries. Expected room redirects do not create a user incident.

Unexpected signaling failures log safe code/reason/reference/frame metadata; acknowledgments do not echo internal exception text. Socket failures are not automatically written to MongoDB; authenticated user reports remain available.

## User experience

A failed action has a plain-language title, explanation, next step, visible numbered code and separate reference. **View details** includes the developer reason, field messages and copyable diagnostics. Notices stay until dismissed; **Recent error** reopens the latest entry and displays its code. Only ten entries are held in memory, no error history is written to browser storage, and account changes clear the history.

The module never automatically repeats requests or reloads the page. Network/timeout guidance asks users to check whether a change saved before resubmitting. Existing classroom/media recovery remains in charge of its own actions.

`QUIET_ERROR` records background failures without interrupting the user. Calendar polling, class notices, device setup and classroom acknowledgments use this pattern. Auth refresh/me/logout outcomes remain owned by authentication. `EXPECTED_ERROR_STATUSES` excludes explicitly handled normal fallbacks, such as missing optional CMS content; requested pages still surface real failures.

Signed-in users can **Report issue**. Unexpected page/runtime errors also send a bounded technical report while signed in. Guests can copy details. Reporting failures do not recurse through the interceptor, are shown honestly and are not automatically retried. Offline state never claims that a change saved.

## Public Error Encyclopedia

The code reference is public on the **admin portal domain**, independently of the private incident log:

- `/error-encyclopedia`: search by SAP code, semantic reason, message or problem; filter by area.
- `/error-encyclopedia/SAP3001`: a numbered code explanation, with causes, user fixes, developer checks, examples and related codes.
- `/error-encyclopedia/NETWORK_ERROR`: a supported legacy alias for the same guide; generated share links use `SAP3001`.
- `/errors`: the private admin incident log.

All 20 guides are authored in `apps/admin-portal/src/app/features/error-encyclopedia/error-guides.ts`. They describe failure types and contain no occurrence data. Public pages load without signing in or calling the API, including with a stale stored admin session while the backend is unavailable. Section anchors preserve the current page; back navigation restores reading position.

Notices and details link directly to their guide. Set `adminPortalUrl` in `apps/frontend/public/env.js` to the real HTTPS admin origin. Local web development defaults to port 4300. Production without a configured origin displays the code without inventing a URL.

Desktop builds accept `--admin-url https://admin.example.com` or `SFU_DESKTOP_ADMIN_URL`. The validated origin is bundled with the renderer. Guides open through the existing system-browser bridge and contain no occurrence IDs, tokens or diagnostic query strings. No native app needs to open for headless verification.

## Incident storage and admin workflow

Unexpected HTTP 5xx failures are recorded to MongoDB `error_incidents` on a best-effort basis. Storage never delays the response, and at most 50 writes are pending per node during an outage. Structured logs remain the fallback. An exit before the asynchronous write completes can leave no database record. This does not replace centralized durable production logs.

New records store the numbered `code` and semantic `reason`. Historical records with a semantic `code` are normalized when read through the incident API; they are not rewritten or deleted. Reports from older clients may submit semantic codes. New reports submit both values, and mismatched pairs are rejected. Report upserts remain idempotent for `(source, userId, reference)`.

Only `ADMIN` and `SUPER_ADMIN` may list, read or resolve records. Authenticated client reports derive account identity from the verified session, accept allowlisted metadata and are limited to ten per minute per IP. Expected HTTP 4xx failures enter the incident log only when reported. Client reports are labeled separately from server exceptions.

In **Admin → Error log**, search a full reference or filter by source/status. Open a record to see the numbered code, semantic reason, HTTP status, route, occurrence reference, account ID, safe frames and known developer explanations. Resolve or reopen it; this records who changed the status and when without changing product behavior.

Reports/diagnostics exclude request bodies, passwords, cookies, raw exception messages, full local file paths and URL queries. Frames contain file basenames and coordinates only. Client metadata is untrusted and rendered as text. Account IDs and route paths are operational metadata: restrict admin access and define organizational retention. No records are silently expired or sent to an external reporting vendor.

## Deployment and compatibility

1. Build contracts, backend, website and admin portal; desktop packages compile the shared UI.
2. For a production database with automatic indexing disabled, run `MONGODB_URI=... npm run setup:errors`. Use `-- --allow-remote` only for a reviewed target.
3. Deploy the backend, then the matching website/admin builds and refreshed desktop installers. REST `code` is now numbered; clients that inspect the former semantic field must switch their semantic comparisons to `reason`.
4. Existing semantic documentation URLs and historical incident records remain readable. The current shared client accepts older semantic API responses during rollout. New client reports require the updated backend; do not roll out new clients first.
5. Configure the actual admin origin and retain structured server logs centrally, searchable by request ID.

No new paid services or credentials are required. Current installers use localhost and remain unsigned development packages. A live application still needs a configured hosting environment and public domain.

The module covers JSON REST exceptions, uncaught Angular/browser errors, router errors, device setup and classroom acknowledgments. It does not capture native Electron main-process crashes, OS failures, service-worker startup failures or every locally handled media/reconnect warning. Reports cannot be sent while disconnected or before sign-in.

## Verification

The focused suite checks published-code stability, HTTP and signaling mappings, safe messages, request references, old API compatibility, Blob headers, report normalization/mismatch rejection and historical-record reads. Real-backend acceptance uses isolated MongoDB/Redis and the existing Nest/Angular applications, with a temporary validator on the isolated sessions collection to induce an actual database failure. No HTTP response mocks or production failure endpoints are used. This test requires local MongoDB database `whiteboard_acceptance` and a dedicated local Redis URL ending in `/15`; before each browser project it clears only `sfu:throttle:*` counters in that isolated Redis database.

Public-reference acceptance runs the built admin portal with a genuinely unavailable upstream. It checks all numbered pages and semantic aliases, public access with zero API calls, notice links, protected incident logs, search, anchors, copy-link fallback, dark mode and 390px layouts across headless Chromium, Firefox and WebKit. Actual screenshots are saved with the test artifacts. Installer checksums, DMG/ZIP integrity and cross-architecture renderer comparisons are recorded in `apps/desktop/installers/manifest.json`.


Validated on 29 October 2026: 69 backend checks, 24 shared error/socket client checks, 26 desktop runtime checks, both real-backend browser flows (Chromium/WebKit) and all 6 public-reference browser checks (Chromium/Firefox/WebKit) passed. Backend, website, admin and desktop-renderer builds succeeded. Native apps and visible browsers remained closed.
