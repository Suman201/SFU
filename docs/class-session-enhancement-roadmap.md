# Class Session Enhancement Roadmap

This document captures the next product and engineering enhancements for the class-session flow.

It was refreshed against the current codebase so the roadmap does not list already-implemented work as future work.

How to read this document:

- Struck-through lines are implemented or baseline capabilities.
- Unstruck roadmap items are remaining enhancement scope.

## Current Codebase Baseline

The current class-session flow already includes the major classroom foundations below.

- ~~Manual teacher start and end APIs, with live-session join gating.~~
- ~~Enrollment-backed access checks for session metadata, room join, lifecycle watch, and chat access.~~
- ~~Teacher reconnect grace with persisted reconnect deadline fields.~~
- ~~Teacher preflight modal with local camera/microphone preview, device selectors, microphone meter, readiness checks, and explicit Start Live Class or Enter Live Class confirmation.~~
- ~~Student pre-join popup with preview, device controls, and explicit Join Class.~~
- ~~SFU media wiring for teacher camera, microphone, screen share, student media publishing, and teacher participant cards.~~
- ~~Student layout that prioritizes teacher screen share and shows teacher camera as PiP.~~
- ~~Camera and microphone device switching for teacher and student.~~
- ~~Teacher moderation for individual student mic/camera, local hide/show, and class-wide mute/stop camera controls.~~
- ~~Teacher class lock/unlock using room lock behavior.~~
- ~~Hand raise, lower hand, allow speak, and revoke speak flow.~~
- ~~Private teacher-student chat, explicit teacher broadcast chat, thread summaries, unread counts, read state, and chat read receipts.~~
- ~~Basic chat attachments for PDF, image, and link messages using validated inline data URL or safe URL metadata.~~
- ~~Server-stored class-session chat file attachments with local backend storage, guarded download endpoints, safe metadata, checksum, MIME/extension validation, and private/broadcast visibility enforcement.~~
- ~~Attendance CSV download from class-session context.~~
- ~~A rich local whiteboard component with advanced drawing, erasing, selection, fill, keyboard shortcuts, pages, and file/image elements.~~

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

1. ~~Persisted realtime whiteboard.~~
2. ~~Server-stored chat attachments.~~
3. ~~Session activity timeline and audit log.~~
4. ~~Student post-class access and Q&A.~~
5. ~~Post-class report and recap.~~
6. ~~Teacher post-class workflow.~~
7. ~~Homework and assignments.~~
8. ~~Student progress dashboard.~~
9. ~~Teacher analytics.~~
10. ~~Search and library.~~
11. ~~Student support and escalation.~~
12. ~~Public teacher profile gallery and demo classes.~~
13. ~~Teacher marketplace and discovery.~~
14. ~~Public teacher profile promotion and paid visibility.~~
15. Mobile and tablet hardening pass.
16. ~~Recording and playback.~~
17. ~~Attendance analytics and admin reporting.~~
18. Classroom policy presets.
19. Accessibility and localization pass.
20. ~~Production observability and support tooling.~~

## Completed Or Baseline Items

These ideas should no longer be tracked as new roadmap items unless the goal is polish or expansion:

- ~~Teacher preflight modal.~~
- ~~Student pre-join popup.~~
- ~~Teacher class controls: mute all students, stop all student cameras, lock/unlock class, end for everyone, download attendance.~~
- ~~Hand raise and allow-speak flow.~~
- ~~Basic chat attachments.~~
- ~~Server-stored chat attachments with guarded backend download/open endpoints.~~
- ~~Session activity timeline and audit log with immutable safe event records, teacher/admin timeline views, and authorization-protected timeline APIs.~~
- ~~Student post-class access and private Q&A with completed-session review, guarded artifacts, teacher replies, and post-class chat context markers.~~
- ~~Public teacher profile gallery and demo classes with teacher-managed draft/publish workflow, server-stored public media URLs, and published-only public profile tabs.~~
- ~~Teacher post-class workflow with unified completed-session workspace, Q&A triage, explicit artifact publishing, announcements, and follow-up assignment shortcut.~~
- ~~Homework and assignments with teacher create/review, student submit/view, guarded attachments, and enrollment-protected access.~~
- ~~Student progress dashboard with student-only backend summary, attendance/class/assignment/recording/participation/Q&A rollups, honest unavailable states, and mobile-friendly frontend page.~~
- ~~Teacher analytics with teacher-owned/admin-scoped batch learning signals, deterministic aggregates, conservative risk indicators, and privacy-safe source links.~~
- ~~Admin attendance analytics and reporting with snapshot/inferred source labels, filters, per-student CSV export, and drilldowns.~~
- ~~Student support and escalation with student-owned requests, class/recording context validation, admin triage queue, safe diagnostics, and role-protected status updates.~~
- ~~Search and library with metadata search across authorized class-session artifacts for student, teacher, and admin scopes.~~
- ~~Teacher marketplace and discovery with `/teachers` public listing, safe teacher cards, public-profile links, search/filter API, and student explore entry points.~~
- ~~Public teacher profile promotion foundation with teacher requests, admin approval/pause/cancel/reject, active promotion boosting, promoted marketplace badges, and audit-safe records.~~
- ~~Recording playback analytics with enrollment-protected progress writes, watched/unwatched student progress, teacher engagement rollups, and admin recording engagement cards.~~
- ~~Production observability and support tooling with admin session health snapshots, support-safe diagnostics, support/recording metrics, and dashboard operational issue surfacing.~~
- ~~Persisted realtime whiteboard with operation persistence, current snapshots, student read-only sync, and completed-session review.~~
- ~~Chat unread/read state and delivery UI.~~
- ~~Enrollment-based class-session access control.~~
- ~~Teacher reconnect grace.~~
- ~~Camera/microphone device switching.~~
- ~~Teacher screen share plus PiP layout.~~

## P1: Persisted Realtime Whiteboard

Status: **Done on 2026-07-07.**

Completed roadmap requirements below are fully struck through. The unstruck `Done:` notes describe what shipped.

### Why

~~The whiteboard is feature-rich locally, but class sessions still need a session-persisted, realtime board that students can view during class and revisit after class.~~

Done: accepted live whiteboard commands are now persisted as operations, folded into the saved class-session board state, and loaded for live students and completed-session review.

### Proposed Behavior

- ~~Persist whiteboard operations or snapshots by `sessionId`, `roomId`, and `whiteboardChannelId`.~~
  Done: live `whiteboard:command` events persist operation records with operation id, sequence, session, batch, room, channel, actor, and command payload; the current snapshot state is updated after each accepted operation.
- ~~Sync teacher board changes to students in realtime.~~
  Done: teacher commands now emit for normal teacher drawing, not only during student control, and realtime command delivery targets all admitted room participants.
- ~~Load current board state for late joins and refreshes.~~
  Done: students load persisted whiteboard memory when a live session payload is active, then apply live command updates in the board drawer.
- ~~Show ended-session whiteboards in read-only mode.~~
  Done: completed-class detail loads the final saved whiteboard state and renders it through the shared whiteboard component in read-only mode.
- ~~Optionally allow student drawing, pointer, or laser only when teacher enables it.~~
  Done: existing selective student control remains enforced; authorized student commands also receive operation ids and persist through the same socket path.

### Implementation Notes

- ~~Reuse the existing `WhiteboardCommand` shape from the shared whiteboard component.~~
  Done: the operation ledger stores the existing `upsert`, `delete`, and `clear` command shape without introducing a parallel command model.
- ~~Add operation ids for dedupe and replay safety.~~
  Done: clients send operation ids; duplicate operation ids with the same command are treated as idempotent replay and are not rebroadcast.
- ~~Store compact snapshots periodically to avoid replaying huge operation logs.~~
  Done: the existing whiteboard memory snapshot remains the compact read model, and live operations update that snapshot cursor.
- ~~Keep board events separate from media and chat events.~~
  Done: persistence uses dedicated whiteboard state/version/operation records and the existing whiteboard socket events.
- ~~Add teacher/student authorization around board write permissions.~~
  Done: teacher/co-host writes and granted-student writes reuse existing room participant, live-session, lock, permission-level, and enrollment-protected read checks.

### Acceptance Checks

- ~~Student joining late sees the current board.~~
  Done: live student clients load persisted board state for the current session before applying new realtime commands.
- ~~Refresh reloads the same board state.~~
  Done: the saved whiteboard memory endpoint returns the latest snapshot and operation cursor metadata for authorized users.
- ~~Teacher updates appear for students without page refresh.~~
  Done: teacher command events are delivered to admitted room participants and applied by the student read-only board drawer.
- ~~Ended sessions can show the final board read-only.~~
  Done: student completed-class detail renders the saved board read-only alongside the page summary.
- ~~Unauthorized or non-enrolled users cannot load board state.~~
  Done: board state loading continues to use class-session read authorization, and writes continue to require live room participation plus teacher/granted-student permissions.

## P1: Server-Stored Chat Attachments

Status: **Done for the local-storage implementation on 2026-07-07.**

Completed lines below are fully struck through. Unstruck lines remain future hardening or deployment policy work.

