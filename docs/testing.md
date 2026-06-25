# Testing

Before running the release gate locally, use the workspace toolchain declared in the root [package.json](/Volumes/Extarnal/RND/SFU/package.json):

- Node.js `>=22.22.3`
- npm `>=10`
- Docker / Docker Compose for MongoDB, Redis, and browser-backed integration slices
- writable local `node_modules` for the Playwright loader patch step

## Unit Tests

The reusable `sfu-core` package tests cover RTP parsing, RTCP parsing, and routing behavior.

```bash
npm run test -w @native-sfu/sfu-core
npm run test -w @native-sfu/backend
```

For the eventing adapter surface specifically, the focused U5 regression slice is:

```bash
npm test -w @native-sfu/backend -- \
  src/events/platform-events.service.spec.ts \
  src/events/adapters/webhook-delivery.adapter.spec.ts \
  src/events/adapters/redis-stream-delivery.adapter.spec.ts \
  src/events/adapters/event-delivery-adapter.registry.spec.ts
```

## Integration Tests

Use Docker Compose to run MongoDB and Redis, then execute backend e2e tests.

```bash
npm run docker:up
npm run test:e2e -w @native-sfu/backend
```

## Build and Dev Runtime Verification

Use this slice when you need to prove that the repo is not only compile-green, but also starts locally in development mode.

Toolchain:

- Node.js `22.22.3` or newer from the root [.nvmrc](/Volumes/Extarnal/RND/SFU/.nvmrc)
- npm `10` or newer
- MongoDB reachable from the backend, default `mongodb://127.0.0.1:27017/native_sfu`
- Redis reachable from the backend, default `redis://127.0.0.1:6379`
- Optional TURN/Coturn for media proof beyond this smoke slice

Build verification:

```bash
npm run build --workspace @native-sfu/contracts
npm run build --workspace @native-sfu/sfu-core
npm run build --workspace @native-sfu/nest-sfu
npm run build --workspace @native-sfu/backend
npm run build --workspace @native-sfu/frontend
npm run build --workspace @native-sfu/admin-portal
```

The convenience wrapper is:

```bash
npm run verify:build
```

Local dev startup order:

1. Start MongoDB and Redis. For the repo compose stack:

```bash
npm run docker:up
```

The dev compose stack exposes MongoDB on host port `27018` and Redis on host port `6379`. If you use those host ports from a backend running directly on the host, set `MONGODB_URI=mongodb://127.0.0.1:27018/native_sfu`.

2. Start the backend:

```bash
npm run verify:dev:backend
```

If another local stack already owns port `3000`, start the backend on a different port and point the portals at it:

```bash
PORT=3100 \
PUBLIC_URL=http://localhost:3100 \
NODE_PUBLIC_URL=http://localhost:3100 \
FRONTEND_URL=http://localhost:4200 \
CORS_ALLOWED_ORIGINS=http://localhost:4200,http://localhost:4300 \
npm run verify:dev:backend
```

3. Start the frontend portal:

```bash
SFU_BACKEND_ORIGIN=http://localhost:3100 npm run verify:dev:frontend
```

4. Start the admin portal:

```bash
SFU_BACKEND_ORIGIN=http://localhost:3100 npm run verify:dev:admin
```

5. Run the smoke probe from another terminal:

```bash
BACKEND_ORIGIN=http://127.0.0.1:3100 \
FRONTEND_ORIGIN=http://127.0.0.1:4200 \
ADMIN_ORIGIN=http://127.0.0.1:4300 \
npm run verify:dev:smoke
```

That smoke checks backend live/ready health, the protected API route shape, the Socket.IO Engine.IO handshake at `/socket.io`, and unauthenticated frontend/admin route shells. It does not prove real camera, microphone, TURN relay, or authenticated class-session media behavior.

Expected dev ports:

| Service | Default port | Notes |
| --- | --- | --- |
| Backend API and Socket.IO | `3000` | Use `PORT=3100` or another free port when `3000` is occupied. |
| Frontend portal | `4200` | Proxy uses `SFU_BACKEND_ORIGIN`, default `http://localhost:3000`. |
| Admin portal | `4300` | Proxy uses `SFU_BACKEND_ORIGIN`, default `http://localhost:3000`. |
| MongoDB via dev compose | `27018` | Backend inside compose uses service DNS `mongo:27017`. |
| Redis via dev compose | `6379` | Backend inside compose uses service DNS `redis:6379`. |

Current local caveats:

- Authenticated admin smoke needs a seeded admin credential for the local database. If the documented bootstrap credential is not present, login will correctly return `401`.
- Angular dev servers start successfully under Node `22.22.3`. If a production `ng build` fails with an esbuild runtime crash on a specific machine, keep the dev-server smoke result separate from the build result and report the exact esbuild stack.

## Browser Interop

The release-candidate browser slice runs through the repo wrapper so the Playwright loader patch is applied first.

```bash
npm run test:browser
```

Per-browser reruns are available when only one engine needs verification:

```bash
npm run test:browser:chromium
npm run test:browser:firefox
npm run test:browser:webkit
```

For Milestone U2 operator signoff, use the focused local browser workflow:

```bash
npm run test:browser:operator
```

That slice starts a repo-managed local backend stack plus an Angular dev server and then drives the real operator UI through Chromium. It validates:

- room protection and recovery state in the host controls UI
- incident timeline and snapshot history rendering
- live recovery action propagation
- distributed owner redirect handling with room rehydration on the redirected page
- `room:failed` browser surfacing against the real backend failure-handling path
- incident, recovery, snapshot, and failure metrics remaining coherent with the UI

Notes:

- Use Node `22.22.3` or set `SFU_NODE_BIN` to a compatible Node 22 binary for this local harness.
- This is a truthful repo-supported validation path for operator/browser signoff in this environment.
- It is not a substitute for staged ingress, TURN, or public-network media proof.
- In this local environment the Angular production build path can still fail with an allocator crash, so U2 browser signoff is intentionally anchored to the Node 22 `ng serve` harness rather than pretending that `ng build` is currently the strong local gate.

## Supported Environment Matrix

| Validation slice | Current status | Strongest command | Important limit |
| --- | --- | --- | --- |
| Local operator incident workflow | Chromium validated | `npm run test:browser:operator` | Proves operator UI/runtime truth locally, not public ingress or staged media truth |
| Local single-node browser media | Partial local regression evidence | `npm run test:browser` | Good for repo/runtime regressions, not public-network proof |
| Staged TURN relay gathering | Chromium validated | `npm run test:browser:staging-turn` | Proves relay candidate gathering only, not full publish/subscribe over ingress |
| Staged full browser publish/subscribe over shared ingress | Chromium harness available | `npm run test:browser -- tests/browser/staging-ingress-browser-proof.spec.ts --project=chromium` | Requires real staging credentials and still needs a real out-of-sandbox browser run for signoff |
| Two-node distributed soak | Synthetic distributed soak evidence with report output | `npm run docker:start:multi-node && npm run seed:dummy-users:multi-node && npm run test:live-soak:local` | Uses backend/socket flows, not a browser DTLS/SRTP media path |
| Firefox | Partial | `npm run test:browser:firefox` | Some live multi-layer and impairment slices still skip in Playwright |
| WebKit | Partial | `npm run test:browser:webkit` | Flow coverage exists, but live adaptive/browser edge coverage is thinner than Chromium |
| TURN transport support | UDP only | `npm run test:browser:staging-turn` | Do not advertise TURN-over-TCP or TURNS in the current RC |

## Staging Rollout Signoff

Use the dedicated staged signoff checks in this order when validating a production-like environment. Run the server-side preflight against direct node URLs, then run the browser proof against the shared ingress hostname.

1. Server-side preflight:

```bash
NODE_A_URL=https://node-a.example.com \
NODE_B_URL=https://node-b.example.com \
OPERATIONS_TOKEN=... \
EXPECT_DISTRIBUTED=true \
EXPECT_PIPE_ENABLED=true \
npm run test:staging:preflight
```

If you also want the preflight to verify authenticated TURN credential shape, add `STAGING_EMAIL` and `STAGING_PASSWORD` to the command.

