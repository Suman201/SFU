# Testing

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

## Load Tests

The k6 script in `tests/load/socketio-room-flow.js` is a scaffold for room signaling flows. Real media load testing requires a WebRTC traffic generator that can produce DTLS-SRTP traffic.
