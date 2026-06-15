# WebSocket API

Namespace: `/sfu`

Authentication: pass a JWT access token in Socket.IO auth:

```ts
io('http://localhost:3000/sfu', {
  auth: { token: accessToken },
  transports: ['websocket']
});
```

All client events use acknowledgement callbacks:

```ts
socket.emit('room:create', payload, (response) => {
  if (response.ok) {
    console.log(response.data);
  }
});
```

## Room Events

- `room:create`
- `room:join`
- `room:leave`
- `room:close`
- `room:lock`
- `room:unlock`
- `room:admit`
- `room:reject`

## Transport Events

- `transport:create`
- `transport:ice-candidate`
- `transport:ice-restart`

## Producer Events

- `producer:create`
- `producer:pause`
- `producer:resume`
- `producer:close`

## Consumer Events

- `consumer:create`
- `consumer:pause`
- `consumer:resume`
- `consumer:close`

## Moderation and Permissions

- `permission:update`
- `participant:kick`
- `participant:ban`
- `participant:unban`
- `participant:mute`

## Screen, Chat, Hand Raise

- `screen:start`
- `screen:stop`
- `chat:send`
- `hand:raise`

## Server Events

- `room:updated`
- `room:closed`
- `participant:joined`
- `participant:left`
- `participant:updated`
- `participant:kicked`
- `participant:banned`
- `permissions:updated`
- `producer:created`
- `producer:updated`
- `producer:closed`
- `consumer:created`
- `consumer:updated`
- `consumer:closed`
- `chat:message`
- `network:quality`
- `waiting-room:pending`