### Why

~~Chat previously supported attachment metadata and inline data URLs/safe URLs for small files. Done: class-session file attachments now use backend upload plus guarded download URLs instead of embedding file bytes in socket payloads or chat documents.~~

~~S3 is intentionally out of scope for the first implementation. Done: files are stored through the repo-native local storage configuration while metadata keeps `storageProvider`, `storageKey`, and checksum fields ready for a later object-storage provider.~~

### Proposed Behavior

- **Done**: ~~Upload PDFs and images to backend-controlled local storage. Done: PDF, JPEG/JPG, PNG, and WebP uploads are accepted through `POST /api/v1/class-sessions/:sessionId/chat/attachments`.~~
- **Done**: ~~Store attachment ids, storage provider, and storage keys instead of large inline payloads. Done: chat messages persist safe attachment metadata snapshots, while stored file records keep local `storageKey` and filesystem path server-side.~~
- **Done**: ~~Serve attachments through guarded backend download/open endpoints. Done: `GET /api/v1/class-sessions/:sessionId/chat/attachments/:attachmentId` streams authorized files without the global JSON success wrapper.~~
- **Done**: ~~Preserve private and broadcast chat visibility rules. Done: private attachments inherit the teacher-student thread and broadcast attachments inherit teacher/admin broadcast visibility.~~
- **Done**: ~~Keep links as validated URL attachments. Done: links remain HTTP/HTTPS metadata attachments and do not require file storage.~~
- **Done**: ~~Do not implement S3 yet. Done: this pass uses local storage only and leaves the provider boundary intact.~~

### Implementation Notes

- **Done**: ~~Reuse existing storage infrastructure if present; otherwise add a small local storage adapter. Done: chat attachments use the existing backend local-storage/config pattern instead of a new storage stack.~~
- **Done**: ~~Store `storageProvider: local` and `storageKey` so a future S3 adapter can reuse the same chat authorization path. Done: stored file documents include local provider metadata, storage key, checksum, sanitized names, and size metadata.~~
- **Done**: ~~Keep attachment scope inherited from the chat message. Done: pending uploads are bound to private or broadcast scope only when the chat message is persisted.~~
- **Done**: ~~Enforce file size, MIME type, extension, and content validation. Done: size, MIME allowlist, matching extension, non-empty buffer, and upload ownership are validated.~~
- Future hardening: add virus scanning or quarantine hooks when a scanning provider is available.
- **Done**: ~~Avoid exposing raw storage keys or filesystem paths to clients. Done: client payloads receive attachment ids, names, MIME, size, checksum, provider, and guarded download URL only.~~

### Acceptance Checks

- **Done**: ~~Private attachments are visible only to teacher and target student. Done: private download checks use the teacher-student thread key and reject other students.~~
- **Done**: ~~Broadcast attachments are visible to admitted/enrolled class participants. Done: broadcast files follow class-session access and broadcast scope.~~
- **Done**: ~~Non-enrolled users cannot download files by guessing URLs. Done: download routes reuse class-session authorization before streaming files.~~
- **Done**: ~~Large files do not bloat chat socket payloads or Mongo documents. Done: class-session file sends reject inline `dataUrl` and external file `url` payloads; clients send uploaded attachment ids.~~
- **Done**: ~~S3 is not required for this phase, but the metadata model can support it later. Done: local storage is implemented and provider metadata remains object-storage friendly.~~

## P1: Session Activity Timeline And Audit Log

Status: **Done on 2026-07-07.**

Completed lines below are fully struck through. Unstruck lines remain future hardening or expansion work.

### Why

~~Teachers and support staff need a reliable view of what happened in a class: joins, leaves, reconnects, moderation, hand raises, broadcasts, whiteboard snapshots, and session lifecycle events. Done: class sessions now write immutable activity records and expose protected teacher/admin timeline views.~~

### Proposed Behavior

- ~~Capture structured class-session events. Done: lifecycle, join/leave/rejoin, reconnect grace, moderation, bulk controls, class lock, hand raise/speak, media failures, broadcasts, recordings, materials, whiteboard control, post-class Q&A status, attendance snapshot, and support incidents are recorded.~~
- ~~Show a teacher/admin timeline after class. Done: teacher batch/session details and admin class-session detail include a filtered activity timeline with load-more pagination, including a dedicated Media filter.~~
- ~~Include key events during live support troubleshooting. Done: the timeline API works for live and completed sessions and includes support-safe incidents such as denied joins, chat failures, and media publish/consume failures.~~
- ~~Keep student-visible timeline limited to allowed classroom artifacts. Done: the backend supports student-safe timeline filtering so students cannot read other students' private activity.~~

### Implementation Notes

- ~~Reuse existing room incident/timeline patterns where appropriate. Done: class-session activity capture is wired through existing class-session, room, recording, material, whiteboard, and chat flows instead of a parallel realtime stack.~~
- ~~Add class-session-specific event types only where room events are too generic. Done: event types are namespaced around session, participant, reconnect, moderation, media, hand raise, class controls, recording, materials, whiteboard, chat broadcast, Q&A, attendance, and support events. Recording availability is represented by the stopped/playable recording state in this repo.~~
- ~~Avoid storing private chat message bodies in broad audit records. Done: private chat bodies are not written to timeline records, and sensitive metadata keys such as body, content, URL, storage path, token, and secret fields are redacted.~~
- ~~Keep event records immutable. Done: timeline entries are append-only records in `class_session_activity_events`; the read path supports `before`, `limit`, and category filters.~~

### Acceptance Checks

- ~~Ended session shows a chronological timeline. Done: the API returns newest-to-oldest activity with pagination for completed and live sessions.~~
- ~~Teacher can see moderation and attendance-relevant events. Done: owned-session teachers can read the full safe timeline, including moderation and attendance snapshot events.~~
- ~~Student cannot see another student's private events. Done: enrolled students receive only student-safe and own-audience records from the backend timeline filter.~~
- ~~Admin can inspect session incidents for support. Done: admin/super-admin users can open any class-session timeline from the admin portal session detail page.~~

## P1: Student Post-Class Access And Q&A

Status: **Done on 2026-07-07.**

Completed lines below are fully struck through. Unstruck lines remain future enhancement scope.

### Why

~~Students need a calm after-class place to continue learning: replay the class, collect notes and materials, read teacher announcements, and ask follow-up questions without opening a new support or public chat channel.~~

Done: enrolled students have a completed-session page with authorized class artifacts and private teacher Q&A.

### Proposed Behavior

- ~~Show enrolled students a student-safe completed-session view.~~
  Done: `/student/classes/completed/:sessionId` loads only historically enrolled student history.
- ~~Include teacher-published recording or playback links when available.~~
  Done: completed-session detail includes authorized recording rows and guarded playback/download links when recording settings allow them.
- ~~Include shared whiteboard notes, exported PDFs, lesson materials, and teacher announcements.~~
  Done: the page includes saved whiteboard summary/read-only state, shared materials, related assignments, and teacher broadcast announcements.
- ~~Include only the student's own private teacher-student chat and question thread.~~
  Done: student detail loads the private thread for the authenticated student/teacher pair and never broad room-private history.
- ~~Allow enrolled students to ask post-class questions after a session is completed.~~
  Done: students can send a private follow-up question through the completed-session Q&A composer.
- ~~Route post-class questions privately to the teacher by default.~~
  Done: post-class Q&A writes private teacher-student chat with `context: post_class`, filters Q&A history/summary to post-class private messages, and never uses room-wide broadcast.
- ~~Let the teacher reply privately from the related session context.~~
  Done: teacher batch session detail exposes a Post-class Q&A panel with private per-student threads and replies.
- Optionally let the teacher promote a useful question into a public batch/session announcement later, but only through an explicit action.

### Implementation Notes

- ~~Reuse existing enrollment-backed class-session authorization.~~
  Done: completed-session list/detail/Q&A reuse historical enrollment and teacher/admin batch access checks.
- ~~Reuse private teacher-student chat where possible, but allow a completed-session Q&A mode if live chat is otherwise blocked after class.~~
  Done: post-class Q&A reuses private chat thread keys while marking persisted messages with `context: post_class`.
- ~~Keep teacher broadcasts and public announcements separate from private Q&A.~~
  Done: announcements are loaded from broadcast history; Q&A uses private thread history and private writes only.
- ~~Do not expose other students' private questions, private chats, attendance details, or submissions.~~
  Done: student detail uses the current user's thread and own attendance/assignment surfaces only; teacher thread loading validates historical roster membership.
- ~~Keep recording, material, note, and attachment URLs guarded by backend authorization instead of relying on hidden client links.~~
  Done: completed-session artifacts reuse existing authorized recording, material, whiteboard memory, assignment, and attachment paths; material downloads now use completed-session historical access for enrolled students.

### Acceptance Checks

- ~~Enrolled students can open their own completed-session page.~~
  Done: backend tests cover class-history batch filtering and detail access.
- ~~Enrolled students can access authorized recordings, notes, materials, and announcements.~~
  Done: the detail API aggregates only student-safe artifacts for the completed session.
