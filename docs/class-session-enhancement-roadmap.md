# Class Session Enhancement Roadmap

This document captures the next product and engineering enhancements for the class-session flow.

It was refreshed against the current codebase so the roadmap does not list already-implemented work as future work.

## Current Codebase Baseline

The current class-session flow already includes the major classroom foundations below.

- Manual teacher start and end APIs, with live-session join gating.
- Enrollment-backed access checks for session metadata, room join, lifecycle watch, and chat access.
- Teacher reconnect grace with persisted reconnect deadline fields.
- Teacher preflight modal with local camera/microphone preview, device selectors, microphone meter, readiness checks, and explicit Start Live Class or Enter Live Class confirmation.
- Student pre-join popup with preview, device controls, and explicit Join Class.
- SFU media wiring for teacher camera, microphone, screen share, student media publishing, and teacher participant cards.
- Student layout that prioritizes teacher screen share and shows teacher camera as PiP.
- Camera and microphone device switching for teacher and student.
- Teacher moderation for individual student mic/camera, local hide/show, and class-wide mute/stop camera controls.
- Teacher class lock/unlock using room lock behavior.
- Hand raise, lower hand, allow speak, and revoke speak flow.
- Private teacher-student chat, explicit teacher broadcast chat, thread summaries, unread counts, read state, and chat read receipts.
- Basic chat attachments for PDF, image, and link messages using validated inline data URL or safe URL metadata.
- Attendance CSV download from class-session context.
- A rich local whiteboard component with advanced drawing, erasing, selection, fill, keyboard shortcuts, pages, and file/image elements.

Relevant code areas observed during refresh:

- `apps/frontend/src/app/features/class-session/teacher/class-session.ts`
- `apps/frontend/src/app/features/class-session/student/class-session.ts`
- `apps/frontend/src/app/features/class-session/session-chat/session-chat.ts`
- `apps/frontend/src/app/shared/whiteboard/whiteboard.ts`
- `apps/backend/src/class-sessions/class-sessions.service.ts`
- `apps/backend/src/class-sessions/class-sessions.controller.ts`
- `apps/backend/src/rooms/rooms.service.ts`
- `apps/backend/src/rooms/rooms.gateway.ts`
- `apps/backend/src/database/schemas.ts`

## Product Direction

The class session should feel like a focused live classroom, not just a generic video room. The next improvements should preserve useful learning artifacts, improve post-class review, and harden the experience for real school operations.

Use the Native SFU palette for new UI surfaces:

- Rose `#F26076` for primary actions and moderation emphasis.
- Coral `#FF9760` for live/highlight states.
- Amber `#FFD150` for attention and waiting states.
- Green `#458B73` for calm connected/ready states.

## Recommended Implementation Order

1. Persisted realtime whiteboard.
2. Server-stored chat attachments.
3. Session activity timeline and audit log.
4. Post-class report and recap.
5. Mobile and tablet hardening pass.
6. Recording and playback.
7. Attendance analytics and admin reporting.
8. Classroom policy presets.
9. Accessibility and localization pass.
10. Production observability and support tooling.

## Completed Or Baseline Items

These ideas should no longer be tracked as new roadmap items unless the goal is polish or expansion:

- Teacher preflight modal.
- Student pre-join popup.
- Teacher class controls: mute all students, stop all student cameras, lock/unlock class, end for everyone, download attendance.
- Hand raise and allow-speak flow.
- Basic chat attachments.
- Chat unread/read state and delivery UI.
- Enrollment-based class-session access control.
- Teacher reconnect grace.
- Camera/microphone device switching.
- Teacher screen share plus PiP layout.

## P1: Persisted Realtime Whiteboard

### Why

The whiteboard is feature-rich locally, but class sessions still need a session-persisted, realtime board that students can view during class and revisit after class.

### Proposed Behavior

- Persist whiteboard operations or snapshots by `sessionId`, `roomId`, and `whiteboardChannelId`.
- Sync teacher board changes to students in realtime.
- Load current board state for late joins and refreshes.
- Show ended-session whiteboards in read-only mode.
- Optionally allow student drawing, pointer, or laser only when teacher enables it.

### Implementation Notes

- Reuse the existing `WhiteboardCommand` shape from the shared whiteboard component.
- Add operation ids for dedupe and replay safety.
- Store compact snapshots periodically to avoid replaying huge operation logs.
- Keep board events separate from media and chat events.
- Add teacher/student authorization around board write permissions.

