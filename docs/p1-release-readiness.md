# P1 release readiness

Updated 26 November 2026. This pass hardens the existing student/teacher product and adds reproducible local evidence for the eight repository P1 readiness areas. Local acceptance is distinct from deployment signoff. The production rollout gates in [P0 readiness](p0-release-readiness.md) still apply.

## Scope and evidence

| P1 area | Repository implementation and local gate | Deployment evidence still required |
| --- | --- | --- |
| Scale and multi-node | Two real worker-mode backends, MongoDB and Redis; private chat/read receipts, whiteboard grants and targeted moderation isolation; reject new rooms during drain while existing chat continues; reconnect retains the private thread; native UDP video in both directions. `npm run test:p1:browser`. | Public ingress/sticky routing, public media and pipe UDP ranges, owner loss/handoff, rollout drain on the deployed topology. Pipe remains experimental and disabled by default. |
| Soak and degradation | Bounded churn with room steps 2/4, three cycles, intentional child-worker termination, replacement readiness, failed-room cleanup, and return to zero room/transport/consumer/participant gauges. Background quality reads cannot allocate phantom rooms or terminate the backend during restart. | Long sessions with sustained browser RTP, expected concurrency on the target server, TURN/Redis/Mongo/recording outages and measured degradation. Local descriptor churn establishes no production class size or capacity. |
| Observability and runbooks | Existing worker/cluster/pipe diagnostics and incident records, actual zero-baseline checks, P0 alert rule and local Alertmanager delivery drill; cleanup counters reflect locally allocated consumers even after remote native cleanup. | Delivery to the configured operator receiver, on-call ownership and thresholds calibrated to the deployment. |
| Data durability and retention | Existing age-encrypted Mongo/artifact restore drill, wrong-key and corrupt-archive rejection, retention/access regressions. `npm run test:p0:operations`. | Restore on the target storage, measured RPO/RTO, S3 versioning when selected, approved retention/deletion policy. No existing content is deleted by this change. |
| Recording/playback | P0 real SFU whiteboard video recording, finalize, authorized playback and student access; backend recording/access/retention regression suite. `npm run test:p0:browser` and `npm run test:p0:backend`. | Production object storage and recording recovery under target network/process failure; physical Safari/mobile capture and playback. |
| Files and materials | Existing authenticated, private/broadcast scoped downloads, MIME allowlists, filename sanitization and size limits; complete batch validation before persistence; optional bounded ClamAV screening for chat, materials and assignment files with rejection/outage tests. `npm run test:p1:uploads` exercises a real engine. | Approved scanner resources, current signature database and enabled scanner configuration; durable storage permissions and backup on the target. The local drill uses a synthetic signature, not the public virus database. |
| Browsers/devices | Completed-class private Q&A runs in Chromium, Firefox and WebKit without reload. Classroom viewport acceptance covers desktop, 390px phone, landscape and tablet, including stage size, separate utility/media controls and a collapsed chat button that remains visible, draggable and clickable. | Physical iOS Safari/Android permissions, virtual keyboard, touch drawing, real-device autoplay and long-session reconnect. Headless WebKit is not a physical Safari-device signoff. |
| Contracts/API | All clients share protocol version 1; trusted API requests and socket authentication advertise it; incompatible versions receive HTTP 426 or a socket update error. A checked-in public declaration baseline fails CI on drift. | Classify declaration changes during review; bump the protocol for incompatible changes and coordinate client rollout. A hash baseline does not automatically decide semantic compatibility. |

## Local validation on 26 November 2026

- Full contracts, media dependencies, worker facade, backend, learning portal and admin production build chain passes; declaration baseline matches.
- Backend: 68 suites, 796 tests pass. Frontend: 235 tests pass. Admin: 12 tests pass. Native worker lifecycle: 13 tests pass.
- P0: all three actual backend/browser journeys pass, including paid classroom media/recording/reconnect, invoice delivery to the local SMTP receiver and calendar behavior.
- P1: all six required browser checks pass without skips: two-node isolation/churn/recovery, native UDP video in both directions, and private Q&A plus historical read-only homework in all three browser engines.
- Real ClamAV engine drill passes clean-file acceptance, synthetic detection rejection and unavailable-engine fail-closed behavior.

Generated reports are local/CI artifacts, not target-environment approval. The focused final real classroom journey also passes after the layout changes: reviewed phone/landscape screenshots show separate utilities, presentation, camera and collapsed chat; real pointer dragging and subsequent open/collapse clicks work.

## Completed-class Q&A

Historically enrolled students can read only their own completed-session thread; teachers select a validated historical student thread. Neither path requires a live room participant. Peer and non-enrolled access remains forbidden. Published homework linked to a completed session is also readable through historical enrollment, with only the student’s own saved work returned. The assignment detail explicitly becomes read-only; it creates no submission, sends no viewed mutation and offers no submit form. Submission and revision endpoints still require active enrollment. Unscoped batch lists remain active-enrollment only.

Read watermarks use MongoDB `$max`, so an old tab cannot move them backwards.

