# Mediasoup Gap Roadmap

This document captures the practical estimate for how many additional phases it would take to close the remaining gap between this repo and a mediasoup-grade production posture.

It is not a claim of full parity. It is a planning aid for deciding how much additional hardening, validation, and operational work is still needed.

## Summary

There are two useful planning targets:

- **3 phases** if the goal is to become a very strong controlled-deployment custom SFU
- **5 phases** if the goal is to close most of the fillable gap versus mediasoup

The remaining gap is not evenly distributed. The repo is already much closer on core SFU mechanics than it is on long-tail production confidence and operational maturity.

## What Is Still Fillable

These are the areas where focused engineering can close most of the remaining gap:

- ICE / STUN / nomination correctness
- DTLS / SRTP / RTCP edge-case handling
- RTP forwarding correctness
- retransmission, NACK, PLI, FIR, RTX behavior
- packet loss, reordering, duplicate handling
- simulcast / SVC / adaptive switching behavior
- worker-mode and distributed forwarding hardening
- browser regression coverage
- deployment validation and rollout safety
- observability, diagnostics, and operator guidance

## What Is Harder To Fill Quickly

These gaps usually require time and repeated production exposure:

- years of long-tail real-world bug history
- community-discovered edge cases
- repeated operator failure patterns
- browser drift across releases
- weird NAT / firewall / network behavior across many environments
- large-scale operational confidence

## Three-Phase Plan

Use this plan if the target is:

- a strong self-hosted SFU for controlled environments
- internal production use
- limited customer environments with a team that owns the infrastructure

### Phase A: Mediasoup Issue Hardening

Goal:

- use mediasoup issues and fixes as a scenario bank
- classify which issue classes apply to this repo
- fix directly applicable correctness gaps
- add regression tests

Primary focus:

- transport correctness
- forwarding correctness
- RTCP / retransmission behavior
- simulcast / SVC edge cases
- worker cleanup and distributed forwarding races

### Phase B: Local and Staging Scenario Closure

Goal:

- run the repo against the highest-value real scenarios before broader rollout
- close the remaining local proof gaps
- validate real staging behavior for public TURN, distributed media, and real deployment wiring

Primary focus:

- honest local end-to-end proof
- real staging TURN proof
- real UDP media-plane proof
- distributed ownership and cleanup validation
- soak / churn / drain confidence

### Phase C: Production Validation and Ops Maturity

Goal:

- convert technical correctness into operator trust
- tighten rollout safety, alerts, diagnostics, and runbooks
- repeat soak and failure validation until rollout decisions are boring

Primary focus:

- capacity and soak evidence
- drain / restart / cleanup reliability
- alert thresholds
- diagnostics completeness
- operator runbook maturity

### Expected Outcome After 3 Phases

Likely result:

- strong technical confidence
- strong regression depth
- credible controlled-rollout production posture
- still not equal to mediasoup's long-history confidence

## Five-Phase Plan

Use this plan if the target is:

- close most of the fillable gap versus mediasoup
- become a serious replacement candidate in a narrower self-hosted market
- raise production trust well beyond a controlled RC/GA candidate

### Phase 1: Mediasoup Issue Matrix

Goal:

- audit open and relevant fixed mediasoup issues
- classify each one for this repo
- identify exact missing coverage and risk

Deliverables:

- hardening matrix
- applicability classification
- prioritized backlog

### Phase 2: Applicable Bug-Class Fixes and Regressions

Goal:

- implement narrow fixes for applicable issue classes
- add unit, integration, browser, and soak regressions where needed

Deliverables:

- focused code fixes
- focused regression suites

### Phase 3: Browser, Network, and Deployment Hardening

Goal:

- harden the repo against realistic browser and deployment behavior
- improve TURN, routing, ingress, and media-plane truthfulness

Deliverables:

- stronger browser confidence
- stronger deployment validation
- clearer supported-environment boundaries

### Phase 4: Distributed Soak and Failure Injection

Goal:

- aggressively test distributed, worker-mode, and lifecycle behavior
- validate recovery, cleanup, and churn under realistic failure modes

Deliverables:

- distributed soak evidence
- failure recovery evidence
- cleanup convergence confidence

### Phase 5: Operational Packaging and Repeatability

Goal:

- make the repo easier to deploy and operate safely
- improve repeatability of rollout and rollback

Deliverables:

- stronger deployment packaging
- better operator guidance
- better alerts / dashboards / runbooks

### Expected Outcome After 5 Phases

Likely result:

- most of the technical gap is closed
- much of the deployment and validation gap is closed
- operational confidence is much stronger
- still behind mediasoup on ecosystem maturity and years of accumulated production history

## Gap Shape Versus Mediasoup

The remaining gap is best thought of in three buckets:

### Smallest Gap

- core RTP/RTCP/SFU mechanics
- transport and forwarding behavior

### Medium Gap

- regression depth
- browser and network edge-case coverage
- distributed and worker-mode hardening

### Largest Gap

- long-tail production confidence
- deployment packaging
- operator ecosystem maturity
- years of field exposure

## Planning Guidance

Choose the **3-phase plan** if:

- the target is a strong controlled deployment
- the team owns infra deeply
- broad turnkey replacement is not yet required

Choose the **5-phase plan** if:

- the target is to close most of the practical gap versus mediasoup
- the repo needs stronger replacement credibility
- the team is willing to invest in validation, ops, and long-run hardening

## Practical Conclusion

The repo can likely close **most of the technical and validation gap** with focused work.

It cannot fully shortcut the final maturity edge that comes from:

- time
- production exposure
- incident history
- ecosystem experience

So the realistic planning answer is:

- **3 phases** for a strong controlled custom SFU posture
- **5 phases** for closing most of the fillable gap versus mediasoup
