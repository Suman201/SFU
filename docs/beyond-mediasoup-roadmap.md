# Beyond Mediasoup Roadmap

This roadmap is about becoming more useful than mediasoup for a product team or operator, not about trying to win a purity contest on raw SFU minimalism.

Mediasoup is already strong at the low-level SFU layer: transport, routing, simulcast, SVC, bitrate adaptation, `WebRtcServer`, `pipeToRouter()`, observers, and traceable primitives. Competing only on "another SFU core" is the least favorable battle.

This repo has a better opening elsewhere:

- a real NestJS control plane
- shared contracts
- room and moderation state
- metrics and diagnostics
- worker-mode and distributed pipe foundations
- an Angular app that can prove product workflows instead of isolated SFU mechanics

The best strategy is to turn the SFU into a complete real-time platform with operator automation, policy, diagnostics, and workflow depth built in.

## Positioning

Target statement:

> "Choose this when you want mediasoup-class media control plus an opinionated platform for rooms, policy, operations, and rollout safety."

That is a more realistic and more valuable wedge than claiming universal SFU superiority.

## Current Strengths To Build On

The repo already has unusual leverage compared with a raw SFU library:

- room, participant, permissions, moderation, and chat contracts
- consumer, producer, transport, and room quality surfaces
- worker drain, node drain, readiness, pipe diagnostics, and staging preflight guardrails
- TURN credential delivery and deployment-facing media diagnostics
- recording domain scaffolding
- distributed ownership and pipe transport hooks

Those surfaces are the starting point for differentiation.

## Recommended Differentiation Tracks

### 1. Operator Autopilot

Goal:

- make deployment and incident handling safer than a DIY mediasoup stack

Build:

- rollout preflight API that scores config safety before admission
- automatic room/node admission throttling from live congestion and worker pressure
- incident bundles that snapshot room, transport, producer, consumer, and pipe state
- one-click maintenance workflows built on existing drain controls
- runtime config truth endpoints that highlight "declared vs effective" networking state

Why it wins:

- mediasoup gives primitives; this gives operators decisions and guardrails

Primary modules:

- `apps/backend/src/media`
- `apps/backend/src/health`
- `apps/backend/src/metrics`
- `apps/backend/src/cluster`
- `packages/contracts/src/metrics.ts`
- `docs/operator-runbook.md`

### 2. Quality Policy Engine

Goal:

- let products express intent like "classroom", "webinar", or "support call" without hand-coding transport policy every time

Build:

- room media profiles with defaults for bitrate ceilings, layer preferences, dynacast behavior, and priority weights
- host/co-host controls for quality mode, screen-share preference, and recovery aggressiveness
- policy-driven allocation inputs on top of the existing scoring and quality state
- policy-aware fallback behavior when congestion persists

Why it wins:

- mediasoup exposes knobs; this repo can expose outcomes

Primary modules:

- `packages/contracts/src/rooms.ts`
- `packages/contracts/src/metrics.ts`
- `packages/contracts/src/signaling.ts`
- `apps/backend/src/rooms`
- `packages/nest-sfu/src/media.service.ts`
- `packages/sfu-core/src/rtp`

### 3. Eventing, Webhooks, and Auditability

Goal:

- make the platform integratable without custom socket scraping or ad hoc database polling

Build:

- signed webhooks for room lifecycle, recording lifecycle, quality degradation, worker failure, drain events, and moderation actions
- append-only audit/event log for operator and compliance workflows
- replayable room timeline for incident review
- external sink support for Slack, PagerDuty, and warehouse-style exports

Why it wins:

- mediasoup is a library; this becomes an operational system boundary

Primary modules:

- `packages/contracts/src/signaling.ts`
- `apps/backend/src/rooms`
- `apps/backend/src/media`
- `apps/backend/src/recordings`
- `apps/backend/src/database`
- new `apps/backend/src/events` or `apps/backend/src/webhooks`

### 4. Recording, Analytics, and Post-Room Intelligence