- ~~Students can ask private post-class questions to the teacher.~~
  Done: `POST /class-sessions/student/completed/:sessionId/questions` sends private post-class messages.
- ~~Teachers can reply privately to post-class questions.~~
  Done: teacher post-class chat summary/history/reply endpoints and UI are wired from batch detail.
- ~~Student1 cannot see Student2's questions, private chats, or replies.~~
  Done: private history uses stable teacher-student thread keys scoped to the current student or selected roster student.
- ~~Non-enrolled students cannot access guessed post-class artifact or Q&A URLs.~~
  Done: non-enrolled completed detail is forbidden before artifact or chat history is loaded.

## P1: Post-Class Report And Recap

Status: **Done on 2026-07-07.**

Completed roadmap requirements below are fully struck through. The unstruck `Done:` notes describe what shipped.

### Why

~~After a live class, teachers and admins need a concise report that combines attendance, chat, whiteboard artifacts, student Q&A, and participation signals.~~

Done: completed class sessions now expose a deterministic teacher/admin report that combines attendance, participation, broadcasts, artifacts, assignments, Q&A status, and timeline incident highlights without generating AI summaries.

### Proposed Behavior

- ~~Generate a post-class report with attendance summary.~~
  Done: `GET /class-sessions/:sessionId/report` and `GET /admin/class-sessions/:sessionId/report` include attendance totals, attendance rate, average duration, reconnects, late joins, early leaves, and snapshot/inferred source.
- ~~Generate a post-class report with join, leave, reconnect, hand raise, and speaking participation.~~
  Done: the report derives participation counts from existing class-session timeline events.
- ~~Generate a post-class report with teacher broadcast metadata.~~
  Done: broadcast count and latest public broadcast preview are included; private chat bodies are not included.
- ~~Generate a post-class report with shared whiteboard, recording, material, and assignment artifacts.~~
  Done: the report includes authorized recording metadata, session materials, whiteboard snapshot summary, assignment counts, and assignment submission status totals.
- ~~Generate a post-class report with post-class student question and teacher reply status.~~
  Done: Q&A is summarized by private thread count, threads with activity, unanswered count, unread count, and latest activity time.
- ~~Keep private student chats scoped to the relevant teacher/student thread.~~
  Done: broad report output contains only Q&A status counts and does not include private Q&A message bodies.
- ~~Keep the student-facing summary limited to authorized student-safe artifacts.~~
  Done: student completed-session detail remains the student-safe surface; the new full report routes are teacher/admin scoped.

### Implementation Notes

- ~~Start with deterministic summaries before adding AI-generated summaries.~~
  Done: the report is deterministic and generated from existing attendance, timeline, recording, material, whiteboard, assignment, and post-class chat data.
- ~~Make the report available from teacher/admin batch/session views.~~
  Done: teacher batch detail has a completed-session `Session report` panel, and admin class-session detail shows completed-session recap cards.
- ~~Add export options after the first report view is stable.~~
  Done: completed-session reports can now be downloaded as CSV from teacher batch detail and admin class-session detail using `GET /api/v1/class-sessions/:sessionId/report/export.csv` and `GET /api/v1/admin/class-sessions/:sessionId/report/export.csv`.
- ~~Add print options for the completed-session report.~~
  Done: teacher and admin report views now include Print actions with print-friendly styles that keep the recap content visible and hide surrounding controls/chrome.

### Acceptance Checks

- ~~Teacher can open an ended-session report.~~
  Done: completed session row actions include `Session report` in teacher batch detail.
- ~~Admin/super-admin can open reports for completed sessions.~~
  Done: admin class-session detail loads the recap from the admin report endpoint.
- ~~Report does not leak private student chat to other students.~~
  Done: the broad report excludes private chat and Q&A message bodies.
- ~~Student post-class questions remain private to that student and the teacher.~~
  Done: Q&A remains backed by private post-class teacher-student threads; the report only shows counts/status.
- ~~Attendance values match the downloadable CSV source.~~
  Done: the report uses the same `adminAttendanceRowsForSession` helper that prefers attendance snapshots and falls back to inferred rows.
- ~~Report remains available after session room closure.~~
  Done: the report reads persisted completed-session records and artifact metadata, not the active media room.
- ~~Teacher/admin can export the report as CSV without exposing private Q&A bodies.~~
  Done: CSV export is generated from the existing safe `ClassSessionReport` data and includes only Q&A counts/status, not private message bodies.
- ~~Teacher/admin can print the visible completed-session report.~~
  Done: report panels expose browser print actions in the teacher and admin UIs.

Verification:

- ~~Contracts build.~~
  Done: `npm run build --workspace @native-sfu/contracts` passed.
- ~~Backend service tests.~~
  Done: `npm test --workspace @native-sfu/backend -- class-sessions.service.spec.ts` passed with 55 tests.
- ~~Backend build.~~
  Done: `npm run build --workspace @native-sfu/backend` passed.
- ~~Frontend build.~~
  Done: `npm run build --workspace @native-sfu/frontend` passed.
- ~~Admin portal build.~~
  Done: `npm run build --workspace @native-sfu/admin-portal` passed.
- ~~Whitespace check.~~
  Done: `git diff --check` passed.

Tracked follow-ups:

- Add deeper per-student drilldowns from the report only where privacy rules are explicit.

## P1: Teacher Post-Class Workflow

Status: **Done on 2026-07-07.**

Completed roadmap requirements below are fully struck through. The unstruck `Done:` notes describe what shipped.

### Why

~~After class, teachers need a focused workflow to close the loop: review what happened, answer student questions, publish learning artifacts, and assign follow-up work without jumping across unrelated screens.~~

Done: teacher batch detail now opens a unified completed-session post-class workspace from completed session actions.

### Proposed Behavior

- ~~Show a teacher-facing ended-session workspace.~~
  Done: completed session row actions now open `Post-class workspace`, backed by `GET /api/v1/class-sessions/:sessionId/post-class-workspace`.
- ~~Include session recap, attendance summary, hand raises, speaking activity, broadcasts, shared materials, recordings, and board notes.~~
  Done: the workspace composes the completed-session report, attendance/participation summary, broadcasts, materials, recordings, whiteboard notes, Q&A, and linked assignments.
- ~~Add a student questions inbox scoped to the completed session.~~
  Done: the workspace includes private post-class Q&A thread summaries per student.
- ~~Let teachers reply privately to individual students.~~
  Done: the existing Post-class Q&A panel remains wired for private teacher-student replies.
- ~~Let teachers mark important questions for follow-up.~~
  Done: Q&A workflow state supports `important`, `answered`, and `followUp` flags in `class_session_post_class_thread_states`.
- ~~Let teachers publish notes, recordings, or selected materials to students when ready.~~
  Done: explicit publish/unpublish actions are wired for materials, recordings, and whiteboard notes.
- ~~Let teachers create a teacher announcement from the session recap or a selected question.~~
  Done: the workspace includes a manual announcement composer that writes a post-class broadcast without auto-copying private student question content.
- ~~Let teachers assign follow-up homework from the ended-session context.~~
  Done: the workspace exposes a follow-up assignment shortcut with the completed session preselected.

### Implementation Notes

- ~~Reuse existing private chat, broadcast, materials, recording, attendance, and whiteboard-note flows.~~
  Done: the backend workspace composes the existing report/Q&A/material/recording/whiteboard/assignment data rather than introducing a parallel post-class stack.
- ~~Keep publish actions explicit; draft recordings or notes should not become student-visible accidentally.~~
  Done: completed-session students only see published recordings, published/explicitly shared materials, and published whiteboard notes.
- ~~Keep private Q&A separate from public announcements.~~
  Done: private Q&A stays in teacher-student post-class threads; announcements are explicit broadcast messages.
- ~~Do not expose one student's private question to the whole batch unless the teacher explicitly converts it into an announcement without private student identifiers.~~
  Done: the announcement composer is manual and does not auto-copy private student question bodies or identities.

### Acceptance Checks

- ~~Teacher can open a completed-session workspace.~~
  Done: completed session actions open the post-class workspace in teacher batch detail.
- ~~Teacher can see student questions and reply privately.~~
  Done: Q&A summaries are visible in the workspace, and private reply threads remain available from the Q&A panel.
- ~~Teacher can publish notes/materials/recording visibility explicitly.~~
  Done: each artifact type has an explicit publish/unpublish control.
- ~~Teacher can create an announcement from the post-class flow.~~
  Done: post-class announcement composer writes a teacher broadcast scoped to the completed session.
- ~~Teacher can start an assignment from the completed-session context.~~
  Done: `Create follow-up` opens the existing assignment form with the session preselected.
- ~~Private student questions are not exposed to other students.~~
  Done: the broad workspace report excludes private Q&A bodies, and student completed-session pages continue to load only the authenticated student's private thread.

### Verification

- ~~Contracts build.~~
  Done: `npm run build --workspace @native-sfu/contracts` passed.
- ~~Backend build.~~
  Done: `npm run build --workspace @native-sfu/backend` passed.
