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
- Verify `PUBLIC_URL`, `NODE_PUBLIC_URL`, `PIPE_ADVERTISE_IP`, and TURN public/announced addresses match the addresses remote browsers and peer nodes really use.
- Verify the frontend resolves the real backend origin in staging. Non-local frontend builds now default to same-origin `/api/v1` and `/sfu`; if the frontend is served from a different host than the backend ingress, override `/env.js` with `apiBaseUrl` and `socketUrl`.

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

The shipped ingress routes `/api` to the backend and `/` to the frontend. That same-origin path layout is what the production frontend expects by default. If your staging or production topology splits frontend and backend across different hosts, publish a custom `/env.js` with explicit runtime endpoints instead of rebuilding the Angular bundle with localhost defaults.

## Health, Readiness, and Shutdown

Public health routes live outside `/api/v1`:

- `GET /health/live`
- `GET /health/ready`
- `GET /health`
- `GET /health/db`
- `GET /health/redis`

Use `/health/live` for liveness and `/health/ready` for traffic admission. During planned maintenance:

1. Call `POST /api/v1/media/node/drain` with `X-Operations-Token`.
2. Wait for `/health/ready` to fail and for `/api/v1/media/diagnostics/node` to report `trafficReady=false`.
3. Allow existing sessions to wind down or migrate according to your rollout policy.
4. Send SIGTERM only after the node is drained.
5. Keep `terminationGracePeriodSeconds` long enough for drain plus external load-balancer deregistration.

Do not use a blind sleep as the primary shutdown mechanism. If you add a `preStop` hook, make it invoke the drain workflow and observe readiness withdrawal. The application still needs the actual shutdown signal so it can publish final cluster updates.

## Metrics and Diagnostics

- `/metrics` stays outside the API prefix for Prometheus scraping.
- When `OPERATIONS_TOKEN` is empty, `/metrics` can be scraped without extra headers.
- When `OPERATIONS_TOKEN` is configured, send it as `X-Operations-Token` for `/metrics` and `/api/v1/media/*` operator endpoints.
- Treat `/api/v1/media/*` diagnostics and drain routes as operator-only even though some health routes stay public for orchestrators.
- Keep Swagger disabled in production unless you have an explicit operational reason to expose it.

## Observability

Prometheus scrapes backend `/metrics`. Grafana provisions a starter dashboard with room, participant, RTP forwarding, pipe, worker, and cluster-health panels.
