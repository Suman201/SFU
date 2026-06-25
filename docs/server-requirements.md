# Server Requirements and Deployment Profiles

This document explains what kind of servers this SFU platform needs, how to think about sizing, and what is already supported by the current codebase versus what still needs real-world validation.

It is intentionally practical. This is not a marketing sizing sheet and it is not a claim of proven hyperscale capacity. It is a deployment guide for the repository as it stands today.

## What kind of server does this SFU need?

For production media workloads, this SFU should run on:

- Linux servers or Linux VMs
- dedicated or high-performance general-purpose instances
- stable CPU, RAM, and network capacity
- public UDP reachability
- a real public or announced IP configuration

The best fit is:

- bare metal, or
- non-burstable cloud compute, or
- high-quality VMs with predictable network performance

The worst fit is:

- tiny shared instances
- burstable instances for sustained media workloads
- platforms that hide or restrict UDP behavior
- deployments that only expose HTTP ingress and do not expose media UDP ports

In simple terms: this repo wants "real infrastructure," not just a web-app host.

## What the current repo is built for

Today, the repository is best treated as:

- strong custom SFU architecture
- production-minded transport and routing foundation
- controlled single-node and two-node deployment candidate
- not yet a broadly proven LiveKit-scale or mediasoup-fleet-scale system

That means the server choice matters a lot. The code is only one half of the answer. The host network, port exposure, TURN behavior, and deployment topology decide whether the system feels reliable in real use.

## Recommended deployment profiles

These are starting profiles, not guaranteed capacity numbers.

### 1. Local development

Use this for:

- feature development
- local browser testing
- backend and signaling checks
- light single-machine validation

Recommended starting point:

- 4 vCPU
- 8 GB RAM
- Docker available for Mongo and Redis
- local UDP allowed

This is enough for development, but it does not prove public-network behavior.

### 2. Single-node controlled production or internal pilot

Use this for:

- internal rollout
- small pilots
- private customer validation
- production-like proof before broader scale-out

Recommended starting point:

- 8 vCPU
- 16 GB RAM
- SSD storage
- 1 Gbps network
- dedicated public IP or correctly announced IP
- external or well-configured TURN

This is the smallest shape that starts to make sense for honest media use.

### 3. Two-node controlled distributed deployment

Use this for:

- owner-node and non-owner-node routing validation
- distributed pipe transport validation
- drain and failover exercises
- pre-scale production proving

Local proof harness:

- `npm run docker:start:multi-node`
- `npm run seed:dummy-users:multi-node`
- `npm run test:live-soak:local`

That local harness is useful for repo-level backend/socket evidence, but it is not a substitute for two real nodes with public UDP and ingress validation.

Recommended starting point per SFU node:

- 8 to 16 vCPU
- 16 to 32 GB RAM
- SSD storage
- 1 Gbps or better network
- public UDP exposure
- low-latency private connectivity between nodes

Recommended supporting services:

- Redis on its own instance or managed service
- Mongo on its own instance or managed service
- TURN on its own host or dedicated service

This is the most realistic current target for the repo as documented today.

### 4. Larger production rollout

Use this when you want:

- many concurrent rooms
- sustained distributed media load
- stronger isolation between control plane and media plane
- room placement, drain, and recovery discipline

Recommended starting point per media node:

- 16+ vCPU
- 32+ GB RAM
- high network throughput
- dedicated monitoring
- careful room placement and node admission controls

Recommended architecture:

- multiple SFU nodes
- dedicated Redis
- dedicated Mongo
- dedicated TURN
- explicit ingress and routing policy
- observability and drain automation

Important: this repo is not yet honestly proven at this scale just because the architecture can describe it. Real soak, failure, and capacity evidence are still required.

## Network requirements

This repo is media-first, so networking is as important as CPU and RAM.

### Required

- public UDP reachability for ICE host candidates
- correct `ICE_ANNOUNCED_ADDRESS` or equivalent public/announced address handling
- open UDP range for `HOST_CANDIDATE_PORT_RANGE`
- open UDP range for `PIPE_PORT_RANGE` when distributed pipe transport is enabled
- working STUN/TURN configuration

### Important current reality

- TURN over UDP is the primary realistic expectation in the current repo
- TURN TCP/TLS should be treated as deployment validation work, not assumed truth
- announced IP correctness must be tested from outside the host network
- ingress must not break UDP media paths

### Do not rely on

