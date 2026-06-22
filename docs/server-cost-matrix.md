# Server Cost Matrix

This document is the cost companion to [docs/server-requirements.md](./server-requirements.md).

It answers a practical question:

"What does it roughly cost to run this SFU on real infrastructure?"

This is a budgeting guide, not a capacity guarantee.

## Scope and honesty

These numbers are intended for:

- local-to-production planning
- internal budgeting
- pilot sizing
- early production decision-making

These numbers do **not** prove:

- how many concurrent users a given node can carry
- that a provider will behave equally well for UDP media
- that a price point is enough for your exact workload

For this SFU, real capacity still depends on:

- number of active publishers
- video bitrate
- simulcast or SVC usage
- TURN relay percentage
- subscriber fanout per room
- cross-node media activity

## Pricing date

This document reflects provider pricing checked on **2026-06-22**.

Cloud pricing changes. Recheck before purchasing.

## What is included in these estimates

The estimates below assume:

- SFU application nodes
- MongoDB
- Redis-compatible cache
- TURN

They do **not** include:

- CDN
- object storage
- backup retention
- log platform costs
- on-call / ops costs
- engineering time

## Recommended planning tiers

### Tier 1: Serious pilot

Use when you want:

- a real internal pilot
- a small customer trial
- honest browser media validation

Shape:

- 1 SFU node
- 1 small Mongo instance
- 1 small Redis-compatible cache
- 1 small TURN node

### Tier 2: Controlled two-node deployment

Use when you want:

- owner and non-owner node behavior
- distributed attach and release validation
- room drain and routing confidence

Shape:

- 2 SFU nodes
- Mongo
- Redis-compatible cache
- TURN

### Tier 3: Safer early production

Use when you want:

- more headroom
- cleaner distributed trials
- more honest pre-scale production use

Shape:

- 2 larger SFU nodes
- Mongo
- Redis-compatible cache
- TURN

## Provider cost matrix

### DigitalOcean reference pricing

Official source:

- [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing/droplets)
- [DigitalOcean Managed Databases pricing](https://www.digitalocean.com/pricing/managed-databases)

Relevant current public prices:

- Basic `4 vCPU / 8 GB`: **USD 48/mo**
- CPU-Optimized `4 vCPU / 8 GB`: **USD 84/mo**
- CPU-Optimized `8 vCPU / 16 GB`: **USD 168/mo**
- Managed MongoDB `1 vCPU / 1 GB`: **USD 15.23/mo**
- Managed Valkey-compatible cache `1 vCPU / 1 GB`: **USD 15/mo**

Practical budgeting for this repo:

| Tier | Shape | Approx monthly cost |
| --- | --- | --- |
| Tier 1 | `1 x 4 vCPU / 8 GB SFU` + Mongo + Valkey + small TURN | `USD 120-130` |
| Tier 2 | `2 x 4 vCPU / 8 GB SFU` + Mongo + Valkey + small TURN | `USD 205-215` |
| Tier 3 | `2 x 8 vCPU / 16 GB SFU` + Mongo + Valkey + small TURN | `USD 370-390` |

Notes:

- For media nodes, the CPU-optimized line is a better fit than the cheapest shared compute.
- TURN can be a tiny extra node at first, but its bandwidth bill may become more important than its VM cost.

### AWS Lightsail reference pricing

Official source:

- [AWS Lightsail pricing](https://aws.amazon.com/lightsail/pricing/)

Relevant current public prices:

- Compute Optimized `4 GB / 2 vCPU`: **USD 42/mo**
- Compute Optimized `8 GB / 4 vCPU`: **USD 84/mo**
- Compute Optimized `16 GB / 8 vCPU`: **USD 168/mo**

Practical budgeting for this repo:

| Tier | Shape | Approx monthly cost |
| --- | --- | --- |
| Tier 1 | `1 x 4 vCPU / 8 GB class SFU` + small data services + TURN | `USD 130-180` |
| Tier 2 | `2 x 4 vCPU / 8 GB class SFU` + small data services + TURN | `USD 220-320` |
| Tier 3 | `2 x 8 vCPU / 16 GB class SFU` + small data services + TURN | `USD 400-550` |

Notes:

- AWS can absolutely run this well, but the total cost usually rises once we add real networking, managed services, and operational extras.
- The range is wider because AWS deployment shape varies more quickly than the sticker price of a single VM.

### Hetzner planning guidance

Official source:

- [Hetzner Cloud](https://www.hetzner.com/cloud)
- [Hetzner General Purpose Cloud](https://www.hetzner.com/cloud/general-purpose)

What the official pages clearly confirm:

- shared plans are for lower and more variable workloads
- dedicated vCPU plans are the right class for sustained business workloads
- dedicated plans are intended for high-traffic applications

For this SFU, if using Hetzner:

- avoid the cheapest shared cloud plans for serious media use
- prefer dedicated-vCPU general-purpose or stronger instances
- verify current monthly price in the Hetzner calculator at purchase time

Practical expectation:

- Hetzner is often cheaper than AWS for raw compute
- it can be attractive for cost-sensitive early production
- you still need to prove public UDP, TURN, announced IP, and real browser behavior in your exact region and topology

Because the public Hetzner pages exposed to our crawler did not return stable numeric pricing fields, this document treats Hetzner as a provider to validate manually before committing a budget.

## Cheapest honest setup

If you want the smallest setup I would still take seriously for this repo:

- 1 SFU node: `4 vCPU / 8 GB`
- small Mongo
- small Redis-compatible cache
- small TURN

Budget:

- roughly **USD 120-180/month**

This is not "large scale." It is the floor for a real pilot.

## Better early production setup

If you want something that feels much less fragile:

- 2 SFU nodes
- each `4 vCPU / 8 GB` minimum
- Mongo
- Redis-compatible cache
- TURN

Budget:

- roughly **USD 220-320/month**

This is the first shape where distributed behavior starts to be worth validating seriously.

## Safer serious setup

If your intent is meaningful real usage, not just a demo:

- 2 SFU nodes
- each `8 vCPU / 16 GB`
- Mongo
- Redis-compatible cache
- TURN
- metrics and logs

Budget:

- roughly **USD 370-550/month**

That still does not make it "LiveKit scale." It simply gives you a healthier production starting point.

## Hidden costs people underestimate

### 1. TURN traffic

TURN is often cheap as a VM and expensive as bandwidth.

If many clients relay through TURN, the network bill can grow faster than compute.

### 2. Egress

Video egress can dominate cost once rooms get larger.

The SFU itself may look affordable while traffic becomes the real bill.

### 3. Observability

Metrics are cheap.
Logs, traces, and long retention are not always cheap.

### 4. Operational headroom

Running a node at the edge of CPU or network saturation is not a savings strategy. It is a failure strategy.

## What to budget by stage

### Internal product validation

Budget:

- **USD 120-180/month**

### Small real pilot

Budget:

- **USD 220-320/month**

### Safer pre-production

Budget:

- **USD 370-550/month**

### Large-use ambition

Budget:

- start at **USD 500+/month**
- assume bandwidth and validation effort will matter more than just node rent

## What this repo can honestly support from a cost-planning view

Today, a reasonable planning statement is:

- you can budget and deploy it for controlled real usage
- you can validate it on single-node and two-node shapes
- you should not promise large-scale fleet economics before real soak and traffic evidence

## Bottom line

If you want the simplest honest answer:

- **cheap real pilot:** about `USD 150/month`
- **controlled two-node deployment:** about `USD 250/month`
- **safer serious starting point:** about `USD 400/month`

That is the right mental model for this repo today.
