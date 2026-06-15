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

Returns time-limited Coturn REST credentials.

`GET /media/transport-capabilities`

Returns whether the native DTLS-SRTP transport adapter is installed.

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

- `GET /api/v1/health`
- `GET /metrics`