- HTTP-only ingress as your media strategy
- localhost-style assumptions in production
- default cloud firewall rules
- "it worked locally" as proof of public ICE correctness

## Control-plane and data-plane expectations

The system needs more than one kind of server role once you move beyond local development.

### SFU application nodes

These run:

- Nest backend
- signaling
- room ownership logic
- media services
- worker mode where enabled

They need:

- CPU stability
- UDP reachability
- low event-loop delay
- enough headroom for packet processing and routing

### Redis

Redis is needed for:

- cluster coordination
- distributed ownership signaling
- cross-node eventing paths
- queue and control-plane flows

This should not be treated as an optional extra in distributed use.

### MongoDB

Mongo is needed for:

- durable backend state
- room/platform data
- audit/eventing persistence where enabled

For serious production use, Mongo should not live on the same tiny host as overloaded media traffic unless the load is very small.

### TURN

TURN is required for:

- restrictive client networks
- mobile and enterprise network compatibility
- honest production connectivity

If you want the system to work broadly on real networks, TURN is not optional.

## Recommended operating system and runtime

For production:

- Linux preferred
- Node.js version aligned with the repo toolchain
- stable Docker or container runtime if containerized
- kernel and firewall settings that allow the configured UDP ranges

For this repo specifically, production assumptions are much stronger on Linux than on a desktop development environment.

## Kubernetes or VM?

Both can work, but they are not equal in difficulty.

### VM or bare metal

Best when you want:

- simpler UDP exposure
- easier network debugging
- more predictable packet behavior
- faster bring-up for early production trials

### Kubernetes

Useful when you already have:

- a team that understands UDP exposure in Kubernetes
- node-level networking clarity
- drain and readiness discipline
- a clean plan for sticky signaling and room ownership

Kubernetes is fine, but it does not remove media complexity. It often makes early debugging harder if the team is still proving ICE, TURN, and distributed media behavior.

## What actually drives server size?

The biggest sizing drivers are:

- number of simultaneous publishers
- video bitrate
- number of subscribers per room
- simulcast or SVC usage
- TURN relay percentage
- cross-node forwarding frequency
- room churn
- pacing, retransmission, and congestion activity

A 100-user system is not defined just by user count. It depends heavily on:

- how many are sending video
- how many layers are active
- how much relaying goes through TURN
- whether rooms are mostly lecture-style or all-hands interactive

## Practical sizing guidance

If your use case is serious and you want room to grow, start here:

### Minimum serious pilot

- 1 SFU node
- 8 vCPU / 16 GB RAM
- external Redis
- external Mongo
- TURN available

### Better early production shape

- 2 SFU nodes
- each 8 to 16 vCPU / 16 to 32 GB RAM
- dedicated Redis
- dedicated Mongo
- dedicated TURN
- metrics, drain, and readiness wired

### Large-use ambition

If your goal is large-scale commercial usage, plan for:

- multiple SFU nodes from the beginning
- isolated state services
- real soak and failure testing
- public TURN validation
- node drain and room placement discipline
- capacity measurement before customer commitments

That is the path to becoming scalable. The repo can be the core of that path, but the proof comes from deployment evidence.

## What this repo can honestly claim today

Reasonable claim:

- custom SFU platform with serious transport, forwarding, distributed routing, operator tooling, and eventing foundations
- good candidate for controlled production use
- can be deployed locally, in single-node mode, and in controlled two-node distributed mode

Not yet an honest claim:

- battle-proven hyperscale fleet
- proven broad public-network behavior across all deployment shapes
- automatic parity with mature mediasoup or LiveKit fleets just because the features exist in code

## Pre-production checklist

Before calling the system production-ready for your own use case, validate:

- public ICE host candidate reachability
- TURN relay behavior
- announced IP correctness
- browser publish/subscribe over the real ingress path
- room join/leave churn
- drain and restart behavior
- metrics and readiness behavior under load
- distributed attach/release behavior
- long-running soak on your actual server class

## Bottom line

If you want to use this SFU seriously, do not think in terms of "a Node server."

Think in terms of:

- SFU media nodes
- Redis
- Mongo
- TURN
- UDP-aware networking
- honest soak and capacity validation

That is the server story this repo needs.

If your target is large scalable usage, the right next step is not "more theory." It is:

1. deploy on a real server class
2. measure rooms, publishers, subscribers, bitrate, CPU, memory, and packet health
3. increase node count and validate drain, ownership, and cross-node behavior
4. only then claim capacity