That probe validates:

- `/health/live` and `/health/ready`
- `/metrics` operator-token enforcement
- node diagnostics, pipe/runtime health, and TURN diagnostics
- effective server-side ICE runtime state for `ICE_STUN_SERVERS`, `ICE_TURN_SERVERS`, and `ICE_ANNOUNCED_ADDRESS`
- worker readiness plus CPU / memory snapshots
- Prometheus refresh status and default event-loop metrics
- optional authenticated `GET /api/v1/media/turn-credentials` response shape when staging user credentials are provided

What that preflight proves:

- the deployed nodes are booted with a sane control-plane config surface
- production token hardening and operator diagnostics are behaving as expected
- the process is not obviously advertising localhost or unsupported TURN settings

Repo-side P0 security hardening was verified on 2026-06-25 with:

- `npm test --workspace @native-sfu/backend -- env.validation.spec.ts operations-token.guard.spec.ts health.controller.spec.ts metrics.controller.spec.ts`
- `npm test --workspace @native-sfu/backend -- rooms.gateway.spec.ts rooms.service.spec.ts class-sessions.service.spec.ts`
- `npm test --workspace @native-sfu/backend -- media.controller.spec.ts recordings.service.spec.ts platform-events.service.spec.ts`
- backend, frontend, and admin portal builds
- `git diff --check`

That local verification proves compile/test coverage for the guardrails. It does not replace staging proof with real production-like secrets, ingress, TURN, CORS origins, and operator-token-protected scrape/diagnostic access.

What it does not prove:

- actual browser ICE gathering
- successful room join, publish, subscribe, or media flow over ingress
- owner-aware ingress behavior across reconnects or multi-node session churn

2. Shared-ingress browser TURN proof:

```bash
STAGING_BASE_URL=https://sfu.example.com \
STAGING_EMAIL=teacher.one@example.com \
STAGING_PASSWORD=Password@12345 \
npm run test:browser:staging-turn
```

That browser slice logs in through the deployed auth API, fetches real `/api/v1/media/turn-credentials`, and asserts that Chromium gathers at least one `relay` ICE candidate from the staged UDP TURN deployment.

What that browser proof proves:

- the shared ingress hostname can reach the real auth and TURN-credential endpoints
- staged TURN credentials are usable by Chromium
- at least one non-local UDP relay candidate is gatherable from the deployed TURN service

What it does not prove:

- browser publish/subscribe through the application room flow
- media on the real `HOST_CANDIDATE_PORT_RANGE`
- pipe-media behavior on `PIPE_PORT_RANGE`
- Socket.IO stickiness or owner routing through the ingress layer
- Firefox or WebKit staged behavior

These two checks are necessary for staged rollout confidence, but they are not sufficient to claim full browser/media ingress truth on their own. Keep the remaining gaps visible in [docs/unproven-checklist.md](/Volumes/Extarnal/RND/SFU/docs/unproven-checklist.md).

## Release-Candidate Gate

The minimum automated RC gate is:

```bash
npm run test:rc
```

That covers linting, workspace builds, workspace unit tests, backend e2e tests, and the browser interop suite.

## Load Tests

The k6 script in `tests/load/socketio-room-flow.js` is a scaffold for room signaling flows. Real media load testing requires a WebRTC traffic generator that can produce DTLS-SRTP traffic.

```bash
npm run test:load:socketio
```

Use `tests/load/node-drain-soak.js` to repeatedly validate runtime node drain/undrain behavior and health exposure during maintenance windows:

```bash
BASE_URL=http://localhost:3000 APPLY_NODE_DRAIN=true DURATION=5m npm run test:load:node-drain
```

Without `APPLY_NODE_DRAIN=true`, the script runs a read-only health/auth smoke path and does not change node drain state.

The two-node synthetic distributed soak harness lives in `tests/load/live-soak-signoff.mjs`:

```bash
npm run docker:start:multi-node
npm run seed:dummy-users:multi-node
npm run test:live-soak:local
npm run docker:down:multi-node
```