- ~~Frontend build.~~
  Done: `npm run build --workspace @native-sfu/frontend` passed.
- ~~Focused backend post-class/class-session tests.~~
  Done: `npm test --workspace @native-sfu/backend -- class-sessions.service.spec.ts` passed with 55 tests.
- ~~Whitespace check.~~
  Done: `git diff --check` passed.

Tracked follow-ups:

- Add a richer "convert selected private question into sanitized announcement" flow only after copy/privacy review.
- Add frontend unit tests for the new teacher workspace once batch-detail test coverage is split into smaller focused specs.

## P1: Homework And Assignments

Status: **Done on 2026-07-07.**

Completed roadmap requirements below are fully struck through. The unstruck `Done:` notes describe what shipped.

### Why

~~Live classes should lead into practice. Teachers need a simple assignment flow, and students need a clear place to submit work and track feedback.~~

Done: assignments now have backend-backed teacher creation/review flows and student dashboard/detail submission flows.

### Proposed Behavior

- ~~Teacher can assign homework after a class or from a batch context.~~
  Done: teachers/admins can create assignments for owned/managed batches from the teacher batch detail page and assignment API.
- ~~Assignment can include title, instructions, due date, attachments/material links, and optional related session.~~
  Done: assignments persist title, instructions, due date, allowed submission types, optional session, and link/material/file attachment metadata. Backend guarded file attachment endpoints are in place; a richer teacher-side file upload picker remains UI polish.
- ~~Students can view assigned work from dashboard and completed-session detail.~~
  Done: the student dashboard shows due assignments, and completed-session detail surfaces related assignments for the session.
- ~~Students can submit text, files, or links according to allowed formats.~~
  Done: student assignment detail supports text, link, and file submission with backend type/file validation.
- ~~Teacher can review submissions, add feedback, return for revision, or mark complete.~~
  Done: teacher submission review supports feedback plus reviewed, returned, and completed states.
- ~~Track statuses such as assigned, viewed, submitted, late, reviewed, returned, and completed.~~
  Done: assignment submissions track assigned, viewed, submitted, late, reviewed, returned, and completed status transitions.

### Implementation Notes

- ~~Reuse enrollment authorization and existing upload/storage patterns where possible.~~
  Done: student assignment access uses active enrollment checks; teacher/admin access uses batch ownership/admin rules.
- ~~Keep assignment attachments access-protected.~~
  Done: assignment and submission files are served through guarded backend download endpoints without exposing raw storage paths. Student submission file upload is surfaced in the UI; teacher assignment resource uploads are backend-ready and can be promoted into the create form in a later polish pass.
- ~~Start with manual teacher review before adding auto-grading or quiz logic.~~
  Done: this pass implements manual review only; auto-grading remains future scope.
- ~~Keep assignments separate from chat messages, but allow links back to the related session and materials.~~
  Done: assignments use dedicated assignment/submission collections and can reference related sessions/materials without becoming chat records.

### Acceptance Checks

- ~~Teacher can create an assignment for an owned batch/session.~~
  Done: backend tests cover owned-batch creation and rejection for another teacher's batch.
- ~~Enrolled students can view and submit only their own assignments.~~
  Done: enrolled students can list/submit assignments; non-enrolled filtered access is rejected.
- ~~Teacher can review and provide feedback.~~
  Done: teacher review APIs and UI update submission feedback and review state.
- ~~Student cannot see another student's submission.~~
  Done: submission downloads are scoped to the owning student or authorized teacher/admin.
- ~~Assignment state appears consistently on student and teacher surfaces.~~
  Done: dashboard/detail/student submission and teacher batch/submission review surfaces use the shared assignment contracts.

## P1: Student Progress Dashboard

Status: **Done on 2026-07-08.**

Every completed checklist item below is fully struck through and marked **Done**. Remaining expansion is listed separately as **Tracked**.

### Why

~~Students need a simple view of their learning progress, not only a list of classes. This helps them understand attendance, missed work, recordings to watch, and weak areas. Done: students now have a backend-backed `/student/progress` page summarizing their own learning activity across enrolled and historical batches.~~

### Proposed Behavior

- **Done**: ~~Add a backend-backed student progress page in the frontend portal. Done: `/student/progress` is routed from the student dashboard and loads a server-owned summary payload.~~
- **Done**: ~~Show only the authenticated student's own progress across enrolled and historical batches/courses. Done: the backend derives batch scope from the authenticated student's enrollment/history and never accepts a client-supplied `studentId`.~~
- **Done**: ~~Show enrolled batch/course summary. Done: progress batches include batch, course, teacher, class, assignment, recording, participation, and source identifier summaries.~~
- **Done**: ~~Show attendance rate and trend by batch/course using attendance snapshots or existing attendance inference. Done: completed-class attendance uses persisted snapshots first and existing room attendance inference for legacy sessions.~~
- **Done**: ~~Show completed, missed, and upcoming class counts from class-session history and scheduled sessions. Done: completed, attended, missed, unknown-attendance, live, and upcoming counts are included per batch and in the top-level summary.~~
- **Done**: ~~Show assignments due, submitted, reviewed, and overdue from existing assignment records. Done: published assignments and the authenticated student's submission status drive due/submitted/reviewed/overdue/missing counts.~~
- **Done**: ~~Show recordings watched/unwatched only where playback tracking exists; otherwise show an honest unavailable/empty state. Done: published recording readiness, watched/unwatched count, watched time, and completion rate now come from persisted student playback progress.~~
- **Done**: ~~Show participation history such as questions asked, hand raises, allowed-speaking turns, and post-class Q&A status where source records exist. Done: the endpoint counts only events and Q&A workflow states tied to the authenticated student.~~
- **Done**: ~~Show conservative weak-topic or recommended review signals only when tagged data exists. Done: deterministic review signals cover attendance, assignments, participation, Q&A, recording progress, and whiteboard-tagged topic review where tags exist; no AI or opaque scoring was added.~~
- **Done**: ~~Link safely to completed sessions, assignments, recordings, and Q&A threads where the student is authorized. Done: recent attendance links go to the existing authorized completed-session detail route; assignment and artifact values stay metadata-only.~~

### Implementation Notes

- **Done**: ~~Reuse existing student enrollment, completed-session history, attendance snapshot/report, assignment, recording, private Q&A/chat metadata, and participation/timeline data. Done: progress aggregates from those existing source records without a parallel analytics store.~~
- **Done**: ~~Add or wire a student-only endpoint only if current APIs would make the page inefficient. Done: `GET /api/v1/class-sessions/student/progress` returns one student-safe summary payload.~~
- **Done**: ~~Keep the endpoint scoped to the authenticated student; do not accept arbitrary `studentId` from the frontend. Done: the endpoint is `@Roles('STUDENT')` and uses `user.sub` only.~~
- **Done**: ~~Do not expose class-wide analytics, other-student progress, private Q&A bodies, private chat bodies, assignment submission bodies, raw storage keys, or raw media data. Done: backend tests verify peer ids and private assignment text are absent from the student progress payload.~~
- **Done**: ~~Keep teacher/admin analytics separate from the student self-progress view. Done: teacher analytics remains on the teacher/admin analytics endpoint and the student progress route is student-only.~~
- **Done**: ~~Use deterministic source records first; do not build a parallel analytics system. Done: attendance, assignments, recordings, activity events, and Q&A workflow records are read directly from existing collections/services.~~
- **Done**: ~~Keep empty states honest when attendance, recording-watch, assignment, or participation data is unavailable. Done: the payload includes availability notes and reports recording progress from persisted playback data when published recordings exist.~~
- **Done**: ~~Keep the page compact, mobile/tablet friendly, and aligned with the Native SFU palette. Done: the frontend page uses compact cards, responsive batch panels, and the Native SFU rose/coral/amber/green palette.~~

### Acceptance Checks

- **Done**: ~~Student sees only their own progress. Done: the progress endpoint derives the student id from auth and filters event/Q&A/submission data to that id.~~
- **Done**: ~~Progress is scoped to authenticated student enrollment and historical access. Done: batch scope uses `listStudentClassHistoryBatchIds`.~~
- **Done**: ~~Attendance values match attendance snapshots/source records. Done: attendance uses the existing snapshot-first attendance helper.~~
- **Done**: ~~Assignment counts match assignment source records. Done: assignment counts are derived from published assignments plus the student's own submission status.~~
- **Done**: ~~Recording review counts match playback/watch records when they exist, or show an honest unavailable state when they do not. Done: student progress now reads persisted playback progress for watched/unwatched, watched time, and completion rate.~~
- **Done**: ~~Participation values match source records for Q&A, hand raises, allowed-speaking turns, and post-class status. Done: counts come from class-session activity events and post-class thread workflow state.~~
- **Done**: ~~Private Q&A bodies and private chat bodies are not included in progress summaries. Done: only Q&A workflow counts are returned.~~
- **Done**: ~~Student cannot request another student's progress. Done: there is no `studentId` request parameter and tests cover non-student rejection.~~
- **Done**: ~~Empty states are honest when analytics are not available. Done: empty enrollment/history returns empty summaries and availability reasons.~~
- **Done**: ~~Progress remains accessible on mobile. Done: `/student/progress` uses responsive grids that collapse for tablet and mobile widths.~~

