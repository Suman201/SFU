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
- `room:get-quality`
- `room:get-quality-summary`
- `room:get-incident-state`
- `room:get-incident-timeline`
- `room:get-snapshot-history`
- `room:run-recovery-action`
- `room:update-media-profile`

## Transport Events

- `transport:create`
- `transport:ice-candidate`
- `transport:ice-restart`

## Producer Events

- `producer:create`
- `producer:pause`
- `producer:resume`
- `producer:close`
- `producer:get-layers`

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
- `room:owner-changed`
- `room:quality-updated`
- `room:quality-summary-updated`
- `room:incident-updated`
- `room:incident-event`
- `room:snapshot-generated`
- `participant:joined`
- `participant:left`
- `participant:updated`
- `participant:kicked`
- `participant:banned`
- `permissions:updated`
- `producer:created`
- `producer:updated`
- `producer:closed`
- `producer:layers-needed`
- `producer:layers-unneeded`
- `producer:dynacast-updated`
- `consumer:created`
- `consumer:updated`
- `consumer:closed`
- `room:failed`
- `chat:message`
- `network:quality`
- `waiting-room:pending`

## Operator/Host Notes

- `room:get-quality-summary` returns the same policy-aware summary used by the room host controls.
- `room:get-incident-state`, `room:get-incident-timeline`, and `room:get-snapshot-history` are moderator-only visibility surfaces used by the operator sidebar.
- Durable room audit history is intentionally exposed over REST at `GET /api/v1/rooms/:roomId/audit-log`; U3 did not add a parallel Socket.IO audit-log stream.
- `room:run-recovery-action` is owner-authoritative and returns the updated room plus current incident state.
- `room:update-media-profile` is owner-authoritative. Hosts and co-hosts can switch between `meeting`, `webinar`, `classroom`, and `support` without restarting the room.
- `room:update-media-profile` and other owner-authoritative control events can return `ROOM_REDIRECT` with `ownerUrl` when the caller is attached to a non-owner node.
- `room:quality-summary-updated` is broadcast when room quality, node pressure, worker pressure, or policy changes affect live autopilot decisions.
- `room:incident-updated` is broadcast whenever persisted recovery state, protections, or alert state changes.
- `room:incident-event` streams individual timeline events such as protection changes, snapshots, repeated throttles, and room failures.
- `room:snapshot-generated` streams new snapshot bundle summaries so operator views can update without polling.
- `producer:create` / `screen:start` may return a producer in `paused` state with `policyDecision` when the active room profile soft-throttles new publishing instead of rejecting it.
- `room:failed` surfaces worker-side room failures to the active room UI so operators and hosts can see the incident immediately.