This starts two backend containers against shared MongoDB/Redis using `infra/docker-compose.multi-node.yml`. Node A is exposed on `http://127.0.0.1:3000`, node B is exposed on `http://127.0.0.1:3002`, pipe transport is enabled by default for this local proof, and the checked-in local operations token is `local-multinode-operations-token-32chars`.

The local soak command writes a timestamped JSON report under `reports/live-soak/`. It exits non-zero when declared proof expectations fail, including final baseline cleanup, worker readiness, metrics refresh status, drain new-room rejection, distributed node presence when `EXPECT_DISTRIBUTED=true`, and pipe runtime health when `EXPECT_PIPE_ENABLED=true`.

If operations hardening is enabled in a different target environment, add `OPERATIONS_TOKEN=...` to the drain and live-soak commands so metrics and media diagnostics remain reachable during validation.

The live soak report now captures worker CPU / RSS snapshots, process memory, default event-loop lag metrics, and Prometheus refresh status in addition to rooms / transports / consumers / pipe state.

For public staging, prefer direct node URLs for `NODE_A_URL` / `NODE_B_URL` so you can distinguish owner and non-owner behavior during distributed soak. Use the shared ingress hostname for the browser TURN and shared-ingress publish/subscribe proofs.

For a staging two-node soak, keep the same harness but replace the URLs and token:

```bash
NODE_A_URL=https://node-a.example.com \
NODE_B_URL=https://node-b.example.com \
OPERATIONS_TOKEN=... \
EXPECT_DISTRIBUTED=true \
EXPECT_PIPE_ENABLED=true \
REPORT_DIR=reports/live-soak-staging \
npm run test:live-soak
```

This harness proves owner routing, remote publisher/subscriber signaling, node drain, cleanup, and pipe-health metrics at the backend/socket layer. It does not prove public browser ICE/DTLS/SRTP, TURN relay gathering, shared ingress stickiness, or Kubernetes UDP exposure; run the staging browser and TURN proofs separately for those.

Worker crash validation is intentionally destructive and opt-in. It only runs against local node targets and must be enabled explicitly:

```bash
ENABLE_WORKER_CRASH_VALIDATION=true \
NODE_A_URL=http://127.0.0.1:3000 \
NODE_B_URL=http://127.0.0.1:3002 \
OPERATIONS_TOKEN=... \
npm run test:live-soak
```

The mixed-adapter eventing backlog and fairness harness lives in `tests/load/eventing-mixed-backlog-soak.mjs`:

```bash
npm run docker:up
npm run seed:dummy-users

NODE_A_URL=http://127.0.0.1:3000 \
NODE_B_URL=http://127.0.0.1:3002 \
SEED_USER_PASSWORD=Password@12345 \
OPERATIONS_TOKEN=... \
WEBHOOK_ENDPOINT_BASE_URL=http://127.0.0.1:4319 \
npm run test:eventing:soak
```

What this U5A slice proves:

- real room/producer/consumer lifecycle events drive the platform event log
- mixed webhook + Redis stream endpoints share the same persisted queue
- slow and failing webhook destinations create real retry / exhaustion pressure
- Redis stream deliveries write real `XADD` entries and preserve delivery references
- queue drain, backlog aging, and top-lane concentration are observable through `GET /api/v1/events/diagnostics/summary`
- per-node fairness can be checked from the per-node `/metrics` scrape plus the final JSON report

Important local notes:

- `infra/docker-compose.dev.yml` now exposes Redis on host port `6379` and MongoDB on host port `27018`, which the harness uses for the direct Redis / Mongo evidence slice.
- For a backend running inside Docker, `WEBHOOK_ENDPOINT_BASE_URL=http://host.docker.internal:4319` is usually the truthful setting so the container can reach the host webhook receiver.
- For a backend running directly on the host, `WEBHOOK_ENDPOINT_BASE_URL=http://127.0.0.1:4319` is fine.
- Full U5A fairness signoff needs two distinct backend nodes. Reusing the same URL for `NODE_A_URL` and `NODE_B_URL` is useful for backlog smoke-testing, but it is not honest distributed fairness evidence.
