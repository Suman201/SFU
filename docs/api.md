# REST API

Base URL: `/api/v1`

## Auth

`POST /auth/register`

```json
{
  "displayName": "Host",
  "email": "host@example.com",
  "password": "Password@12345"
}
```

`POST /auth/login`

```json
{
  "email": "host@example.com",
  "password": "Password@12345"
}
```

Both return:

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "expiresIn": "15m"
}
```

## Rooms

`GET /rooms/:roomId`

Returns the room snapshot for an authenticated active participant.

## Media

`GET /media/turn-credentials`

Requires bearer auth and returns time-limited Coturn REST credentials. The Angular WebRTC client consumes this endpoint before creating `RTCPeerConnection` so browser sessions use the configured TURN URIs instead of a hard-coded local ICE list. Production callers should expect UDP TURN URIs only in the current release candidate.

`GET /media/transport-capabilities`

Returns the current transport and forwarding readiness summary exposed to authenticated clients.

## Operational Endpoints

The following routes are operator-facing:

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Broad dependency and worker health summary. |
| `GET /health/live` | none | Liveness probe. |
| `GET /health/ready` | none | Traffic-admission readiness probe. |
| `GET /health/db` | none | MongoDB-only health probe. |
| `GET /health/redis` | none | Redis-only health probe. |
| `GET /metrics` | optional `X-Operations-Token` | Prometheus scrape endpoint; header becomes required when `OPERATIONS_TOKEN` is configured. |
| `GET /api/v1/media/statistics` | `X-Operations-Token` | Adaptive transport metrics snapshot. |
| `GET /api/v1/media/workers` | `X-Operations-Token` | Worker-pool status snapshot. |
| `GET /api/v1/media/pipe` | `X-Operations-Token` | Pipe coordination summary. |
| `GET /api/v1/media/diagnostics/node` | `X-Operations-Token` | Node-level drain/capacity/pipe diagnostics. |
| `GET /api/v1/media/diagnostics/workers/:workerId` | `X-Operations-Token` | Per-worker diagnostics. |
| `GET /api/v1/media/diagnostics/pipe` | `X-Operations-Token` | Pipe runtime diagnostics. |
| `POST /api/v1/media/workers/:workerId/drain` | `X-Operations-Token` | Drain a worker gracefully. |
| `POST /api/v1/media/node/drain` | `X-Operations-Token` | Drain the local node before maintenance. |
| `POST /api/v1/media/node/undrain` | `X-Operations-Token` | Resume local admission after maintenance. |

Operational notes:

- `/health/*` stays outside `/api/v1` so orchestrators can probe liveness and readiness without the room-auth stack.
- `/api/v1/media/*` diagnostics and drain routes are operator-only and should not be exposed through end-user clients.

## Recordings

`POST /recordings/start`

```json
{
  "roomId": "room-id",
  "scope": "room"
}
```

`POST /recordings/:recordingId/stop`

Stops a recording owned by the room host.

`GET /recordings/rooms/:roomId`

Lists room recordings for the host.

## Health and Metrics

- `GET /health`
- `GET /health/live`
- `GET /health/ready`
- `GET /health/db`
- `GET /health/redis`
- `GET /metrics`
