# Unproven Checklist

This document tracks the areas that are still not proven by the current local and staging validation passes.

Use it as a backlog after staging so the team can close the remaining confidence gaps without mixing them into the active rollout signoff work.

Updated local evidence and remaining deployment gates: [P0 release readiness](p0-release-readiness.md), 26 November 2026.

## How To Use This Checklist

- Mark an item done only when it is backed by real evidence, not inference.
- Prefer linking the command, test run, or report that proved the item.
- Keep local-only proof, staging proof, and post-staging improvements separate.

## Local Proof Gaps

These items were not fully proven in the current local pass.

- [x] Real frontend-to-backend local paid classroom journey
  - `npm run test:p0:browser`: real login, checkout, SFU media, reconnect, recording/playback and private post-class Q&A; actual screenshots in `reports/p0/`. Public staging remains separate.
- [x] Clean backend unit-suite proof
  - `npm run test:p0:backend`: all 66 suites / 770 tests passed locally on 26 November 2026 with FFmpeg available.
- [ ] Honest local distributed/two-node proof
  - Done: the checked-in local two-node stack and report-writing soak harness now exist (`npm run docker:start:multi-node`, `npm run seed:dummy-users:multi-node`, `npm run test:live-soak:local`).
  - Current issue: keep this proof item open until a real passing report from `reports/live-soak/` is attached. The latest run did not start the soak because existing Docker containers already occupied host ports `3000`, `3002`, and `6379`.
- [ ] Honest local soak/drain proof
  - Current issue: the fallback `npm run test:load:node-drain` could not run because `k6` was not installed.
- [ ] True two-gateway targeted-event integration proof
  - Current issue: service and gateway unit coverage proves private targeting and Redis fanout separately, but there is not yet a two-live-gateway integration run proving private chat, moderation, read receipts, and whiteboard commands reach only intended sockets across nodes.

## Staging Proof Gaps

These items block a truthful controlled-rollout signoff until they are executed against a real staging environment.

- [ ] Run the staging preflight against real node URLs and a real operations token
- [ ] Re-run the staging preflight with `STAGING_EMAIL` and `STAGING_PASSWORD` so `/api/v1/media/turn-credentials` is checked with a real user session
- [ ] Run the Chromium TURN relay proof against the real shared staging ingress hostname
- [ ] Run the Chromium shared-ingress browser publish/subscribe proof against real staging credentials
- [ ] Prove public Coturn UDP reachability behind the advertised TURN URI
- [ ] Prove real UDP media-plane exposure for `HOST_CANDIDATE_PORT_RANGE`
- [ ] Prove real UDP media-plane exposure for `PIPE_PORT_RANGE` when pipe transport is enabled
- [ ] Prove multi-node distributed behavior end to end with a trustworthy owner-routing story
- [ ] Prove targeted class-session events across real multi-node Socket.IO instances without private-message or moderation leaks
- [ ] Prove drain and recovery behavior in the real staging deployment shape
- [ ] Prove that the deployment has a working `preStop` drain-hook path or equivalent rollout-safe drain mechanism

## Still Unproven Even After The Browser Ingress Proof

If the preflight, Chromium relay-gathering proof, and Chromium shared-ingress publish/subscribe proof all pass, keep these items open until they have separate evidence:

- [ ] Real browser media on the public `HOST_CANDIDATE_PORT_RANGE`
- [ ] Real browser-visible multi-node owner routing, reconnect, and host handoff behavior
- [ ] Real `PIPE_PORT_RANGE` media movement between nodes when pipe transport is enabled
- [ ] Real ingress/load-balancer drain plus recovery behavior during rollout
- [ ] Firefox and WebKit staged behavior beyond local-only regression coverage

## Post-Staging Follow-Ups

These are useful follow-ups after staging even if staging goes green.

- [ ] Add a staging-only Kubernetes overlay for real UDP exposure and drain-hook wiring
- [ ] Broaden the shared-ingress browser proof beyond Chromium and single-flow video coverage
- [ ] Add explicit frontend handling for owner redirects if multi-node non-pipe routing is meant to be first-class
- [x] Package alert rules and dashboard guidance for drain, worker, capacity, abuse, control-plane, and pipe incidents. Environment alert delivery remains unproven.
- [x] Run a Mongo/artifact backup and isolated restore drill using the production scripts
  - `npm run test:p0:operations`: age-encrypted archive, actual restore to a fresh MongoDB, six artifact directories, wrong-key/checksum rejection before writes; `reports/p0/operations.json`. Target-environment RPO/RTO remains unproven.
- [x] Verify production alert rules and actual Alertmanager firing/resolved delivery to an isolated local receiver
  - `npm run test:p0:operations`; Promtool timing assertions and real webhook receipt.
- [ ] Verify the deployment-configured Alertmanager receiver receives firing and resolved alerts
- [ ] Decide whether `/metrics` should remain canonical with alias behavior documented, or become fully path-configurable
- [ ] Reduce backend lint/test warning noise that obscures real failures
- [ ] Quiet `ts-jest` dist `.js` transform warnings in backend test output

## Still Not Proven By Local Alone

Even a fully green local pass does not prove these items:

- [ ] Public TURN correctness
- [ ] Public/announced IP correctness
- [ ] Real ingress behavior
- [ ] Real Kubernetes UDP media-plane behavior
- [ ] Real production-like multi-node rollout safety

## Evidence Notes

When closing an item, record:

- command or test name
- environment used
- result summary
- location of any generated report, if applicable