Verification:

- **Done**: ~~Contracts build passed. Done: `npm run build --workspace @native-sfu/contracts`.~~
- **Done**: ~~Backend focused tests passed. Done: `npm test --workspace @native-sfu/backend -- class-sessions.service.spec.ts` passed with student progress privacy/empty-state coverage.~~
- **Done**: ~~Backend build passed. Done: `npm run build --workspace @native-sfu/backend`.~~
- **Done**: ~~Frontend build passed. Done: `npm run build --workspace @native-sfu/frontend`.~~
- **Done**: ~~Whitespace check passed. Done: `git diff --check`.~~
- **Pending Proof**: Frontend Karma runner still needs local harness hardening. `npm test --workspace @native-sfu/frontend` bound Karma only outside the sandbox, but ChromeHeadless disconnected before executing specs.

Tracked follow-ups:

- **Done**: ~~Add per-student recording watch/progress tracking before showing watched/unwatched counts. Done 2026-07-08: recording playback progress is persisted by recording/session/batch/student and drives watched/unwatched student progress.~~
- **Done**: ~~Add richer weak-topic/recommended-review signals only after tagged lesson/assignment outcome data exists. Done 2026-07-08: baseline recommendations now use deterministic source records and existing whiteboard page tags for source-linked student review signals. Richer learning-outcome taxonomy remains future content-model work.~~

## P1: Teacher Analytics

Status: **Done on 2026-07-08.**

Completed roadmap requirements below are fully struck through. The unstruck `Done:` notes describe what shipped.

### Why

~~Teachers need batch-level insight to identify disengaged students, repeated questions, attendance problems, and material usage patterns.~~

Done: teachers now have a backend-backed analytics view for owned batches, and admins can query the same deterministic analytics across allowed batches.

### Proposed Behavior

- ~~Show per-batch engagement summary.~~
  Done: the `TeacherAnalyticsResponse` returns per-batch engagement, attendance, participation, assignment, recording, material, Q&A, and risk summaries.
- ~~Include attendance rate, missed classes, late joins, reconnect patterns, and participation signals.~~
  Done: analytics reuse attendance snapshots or inferred attendance, class-session activity events, and reconnect/participation timeline metadata.
- ~~Include question frequency, unanswered questions, and common topics where tagged.~~
  Done: private Q&A thread state contributes question and unanswered counts without exposing message bodies; topic-style analytics remain honest until tagged source data exists.
- ~~Include recording usage and material download/view counts where tracking exists.~~
  Done: recording readiness metadata, persisted playback progress, watched/not-watched counts, average completion, total watch time, and material download events are reported where source data exists.
- ~~Highlight student risk indicators such as repeated absences, no submissions, low participation, or many unanswered questions.~~
  Done: conservative risk indicators are derived from deterministic counts for repeated absences, missing/no submissions, low recorded participation, and unanswered Q&A.
- ~~Allow filtering by batch, course, date range, and student.~~
  Done: `TeacherAnalyticsQuery` supports `batchId`, `courseId`, `studentId`, `dateFrom`, and `dateTo`.

### Implementation Notes

- ~~Reuse attendance snapshots, chat/Q&A metadata, materials events, recording access records, and assignment states.~~
  Done: the backend aggregates from attendance snapshots/inference, class-session activity events, assignments/submissions, Q&A thread state, materials, and recordings.
- ~~Keep analytics teacher-owned or admin-only.~~
  Done: `GET /api/v1/teacher/analytics` is scoped to owned teacher batches, and `GET /api/v1/admin/teacher-analytics` is admin/super-admin only.
- ~~Avoid showing private message bodies in aggregate analytics unless the teacher opens the authorized private thread.~~
  Done: analytics payloads exclude private chat/Q&A bodies, assignment submission bodies, raw storage keys, and raw media details.
- ~~Make risk labels explainable and conservative.~~
  Done: risk indicators include count-based reasons and source ids where safe.

### Acceptance Checks

- ~~Teacher can inspect analytics for owned batches.~~
  Done: the teacher route and API enforce owned-batch scope.
- ~~Admin can inspect analytics across batches.~~
  Done: the admin API alias reuses the same aggregation with admin authorization.
- ~~Students cannot access teacher analytics.~~
  Done: backend tests cover student access rejection.
- ~~Metrics link back to source sessions, assignments, or Q&A where useful.~~
  Done: safe session, batch, assignment, recording, material, and thread identifiers are included without private bodies.

Verification:

- ~~Contracts build.~~
  Done: `npm run build --workspace @native-sfu/contracts` passed.
- ~~Backend build.~~
  Done: `npm run build --workspace @native-sfu/backend` passed.
- ~~Frontend build.~~
  Done: `npm run build --workspace @native-sfu/frontend` passed.
- ~~Admin portal build.~~
  Done: `npm run build --workspace @native-sfu/admin-portal` passed.
- ~~Focused backend class-session tests.~~
  Done: `npm test --workspace @native-sfu/backend -- class-sessions.service.spec.ts` passed with 64 tests.
- ~~Whitespace check.~~
  Done: `git diff --check` passed.

## P1: Search And Library

Status: **Done on 2026-07-07.**

Completed roadmap requirements below are fully struck through. The unstruck `Done:` notes describe what shipped.

### Why

~~As recordings, notes, materials, questions, sessions, and assignments grow, users need a way to find learning artifacts quickly.~~

Done: the class library now provides authorization-scoped metadata search across completed-session learning artifacts for students, teachers, and admins.

### Proposed Behavior

- ~~Add a searchable class library.~~
  Done: frontend `/class-library` and admin portal `/class-library` pages are available, with dashboard/sidebar links into the library.
- ~~Search recordings, whiteboard notes, materials, questions, sessions, assignments, and topics.~~
  Done: results include `session`, `recording`, `material`, `whiteboard`, `assignment`, `announcement`, and `qna` artifact types.
- ~~Filter by course, batch, teacher, date, artifact type, and status.~~
  Done: `ClassLibrarySearchQuery` supports `courseId`, `batchId`, `teacherId`, `dateFrom`, `dateTo`, `artifactType`, `status`, page, and limit.
- ~~Student search returns only authorized student-visible artifacts.~~
  Done: student search is limited to historically enrolled batches, completed sessions, and student-visible published/shared artifacts.
- ~~Teacher search returns owned batch/session artifacts and private threads they are allowed to access.~~
  Done: teacher search is limited to batches owned by the authenticated teacher and exposes private Q&A as status metadata, not message bodies.
- ~~Admin search can span the platform according to admin permissions.~~
  Done: `GET /api/v1/admin/class-library/search` is admin-only and searches across allowed platform artifact metadata.

### Implementation Notes

- ~~Reuse existing material, recording, whiteboard page title/tag, session, and chat metadata first.~~
  Done: the backend searches existing class-session, material, recording, whiteboard memory, assignment, broadcast chat, and Q&A thread-state collections.
- ~~Keep private chat/Q&A search scoped to the two authorized participants and teacher/admin rules.~~
  Done: broad library search only returns Q&A status/count metadata, and private bodies remain inside authorized teacher-student thread views.
- ~~Add full-text indexing later if simple metadata search is not enough.~~
  Done: no new search index was added for this phase; metadata search remains the first production-safe step, with richer indexing left as future polish.
- ~~Avoid indexing private message bodies into broad shared search surfaces.~~
  Done: private Q&A/chat bodies, assignment submission bodies, raw storage keys, and raw file paths are excluded from search result metadata.

### Acceptance Checks

- ~~Student can find their own completed class artifacts.~~
  Done: focused backend tests cover enrolled student access and visible completed-session artifacts.
- ~~Teacher can find owned session artifacts and student Q&A.~~
  Done: focused backend tests cover owned teacher results and non-owner exclusion.
- ~~Search results do not leak materials, recordings, notes, or private questions across enrollments.~~
  Done: focused backend tests verify another batch is excluded and private body/storage fields are not returned.
- ~~Filters work by course, batch, teacher, date, and type.~~
  Done: focused backend tests cover admin filtering and typed artifact filtering.

Verification:

- ~~Contracts build.~~
  Done: `npm run build --workspace @native-sfu/contracts` passed.
- ~~Backend focused class-library tests.~~
  Done: `npm test --workspace @native-sfu/backend -- class-library.service.spec.ts` passed with 4 tests.
- ~~Backend build.~~
  Done: `npm run build --workspace @native-sfu/backend` passed.
- ~~Frontend build.~~
  Done: `npm run build --workspace @native-sfu/frontend` passed.
- ~~Admin portal build.~~
  Done: `npm run build --workspace @native-sfu/admin-portal` passed.
- ~~Whitespace check.~~
  Done: `git diff --check` passed.

## P1: Student Support And Escalation

Status: **Done on 2026-07-08** for student request creation/status and admin support triage. Teacher-owned support visibility remains a tracked follow-up until product rules define whether teachers can respond or only view class-related requests.

