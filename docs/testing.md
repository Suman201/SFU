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

## Integration Tests

Use Docker Compose to run MongoDB and Redis, then execute backend e2e tests.

```bash
npm run docker:up
npm run test:e2e -w @native-sfu/backend
```

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

## Staging Rollout Signoff

Use the dedicated staging checks in this order when validating a production-like environment:

1. Operator and runtime preflight:

```bash
NODE_A_URL=https://node-a.example.com \
NODE_B_URL=https://node-b.example.com \
OPERATIONS_TOKEN=... \
EXPECT_DISTRIBUTED=true \
EXPECT_PIPE_ENABLED=true \
npm run test:staging:preflight
```

That probe validates:

- `/health/live` and `/health/ready`
- `/metrics` operator-token enforcement
- node diagnostics, pipe/runtime health, and TURN diagnostics
- worker readiness plus CPU / memory snapshots
- Prometheus refresh status and default event-loop metrics

2. Real browser TURN proof:

```bash
STAGING_BASE_URL=https://sfu.example.com \
STAGING_EMAIL=teacher.one@example.com \
STAGING_PASSWORD=Password@12345 \
npm run test:browser:staging-turn
```

That browser slice logs in through the deployed auth API, fetches real `/api/v1/media/turn-credentials`, and asserts that Chromium gathers at least one `relay` ICE candidate from the staged UDP TURN deployment.

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

The two-node live soak and capacity signoff harness lives in `tests/load/live-soak-signoff.mjs`:

```bash
npm run seed:dummy-users
NODE_A_URL=http://127.0.0.1:3000 \
NODE_B_URL=http://127.0.0.1:3002 \
SEED_USER_PASSWORD=Password@12345 \
npm run test:live-soak
```

If operations hardening is enabled in the target environment, add `OPERATIONS_TOKEN=...` to the drain and live-soak commands so metrics and media diagnostics remain reachable during validation.

The live soak report now captures worker CPU / RSS snapshots, process memory, default event-loop lag metrics, and Prometheus refresh status in addition to rooms / transports / consumers / pipe state.

For public staging, prefer direct node URLs for `NODE_A_URL` / `NODE_B_URL` so you can distinguish owner and non-owner behavior during distributed soak. Use the shared ingress hostname for the browser TURN proof.

Worker crash validation is intentionally destructive and opt-in. It only runs against local node targets and must be enabled explicitly:

```bash
ENABLE_WORKER_CRASH_VALIDATION=true \
NODE_A_URL=http://127.0.0.1:3000 \
NODE_B_URL=http://127.0.0.1:3002 \
OPERATIONS_TOKEN=... \
npm run test:live-soak
```