Goal:

- turn live sessions into artifacts and operator intelligence

Build:

- complete room recording pipeline with resilient status tracking
- room quality report with join latency, bitrate history, loss spikes, active speaker windows, and degraded-participant summary
- searchable recording metadata and export formats
- transcript and chapter hooks once recording is stable

Why it wins:

- most teams using mediasoup eventually build this themselves

Primary modules:

- `apps/backend/src/recordings`
- `packages/contracts/src/recordings.ts`
- `packages/contracts/src/metrics.ts`
- `apps/backend/src/media`
- `apps/backend/src/rooms`

### 5. Multi-Tenant Governance and Commercial Controls

Goal:

- make the platform useful for more than a single internal deployment

Build:

- tenants or organizations
- room templates and policy presets
- API keys and scoped operations tokens
- quotas for rooms, publishers, recording, and bitrate tiers
- admin surfaces for audit, bans, and support workflows

Why it wins:

- this is where "product platform" value starts to exceed "SFU library" value

Primary modules:

- `apps/backend/src/auth`
- `apps/backend/src/rooms`
- `apps/backend/src/common/guards`
- `packages/contracts/src/rooms.ts`
- `packages/contracts/src/permissions.ts`
- `packages/contracts/src/roles.ts`
- `apps/frontend/src/app`

### 6. Developer Truthfulness and Local/Stage Tooling

Goal:

- reduce the time from clone to trustworthy media proof

Build:

- one-command local cluster bring-up with explicit port and dependency checks
- environment doctor that validates Redis, Mongo, TURN, announced IP, and ingress assumptions
- reproducible scenario harnesses for churn, congestion, and distributed ownership
- room/transport debug exports that can be attached to bug reports

Why it wins:

- faster debugging and safer rollout are a real product advantage

Primary modules:

- `README.md`
- `docs/testing.md`
- `docs/deployment.md`
- `tests/browser`
- `tests/load`
- `infra/docker`

## Best Implementation Order

If the goal is "more useful than mediasoup" in the next few milestones, the order should be:

1. `Operator Autopilot`
2. `Quality Policy Engine`
3. `Eventing, Webhooks, and Auditability`
4. `Recording, Analytics, and Post-Room Intelligence`
5. `Multi-Tenant Governance and Commercial Controls`
6. `Developer Truthfulness and Local/Stage Tooling`

This order matters because it builds value on top of the repo's current strengths instead of branching into a second giant media-core effort.

## First Concrete Milestone

The highest-leverage next build is:

### Milestone U1: Operator Autopilot and Policy Foundation

Deliverables:

- room media profile model: `meeting`, `webinar`, `classroom`, `support`
- room quality summary endpoint with policy-aware recommendations
- drain-safe room admission throttling when worker or node quality drops
- incident snapshot export for a room or transport
- frontend host controls for selecting room media profile

Suggested starting files:

- `packages/contracts/src/rooms.ts`
- `packages/contracts/src/metrics.ts`
- `packages/contracts/src/signaling.ts`
- `apps/backend/src/rooms/rooms.service.ts`
- `apps/backend/src/rooms/rooms.gateway.ts`
- `apps/backend/src/media/media.controller.ts`
- `apps/backend/src/metrics/metrics.service.ts`
- `apps/frontend/src/app`

## What Not To Optimize First

Do not spend the next milestone trying to out-mediasoup mediasoup on:

- more codec permutations for their own sake
- AV1 dependency-descriptor breadth before product demand is real
- broad architecture rewrites
- speculative multi-region work before operator workflows are smooth

Those can matter later, but they are not the strongest path to usefulness.

## Practical Conclusion

This repo can become more useful than mediasoup if it treats mediasoup as the reference point for media primitives and then wins on:

- operations
- policy
- diagnostics
- workflow integration
- product completeness

The right ambition is:

> "mediasoup-class media core, but with a built-in control plane and operator platform."

That is both believable and valuable.
