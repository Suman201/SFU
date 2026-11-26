# P0 release readiness

Updated: 26 November 2026. Repository checks and environment acceptance are separate gates. A green local or CI run does not approve a production launch.

| P0 area | Repository work | Evidence still required from the deployment |
| --- | --- | --- |
| Classroom | Headless paid learner/teacher journey against the real backend, MongoDB, Redis and SFU; camera frames, shared whiteboard video, offline reconnect, actual audio/video recording, authorized playback and private post-class Q&A. | Approved staging ingress and accounts; public TURN/media ports, real device/browser coverage, ingress reconnect/drain and measured classroom capacity on the target hardware. |
| Payments and email | Existing signed Stripe webhook/refund and authorization regressions remain in the gate. Added repeatable production ledger index provisioning and real invoice/PDF/local SMTP retry acceptance. The classroom journey pays through the synthetic test gateway. | Stripe test merchant credentials and deployed endpoint signing secrets; hosted Checkout/webhook/refund proof; authorized external QA email; approved issuer, tax and published legal policies. Production activation remains separate. |
| Recovery and monitoring | Production backup/restore scripts exercised with age encryption, a fresh isolated database, documents/indexes/empty collections and six artifact directories. Wrong-key and corrupt-checksum restores must fail before writes. Production Prometheus rules are checked for firing/resolution, followed by actual Alertmanager firing/resolved delivery to an isolated receiver. | Restore from a target-environment backup with separately retained keys, real RPO/RTO, approved retention, actual configured receiver delivery and measured deployment capacity. |
| Product CI | `.github/workflows/admin.yml` builds shared packages and all portals, runs every backend/frontend/admin unit test, real admin/payment integration and headless admin plus classroom/calendar/invoice acceptance. Artifacts and service logs are retained on failures. | A green hosted run for the release commit, branch/release policy and deployment-specific acceptance above. |

## Repeatable local checks

Use Node 22.22.3, Docker, FFmpeg/FFprobe and the locked dependencies. These commands create only synthetic local fixtures. The P0 service helper owns MongoDB on `127.0.0.1:27028` and Redis on `127.0.0.1:6394`; it refuses to replace an existing named container. Browser tests use only the `whiteboard_acceptance` database and Redis database 15.

```sh
npm ci
npx playwright install --with-deps chromium webkit
npm run build:admin-ci
npm run build:p0:classroom
export CHROME_BIN="$(node -p "require('playwright').chromium.executablePath()")"
npm run test:admin:unit
npm run test:p0:frontend
npm run test:p0:backend
npm run test:p0:operations
node scripts/admin-ci-services.cjs up
npm run test:admin:integration
npm run test:admin:browser
node scripts/admin-ci-services.cjs down
node scripts/p0-ci-services.cjs up
npm run test:p0:setup
npm run test:p0:browser
node scripts/p0-ci-services.cjs down
```

Always run both service helpers' `down` commands after failures. Run browser suites sequentially. The synthetic classroom runner explicitly disables real Stripe credentials and uses a local SMTP sink when email is tested.

Reports are ignored working artifacts under `reports/p0/` and `test-results/p0/`: `learning-journey.json`, actual classroom/Q&A screenshots, a playable recording, `operations.json`, JUnit/HTML reports and failure traces. CI also uploads the existing admin evidence for seven days.

Local verification on 26 November: all 66 backend suites (770 tests), all 231 frontend tests, payment index provisioning and the encrypted restore/monitoring drill passed. All three browser journeys passed together (2.8 minutes): paid classroom, calendar/enrollment/timezones/reminders, and invoice/PDF/local SMTP failure/retry with two backend processes. The classroom evidence includes received whiteboard ink, an actual 7.1-second recording with audio and video, authorized playback, reconnect and private Q&A.

## Deployment configuration inventory

```sh
npm run verify:p0:launch -- --env-file /approved/path/staging.env
```

This inventories the supplied file and selected secret-file references without printing secret values, sending mail, taking payments or connecting to staging. Exit 2 means required configuration is missing; exit 0 means the inventory is configured, not that production is ready. `productionReady` remains false because environment proof cannot be inferred from configuration.

Supply `STAGING_BASE_URL`, `NODE_A_URL`, operator and QA account access through the approved secret store; Stripe **test** credentials and the signing secret for each deployed endpoint; SMTP plus `P0_QA_EMAIL`; approved issuer/tax/legal content referenced by `P0_BUSINESS_APPROVAL_REF`, `BOOKING_TAX_RATE_BPS` and `BOOKING_TAX_NOTE`; backup encryption recipient and separately retained identity; and the approved alert receiver. Do not put credentials in a ticket, report or chat.

The staging preflight now unwraps the API response envelope correctly and labels its scope `server-preflight-only`. It always reports `controlledRolloutReady: false`; missing authenticated TURN proof exits 2. Run the existing staging browser/TURN and load/drain suites with approved environment access, then attach their actual reports. Local results do not measure deployment RPO/RTO or establish a supported class size.

## Payment index deployment step

After the backend is built, run `npm run setup:payments` with the reviewed database's `MONGODB_URI` or `MONGODB_URI_FILE`. A remote database also requires `-- --allow-remote`. The command creates missing ledger/idempotency/payout collections and indexes without deleting or rewriting existing records. Duplicate existing records cause index creation to fail; investigate them instead of removing the uniqueness constraint. Production disables automatic index creation, so this is an explicit deployment prerequisite.