Both screens poll the lightweight private-history endpoint every five seconds while the thread is visible, with one request in flight and a ten-second timeout. Leaving/switching threads cancels history requests; delayed responses and sends cannot overwrite another student's thread or draft. Hidden pages and offscreen threads do not poll. Only visible messages advance read state. Poll failures preserve the existing conversation and show a retry status; recording and artifact pages do not reload to fetch replies.

## Run the gates

Use Node 22.22.3, Docker, FFmpeg/FFprobe and the locked dependencies. Run browser suites sequentially; they own fixed local backend ports and generated build files must not change while the suites run.

```sh
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run build:admin-ci
npm run contracts:check
npm run test:p1:workers
npm run test:p1:uploads
npm run test:p0:backend
# Set CHROME_BIN to the installed headless Chromium executable.
npm run test:p0:frontend
npm run test:admin:unit
npm run build:p0:classroom
node scripts/p0-ci-services.cjs up
npm run test:p0:browser
npm run test:p1:browser
node scripts/p0-ci-services.cjs down
```

The classroom wrapper refuses database destinations outside its owned localhost Mongo replica set (27028, `whiteboard_acceptance`) and Redis (6394, DB 15), disables external payment/email/scanner providers, and uses synthetic accounts. The generic-room soak needs the legacy HOST role; the test adds it only to dedicated synthetic teacher accounts. Production role checks are unchanged. The required native-pipe tests fail if UDP setup fails; required P1 evidence is not silently skipped.

Reports and actual screenshots are generated under ignored `reports/p1/` and `reports/p0/`. The key P1 reports are `multi-node/multi-node.json`, `multi-node/bounded-soak.json`, `upload-security/engine-drill.json`, browser JUnit/HTML, and failure traces under `test-results/p1/`. Reports explicitly label their local environment and do not provide production signoff. CI uploads these artifacts for seven days and cleans up only containers carrying its own labels.

## Upload screening policy

Classroom chat attachments, teacher materials, assignment reference files and assignment submission files are screened before any uploaded file or uploaded-file metadata in the batch is saved when `UPLOAD_SCAN_ENABLED=true`. Clean files proceed through the existing permissions, allowed types and size checks. Detections return HTTP 400 with a generic rejection; unavailable, malformed, oversized-reply or timed-out scanner responses return HTTP 503. Request filenames, filesystem paths and credentials are not sent to the scanner. The client streams chunks of at most 64 KiB and accepts only a complete NUL-terminated verdict. Each backend process allows two concurrent scans by default, rejecting excess requests instead of growing a scan queue.

Configuration: `UPLOAD_SCAN_HOST`, `UPLOAD_SCAN_PORT`, `UPLOAD_SCAN_TIMEOUT_MS` (default 15000), `UPLOAD_SCAN_MAX_BYTES` (default 64 MiB) and `UPLOAD_SCAN_MAX_CONCURRENT` (default 2). Keep the scan byte limit at least as large as the largest permitted classroom file. Scanning defaults to disabled for backwards-compatible local setup; it must be enabled with a monitored, current engine before claiming malware-screened production uploads. The policy does not retroactively scan stored files.

The optional `infra/docker-compose.upload-security.yml` overlay connects the backend to a private ClamAV service with no host port, a persistent signature volume, health gating and a 4 GiB memory limit. It uses the official feature-version image and its normal signature updater. Review resource use, signature freshness and deployment connectivity before enabling the overlay. Do not expose unauthenticated clamd to the public network. Deploying this overlay is a separate release operation.

The drill starts an isolated real ClamAV daemon with one harmless custom detection signature. It verifies the application scan client accepts an ordinary fixture, rejects that signature and fails closed when the daemon stops. It then removes only its labelled container and temporary fixtures. This verifies integration with the engine; it does not establish public signature freshness or malware detection coverage.

Protocol references: [ClamAV daemon protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html), [official Docker images](https://docs.clamav.net/manual/Installing/Docker.html), [extended signature format](https://docs.clamav.net/manual/Signatures/ExtendedSignatures.html).

## Contract rollout policy

Build contracts first, then run `npm run contracts:check`. The normalized public `.d.ts` hashes are compared with `packages/contracts/api-baseline.json`; any added, removed or changed declaration requires review. The optional `AssignmentDetailResponse.readOnly` field is an additive v1 change: current clients remain compatible and the updated detail screen suppresses writes for historical access. After classifying subsequent changes, regenerate deliberately with `npm run contracts:baseline` and commit both API and baseline changes. Incompatible HTTP/socket changes require a protocol bump and explicit rollout review. Do not update the baseline just to make CI green.

Missing version declarations are treated as legacy version 1 for current compatibility. Explicit unsupported or malformed versions fail before app actions. Provider callbacks/webhooks and the narrowly matched desktop recording capability URL are exempt from client protocol negotiation; their existing verification and access controls still apply. Frontend/admin headers are attached only to the configured trusted API origin.

## Remaining signoff

No deployment credentials, approved production URLs or physical devices were available for this pass. Target-environment restore, provider delivery, public TURN/ICE/pipe/ingress, production-duration soak, physical-device permissions and approved retention remain open. See [the unproven checklist](unproven-checklist.md) for those gates. Do not infer production readiness from a passing local CI run.