Completed roadmap requirements below are fully struck through. The unstruck `Done:` notes describe what shipped.

### Why

~~Students need an obvious way to get help when something goes wrong: missing access, class issues, recording problems, or audio/video trouble.~~

Done: the frontend portal now has a student support page with context-prefilled entry points from dashboard, live class, completed class, and completed-class recording rows.

### Proposed Behavior

- ~~Add a student support entry point from dashboard, live class, and completed-session detail.~~
  Done: `/student/support` is linked from the dashboard, student live class states/actions, completed-session detail, and recording rows.
- ~~Let students ask admin/support for help.~~
  Done: students can create support requests through `POST /api/v1/support/requests`.
- ~~Let students report a class issue.~~
  Done: class-session context fields are accepted and enrollment/historical enrollment is validated before persistence.
- ~~Let students request recording access or report missing/expired recording access.~~
  Done: the form supports `recordingId`, and completed-class recording rows prefill recording access/problem requests.
- ~~Let students report audio/video problems with useful device/session context.~~
  Done: live-class Help links prefill audio/video issue type, batch, session, room, and safe browser diagnostics.
- ~~Track support status such as open, in review, waiting for student, resolved, and closed.~~
  Done: support requests persist `open`, `in_review`, `waiting_for_student`, `resolved`, and `closed` statuses.
- ~~Allow support/admin response according to issue type.~~
  Done: admin/super-admin users can triage, update status, assign by name, and add student-visible responses or internal notes in `/admin/support`.
- **Tracked**: Add teacher-owned class-related support visibility after product rules define whether teachers can respond or view read-only only.

### Implementation Notes

- ~~Reuse authenticated user, enrollment, session, recording, and room context to prefill support requests.~~
  Done: the backend resolves session/recording/batch context and validates student enrollment before storing class-linked tickets.
- ~~Do not include private chat bodies or raw media payloads in support reports.~~
  Done: only the explicit support message plus safe IDs/diagnostics are stored; no chat bodies, raw media payloads, tokens, storage keys, or attachment URLs are copied.
- ~~Include safe diagnostics such as browser, device permission state, sessionId, batchId, and timestamp when available.~~
  Done: diagnostics are whitelisted and bounded to userAgent, route, timestamp, platform/browser, and permission states; URL token-like parameters are redacted.
- ~~Keep escalation visibility role-based: student sees own tickets and admin sees support queue.~~
  Done: student endpoints are own-ticket only, and admin queue endpoints are admin/super-admin only.
- **Tracked**: Add teacher support visibility only when product visibility rules are finalized.

### Acceptance Checks

- ~~Student can submit support requests from relevant contexts.~~
  Done: dashboard/live/completed/recording entry points all route into the support form.
- ~~Student can see status updates for their own requests.~~
  Done: `/student/support` lists the student's own support requests and latest student-visible response.
- ~~Support requests include enough context for operators without leaking private data.~~
  Done: admin queue shows student, issue type, status, class/recording context, safe diagnostics, and explicit support message only.
- ~~Non-enrolled users cannot file requests against guessed class sessions.~~
  Done: backend tests cover non-enrolled rejection for guessed class sessions.

Verification:

- ~~Contracts build.~~
  Done: `npm run build --workspace @native-sfu/contracts` passed.
- ~~Backend focused support tests.~~
  Done: `npm test --workspace @native-sfu/backend -- support.service.spec.ts` passed with 4 tests.
- ~~Backend build.~~
  Done: `npm run build --workspace @native-sfu/backend` passed.
- ~~Frontend build.~~
  Done: `npm run build --workspace @native-sfu/frontend` passed.
- ~~Admin portal build.~~
  Done: `npm run build --workspace @native-sfu/admin-portal` passed.
- ~~Whitespace check.~~
  Done: `git diff --check` passed.

## P1: Public Teacher Profile Gallery And Demo Classes

Status: Done.

### Why

Students need confidence before enrolling in a batch. The existing public teacher profile covers biography, skills, credentials, experience, links, availability, and public batches, but it does not yet include richer trust-building content such as gallery items or sample/demo classes.

### Proposed Behavior

- ~~Add a teacher-managed public gallery.~~
  Done: teachers can create, edit, archive, upload media for, publish, and unpublish gallery items from the teacher profile page.
- ~~Support gallery items such as classroom images, certificates, sample whiteboard notes, intro media, and lesson screenshots.~~
  Done: public content supports image, video, PDF, document, slide, and link media types with tags/topics.
- ~~Add demo or sample class entries.~~
  Done: demo class entries are stored separately from gallery items and appear in a dedicated public profile tab.
- ~~Demo classes can include free preview lessons, recorded sample videos, short topic clips, or public sample materials.~~
  Done: demo classes can use safe external URLs or uploaded server-stored public media.
- ~~Let teachers control which gallery/demo items are published.~~
  Done: each item has draft, published, and unpublished states.
- ~~Show gallery and demo classes on the public teacher profile.~~
  Done: the public teacher profile now has Gallery and Demo Classes tabs.
- ~~Let students open demo items before enrolling where product rules allow.~~
  Done: published items expose only safe public/external URLs for unauthenticated public viewing.
- ~~Keep public batches visible separately from demo/sample content.~~
  Done: the public Batches tab remains separate from Gallery and Demo Classes.

### Implementation Notes

- ~~Extend the public teacher profile contract instead of using hardcoded/demo frontend data.~~
  Done: shared profile contracts now include `TeacherPublicContentItem`, `gallery`, and `demoClasses`.
- ~~Reuse existing profile media upload and class material/storage patterns where possible.~~
  Done: uploaded public content uses backend profile-media storage and server-routed public URLs.
- ~~Store publish/unpublish state per gallery/demo item.~~
  Done: `teacher_public_contents` stores per-item publish status and published timestamp.
- ~~Keep private batch/session materials separate from public demo materials.~~
  Done: public content lives in a dedicated teacher public content collection, not real class-session material/recording records.
- ~~Do not expose recordings from real enrolled classes unless explicitly published as public demo content.~~
  Done: the public profile only renders items explicitly published through the teacher public content workflow.
- Add moderation/admin review workflow later if public content needs approval.

### Acceptance Checks

- ~~Teacher can add, edit, publish, and unpublish public gallery items.~~
  Done.
- ~~Teacher can add demo/sample class entries.~~
  Done.
- ~~Public teacher profile shows only published gallery/demo items.~~
  Done.
- ~~Students can view public demo content without seeing private enrolled-class materials.~~
  Done.
- ~~Disabled/private teacher profiles do not expose gallery or demo content.~~
  Done.
- ~~Public demo URLs do not leak private storage keys or real class-session artifacts.~~
  Done.

## P1: Teacher Marketplace And Discovery

Status: Done for the P1 baseline. Richer paid placement, ratings, price filters, and admin editorial controls remain tracked under P2 promotion/paid visibility.

### Why

Students currently discover teachers indirectly through available batches. That works for enrollment, but it does not provide a teacher-first discovery experience where students can browse, compare, search, and build confidence before choosing a teacher or batch.

### Proposed Behavior

- ~~Add a public teacher marketplace page at `/teachers`.~~
  Done: `/teachers` now renders a compact teacher-first discovery page.
- ~~Add a student dashboard entry point such as `Browse Teachers`.~~
  Done: student navigation and batch Explore now link to the teacher marketplace.
- ~~Show teacher cards with avatar, headline, specialties, credentials, rating or trust indicators, active batches, and demo classes where available.~~
  Done: cards show avatar, headline, skills, languages, highlighted credential/trust label, active public batch count, next batch date, and gallery/demo counts. Ratings remain a future data-source expansion.
- ~~Let students search teachers by name, subject, skill, language, and topic.~~
  Done: backend and frontend support search by name/profile text plus skill/topic, subject, and language filters.
- ~~Let students filter by subject, level, availability, language, rating, price or free demo availability, and active batch status.~~
  Done: P1 filters cover subject, availability/open batches, language, and skill/topic. Level, rating, price, and free-demo filtering remain tracked for future marketplace data.
- Let students sort by relevance, popularity, rating, availability, newest, and promoted placement where applicable.
  Tracked: sorting and promoted placement should land with the P2 promotion/paid visibility model.
- Add featured teacher sections and marketplace placements.
  Tracked: featured placement should land with admin marketplace controls.
- ~~Connect teacher cards to public teacher profiles.~~
  Done: each card links to the existing `/teachers/:teacherId` public profile.
- ~~Add profile calls to action such as `View Profile`, `Watch Demo`, `See Batches`, `Enroll`, and `Ask Question` where product rules allow.~~
  Done: P1 cards include `View profile` and `Open batches`; demo/gallery availability is visible. Direct ask-question remains post-class/private Q&A scoped and is not exposed publicly.
- ~~Let students browse all public batches from a selected teacher.~~
  Done: public profiles retain separate public batch listings and the marketplace links back to batch Explore.
- ~~Keep batch enrollment gated by the existing enrollment flow.~~
  Done: marketplace discovery does not alter enrollment/session authorization.

### Implementation Notes

