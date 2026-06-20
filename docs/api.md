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
  "expiresIn": "15m",
  "user": {
    "id": "user-id",
    "name": "User Name",
    "email": "user@example.com",
    "role": "teacher"
  }
}
```

## Teacher Batches

All teacher batch endpoints require bearer auth for a `TEACHER` role user. The backend derives `teacherId` from the access token and never accepts it from the request body.

The feature persists data in MongoDB collections named `batches` and `batch_schedules`. Batch IDs and schedule IDs are UUID strings. Batch creation and schedule replacement use a Mongo session transaction when the deployment supports transactions; local standalone Mongo falls back to ordered writes for developer convenience.

`POST /teacher/batches`

Creates a calendar-year batch. `startDate` is always January 1 of `year`; `endDate` is always December 31 of `year`.

```json
{
  "name": "Laravel Morning Batch 2026",
  "courseId": "course_uuid",
  "courseName": "Laravel",
  "year": 2026,
  "maxCapacity": 30,
  "schedule": [
    {
      "dayOfWeek": "MONDAY",
      "startTime": "10:00"
    },
    {
      "dayOfWeek": "WEDNESDAY",
      "startTime": "14:00"
    }
  ]
}
```

Validation rules:

- `name`, `year`, `maxCapacity`, and `schedule` are required.
- `maxCapacity` must be greater than zero.
- `schedule` must include at least one weekday.
- `startTime` must use `HH:mm` 24-hour time.
- Duplicate `dayOfWeek` values are rejected.
- A teacher cannot create two active batches with the same `name` and `year`.

`GET /teacher/batches`

Lists only the logged-in teacher's non-deleted batches. Each item includes `id`, `name`, optional course fields, `year`, `startDate`, `endDate`, `maxCapacity`, `enrolledCount`, `status`, `schedule`, and timestamps. `enrolledCount` is currently `0` until enrollment persistence is added.

`GET /teacher/batches/:id`

Returns one batch owned by the logged-in teacher. Batches owned by another teacher return `404`.

`PATCH /teacher/batches/:id`

Updates batch details and optionally replaces the schedule. The backend still derives ownership from the token, recomputes the date range if `year` changes, rejects duplicate weekdays, and prevents `maxCapacity` from dropping below the enrolled student count once enrollment persistence exists.

`PATCH /teacher/batches/:id/status`

```json
{
  "status": "ACTIVE"
}
```

Supported statuses are `ACTIVE`, `INACTIVE`, `COMPLETED`, and `CANCELLED`.

`DELETE /teacher/batches/:id`

Soft deletes a batch owned by the logged-in teacher and marks it `CANCELLED`.

## Rooms

`GET /rooms/:roomId`

Returns the room snapshot for an authenticated active participant.

`GET /rooms/:roomId/quality`

Returns the raw room quality state for an authenticated active participant.

`GET /rooms/:roomId/quality-summary`

Returns the policy-aware room quality summary used by host controls and operator workflows. The payload includes:

- room health: `stable`, `degraded`, or `critical`
- active room media profile: `meeting`, `webinar`, `classroom`, or `support`
- join / publish / screen-share protection state: `allow`, `warn`, `soft-throttle`, or `reject`
- degraded consumer / producer / transport counts
- bitrate rollups and recommendation list

`GET /rooms/:roomId/incident-state`

Returns the current operator-facing incident state for a host or co-host participant, including:

- status: `stable`, `degraded`, `critical`, `recovering`, or `failed`
- manual protection state
- active recovery state
- active alerts
- workflow recommendations
- snapshot counters

`GET /rooms/:roomId/incident-timeline`

Returns the recent incident event timeline for a host or co-host participant.

`GET /rooms/:roomId/snapshot-history`

Returns recent room snapshot bundle summaries for a host or co-host participant.

`GET /rooms/:roomId/audit-log`

Returns the persisted room-scoped platform event history for a host or co-host participant. This is the broader structured audit log, not the incident-only timeline.

Supported query parameters:

- `eventTypes=producer.created,producer.closed`
- `actorUserId=<userId>`
- `actorParticipantId=<participantId>`
- `from=<ISO timestamp>`
- `to=<ISO timestamp>`
- `limit=<1-200>`

`PATCH /rooms/:roomId/media-profile`

Requires bearer auth for an active host or co-host participant in the room.

```json
{
  "profileId": "webinar"
}
```

Applies the new room media profile immediately to live producer / consumer policy.
If the participant is attached to a non-owner node, the Socket.IO path returns a `ROOM_REDIRECT` payload with `ownerUrl` so the frontend can reconnect to the room owner before retrying the change.

`PATCH /rooms/:roomId/recovery`

Requires bearer auth for an active host or co-host participant in the room.

```json
{
  "action": "protect_room",
  "reason": "Protect while we stabilize transport loss"
}
```

Runs an operator recovery action such as:

- `protect_room`
- `unprotect_room`
- `reopen_admissions`
- `pause_new_publishing`
- `resume_new_publishing`
- `force_incident_snapshot`
- `mark_operator_recovery`
- `clear_recovery`

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
| `GET /api/v1/media/diagnostics/rooms/:roomId/incident-snapshot` | `X-Operations-Token` | Room-scoped incident export with profile, protections, degraded entities, and transport summaries. |
| `GET /api/v1/media/diagnostics/rooms/:roomId/incident-state` | `X-Operations-Token` | Current operator incident state without room-participant auth. |
| `GET /api/v1/media/diagnostics/rooms/:roomId/incident-timeline` | `X-Operations-Token` | Persisted incident timeline for the room. |
| `GET /api/v1/media/diagnostics/rooms/:roomId/snapshot-history` | `X-Operations-Token` | Recent incident snapshot bundle summaries. |
| `GET /api/v1/media/diagnostics/rooms/snapshot-bundles/:bundleId` | `X-Operations-Token` | Full incident snapshot bundle payload by bundle id. |
| `POST /api/v1/media/diagnostics/rooms/:roomId/incident-snapshot` | `X-Operations-Token` | Manually generate and persist a room incident snapshot bundle. |
| `POST /api/v1/media/diagnostics/rooms/:roomId/fail` | `X-Operations-Token` | Non-production diagnostics hook that injects a real room-failure event for validation and operator-flow testing. |
| `GET /api/v1/media/diagnostics/transports/:transportId/incident-snapshot` | `X-Operations-Token` | Transport-scoped incident export with room policy and related producer / consumer context. |
| `POST /api/v1/media/workers/:workerId/drain` | `X-Operations-Token` | Drain a worker gracefully. |
| `POST /api/v1/media/node/drain` | `X-Operations-Token` | Drain the local node before maintenance. |
| `POST /api/v1/media/node/undrain` | `X-Operations-Token` | Resume local admission after maintenance. |
| `POST /api/v1/events/webhooks` | `X-Operations-Token` | Create a signed webhook endpoint and return the secret once. |
| `GET /api/v1/events/webhooks` | `X-Operations-Token` | List webhook endpoints with health state and last-delivery summary. |
| `GET /api/v1/events/webhooks/:endpointId` | `X-Operations-Token` | Inspect one webhook endpoint. |
| `PATCH /api/v1/events/webhooks/:endpointId` | `X-Operations-Token` | Update endpoint URL, subscriptions, filters, timeouts, retry policy, or enabled state. |
| `POST /api/v1/events/webhooks/:endpointId/rotate-secret` | `X-Operations-Token` | Rotate the webhook signing secret and return the new secret once. |
| `GET /api/v1/events/log` | `X-Operations-Token` | Global platform event log query surface. |
| `GET /api/v1/events/rooms/:roomId/log` | `X-Operations-Token` | Room-scoped platform event log query surface. |
| `GET /api/v1/events/deliveries` | `X-Operations-Token` | Delivery history with endpoint, event, status, and time filters. |
| `GET /api/v1/events/deliveries/exhausted` | `X-Operations-Token` | Exhausted / dead-letter delivery queue view. |
| `GET /api/v1/events/deliveries/:deliveryId` | `X-Operations-Token` | One delivery record with attempt history. |
| `POST /api/v1/events/deliveries/:deliveryId/replay` | `X-Operations-Token` | Replay a failed delivery through the real queue and signer path. |
| `POST /api/v1/events/log/:eventId/endpoints/:endpointId/replay` | `X-Operations-Token` | Replay a specific event to a specific endpoint through the real queue and signer path. |
| `GET /api/v1/events/diagnostics/summary` | `X-Operations-Token` | Eventing / webhook backlog and unhealthy-endpoint summary. |

Operational notes:

- `/health/*` stays outside `/api/v1` so orchestrators can probe liveness and readiness without the room-auth stack.
- `/api/v1/media/*` diagnostics and drain routes are operator-only and should not be exposed through end-user clients.
- `/api/v1/events/*` is the operator eventing surface for audit queries, webhook management, delivery replay, and delivery diagnostics.
- Incident snapshot exports are JSON payloads intended for download, ticket attachment, or copy/paste into operational tooling. They are not public room APIs.
- `POST /api/v1/media/diagnostics/rooms/:roomId/fail` is disabled in production and exists only to drive truthful local or pre-production browser validation through the real room-failure path.

Webhook delivery notes:

- Payloads are signed as `sha256=<hex>` in `X-Native-Sfu-Signature`.
- The signature input is `${timestamp}.${rawJsonBody}` where the timestamp is sent in `X-Native-Sfu-Timestamp`.
- Every delivery includes:
  - `X-Native-Sfu-Delivery-Id`
  - `X-Native-Sfu-Event-Id`
  - `X-Native-Sfu-Event-Type`
  - `X-Native-Sfu-Timestamp`
  - `X-Native-Sfu-Signature`
- Non-2xx responses, timeouts, and transport errors are treated as failures.
- Failed deliveries retry with bounded exponential backoff until they reach `exhausted`.
- Replay routes enqueue a fresh delivery record and reuse the real delivery pipeline rather than shortcutting the HTTP send.

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

Recording eventing notes:

- Starting a recording emits `recording.started`.
- Stopping a recording emits `recording.stopped`.
- `recording.failed` is reserved for a future recording failure path; the current recording surface does not yet synthesize failure states.

## Health and Metrics

- `GET /health`
- `GET /health/live`
- `GET /health/ready`
- `GET /health/db`
- `GET /health/redis`
- `GET /metrics`
