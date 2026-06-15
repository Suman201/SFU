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

## Input Protection

- Global Nest validation strips unknown REST payload fields.
- Chat messages are length-limited in MongoDB schema.
- Helmet is enabled.
- CORS is restricted to configured frontend origins.
- Rate limiting is configured through `@nestjs/throttler`.

## Replay and Transport Protection

JWT expiry limits replay windows for REST and WebSocket connection setup. Media replay protection belongs in the SRTP implementation and must include per-SSRC rollover counters and replay windows before browser media is accepted.

## Secrets

Use Kubernetes secrets or an external secret manager for:

- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `TURN_SECRET`
- S3 credentials

Never deploy the example Coturn secret.
