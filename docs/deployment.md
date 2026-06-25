# Deployment

## Local Docker

```bash
cp .env.example .env
npm run docker:up
```

Services:

- Frontend: `http://localhost:4200`
- Backend: `http://localhost:3000/api/v1`
- Swagger: `http://localhost:3000/api/docs`
- Metrics: `http://localhost:3000/metrics`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001`

## Local Two-Node Proof Stack

Use the dedicated multi-node compose file when you need a repeatable local proof for owner routing, Redis-backed room ownership, pipe-enabled remote publisher/subscriber flows, drain behavior, and soak cleanup:

```bash
npm run docker:start:multi-node
npm run seed:dummy-users:multi-node
npm run test:live-soak:local
npm run docker:down:multi-node
```

What it starts:

- MongoDB on host `127.0.0.1:27018`
- Redis on host `127.0.0.1:6379`
- Backend node A on `http://127.0.0.1:3000`
- Backend node B on `http://127.0.0.1:3002`
- Distinct host candidate UDP ranges: `40000-40020` and `40021-40040`
- Distinct pipe UDP ranges: `41000-41020` and `41021-41040`

The local proof stack sets `ENABLE_PIPE_TRANSPORT=true`, `MEDIA_WORKER_MODE=worker`, stable compose node IDs, and a local-only operations token. It is intentionally a local proof harness, not a production secret template. The soak report is written to `reports/live-soak/` and should be attached to any local scale signoff.

This proof does not replace staging validation for public TURN, public ICE candidate reachability, shared ingress stickiness, or Kubernetes UDP media exposure.

## Kubernetes

```bash
kubectl apply -f infra/k8s/namespace.yaml
# first create a private Secret manifest or external secret from infra/k8s/secret.example.yaml
# after replacing every placeholder value, then apply that private manifest here
kubectl apply -f infra/k8s/configmap.yaml
kubectl apply -f infra/k8s/backend.yaml
kubectl apply -f infra/k8s/frontend.yaml
kubectl apply -f infra/k8s/hpa.yaml
kubectl apply -f infra/k8s/ingress.yaml
```

The Kubernetes manifests are a control-plane baseline, not a complete media-plane deployment. Before declaring production readiness:

- Replace `secret.example.yaml` with real secrets and move credentialed `MONGODB_URI` / `REDIS_URL` out of ConfigMaps.
- Expose the full configured UDP ranges for `HOST_CANDIDATE_PORT_RANGE` and `PIPE_PORT_RANGE`. A single UDP service port is not enough for a real SFU workload.
- Configure sticky Socket.IO routing or an equivalent owner-aware ingress strategy.
- Deploy Coturn externally or fully wire Coturn with public IP, TLS, `TURN_SECRET`, `TURN_REALM`, and the advertised TURN URIs.
- Keep `ENABLE_PIPE_TRANSPORT=false` until the environment has been explicitly validated for distributed media.
- Verify `PUBLIC_URL`, `NODE_PUBLIC_URL`, `PIPE_ADVERTISE_IP`, `ICE_STUN_SERVERS`, `ICE_TURN_SERVERS`, `ICE_ANNOUNCED_ADDRESS`, and TURN public/announced addresses match the addresses remote browsers and peer nodes really use.
- Verify the frontend resolves the real backend origin in staging. Non-local frontend builds now default to same-origin `/api/v1` and `/sfu`; if the frontend is served from a different host than the backend ingress, override `/env.js` with `apiBaseUrl` and `socketUrl`.
- Set `CORS_ALLOWED_ORIGINS` to explicit `https://` browser origins. Production validation rejects wildcards, localhost origins, and origin values with paths or query strings.
- Store `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `TURN_SECRET`, `OPERATIONS_TOKEN`, `WEBHOOK_SECRET_ENCRYPTION_KEY`, and optional pipe/S3 secrets outside version control. Production validation rejects known placeholders and reused shared-secret values.

### Server-Side Runtime Config

Treat these values as the minimum deployment-facing config surface that must be correct before any staged signoff means much:

| Key | What it must describe | How to verify it at runtime |
| --- | --- | --- |
| `PUBLIC_URL` | The shared control-plane URL operators and clients are meant to reach. In production it must not be localhost or a wildcard address. | `GET /api/v1/media/diagnostics/node` -> `addressing.publicUrl` |
| `NODE_PUBLIC_URL` | The externally reachable URL for this specific node. In single-host staging it may match `PUBLIC_URL`; in multi-node staging it should identify the real node entrypoint. | `GET /api/v1/media/diagnostics/node` -> `addressing.nodePublicUrl` |
| `TURN_URIS` | Comma-separated public TURN URIs returned by `GET /api/v1/media/turn-credentials`. Current RC support is UDP TURN only. | `GET /api/v1/media/diagnostics/node` -> `turn.*`; staged browser proof via `npm run test:browser:staging-turn` |
| `ICE_STUN_SERVERS` | Optional comma-separated STUN servers used by the SFU itself to gather server-reflexive candidates. Keep them on UDP and point them at real reachable infrastructure. | `GET /api/v1/media/diagnostics/node` -> `ice.stun*` |
| `ICE_TURN_SERVERS` | Optional comma-separated TURN URIs used by the SFU itself to gather relay candidates. Current RC support is UDP `turn:` only and the backend derives shared-secret credentials from `TURN_SECRET`. | `GET /api/v1/media/diagnostics/node` -> `ice.turn*` |
| `ICE_ANNOUNCED_ADDRESS` | Optional host-candidate public address rewrite for the SFU media plane. Use it when the node binds privately but must advertise a different public host candidate. | `GET /api/v1/media/diagnostics/node` -> `ice.announcedAddress`, `ice.hostCandidateMode` |
| `OPERATIONS_TOKEN` | Operator credential for `/metrics`, `/api/v1/media/*`, and `/api/v1/events/*` control routes. Production requires a non-empty value. | `npm run test:staging:preflight` checks token enforcement |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | Dedicated encryption key for webhook signing secrets at rest. Production should not rely on the JWT fallback for this. | Boot-time config validation plus create/list/replay smoke through `/api/v1/events/*` |
| `CORS_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the API. Production values must be explicit `https://` origins, never wildcard or localhost. | Boot-time config validation and browser preflight from the deployed frontend/admin origins |
| `WEBHOOK_DELIVERY_CONCURRENCY` / `WEBHOOK_DELIVERY_MAX_BATCH_PER_PUMP` / `WEBHOOK_DELIVERY_MAX_CONCURRENT_PER_ENDPOINT` | Backlog throughput and fairness knobs for the shared event delivery pump that now serves both webhook and Redis stream adapters. Keep max batch >= concurrency and per-endpoint concurrency <= total concurrency. | `GET /api/v1/events/diagnostics/summary` -> `dispatch.*`, `deliveryCountsByAdapter`, and backlog behavior under load |
| `EVENT_LOG_RETENTION_DAYS` / `WEBHOOK_DELIVERY_RETENTION_DAYS` / `WEBHOOK_EXHAUSTED_DELIVERY_RETENTION_DAYS` | Policy-driven retention windows for audit events, normal delivery history, and dead-letter history. | `GET /api/v1/events/diagnostics/summary` -> `retention.*` |
| `PIPE_ADVERTISE_IP` | Stable inter-node address other SFU nodes actually dial when `ENABLE_PIPE_TRANSPORT=true`. It must not be localhost or a pod-only address. | `GET /api/v1/media/diagnostics/node` -> `addressing.pipeAdvertiseIp` and pipe health |
| `METRICS_PATH` | Optional extra scrape alias when an environment needs a non-default metrics path. | Probe the configured alias if you use one; `/metrics` remains the canonical endpoint |

The node diagnostics endpoint is the most honest runtime source for this surface. It shows what the process actually booted with, not just what the manifest intended to set.

### Kubernetes UDP Media Plane

The provided manifests intentionally stop at HTTP readiness and control-plane wiring. For real media traffic you must choose one of these operator-owned exposure models:

1. `hostNetwork: true`
   - Simplest path for fixed-node clusters.
   - Backend binds directly on the node IP for the full UDP media range.
   - Requires node-level port ownership and tighter scheduling discipline.
2. `NodePort` or direct node UDP exposure
   - Works when you can reserve the entire `HOST_CANDIDATE_PORT_RANGE` and, if enabled, `PIPE_PORT_RANGE` on every node.
   - Requires announced/public node addressing to stay stable.
3. UDP `LoadBalancer`
   - Viable only when the platform preserves large UDP port ranges and stable backend affinity.
   - Many managed L4 products are a poor fit for WebRTC media unless validated carefully.

Minimum production expectation:

- Expose every UDP port in `HOST_CANDIDATE_PORT_RANGE`.
- If `ENABLE_PIPE_TRANSPORT=true`, expose every UDP port in `PIPE_PORT_RANGE` between nodes.
- Keep the HTTP service separate from media-plane exposure so readiness and ingress policy do not hide UDP failures.
- Align `PUBLIC_URL`, `NODE_PUBLIC_URL`, Coturn public IP, and any external DNS names with the addresses browsers and peer nodes actually reach.
- Treat pod IPs, localhost, and private RFC1918 addresses as invalid TURN/browser-facing candidates unless clients are inside that same network boundary.

The current release candidate validates UDP media transport. TURN-over-TCP/TLS is documented as unsupported and must not be advertised in production config. Publish only UDP TURN URIs to clients until TCP/TLS support is explicitly released.

### Ingress and Session Ownership

HTTP ingress is part of the control plane only. For stable signaling and media ownership:

- Keep Socket.IO upgrades sticky to the same backend for the lifetime of the session, or route requests through an owner-aware layer that can consistently reach the node holding the room transports.
- Do not assume ordinary round-robin HTTP ingress is enough for multi-node admission, reconnect, or host-control workflows.
- Keep media UDP exposure outside the HTTP ingress path; L7 ingress readiness does not prove the media plane is reachable.
- When running more than one backend replica, validate reconnect, host handoff, and node-drain behavior through the real ingress path before calling the deployment GA-ready.

For the checked-in staged signoff path, use direct per-node URLs for `NODE_A_URL` and `NODE_B_URL` during the server-side preflight, then use the shared ingress hostname for `STAGING_BASE_URL` during the browser TURN proof. That split is intentional: it lets the preflight catch per-node config mistakes while the browser step uses the same public hostname real clients use.

The shipped ingress routes `/api` to the backend and `/` to the frontend. That same-origin path layout is what the production frontend expects by default. If your staging or production topology splits frontend and backend across different hosts, publish a custom `/env.js` with explicit runtime endpoints instead of rebuilding the Angular bundle with localhost defaults.

## Health, Readiness, and Shutdown

Public health routes live outside `/api/v1`:

- `GET /health/live`
- `GET /health/ready`
- `GET /health`
- `GET /health/db`
- `GET /health/redis`

Use `/health/live` for liveness and `/health/ready` for traffic admission. These routes intentionally expose only status-level probe data; use `X-Operations-Token` with media diagnostics for full node, worker, TURN, and incident detail. During planned maintenance:

1. Call `POST /api/v1/media/node/drain` with `X-Operations-Token`.
2. Wait for `/health/ready` to fail and for `/api/v1/media/diagnostics/node` to report `trafficReady=false`.
3. Allow existing sessions to wind down or migrate according to your rollout policy.
4. Send SIGTERM only after the node is drained.
5. Keep `terminationGracePeriodSeconds` long enough for drain plus external load-balancer deregistration.

Do not use a blind sleep as the primary shutdown mechanism. If you add a `preStop` hook, make it invoke the drain workflow and observe readiness withdrawal. The application still needs the actual shutdown signal so it can publish final cluster updates.

## Metrics and Diagnostics

- `/metrics` stays outside the API prefix for Prometheus scraping.
- If `METRICS_PATH` is set to a non-default value, the server also exposes that alias outside the API prefix. Keep `/metrics` as the canonical path in docs, dashboards, and operator habits unless the environment has a strong reason to prefer the alias.
- Development can leave `OPERATIONS_TOKEN` empty; production requires it.
- Send `X-Operations-Token` for `/metrics`, any configured metrics alias, Swagger if temporarily enabled in production, and `/api/v1/media/*` / `/api/v1/events/*` operator endpoints.
- Treat `/api/v1/media/*` diagnostics and drain routes as operator-only even though some health routes stay public for orchestrators.
- `GET /api/v1/media/diagnostics/node` is the main runtime truth source for staged rollout checks. Use it to confirm `trafficReady`, derived rollout alerts, TURN URI hygiene, public URL shape, and pipe advertise IP shape before blaming browsers or ingress.
- `GET /api/v1/events/diagnostics/summary` is the runtime truth source for eventing backlog fairness, per-adapter skew, dispatch concurrency, lease expiry, backlog aging, hottest-lane concentration, and frozen snapshot mix.
- Keep Swagger disabled in production unless you have an explicit operational reason to expose it.

## Observability

Prometheus scrapes backend `/metrics`. Grafana provisions a starter dashboard with room, participant, RTP forwarding, pipe, worker, and cluster-health panels.
