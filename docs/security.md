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

Use Kubernetes secrets or an external secret manager for:

- `MONGODB_URI`
- `REDIS_URL`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `OPERATIONS_TOKEN`
- `TURN_SECRET`
- `PIPE_CLUSTER_SECRET`
- S3 credentials

`infra/k8s/secret.example.yaml` is a placeholder schema, not a deployable production secret. Copy the keys into your secret manager or a private manifest, replace every value, and keep the rendered secret out of version control.
