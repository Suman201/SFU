# Unproven Checklist

This document tracks the areas that are still not proven by the current local and staging validation passes.

Use it as a backlog after staging so the team can close the remaining confidence gaps without mixing them into the active rollout signoff work.

Updated local evidence and remaining deployment gates: [P0 release readiness](p0-release-readiness.md) and [P1 release readiness](p1-release-readiness.md), 26 November 2026.

## How To Use This Checklist

- Mark an item done only when it is backed by real evidence, not inference.
- Prefer linking the command, test run, or report that proved the item.
- Keep local-only proof, staging proof, and post-staging improvements separate.

## Local Proof Gaps

Completed local proof is bounded by the scope below; unchecked environment gates remain separate.

- [x] Real frontend-to-backend local paid classroom journey
  - `npm run test:p0:browser`: real login, checkout, SFU media, reconnect, recording/playback and private post-class Q&A; actual screenshots in `reports/p0/`. Public staging remains separate.
- [x] Clean backend unit-suite proof
  - `npm run test:p0:backend`: the complete backend suite passed locally on 26 November 2026 with FFmpeg available.
- [x] Bounded local distributed/two-node proof
  - `npm run test:p1:browser`: two actual worker-mode backends with shared Redis/Mongo, native UDP video in both directions, and zero cleanup baselines. Reports: `reports/p1/multi-node/` and browser JUnit. Public ingress and active owner handoff remain unproven.
- [x] Bounded local churn/drain/recovery proof
  - Required P1 gate: three descriptor churn cycles, room steps 2/4, admission drain while current chat continues, intentional child-worker crash and replacement. This does not establish production capacity or long-running browser RTP stability.
- [x] Two-live-gateway private/targeted-event proof
  - Required P1 gate verifies private chat, read receipts, whiteboard control grants, targeted media moderation and class-only broadcasts; unrelated classmates/rooms receive no private or targeted payloads. This does not prove cross-owner whiteboard mutation routing or active-room migration.

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