- ~~Reuse public teacher profile data instead of duplicating separate marketplace-only teacher data.~~
  Done: marketplace cards are generated from users, public batches, and published teacher public content.
- ~~Add a marketplace list/search API that only returns active teachers with published public profiles.~~
  Done: `GET /api/v1/teachers` returns only active, enabled, public-profile-enabled teachers.
- ~~Include only public-safe fields in marketplace cards.~~
  Done: card payload excludes email, phone, settings, storage keys, and private artifacts.
- ~~Reuse public gallery and demo class data when available.~~
  Done: marketplace cards include published gallery and demo-class counts.
- ~~Keep marketplace search separate from private enrolled-class materials, recordings, and chat.~~
  Done: marketplace counts come from `teacher_public_contents`, not class-session artifacts.
- Leave promoted placement optional until paid promotion is implemented.
- Add admin controls later for marketplace visibility, featured teachers, and editorial ordering.

### Acceptance Checks

- ~~Students can browse teachers without starting from a batch card.~~
  Done.
- ~~Marketplace shows only active teachers with published public profiles.~~
  Done.
- ~~Search and filters return public-safe teacher results.~~
  Done.
- ~~Teacher cards link to the correct public teacher profile.~~
  Done.
- ~~Students can move from teacher profile to available batches and enrollment.~~
  Done.
- ~~Private class/session artifacts are not visible through marketplace discovery.~~
  Done.
- ~~Disabled, private, or unpublished teacher profiles are excluded.~~
  Done.

### Verification

- `npm run build --workspace @native-sfu/contracts`
- `npm run build --workspace @native-sfu/backend`
- `npm test --workspace @native-sfu/backend -- profiles.service.spec.ts`
- `npm run build --workspace @native-sfu/frontend`
- `git diff --check`

## P2: Public Teacher Profile Promotion And Paid Visibility

Status: **Done for the P2 promotion foundation on 2026-07-08.** Payment checkout, impression/click analytics, richer sort/rating/price filters, and legal/policy copy remain tracked future scope.

Shipped surface:

- ~~Teacher self-service promotion request and promotion history on the teacher profile page.~~
- ~~Admin promotion queue with approve, pause, cancel, reject, filters, and notes.~~
- ~~Marketplace ranking boost and promoted badge for active in-window promotions.~~
- ~~Backend promotion collection, admin/teacher APIs, indexes, eligibility checks, overlap prevention, and audit-safe events.~~

### Why

~~Publishing a teacher profile is not the same as promoting it. A paid or admin-curated promotion system would let the platform highlight trusted teachers, sell profile visibility, and measure whether promoted placement leads to profile views, demo-class opens, inquiries, or enrollments.~~

Done: the platform now separates public profile publishing from promotion records, lets teachers request visibility, lets admins manage promotion lifecycle, and boosts active promotions in the public marketplace without bypassing public-profile eligibility.

### Proposed Behavior

- ~~Add featured teacher listing placements.~~
  Done: active `marketplace_featured` promotions are boosted ahead of organic public teacher results.
- ~~Add a sponsored or promoted badge on paid/promoted profiles.~~
  Done: marketplace teacher cards show a visible promoted/featured badge when an active promotion applies.
- Support paid boost plans or subscription-based promotion entitlement.
  Tracked: checkout/subscription integration remains out of scope; current records store safe billing/payment placeholders.
- ~~Require admin approval before promoted visibility goes live.~~
  Done: teacher requests stay `requested` until an admin/super-admin approves or schedules them.
- ~~Support promotion start and end dates.~~
  Done: promotion windows are stored and only active in-window promotions affect public marketplace ranking/metadata.
- ~~Add ranking or placement weight for promoted teachers.~~
  Done: active promoted teachers are fetched before non-promoted teachers for the marketplace list.
- ~~Add marketplace/gallery placement where promoted teachers can appear.~~
  Done: marketplace placement is implemented; gallery/profile-badge metadata is modeled for future UI expansion.
- Add promotion analytics such as views, clicks, demo opens, inquiries, and enrollments.
  Tracked: no impression/click analytics were added in this foundation pass.
- ~~Let promoted profiles include demo classes and gallery content when available.~~
  Done: promoted cards reuse existing published gallery/demo counts and never expose private class artifacts.
- Add public teacher search, filter, and sort by subject, rating, availability, popularity, and promotion status.
  Tracked: existing search/filter remains public-safe; explicit rating, price, popularity, and promotion-status filters remain future marketplace data work.

### Implementation Notes

- ~~Keep public profile publishing separate from paid promotion state.~~
  Done: promotions live in `teacher_promotions`; user/public-profile fields are not used as paid-visibility state.
- ~~Model promotion campaigns separately from the teacher profile so promotions can expire, be audited, and be reviewed.~~
  Done: promotion documents store status, placement, teacher, date window, billing placeholder, notes, request/approve/cancel users, and timestamps.
- ~~Store placement, priority, status, startAt, endAt, payment or entitlement reference, and review metadata.~~
  Done: placement/status/date/billing/payment/admin-note metadata exists. Explicit numeric priority remains future editorial ranking work.
- ~~Clearly label paid placements as sponsored or promoted where required by product/legal policy.~~
  Done: marketplace cards display a promoted/featured badge. Final legal copy can be refined with policy input.
- Reuse profile gallery, demo classes, enrollment, analytics, and payment/subscription infrastructure where available.
- ~~Do not let teachers self-escalate ranking without a valid paid entitlement or admin approval.~~
  Done: teacher self-service only creates requests; active marketplace boosting requires admin action and active public-profile eligibility.

### Acceptance Checks

- ~~Public profile can remain published without being promoted.~~
  Done.
- ~~Only approved paid/admin promotions appear in featured placements.~~
  Done: only `active` in-window promotions affect public marketplace cards.
- ~~Expired or rejected promotions do not affect public ranking.~~
  Done.
- ~~Students can identify sponsored/promoted profiles clearly.~~
  Done.
- Promotion analytics distinguish organic profile traffic from promoted traffic.
  Tracked: promotion analytics were not implemented in this foundation pass.
- ~~Search and marketplace pages do not expose disabled/private teacher profiles.~~
  Done: promotion ranking still filters to active, enabled, public-profile-enabled teacher profiles.

### Verification

- `npm run build --workspace @native-sfu/contracts`
- `npm test --workspace @native-sfu/backend -- profiles.service.spec.ts`
- `npm run build --workspace @native-sfu/backend`
- `npm run build --workspace @native-sfu/frontend`
- `npm run build --workspace @native-sfu/admin-portal`

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

Status: **Done for playback analytics and engagement reporting on 2026-07-08.**

Completed checklist lines below are fully struck through and marked **Done**. Remaining future recording polish should be tracked separately rather than reopening the analytics baseline.

### Why

~~Recording is valuable for review, but it has media-pipeline, storage, consent, retention, and access-control implications. It should be designed deliberately.~~

~~Recording must be server-side. Browser-side `MediaRecorder` or teacher/student client recording should not be the source of truth.~~

**Done**: ~~Recording playback engagement is now tracked from authorized student completed-session playback without changing the server-side recording source of truth.~~

### Proposed Behavior

- **Done**: ~~Teacher explicitly starts/stops recording. Done: existing manual recording controls remain the source of recording start/stop.~~
- **Done**: ~~Students see a clear recording indicator. Done: existing live recording state remains unchanged by the analytics pass.~~
- **Done**: ~~Ended sessions expose playback only to authorized users. Done: completed-session recordings remain guarded by class-session/enrollment authorization and published-recording rules.~~
- **Done**: ~~Admins can configure retention and download permissions. Done: admin recording detail keeps retention/download controls and now adds safe engagement summary cards.~~
- **Done**: ~~Recording stops when the class session ends. Done: existing manual lifecycle recording cleanup remains unchanged.~~
- **Done**: ~~Track enrolled student playback activity. Done: `recording_playback_progress` stores student/session/batch progress, play/pause/seek counts, watched seconds, completion percent, and timestamps without raw URLs or storage keys.~~
- **Done**: ~~Show students their own recording progress. Done: completed-session recording rows show Not started, In progress, or Watched, and the student progress dashboard reports watched/ready counts, unwatched count, review time, and completion rate.~~
- **Done**: ~~Show teachers owned-batch recording engagement. Done: teacher analytics reports watched, not watched, average completion, and total watch time only for teacher-owned/admin-authorized batches.~~
- **Done**: ~~Show admins recording engagement. Done: admin recording detail displays watched/not-watched, average completion, total watch time, plays, pauses, and seeks from safe aggregate data.~~

### Implementation Notes

