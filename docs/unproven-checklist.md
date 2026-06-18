# Unproven Checklist

This document tracks the areas that are still not proven by the current local and staging validation passes.

Use it as a backlog after staging so the team can close the remaining confidence gaps without mixing them into the active rollout signoff work.

## How To Use This Checklist

- Mark an item done only when it is backed by real evidence, not inference.
- Prefer linking the command, test run, or report that proved the item.
- Keep local-only proof, staging proof, and post-staging improvements separate.

## Local Proof Gaps

These items were not fully proven in the current local pass.

- [ ] Honest frontend-to-backend local UI proof under the real machine port layout
  - Current issue: backend needed to run on `3010`, while the frontend local runtime still targeted `localhost:3000`.
- [ ] Clean backend unit-suite proof
  - Current issue: `apps/backend/src/auth/dto/auth.dto.spec.ts` was red due to TypeScript/Jest matcher typing issues.
- [ ] Honest local distributed/two-node proof
  - Current issue: no checked-in one-command local two-node pipe-enabled cluster was available for `npm run test:live-soak`.
- [ ] Honest local soak/drain proof
  - Current issue: the fallback `npm run test:load:node-drain` could not run because `k6` was not installed.

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
- [ ] Package alert rules or dashboard guidance for TURN, drain, worker, and pipe incidents
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
