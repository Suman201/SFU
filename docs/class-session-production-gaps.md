# Class Session Production Gaps

This document captures the current production gaps in the class session flow after the manual lifecycle, media, moderation, and private chat work.

## Recommended Fix Order

1. Lock down class-session authorization with real student enrollment or roster checks.
2. Make manual lifecycle safe across teacher disconnects and reconnects.
3. Add realtime, persisted whiteboard collaboration tied to the session channel.
4. Harden private chat with read state, thread summaries, multi-socket delivery, and cluster-safe targeted events.
5. Improve socket auth, reconnect, ack timeouts, and long-session resilience.

## P0: Authorization And Access Control

### Gap

Any authenticated student can currently read or join class-session metadata if they know the batch/session IDs.

The current batch read guard allows any `STUDENT` role. Room join entitlements also treat any non-teacher/admin user as a class-session participant.

### Risk

Students may join sessions for batches they are not enrolled in, see class metadata, receive lifecycle events, access chat history, and publish media.

### Needed Fix

- Add or wire a batch enrollment/roster model.
- Validate student enrollment in:
  - `GET /class-sessions/batches/:batchId/current`
  - `GET /class-sessions/:sessionId`
  - `POST /class-sessions/:sessionId/join`
  - `GET /class-sessions/:sessionId/chat`
  - Socket `room:join` for class-session rooms
  - Socket `session:watch`
- Keep teacher/admin checks as-is, but require teacher ownership or admin role.
- Add tests proving unauthorized students cannot read, watch, join, chat, or load history.

### Code Areas

- `apps/backend/src/class-sessions/class-sessions.service.ts`
- `apps/backend/src/rooms/rooms.service.ts`
- `apps/backend/src/rooms/rooms.gateway.ts`

## P0: Teacher Disconnect Must Not Auto-End Media Room

### Gap

Socket disconnect calls `leaveRoomForSocket`. If the disconnecting participant is the host, `leaveRoom` can close the room. For a class session, a teacher network drop can close the live media room even though the class session status remains `live`.

### Risk

A temporary teacher disconnect can kick students out, close producers/consumers, and leave backend session state inconsistent.

### Needed Fix

- Class-session rooms should close only from the manual End Session action.
- Add reconnect grace for teacher socket disconnects.
- Mark teacher temporarily offline without closing the room.
- Keep students in waiting/reconnecting state if teacher disconnects briefly.
- Close the room only when:
  - Teacher manually ends the session, or
  - An explicit admin/operator action closes it.
- Add tests for teacher disconnect, reconnect, and manual end.

### Code Areas

- `apps/backend/src/rooms/rooms.gateway.ts`
- `apps/backend/src/rooms/rooms.service.ts`
- `apps/frontend/src/app/features/class-session/teacher/class-session.ts`
- `apps/frontend/src/app/features/class-session/student/class-session.ts`

## P0: Lifecycle Watch Authorization

### Gap

Socket `session:watch` only checks that the socket is authenticated. It does not validate that the user is allowed to watch that session.

### Risk

Any authenticated user can subscribe to guessed `session:started` and `session:ended` lifecycle events.

### Needed Fix

- Route `session:watch` through a service authorization check.
- Validate teacher ownership, admin role, or student enrollment.
- Reject unknown or unauthorized session IDs.
- Add tests for allowed and denied watchers.

### Code Areas

- `apps/backend/src/rooms/rooms.gateway.ts`
- `apps/backend/src/class-sessions/class-sessions.service.ts`

## P0: Start/End Session Consistency

### Gap

Manual start checks for another live session, then updates separately. This can race under concurrent requests. Manual end updates DB before closing the room, so a room close failure can leave the session completed while media remains active.

### Risk

Two sessions for one batch can become live under race conditions. Ended sessions can have live media rooms if room close fails.

### Needed Fix

- Add a transactional guard or partial unique index for one live session per batch.
- Make end-session room closure and DB update consistent.
- Consider state transition fields like `ending` if room close can be asynchronous.
- Emit lifecycle events only after the transition is fully consistent.
- Add concurrency and failure-path tests.

### Code Areas

- `apps/backend/src/class-sessions/class-sessions.service.ts`
- `apps/backend/src/database/schemas.ts`

## P1: Whiteboard Is Not Yet Session-Realtime

### Gap

Teacher page renders the whiteboard, but the student session page does not show a synced whiteboard surface. The session payload includes a `whiteboardChannelId`, but the reviewed flow does not appear to use it for persisted/realtime board state.

### Risk

The whiteboard is locally rich but not yet a true collaborative classroom artifact.

### Needed Fix

- Add a dedicated whiteboard collection or event log:
  - sessionId
  - roomId
  - channelId
  - operation id
  - actor id
  - operation payload
  - createdAt
- Add Socket.IO events for whiteboard operations and cursor presence.
- Load initial board history/snapshot on join.
- Persist snapshots or compact operation logs for long sessions.
- Add student read/write rules:
  - Teacher can draw by default.
  - Student can draw only if allowed, or use pointer/laser/raise hand.
- Add conflict-safe operation IDs and dedupe.

### Code Areas