### Acceptance Checks

- Student joining late sees the current board.
- Refresh reloads the same board state.
- Teacher updates appear for students without page refresh.
- Ended sessions can show the final board read-only.
- Unauthorized or non-enrolled users cannot load board state.

## P1: Server-Stored Chat Attachments

### Why

Chat currently supports attachment metadata and inline data URLs/safe URLs. That is useful for small files, but production classrooms need server-stored files, access-controlled downloads, and better file handling.

S3 is intentionally out of scope for the first implementation. Store files on the server or the repo-native local storage abstraction now, but keep the storage boundary ready for a future S3 provider.

### Proposed Behavior

- Upload PDFs and images to backend-controlled local storage.
- Store attachment ids, storage provider, and storage keys instead of large inline payloads.
- Serve attachments through guarded backend download/open endpoints.
- Preserve private and broadcast chat visibility rules.
- Keep links as validated URL attachments.
- Do not implement S3 yet.

### Implementation Notes

- Reuse existing storage infrastructure if present; otherwise add a small local storage adapter.
- Store `storageProvider: local` and `storageKey` so a future S3 adapter can reuse the same chat authorization path.
- Keep attachment scope inherited from the chat message.
- Enforce file size, MIME type, extension, and content validation.
- Add virus scanning or quarantine hook if the platform has one.
- Avoid exposing raw storage keys or filesystem paths to clients.

### Acceptance Checks

- Private attachments are visible only to teacher and target student.
- Broadcast attachments are visible to admitted/enrolled class participants.
- Non-enrolled users cannot download files by guessing URLs.
- Large files do not bloat chat socket payloads or Mongo documents.
- S3 is not required for this phase, but the metadata model can support it later.

## P1: Session Activity Timeline And Audit Log

### Why

Teachers and support staff need a reliable view of what happened in a class: joins, leaves, reconnects, moderation, hand raises, broadcasts, whiteboard snapshots, and session lifecycle events.

### Proposed Behavior

- Capture structured class-session events.
- Show a teacher/admin timeline after class.
- Include key events during live support troubleshooting.
- Keep student-visible timeline limited to allowed classroom artifacts.

### Implementation Notes

- Reuse existing room incident/timeline patterns where appropriate.
- Add class-session-specific event types only where room events are too generic.
- Avoid storing private chat message bodies in broad audit records.
- Keep event records immutable.

### Acceptance Checks

- Ended session shows a chronological timeline.
- Teacher can see moderation and attendance-relevant events.
- Student cannot see another student's private events.
- Admin can inspect session incidents for support.

## P1: Post-Class Report And Recap

### Why

After a live class, teachers need a concise report that combines attendance, chat, whiteboard artifacts, and participation signals.

### Proposed Behavior

- Generate a post-class report with:
  - attendance summary
  - join/leave/reconnect list
  - hand raise and speaking participation
  - teacher broadcast messages
  - shared whiteboard snapshot link
  - attachment list
- Keep private student chats scoped to the relevant teacher/student thread.

### Implementation Notes

- Start with deterministic summaries before adding AI-generated summaries.
- Make the report available from teacher/admin batch/session views.
- Add export options after the first report view is stable.

### Acceptance Checks

- Teacher can open an ended-session report.
- Report does not leak private student chat to other students.
- Attendance values match the downloadable CSV.
- Report remains available after session room closure.

## P1: Mobile And Tablet Hardening

### Why

Students may join from phones or tablets. The classroom should remain usable when screen share, PiP, chat, participant drawer, and media controls all compete for space.

### Proposed Behavior

- Keep screen share as the main stage when active.
- Keep teacher camera PiP visible but non-blocking.
- Move chat and participants into compact sheets or tabs on small screens.
- Keep pre-join, device selectors, hand raise, and chat composer usable in portrait and landscape.

### Implementation Notes

- Test common mobile widths and tablet landscape.
- Use stable dimensions for media stage, PiP, toolbar, and composer.
- Avoid overlapping bottom controls with PiP or chat composer.
- Add focused Playwright screenshot checks if the repo already has that pattern.

### Acceptance Checks

- Student can watch screen share and teacher camera on mobile.
- Teacher controls remain reachable on tablet.
- Chat composer does not overlap media controls.
- Pre-join popup fits without clipped actions.

## P2: Recording And Playback

### Why

Recording is valuable for review, but it has media-pipeline, storage, consent, retention, and access-control implications. It should be designed deliberately.

