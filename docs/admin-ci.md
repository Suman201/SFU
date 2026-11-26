# Admin permissions and CI

Older admin screens now use the same module permissions as navigation and the backend. Read-only staff can filter lists, inspect details, preview CMS content and download authorized documents. Mutation buttons and creation links are hidden; edit forms use native disabled fieldsets while retaining existing field values and control-specific disabled states. Write handlers also check the current permission before submission. Staff with user-management permission cannot edit administrator or super-admin accounts unless they are super admins, and self-deactivation controls are not offered.

Cross-module context links require access to their destination. Dashboard totals remain readable when a destination is unavailable. Optional filter lookups do not request the user directory or teaching catalogue without the corresponding view permission. Lookup caches are cleared when the account or permissions change, and late responses from an earlier account are ignored. These UI checks supplement the existing server authorization.

## Workflow

`.github/workflows/admin.yml` runs on pull requests, pushes to main and manual dispatch. It uses read-only repository permissions, disables persisted checkout credentials, pins GitHub Actions to immutable commits, and cancels superseded runs. The job uses Ubuntu 24.04, the project's Node 22.22.3 version and `npm ci`.

The workflow installs Chromium/Firefox/WebKit and their Linux dependencies, builds contracts and backend dependencies plus the student/teacher and admin portals, runs all admin, frontend and backend unit tests, then runs real-HTTP admin/payment scenarios and the dedicated browser suite. It also installs FFmpeg and runs the P0 paid classroom, calendar, invoice/PDF/local-email, payment index, encrypted recovery and monitoring acceptance gate described in [P0 release readiness](p0-release-readiness.md). Admin services are isolated MongoDB 7 (`booking-tests` replica set on localhost:27124) and Redis 7 (localhost:6395). Only synthetic fixture accounts and payment-provider adapters are used; no production database, Stripe or SMTP secrets are required.

Reports, actual screenshots, JUnit results and retained failure traces are uploaded as `admin-ci-evidence` for seven days, including when checks fail. Test service diagnostics are collected before cleanup. Production configuration and live merchant/email delivery checks remain separate from this workflow. The workflow does not modify branch-protection settings.

## Run the same checks locally

```sh
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run build:admin-ci
npm run contracts:check
npm run test:p1:workers
npm run test:p1:uploads
export CHROME_BIN="$(node -p "require('playwright').chromium.executablePath()")"
npm run test:admin:unit
npm run test:p0:frontend
npm run test:p0:backend
node scripts/admin-ci-services.cjs up
npm run test:admin:integration
npm run test:admin:browser
node scripts/admin-ci-services.cjs down
npm run build:p0:classroom
npm run test:p0:operations
node scripts/p0-ci-services.cjs up
npm run test:p0:setup
npm run test:p0:browser
npm run test:p1:browser
node scripts/p0-ci-services.cjs down
```

On macOS, use the installed headless Chromium executable for `CHROME_BIN` if a full Chromium build is unavailable. The service helper refuses to replace existing named containers and only removes containers with its own test-suite label. Ensure no other process uses the isolated ports before starting it. Always run `down` after local checks, including failures.

`playwright.admin.config.ts` runs `admin-portal-runtime-smoke.spec.ts`, `admin-completion.spec.ts` , `admin-permissions.spec.ts` and `payment-merge.spec.ts` headlessly in Chromium and WebKit with one worker and no automatic test retries. Browser artifacts go to ignored `reports/admin-ci` and `test-results/admin` directories. `ADMIN_PERMISSION_UI_OUTPUT` and `ADMIN_COMPLETION_OUTPUT` can select absolute screenshot destinations.

The permission acceptance tests cover read-only forms and lifecycle controls, creation deep links, partial module access, forbidden lookup suppression, protected administrator accounts, successful staff edits to user/course/CMS records, and responsive light/dark presentation. Unit tests cover lookup permission changes and late responses across account switches. A regression also verifies that CMS updates with no canonical URL omit that optional value instead of sending an invalid empty URL.

References: [GitHub checkout](https://github.com/actions/checkout), [Node setup](https://github.com/actions/setup-node), [artifact upload](https://github.com/actions/upload-artifact), [Playwright CI](https://playwright.dev/docs/ci).

Validated locally on 25 November 2026: the complete build chain, 78 focused unit tests, 23 real-backend integration scenarios, and all 12 Chromium/WebKit browser checks passed. Actual screenshots include read-only user and invoice settings views, authorized user editing, and a successful CMS update on a 390px dark-mode layout.

The payment-branch merge extends the gate with payment ledger/Stripe tests, enrollment and configuration regressions, real settlement/refund/payout and cross-checkout capacity scenarios, and real student/teacher/Finance browser screens. `PAYMENT_MERGE_OUTPUT` selects the new payment screen captures. The earlier validation counts above describe the pre-merge baseline.

P0 classroom services use their own labelled MongoDB replica set on localhost:27028 and Redis on localhost:6394 (database 15). Headless Chromium verifies the actual local SFU and recording; production network paths and live providers remain separate. P0 reports and failure traces are included in `admin-ci-evidence`.

P1 extends the same gate with public declaration drift detection, real worker lifecycle regressions, an isolated ClamAV engine drill, three-browser completed-class private Q&A, two-node targeted event isolation, bounded worker crash/recovery churn, and required native UDP video in both directions. P1 reports and traces are included in the same artifact. Local proof boundaries and activation instructions are in [P1 release readiness](p1-release-readiness.md).