- **Done**: ~~Build on the SFU/server media path rather than browser recording. Done: analytics attach to existing recording metadata/playback, not a parallel browser recording system.~~
- **Done**: ~~Prefer server-side composition if feasible: screen share as primary, teacher camera as PiP, teacher audio, and allowed student audio. Done: this remains recording-capture behavior, outside the playback analytics write path.~~
- **Done**: ~~If composition is too large for the first phase, record server-side tracks plus a playback manifest and document the limitation. Done: the existing server-owned recording manifest/playback path remains the source used by completed-session review.~~
- **Done**: ~~Define consent and retention rules before implementation. Done: retention/admin playback behavior remains unchanged; analytics only records progress for already authorized published recordings.~~
- **Done**: ~~Store recording metadata by session and batch. Done: playback progress stores recording, session, batch, and student identifiers with indexed lookup paths.~~
- **Done**: ~~Gate playback by teacher/admin/enrolled-student access. Done: progress writes require authenticated enrolled/historically authorized students, while teacher/admin analytics use existing owned-batch/admin authorization.~~

### Acceptance Checks

- **Done**: ~~Recording never starts silently. Done: analytics did not add any automatic recording start path.~~
- **Done**: ~~Recording state survives reconnect. Done: existing recording/session state behavior is preserved.~~
- **Done**: ~~Recording is performed on the server side. Done: playback analytics do not introduce client-side recording.~~
- **Done**: ~~Only authorized users can access playback. Done: playback progress and completed-session recording access are enrollment-protected, and non-students cannot spoof playback progress.~~
- **Done**: ~~Ended sessions can show recording availability. Done: completed-session pages show authorized recordings and now update own progress from playback events.~~
- **Done**: ~~Student playback progress is persisted securely. Done: backend tests cover enrolled writes, non-enrolled rejection, non-student rejection, clamping, and absence of raw playback/storage data.~~
- **Done**: ~~Playback remains usable if analytics writes fail. Done: frontend progress writes are best-effort and do not block video/open actions.~~

### Verification

- **Done**: ~~Contracts build. Done: `npm run build --workspace @native-sfu/contracts` passed.~~
- **Done**: ~~Focused backend recording tests. Done: `npm test --workspace @native-sfu/backend -- recordings.service.spec.ts` passed with 16 tests.~~
- **Done**: ~~Focused backend class-session tests. Done: `npm test --workspace @native-sfu/backend -- class-sessions.service.spec.ts` passed with 64 tests.~~
- **Done**: ~~Backend build. Done: `npm run build --workspace @native-sfu/backend` passed.~~
- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed.~~
- **Done**: ~~Admin portal build. Done: `npm run build --workspace @native-sfu/admin-portal` passed.~~
- **Done**: ~~Whitespace check. Done: `git diff --check` passed.~~

## P2: Attendance Analytics And Admin Reporting

Status: **Done on 2026-07-08.**

Completed lines below are fully struck through. Plain `Done:` notes explain what shipped.

### Why

~~The CSV export is useful for a single session. Admins will eventually need aggregate views across batches, teachers, courses, and date ranges.~~

Done: admin attendance reporting now supports cross-session analytics with source visibility, filters, drilldowns, and per-student CSV export.

### Proposed Behavior

- ~~Add attendance dashboards for batch and course views.~~
  Done: the admin Attendance page shows summary cards, trend data, sessions and students tabs, per-session student drilldown, and safe links to batch, course, teacher, and user detail pages.
- ~~Show present/absent, late joins, early leaves, total duration, reconnect count, and attendance source state.~~
  Done: session rows, student rows, drilldowns, summary cards, and exports include attendance status, join/leave time, duration, reconnects, late/early signals, and snapshot/inferred source labels. Aggregate coverage shows Snapshot, Inferred, Mixed, or None.
- ~~Allow CSV export by batch/course/date range.~~
  Done: admin attendance CSV export uses the same filter and snapshot-preferred source path as JSON analytics and includes per-student rows with session, course, batch, teacher, student, attendance status, first join, last leave, duration, reconnect count, and source.
- ~~Support operational filters for admin review.~~
  Done: admin attendance APIs and UI support date range, course, batch, teacher, student, session status, attendance status, and source filters.

### Implementation Notes

- ~~Reuse participant join/leave records and enrollment roster.~~
  Done: reporting prefers immutable attendance snapshots for completed sessions and falls back to existing roster/room participant inference for legacy sessions without snapshots.
- ~~Normalize report rows so absent enrolled students are included.~~
  Done: snapshot and inferred attendance rows both include present/absent status, roster source, duration, reconnect count, and join/leave metadata.
- ~~Keep teacher/admin authorization separate from student views.~~
  Done: admin attendance analytics remain admin/super-admin only; teacher-owned analytics remain in the teacher analytics surface; student progress remains student-only.
- ~~Keep exports audit-safe.~~
  Done: CSV export excludes private chat/Q&A bodies, attachment storage keys, URLs, tokens, and unrelated private data.
- Backfill note: automatic historical snapshot backfill is not part of this pass. Legacy completed sessions without snapshots remain visible as inferred and clearly labeled until a separate idempotent backfill is added.

### Acceptance Checks

- ~~Admin can view attendance across multiple sessions.~~
  Done: admin attendance summary, sessions, students, trends, drilldown, and CSV export work across courses, batches, teachers, students, date ranges, statuses, and sources.
- ~~Teacher can view attendance for owned batches.~~
  Done: owned-batch teacher insight remains covered by the teacher analytics/reporting surfaces, while cross-platform attendance analytics stay admin-scoped.
- ~~Enrolled students cannot see other students' analytics.~~
  Done: this admin reporting surface is admin-only, and student-facing progress/report views remain scoped to the authenticated student.
- ~~Completed-session attendance uses immutable snapshots where available.~~
  Done: snapshot-backed sessions are counted separately from inferred sessions and do not depend on later roster drift.
- ~~CSV and UI reports agree on source data.~~
  Done: CSV export uses the same snapshot-preferred attendance row path and filters as JSON analytics.

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

Status: **Done on 2026-07-09** for the admin health snapshot, metrics, dashboard issue surfacing, and support-safe diagnostics scope.

Completed roadmap requirements below are fully struck through. The unstruck `Done:` notes describe what shipped.

### Why

~~Live classes need quick support answers: who is connected, whether media is flowing, why a student cannot join, and whether socket events are delayed.~~

Done: admin users can inspect a support-safe class-session health snapshot, the admin dashboard surfaces live operational issues, and support/recording flows emit bounded metrics without exposing private payloads.

### Proposed Behavior

- ~~Add class-session support view for admin/operator users.~~
  Done: admin class-session detail now includes an Operational Health panel backed by `GET /api/v1/admin/class-sessions/:sessionId/health`.
- ~~Show session status, room owner, connected participants, media producers, reconnect grace state, lock state, chat health, and recent errors.~~
  Done: the health payload includes safe session, room, teacher connection, participant count, media count, recent join denial, recording, support, and issue summaries.
- ~~Add metrics/alerts for failed joins, reconnect grace expiries, chat delivery failures, and attachment validation failures.~~
  Done: existing class-session lifecycle/chat/media counters remain in place, and this pass added support-request and recording-event counters plus dashboard issues for teacher reconnecting, media failures, join denials, failed recordings, and unresolved support requests.

### Implementation Notes

- ~~Reuse existing room quality, incident, and snapshot systems.~~
  Done: the health endpoint reuses class-session, room, participant, support, recording, and timeline/incident state instead of introducing a parallel event stack.
- ~~Avoid exposing private chat bodies in support views.~~
  Done: support diagnostics and health summaries expose IDs, counts, statuses, timestamps, and redacted reasons only; private chat/Q&A bodies, raw media payloads, storage keys, tokens, and secrets stay out of the support view.
- ~~Add links from session report to room incident evidence.~~
  Done: the health response includes admin links to the class-session detail, timeline, attendance, recordings, support, and live room where applicable.

### Acceptance Checks

- ~~Operator can diagnose a live class without database shell access.~~
  Done: admins can open the class-session detail Operational Health panel for the current safe health snapshot.
- ~~Alerts include session and batch identifiers.~~
  Done: dashboard operational issues and session health summaries include session and batch identifiers plus safe related links.
- ~~Support view respects admin-only access.~~
  Done: the health endpoint is exposed from the admin class-session controller and uses the existing admin/super-admin guard path.

### Verification

- Contracts build passed: `npm run build --workspace @native-sfu/contracts`.
- Backend build passed: `npm run build --workspace @native-sfu/backend`.
- Frontend build passed: `npm run build --workspace @native-sfu/frontend`.
- Admin portal build passed: `npm run build --workspace @native-sfu/admin-portal`.
- Focused backend tests passed: `npm test --workspace @native-sfu/backend -- admin-dashboard.service.spec.ts support.service.spec.ts class-sessions.service.spec.ts rooms.service.spec.ts recordings.service.spec.ts metrics.service.spec.ts`.
- `git diff --check` passed.

## Verification Checklist

- Run backend and frontend builds after each implementation slice.
- Add focused backend tests for any new authorization, lifecycle, persistence, or download behavior.
- Add frontend tests for modal, chat, media, and state transitions where existing patterns allow.
- Verify teacher and student flows with two browser sessions.
- Confirm manual lifecycle remains intact, except for the intentional teacher reconnect grace auto-end behavior.
- Confirm private chat, broadcast chat, and enrollment authorization are not weakened by new features.
- Confirm mobile layouts with screenshots before calling UI work complete.