Recording must be server-side. Browser-side `MediaRecorder` or teacher/student client recording should not be the source of truth.

### Proposed Behavior

- Teacher explicitly starts/stops recording.
- Students see a clear recording indicator.
- Ended sessions expose playback only to authorized users.
- Admins can configure retention and download permissions.
- Recording stops when the class session ends.

### Implementation Notes

- Build on the SFU/server media path rather than browser recording.
- Prefer server-side composition if feasible: screen share as primary, teacher camera as PiP, teacher audio, and allowed student audio.
- If composition is too large for the first phase, record server-side tracks plus a playback manifest and document the limitation.
- Define consent and retention rules before implementation.
- Store recording metadata by session and batch.
- Gate playback by teacher/admin/enrolled-student access.

### Acceptance Checks

- Recording never starts silently.
- Recording state survives reconnect.
- Recording is performed on the server side.
- Only authorized users can access playback.
- Ended sessions can show recording availability.

## P2: Attendance Analytics And Admin Reporting

### Why

The CSV export is useful for a single session. Admins will eventually need aggregate views across batches, teachers, courses, and date ranges.

### Proposed Behavior

- Add attendance dashboards for batch and course views.
- Show present/absent, late joins, early leaves, total duration, reconnect count, and participation signals.
- Allow CSV export by batch/course/date range.

### Implementation Notes

- Reuse participant join/leave records and enrollment roster.
- Normalize report rows so absent enrolled students are included.
- Keep teacher/admin authorization separate from student views.

### Acceptance Checks

- Admin can view attendance across multiple sessions.
- Teacher can view attendance for owned batches.
- Enrolled students cannot see other students' analytics.

## P2: Classroom Policy Presets

### Why

Teachers need repeatable class setup rules instead of toggling the same controls every session.

### Proposed Behavior

- Add policy presets such as:
  - student mic starts muted
  - student camera starts off
  - chat locked until teacher opens it
  - student drawing disabled by default
  - class locks after start
- Apply presets when a teacher starts a class.

### Implementation Notes

- Store policies at batch level first.
- Allow per-session override if product needs it later.
- Keep backend authorization as the final source of truth.

### Acceptance Checks

- Teacher can configure a batch classroom policy.
- New live sessions apply the policy on start.
- Students see clear disabled/locked states.

## P2: Accessibility And Localization

### Why

Live classroom UI has high interaction density. Keyboard, screen reader, contrast, and language support matter more as the product becomes production-facing.

### Proposed Behavior

- Audit keyboard paths for preflight, pre-join, chat, participant cards, hand raise, and whiteboard.
- Add ARIA labels and live regions where state changes are important.
- Verify color contrast in light and dark mode.
- Prepare visible strings for localization.

### Implementation Notes

- Keep modal focus traps and escape behavior consistent.
- Avoid icon-only controls without accessible labels.
- Add focused tests for critical modal and chat interactions where possible.

### Acceptance Checks

- Preflight and pre-join can be completed by keyboard.
- Screen readers announce session ended, teacher reconnecting, and moderation state changes.
- Controls meet contrast expectations.

## P2: Production Observability And Support Tooling

### Why

Live classes need quick support answers: who is connected, whether media is flowing, why a student cannot join, and whether socket events are delayed.

### Proposed Behavior

- Add class-session support view for admin/operator users.
- Show session status, room owner, connected participants, media producers, reconnect grace state, lock state, chat health, and recent errors.
- Add metrics/alerts for failed joins, reconnect grace expiries, chat delivery failures, and attachment validation failures.

### Implementation Notes

- Reuse existing room quality, incident, and snapshot systems.
- Avoid exposing private chat bodies in support views.
- Add links from session report to room incident evidence.

### Acceptance Checks

- Operator can diagnose a live class without database shell access.
- Alerts include session and batch identifiers.
- Support view respects admin-only access.

## Verification Checklist

- Run backend and frontend builds after each implementation slice.
- Add focused backend tests for any new authorization, lifecycle, persistence, or download behavior.
- Add frontend tests for modal, chat, media, and state transitions where existing patterns allow.
- Verify teacher and student flows with two browser sessions.
- Confirm manual lifecycle remains intact, except for the intentional teacher reconnect grace auto-end behavior.
- Confirm private chat, broadcast chat, and enrollment authorization are not weakened by new features.
- Confirm mobile layouts with screenshots before calling UI work complete.
