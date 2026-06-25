# Security

## Authentication

- Access and refresh tokens are JWTs with independent secrets.
- Refresh tokens carry token IDs and are revocable per user.
- REST endpoints use bearer-token guards.
- Socket.IO connections verify the access token during handshake.

## Authorization

- Room membership is checked before room snapshots are returned.
- Host-only actions include closing, locking, unlocking, and recording.
- Host/co-host actions include admitting, rejecting, permission updates, mute, kick, ban, and unban.
- Permission changes are persisted and broadcast immediately.
- Operational node and worker endpoints are protected separately from room roles through `X-Operations-Token`.

## Input Protection

- Global Nest validation strips unknown REST payload fields.
- Chat messages are length-limited in MongoDB schema.
- Helmet is enabled.
- CORS is restricted to configured frontend origins.
- Rate limiting is configured through `@nestjs/throttler`.

## Replay and Transport Protection

JWT expiry limits replay windows for REST and WebSocket connection setup. Media replay protection is enforced in the SRTP/SRTCP transport implementation with per-SSRC replay windows and rollover-aware sequence handling.

## Secrets

Use Kubernetes secrets or an external secret manager for production secrets. Production startup rejects missing, placeholder, too-short, or reused values for the required shared secrets, so generate each value independently and rotate them on separate schedules.

- `MONGODB_URI`
- `REDIS_URL`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `OPERATIONS_TOKEN`
- `TURN_SECRET`
- `WEBHOOK_SECRET_ENCRYPTION_KEY`
- `PIPE_CLUSTER_SECRET`
- S3 credentials

`infra/k8s/secret.example.yaml` is a placeholder schema, not a deployable production secret. Copy the keys into your secret manager or a private manifest, replace every value, and keep the rendered secret out of version control.

## Production Exposure Checklist

- Keep Swagger disabled in production with `SWAGGER_ENABLED=false`. If it is temporarily enabled for an operational reason, the docs route requires `X-Operations-Token`.
- Protect `/metrics`, `/api/v1/media/*` diagnostics/control routes, and `/api/v1/events/*` operator routes with `X-Operations-Token`.
- Keep public health probes limited to status-level readiness/liveness. Use operator-token diagnostics for node, worker, TURN, and incident detail.
- Set `CORS_ALLOWED_ORIGINS` to explicit `https://` frontend/admin origins. Wildcards, localhost, and path-bearing origins are rejected in production.
- Leave frontend `/env.js` empty for same-origin ingress, or set real production `apiBaseUrl` / `socketUrl` values for split-host deployments. Non-local browsers ignore accidental localhost runtime overrides.
- Keep class-session access checks enrollment-backed: unauthorized students must not read, watch, join, chat, load materials, or download recordings for another batch.