- `apps/frontend/src/app/shared/whiteboard/whiteboard.ts`
- `apps/frontend/src/app/features/class-session/teacher/class-session.html`
- `apps/frontend/src/app/features/class-session/student/class-session.html`
- `apps/backend/src/database/schemas.ts`
- `apps/backend/src/rooms/rooms.gateway.ts`

## P1: Private Chat Needs Production Thread State

### Gap

Private teacher-student chat is scoped correctly now, but there is no real read state, unread count, message delivery state, retry state, or durable per-thread summary. The collapsed badge currently counts visible messages, not unread messages.

### Risk

Teacher cannot reliably track which students need attention. Students can see confusing unread counts. Reconnect and missed-event handling depends heavily on history reload.

### Needed Fix

- Add chat read-state persistence:
  - sessionId
  - roomId
  - userId or participantId
  - threadKey or broadcast scope
  - lastReadAt
- Add `chat:mark-read`.
- Add teacher thread summary API:
  - student list
  - latest message preview
  - unread count
  - online/joined state
- Add frontend pending/sent/failed message state.
- Add retry for failed sends if feasible.
- Keep broadcast as explicit teacher-only mode.

### Code Areas

- `apps/backend/src/database/schemas.ts`
- `apps/backend/src/rooms/rooms.service.ts`
- `apps/backend/src/rooms/rooms.gateway.ts`
- `apps/frontend/src/app/features/class-session/session-chat/session-chat.ts`

## P1: Private Socket Delivery Is Single-Socket

### Gap

Private chat and targeted moderation use the single `participant.socketId`. They do not emit to all active sockets for the same participant/user, and private events do not appear to use the distributed signal path.

### Risk

Private messages can be missed in multi-tab, reconnect, mobile handoff, or multi-node deployments.

### Needed Fix

- Track active sockets per participant/user/room.
- Emit private events to all active sockets for both sender and recipient.
- Use cluster-safe targeted signaling or persist-and-notify with history reconciliation.
- Avoid leaking private events to the whole room.

### Code Areas

- `apps/backend/src/rooms/rooms.service.ts`
- `apps/backend/src/rooms/rooms.gateway.ts`
- `apps/backend/src/redis/redis.service.ts`

## P1: Socket Auth And Ack Resilience

### Gap

The frontend socket singleton does not clearly refresh auth when the access token changes. `emitAck` has no timeout, so failed socket calls can hang.

### Risk

Long sessions, token refresh, logout/login switching, and network instability can create stuck UI states.

### Needed Fix

- Recreate or re-authenticate socket when token changes.
- Add ack timeout with useful error messages.
- Handle connect errors uniformly.
- Add reconnect backoff state to UI.
- Add tests for stale token and ack timeout behavior.

### Code Areas

- `apps/frontend/src/app/core/services/socket.service.ts`
- `apps/frontend/src/app/features/class-session/teacher/class-session.ts`
- `apps/frontend/src/app/features/class-session/student/class-session.ts`
- `apps/frontend/src/app/features/class-session/session-chat/session-chat.ts`

## P2: Media UX And Moderation Polish

### Gap

Media publishing, consuming, device switching, and teacher moderation are present, but production polish is still needed around reconnect state, device-denied states, teacher moderation reversibility, and audio/video diagnostics.

### Needed Fix

- Add teacher unmute/allow-camera controls if product policy allows it.
- Distinguish student self-muted vs teacher-muted.
- Add clearer browser permission recovery flows.
- Persist teacher moderation state per session.
- Add per-student network/media health indicator for teacher.
- Add mobile layout checks for video, chat, and controls.

### Code Areas

- `apps/frontend/src/app/core/services/webrtc.service.ts`
- `apps/frontend/src/app/features/class-session/teacher/class-session.ts`
- `apps/frontend/src/app/features/class-session/student/class-session.ts`
- `apps/backend/src/rooms/rooms.service.ts`

## P2: Observability And Audit Trail

### Gap

The class-session-specific lifecycle and moderation actions need a tighter audit trail and operator visibility.

### Needed Fix

- Audit:
  - session started
  - session ended
  - student joined
  - teacher disconnected/reconnected
  - chat broadcast sent
  - media moderation action
  - whiteboard cleared/exported
- Add dashboards or logs for failed joins, socket disconnect rate, media publish failures, and chat send failures.

### Code Areas

- `apps/backend/src/events/platform-events.service.ts`
- `apps/backend/src/rooms/rooms.service.ts`
- `apps/backend/src/class-sessions/class-sessions.service.ts`

## Acceptance Checklist Before Production

- Unauthorized students cannot discover, watch, join, chat, or load history for another batch.
- Teacher network drop does not end the class or close the room.
- Manual End Session is the only normal class-session room close path.
- Students see teacher media and screen share reliably after reconnect.
- Teacher sees each student media tile and audio reliably after reconnect.
- Private chat never leaks between students.
- Teacher broadcast is explicit and clearly labeled.
- Chat unread state is real and persists across refresh.
- Whiteboard syncs between teacher and students and persists across refresh.
- Socket calls time out instead of hanging forever.
- Build and focused backend/frontend tests pass.
